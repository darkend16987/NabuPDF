"""RapidViet detection: prove it asks RapidOCR for DETECTION ONLY, and why.

Background — the thing this guards. `RapidVietHybridOCREngine` recognises text with
VietOCR and uses RapidOCR purely to find the line boxes. Until 2026-09-16 it ran
RapidOCR's WHOLE pipeline (det + cls + rec) and discarded the text, on the strength
of a comment claiming detection-only "over-segments lines into words".

Measured on a real 78-page scanned contract, that claim is false: det-only returned
the identical box set on 70 of 78 pages and never lost a box on any page, while
cutting detection from 4.17 s to 1.38 s per page. It also RECOVERED content the old
path silently dropped — turning rec off also turns off rapidocr's "empty text" and
`text_score < 0.5` filters, and those scores come from the PP-OCR *Latin* recogniser,
which cannot read Vietnamese. It had been deleting lines like `THS. Đoàn Văn Động`.

Why this file exists rather than the corpus run: the corpus proves the OUTPUT is
right, but it needs a 35 MB scan, both models and ~15 minutes. These checks pin the
CONTRACT — which flags are sent, that nothing reads `.txts`, that reading order holds
— in under a second with no models at all, so a future edit that quietly re-enables
the recogniser fails here instead of in someone's OCR bill.

Run:  .venv\\Scripts\\python test_ocr_det_only.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Check names below are Vietnamese; a bare `python test_...py` in a cp1252 console
# would otherwise die on the first ok() instead of reporting a result.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from PIL import Image

from src.ocr.engine import RapidVietHybridOCREngine

PASS = 0
FAIL = 0


def check(name: str, actual, expected) -> None:
    global PASS, FAIL
    if actual == expected:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}\n       got      {actual!r}\n       expected {expected!r}")


def ok(name: str, cond: bool) -> None:
    check(name, bool(cond), True)


# --- a stand-in for rapidocr ------------------------------------------------
# Shaped like `TextDetOutput`: it has `.boxes` and NOTHING else. That is the point —
# in det-only mode rapidocr really does return that type, so if any line of
# `_detect_boxes` ever reaches for `.txts` or `.scores` this raises AttributeError
# instead of quietly working because a full-pipeline object happened to have them.
class DetOutput:
    __slots__ = ("boxes",)

    def __init__(self, boxes):
        self.boxes = boxes


class Recorder:
    """Stands in for `RapidOCR.__call__`, remembering how it was invoked."""

    def __init__(self, boxes=None):
        self.calls: list[dict] = []
        self.boxes = boxes if boxes is not None else []

    def __call__(self, img, **kw):
        self.calls.append(kw)
        return DetOutput(self.boxes)


def quad(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def engine_with(rec: Recorder) -> RapidVietHybridOCREngine:
    """Build the engine WITHOUT loading any model.

    __init__ only constructs the two lazy wrappers, so overwriting the detector's
    cached `_engine` here means neither the ONNX detector nor VietOCR is ever built.
    """
    eng = RapidVietHybridOCREngine()
    eng._detector._engine = rec
    return eng


IMG = Image.new("RGB", (400, 300), "white")


print("-- flags sent to RapidOCR --")

os.environ.pop("OCR_RAPID_DET_ONLY", None)
rec = Recorder()
engine_with(rec)._detect_boxes(IMG)
check("mặc định: gọi đúng 1 lần", len(rec.calls), 1)
check(
    "mặc định = CHỈ detect (cls và rec đều tắt)",
    rec.calls[0],
    {"use_det": True, "use_cls": False, "use_rec": False},
)

# The three flags must be named EVERY call, not left to instance state: rapidocr's
# update_params() writes them onto the RapidOCR object and they stick for every
# later call, so an omitted flag would silently inherit whatever ran last.
ok("cả ba cờ đều được nêu tên (không dựa vào trạng thái dính)",
   set(rec.calls[0]) == {"use_det", "use_cls", "use_rec"})

os.environ["OCR_RAPID_DET_ONLY"] = "0"
rec = Recorder()
engine_with(rec)._detect_boxes(IMG)
check(
    "OCR_RAPID_DET_ONLY=0 trả lại pipeline cũ nguyên vẹn",
    rec.calls[0],
    {"use_det": True, "use_cls": True, "use_rec": True},
)

for val in ("1", "", "yes", "false"):
    os.environ["OCR_RAPID_DET_ONLY"] = val
    rec = Recorder()
    engine_with(rec)._detect_boxes(IMG)
    ok(f"OCR_RAPID_DET_ONLY={val!r} → vẫn det-only (chỉ '0' mới tắt)",
       rec.calls[0]["use_rec"] is False)
os.environ.pop("OCR_RAPID_DET_ONLY", None)


print("\n-- hình dạng kết quả --")

rec = Recorder(boxes=[])
check("không có box → trả list rỗng", engine_with(rec)._detect_boxes(IMG), [])

rec = Recorder(boxes=None)
check("boxes=None → trả list rỗng, không ném", engine_with(rec)._detect_boxes(IMG), [])


class NoneOutput(Recorder):
    def __call__(self, img, **kw):
        self.calls.append(kw)
        return None


rec = NoneOutput()
check("rapidocr trả None → list rỗng", engine_with(rec)._detect_boxes(IMG), [])


print("\n-- thứ tự đọc (trên xuống, rồi trái sang phải) --")

# Deliberately scrambled, and rows 0 and 1 interleave so a naive sort by x or by a
# single key gets it wrong. VietOCR reads the crops in exactly this order and the
# joined text is what the user sees, so order IS output.
boxes = [
    quad(200, 100, 300, 130),   # hàng 2 phải
    quad(10, 10, 100, 40),      # hàng 1 trái
    quad(120, 100, 190, 130),   # hàng 2 trái
    quad(150, 10, 260, 40),     # hàng 1 phải
]
rec = Recorder(boxes=boxes)
got = engine_with(rec)._detect_boxes(IMG)
check("số box giữ nguyên", len(got), 4)
check(
    "sắp đúng: (trên,trái) → (trên,phải) → (dưới,trái) → (dưới,phải)",
    [(int(b[:, 0].min()), int(b[:, 1].min())) for b in got],
    [(10, 10), (150, 10), (120, 100), (200, 100)],
)
ok("mỗi box là ndarray float (VietOCR crop dựa vào đó)",
   all(isinstance(b, np.ndarray) and b.dtype == np.float64 for b in got))


print("\n-- các box đi thẳng sang VietOCR, không qua bộ lọc nào --")

# The 14 extra boxes det-only keeps are the whole trade of this change. If someone
# later adds a "tidy up junk" filter here, the corpus numbers in _detect_boxes stop
# describing the code — so make the absence of a filter an explicit, failing check.
many = [quad(0, i * 10, 5, i * 10 + 4) for i in range(30)]  # 30 ô tí xíu 5x4 px
rec = Recorder(boxes=many)
check("box nhỏ xíu KHÔNG bị loại (không có bộ lọc hình học nào)",
      len(engine_with(rec)._detect_boxes(IMG)), 30)


print(f"\n{PASS} pass, {FAIL} fail")
sys.exit(1 if FAIL else 0)
