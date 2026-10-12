"""Tests for Căn lề + Gạch ngang in /edit-text (P8, BI-114).

WHAT IS UNDER TEST.
  * `align` ("left" | "center" | "right"): each line of the redraw is placed inside the
    extent the ORIGINAL run had ALONG the text — a retyped right-aligned amount keeps its
    right edge, a centred cell keeps its centre. Along the run's own direction, so a
    vertical label on a CAD sheet aligns along its length (BI-66).
  * `strike`: a rule through the lowercase body of every line, like the underline.
  * the dead band: no field / "left" / junk must render EXACTLY what /edit-text drew before
    (the single insert_text call) — /text-find's replace path and an older renderer send
    neither field.
  * aligning draws the lines ONE BY ONE; `_insert_line_pitch` must put line 2 where the
    single multi-line call put it, or an aligned paragraph's lines drift apart.

Each alignment case has a GUARD: the left-aligned result must DIFFER from it, or the grid
would pass without the shift doing anything.

Run:  .venv\\Scripts\\python test_edit_text_align.py
"""

import asyncio
import base64
import sys

import fitz  # PyMuPDF

from api import (
    EditTextRequest,
    TextEdit,
    TextSpansRequest,
    _STRIKE_RISE_EM,
    _insert_line_pitch,
    _norm_align,
    _pitch_from_metrics,
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


TEXT = "Hang muc 12"
SIZE = 11.0
TOL = 0.6


def make_pdf(text_rot=0, font="dejavu") -> bytes:
    doc = fitz.open()
    try:
        page = doc.new_page(width=842, height=595)
        if font == "dejavu":
            page.insert_font(fontname="F0", fontfile=_vietnamese_font())
            fn = "F0"
        else:
            fn = "helv"
        page.insert_text((300, 300), TEXT, fontname=fn, fontsize=SIZE, rotate=text_rot)
        page.insert_text((80, 80), "Giu nguyen", fontname=fn, fontsize=SIZE)
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


def apply_edit(pdf: bytes, sp, new_text, font="default", **over) -> bytes:
    """What text-edit.js sends for one span (+ the P8 fields under test)."""
    edit = dict(page=0, bbox=list(sp.bbox), origin=list(sp.origin), new_text=new_text,
                size=sp.size, color="#000000", bg=None, bold=False, italic=False,
                underline=False, font=font, orig_text=sp.text, orig_size=sp.size,
                dir=list(sp.dir))
    edit.update(over)
    res = asyncio.run(edit_text(EditTextRequest(pdf_b64=base64.b64encode(pdf).decode(),
                                                edits=[TextEdit(**edit)])))
    assert res.success, res.error
    return base64.b64decode(res.data_b64)


def pixels(pdf: bytes) -> bytes:
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        return doc[0].get_pixmap(dpi=110).tobytes("png")
    finally:
        doc.close()


def lines_of(pdf: bytes):
    """Every straight stroke on page 1 as (x0, y0, x1, y1)."""
    doc = fitz.open(stream=pdf, filetype="pdf")
    try:
        out = []
        for d in doc[0].get_drawings():
            for it in d["items"]:
                if it[0] == "l":
                    out.append((it[1].x, it[1].y, it[2].x, it[2].y))
        return out
    finally:
        doc.close()


def along(box, u):
    """[start, end] of an axis-aligned box projected on the unit direction u."""
    xs = (box[0], box[2])
    ys = (box[1], box[3])
    ps = [x * u[0] + y * u[1] for x in xs for y in ys]
    return min(ps), max(ps)


# ---------------------------------------------------------------------------
# 1 · the pure helpers
# ---------------------------------------------------------------------------

for v, exp in (("left", "left"), ("center", "center"), ("right", "right"), (None, "left"),
               ("", "left"), ("CENTER", "left"), ("justify", "left"), (3, "left")):
    want(f"H1 _norm_align({v!r}) → {exp}", _norm_align(v) == exp, _norm_align(v))
want("H2 pitch = size × (asc − desc) when that sum is > 1", abs(_pitch_from_metrics(0.928, -0.236, 10) - 11.64) < 1e-9)
want("H3 pitch = size × 1.2 when asc − desc ≤ 1 (PyMuPDF's own rule)", abs(_pitch_from_metrics(0.8, -0.15, 10) - 12) < 1e-9)
want("H3b …the boundary 1.0 itself is the 1.2 case", abs(_pitch_from_metrics(0.8, -0.2, 10) - 12) < 1e-9)
_d = fitz.open()
_p = _d.new_page()
_p.insert_font(fontname="F0", fontfile=_vietnamese_font())
want("H4 _insert_line_pitch reads the document's font info (DejaVu: 1.164 em)",
     abs(_insert_line_pitch(_p, "F0", 10) - 10 * (0.92822265625 + 0.23583984375)) < 1e-6, _insert_line_pitch(_p, "F0", 10))
_d.close()

# ---------------------------------------------------------------------------
# 2 · dead band: the old output, exactly
# ---------------------------------------------------------------------------

flat = make_pdf()
sp = span(flat, TEXT)
want("D0 fixture: the run is found", sp is not None)
base = pixels(apply_edit(flat, sp, "Hang muc 34"))
for v in (None, "left", "junk"):
    want(f"D1 align={v!r} renders identically to no align", pixels(apply_edit(flat, sp, "Hang muc 34", align=v)) == base)
want("D2 strike=False renders identically", pixels(apply_edit(flat, sp, "Hang muc 34", strike=False)) == base)
want("D3 …and adds no stroke", lines_of(apply_edit(flat, sp, "Hang muc 34")) == [])

# ---------------------------------------------------------------------------
# 3 · horizontal run: right / center / left
# ---------------------------------------------------------------------------

U = (1.0, 0.0)
o0, o1 = along(sp.bbox, U)
for new in ("Hang muc 12345678", "12"):
    left = span(apply_edit(flat, sp, new), new)
    right = span(apply_edit(flat, sp, new, align="right"), new)
    cen = span(apply_edit(flat, sp, new, align="center"), new)
    want(f"R1 '{new}' right: ends where the original ended", right and abs(along(right.bbox, U)[1] - o1) <= TOL,
         f"{right and along(right.bbox, U)} vs {o1}")
    want(f"R1g '{new}' guard: left-aligned does NOT end there", left and abs(along(left.bbox, U)[1] - o1) > 2)
    want(f"R2 '{new}' left: starts where the original started", left and abs(along(left.bbox, U)[0] - o0) <= TOL)
    c = cen and sum(along(cen.bbox, U)) / 2
    want(f"R3 '{new}' center: keeps the original centre", cen and abs(c - (o0 + o1) / 2) <= TOL, f"{c} vs {(o0 + o1) / 2}")
    want(f"R4 '{new}' every alignment keeps the baseline",
         all(s and abs(s.origin[1] - sp.origin[1]) <= 0.2 for s in (left, right, cen)))

# ---------------------------------------------------------------------------
# 4 · multi-line: per-line drawing lands where the single call did
# ---------------------------------------------------------------------------

for font_kind, font_req in (("dejavu", "default"), ("helv", "helv")):
    pdf = make_pdf(font=font_kind)
    s0 = span(pdf, TEXT)
    two = "Dong mot\nHai"
    single = apply_edit(pdf, s0, two, font=font_req)
    per_line = apply_edit(pdf, s0, two, font=font_req, align="right")
    a = span(single, "Hai")
    b = span(per_line, "Hai")
    want(f"M1 {font_kind}: line 2's baseline is where the single call put it",
         a and b and abs(a.origin[1] - b.origin[1]) <= 0.2, f"{a and a.origin} vs {b and b.origin}")
    b1 = span(per_line, "Dong mot")
    oo1 = along(s0.bbox, U)[1]
    want(f"M2 {font_kind}: EACH line is right-aligned on its own",
         b and b1 and abs(along(b.bbox, U)[1] - oo1) <= TOL and abs(along(b1.bbox, U)[1] - oo1) <= TOL,
         f"{b and along(b.bbox, U)} {b1 and along(b1.bbox, U)} vs {oo1}")

# ---------------------------------------------------------------------------
# 5 · a vertical run (CAD label): aligns ALONG its own direction (BI-66)
# ---------------------------------------------------------------------------

vert = make_pdf(text_rot=90)
sv = span(vert, TEXT)
want("V0 fixture: the vertical run is found, running up", sv is not None and abs(sv.dir[1] + 1) < 1e-3, sv and sv.dir)
if sv:
    uv = tuple(sv.dir)
    v0, v1 = along(sv.bbox, uv)
    for new in ("Hang muc 12345678", "12"):
        r = span(apply_edit(vert, sv, new, align="right"), new)
        lft = span(apply_edit(vert, sv, new), new)
        want(f"V1 '{new}' right: ends where the original ended, along the text", r and abs(along(r.bbox, uv)[1] - v1) <= TOL,
             f"{r and along(r.bbox, uv)} vs {v1}")
        want(f"V1g '{new}' guard: left does not", lft and abs(along(lft.bbox, uv)[1] - v1) > 2)
        want(f"V2 '{new}' right: stays on the same line (across the text)",
             r and abs(r.bbox[0] - sv.bbox[0]) <= TOL and abs(r.bbox[2] - sv.bbox[2]) <= TOL, f"{r and r.bbox} vs {sv.bbox}")

# ---------------------------------------------------------------------------
# 6 · Gạch ngang
# ---------------------------------------------------------------------------

out = apply_edit(flat, sp, "Hang muc 34", strike=True)
ns = span(out, "Hang muc 34")
ls = lines_of(out)
want("S1 strike draws exactly one rule", len(ls) == 1, ls)
if ls and ns:
    x0, y0, x1, y1 = ls[0]
    want("S2 …horizontal, through the letters: rise × size above the baseline",
         abs(y0 - y1) < 1e-6 and abs(y0 - (sp.origin[1] - SIZE * _STRIKE_RISE_EM)) <= 0.2, ls[0])
    want("S3 …as long as the drawn text", abs(x0 - ns.bbox[0]) <= TOL and abs(x1 - ns.bbox[2]) <= TOL, f"{ls[0]} vs {ns.bbox}")
want("S4 strike renders differently from no strike (guard)", pixels(out) != base)

out = apply_edit(flat, sp, "12", strike=True, align="right")
ns = span(out, "12")
ls = lines_of(out)
want("S5 strike + right: the rule follows the shifted text", len(ls) == 1 and ns and abs(ls[0][0] - ns.bbox[0]) <= TOL
     and abs(ls[0][2] - ns.bbox[2]) <= TOL, f"{ls} vs {ns and ns.bbox}")

out = apply_edit(flat, sp, "Dong mot\nHai", strike=True)
want("S6 two lines → two rules, one per line", len(lines_of(out)) == 2, lines_of(out))

out = apply_edit(flat, sp, "12", underline=True, align="right")
ns = span(out, "12")
ls = lines_of(out)
want("U1 underline + right: the rule sits under the SHIFTED text, below the baseline",
     len(ls) == 1 and ns and abs(ls[0][0] - ns.bbox[0]) <= TOL and ls[0][1] > sp.origin[1], f"{ls} vs {ns and ns.bbox}")
want("U2 a plain underline is unchanged by P8 (left: the old single rule from the origin)",
     [round(v, 2) for v in lines_of(apply_edit(flat, sp, "Hang muc 34", underline=True))[0][:2]]
     == [round(sp.origin[0], 2), round(sp.origin[1] + SIZE * 0.12, 2)])

if sv:
    out = apply_edit(vert, sv, "Hang muc 34", strike=True)
    ls = lines_of(out)
    want("S7 vertical run: the rule turns with the text (vertical, beside the baseline)",
         len(ls) == 1 and abs(ls[0][0] - ls[0][2]) < 1e-6 and abs(ls[0][0] - (sv.origin[0] - SIZE * _STRIKE_RISE_EM)) <= 0.2,
         f"{ls} origin {sv.origin}")

print(f"\nedit-text align/strike: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
