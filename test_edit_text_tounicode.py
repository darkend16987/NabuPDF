"""Tests for the TEXT LAYER of what /edit-text draws — reported as "thay xong thì
không tìm lại được".

The page looked right after a Thay tất cả, but its text said "I2_BD\\xadS\\xad5.001":
insert_text writes a ToUnicode CMap by reversing the font's cmap, and Windows Arial
maps U+002D and U+00AD (soft hyphen) to ONE glyph, U+0020 and U+00A0 to another.
PyMuPDF 1.27.2 picks the look-alike. So the replaced word could not be found again,
and a copy carried invisible soft hyphens. DejaVu has separate glyphs, which is why
nothing here ever showed it.

Two ways in:
  * a PORTABLE font — DejaVu Sans with its cmap edited (fontTools) so the look-alikes
    share glyphs exactly the way Arial's do; drives the helpers PyMuPDF-direct;
  * the real thing — /edit-text with Windows Arial Bold across several pages, which
    is also the only way to see that PyMuPDF shares ONE font object between pages
    (a per-page CMap rewrite left page 1 holding page 3's digits). Skipped where
    Arial Bold is not installed.
"""

import asyncio
import base64
import os
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

from api import EditTextRequest, TextEdit, TextSpansRequest, edit_text, text_spans
from src.pdf.fonts import (
    _drawn_glyph_map,
    _font_object,
    _font_xref_for_resource,
    _merge_tounicode,
    _parse_tounicode,
    _tounicode_cmap,
    _vietnamese_font,
)

ARIAL_BOLD = r"C:\Windows\Fonts\arialbd.ttf"
TEXT = "I2_BD-S-5.001 THÁP I2"


def _aliased_font() -> str:
    """DejaVu Sans with U+00AD → the hyphen's glyph and U+00A0 → the space's glyph."""
    from fontTools.ttLib import TTFont

    src = _vietnamese_font()
    assert src, "no DejaVu found"
    tt = TTFont(src)
    for table in tt["cmap"].tables:
        if table.isUnicode() and 0x2D in table.cmap and 0x20 in table.cmap:
            table.cmap[0xAD] = table.cmap[0x2D]
            table.cmap[0xA0] = table.cmap[0x20]
    fd, path = tempfile.mkstemp(suffix=".ttf")
    os.close(fd)
    tt.save(path)
    return path


def _draw(fontfile: str, text: str, pages: int = 1):
    doc = fitz.open()
    for _ in range(pages):
        p = doc.new_page()
        p.insert_font(fontname="F0", fontfile=fontfile)
        p.insert_text((50, 100), text, fontname="F0", fontsize=12)
    return doc


def _text(doc, pno=0) -> str:
    d = fitz.open(stream=doc.tobytes(garbage=3, deflate=True), filetype="pdf")
    try:
        return d[pno].get_text().strip()
    finally:
        d.close()


def test_aliased_font_reproduces_the_defect():
    """Guards the guard: without the merge the portable font really does extract the
    look-alikes — so the next test is measuring the fix, not PyMuPDF's good luck."""
    path = _aliased_font()
    try:
        doc = _draw(path, TEXT)
        t = _text(doc)
        assert "\u00ad" in t or "\u00a0" in t, (
            f"aliased font extracted cleanly ({t!r}) — PyMuPDF changed how it builds "
            "ToUnicode; re-measure before trusting these tests"
        )
    finally:
        Path(path).unlink(missing_ok=True)


def test_merge_restores_what_was_drawn():
    path = _aliased_font()
    try:
        doc = _draw(path, TEXT)
        page = doc[0]
        fx = _font_xref_for_resource(page, "F0")
        assert fx, "font resource not found on the page"
        assert _merge_tounicode(doc, fx, _drawn_glyph_map(_font_object(fontfile=path), TEXT))
        assert _text(doc) == TEXT
    finally:
        Path(path).unlink(missing_ok=True)


def test_merge_keeps_every_other_entry():
    """The CMap is shared state (one font object, many pages): the merge may change
    only the glyphs it was told about."""
    path = _aliased_font()
    try:
        doc = _draw(path, TEXT)
        fx = _font_xref_for_resource(doc[0], "F0")
        tu = int(doc.xref_get_key(fx, "ToUnicode")[1].split()[0])
        before = _parse_tounicode(doc.xref_stream(tu))
        drawn = _drawn_glyph_map(_font_object(fontfile=path), TEXT)
        _merge_tounicode(doc, fx, drawn)
        after = _parse_tounicode(doc.xref_stream(tu))
        assert before is not None and after is not None
        changed = {g for g in set(before) | set(after) if before.get(g) != after.get(g)}
        assert changed <= set(drawn), f"merge touched glyphs it did not draw: {sorted(changed - set(drawn))}"
    finally:
        Path(path).unlink(missing_ok=True)


