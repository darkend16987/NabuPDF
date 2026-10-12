"use strict";

/*
 * Text layout engine for the overlay editor — lifted out of editor.js at v0.2.48.
 *
 * WHY THIS FILE EXISTS (docs/REGRESSION-GUARD.md §1): this is the one part of
 * editor.js that is both genuinely pure and genuinely dangerous. `layoutTextBox`
 * positions EVERY glyph and is the single shared source of truth for two paths that
 * must agree pixel-for-pixel:
 *   · `measureText`   → the on-screen box the user drags and types into;
 *   · `renderTextPng` → the PNG that actually gets baked into the PDF.
 * When they disagree the failure is SILENT — the box looks right on screen and the
 * saved PDF has text overflowing, re-wrapped, or on the wrong number of lines. That
 * is the §1 criterion for splitting a file ("does a mistake here stay quiet?"), not
 * the line count. Now it is require()-able from node → `npm run test:text`.
 *
 * EXPOSURE — deliberately the `wire.js` tier of §2, NOT the `page-range.js` tier:
 * these names had ~25 call sites in editor.js before the split. Declared at the top
 * level of a classic script they stay in exactly the same shared scope as before, so
 * NOT ONE call site had to change and the editor.js side of this commit is a pure
 * deletion. Switching to `AnnotText.*` would mean 25 hand-edits in the
 * highest-diff file in the repo to buy nothing — that is BI-14 courted for style.
 * `module.exports` is for node; `window.AnnotText` is the same set under a name a
 * probe or test can assert on.
 *
 * TRADE-OFF (same as wire.js): this file MUST be loaded BEFORE editor.js in
 * index.html. Renaming anything here without renaming the call site is a runtime
 * ReferenceError with no build-time warning — BI-14. The test grid is the net:
 * it looks each name up by hand, so a rename fails the grid loudly.
 *
 * Everything here is pure except `measureCtx`, which needs a throwaway canvas to
 * measure glyphs. It is behind a `typeof document` gate (the `pan.js` half-and-half
 * pattern) so node can load this file, and `measureText` takes an optional ctx so
 * the grid can drive it with a stub.
 */

// Built-in font-family keys → a CSS font-family stack. Any other value is taken
// as a literal system family name (from the /fonts picker) and quoted as-is.
const FONT_STACKS = {
  sans: 'system-ui, "Segoe UI", Arial, sans-serif',
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
};
// A falsy key means "no font chosen" and must resolve to the sans STACK. Until
// v0.2.49 it fell through to the literal-family arm and emitted `"sans", sans-serif`
// — a quoted family name nobody has — which the browser resolved to the generic
// sans-serif (Arial on Windows) instead of system-ui (Segoe UI). Text boxes never hit
// it (`normTextStyle` always supplies "sans"), but `textFont(fpx)` with NO opts did,
// and the arrow-label + watermark rasterisers are exactly that: those two rendered in
// Arial while every text box rendered in Segoe UI. Neither has a font picker (see
// TOOL_CTLS in editor.js), so nothing let a user notice or correct it. BI-40.
function fontFamily(key) {
  if (!key) return FONT_STACKS.sans;
  return FONT_STACKS[key] || `"${String(key).replace(/"/g, "")}", sans-serif`;
}
// CSS `font` shorthand from a size (px) and an optional style object
// ({ font, bold, italic }). Defaults match a plain sans-serif text box.
function textFont(fontSizePx, opts) {
  const o = opts || {};
  const style = o.italic ? "italic " : "";
  const weight = o.bold ? "700 " : "";
  return `${style}${weight}${fontSizePx}px ${fontFamily(o.font)}`;
}
// Normalise a text annotation (or a partial style object) into the full set of
// style fields the layout engine understands, filling in safe defaults. Old
// files / older annots that lack the new fields keep their original look.
function normTextStyle(a) {
  a = a || {};
  const num = (v, d) => (v == null || isNaN(+v) ? d : +v);
  const al = a.align;
  return {
    font: a.font || "sans",
    bold: !!a.bold,
    italic: !!a.italic,
    underline: !!a.underline,
    strike: !!a.strike,
    align: al === "center" || al === "right" || al === "justify" ? al : "left",
    lineHeight: Math.max(0.5, num(a.lineHeight, 1.3)), // multiplier of font size
    paraSpacing: Math.max(0, num(a.paraSpacing, 0)), // extra pt at blank-line breaks
    letterSpacing: num(a.letterSpacing, 0), // pt between characters
    wordSpacing: num(a.wordSpacing, 0), // pt added on spaces
    charScale: Math.max(0.2, num(a.charScale, 1)), // horizontal glyph scale (1 = 100%)
    indent: Math.max(0, num(a.indent, 0)), // left indent in pt
    listType: a.listType === "bullet" || a.listType === "number" ? a.listType : "none",
    opacity: Math.min(1, Math.max(0, num(a.opacity, 1))),
    // Anti-clockwise degrees, normalised into (-180, 180] — see normRot below.
    // A box written before rotation existed has no `rot` at all and reads 0, which
    // is the same picture it has always drawn.
    rot: normRot(a.rot),
    // Fixed-width box ("hộp cố định bề rộng"): the width, in pt, that the TEXT wraps
    // to; 0 = the original point-text box that breaks lines only at "\n" and grows to
    // its longest line. Every box written before this existed has no `boxW` and reads
    // 0 — the same picture it has always drawn. Here, in the normaliser, so that every
    // path that re-measures a box (`measureText(…, textStyle(a))` after a font change,
    // renderTextPng in the bake) carries it without being told: a width that only some
    // paths knew about is BI-40 by construction.
    boxW: Math.max(0, num(a.boxW, 0)),
  };
}
// Back-compat alias: the style bundle read off a text annotation is now the full
// normalised set (superset of the old {font,bold,italic}).
function textStyle(a) {
  return normTextStyle(a);
}

