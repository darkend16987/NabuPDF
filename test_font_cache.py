"""The fitz.Font cache behind /edit-text (src/pdf/fonts.py::_font_object).

/edit-text used to build a fresh `fitz.Font` for every edit (twice with underline), each
one re-parsing the font program: 13-22% of a 200-edit batch (docs/REVIEW-2026-10-01 S7).
`_font_object` memoises them. A cache is only worth having if it cannot change results, so
this pins:

  1. identity   - same file / name / buffer content -> the SAME object; different -> not;
  2. staleness  - a font file that is replaced on disk is not served from the cache;
  3. failures   - an unreadable font raises every time (never cached), because every
                  caller relies on `except Exception` to fall back;
  4. bound      - the LRU never exceeds its cap, and cap 0 really disables caching;
  5. effect     - a 60-edit batch constructs ~1 Font instead of 60+;
  6. equivalence- the rendered page is PIXEL-IDENTICAL with the cache on and off.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import os
import shutil
import tempfile

import fitz  # PyMuPDF

import api
from src.pdf import fonts
from src.pdf.fonts import _font_object, _vietnamese_font


_DEFAULT_MAX = fonts._FONT_OBJ_CACHE_MAX  # the shipped default, captured before any test touches it


def _reset(max_size=_DEFAULT_MAX):
    fonts._FONT_OBJ_CACHE.clear()
    fonts._FONT_OBJ_CACHE_MAX = max_size


def test_caching_is_on_by_default():
    assert _DEFAULT_MAX >= 4, f"shipped cache cap is {_DEFAULT_MAX}: the cache is effectively off"


def test_same_inputs_give_the_same_object():
    _reset()
    path = _vietnamese_font()
    assert path, "no bundled Vietnamese font found"
    a = _font_object(fontfile=path)
    assert a is _font_object(fontfile=path)
    assert _font_object(fontname="helv") is _font_object(fontname="helv")
    assert _font_object(fontname="helv") is not _font_object(fontname="cour")
    data = open(path, "rb").read()
    b1 = _font_object(fontbuffer=data)
    b2 = _font_object(fontbuffer=bytes(bytearray(data)))  # equal content, different bytes object
    assert b1 is b2, "buffer key must be by content, not by object identity"
    assert b1 is not a, "a buffer font and a file font are separate cache entries"


def test_a_replaced_font_file_is_not_served_stale():
    _reset()
    path = _vietnamese_font()
    tmp = tempfile.mkdtemp()
    try:
        copy = os.path.join(tmp, "f.ttf")
        shutil.copy(path, copy)
        first = _font_object(fontfile=copy)
        assert first is _font_object(fontfile=copy)
        # same path, new content/mtime: must not return the old object
        with open(copy, "ab") as fh:
            fh.write(b"\0" * 16)
        os.utime(copy, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        assert _font_object(fontfile=copy) is not first, "stale Font served after the file changed"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_failures_are_not_cached_and_still_raise():
    _reset()
    for _ in range(2):
        try:
            _font_object(fontfile=os.path.join(tempfile.gettempdir(), "definitely-missing-font.ttf"))
        except Exception:
            continue
        raise AssertionError("a missing font file must raise (callers fall back on the exception)")
    try:
        _font_object(fontbuffer=b"not a font program")
    except Exception:
        pass
    else:
        raise AssertionError("garbage font bytes must raise")
    assert not fonts._FONT_OBJ_CACHE, "a failure left an entry in the cache"
    # and the coverage guard keeps its contract: unreadable font => "does not cover"
    assert fonts._font_covers("abc", fontfile="definitely-missing.ttf") is False


def test_cache_is_bounded_and_zero_disables_it():
    _reset(max_size=3)
    base = _vietnamese_font()
    data = open(base, "rb").read()
    for i in range(8):
        _font_object(fontbuffer=data + bytes([i]) * 0)  # same content...
    assert len(fonts._FONT_OBJ_CACHE) == 1
    for name in ("helv", "cour", "tiro", "symb", "zadb"):
        _font_object(fontname=name)
    assert len(fonts._FONT_OBJ_CACHE) <= 3, f"cache grew past its cap: {len(fonts._FONT_OBJ_CACHE)}"
    _reset(max_size=0)
    a = _font_object(fontname="helv")
    assert a is not _font_object(fontname="helv") and not fonts._FONT_OBJ_CACHE
    _reset()


# ---- end-to-end through the route ----------------------------------------------------

def _doc_and_edits(n=60, underline=False):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for k in range(n):
        page.insert_text((50, 30 + 12.5 * k), f"Line {k} original text here", fontsize=9)
    b64 = base64.b64encode(doc.tobytes()).decode("ascii")
    doc.close()
    spans = asyncio.run(api.text_spans(api.TextSpansRequest(pdf_b64=b64, page=0))).spans
    edits = [
        api.TextEdit(
            page=0, bbox=list(s.bbox), new_text="Tra cứu hóa đơn tại đây",
            size=s.size, font=s.font, color=s.color, underline=underline,
        )
        for s in spans
    ]
    return b64, edits


def _edit(b64, edits):
    res = asyncio.run(api.edit_text(api.EditTextRequest(pdf_b64=b64, edits=edits)))
    assert res.success, res.error
    return base64.b64decode(res.data_b64)


def _pixels(pdf_bytes):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return doc[0].get_pixmap(matrix=fitz.Matrix(2, 2)).samples
    finally:
        doc.close()


def test_a_batch_constructs_one_font_not_one_per_edit():
    _reset()
    b64, edits = _doc_and_edits(60, underline=True)
    real, count = fitz.Font, {"n": 0}

    def counting(*a, **kw):
        count["n"] += 1
        return real(*a, **kw)

    fitz.Font = counting
    try:
        _edit(b64, edits)
    finally:
        fitz.Font = real
    assert len(edits) >= 50
    assert count["n"] <= 6, f"{count['n']} fitz.Font constructions for {len(edits)} edits (was >= 2x per edit)"


def test_output_is_pixel_identical_with_and_without_the_cache():
    b64, edits = _doc_and_edits(40, underline=True)
    _reset(max_size=0)
    off = _pixels(_edit(b64, edits))
    _reset()
    on = _pixels(_edit(b64, edits))
    again = _pixels(_edit(b64, edits))  # warm cache on the second run
    _reset()
    assert off == on, "rendering differs between uncached and cached runs"
    assert on == again, "rendering differs between a cold and a warm cache"


if __name__ == "__main__":
    import sys

    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as e:  # AssertionError or anything unexpected: both are a failure
            failed += 1
            print("FAIL", name, "-", type(e).__name__, e)
    print("All font-cache tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