def test_cmap_round_trips_pymupdfs_own_table():
    """PyMuPDF's CMap carries non-BMP code points as a bare number ("<10780>"), not a
    surrogate pair; the reader must take that, or every merge is silently refused."""
    doc = _draw(_vietnamese_font(), TEXT)
    fx = _font_xref_for_resource(doc[0], "F0")
    raw = doc.xref_stream(int(doc.xref_get_key(fx, "ToUnicode")[1].split()[0]))
    m1 = _parse_tounicode(raw)
    assert m1, "could not read PyMuPDF's own ToUnicode"
    assert _parse_tounicode(_tounicode_cmap(m1)) == m1


def test_cmap_reads_bare_supplementary_code_points():
    m = _parse_tounicode(b"1 beginbfrange\n<0001> <0002> <10780>\nendbfrange\n1 beginbfchar\n<0005> <1D11E>\nendbfchar")
    assert m == {1: "\U00010780", 2: "\U00010781", 5: "\U0001D11E"}
    assert _parse_tounicode(_tounicode_cmap(m)) == m


def test_unparseable_cmap_is_left_alone():
    assert _parse_tounicode(b"1 beginbfrange\n<0009> <0001> <0041>\nendbfrange") is None


# ---- through /edit-text, Windows Arial Bold, several pages ---------------------


def _lines(i: int, pages: int):
    """Page i's text. The LAST page has no hyphen and no space on purpose: the CMap is
    one object shared by every page, so a merge fed only the last page's characters
    would leave the earlier pages reading soft hyphens — which only a page that
    differs from the others can show (a uniform fixture let exactly that mutation
    through)."""
    if i == pages - 1:
        return (((50, 100), "I1", 14),)
    return (((50, 100), f"I1_BD-S-{i + 5}.00{i + 1}", 14), ((50, 140), "-THÁP I1", 10))


def _arial_src(pages: int) -> str:
    """A source whose OWN text layer is clean, like the customer's PDFsharp file.
    Built with insert_text, so it needs the very fix under test — without it the
    source already reads "\\xad" and the edit would faithfully keep what it was given."""
    doc = fitz.open()
    try:
        drawn = set()
        for i in range(pages):
            p = doc.new_page()
            p.insert_font(fontname="F0", fontfile=ARIAL_BOLD)
            for pt, s, fs in _lines(i, pages):
                p.insert_text(pt, s, fontname="F0", fontsize=fs)
                drawn.update(s)
        fx = _font_xref_for_resource(doc[0], "F0")
        assert _merge_tounicode(doc, fx, _drawn_glyph_map(_font_object(fontfile=ARIAL_BOLD), drawn))
        # Re-opened: MuPDF caches a loaded page's fonts, so the in-memory doc still
        # reads the CMap it had before update_stream.
        assert "­" not in _text(doc), "fixture source is not clean"
        return base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()


def test_edit_text_text_layer_is_what_was_typed_on_every_page():
    if not Path(ARIAL_BOLD).is_file():
        return  # no Arial Bold on this machine: the portable tests above still run
    pages = 3
    src = _arial_src(pages)
    edits = []
    for pno in range(pages):
        for t in asyncio.run(text_spans(TextSpansRequest(pdf_b64=src, page=pno))).spans:
            edits.append(TextEdit(page=pno, bbox=t.bbox, origin=t.origin,
                                  new_text=t.text.replace("I1", "I2"), size=t.size,
                                  color=t.color, font=t.font, bold=bool(t.flags & 16),
                                  orig_text=t.text, orig_size=t.size, dir=t.dir))
    res = asyncio.run(edit_text(EditTextRequest(pdf_b64=src, edits=edits)))
    assert res.success, res.error
    doc = fitz.open(stream=base64.b64decode(res.data_b64), filetype="pdf")
    try:
        for pno in range(pages):
            got = doc[pno].get_text()
            for _pt, line, _fs in _lines(pno, pages):
                want = line.replace("I1", "I2")
                assert want in got, f"page {pno + 1}: text layer reads {got!r}, wanted {want!r}"
            assert "\u00ad" not in got and "\u00a0" not in got, f"page {pno + 1}: {got!r}"
    finally:
        doc.close()


if __name__ == "__main__":
    for fn in (
        test_aliased_font_reproduces_the_defect,
        test_merge_restores_what_was_drawn,
        test_merge_keeps_every_other_entry,
        test_cmap_round_trips_pymupdfs_own_table,
        test_cmap_reads_bare_supplementary_code_points,
        test_unparseable_cmap_is_left_alone,
        test_edit_text_text_layer_is_what_was_typed_on_every_page,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All edit-text ToUnicode tests passed.")
