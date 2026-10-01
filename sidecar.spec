# PyInstaller build spec for the Nabu PDF desktop sidecar.
#
# Build:  pyinstaller sidecar.spec --noconfirm
# Output: dist/sidecar/sidecar.exe  (onedir — bundled by electron-builder)
#
# NOTE: torch / rapidocr / onnxruntime / vietocr ship large native libs and data
# files. collect_all() pulls binaries + datas + hidden imports for each package.
# Expect to iterate: build, run `dist/sidecar/sidecar.exe --port 8000`, read the
# ModuleNotFoundError, then add the missing module to `extra_hiddenimports` below.

from PyInstaller.utils.hooks import collect_all, copy_metadata

# Heavy packages whose binaries/datas/hidden imports must be collected wholesale.
# NB: fitz/pymupdf and matplotlib are imported *lazily* (inside functions in api.py)
# for searchable/compress/text-edit + the Vietnamese DejaVuSans font, so PyInstaller's
# static analysis misses them — they MUST be collected here or the packaged app fails
# at runtime on those features. collect_all("matplotlib") bundles mpl-data/fonts/ttf/
# DejaVuSans.ttf (the font _vietnamese_font() looks up).
# Default engine = RapidViet (RapidOCR ONNX detect + VietOCR recognise). The
# paddle stack is intentionally NOT bundled: it's only a manual fallback
# (OCR_ENGINE=paddleocr/hybrid), AutoOCREngine degrades gracefully without it, and
# dropping it shaves ~400MB off the installer/portable (paddlepaddle ~392MB +
# paddlex ~19MB + paddleocr). shapely + pyclipper feed RapidOCR's detection
# post-process; skimage/scipy arrive via vietocr (albumentations/imgaug) so stay.
HEAVY_PACKAGES = (
    "rapidocr",  # default engine: PP-OCR on onnxruntime (bundles default config yaml)
    "onnxruntime",  # native inference runtime for rapidocr; ships its own DLLs
    "torch",
    "torchvision",
    "vietocr",
    "cv2",
    "shapely",
    "pyclipper",
    "skimage",
    "scipy",
    "google.genai",
    "openpyxl",
    "docx",  # python-docx (import name); PDF→Office DOCX export, lazy-imported
    "lxml",  # python-docx's engine; ships native binaries collect_all must gather
    "fitz",  # PyMuPDF (import name); lazy-imported in api.py
    "pymupdf",  # newer PyMuPDF dist name — loop skips whichever isn't present
    "matplotlib",  # provides DejaVuSans.ttf for the Vietnamese text layer / text-edit
)

# ---------------------------------------------------------------------------
# The VietOCR model, shipped INSIDE the app (see tools/fetch_vietocr_model.py)
# ---------------------------------------------------------------------------
#
# Without this, vietocr 0.3.13 fetches its model at RUNTIME: two YAML GETs to
# vocr.vn on every Predictor construction (cached nowhere), then a 151.8 MB
# vgg_transformer.pth download into tempfile.gettempdir() — %TEMP%, which Windows
# Storage Sense sweeps. Measured 286 s to become ready on a machine that had already
# run OCR successfully. src/ocr/engine.py::_vietocr_local_config looks for these files
# under sys._MEIPASS first, so bundling them here is what makes OCR genuinely offline
# (DESIGN.md D2) and kills the dependency on one Vietnamese host staying up.
#
# The .pth is NOT in git. A build host that skipped the fetch still produces a WORKING
# app — engine.py falls back to the old download path — but it ships the very problem
# this exists to fix, so say so loudly rather than failing the build silently.
import os as _os

# SPECPATH is injected by PyInstaller: the directory holding this spec (= repo root).
_VIETOCR_DIR = _os.path.join(SPECPATH, "models", "vietocr")
_VIETOCR_FILES = ("base.yml", "vgg-transformer.yml", "vgg_transformer.pth")

vietocr_datas = []
for _name in _VIETOCR_FILES:
    _src = _os.path.join(_VIETOCR_DIR, _name)
    if _os.path.isfile(_src):
        vietocr_datas.append((_src, _os.path.join("models", "vietocr")))
    else:
        print(f"[sidecar.spec] *** MISSING {_src}")
        print("[sidecar.spec] *** OCR will fall back to downloading from vocr.vn at first use.")
        print("[sidecar.spec] *** Fix with:  python tools/fetch_vietocr_model.py")

datas, binaries, hiddenimports = list(vietocr_datas), [], []
for pkg in HEAVY_PACKAGES:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # package may be optional / not importable at build time
        print(f"[sidecar.spec] skipped {pkg}: {exc}")