// Core text layout, shared by measureText (box sizing) and renderTextPng (baked
// PNG) so the on-screen box and the printed result always agree. Positions EVERY
// glyph so we can honour alignment, justify, letter/word spacing, horizontal
// char scale, indent and bullet/number lists — none of which plain fillText(str)
// can do. Works in an abstract unit: `fpx` is the font size in that unit and
// `upp` is units-per-point (so pt-based spacings scale correctly): raster passes
// fpx=sizePt*RS, upp=RS; measuring passes fpx=sizePt, upp=1.
//   ctx: a canvas-2d-like object (needs .font + measureText(str).width).
// Returns { width, height, ops:[{ch,x,y}], decos:[{x0,x1,y,kind}], style }.
function layoutTextBox(text, style, ctx, fpx, upp) {
  const s = normTextStyle(style);
  ctx.font = textFont(fpx, s);
  const meas = (str) => ctx.measureText(str).width;
  const sx = s.charScale;
  const ls = s.letterSpacing * upp;
  const ws = s.wordSpacing * upp;
  const indent = s.indent * upp;
  const para = s.paraSpacing * upp;
  const lh = fpx * s.lineHeight;
  const markerGap = fpx * 0.4;
  const isList = s.listType === "bullet" || s.listType === "number";

  const rawLines = String(text == null ? "" : text).split("\n");
  // Width of a line's text run, including char scale + letter/word spacing but
  // NOT the trailing letter-space (spacing sits *between* glyphs).
  const lineTextWidth = (str) => {
    let w = 0;
    for (const ch of str) {
      w += meas(ch) * sx + ls;
      if (ch === " ") w += ws;
    }
    if (str.length) w -= ls;
    return Math.max(0, w);
  };

  let num = 0;
  let items = rawLines.map((str) => {
    const blank = str.trim() === "";
    let marker = "";
    if (isList && !blank) {
      num++;
      marker = s.listType === "bullet" ? "•" : num + ".";
    }
    return { str, blank, marker };
  });
  const markerW = (m) => (m ? meas(m) * sx : 0);
  const maxMarkerW = items.reduce((mx, it) => Math.max(mx, markerW(it.marker)), 0);
  const textLeft = indent + (isList ? maxMarkerW + markerGap : 0);
  // Fixed-width box: break every "\n" line into the lines that fit. The breaks are
  // decided ONCE, in pt (see wrapItemsPt) — never at this call's scale — so the
  // on-screen box (fpx = size) and the baked raster (fpx = size·RS) cannot break a
  // line differently: canvas text at 3× is not exactly 3× as wide (hinting), and a
  // word right at the edge would land on different lines in the saved file. BI-40.
  const boxW = s.boxW > 0 ? s.boxW * upp : 0;
  if (boxW) {
    items = wrapItemsPt(items, s, ctx, fpx / upp, isList);
    ctx.font = textFont(fpx, s); // wrapItemsPt measured at the pt size; back to ours
  }
  const blockW = boxW
    ? Math.max(1, boxW - textLeft)
    : items.reduce((mx, it) => Math.max(mx, lineTextWidth(it.str)), 1);

  const ops = [];
  const decos = [];
  let y = 0;
  items.forEach((it, idx) => {
    if (!it.blank) {
      const lw = lineTextWidth(it.str);
      const lastOfPara = isLastOfPara(items, idx, !!boxW);
      let offset = 0;
      let justifyExtra = 0;
      if (s.align === "center") offset = (blockW - lw) / 2;
      else if (s.align === "right") offset = blockW - lw;
      else if (s.align === "justify" && !lastOfPara) {
        const spaces = (it.str.match(/ /g) || []).length;
        if (spaces > 0) justifyExtra = (blockW - lw) / spaces;
      }
      // Marker (bullet / number) sits at the indent; text follows it.
      if (it.marker) {
        let mx = indent;
        for (const ch of it.marker) {
          ops.push({ ch, x: mx, y });
          mx += meas(ch) * sx;
        }
      }
      let cx = textLeft + offset;
      const lineStartX = cx;
      for (const ch of it.str) {
        ops.push({ ch, x: cx, y });
        cx += meas(ch) * sx + ls;
        if (ch === " ") cx += ws + justifyExtra;
      }
      const lineEndX = it.str.length ? cx - ls : lineStartX;
      if (s.underline) decos.push({ x0: lineStartX, x1: lineEndX, y: y + fpx * 1.02, kind: "under" });
      if (s.strike) decos.push({ x0: lineStartX, x1: lineEndX, y: y + fpx * 0.62, kind: "strike" });
    }
    y += lh;
    if (it.blank) y += para;
  });

  // `lines` = what was laid out, one entry per drawn line (after wrapping, in a
  // fixed-width box) — read by wrappedDisplayText so the on-screen element shows the
  // very same breaks.
  return { width: Math.max(1, textLeft + blockW), height: Math.max(lh, y), ops, decos, style: s, lines: items };
}

