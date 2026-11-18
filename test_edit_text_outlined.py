"""BI-119 — /edit-text on OUTLINED text (visible glyphs = filled vector paths, real
characters only in an INVISIBLE text layer, render mode 3).

That is how AutoCAD's "plot text as geometry" writes a title block. /text-find sees
only the invisible layer; /edit-text used to redact just that layer (BI-23: text-only),
so the replacement was drawn on top of the old, still-visible outlines.

The fixture reproduces the structure measured on the customer's CT3 set: one filled
shape per glyph in the text colour + `3 Tr` text. Assertions are on rendered PIXELS
(an erased path and a hidden path both look "gone" to an object count, but only one is).

Guards, each of which a lazy fix would break:
  * only the edited span's glyphs go          -> neighbouring span's outlines stay
  * rules / other colours inside the box stay -> underline, red mark stay
  * a page with REAL text is untouched        -> helper is a no-op, bytes identical
"""

import asyncio
import base64

import fitz  # PyMuPDF

import api
from api import EditTextRequest, TextEdit, TextSpansRequest, edit_text, text_spans

BLACK = (0, 0, 0)
RED = (1, 0, 0)
X0, BASE = 56.0, 100.0           # span origin
STEP = 6.5                       # old glyph pitch: 6 glyphs end at X0+37, inside the
OLD = "TKBVTC"                   # invisible text's box (helv 11 -> X0+43.4), as on the real file
GLYPH_W, GLYPH_H = 4.5, 7.0


def _glyph_rects(x0: float, base: float, n: int):
    return [fitz.Rect(x0 + i * STEP, base - GLYPH_H, x0 + i * STEP + GLYPH_W, base) for i in range(n)]


def _outlined_pdf(*, rule=True, red_mark=True, neighbour=True) -> str:
    """Title-block-like page: OLD drawn as 6 filled black shapes + invisible text."""
    doc = fitz.open()
    try:
        page = doc.new_page()
        page.insert_text((X0, BASE), OLD, fontname="helv", fontsize=11, render_mode=3)
        for r in _glyph_rects(X0, BASE, len(OLD)):
            page.draw_rect(r, color=None, fill=BLACK)
        if rule:
            # a thin black FILLED rule across most of the span, inside its box: a rule,
            # not a glyph (same colour as the text — only its shape tells them apart)
            page.draw_rect(fitz.Rect(X0, BASE + 0.8, X0 + 42, BASE + 1.8), color=None, fill=BLACK)
        if red_mark:
            # inside the box, filled, but NOT the text colour
            page.draw_rect(fitz.Rect(X0 + 38, BASE - 2, X0 + 41, BASE), color=None, fill=RED)
        if neighbour:
            # another outlined span, far enough right to be outside the edited box
            page.insert_text((X0 + 120, BASE), "Z", fontname="helv", fontsize=11, render_mode=3)
            page.draw_rect(fitz.Rect(X0 + 120, BASE - GLYPH_H, X0 + 120 + GLYPH_W, BASE),
                           color=None, fill=BLACK)
        return base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()


def _real_text_pdf() -> str:
    """Control: VISIBLE text, with a black filled shape inside the span's box."""
    doc = fitz.open()
    try:
        page = doc.new_page()
        page.insert_text((X0, BASE), OLD, fontname="helv", fontsize=11)
        page.draw_rect(fitz.Rect(X0 + 40, BASE - 6, X0 + 44, BASE - 2), color=None, fill=BLACK)
        return base64.b64encode(doc.tobytes(deflate=True, garbage=3)).decode()
    finally:
        doc.close()


def _span(pdf_b64: str, text: str):
    spans = asyncio.run(text_spans(TextSpansRequest(pdf_b64=pdf_b64, page=0))).spans
    hit = [s for s in spans if s.text.strip() == text]
    assert hit, f"fixture has no span {text!r}: {[s.text for s in spans]}"
    return hit[0]


def _edit(pdf_b64: str, old: str, new_text: str) -> str:
    t = _span(pdf_b64, old)
    res = asyncio.run(edit_text(EditTextRequest(
        pdf_b64=pdf_b64,
        edits=[TextEdit(page=0, bbox=t.bbox, origin=t.origin, new_text=new_text, size=t.size,
                        color=t.color, font=t.font, orig_text=t.text, orig_size=t.size)],
    )))
    assert res.success, f"edit-text failed: {res.error}"
    return res.data_b64


