"""Tests that VietOCR loads from the BUNDLED model and never reaches the network.

WHAT THIS GUARDS. vietocr 0.3.13 resolves its model at runtime, from the internet,
twice: `Cfg.load_config_from_name()` GETs two YAMLs from vocr.vn on every Predictor
construction and caches nothing, and `Predictor.__init__` downloads the 151.8 MB
vgg_transformer.pth into `tempfile.gettempdir()` — which Windows Storage Sense
deletes on a schedule. Measured 286 s to become ready on a machine that HAD already
run OCR. `src/ocr/engine.py::_vietocr_local_config` replaces both with files shipped
inside the app; these tests make sure it stays that way.

The load test is the one that matters: it blocks `socket.socket.connect` outright, so
ANY outbound call — requests, urllib, a torchvision weight fetch — fails the test
rather than quietly working on the developer's connection.

Skips itself (loudly, exit 0) when models/vietocr/vgg_transformer.pth is absent, the
same way desktop/test/sidecar-lifecycle.test.js skips without a dev venv. Run
`python tools/fetch_vietocr_model.py` to get it.

No pytest in the venv — plain runner, same style as the other test_*.py files.
"""

import socket
import sys
from pathlib import Path

import yaml

from src.ocr.engine import _vietocr_bundle_dirs, _vietocr_local_config

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / "models" / "vietocr"
WEIGHTS = BUNDLE / "vgg_transformer.pth"


class _NoNetwork:
    """Make every outbound TCP connect raise, for the duration of the with-block."""

    def __enter__(self):
        self._real = socket.socket.connect

        def _blocked(sock, addr, *a, **kw):
            raise AssertionError(
                "network access attempted during VietOCR load: %r — the bundled model "
                "is not being used" % (addr,)
            )

        socket.socket.connect = _blocked
        return self

    def __exit__(self, *exc):
        socket.socket.connect = self._real
        return False


def test_bundle_dirs_include_repo_root():
    dirs = _vietocr_bundle_dirs()
    assert BUNDLE in dirs, f"repo-root models/vietocr not searched; got {dirs}"


def test_config_yamls_are_committed():
    for name in ("base.yml", "vgg-transformer.yml"):
        p = BUNDLE / name
        assert p.is_file(), f"{p} missing — it is committed, did something delete it?"
        assert yaml.safe_load(p.read_text(encoding="utf-8")), f"{p} is empty/invalid"


def test_local_config_matches_the_yaml_merge():
    """The merge must replicate Cfg.load_config_from_name: base.yml UNDER the model."""
    cfg = _vietocr_local_config("vgg_transformer")
    assert cfg is not None, "bundled config not found"
    base = yaml.safe_load((BUNDLE / "base.yml").read_text(encoding="utf-8"))
    model = yaml.safe_load((BUNDLE / "vgg-transformer.yml").read_text(encoding="utf-8"))
    expected = dict(base)
    expected.update(model)
    for k, v in expected.items():
        if k == "weights":
            continue  # deliberately rewritten to the local path
        assert cfg[k] == v, f"config key {k!r} drifted: {cfg[k]!r} != {v!r}"
    # Fields the recogniser's behaviour actually depends on.
    assert cfg["backbone"] == "vgg19_bn"
    assert cfg["dataset"]["image_height"] == 32
    assert cfg["dataset"]["image_max_width"] == 512
    assert "ộ" in cfg["vocab"] and "ử" in cfg["vocab"], "Vietnamese vocab lost"


def test_unknown_model_falls_back_to_none():
    """A model we don't ship must return None so the caller uses the online path."""
    assert _vietocr_local_config("no_such_model_xyz") is None


def test_weights_resolve_to_a_local_file():
    cfg = _vietocr_local_config("vgg_transformer")
    w = str(cfg["weights"])
    assert not w.startswith("http"), f"weights still a URL: {w}"
    assert Path(w).is_file(), f"weights path does not exist: {w}"


def test_predictor_loads_with_the_network_blocked():
    """The real proof: build the Predictor with every TCP connect made to fail."""
    from vietocr.tool.predictor import Predictor

    cfg = _vietocr_local_config("vgg_transformer")
    cfg["cnn"]["pretrained"] = False  # same as engine.py; True would fetch from pytorch.org
    cfg["device"] = "cpu"
    with _NoNetwork():
        predictor = Predictor(cfg)
    assert predictor is not None
    assert predictor.vocab is not None


def test_recognition_still_reads_vietnamese_with_network_blocked():
    """End to end: a rendered Vietnamese line must come back with its diacritics."""
    import fitz
    from PIL import Image

    from src.ocr.engine import VietOCREngine
    from src.pdf.fonts import _vietnamese_font

    font = _vietnamese_font()
    assert font, "no Vietnamese font available"
    doc = fitz.open()
    page = doc.new_page(width=420, height=90)
    page.insert_font(fontname="DJV", fontfile=font)
    page.insert_text((14, 58), "CỘNG HÒA XÃ HỘI", fontname="DJV", fontsize=30)
    pix = page.get_pixmap(dpi=150, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    doc.close()

    engine = VietOCREngine()
    with _NoNetwork():
        text = engine.recognize(img)
    assert text and text.strip(), "VietOCR returned nothing"
    # Not an accuracy test — VietOCR's own accuracy is measured elsewhere. This only
    # asserts the offline path produced stacked-diacritic output at all.
    assert any(ch in text for ch in "ỘÒÃỘộòãệ"), f"no Vietnamese diacritics in {text!r}"


if __name__ == "__main__":
    if not WEIGHTS.is_file():
        print(f"SKIP test_vietocr_offline: {WEIGHTS} missing "
              f"(run: python tools/fetch_vietocr_model.py)")
        raise SystemExit(0)
    for fn in (
        test_bundle_dirs_include_repo_root,
        test_config_yamls_are_committed,
        test_local_config_matches_the_yaml_merge,
        test_unknown_model_falls_back_to_none,
        test_weights_resolve_to_a_local_file,
        test_predictor_loads_with_the_network_blocked,
        test_recognition_still_reads_vietnamese_with_network_blocked,
    ):
        fn()
        sys.stdout.buffer.write(f"PASS {fn.__name__}\n".encode("utf-8", "replace"))
        sys.stdout.flush()
    print("All vietocr-offline tests passed.")