// Which laid-out line is the last of its paragraph — the one line justify leaves
// ragged. A fixed-width box: the last wrapped piece of each "\n" line (Word's rule);
// a point box keeps the rule it always had (the last line, or one before a blank).
// ONE rule with two readers — the bake (layoutTextBox) and the on-screen element
// (justifiedDisplayLines) — so the screen cannot justify a line the file leaves ragged.
function isLastOfPara(items, idx, fixed) {
  return fixed ? !!items[idx].endsPara : idx === items.length - 1 || items[idx + 1].blank;
}

// ---- fixed-width boxes: where the lines break ------------------------------
//
// Greedy, like every text box the user has ever typed into: a line takes words while
// they fit; a break may fall after a space or after a hyphen (where browsers break
// too — the inline <textarea> previews with the browser's own wrapping, and the closer
// the two agree, the less the text moves when the editor closes); spaces at the end
// of a line hang and are not drawn; a single word wider than the line is cut between
// characters rather than overflowing the box.
function wrapLine(str, avail, widthOf) {
  const fits = (t) => widthOf(t.replace(/ +$/, "")) <= avail + 0.01;
  if (fits(str)) return [str.replace(/ +$/, "")];
  const out = [];
  let line = "";
  for (const tok of str.split(/(?<=[ \-])/)) {
    if (fits(line + tok)) {
      line += tok;
      continue;
    }
    if (line) {
      out.push(line.replace(/ +$/, ""));
      line = "";
    }
    if (fits(tok)) {
      line = tok;
      continue;
    }
    for (const ch of tok) {
      if (line && !fits(line + ch)) {
        out.push(line);
        line = "";
      }
      line += ch;
    }
  }
  out.push(line.replace(/ +$/, ""));
  return out;
}

