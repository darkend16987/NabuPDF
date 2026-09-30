"""Tests for MOVING a span with /edit-text (v0.2.73, "di chuyển chữ").

WHAT IS UNDER TEST. The renderer lets the user drag a span box in "Sửa nội dung" and
sends the drag as `offset: [dx, dy]` — in DISPLAYED page space, because that is the
space the overlay (`bbox_view`) and the mouse live in. The sidecar must:

  * still redact the ORIGINAL `bbox` — the old glyphs go from where they were;
  * redraw the text (and its background box and underline) at origin + offset;
  * turn the displayed-space offset into the UNROTATED space insert_text draws in.
    On a /Rotate 90 sheet "drag right" on screen is "move down" in the content
    stream; forgetting that moves the text the wrong way on every CAD page.
  * change NOTHING when there is no offset — /text-find's replace path and an older
    renderer send none.

The rotation cases have a GUARD: the naive answer (apply the offset unrotated) is
computed and must DIFFER from what the fix produced, or the grid would pass without
proving the conversion does anything.

Run:  .venv\\Scripts\\python test_edit_text_move.py
"""

import asyncio
import base64
import sys

import fitz  # PyMuPDF

from api import (
    EditTextRequest,
    TextEdit,
    TextSpansRequest,
    _view_offset_to_page,
    edit_text,
    text_spans,
)
from src.pdf.fonts import _vietnamese_font

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

PASS = 0
FAIL = 0


def want(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"FAIL {name}" + (f"\n  {detail}" if detail else ""))


def near(a, b, tol=0.6):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

TEXT = "Hang muc 12"
OTHER = "Giu nguyen"
SIZE = 11.0


def make_pdf(page_rot=0, text_rot=0) -> bytes:
    """One run to move, plus an untouched neighbour far away from every target."""
    doc = fitz.open()
    try:
        page = doc.new_page(width=842, height=595)
        page.insert_font(fontname="F0", fontfile=_vietnamese_font())
        page.insert_text((300, 300), TEXT, fontname="F0", fontsize=SIZE, rotate=text_rot)
        page.insert_text((80, 80), OTHER, fontname="F0", fontsize=SIZE)
        page.set_rotation(page_rot)
        return doc.tobytes(deflate=True, garbage=3)
    finally:
        doc.close()


def spans_of(pdf: bytes):
    res = asyncio.run(text_spans(TextSpansRequest(pdf_b64=base64.b64encode(pdf).decode(), page=0)))
    assert res.success, res.error
    return res.spans


def span(pdf: bytes, text: str):
    hits = [s for s in spans_of(pdf) if s.text.strip() == text]
    return hits[0] if hits else None


def apply_edit(pdf: bytes, sp, new_text=None, **over) -> bytes:
    """Exactly what text-edit.js sends for one span."""
    edit = dict(
        page=0,
        bbox=list(sp.bbox),
        origin=list(sp.origin),
        new_text=sp.text if new_text is None else new_text,
        size=sp.size,
        color="#000000",
        bg=None,
        bold=False,
        italic=False,
        underline=False,
        font="default",
        orig_text=sp.text,
        orig_size=sp.size,
        dir=list(sp.dir),
    )
    edit.update(over)
    res = asyncio.run(
        edit_text(EditTextRequest(pdf_b64=base64.b64encode(pdf).decode(), edits=[TextEdit(**edit)]))
    )
    assert res.success, res.error
    return base64.b64decode(res.data_b64)


def pixels(pdf: bytes) -> bytes:
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        return doc[0].get_pixmap(dpi=110).tobytes("png")
    finally:
        doc.close()


def shifted(box, v):
    return [box[0] + v[0], box[1] + v[1], box[2] + v[0], box[3] + v[1]]


# ---------------------------------------------------------------------------
# 1 · the pure helper
# ---------------------------------------------------------------------------

_doc = fitz.open()
_pg = _doc.new_page(width=842, height=595)
for bad in (None, [], [0, 0], [1.0], [1, 2, 3], ["x", 1], [float("nan"), 1], [float("inf"), 0]):
    want(f"H1 {bad!r} → no move", _view_offset_to_page(_pg, bad) == (0.0, 0.0), str(_view_offset_to_page(_pg, bad)))
want("H2 unrotated page: the offset passes through", near(_view_offset_to_page(_pg, [30, -12]), (30, -12), 1e-6))
for rot in (90, 180, 270):
    _pg.set_rotation(rot)
    got = _view_offset_to_page(_pg, [30, -12])
    # Ground truth from PyMuPDF's own matrices: a displayed point P and P + v, both
    # taken back to unrotated space — their difference is what the content must move.
    P = fitz.Point(200, 150)
    want_v = ((P + (30, -12)) * _pg.derotation_matrix) - (P * _pg.derotation_matrix)
    want(f"H3 /Rotate {rot}: vector = difference of two derotated points",
         near(got, (want_v.x, want_v.y), 1e-6), f"got {got}, want {tuple(want_v)}")
    want(f"H3b /Rotate {rot}: length is preserved", abs((got[0] ** 2 + got[1] ** 2) ** 0.5 - (30 ** 2 + 12 ** 2) ** 0.5) < 1e-6)
_doc.close()