# Some packages probe their dependencies' *installed metadata* at runtime via
# importlib.metadata.version(). collect_all() bundles a package's own metadata but
# NOT its dependencies', so in the frozen app those lookups return None and the
# probe fails. Bundle the .dist-info metadata for the rapidocr pipeline's deps.
# Names are the *distribution* names (as on PyPI), not import names.
METADATA_PACKAGES = (
    "rapidocr",
    "onnxruntime",
    "imagesize",
    "opencv-contrib-python",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
)
for dist in METADATA_PACKAGES:
    try:
        datas += copy_metadata(dist)
    except Exception as exc:  # not installed under this dist name on the build host
        print(f"[sidecar.spec] no metadata for {dist}: {exc}")

# uvicorn loads protocol/loop implementations dynamically — name them explicitly.
extra_hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # PDF compare module — imported lazily inside the /compare endpoint, so pin it
    # explicitly to be safe against a frozen-app ModuleNotFoundError.
    "src.compare",
    "src.compare.comparator",
    # OCR/LLM worker pools (S1/S2) - imported statically by api.py; pinned like the others.
    "src.offload",
    # PDF helper modules (Phase 4 refactor). api.py imports these statically so the
    # analysis already follows them; pinned here too to match the project's cautious
    # convention against stale/partial frozen builds.
    "src.pdf.util",
    "src.pdf.fonts",
    "src.pdf.legacy_text",
    "src.pdf.layout",
    # PDF→Office converter — imported lazily inside the /pdf-to-office endpoint,
    # so pin it (and the analysis follows src.output.writer already).
    "src.output.pdf_office",
    # Add modules here as PyInstaller reports them missing at runtime.
]

a = Analysis(
    ["sidecar.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + extra_hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Hard-exclude the paddle stack so a build host that still has it installed
    # doesn't drag ~400MB back in via some transitive collect. RapidViet is default.
    #
    # pyarrow + altair ride in behind streamlit (the Streamlit web UI in app.py, which
    # the desktop sidecar never runs). pyarrow alone was 78 MB of the bundle. Verified
    # safe by running the whole test suite and an OCR smoke with all three blocked at
    # sys.meta_path: RapidViet still loaded and read the page identically.
    #
    # DO NOT add scikit-learn here, however tempting its 12.5 MB looks: albumentations
    # imports it at MODULE LOAD, albumentations is a hard dependency of vietocr, and
    # `from vietocr.tool.predictor import Predictor` therefore dies without it. The
    # same meta_path probe proved this — with sklearn blocked the engine fell all the
    # way through to the paddle branch. pandas is likewise left alone: it is only
    # reachable through paddlex (already excluded), so it costs nothing to keep and
    # removing it cannot be proven safe from here.
    excludes=[
        "streamlit", "tkinter", "matplotlib.tests", "PyQt5",
        "paddle", "paddleocr", "paddlex", "paddlepaddle",
        "pyarrow", "altair",
    ],
    noarchive=False,
)

# ---------------------------------------------------------------------------
# Drop build-time-only and unreachable payload that collect_all() sweeps in
# ---------------------------------------------------------------------------
#
# collect_all() takes a package wholesale — which is what makes it safe, and also
# what makes it fat. Three groups are dead weight in a RUNNING sidecar, measured on
# the v0.2.69 build (dist/sidecar = 1155 MB):
#
#   torch/include/**      37.8 MB  C++ headers. Only torch.utils.cpp_extension reads
#   torch/**/*.lib        45.7 MB  MSVC import libraries. Only a C++ linker reads
#                                  these. Nothing here JIT-compiles a custom op
#                                  (VietOCR is plain eager PyTorch, no torch.compile).
#   opencv_videoio_ffmpeg*.dll  52.5 MB  Two copies, because three OpenCV wheels are
#                                  installed over the same cv2/ directory. Loaded ONLY
#                                  by VideoCapture/VideoWriter. Verified empirically:
#                                  after running every cv2 call src/compare/drawing.py
#                                  makes, `tasklist /m` showed no ffmpeg/videoio module
#                                  in the process.
#   cv2/data/haarcascade_*.xml   6 MB  Cascade classifier data; nothing calls
#                                  cv2.CascadeClassifier.
#
# Filtering here (rather than not collecting) keeps collect_all's safety: if a future
# dependency genuinely needs one of these, the fix is to narrow the predicate below,
# in one obvious place, instead of unpicking a hook.
def _is_dead_weight(dest: str) -> bool:
    d = dest.replace("\\", "/")
    low = d.lower()
    if d.startswith("torch/include/"):
        return True
    if d.startswith("torch/") and low.endswith(".lib"):
        return True
    if "opencv_videoio_ffmpeg" in low and low.endswith(".dll"):
        return True
    if "cv2/data/haarcascade" in low:
        return True
    return False


def _prune(toc, label):
    kept = [e for e in toc if not _is_dead_weight(e[0])]
    print(f"[sidecar.spec] pruned {len(toc) - len(kept)} entries from {label}")
    return kept


a.binaries = _prune(a.binaries, "binaries")
a.datas = _prune(a.datas, "datas")

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    console=True,  # P0: keep console to read OCR logs while debugging. Disable for release.
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,  # UPX corrupts some torch/onnxruntime DLLs — leave off.
    name="sidecar",
)
