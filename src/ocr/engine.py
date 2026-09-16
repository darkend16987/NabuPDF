"""OCR Engine module - supports VietOCR, PaddleOCR, and Hybrid mode for Vietnamese text."""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from pathlib import Path
from PIL import Image

logger = logging.getLogger(__name__)

# NOTE — torch is NOT imported here, on purpose. See `_preload_torch_for_paddle()`
# below for the Windows DLL-ordering rule it used to enforce, and why the rule is
# now enforced where it actually applies instead.


def _preload_torch_for_paddle() -> None:
    """Load torch's native DLLs BEFORE paddle's. Call right before importing paddle.

    IMPORTANT (Windows): if paddle is imported first it shadows torch's MKL/OpenMP
    dependencies and torch then fails with `OSError: [WinError 127] ... shm.dll`.

    This used to be a module-level `import torch`, which guaranteed the order for
    every entry point — but also made EVERY importer of this module pay for torch.
    api.py imports it at module load, so the sidecar spent ~1.1 s (warm) / ~8 s
    (cold) loading torch on every launch, and the out-of-process compress worker
    (`sidecar.py --compress-worker`, which re-imports api) paid it again on every
    large compress, even though neither touches OCR.

    Calling it here instead is also STRICTER than the old placement: the module-level
    import only ordered things for a process that imported this module before paddle.
    HybridOCREngine.recognize() loads paddle (detector) before vietocr pulls torch in
    (recognizer) — so with torch imported lazily by vietocr and nothing else, the
    order would be wrong. This call fixes that too.

    Silent on ImportError: torch is optional for the paddle-only path.
    """
    try:
        import torch  # noqa: F401
    except ImportError:
        pass


