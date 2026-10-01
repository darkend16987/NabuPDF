"""Guards for the `garbage=` level used when a route merely re-saves a document.

Why this exists. `tobytes(garbage=3)` merges duplicate objects and costs ~quadratic time
in the object count (600 pages: 5.2 s vs 0.31 s at level 2; docs/REVIEW-2026-10-01 S3),
paid on every write route — notably every "Áp dụng" in Sửa nội dung. Those routes now
share ONE constant, `WRITE_GARBAGE` (src/pdf/util.py), set to 2. Two things must not
drift back or away silently:

  1. Nobody reintroduces a literal `garbage=3` (it would pass every functional test and
     quietly bring the slow save back). /compress is the one place that wants more
     (`garbage=4`, merging duplicate streams IS its job) and keeps its own literal.
  2. The level stays >= 1. That level is what deletes the ORPHANED objects a redaction
     leaves behind — i.e. what makes edited-away text actually gone from the file rather
     than merely unreferenced (BI-23). Lowering it to 0 would be the "faster" change that
     breaks a promise to the user.

Also pins the accepted price (output <= ~10% larger than level 3, measured 1.5–3%).

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import re
from pathlib import Path

import fitz  # PyMuPDF

import api
from src.pdf.util import WRITE_GARBAGE

ROOT = Path(__file__).resolve().parent
MARKER = b"ORPHAN_SECRET_MARKER_7f3a"


def _pdf_with_orphan(marker: bytes = MARKER) -> fitz.Document:
    """A one-page document carrying an object that NOTHING references."""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "hello")
    xref = doc.get_new_xref()
    doc.update_object(xref, "<</Marker (" + marker.decode("ascii") + ")>>")
    return doc


def test_no_literal_garbage_3_anywhere():
    offenders = []
    for path in [ROOT / "api.py", *sorted((ROOT / "src").rglob("*.py"))]:
        for n, line in enumerate(path.read_text(encoding="utf8").splitlines(), 1):
            if re.search(r"garbage\s*=\s*3\b", line) and not line.lstrip().startswith("#"):
                offenders.append(f"{path.relative_to(ROOT)}:{n}")
    assert not offenders, f"use WRITE_GARBAGE instead of a literal garbage=3: {offenders}"


def test_compress_keeps_its_own_stronger_level():
    src = (ROOT / "api.py").read_text(encoding="utf8")
    body = src[src.index("def _compress_pdf_bytes"):]
    body = body[: body.index("\nasync def ") if "\nasync def " in body else len(body)]
    assert re.search(r"garbage\s*=\s*4\b", body), "/compress must keep garbage=4 (merging duplicate streams is its job)"


def test_write_level_is_pinned_and_never_below_one():
    assert WRITE_GARBAGE == 2, f"WRITE_GARBAGE changed to {WRITE_GARBAGE}: re-measure size/time (S3) before accepting"
    assert WRITE_GARBAGE >= 1, "level 0 keeps orphaned objects => redacted text stays in the file (BI-23)"


def test_orphaned_objects_are_dropped_at_the_write_level():
    doc = _pdf_with_orphan()
    try:
        # control: the marker really is in the file when nothing is collected,
        # otherwise the assertion below could not fail.
        assert MARKER in doc.tobytes(garbage=0), "control failed: orphan object not serialised at garbage=0"
        out = doc.tobytes(deflate=True, garbage=WRITE_GARBAGE)
    finally:
        doc.close()
    assert MARKER not in out, "an unreferenced object survived the write - redaction leftovers would too"


def test_a_real_route_drops_the_orphan_and_stays_openable():
    doc = _pdf_with_orphan()
    src_b64 = base64.b64encode(doc.tobytes(garbage=0)).decode("ascii")
    doc.close()
    res = asyncio.run(api.add_page_numbers(api.PageNumberRequest(pdf_b64=src_b64)))
    out = base64.b64decode(res.data_b64)
    assert MARKER not in out, "/add-page-numbers output still carries the orphan object"
    check = fitz.open(stream=out, filetype="pdf")
    try:
        assert check.page_count == 1
    finally:
        check.close()


def test_price_of_level_2_is_bounded():
    """The trade-off the owner accepted: smaller write time for a few % more bytes."""
    doc = fitz.open()
    for i in range(120):
        p = doc.new_page(width=595, height=842)
        for k in range(6):
            p.insert_text((50, 80 + 20 * k), f"Trang {i + 1} dong {k} noi dung hop dong thuong mai")
        p.draw_rect(fitz.Rect(40, 60, 550, 300))
    base = doc.tobytes()
    doc.close()
    res = asyncio.run(
        api.add_page_numbers(api.PageNumberRequest(pdf_b64=base64.b64encode(base).decode("ascii")))
    )
    out = base64.b64decode(res.data_b64)
    ref_doc = fitz.open(stream=out, filetype="pdf")
    try:
        ref = ref_doc.tobytes(deflate=True, garbage=3)
    finally:
        ref_doc.close()
    ratio = len(out) / len(ref)
    assert ratio <= 1.10, f"level-2 output is {ratio:.3f}x the level-3 size (budget 1.10)"


if __name__ == "__main__":
    import sys

    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except AssertionError as e:
            failed += 1
            print("FAIL", name, "-", e)
    print("All write-garbage tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