# ---------------------------------------------------------------------------
# 2 · dead band: no offset = byte-for-byte the old behaviour
# ---------------------------------------------------------------------------

flat = make_pdf()
sp = span(flat, TEXT)
want("D0 fixture: the run is found", sp is not None)
base = pixels(apply_edit(flat, sp, "Hang muc 34"))
want("D1 offset None renders identically to no offset field", pixels(apply_edit(flat, sp, "Hang muc 34", offset=None)) == base)
want("D2 offset [0, 0] renders identically too", pixels(apply_edit(flat, sp, "Hang muc 34", offset=[0, 0])) == base)
want("D3 a wrong-length offset (passes pydantic) does not cost the edit", pixels(apply_edit(flat, sp, "Hang muc 34", offset=[5.0])) == base)


# ---------------------------------------------------------------------------
# 3 · a move on an ordinary page
# ---------------------------------------------------------------------------

V = [120.0, 60.0]
moved = apply_edit(flat, sp, offset=V)
after = span(moved, TEXT)
want("M1 the text still exists after the move", after is not None)
if after:
    want("M2 ...displaced by exactly the offset", near(after.bbox_view, shifted(sp.bbox_view, V)),
         f"got {after.bbox_view}, want {shifted(sp.bbox_view, V)}")
doc = fitz.open(stream=moved, filetype="pdf")
old_left = doc[0].get_text("text", clip=fitz.Rect(*sp.bbox)).strip()
doc.close()
want("M3 nothing is left where it was (the redaction stayed on the ORIGINAL box)", old_left == "", repr(old_left))
nb = span(moved, OTHER)
want("M4 the untouched neighbour is still there, unmoved",
     nb is not None and near(nb.bbox_view, span(flat, OTHER).bbox_view, 0.01))

# Move AND retype in one edit.
both = span(apply_edit(flat, sp, "Da sua", offset=V), "Da sua")
want("M5 retype + move: the NEW text lands at the new place",
     both is not None and abs(both.bbox_view[0] - (sp.bbox_view[0] + V[0])) < 0.6)

# Empty text + offset = delete, same as without a move.
gone = apply_edit(flat, sp, "", offset=V)
want("M6 empty text with an offset just deletes the span", span(gone, TEXT) is None and span(gone, "") is None)


# ---------------------------------------------------------------------------
# 4 · the background box and the underline travel with the text
# ---------------------------------------------------------------------------

def drawings(pdf):
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        return doc[0].get_drawings()
    finally:
        doc.close()


bgd = [d for d in drawings(apply_edit(flat, sp, bg="#ffff00", offset=V)) if d.get("fill")]
want("B1 a background box is drawn", len(bgd) == 1, f"{len(bgd)} filled paths")
if bgd:
    r = bgd[0]["rect"]
    want("B2 ...at the MOVED box, not the old one", near((r.x0, r.y0, r.x1, r.y1), shifted(sp.bbox, V)),
         f"got {tuple(r)}, want {shifted(sp.bbox, V)}")

ul = [d for d in drawings(apply_edit(flat, sp, underline=True, offset=V)) if not d.get("fill")]
want("U1 an underline is drawn", len(ul) == 1, f"{len(ul)} stroked paths")
if ul:
    r = ul[0]["rect"]
    ox, oy = sp.origin[0] + V[0], sp.origin[1] + V[1]
    want("U2 ...starting at the MOVED baseline", abs(r.x0 - ox) < 1.0 and 0 < r.y0 - oy < SIZE * 0.3,
         f"rule at {tuple(r)}, moved origin ({ox}, {oy})")


# ---------------------------------------------------------------------------
# 5 · rotated sheets: the drag direction on screen is the direction it moves
# ---------------------------------------------------------------------------

for page_rot, text_rot in ((90, 90), (180, 180), (270, 270), (90, 0)):
    pdf = make_pdf(page_rot, text_rot)
    s0 = span(pdf, TEXT)
    want(f"R0 /Rotate {page_rot} text {text_rot}: fixture run found", s0 is not None)
    if not s0:
        continue
    out = apply_edit(pdf, s0, offset=V)
    s1 = span(out, TEXT)
    want(f"R1 /Rotate {page_rot} text {text_rot}: text survives", s1 is not None)
    if not s1:
        continue
    want(f"R2 /Rotate {page_rot} text {text_rot}: ON SCREEN it moved by the drag",
         near(s1.bbox_view, shifted(s0.bbox_view, V)),
         f"got {s1.bbox_view}, want {shifted(s0.bbox_view, V)}")
    # GUARD: moving by V in UNROTATED space (the bug this conversion prevents) lands
    # somewhere else on screen. If it did not, R2 would prove nothing.
    naive = span(apply_edit(pdf, s0, offset=None, origin=[s0.origin[0] + V[0], s0.origin[1] + V[1]]), TEXT)
    want(f"R3 /Rotate {page_rot} guard: the naive unrotated move lands elsewhere",
         naive is not None and not near(naive.bbox_view, shifted(s0.bbox_view, V), 5.0),
         f"naive {naive and naive.bbox_view}")
    # The written direction is untouched by a move (BI-66 still holds).
    want(f"R4 /Rotate {page_rot} text {text_rot}: direction unchanged", near(s1.dir, s0.dir, 1e-3), f"{s1.dir} vs {s0.dir}")


print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