class BaseOCREngine(ABC):
    """Abstract base class for OCR engines."""

    @abstractmethod
    def recognize(self, image: Image.Image) -> str:
        """Recognize text from a PIL Image. Returns extracted text."""
        ...

    def recognize_file(self, file_path: str | Path) -> str:
        """Recognize text from an image file."""
        from src.utils.image_processing import load_image
        image = load_image(file_path)
        return self.recognize(image)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions: [(text, [x0,y0,x1,y1]), ...].

        Default: not supported (e.g. recognition-only engines that lack layout).
        Overridden by detection-capable engines (Paddle, Hybrid).
        """
        raise NotImplementedError("This engine does not support positional OCR")


def _vietocr_bundle_dirs() -> list[Path]:
    """Places a bundled `models/vietocr/` may live, most specific first.

    Mirrors what `src/pdf/fonts.py::_vietnamese_font` does for DejaVuSans.ttf, and for
    the same reason: in a frozen app `sys._MEIPASS` (the onedir `_internal` folder) is
    where PyInstaller puts collected data, while a dev checkout has it at the repo root.
    """
    import sys as _sys

    roots: list[Path] = []
    mei = getattr(_sys, "_MEIPASS", None)
    if mei:
        roots.append(Path(mei))
    roots.append(Path(_sys.executable).resolve().parent)   # frozen: next to sidecar.exe
    roots.append(Path(__file__).resolve().parents[2])      # dev: repo root
    return [r / "models" / "vietocr" for r in roots]


def _vietocr_local_config(model_name: str):
    """Build VietOCR's config from the BUNDLED YAMLs + weights, or return None.

    WHY THIS EXISTS. `Cfg.load_config_from_name()` is not a local call: vietocr 0.3.13
    GETs two YAMLs from https://vocr.vn on EVERY Predictor construction and caches
    nothing, and `Predictor.__init__` then downloads the 151.8 MB `vgg_transformer.pth`
    into `tempfile.gettempdir()`. That made OCR depend on one Vietnamese host being up
    even for a machine that had already used it, and %TEMP% is swept by Windows Storage
    Sense — measured 286 s to become ready on a machine that HAD run OCR before.
    Contradicts DESIGN.md D2 (local-first) and the offline promise in
    HUONG-DAN-SU-DUNG.md §3.

    Returning a config with a local `weights` path is what removes the network from the
    picture entirely: `vietocr.tool.utils.download_weights` returns the string unchanged
    when it does not start with "http", so no code path is left that can call out.

    The base + model merge replicates `Cfg.load_config_from_name` exactly (that function
    merges base.yml UNDER the model yaml; `Cfg.load_config_from_file` does NOT read
    base.yml at all, which is why it cannot be used here). The yaml FILENAME comes from
    vietocr's own `url_config` table rather than a second copy of it here, so a model
    name we don't ship simply finds no file and falls back.

    Returns a `Cfg`, or None when nothing usable is bundled.
    """
    try:
        import yaml
        from vietocr.tool.config import Cfg, url_config
    except Exception as e:  # vietocr not installed, or its layout changed
        logger.debug("VietOCR local config unavailable: %s", e)
        return None

    yml_name = url_config.get(model_name)
    if not yml_name:
        return None

    for d in _vietocr_bundle_dirs():
        base_yml, model_yml = d / "base.yml", d / yml_name
        if not (base_yml.is_file() and model_yml.is_file()):
            continue
        try:
            cfg = yaml.safe_load(base_yml.read_text(encoding="utf-8")) or {}
            cfg.update(yaml.safe_load(model_yml.read_text(encoding="utf-8")) or {})
        except Exception as e:
            logger.warning("VietOCR config at %s is unreadable (%s) — falling back", d, e)
            continue

        weights = str(cfg.get("weights", ""))
        if weights.startswith("http"):
            local = d / weights.rsplit("/", 1)[-1]
            if local.is_file():
                cfg["weights"] = str(local)
                logger.info("VietOCR: bundled config + weights (%s) — fully offline", d)
            else:
                # Config is local but the .pth is not. Still better than the old path
                # (vocr.vn is no longer needed for the YAMLs), and Predictor will
                # download the weights exactly as before. Say so loudly: a packaged
                # build reaching this line means the build host skipped the fetch.
                logger.warning(
                    "VietOCR: bundled config found but %s is missing — weights will be "
                    "DOWNLOADED (~152 MB). Run: python tools/fetch_vietocr_model.py",
                    local.name,
                )
        return Cfg(cfg)

    return None


class VietOCREngine(BaseOCREngine):
    """Vietnamese OCR using VietOCR (Transformer-based, optimized for Vietnamese).

    IMPORTANT: VietOCR is recognition-only — it expects pre-cropped single text line
    images. For full-page documents, use HybridOCREngine or PaddleOCREngine instead.
    """

    def __init__(self, model_name: str = "vgg_transformer"):
        self.model_name = model_name
        self._predictor = None

    @property
    def predictor(self):
        if self._predictor is None:
            logger.info("Loading VietOCR model: %s", self.model_name)
            from vietocr.tool.predictor import Predictor
            config = _vietocr_local_config(self.model_name)
            if config is None:
                # No bundled model on this machine (plain dev checkout). Old behaviour:
                # two YAML GETs to vocr.vn, then a 151.8 MB weights download into %TEMP%.
                from vietocr.tool.config import Cfg
                logger.warning(
                    "VietOCR: no bundled model — fetching config + weights from vocr.vn "
                    "(needs internet, ~152 MB once). Run: python tools/fetch_vietocr_model.py"
                )
                config = Cfg.load_config_from_name(self.model_name)
            # Keep OFF. `cnn.pretrained: True` in the yaml makes torchvision download
            # ImageNet vgg19_bn weights from download.pytorch.org — a second, larger
            # network fetch that the fine-tuned .pth overwrites anyway.
            config["cnn"]["pretrained"] = False
            config["device"] = "cpu"
            try:
                import torch
                if torch.cuda.is_available():
                    config["device"] = "cuda:0"
                    logger.info("VietOCR using GPU")
            except ImportError:
                pass
            self._predictor = Predictor(config)
            logger.info("VietOCR model loaded successfully")
        return self._predictor

    def recognize(self, image: Image.Image) -> str:
        """Recognize Vietnamese text from a single-line cropped image."""
        return self.predictor.predict(image)

    def recognize_batch(self, images: list[Image.Image]) -> list[str]:
        """Batch recognize text from multiple cropped line images."""
        return self.predictor.predict_batch(images)


class PaddleOCREngine(BaseOCREngine):
    """OCR using PaddleOCR with Vietnamese language support.

    Handles full document layout: text detection + recognition in one pass.
    """

    # PP-OCRv5 ships "server" (heavy) and "mobile" (light) models. lang="vi"
    # defaults to the SERVER detection model, which dominated CPU runtime in
    # profiling (~42s/page vs ~18s with the mobile detector, same line count).
    # We swap ONLY the detector to mobile: it's the expensive stage and accuracy
    # is unchanged. The recognizer is left at the lang="vi" default — the mobile
    # recognizer mangles Vietnamese diacritics ("Công"->"Cong", "giữa"->"gia")
    # for only ~4s extra, not worth it. Both overridable via env.
    _DEFAULT_DET_MODEL = "PP-OCRv5_mobile_det"
    _DEFAULT_REC_MODEL = None  # None -> PaddleOCR picks the lang-specific recognizer

    def __init__(self, lang: str = "vi", det_model: str | None = None, rec_model: str | None = None):
        import os
        self.lang = lang
        self.det_model = det_model or os.getenv("PADDLE_DET_MODEL") or self._DEFAULT_DET_MODEL
        self.rec_model = rec_model or os.getenv("PADDLE_REC_MODEL") or self._DEFAULT_REC_MODEL
        self._ocr = None

    @property
    def ocr(self):
        if self._ocr is None:
            logger.info("Loading PaddleOCR lang=%s det=%s rec=%s", self.lang, self.det_model, self.rec_model or "default")
            # MUST stay immediately above the paddle import — see the function's
            # docstring for the WinError 127 it prevents.
            _preload_torch_for_paddle()
            from paddleocr import PaddleOCR
            # PaddleOCR 3.x API: `use_angle_cls`/`show_log` removed. Disable the
            # doc-orientation, unwarping and textline-orientation sub-pipelines we
            # don't need (faster load + inference; profiling showed orientation had
            # negligible accuracy benefit on typed contracts).
            # enable_mkldnn=False avoids a paddlepaddle 3.3 PIR+oneDNN bug
            # (NotImplementedError: ConvertPirAttribute2RuntimeAttribute) on CPU —
            # re-tested with mobile models and PIR disabled, still crashes, so it
            # stays off until paddlepaddle is upgraded.
            kwargs = dict(
                lang=self.lang,
                text_detection_model_name=self.det_model,
                use_textline_orientation=False,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                enable_mkldnn=False,
            )
            if self.rec_model:
                kwargs["text_recognition_model_name"] = self.rec_model
            self._ocr = PaddleOCR(**kwargs)
            logger.info("PaddleOCR loaded successfully")
        return self._ocr

    def recognize(self, image: Image.Image) -> str:
        """Recognize text from image using PaddleOCR.

        Returns all detected text joined by newlines, preserving reading order.
        """
        import numpy as np
        results = self.ocr.predict(np.array(image))

        if not results:
            return ""

        # PaddleOCR 3.x returns a list of OCRResult (dict-like), one per image.
        res = results[0]
        texts = res.get("rec_texts", []) if hasattr(res, "get") else []
        return "\n".join(texts)

    def detect_only(self, image: Image.Image) -> list[list[list[int]]]:
        """Run text detection, returns list of bounding boxes.

        Each bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]].
        """
        import numpy as np
        results = self.ocr.predict(np.array(image))

        if not results:
            return []

        res = results[0]
        polys = res.get("dt_polys", None) if hasattr(res, "get") else None
        if polys is None:
            return []

        # dt_polys is an ndarray of shape (N, 4, 2); normalise to nested lists.
        return [np.asarray(p).tolist() for p in polys]

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions. Returns [(text, [x0,y0,x1,y1]), ...].

        Boxes are axis-aligned in image-pixel coordinates (top-left origin).
        Used to build a searchable PDF text layer.
        """
        import numpy as np
        results = self.ocr.predict(np.array(image))
        if not results:
            return []
        res = results[0]
        texts = res.get("rec_texts", []) if hasattr(res, "get") else []
        polys = res.get("dt_polys", []) if hasattr(res, "get") else []
        out: list[tuple[str, list[float]]] = []
        for text, poly in zip(texts, polys):
            p = np.asarray(poly, dtype=float)
            out.append((text, [float(p[:, 0].min()), float(p[:, 1].min()),
                               float(p[:, 0].max()), float(p[:, 1].max())]))
        return out