// The wrapped lines of a fixed-width box, measured in PT whatever scale the caller
// lays out at (see layoutTextBox). Leaves ctx.font at the pt size — the caller resets
// it. Each wrapped line carries the list marker only on its paragraph's first line,
// and `endsPara` on its last (the justify rule).
function wrapItemsPt(items, s, ctx, sizePt, isList) {
  ctx.font = textFont(sizePt, s);
  const m = (str) => ctx.measureText(str).width;
  const sx = s.charScale;
  const widthOf = (str) => {
    let w = 0;
    for (const ch of str) {
      w += m(ch) * sx + s.letterSpacing;
      if (ch === " ") w += s.wordSpacing;
    }
    if (str.length) w -= s.letterSpacing;
    return Math.max(0, w);
  };
  const markerW = items.reduce((mx, it) => Math.max(mx, it.marker ? m(it.marker) * sx : 0), 0);
  const textLeft = s.indent + (isList ? markerW + sizePt * 0.4 : 0);
  // Never narrower than one wide glyph: an indent wider than the box must still make
  // progress, one character per line, instead of looping on nothing.
  const avail = Math.max(m("M") * sx, s.boxW - textLeft);
  const out = [];
  for (const it of items) {
    if (it.blank) {
      out.push({ str: it.str, blank: true, marker: "", endsPara: true });
      continue;
    }
    const parts = wrapLine(it.str, avail, widthOf);
    parts.forEach((p, k) =>
      out.push({ str: p, blank: false, marker: k === 0 ? it.marker : "", endsPara: k === parts.length - 1 })
    );
  }
  return out;
}

// The on-screen text of a fixed-width box: its wrapped lines joined by "\n", so the
// element (white-space: pre) shows EXACTLY the breaks the bake will draw. Markers as
// listDisplayText writes them; a wrapped continuation line of a list item is indented
// by spaces — an approximation, exactly as the list display already is (the raster is
// the exact one). A point box (boxW 0) gets listDisplayText unchanged.
function wrappedDisplayText(text, style, fontSizePt, ctx) {
  const s = normTextStyle(style);
  if (!(s.boxW > 0)) return listDisplayText(text, style);
  const lay = layoutTextBox(text, style, ctx || measureCtx(), fontSizePt, 1);
  const isList = s.listType !== "none";
  return lay.lines
    .map((it) => {
      if (it.blank || !isList) return it.str;
      return (it.marker ? it.marker + " " : "   ") + it.str;
    })
    .join("\n");
}

// The on-screen lines of a JUSTIFIED box, one entry per drawn line, for renderAnnot to
// build one element each. Why not one string like wrappedDisplayText: the overlay is
// `white-space: pre` with the breaks already made, and CSS treats every line before a
// hard break as a paragraph's last line — so `text-align: justify` justified NOTHING
// on screen while the bake justified (measured in Electron's Chromium: line 1 of a
// 400px box ended at 129px with `left` and with `justify` alike). Per line, the
// element can say "justify me" (text-align-last) or not, by the bake's own rule.
//   marker  — the list marker text, as listDisplayText / wrappedDisplayText write it
//             ("• ", "1. ", or three spaces on a wrapped continuation line);
//   str     — the line's text, exactly the run layoutTextBox lays out;
//   justify — the bake stretches this line: not blank, not last of its paragraph, and
//             it has a space to stretch (layoutTextBox spreads the extra over spaces).
// `width` (pt) is where a stretched line ends, measured from the indent (the element's
// padding-left): the bake runs it to textLeft + blockW = the layout's width.
function justifiedDisplayLines(text, style, fontSizePt, ctx) {
  const s = normTextStyle(style);
  const lay = layoutTextBox(text, style, ctx || measureCtx(), fontSizePt, 1);
  const isList = s.listType !== "none";
  const fixed = s.boxW > 0;
  const lines = lay.lines.map((it, idx) => ({
    marker: isList && !it.blank ? (it.marker ? it.marker + " " : "   ") : "",
    str: it.str,
    justify: !it.blank && !isLastOfPara(lay.lines, idx, fixed) && it.str.indexOf(" ") >= 0,
  }));
  return { width: Math.max(0, lay.width - s.indent), lines };
}