def _count(pdf_b64: str, clip: fitz.Rect, pred) -> int:
    doc = fitz.open(stream=base64.b64decode(pdf_b64), filetype="pdf")
    try:
        pix = doc[0].get_pixmap(dpi=150, clip=clip)
        return sum(1 for y in range(pix.height) for x in range(pix.width) if pred(pix.pixel(x, y)[:3]))
    finally:
        doc.close()


def _dark(rgb):
    return max(rgb) < 90


def _red(rgb):
    return rgb[0] > 200 and rgb[1] < 60 and rgb[2] < 60


# The tail of the old word: glyphs 4..6 sit at x = X0+19.5 .. X0+37. New text "TK" is
# ~14 pt wide, so nothing the edit draws can reach here — dark pixels here are OLD ink.
TAIL = fitz.Rect(X0 + 19, BASE - GLYPH_H - 1, X0 + 38, BASE - 0.3)


def test_fixture_is_what_we_think():
    src = _outlined_pdf(rule=False, red_mark=False, neighbour=False)
    assert _count(src, TAIL, _dark) > 0, "fixture has no outlined ink in the tail"
    d = fitz.open(stream=base64.b64decode(src), filetype="pdf")
    runs = d[0].get_texttrace()
    assert runs and all(t["type"] == 3 for t in runs), "fixture text must be invisible (Tr 3)"


def test_old_outlines_are_erased():
    """The bug itself: the new text must not be drawn over the old visible glyphs."""
    src = _outlined_pdf(rule=False, red_mark=False, neighbour=False)
    before = _count(src, TAIL, _dark)
    out = _edit(src, OLD, "TK")
    after = _count(out, TAIL, _dark)
    assert before > 0 and after == 0, f"old outlines left behind: {before} -> {after} dark px"
    assert "TK" in fitz.open(stream=base64.b64decode(out), filetype="pdf")[0].get_text()


def test_neighbouring_span_outlines_survive():
    src = _outlined_pdf(rule=False, red_mark=False)
    z = fitz.Rect(X0 + 118, BASE - GLYPH_H - 1, X0 + 128, BASE + 0.5)
    before = _count(src, z, _dark)
    out = _edit(src, OLD, "TK")
    assert before > 0
    assert _count(out, z, _dark) == before, "the OTHER span's outline was damaged"


def test_rule_in_the_box_survives():
    """A thin filled rule in the text colour is a rule, not a glyph."""
    src = _outlined_pdf(red_mark=False, neighbour=False)
    band = fitz.Rect(X0 + 26, BASE + 0.9, X0 + 40, BASE + 1.7)
    before = _count(src, band, _dark)
    out = _edit(src, OLD, "TK")
    assert before > 0, "fixture has no rule"
    assert _count(out, band, _dark) > 0, "the rule under the edited text was erased"


def test_other_colour_in_the_box_survives():
    src = _outlined_pdf(rule=False, neighbour=False)
    mark = fitz.Rect(X0 + 38, BASE - 2, X0 + 41, BASE)
    assert _count(src, mark, _red) > 0, "fixture has no red mark"
    out = _edit(src, OLD, "TK")
    # new text ("TK") ends near X0+14, so the red mark at X0+38 is not under it
    assert _count(out, mark, _red) > 0, "a non-text-colour shape was erased"


def test_real_text_page_is_untouched_by_the_new_step():
    """Gating: no invisible text -> the helper does nothing, not even a re-save."""
    src = _real_text_pdf()
    d = fitz.open(stream=base64.b64decode(src), filetype="pdf")
    page = d[0]
    # (tobytes() twice is not stable — trailer /ID — so compare what matters: the page's
    # content stream and its object list)
    before = (page.read_contents(), page.get_contents())
    t = _span(src, OLD)
    e = TextEdit(page=0, bbox=t.bbox, new_text="TK")
    assert api._erase_outlined_glyphs(fitz, page, [e]) == 0
    assert (page.read_contents(), page.get_contents()) == before, \
        "the helper modified a page of real text"
    # and the black shape inside a REAL-text span's box still survives a full edit
    shape = fitz.Rect(X0 + 40, BASE - 6, X0 + 44, BASE - 2)
    out = _edit(src, OLD, "TK")
    assert _count(out, shape, _dark) > 0, "a shape inside real text was erased"


if __name__ == "__main__":
    for fn in (
        test_fixture_is_what_we_think,
        test_old_outlines_are_erased,
        test_neighbouring_span_outlines_survive,
        test_rule_in_the_box_survives,
        test_other_colour_in_the_box_survives,
        test_real_text_page_is_untouched_by_the_new_step,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All outlined-text edit tests passed.")