class HybridOCREngine(BaseOCREngine):
    """Hybrid engine: PaddleOCR for text detection + VietOCR for recognition.

    This combines PaddleOCR's robust layout detection with VietOCR's superior
    Vietnamese text recognition accuracy. Best of both worlds for Vietnamese
    documents with clean typed text.
    """

    def __init__(self, vietocr_model: str = "vgg_transformer", paddle_lang: str = "vi"):
        self._detector = PaddleOCREngine(lang=paddle_lang)
        self._recognizer = VietOCREngine(model_name=vietocr_model)

    def _crop_text_region(self, image: Image.Image, bbox: list[list[int]]) -> Image.Image:
        """Crop a text region from the image using its bounding box."""
        import numpy as np

        pts = np.array(bbox, dtype=np.float32)
        x_min = max(0, int(pts[:, 0].min()))
        y_min = max(0, int(pts[:, 1].min()))
        x_max = min(image.width, int(pts[:, 0].max()))
        y_max = min(image.height, int(pts[:, 1].max()))

        return image.crop((x_min, y_min, x_max, y_max))

    def _sort_bboxes_reading_order(self, bboxes: list[list[list[int]]]) -> list[list[list[int]]]:
        """Sort bounding boxes in reading order (top-to-bottom, left-to-right)."""
        if not bboxes:
            return bboxes

        def sort_key(bbox):
            # Use top-left y coordinate as primary, x as secondary
            y = min(pt[1] for pt in bbox)
            x = min(pt[0] for pt in bbox)
            return (y, x)

        return sorted(bboxes, key=sort_key)

    def recognize(self, image: Image.Image) -> str:
        """Detect text regions with PaddleOCR, then recognize with VietOCR."""
        # Step 1: Detect text regions
        bboxes = self._detector.detect_only(image)
        if not bboxes:
            logger.warning("No text regions detected")
            return ""

        # Step 2: Sort in reading order
        bboxes = self._sort_bboxes_reading_order(bboxes)

        # Step 3: Crop and recognize each region with VietOCR
        cropped_images = [self._crop_text_region(image, bbox) for bbox in bboxes]
        texts = self._recognizer.recognize_batch(cropped_images)

        logger.info("Hybrid OCR: detected %d regions, recognized %d texts", len(bboxes), len(texts))
        return "\n".join(texts)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions (PaddleOCR detect + VietOCR recognize).

        Returns [(text, [x0,y0,x1,y1]), ...] in image-pixel coords (top-left origin).
        """
        bboxes = self._detector.detect_only(image)
        if not bboxes:
            return []
        bboxes = self._sort_bboxes_reading_order(bboxes)
        crops = [self._crop_text_region(image, b) for b in bboxes]
        texts = self._recognizer.recognize_batch(crops)
        out: list[tuple[str, list[float]]] = []
        for b, t in zip(bboxes, texts):
            xs = [pt[0] for pt in b]
            ys = [pt[1] for pt in b]
            out.append((t, [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]))
        return out


class RapidOCREngine(BaseOCREngine):
    """OCR using RapidOCR (PP-OCR models on ONNX Runtime).

    Same detection + recognition models as PaddleOCR but run through onnxruntime
    instead of paddlepaddle. On CPU this is ~4-7x faster (onnxruntime has stable
    oneDNN/MLAS; paddlepaddle 3.3 crashes with mkldnn enabled), it sidesteps the
    paddle DLL/metadata packaging issues entirely, and the wheel is far smaller.

    WARNING — weak Vietnamese: the bundled recognizers (EN / LATIN PP-OCR) do NOT
    handle stacked Vietnamese diacritics (ộ/ử/ấ/ề/ị become o/u/a/e/i). Use this for
    speed on Latin-script text only; for correct Vietnamese use the Hybrid engine.
    A dedicated Vietnamese ONNX recognizer is planned to fix this. Returns boxes
    for the searchable-PDF layer.
    """

    def __init__(self, lang_rec: str = "EN"):
        self.lang_rec = lang_rec
        self._engine = None

    @property
    def engine(self):
        if self._engine is None:
            logger.info("Loading RapidOCR (onnxruntime) lang_rec=%s", self.lang_rec)
            from rapidocr import RapidOCR, LangRec
            self._engine = RapidOCR(params={"Rec.lang_type": LangRec[self.lang_rec]})
            logger.info("RapidOCR loaded successfully")
        return self._engine

    def recognize(self, image: Image.Image) -> str:
        """Recognize text; returns lines joined in detection (reading) order."""
        import numpy as np
        # All three named explicitly, and they are the config defaults, so this
        # changes nothing — except that it can no longer be changed FOR us.
        # rapidocr's update_params() writes these onto the instance and they stick,
        # so a det-only caller sharing a RapidOCR object would otherwise leave this
        # method silently returning no text at all. See RapidVietHybridOCREngine.
        res = self.engine(np.array(image), use_det=True, use_cls=True, use_rec=True)
        if res is None or res.txts is None:
            return ""
        return "\n".join(res.txts)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize text with positions: [(text, [x0,y0,x1,y1]), ...].

        RapidOCR returns quadrilateral boxes (N,4,2) in image-pixel coords; we
        reduce each to an axis-aligned bbox for the invisible PDF text layer.
        """
        import numpy as np
        # Same reason as recognize(): pin the mode, don't inherit it.
        res = self.engine(np.array(image), use_det=True, use_cls=True, use_rec=True)
        if res is None or res.txts is None or res.boxes is None:
            return []
        out: list[tuple[str, list[float]]] = []
        for text, poly in zip(res.txts, res.boxes):
            p = np.asarray(poly, dtype=float)
            out.append((text, [float(p[:, 0].min()), float(p[:, 1].min()),
                               float(p[:, 0].max()), float(p[:, 1].max())]))
        return out