// One throwaway 2d context, reused for every measurement (creating a canvas per
// keystroke was measurable). node has no `document`: rather than crash somewhere
// deep in layout, say so — callers there are expected to pass their own ctx.
let _measureCtx;
function measureCtx() {
  if (!_measureCtx) {
    if (typeof document === "undefined") {
      throw new Error("measureCtx: no DOM in this environment — pass a ctx explicitly");
    }
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  return _measureCtx;
}

// `ctx` is an optional override (the test grid passes a stub); the browser leaves it
// out and gets the shared measuring canvas. Callers in editor.js pass 3 args, as before.
function measureText(text, fontSizePt, opts, ctx) {
  const lay = layoutTextBox(text, opts, ctx || measureCtx(), fontSizePt, 1);
  const pad = fontSizePt * 0.15;
  return { w: Math.ceil(lay.width + pad * 2), h: Math.ceil(lay.height + pad * 2) };
}

// Text with bullet/number markers prefixed per non-empty line — DISPLAY ONLY
// (the stored `text` stays clean so editing never touches the markers).
function listDisplayText(text, style) {
  const s = normTextStyle(style);
  const str = text == null ? "" : String(text);
  if (s.listType === "none") return str;
  let n = 0;
  return str
    .split("\n")
    .map((ln) => {
      if (ln.trim() === "") return ln;
      n++;
      return (s.listType === "bullet" ? "• " : n + ". ") + ln;
    })
    .join("\n");
}

// ---- the text default: "Đặt làm mặc định" / "Xoá định dạng" -----------------
//
// WHAT a text default carries: every field the user sets with the font bar or the
// Format panel, plus the size. Deliberately NOT colour (Cài đặt → Màu mặc định owns it,
// shared by every kind), background, rotation or wrap width — those belong to one box's
// placement on one page, not to a "kiểu chữ". `opacity` is the annot's key; the palette
// keeps it as `ed.textOpacity` (edTextStyle maps it).
const TEXT_DEFAULT_KEYS = [
  "font", "fontSize", "bold", "italic", "underline", "strike", "align", "lineHeight",
  "paraSpacing", "letterSpacing", "wordSpacing", "charScale", "indent", "listType", "opacity",
];
// #ed-fontsize's min / max / initial value. The factory size has to equal `ed.fontSize`
// in editor.js and the markup's value="16" (test:fmtpanel pins all three).
const TEXT_SIZE_MIN = 6;
const TEXT_SIZE_MAX = 120;
const TEXT_SIZE_DEFAULT = 16;

// The default style read off anything annot-shaped (a box, the palette bundle, or a
// parsed localStorage value a human may have edited). Every field goes through
// normTextStyle — the same normaliser the layout engine reads — so a stored default can
// never hold a value a box could not; `{}` gives the factory style.
function pickTextDefault(src) {
  const a = src || {};
  const s = normTextStyle(a);
  const out = {};
  for (const k of TEXT_DEFAULT_KEYS) out[k] = s[k];
  const fs = +a.fontSize;
  out.fontSize = isFinite(fs) && fs > 0 ? Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, fs)) : TEXT_SIZE_DEFAULT;
  // A font is a family NAME: anything else (a number, an object, a novel) is junk.
  if (typeof out.font !== "string" || !out.font.trim() || out.font.length > 200) out.font = "sans";
  return out;
}
// localStorage → a default, or null for "none saved / unreadable" (never throws).
function parseTextDefault(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? pickTextDefault(o) : null;
  } catch (_) {
    return null;
  }
}

// ---- the text raster's own rectangle ----------------------------------------
//
// renderTextPng rasterises a box at TEXT_RS× and pads it by ceil(0.15em) on every side;
// the bake then places that PNG at (a.x − 0.15·size, a.y − 0.15·size). So the rectangle
// the saved file paints is cw × chh RASTER pixels — NOT a.w × a.h, which measureText
// ceil()s in whole points from a 1× layout. The two differ by up to ~1pt. A background
// wash never showed it; a BORDER does (its right/bottom edge would sit up to 1pt off on
// screen). So the overlay asks for the raster's rectangle from the same arithmetic the
// raster uses: one function, two readers (BI-40).
const TEXT_RS = 3;
function textRasterGeom(layWidth, layHeight, fpx) {
  const pad = Math.ceil(fpx * 0.15);
  return { pad, cw: Math.ceil(layWidth) + pad * 2, chh: Math.ceil(layHeight) + pad * 2 };
}
// The same rectangle in pt, for the overlay: one layout at the bake's own scale (canvas
// text at 3× is not exactly 3× as wide — see wrapItemsPt), then the raster's ceil()s.
function textRasterBoxPt(text, style, fontSizePt, ctx) {
  const fpx = fontSizePt * TEXT_RS;
  const lay = layoutTextBox(text, style, ctx || measureCtx(), fpx, TEXT_RS);
  const g = textRasterGeom(lay.width, lay.height, fpx);
  return { w: g.cw / TEXT_RS, h: g.chh / TEXT_RS };
}