class RapidVietHybridOCREngine(BaseOCREngine):
    """Detection via RapidOCR (ONNX) + recognition via VietOCR.

    The fast + accurate combination: RapidOCR's ONNX detector finds text lines (no
    paddlepaddle, no mkldnn crash), and VietOCR — the only local engine with a true
    Vietnamese recognizer — reads them with correct stacked diacritics (ộ/ử/ấ/ề/ị).
    This is the default engine and keeps paddlepaddle out of the hot path.

    WHAT IT ACTUALLY COSTS, measured warm on 78 real 200-dpi A4 scanned contract
    pages (2026-09-16), so nobody plans against a number from a toy page:

        detect (this class, det-only)   1.38 s/page, flat — it barely varies
        recognise (VietOCR)             5-26 s/page, ~0.3 s per detected line

    i.e. **VietOCR is 80-95 % of the job** and it scales with how many lines are on
    the page (24-124 boxes across this corpus, ~47 typical). Detection is noise by
    comparison. Anyone optimising this pipeline should go straight at the recogniser
    — realistically exporting VietOCR to ONNX — and not at detection, which is
    already as cheap as it can usefully get. See `_detect_boxes` for what was
    already taken out of it and docs/RESEARCH-2026-09-15-deps-perf-audit.md §13.

    (The plain HybridOCREngine uses PaddleOCR for detection, which loads slower and
    drags paddlepaddle into the pipeline; this class supersedes it as the default.)
    """

    def __init__(self, vietocr_model: str = "vgg_transformer"):
        self._detector = RapidOCREngine()
        self._recognizer = VietOCREngine(model_name=vietocr_model)

    def _detect_boxes(self, image: Image.Image) -> list:
        """Run RapidOCR DETECTION ONLY; return quad boxes (Nx4x2) in reading order.

        This used to run the whole RapidOCR pipeline (det + cls + rec) and throw the
        recognised text away, because an old comment claimed detection-only mode
        "over-segments lines into words, which hurts VietOCR's per-line recognition."

        MEASURED ON A REAL 78-PAGE SCANNED CONTRACT (2026-09-16), and it does not:
        det-only produced the identical box set on 70 of 78 pages, **never lost a
        single box on any page**, and cut the detect stage from 4.17 s to 1.38 s per
        page — -67 % of detection, which is **-12.4 % end-to-end** once VietOCR's
        share is counted honestly (see the class docstring: VietOCR is ~81 % of the
        work). On the 8 pages that differed it returned 14 boxes MORE, not fewer.

        Those 14 extra boxes are the real trade, so state it exactly. Turning rec
        off also turns off the two filters rapidocr applies in `build_final_output`:
        it drops boxes whose text came back empty, then drops boxes scoring under
        `text_score` (0.5). Both scores come from the **PP-OCR Latin recogniser** —
        the very component this class exists to avoid, because it cannot read
        Vietnamese diacritics. So that filter was never judging "is this text", it
        was judging "can an English recogniser read this".

        On page 72 of that corpus — the acknowledgement/signature page — what it threw
        away was the line sitting between `Signature/ Chữ ký:` and `Date/ Ngày:`, i.e.
        **the signature line itself**: `THS. Đoàn Văn Động`. (The name is typed
        elsewhere on that page and survived; it is the signature block that came back
        empty.) The other 13 extra boxes were sub-character fragments off the two round
        stamps.

        Trading 13 stray glyphs per 78 pages for the signature line and a third of the
        detect time is the right way round. cls goes off with it: it only rotates
        the crops fed to rec, and we re-crop from the original PIL image ourselves,
        so it has never been able to affect this function's output.

        OCR_RAPID_DET_ONLY=0 restores the old full-pipeline behaviour byte for byte.
        """
        import numpy as np
        # Passed per call, all three explicitly, on purpose: rapidocr's
        # update_params() SETS THESE ON THE INSTANCE and they stick for every later
        # call. Naming all three each time means this engine's mode can never be
        # left behind by some other caller's flags.
        det_only = os.getenv("OCR_RAPID_DET_ONLY", "1") != "0"
        res = self._detector.engine(
            np.array(image), use_det=True, use_cls=not det_only, use_rec=not det_only
        )
        # NB: det-only returns TextDetOutput, full returns RapidOCROutput. Both
        # carry `.boxes`, which is all this function reads.
        if res is None or res.boxes is None:
            return []
        boxes = [np.asarray(b, dtype=float) for b in res.boxes]
        # reading order: top-to-bottom, then left-to-right
        boxes.sort(key=lambda b: (float(b[:, 1].min()), float(b[:, 0].min())))
        return boxes

    @staticmethod
    def _crop(image: Image.Image, box) -> Image.Image:
        x0, y0 = box[:, 0].min(), box[:, 1].min()
        x1, y1 = box[:, 0].max(), box[:, 1].max()
        return image.crop((max(0, int(x0)), max(0, int(y0)), int(x1), int(y1)))

    def recognize(self, image: Image.Image) -> str:
        boxes = self._detect_boxes(image)
        if not boxes:
            return ""
        crops = [self._crop(image, b) for b in boxes]
        texts = self._recognizer.recognize_batch(crops)
        return "\n".join(texts)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        """Recognize with positions for the searchable-PDF layer.

        Boxes from RapidOCR (image-pixel coords), text from VietOCR.
        """
        boxes = self._detect_boxes(image)
        if not boxes:
            return []
        crops = [self._crop(image, b) for b in boxes]
        texts = self._recognizer.recognize_batch(crops)
        out: list[tuple[str, list[float]]] = []
        for b, t in zip(boxes, texts):
            out.append((t, [float(b[:, 0].min()), float(b[:, 1].min()),
                            float(b[:, 0].max()), float(b[:, 1].max())]))
        return out