// Where a TURNED text box turns, as an offset (pt) from its top-left (a.x, a.y): the
// centre of its raster. renderTextPng turns the canvas about the canvas's own centre and
// the bake puts that canvas down at (a.x − 0.15·size, a.y − 0.15·size) — so the pivot the
// SAVED FILE uses is (rasterW/2 − pad, rasterH/2 − pad). The overlay used to turn about the
// element's centre (a.w/2, a.h/2) instead, which sits `pad` right and down of it (BI-71
// measured the two centres: a.x + 46.50 vs a.x + 44.27 at 16pt). Turning one picture about
// two different points adds a translation of 2·pad·√2·sin(θ/2): 90° ≈ 4.4pt measured at
// 16pt, growing with the font size — the box on screen was not where the file put it.
// One pivot, read by the element AND by the inline editor that retypes it (BI-110).
const TEXT_PLACE_PAD_EM = 0.15; // the bake's padPt = a.fontSize * 0.15 (drawOneAnnot / addManagedAnnot)
function textRotationPivot(text, style, fontSizePt, ctx) {
  const rb = textRasterBoxPt(text, style, fontSizePt, ctx);
  const pad = fontSizePt * TEXT_PLACE_PAD_EM;
  return { x: rb.w / 2 - pad, y: rb.h / 2 - pad };
}

// ---- viền khung (border) of a text box ---------------------------------------
//
// `borderColor` present (a #rrggbb) ⇔ the box has a border; `borderWidth` (pt) and
// `borderDash` ("dash" | "dot"; absent = solid) only mean something with it. ABSENCE is
// "no border", which is what every box written before this existed has — so its
// /NabuData and its raster stay byte-identical (BI-59). Not in normTextStyle on purpose:
// a border is drawn AROUND the layout and must never reach layoutTextBox (same reason
// fill/fillOpacity are kept out of it). null = no border.
const TEXT_BORDER_MIN = 0.25;
const TEXT_BORDER_MAX = 12;
function normTextBorder(a) {
  const c = a && a.borderColor;
  if (typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c)) return null;
  const w = +a.borderWidth;
  return {
    color: c,
    width: isFinite(w) && w > 0 ? Math.min(TEXT_BORDER_MAX, Math.max(TEXT_BORDER_MIN, w)) : 1,
    dash: a.borderDash === "dash" || a.borderDash === "dot" ? a.borderDash : "solid",
  };
}

// ---- Sao chép / Dán định dạng (format painter) ---------------------------------
//
// The LOOK of a label: everything a text default carries, plus colour, background and
// border. Not rotation, wrap width, text or position — those say where a box sits and
// how wide it wraps, not what it looks like (pasting a 90° turn onto a row of labels
// would be a surprise, not a format).
function copyTextFormat(a) {
  const f = pickTextDefault(a);
  f.color = typeof a.color === "string" && a.color ? a.color : "#000000";
  if (a.fill && a.fill !== "none") {
    f.fill = a.fill;
    f.fillOpacity = a.fillOpacity != null ? +a.fillOpacity : 1;
  }
  const bd = normTextBorder(a);
  if (bd) {
    f.borderColor = bd.color;
    f.borderWidth = bd.width;
    if (bd.dash !== "solid") f.borderDash = bd.dash;
  }
  return f;
}
// Write a copied format onto box `a` (mutates it). A key the format LACKS is removed from
// the box — no background on the source ⇒ none on the target — so "dán định dạng" means
// "look like that one", not "merge into this one". Keys are deleted, never set to a
// "none" value, so a target that ends up plain has exactly the shape of a box that never
// had them (BI-59). `opts.noBorder`: a partner's FreeText keeps the border its file gave
// it (BI-100 — writeFreeText draws that one itself).
function applyTextFormat(a, f, opts) {
  for (const k of TEXT_DEFAULT_KEYS) a[k] = f[k];
  a.color = f.color;
  if (f.fill) {
    a.fill = f.fill;
    a.fillOpacity = f.fillOpacity;
  } else {
    delete a.fill;
    delete a.fillOpacity;
  }
  if (!(opts && opts.noBorder)) {
    delete a.borderColor;
    delete a.borderWidth;
    delete a.borderDash;
    if (f.borderColor) {
      a.borderColor = f.borderColor;
      a.borderWidth = f.borderWidth;
      if (f.borderDash) a.borderDash = f.borderDash;
    }
  }
  return a;
}