class AutoOCREngine(BaseOCREngine):
    """Automatic engine selection.

    Priority favours Vietnamese accuracy over raw speed: the PP-OCR multilingual
    recognizers (RapidOCR, PaddleOCR 3.x) mangle stacked diacritics, so engines
    that recognise with VietOCR are preferred.

    Priority:
    1. RapidVietHybridOCREngine (RapidOCR detect + VietOCR) - fast AND correct
    2. HybridOCREngine (PaddleOCR detect + VietOCR) - correct, slower detect
    3. RapidOCREngine (PP-OCR on ONNX Runtime) - fast full-page, weak diacritics
    4. PaddleOCREngine (full pipeline) - fallback
    5. VietOCREngine (recognition only) - last resort, single lines only
    """

    def __init__(self, vietocr_model: str = "vgg_transformer"):
        self.vietocr_model = vietocr_model
        self._engine: BaseOCREngine | None = None

    @property
    def engine(self) -> BaseOCREngine:
        if self._engine is None:
            # Try RapidViet first (RapidOCR ONNX detect + VietOCR recognize):
            # fast detection with no paddle, correct Vietnamese diacritics.
            try:
                self._engine = RapidVietHybridOCREngine(vietocr_model=self.vietocr_model)
                _ = self._engine._detector.engine        # load onnx detector
                _ = self._engine._recognizer.predictor   # load vietocr
                logger.info("Auto-selected RapidViet engine (RapidOCR detect + VietOCR)")
                return self._engine
            except Exception as e:
                logger.info("RapidViet unavailable: %s", e)

            # Fallback: Hybrid (PaddleOCR detect + VietOCR) — still correct dấu.
            try:
                self._engine = HybridOCREngine(vietocr_model=self.vietocr_model)
                _ = self._engine._recognizer.predictor  # force model load
                logger.info("Auto-selected Hybrid engine (PaddleOCR detect + VietOCR)")
                return self._engine
            except Exception as e:
                logger.info("Hybrid unavailable: %s", e)

            # Fallback: RapidOCR (fast onnxruntime PP-OCR, weak Vietnamese)
            try:
                self._engine = RapidOCREngine()
                _ = self._engine.engine
                logger.info("Auto-selected RapidOCR engine (ONNX Runtime)")
                return self._engine
            except Exception as e:
                logger.info("RapidOCR unavailable: %s", e)

            # Fallback to PaddleOCR only
            try:
                self._engine = PaddleOCREngine()
                _ = self._engine.ocr
                logger.info("Auto-selected PaddleOCR engine")
                return self._engine
            except Exception as e:
                logger.info("PaddleOCR unavailable: %s", e)

            # Last resort: VietOCR only (single line recognition)
            logger.warning("Only VietOCR available - works on single text lines only")
            self._engine = VietOCREngine(self.vietocr_model)

        return self._engine

    def recognize(self, image: Image.Image) -> str:
        return self.engine.recognize(image)

    def recognize_boxes(self, image: Image.Image) -> list[tuple[str, list[float]]]:
        return self.engine.recognize_boxes(image)


def create_engine(engine_type: str = "auto", **kwargs) -> BaseOCREngine:
    """Factory function to create an OCR engine.

    Args:
        engine_type: "rapidocr", "vietocr", "paddleocr", "hybrid", or "auto"
        **kwargs: Additional arguments passed to engine constructor

    Returns:
        An OCR engine instance
    """
    engines = {
        "rapidviet": RapidVietHybridOCREngine,
        "rapidocr": RapidOCREngine,
        "vietocr": VietOCREngine,
        "paddleocr": PaddleOCREngine,
        "hybrid": HybridOCREngine,
        "auto": AutoOCREngine,
    }
    if engine_type not in engines:
        raise ValueError(f"Unknown engine: {engine_type}. Choose from: {list(engines.keys())}")
    return engines[engine_type](**kwargs)