// ---- rotating a text box (v0.2.63) ---------------------------------------
//
// SIGN CONVENTION, decided once here so nothing has to guess: a POSITIVE angle turns
// the text ANTI-CLOCKWISE on screen. That is the watermark's convention already
// (editor.js renders it as `rotate(${-wm.angle}deg)`, and CSS rotate is clockwise),
// and having the app's two rotatable pieces of text disagree about which way "45" goes
// would be its own bug report.
//
// Normalised into (-180, 180]: the control is a degree field, so a user who types 350
// means "10° the other way", and a stored 350 vs -10 would make two visually identical
// boxes compare unequal — which matters because /NabuData round-trips the number.
function normRot(v) {
  let d = +v;
  if (!isFinite(d)) return 0;
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360;
  // -0 is a real value in JS and it survives JSON.stringify as "0" but compares
  // unequal to 0 under Object.is. Fold it away so a payload can't carry it.
  return d === 0 ? 0 : d;
}

// The axis-aligned box that a w×h rectangle needs after turning by `deg`.
//
// WHY THE BAKE NEEDS THIS AND THE OVERLAY DOES NOT. On screen the browser turns the
// element and paints outside its box for free. In the PDF the text is a PNG placed by
// its rectangle, so the RASTER has to be big enough to hold the turned glyphs — a 90°
// text box needs a canvas as tall as the text was wide. Same arithmetic the watermark
// rasteriser has done since v0.1: |w·cos| + |h·sin| across, |w·sin| + |h·cos| down.
//
// At 0° this returns exactly (w, h) — no epsilon, no ceil — which is what keeps an
// unrotated text box byte-identical to what shipped before rotation existed.
function rotatedBox(w, h, deg) {
  const d = normRot(deg);
  if (!d) return { w: w, h: h };
  const r = (d * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: w * c + h * s, h: w * s + h * c };
}

// node (tests) takes the module export; the browser already has the bare names
// above in the shared script scope. window.AnnotText is the same set under a name a
// probe can assert on. Mirrors the tail of wire.js exactly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FONT_STACKS, fontFamily, textFont, normTextStyle, textStyle,
    layoutTextBox, measureCtx, measureText, listDisplayText, wrapLine, wrappedDisplayText,
    isLastOfPara, justifiedDisplayLines,
    normRot, rotatedBox,
    TEXT_DEFAULT_KEYS, TEXT_SIZE_MIN, TEXT_SIZE_MAX, TEXT_SIZE_DEFAULT, pickTextDefault, parseTextDefault,
    TEXT_RS, textRasterGeom, textRasterBoxPt, TEXT_BORDER_MIN, TEXT_BORDER_MAX, normTextBorder,
    copyTextFormat, applyTextFormat, TEXT_PLACE_PAD_EM, textRotationPivot,
  };
}
if (typeof window !== "undefined") {
  window.AnnotText = {
    FONT_STACKS, fontFamily, textFont, normTextStyle, textStyle,
    layoutTextBox, measureCtx, measureText, listDisplayText, wrapLine, wrappedDisplayText,
    isLastOfPara, justifiedDisplayLines,
    normRot, rotatedBox,
    TEXT_DEFAULT_KEYS, TEXT_SIZE_MIN, TEXT_SIZE_MAX, TEXT_SIZE_DEFAULT, pickTextDefault, parseTextDefault,
    TEXT_RS, textRasterGeom, textRasterBoxPt, TEXT_BORDER_MIN, TEXT_BORDER_MAX, normTextBorder,
    copyTextFormat, applyTextFormat, TEXT_PLACE_PAD_EM, textRotationPivot,
  };
}
