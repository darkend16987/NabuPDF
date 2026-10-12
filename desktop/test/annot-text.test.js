"use strict";

// Regression net for renderer/annot-text.js — the text layout engine the overlay
// editor uses (extracted from editor.js at v0.2.48; every body was verified
// byte-identical to v0.2.47's editor.js before the move, so this grid is testing the
// same arithmetic that has been shipping, not a rewrite of it).
//
// WHY THIS GRID EXISTS. `layoutTextBox` is the single shared source of truth for two
// paths that MUST agree: `measureText` sizes the on-screen box the user types into,
// and `renderTextPng` rasterises the PNG that gets baked into the PDF. When they
// drift the failure is silent — the box looks fine on screen and the saved file has
// text overflowing its frame, re-wrapped, or on a different number of lines. Nobody
// sees it until a customer opens the contract. That is the docs/REGRESSION-GUARD.md
// §1 criterion ("does a mistake here stay quiet?"), which line count is not.
//
// HOW. Real font metrics are not reproducible across machines, so every case drives
// layout through a STUB ctx with fixed widths. That is not a compromise: what is
// under test is the arithmetic *around* the measurements — alignment offsets,
// justify distribution, the between-glyphs spacing rule, list marker columns — and
// a stub makes each of those an exact integer instead of a float to eyeball.
//
// Run:  node desktop/test/annot-text.test.js      (or: npm run test:text)

const A = require("../renderer/annot-text.js");
const { normTextStyle, textStyle, fontFamily, textFont, layoutTextBox, measureText, listDisplayText } = A;

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}
function near(name, actual, expected, eps) {
  const tol = eps == null ? 1e-9 : eps;
  if (typeof actual === "number" && Math.abs(actual - expected) <= tol) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ≈${expected}\n  actual   ${actual}`);
  }
}

// ---- stub contexts -------------------------------------------------------

// Every glyph is 10 wide. Makes every offset an exact integer.
const flat = (w) => ({ font: "", measureText: (s) => ({ width: [...s].length * (w == null ? 10 : w) }) });
// Per-character widths, for the list-marker column and proportional cases.
const perChar = (map, dflt) => ({
  font: "",
  measureText: (s) => ({ width: [...s].reduce((t, c) => t + (map[c] == null ? (dflt == null ? 10 : dflt) : map[c]), 0) }),
});

const xs = (lay) => lay.ops.map((o) => o.x);
const chars = (lay) => lay.ops.map((o) => o.ch).join("");

// ==========================================================================
// 1. normTextStyle — defaults, whitelists, clamps
// ==========================================================================

const D = normTextStyle();
check("no argument → the full default bundle, never undefined fields", Object.keys(D).sort(), [
  // boxW (fixed-width box) joined the bundle ON PURPOSE: being in the normaliser is
  // what makes every re-measure path carry it (see normTextStyle). 0 = point box.
  "align", "bold", "boxW", "charScale", "font", "indent", "italic", "letterSpacing",
  "lineHeight", "listType", "opacity", "paraSpacing", "rot", "strike", "underline",
  "wordSpacing",
]);
check("default font/align/listType", [D.font, D.align, D.listType], ["sans", "left", "none"]);
check("default lineHeight is 1.3, spacings 0, charScale 1, opacity 1",
  [D.lineHeight, D.letterSpacing, D.wordSpacing, D.paraSpacing, D.indent, D.charScale, D.opacity],
  [1.3, 0, 0, 0, 0, 1, 1]);
check("null argument behaves like no argument", normTextStyle(null), D);
check("textStyle is the same normaliser (back-compat alias)", textStyle({ bold: 1 }), normTextStyle({ bold: 1 }));

check("booleans are coerced, not passed through",
  [normTextStyle({ bold: 1, italic: "", underline: "x", strike: 0 })].map((s) => [s.bold, s.italic, s.underline, s.strike])[0],
  [true, false, true, false]);

// Whitelists. An unknown value must fall back, not reach the renderer.
check("align whitelist", ["left", "center", "right", "justify", "middle", "", null, "LEFT"].map((v) => normTextStyle({ align: v }).align),
  ["left", "center", "right", "justify", "left", "left", "left", "left"]);
check("listType whitelist", ["bullet", "number", "none", "circle", null].map((v) => normTextStyle({ listType: v }).listType),
  ["bullet", "number", "none", "none", "none"]);

// Clamps. These are the values a user can type into the Format panel; an unclamped
// one reaches the PNG rasteriser and produces a zero/negative-size canvas.
check("lineHeight clamps at 0.5 (0 line height = every line on top of the last)",
  [0, 0.1, 0.5, 0.49, 3].map((v) => normTextStyle({ lineHeight: v }).lineHeight), [0.5, 0.5, 0.5, 0.5, 3]);
check("charScale clamps at 0.2", [0, -5, 0.2, 0.19, 4].map((v) => normTextStyle({ charScale: v }).charScale),
  [0.2, 0.2, 0.2, 0.2, 4]);
check("paraSpacing / indent floor at 0", [normTextStyle({ paraSpacing: -9 }).paraSpacing, normTextStyle({ indent: -9 }).indent], [0, 0]);
check("opacity clamps into [0,1]", [-1, 0, 0.5, 1, 7].map((v) => normTextStyle({ opacity: v }).opacity), [0, 0, 0.5, 1, 1]);
check("letter/word spacing may be NEGATIVE (tightening is legitimate)",
  [normTextStyle({ letterSpacing: -2 }).letterSpacing, normTextStyle({ wordSpacing: -2 }).wordSpacing], [-2, -2]);
check("NaN / garbage numerics fall back to the default, not NaN",
  ["x", NaN, undefined, {}].map((v) => normTextStyle({ lineHeight: v }).lineHeight), [1.3, 1.3, 1.3, 1.3]);
check("numeric strings are accepted (they arrive from <input> as strings)",
  [normTextStyle({ lineHeight: "2" }).lineHeight, normTextStyle({ indent: "12" }).indent], [2, 12]);

// ==========================================================================
// 2. fontFamily / textFont
// ==========================================================================

check("built-in keys map to a stack", [fontFamily("sans"), fontFamily("serif"), fontFamily("mono")],
  [A.FONT_STACKS.sans, A.FONT_STACKS.serif, A.FONT_STACKS.mono]);
check("unknown key is treated as a literal system family, quoted", fontFamily("Arial Narrow"), '"Arial Narrow", sans-serif');
// FIXED AT v0.2.49, and this is the case that was updated on purpose (the previous
// revision of this grid PINNED the old behaviour and said so). Before: `FONT_STACKS[""]`
// missed, the fallback arm ran, and it emitted a QUOTED LITERAL family called "sans" —
// a font nobody has — which the browser resolved to the generic `sans-serif` (Arial on
// Windows) instead of `FONT_STACKS.sans` (system-ui → Segoe UI). Text boxes never hit it
// (`normTextStyle` always supplies "sans"), but `textFont(fpx)` with NO opts did, and the
// arrow-label + watermark rasterisers are exactly that — so those two rendered in Arial
// while every text box rendered in Segoe UI, with no font picker on either to reveal it.
// A falsy key now means "no font chosen" → the sans stack. BI-40.
check("a falsy key resolves to the sans STACK, not a literal family named 'sans'",
  [fontFamily(""), fontFamily(null), fontFamily(undefined), fontFamily(0)],
  [A.FONT_STACKS.sans, A.FONT_STACKS.sans, A.FONT_STACKS.sans, A.FONT_STACKS.sans]);
// Guard: the exact string the bug used to produce must never come back.
check("guard — the old literal-family output is gone",
  fontFamily("") === '"sans", sans-serif', false);
check("the explicit key 'sans' gives the same thing (no-choice == choosing sans)",
  fontFamily("sans"), fontFamily(""));
// Guard: the family name comes from the system /fonts picker and goes into a CSS
// `font` shorthand. An embedded quote would break out of the string.
check("embedded quotes are stripped, not escaped through", fontFamily('Ev"il'), '"Evil", sans-serif');

check("textFont builds the CSS shorthand in order style-weight-size-family",
  textFont(12, { bold: true, italic: true, font: "mono" }), `italic 700 12px ${A.FONT_STACKS.mono}`);
// No opts → no style, no weight, and the sans stack. This is the shape the arrow-label
// and watermark rasterisers use (`textFont(fs)` / `textFont(fpx)`), so these three cases
// are what makes them agree with text boxes rather than falling back to Arial.
check("plain textFont omits style and weight and uses the sans stack",
  textFont(9), `9px ${A.FONT_STACKS.sans}`);
check("bold alone / italic alone", [textFont(10, { bold: true }), textFont(10, { italic: true })],
  [`700 10px ${A.FONT_STACKS.sans}`, `italic 10px ${A.FONT_STACKS.sans}`]);
check("an explicit font key gives the stack even with no other style",
  textFont(9, { font: "sans" }), `9px ${A.FONT_STACKS.sans}`);
// The whole point of the fix, stated as one case: the no-opts call the arrow-label and
// watermark rasterisers make must produce EXACTLY what a default text box produces.
check("arrow-label / watermark now match a default text box",
  textFont(14), textFont(14, normTextStyle({})));

// ==========================================================================
// 3. layoutTextBox — the core
// ==========================================================================

// It sets ctx.font before measuring. If it stopped doing that, every measurement
// would use whatever font the previous caller left behind.
{
  const ctx = flat();
  layoutTextBox("ab", { font: "mono", bold: true }, ctx, 20, 1);
  check("ctx.font is set from the style before measuring", ctx.font, `700 20px ${A.FONT_STACKS.mono}`);
}

// One op PER CHARACTER — the whole reason this engine exists instead of fillText().
{
  const lay = layoutTextBox("abc", {}, flat(), 10, 1);
  check("one op per character, in order", chars(lay), "abc");
  check("glyphs advance by the measured width", xs(lay), [0, 10, 20]);
  check("all on one line", lay.ops.map((o) => o.y), [0, 0, 0]);
  near("height is one lineHeight", lay.height, 13); // 10 * 1.3
  near("width covers the run", lay.width, 30);
}

// Newlines are hard breaks; there is NO word wrapping in this engine (the box is
// sized to the text, not the reverse). Pinning it so nobody "fixes" it silently.
{
  const lay = layoutTextBox("ab\ncdef", {}, flat(), 10, 1);
  check("second line starts at y = lineHeight", lay.ops.map((o) => o.y), [0, 0, 13, 13, 13, 13]);
  near("width is the WIDEST line, not the total", lay.width, 40);
  near("height is 2 lines", lay.height, 26);
}
{
  const lay = layoutTextBox("a very long single line with many spaces", {}, flat(), 10, 1);
  check("no auto-wrap: still exactly one line", new Set(lay.ops.map((o) => o.y)).size, 1);
}

// Empty / null input must still produce a usable box (a 0×0 canvas throws in the
// rasteriser, and an empty text box is a normal thing for a user to create).
for (const [label, v] of [["empty string", ""], ["null", null], ["undefined", undefined]]) {
  const lay = layoutTextBox(v, {}, flat(), 10, 1);
  check(`${label} → no ops but a non-zero box`, [lay.ops.length, lay.width >= 1, lay.height >= 13], [0, true, true]);
}
check("width floors at 1 even with nothing to draw", layoutTextBox("", {}, flat(), 10, 1).width, 1);

// --- the between-glyphs spacing rule -------------------------------------
// letterSpacing sits BETWEEN glyphs, so an n-char line gets (n-1) gaps. Counting n
// gaps silently widens every box by one letter-space — invisible at 0 (the default)
// and wrong for everyone who touches the spacing control.
{
  const lay = layoutTextBox("abc", { letterSpacing: 5 }, flat(), 10, 1);
  check("letterSpacing advances each glyph", xs(lay), [0, 15, 30]);
  near("width counts 2 gaps for 3 glyphs, not 3", lay.width, 40); // 3*10 + 2*5
}
check("a single glyph gets NO letter-space at all", layoutTextBox("a", { letterSpacing: 5 }, flat(), 10, 1).width, 10);
{
  // `upp` scales pt-based spacings into the working unit: the raster pass uses
  // upp=RS so a 5pt letter-space must become 5*RS. Getting this wrong makes the
  // baked PNG disagree with the on-screen box by exactly the spacing.
  const lay = layoutTextBox("abc", { letterSpacing: 5 }, flat(), 10, 3);
  check("letterSpacing is multiplied by upp", xs(lay), [0, 25, 50]); // 10 + 5*3
}
{
  const lay = layoutTextBox("a b", { wordSpacing: 7 }, flat(), 10, 1);
  check("wordSpacing is added AFTER a space glyph", xs(lay), [0, 10, 27]);
  near("and counted in the width", lay.width, 37);
}

// --- charScale ------------------------------------------------------------
{
  const lay = layoutTextBox("abc", { charScale: 2 }, flat(), 10, 1);
  check("charScale stretches the advance", xs(lay), [0, 20, 40]);
  near("and the width", lay.width, 60);
}
{
  // charScale scales glyphs; letterSpacing must NOT be scaled with them.
  const lay = layoutTextBox("ab", { charScale: 2, letterSpacing: 5 }, flat(), 10, 1);
  check("charScale scales the glyph advance, letterSpacing stays literal", xs(lay), [0, 25]);
}

// --- alignment ------------------------------------------------------------
// Offsets are relative to the widest line in the block (blockW), not to any frame.
{
  const st = (align) => layoutTextBox("ab\nabcd", { align }, flat(), 10, 1);
  check("left: both lines flush at 0", xs(st("left")), [0, 10, 0, 10, 20, 30]);
  check("center: the short line is offset by half the slack", xs(st("center")), [10, 20, 0, 10, 20, 30]);
  check("right: the short line is offset by all the slack", xs(st("right")), [20, 30, 0, 10, 20, 30]);
}
{
  // Justify stretches spaces to fill blockW — but NEVER on the last line of a
  // paragraph, or every paragraph ends in a stretched-out line.
  const lay = layoutTextBox("a b\nabcdefg", { align: "justify" }, flat(), 10, 1);
  check("justify: line 1 has its single space stretched to fill", xs(lay).slice(0, 3), [0, 10, 60]);
  check("justify: the LAST line of the paragraph is left alone",
    xs(lay).slice(3), [0, 10, 20, 30, 40, 50, 60]);
}
{
  // A blank line ends a paragraph, so the line before it is a "last line" too.
  const lay = layoutTextBox("a b\n\nabcdefg", { align: "justify" }, flat(), 10, 1);
  check("a blank line ends the paragraph → the line above it is not justified",
    xs(lay).slice(0, 3), [0, 10, 20]);
}
check("justify on a line with no spaces cannot divide by zero",
  xs(layoutTextBox("abc\nabcdefgh", { align: "justify" }, flat(), 10, 1)).slice(0, 3), [0, 10, 20]);

// --- blank lines and paraSpacing -----------------------------------------
{
  const lay = layoutTextBox("a\n\nb", { paraSpacing: 6 }, flat(), 10, 1);
  check("a blank line emits no ops", chars(lay), "ab");
  check("paraSpacing is added ON TOP of the blank line's own lineHeight",
    lay.ops.map((o) => o.y), [0, 32]); // 13 (line a) + 13 + 6 (blank) = 32
  near("and is included in the height", lay.height, 45); // 32 + 13
}
{
  const lay = layoutTextBox("a\n \nb", { paraSpacing: 6 }, flat(), 10, 1);
  check("a whitespace-only line counts as blank (trim, not ===)", lay.ops.map((o) => o.y), [0, 32]);
}
check("paraSpacing is scaled by upp too",
  layoutTextBox("a\n\nb", { paraSpacing: 6 }, flat(), 10, 2).ops.map((o) => o.y), [0, 38]); // 13+13+12

// --- indent ---------------------------------------------------------------
{
  const lay = layoutTextBox("ab", { indent: 4 }, flat(), 10, 1);
  check("indent shifts the text run", xs(lay), [4, 14]);
  near("and is included in the width", lay.width, 24);
}
check("indent is scaled by upp", xs(layoutTextBox("a", { indent: 4 }, flat(), 10, 3)), [12]);

// --- lists ---------------------------------------------------------------
{
  const lay = layoutTextBox("one\ntwo", { listType: "bullet" }, flat(), 10, 1);
  check("bullet markers are emitted as ops, one per line", chars(lay), "•one•two");
  check("the marker sits at the indent (0 here); text follows after the gap",
    xs(lay), [0, 14, 24, 34, 0, 14, 24, 34]); // markerW 10 + gap 10*0.4 = 14
}
{
  const lay = layoutTextBox("a\nb\nc", { listType: "number" }, flat(), 10, 1);
  check("numbered markers count up and include the dot", chars(lay), "1.a2.b3.c");
}
{
  const lay = layoutTextBox("a\n\nb", { listType: "number" }, flat(), 10, 1);
  check("blank lines do NOT consume a list number", chars(lay), "1.a2.b");
}
{
  // The text column is set by the WIDEST marker in the block, so "9." and "10."
  // still line their text up. Using each line's own marker width staircases them.
  const ctx = perChar({ "1": 6, "0": 6, ".": 3 }, 10);
  const lines = Array.from({ length: 10 }, (_, i) => "x").join("\n");
  const lay = layoutTextBox(lines, { listType: "number" }, ctx, 10, 1);
  const textXs = lay.ops.filter((o) => o.ch === "x").map((o) => o.x);
  check("every list line's text starts in the SAME column", new Set(textXs).size, 1);
  check("that column is the widest marker (10.) + gap", textXs[0], 6 + 6 + 3 + 4);
}
{
  const lay = layoutTextBox("ab", { listType: "bullet", indent: 5 }, flat(), 10, 1);
  check("indent and the marker column stack: marker at indent, text after it", xs(lay), [5, 19, 29]);
}
check("listType 'none' emits no markers", chars(layoutTextBox("a", { listType: "none" }, flat(), 10, 1)), "a");

// --- underline / strike decorations --------------------------------------
{
  const lay = layoutTextBox("abc", { underline: true }, flat(), 10, 1);
  check("one underline deco per non-blank line", lay.decos.length, 1);
  check("it spans the drawn run, excluding the trailing letter-space",
    [lay.decos[0].x0, lay.decos[0].x1], [0, 30]);
  near("and sits just below the baseline box", lay.decos[0].y, 10 * 1.02);
  check("kind is tagged so the renderer can pick a thickness", lay.decos[0].kind, "under");
}
{
  const lay = layoutTextBox("abc", { strike: true }, flat(), 10, 1);
  near("strike sits through the middle", lay.decos[0].y, 10 * 0.62);
  check("kind", lay.decos[0].kind, "strike");
}
{
  const lay = layoutTextBox("ab\n\ncd", { underline: true, strike: true }, flat(), 10, 1);
  check("both decorations on each non-blank line, none on the blank one", lay.decos.length, 4);
  check("decoration order is under-then-strike per line", lay.decos.map((d) => d.kind), ["under", "strike", "under", "strike"]);
}
{
  const lay = layoutTextBox("ab", { underline: true, letterSpacing: 5 }, flat(), 10, 1);
  check("the underline stops at the last glyph, not after its letter-space",
    [lay.decos[0].x0, lay.decos[0].x1], [0, 25]);
}
{
  const lay = layoutTextBox("ab", { underline: true, align: "right" }, flat(), 10, 1);
  check("the underline follows the alignment offset", [lay.decos[0].x0, lay.decos[0].x1], [0, 20]);
}
check("no decorations when neither flag is set", layoutTextBox("ab", {}, flat(), 10, 1).decos.length, 0);

// --- Vietnamese ----------------------------------------------------------
// The reason this engine rasterises text at all (pdf-lib's standard fonts cannot
// encode Vietnamese diacritics). Precomposed glyphs must be ONE op each.
{
  const lay = layoutTextBox("Hợp đồng", {}, flat(), 10, 1);
  check("precomposed Vietnamese glyphs are one op each", lay.ops.length, 8);
  check("they round-trip unchanged", chars(lay), "Hợp đồng");
  check("the space still takes an op", lay.ops[3].ch, " ");
}
{
  // `for...of` iterates code POINTS, so a glyph outside the BMP stays one op
  // instead of being split into two broken halves.
  const lay = layoutTextBox("a😀b", {}, flat(), 10, 1);
  check("an astral character is not split into surrogate halves", lay.ops.length, 3);
  check("and survives intact", chars(lay), "a😀b");
}

// --- the returned style ---------------------------------------------------
check("the normalised style comes back with the layout (the renderer reuses it)",
  layoutTextBox("a", { align: "bogus", opacity: 5 }, flat(), 10, 1).style,
  normTextStyle({ align: "bogus", opacity: 5 }));

// ==========================================================================
// 4. measureText — the on-screen box
// ==========================================================================

{
  const m = measureText("abc", 10, {}, flat());
  const pad = 10 * 0.15;
  check("pad is added on BOTH sides and the result ceil'd",
    [m.w, m.h], [Math.ceil(30 + pad * 2), Math.ceil(13 + pad * 2)]);
}
check("measureText passes upp=1 (it works in points, so spacings are literal)",
  measureText("abc", 10, { letterSpacing: 5 }, flat()).w, Math.ceil(40 + 3));
check("the box never rounds DOWN below the text (ceil, not round)",
  measureText("a", 10, {}, flat()).w >= 10, true);
check("an empty box is still at least 1pt of text plus padding",
  measureText("", 10, {}, flat()).w >= 1, true);
// Guard: node has no document. Without an injected ctx this MUST say so loudly
// rather than fail somewhere deep inside layout.
check("no ctx and no DOM → a clear error, not a crash in layout",
  (() => { try { measureText("a", 10, {}); return "no throw"; } catch (e) { return /no DOM/.test(e.message) ? "clear" : "unclear: " + e.message; } })(),
  "clear");
check("measureCtx itself throws the same way in node",
  (() => { try { A.measureCtx(); return "no throw"; } catch (e) { return /no DOM/.test(e.message) ? "clear" : "unclear"; } })(),
  "clear");

// ==========================================================================
// 5. listDisplayText — the on-screen preview only
// ==========================================================================

check("bullets are prefixed with a trailing space", listDisplayText("a\nb", { listType: "bullet" }), "• a\n• b");
check("numbers count up", listDisplayText("a\nb\nc", { listType: "number" }), "1. a\n2. b\n3. c");
check("blank lines keep their place and do NOT consume a number",
  listDisplayText("a\n\nb", { listType: "number" }), "1. a\n\n2. b");
check("a whitespace-only line is left exactly as it was",
  listDisplayText("a\n  \nb", { listType: "number" }), "1. a\n  \n2. b");
check("listType none returns the text untouched", listDisplayText("a\nb", {}), "a\nb");
check("null/undefined text → empty string, never the word 'null'",
  [listDisplayText(null, {}), listDisplayText(undefined, {})], ["", ""]);
// Guard: the numbering must restart every call. A module-level counter would make
// the SECOND text box on a page start at 4.
check("numbering restarts on every call (no leaked counter)",
  listDisplayText("a\nb\nc", { listType: "number" }), listDisplayText("a\nb\nc", { listType: "number" }));
// Guard: this is DISPLAY ONLY. The markers must never be folded into the stored
// text, or editing a list would show "1. 1. a" and bake it that way.
check("the input string is not mutated and markers are not idempotent-safe by accident",
  listDisplayText(listDisplayText("a", { listType: "number" }), { listType: "number" }), "1. 1. a");

// ==========================================================================
// 6. the module surface itself (BI-14: a rename here breaks editor.js silently)
// ==========================================================================

check("node import exposes exactly the surface editor.js calls by bare name",
  Object.keys(A).sort(),
  ["FONT_STACKS",
   // viền khung: the border width range
   "TEXT_BORDER_MAX", "TEXT_BORDER_MIN",
   // the text default (Đặt làm mặc định / Xoá định dạng): which fields, the size range
   "TEXT_DEFAULT_KEYS",
   // the bake's placement pad (0.15em) — what the rotation pivot subtracts
   "TEXT_PLACE_PAD_EM",
   // the raster's supersample factor (renderTextPng + the overlay border)
   "TEXT_RS",
   "TEXT_SIZE_DEFAULT", "TEXT_SIZE_MAX", "TEXT_SIZE_MIN",
   // Sao chép / Dán định dạng
   "applyTextFormat", "copyTextFormat",
   "fontFamily",
   // justify on screen (isLastOfPara: the one ragged-line rule; justifiedDisplayLines:
   // the overlay's per-line elements for a justified box)
   "isLastOfPara", "justifiedDisplayLines",
   "layoutTextBox", "listDisplayText", "measureCtx",
   "measureText", "normRot",
   // viền khung: null | { color, width, dash }
   "normTextBorder",
   "normTextStyle",
   // the text default: validate a stored / picked style
   "parseTextDefault", "pickTextDefault",
   "rotatedBox", "textFont",
   // the raster's rectangle — renderTextPng's arithmetic, read back by the overlay
   "textRasterBoxPt", "textRasterGeom",
   // where a turned box turns (the raster's centre) — overlay + inline editor (BI-110)
   "textRotationPivot",
   "textStyle",
   // fixed-width boxes (wrapLine: the break rule; wrappedDisplayText: the overlay text)
   "wrapLine", "wrappedDisplayText"]);
// UPPER_CASE exports are data (tables / numbers); everything else must be a function.
check("every export is callable (or a data constant)",
  Object.keys(A).map((k) => (/^[A-Z_]+$/.test(k) ? typeof A[k] === "object" || typeof A[k] === "number" : typeof A[k] === "function")).every(Boolean), true);


// ==========================================================================
// 7. normRot / rotatedBox - turning a text box (v0.2.63)
// ==========================================================================
//
// WHY THESE TWO ARE PURE AND TESTED HERE. Text rotation is baked into the RASTER
// (editor.js renderTextPng), not into the annotation's /AP matrix - which is what
// let it ship without touching the placement maths BI-59 and test:rotate exist to
// protect. What that trade costs is these two functions: the canvas has to be
// exactly the turned box, and the placement has to move by exactly half the growth,
// or the words drift off where the user put them. Neither can be checked by looking
// at the app, so they are checked here.

const { normRot, rotatedBox } = A;

check("normRot: already in range, unchanged", [normRot(0), normRot(45), normRot(-90), normRot(180)],
  [0, 45, -90, 180]);
// A degree field lets someone type 350 meaning "10 the other way". Storing 350 and
// -10 as different numbers would make two identical-looking boxes compare unequal,
// and the number round-trips through /NabuData.
check("normRot: wraps into (-180, 180]", [normRot(350), normRot(-350), normRot(270), normRot(-270)],
  [-10, 10, -90, 90]);
check("normRot: multiple turns collapse", [normRot(720), normRot(-720), normRot(450), normRot(361)],
  [0, 0, 90, 1]);
check("normRot: 180 stays positive (the interval is half-open at -180)",
  [normRot(180), normRot(-180)], [180, 180]);
check("normRot: junk is upright, and never -0",
  [normRot(undefined), normRot(null), normRot(NaN), normRot("x"), Object.is(normRot(-360), 0)],
  [0, 0, 0, 0, true]);

// EXACTLY (w, h) at 0 - no epsilon, no ceil. This is what keeps an upright text box
// byte-identical to what shipped before rotation existed, which is the same promise
// apMatrixFor makes about an unrotated page.
check("rotatedBox: 0 returns the box untouched, exactly",
  [rotatedBox(100, 20, 0), rotatedBox(100, 20, undefined), rotatedBox(100, 20, 360)],
  [{ w: 100, h: 20 }, { w: 100, h: 20 }, { w: 100, h: 20 }]);
check("rotatedBox: a quarter turn swaps the sides",
  [Math.round(rotatedBox(100, 20, 90).w), Math.round(rotatedBox(100, 20, 90).h),
   Math.round(rotatedBox(100, 20, -90).w), Math.round(rotatedBox(100, 20, -90).h)],
  [20, 100, 20, 100]);
check("rotatedBox: half a turn is the same box",
  [Math.round(rotatedBox(100, 20, 180).w), Math.round(rotatedBox(100, 20, 180).h)], [100, 20]);
// 45 degrees is where a w-and-h mix-up cannot hide: both sides become the same
// number, and that number is (w+h)/sqrt(2).
check("rotatedBox: 45 gives (w+h)/sqrt(2) on both sides",
  [Math.round(rotatedBox(100, 20, 45).w * 100) / 100,
   Math.round(rotatedBox(100, 20, 45).h * 100) / 100],
  [Math.round((120 / Math.SQRT2) * 100) / 100, Math.round((120 / Math.SQRT2) * 100) / 100]);
check("rotatedBox: the box never shrinks, at any angle",
  (() => {
    for (let d = -180; d <= 180; d += 7) {
      const r = rotatedBox(100, 20, d);
      if (r.w < 20 - 1e-9 || r.h < 20 - 1e-9) return d;   // never below the short side
      if (r.w > 120 + 1e-9 || r.h > 120 + 1e-9) return d; // never above w+h
    }
    return true;
  })(),
  true);
check("rotatedBox: mirrored angles give the same box (|cos|, |sin|)",
  [rotatedBox(80, 30, 30), rotatedBox(80, 30, -30)][0].w === rotatedBox(80, 30, -30).w, true);
check("rotatedBox: it normalises its own angle (350 behaves as -10)",
  rotatedBox(80, 30, 350), rotatedBox(80, 30, -10));

// normTextStyle is the one place the rest of the app reads the angle from, so it has
// to normalise on the way in - a hand-edited /NabuData carrying 450 must not reach
// the rasteriser as 450.
check("normTextStyle normalises rot on the way in",
  [normTextStyle({ rot: 450 }).rot, normTextStyle({ rot: "-90" }).rot,
   normTextStyle({ rot: "abc" }).rot, normTextStyle({}).rot],
  [90, -90, 0, 0]);

// ---- a text box's background must never touch the LAYOUT (v0.2.64) ----------
//
// A text box can now carry `fill` + `fillOpacity` (the wash behind its words). Those two
// live on the ANNOT, are painted by renderTextPng and by renderAnnot's underlay, and must
// be invisible to everything in this file. The reason is BI-40: `layoutTextBox` positions
// every glyph for BOTH the on-screen box and the baked PNG, so if a background could nudge
// a single advance, a box would wrap differently in the saved file than on screen — and
// nothing would report it. normTextStyle building a fresh object from a fixed field list
// is what makes that impossible; these cases are the guard on that property.
const BG = { fill: "#ffeb3b", fillOpacity: 0.4 };
check("normTextStyle drops fill/fillOpacity entirely",
  ["fill" in normTextStyle(BG), "fillOpacity" in normTextStyle(BG)], [false, false]);
check("… so a styled box normalises to exactly the same style with or without a background",
  normTextStyle(Object.assign({ bold: true, align: "center", rot: 30 }, BG)),
  normTextStyle({ bold: true, align: "center", rot: 30 }));
check("measureText returns the identical box with a background applied",
  measureText("Nghiem thu\nlan 2", 16, Object.assign({ charScale: 0.8 }, BG), flat()),
  measureText("Nghiem thu\nlan 2", 16, { charScale: 0.8 }, flat()));
check("layoutTextBox places every glyph identically with a background applied",
  JSON.stringify(layoutTextBox("Nghiem thu", BG, flat(), 48, 3).ops),
  JSON.stringify(layoutTextBox("Nghiem thu", {}, flat(), 48, 3).ops));
check("textFont ignores a background too (it is not a font property)",
  textFont(14, BG), textFont(14, {}));

// ==========================================================================
// 8. fixed-width boxes ("hộp cố định bề rộng") — boxW
// ==========================================================================
//
// The user's complaint: dragging the frame changed nothing, a one-line text stayed one
// line until it was baked. A box with `boxW` wraps to that width and grows DOWN. The
// danger is the usual one (BI-40): the screen element and the baked PNG must break
// every line in the same place, or the saved file differs from what was approved.

const { wrapLine, wrappedDisplayText } = A;
const W10 = (t) => [...t].length * 10; // flat 10-wide glyphs, as a widthOf

check("W1 a line that fits is returned whole", wrapLine("abc def", 70, W10), ["abc def"]);
check("W2 breaks after spaces, trailing spaces hang (not drawn)",
  wrapLine("aa bb cc dd", 50, W10), ["aa bb", "cc dd"]);
check("W3 may break after a hyphen, like the browser's textarea",
  wrapLine("DAOL.I2_BD-S-5.001", 120, W10), ["DAOL.I2_BD-", "S-5.001"]);
check("W3b …greedily: a line takes every piece that still fits",
  wrapLine("ab-cd-ef", 50, W10), ["ab-", "cd-ef"]);
check("W4 a word wider than the box is cut between characters, never overflows",
  wrapLine("abcdefghij", 40, W10), ["abcd", "efgh", "ij"]);
check("W5 no drawn line is wider than the box",
  wrapLine("Hợp đồng thi công xây dựng công trình nhà ở thương mại", 120, W10).every((l) => W10(l) <= 120), true);
check("W6 nothing is lost: the words come back in order",
  wrapLine("aa bb cc dd ee", 50, W10).join(" ").split(/ +/), ["aa", "bb", "cc", "dd", "ee"]);

check("B1 boxW is normalised: negative / garbage → 0 (point box), strings accepted",
  [-5, "x", NaN, undefined, "120", 80].map((v) => normTextStyle({ boxW: v }).boxW), [0, 0, 0, 0, 120, 80]);
check("B2 boxW 0 lays out byte-identically to a box that never had the field",
  JSON.stringify(layoutTextBox("ab\ncd ef", { boxW: 0, align: "right" }, flat(), 10, 1)),
  JSON.stringify(layoutTextBox("ab\ncd ef", { align: "right" }, flat(), 10, 1)));
{
  const lay = layoutTextBox("aa bb cc dd", { boxW: 50 }, flat(), 10, 1);
  check("B3 the box is exactly boxW wide, whatever the text", lay.width, 50);
  check("B3b two lines, wrapped", lay.lines.map((l) => l.str), ["aa bb", "cc dd"]);
  check("B3c the second line sits one line-height down", [...new Set(lay.ops.map((o) => o.y))], [0, 13]);
}
{
  const lay = layoutTextBox("ab cd", { boxW: 100, align: "center" }, flat(), 10, 1);
  check("B4 centre aligns within the BOX, not within the longest line", lay.ops[0].x, (100 - 50) / 2);
}
{
  const lay = layoutTextBox("aa bb cc dd ee", { boxW: 70, align: "justify" }, flat(), 10, 1);
  const rows = {};
  for (const o of lay.ops) (rows[o.y] = rows[o.y] || []).push(o);
  const right = (r) => r[r.length - 1].x + 10;
  check("B5 justify stretches every wrapped line but the paragraph's last",
    Object.values(rows).map(right), [70, 70, 20]);
}
{
  // 80 wide minus the number column ("1." 20 + gap 4) leaves 56 for the text.
  const lay = layoutTextBox("aa bb cc\ndd", { boxW: 80, listType: "number" }, flat(), 10, 1);
  check("B6 a list marker only on the FIRST line of each item",
    lay.lines.map((l) => [l.marker, l.str]), [["1.", "aa bb"], ["", "cc"], ["2.", "dd"]]);
}
check("B7 measureText of a fixed box: width = boxW + padding, height grows with lines",
  [measureText("aa bb cc dd", 10, { boxW: 50 }, flat()), measureText("aa bb", 10, { boxW: 50 }, flat())],
  [{ w: Math.ceil(50 + 3), h: Math.ceil(26 + 3) }, { w: Math.ceil(50 + 3), h: Math.ceil(13 + 3) }]);
check("B8 an indent wider than the box still makes progress (one glyph per line)",
  layoutTextBox("abc", { boxW: 10, indent: 40 }, flat(), 10, 1).lines.map((l) => l.str), ["a", "b", "c"]);

// B9 — THE BI-40 case. A measuring context whose widths are NOT linear in font size
// (rounded to whole px, as hinting does). If line breaks were decided at the call's
// scale, the raster (fpx = size·3) and the screen (fpx = size) would split differently.
const hinted = () => {
  const ctx = {
    font: "10px x",
    measureText(str) {
      const px = parseFloat(/([\d.]+)px/.exec(ctx.font)[1]);
      return { width: [...str].reduce((t) => t + Math.round(px * 0.55 + 0.4), 0) };
    },
  };
  return ctx;
};
{
  const TXT = "Mặt bằng định vị cọc tháp I2 khu đô thị thể thao quốc tế";
  const at1 = layoutTextBox(TXT, { boxW: 60 }, hinted(), 10, 1).lines.map((l) => l.str);
  const at3 = layoutTextBox(TXT, { boxW: 60 }, hinted(), 30, 3).lines.map((l) => l.str);
  check("B9 screen (1×) and bake (3×) break every line in the same place", at3, at1);
  check("B9b …and the fixture really is non-linear (else B9 proves nothing)",
    hinted().measureText.call({ font: "30px x" }, "a") !== undefined &&
    (() => { const c = hinted(); c.font = "30px x"; const w3 = c.measureText("abcdefgh").width; c.font = "10px x"; return w3 !== 3 * c.measureText("abcdefgh").width; })(),
    true);
}
check("B10 the overlay text of a fixed box is its wrapped lines",
  wrappedDisplayText("aa bb cc dd", { boxW: 50 }, 10, flat()), "aa bb\ncc dd");
check("B10b …and of a point box exactly what listDisplayText gives",
  wrappedDisplayText("aa bb\ncc", { listType: "bullet" }, 10, flat()), listDisplayText("aa bb\ncc", { listType: "bullet" }));
// B11 — the /NabuData payload. A point box must stay byte-identical (BI-59: every
// file saved before fixed boxes existed re-saves to the same bytes); a fixed box must
// carry its width, or re-opening the file turns it back into one long line.
{
  const MC = require("../renderer/managed-codec.js");
  const base = { kind: "text", x: 1, y: 2, w: 30, h: 20, text: "aa bb", fontSize: 12, color: "#000000" };
  const point = MC.serializeManaged(base);
  check("B11 a point box writes no boxW key at all", "boxW" in point, false);
  check("B11b …so its payload is exactly what it was before boxW existed",
    JSON.stringify(point), JSON.stringify(MC.serializeManaged(Object.assign({}, base, { boxW: 0 }))));
  check("B11c a fixed box writes its width", MC.serializeManaged(Object.assign({}, base, { boxW: 120 })).boxW, 120);
}

// B12 — source pins on editor.js, which the grid cannot run (DOM). Each one is a place
// where an innocent-looking edit silently breaks fixed boxes.
{
  const ed = require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "editor.js"), "utf8");
  check("B12 the overlay shows a fixed box's WRAPPED lines (never the browser's wrapping)",
    /st\.boxW > 0\s*\?\s*window\.AnnotText\.wrappedDisplayText\(a\.text, st, a\.fontSize\)/.test(ed), true);
  check("B12b the drag-out runs BEFORE onMove drops a drag with no annot",
    /if \(drag\.type === "textbox"\) \{[\s\S]{0,300}?return;\s*\}\s*const hit = findAnnot\(drag\.id\);/.test(ed), true);
  check("B12c Esc during the drag-out keeps the field open (returns before renderLayer)",
    /function cancelDrag\(\)[\s\S]{0,400}?d\.type === "textbox"[\s\S]{0,200}?return;/.test(ed), true);
  check("B12d a resize grip moves the wrap width and re-measures the height",
    /a\.kind === "text"\) \{[\s\S]{0,700}?a\.boxW = Math\.max\(MIN_BOX_W[\s\S]{0,200}?measureText\(a\.text, a\.fontSize, textStyle\(a\)\)/.test(ed), true);
  check("B12e Esc on a grip drag puts the wrap width back too",
    /d\.orig\.boxW != null\) a\.boxW = d\.orig\.boxW/.test(ed), true);
}

check("B10c a list item's continuation line is indented, its marker not repeated",
  wrappedDisplayText("aa bb cc", { boxW: 70, listType: "bullet" }, 10, flat()), "• aa bb\n   cc");

// J — justify on screen = justify in the file. The overlay builds one element per line
// (editor.js renderJustifiedLines) and stretches exactly the lines justifiedDisplayLines
// flags. The flags must be the lines layoutTextBox ACTUALLY stretches, read off its ops:
// a line is stretched iff its glyphs span more than their natural width. Before this,
// the screen stretched none of them (CSS treats every pre-broken line as a paragraph
// end) while the bake stretched most of them (BI-40).
const { justifiedDisplayLines, isLastOfPara } = A;
{
  // Which lines does the BAKE stretch? Row by row from the ops (flat 10-wide glyphs,
  // line height 13, no paragraph spacing in these cases).
  const bakeStretched = (text, style) => {
    const lay = layoutTextBox(text, style, flat(), 10, 1);
    const rows = new Map();
    for (const o of lay.ops) {
      if (!rows.has(o.y)) rows.set(o.y, []);
      rows.get(o.y).push(o);
    }
    return lay.lines.map((it, i) => {
      const r = rows.get(i * 13) || [];
      if (it.blank || !r.length) return false;
      const n = [...it.str].length;
      const textOps = r.slice(r.length - n);
      const spanned = textOps[n - 1].x + 10 - textOps[0].x;
      return spanned > n * 10 + 1e-9;
    });
  };
  const flags = (text, style) => justifiedDisplayLines(text, style, 10, flat()).lines.map((l) => l.justify);
  const CASES = [
    ["fixed box, two paragraphs", "aa bb cc dd ee\nff gg hh ii", { boxW: 70, align: "justify" }],
    ["point box, blank line splits paragraphs", "a b\nccc ddd eee\n\nf g\nhhhh iiii", { align: "justify" }],
    ["fixed box, numbered list", "aa bb cc dd\nee ff gg hh", { boxW: 80, align: "justify", listType: "number" }],
    ["fixed box, a line with no space is never stretched", "abcdefghijklmnop qq rr ss tt", { boxW: 60, align: "justify" }],
    ["point box, bullets + indent", "aa bb\nc d\ndd ee ff", { align: "justify", listType: "bullet", indent: 18 }],
  ];
  for (const [name, text, style] of CASES) {
    check("J1 screen stretches exactly the lines the bake stretches — " + name, flags(text, style), bakeStretched(text, style));
  }
  check("J1b …and every case stretches something AND leaves something ragged (else J1 proves nothing)",
    CASES.map(([, t, st]) => { const b = bakeStretched(t, st); return b.includes(true) && b.includes(false); }),
    CASES.map(() => true));
}
check("J2 the stretched width is the bake's line end, measured from the indent (fixed box)",
  justifiedDisplayLines("aa bb cc", { boxW: 70, align: "justify", indent: 12 }, 10, flat()).width, 70 - 12);
check("J2b …and for a point box the longest line plus the list column",
  justifiedDisplayLines("a b\nccc ddd", { align: "justify", listType: "number" }, 10, flat()).width,
  layoutTextBox("a b\nccc ddd", { align: "justify", listType: "number" }, flat(), 10, 1).width);
check("J3 same text and markers as the one-string overlay (fixed box)",
  justifiedDisplayLines("aa bb cc", { boxW: 70, listType: "bullet", align: "justify" }, 10, flat()).lines.map((l) => l.marker + l.str).join("\n"),
  wrappedDisplayText("aa bb cc", { boxW: 70, listType: "bullet", align: "justify" }, 10, flat()));
check("J3b …and (point box) the same as listDisplayText",
  justifiedDisplayLines("x y\n\nz", { listType: "number", align: "justify" }, 10, flat()).lines.map((l) => l.marker + l.str).join("\n"),
  listDisplayText("x y\n\nz", { listType: "number" }));
{
  // The fixed-box half of the rule, in the BAKE. B5 cannot see it (its one paragraph
  // ends on the box's last line, where both halves agree); here paragraph 1 ends on a
  // wrapped line that is NOT followed by a blank — Word leaves it ragged, and so must we.
  const lay = layoutTextBox("aa bb cc dd\nee ff gg", { boxW: 60, align: "justify" }, flat(), 10, 1);
  const rows = {};
  for (const o of lay.ops) (rows[o.y] = rows[o.y] || []).push(o);
  check("J6 a paragraph's last WRAPPED line stays ragged even with more text below",
    Object.values(rows).map((r) => r[r.length - 1].x + 10), [60, 50, 60, 20]);
}
check("J4 isLastOfPara (point box): the last line and the line before a blank",
  [0, 1, 2, 3].map((i) => isLastOfPara([{ blank: false }, { blank: false }, { blank: true }, { blank: false }], i, false)),
  [false, true, false, true]);
{
  const ed = require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "editor.js"), "utf8");
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "app.css"), "utf8");
  check("J5 renderAnnot sends a justified box down the per-line path",
    /st\.align === "justify"\) renderJustifiedLines\(el, a, st, s\)/.test(ed), true);
  check("J5b …which flags each row from justifiedDisplayLines (never a rule of its own)",
    /window\.AnnotText\.justifiedDisplayLines\(a\.text, st, a\.fontSize\)[\s\S]{0,600}?ln\.justify \? "an-text-line jl"/.test(ed), true);
  check("J5c the stretch is text-align-LAST (a lone line is its own last line)",
    /\.an-text-line\.jl \{[^}]*text-align-last: justify/.test(css), true);
  check("J5d the list marker is atomic (justify must not widen the gap after it)",
    /\.an-text-mk \{[^}]*display: inline-block/.test(css), true);
}

// T — the text default ("Đặt làm mặc định" / "Xoá định dạng"). pickTextDefault decides
// WHICH fields a default carries and validates them; parseTextDefault reads what a human
// (or an older / newer build) may have left in localStorage. Wrong here = a junk value
// reaches every new box, or a default silently carries colour / rotation / width.
const { pickTextDefault, parseTextDefault, TEXT_DEFAULT_KEYS } = A;
check("T1 the factory style is the plain box every fresh install has always drawn",
  pickTextDefault({}),
  { font: "sans", fontSize: 16, bold: false, italic: false, underline: false, strike: false, align: "left",
    lineHeight: 1.3, paraSpacing: 0, letterSpacing: 0, wordSpacing: 0, charScale: 1, indent: 0, listType: "none", opacity: 1 });
{
  const box = { kind: "text", text: "x", font: "Arial", fontSize: 22, bold: true, italic: true, underline: true, strike: true,
    align: "justify", lineHeight: 1.6, paraSpacing: 4, letterSpacing: 0.5, wordSpacing: 2, charScale: 0.9, indent: 18,
    listType: "number", opacity: 0.8, color: "#123456", fill: "#ffff00", fillOpacity: 0.5, rot: 90, boxW: 200, x: 3, y: 4, w: 50, h: 20 };
  const d = pickTextDefault(box);
  check("T2 a box's style is carried field for field", d,
    { font: "Arial", fontSize: 22, bold: true, italic: true, underline: true, strike: true, align: "justify", lineHeight: 1.6,
      paraSpacing: 4, letterSpacing: 0.5, wordSpacing: 2, charScale: 0.9, indent: 18, listType: "number", opacity: 0.8 });
  check("T2b …and NEVER colour, background, rotation, wrap width, text or geometry",
    ["color", "fill", "fillOpacity", "rot", "boxW", "text", "kind", "x", "y", "w", "h"].filter((k) => k in d), []);
  check("T2c the key list is exactly the output (one list, two readers: editor.js copies by it)",
    Object.keys(d).sort(), TEXT_DEFAULT_KEYS.slice().sort());
}
check("T3 size is clamped to the size field's own range (#ed-fontsize 6…120)",
  [2, 500, -1, "abc", undefined, "24"].map((v) => pickTextDefault({ fontSize: v }).fontSize), [6, 120, 16, 16, 16, 24]);
check("T4 junk values fall back like normTextStyle (align, list, opacity, font)",
  pickTextDefault({ align: "diagonal", listType: "stars", opacity: 7, font: 42 }),
  Object.assign(pickTextDefault({}), { opacity: 1 }));
check("T4b a font name that is not a sane string is dropped to sans",
  [{ font: "   " }, { font: "x".repeat(500) }, { font: { a: 1 } }].map((o) => pickTextDefault(o).font), ["sans", "sans", "sans"]);
check("T5 parseTextDefault: nothing saved / not JSON / not an object → null (never throws)",
  [null, "", "{", "[1,2]", "42", "null", undefined].map(parseTextDefault), [null, null, null, null, null, null, null]);
check("T5b …a saved default round-trips exactly",
  parseTextDefault(JSON.stringify(pickTextDefault({ font: "Tahoma", fontSize: 12, align: "center" }))),
  pickTextDefault({ font: "Tahoma", fontSize: 12, align: "center" }));
check("T5c …and a hand-edited one is re-validated, extra keys dropped",
  parseTextDefault('{"fontSize": 999, "color": "#ff0000", "bold": "yes"}'),
  Object.assign(pickTextDefault({}), { fontSize: 120, bold: true }));

// V — viền khung + the raster rectangle. normTextBorder is the one reader of the three
// border keys (overlay, raster, payload, deserialiser all go through it); the raster
// rectangle is what the overlay draws the border on, so it must be renderTextPng's own.
const { normTextBorder, textRasterGeom, textRasterBoxPt, TEXT_RS, copyTextFormat, applyTextFormat } = A;
check("V1 no / junk borderColor ⇒ no border (every box written before borders existed)",
  [{}, { borderColor: "red" }, { borderColor: "#12345" }, { borderColor: 7 }, { borderWidth: 3 }].map(normTextBorder),
  [null, null, null, null, null]);
check("V2 a border: width defaults to 1 and is clamped to 0.25…12, dash defaults to solid",
  [{ borderColor: "#ff0000" }, { borderColor: "#ff0000", borderWidth: 0.1 }, { borderColor: "#ff0000", borderWidth: 99 },
   { borderColor: "#ff0000", borderWidth: "2", borderDash: "dot" }, { borderColor: "#ff0000", borderDash: "wavy" }].map(normTextBorder),
  [{ color: "#ff0000", width: 1, dash: "solid" }, { color: "#ff0000", width: 0.25, dash: "solid" },
   { color: "#ff0000", width: 12, dash: "solid" }, { color: "#ff0000", width: 2, dash: "dot" },
   { color: "#ff0000", width: 1, dash: "solid" }]);
check("V3 a border never reaches layout (normTextStyle drops it, so no glyph can move)",
  JSON.stringify(layoutTextBox("ab cd", { borderColor: "#000000", borderWidth: 4 }, flat(), 10, 1)),
  JSON.stringify(layoutTextBox("ab cd", {}, flat(), 10, 1)));
check("V4 textRasterGeom is renderTextPng's arithmetic: pad = ceil(0.15·fpx), size = ceil(layout) + 2·pad",
  textRasterGeom(100.2, 39, 48), { pad: Math.ceil(48 * 0.15), cw: 101 + 2 * 8, chh: 39 + 2 * 8 });
{
  // The overlay asks at the BAKE's scale (3×), not at 1× — with a non-linear (hinted) ctx
  // the two disagree, and the border has to sit where the raster's edge is.
  const hint = () => {
    const c = { font: "10px x", measureText(str) { const px = parseFloat(/([\d.]+)px/.exec(c.font)[1]); return { width: [...str].length * Math.round(px * 0.55 + 0.4) }; } };
    return c;
  };
  const lay3 = layoutTextBox("Nhãn ghi chú", {}, hint(), 16 * TEXT_RS, TEXT_RS);
  const g = textRasterGeom(lay3.width, lay3.height, 16 * TEXT_RS);
  check("V5 textRasterBoxPt = the 3× raster rectangle in pt (what the saved file paints)",
    textRasterBoxPt("Nhãn ghi chú", {}, 16, hint()), { w: g.cw / TEXT_RS, h: g.chh / TEXT_RS });
  check("V5b …and it is NOT measureText's a.w × a.h in general (else the helper buys nothing)",
    JSON.stringify(textRasterBoxPt("Nhãn ghi chú", {}, 16, hint())) !== JSON.stringify(measureText("Nhãn ghi chú", 16, {}, hint())), true);
}
// P5 — Sao chép / Dán định dạng
{
  const src = { kind: "text", text: "A", x: 1, y: 2, w: 3, h: 4, rot: 30, boxW: 120, font: "Tahoma", fontSize: 20, bold: true,
    align: "center", color: "#0000ff", fill: "#ffff00", fillOpacity: 0.6, borderColor: "#ff0000", borderWidth: 2, borderDash: "dash" };
  const f = copyTextFormat(src);
  check("F1 the copied look: style + colour + background + border",
    [f.font, f.fontSize, f.bold, f.align, f.color, f.fill, f.fillOpacity, f.borderColor, f.borderWidth, f.borderDash],
    ["Tahoma", 20, true, "center", "#0000ff", "#ffff00", 0.6, "#ff0000", 2, "dash"]);
  check("F1b …never rotation, wrap width, text or geometry", ["rot", "boxW", "text", "x", "y", "w", "h", "kind"].filter((k) => k in f), []);
  const dst = { kind: "text", text: "B", x: 9, y: 9, w: 9, h: 9, rot: 90, boxW: 50, color: "#000000", fontSize: 10 };
  applyTextFormat(dst, f);
  check("F2 pasting makes the target LOOK like the source",
    [dst.font, dst.fontSize, dst.bold, dst.align, dst.color, dst.fill, dst.borderColor, dst.borderDash], ["Tahoma", 20, true, "center", "#0000ff", "#ffff00", "#ff0000", "dash"]);
  check("F2b …and keeps its own text, position, rotation, wrap width", [dst.text, dst.x, dst.rot, dst.boxW], ["B", 9, 90, 50]);
  const plain = copyTextFormat({ kind: "text", color: "#111111" });
  applyTextFormat(dst, plain);
  check("F3 a plain source REMOVES background and border from the target (keys deleted, not set to none)",
    ["fill", "fillOpacity", "borderColor", "borderWidth", "borderDash"].filter((k) => k in dst), []);
  const foreign = { kind: "text", text: "C", color: "#000000", fontSize: 10, _foreign: {} };
  applyTextFormat(foreign, f, { noBorder: true });
  check("F4 a partner's FreeText takes the look but NOT a border (it keeps its file's own)",
    [foreign.font, foreign.fill, "borderColor" in foreign], ["Tahoma", "#ffff00", false]);
  check("F5 copy → paste → copy round-trips exactly", copyTextFormat(applyTextFormat({ kind: "text" }, f)), f);
}
// The payload: a border travels only when there is one (BI-59 byte identity otherwise).
{
  const MC = require("../renderer/managed-codec.js");
  const base = { kind: "text", x: 1, y: 2, w: 30, h: 20, text: "aa", fontSize: 12, color: "#000000" };
  check("V6 a box with no border writes no border key at all", Object.keys(MC.serializeManaged(base)).filter((k) => /^border/.test(k)), []);
  check("V6b a solid border writes colour + width, no dash key",
    (({ borderColor, borderWidth, borderDash }) => [borderColor, borderWidth, borderDash])(MC.serializeManaged(Object.assign({}, base, { borderColor: "#ff0000", borderWidth: 1.5 }))),
    ["#ff0000", 1.5, undefined]);
  check("V6c a dotted one writes its dash", MC.serializeManaged(Object.assign({}, base, { borderColor: "#ff0000", borderDash: "dot" })).borderDash, "dot");
  check("V6d junk border keys are not written (normalised on the way out)",
    Object.keys(MC.serializeManaged(Object.assign({}, base, { borderColor: "nope", borderWidth: 3 }))).filter((k) => /^border/.test(k)), []);
}

// X — where a TURNED box turns (BI-110). The overlay used to turn about the element's
// centre (a.w/2, a.h/2); the file turns about the raster's centre, `pad` up-left of it,
// so a 90° box landed ~4.9pt (16pt) / ~14.7pt (48pt) away from the screen. The bake half
// of this invariant is in test:managed (renderTextPng's own arithmetic); here: the pure
// function and the two editor.js call sites.
const { textRotationPivot, TEXT_PLACE_PAD_EM } = A;
check("X1 the placement pad is the bake's 0.15em", TEXT_PLACE_PAD_EM, 0.15);
{
  const hint = () => {
    const c = { font: "10px x", measureText(str) { const px = parseFloat(/([\d.]+)px/.exec(c.font)[1]); return { width: [...str].length * Math.round(px * 0.55 + 0.4) }; } };
    return c;
  };
  for (const size of [16, 48]) {
    const rb = textRasterBoxPt("Nhãn ghi chú", { rot: 90 }, size, hint());
    check(`X2 ${size}pt: pivot = raster centre measured from the box's top-left (rb/2 − 0.15·size)`,
      textRotationPivot("Nhãn ghi chú", { rot: 90 }, size, hint()), { x: rb.w / 2 - 0.15 * size, y: rb.h / 2 - 0.15 * size });
    const m = measureText("Nhãn ghi chú", size, { rot: 90 }, hint());
    const pv = textRotationPivot("Nhãn ghi chú", { rot: 90 }, size, hint());
    check(`X2b ${size}pt: …and it is NOT the element's centre (that was the bug: ~pad up-left of it)`,
      Math.abs(m.w / 2 - pv.x) > 0.1 * size && Math.abs(m.h / 2 - pv.y) > 0.1 * size, true);
  }
}
{
  const ed = require("fs").readFileSync(require("path").join(__dirname, "..", "renderer", "editor.js"), "utf8");
  check("X3 renderAnnot turns a box about textRotationPivot (visual px, not divided by charScale)",
    /if \(st\.rot\) \{\s*const pv = window\.AnnotText\.textRotationPivot\(a\.text, st, a\.fontSize\);\s*const cxPx = pv\.x \* s;\s*const cyPx = pv\.y \* s;/.test(ed), true);
  check("X3b …and the inline editor that retypes it turns about the SAME point (no jump on open/close)",
    /if \(existing && st\.rot\) \{\s*const pv = window\.AnnotText\.textRotationPivot\(existing\.text, st, existing\.fontSize\);\s*const cx = \(existing\.x \+ pv\.x\) \* state\.scale;\s*const cy = \(existing\.y \+ pv\.y\) \* state\.scale;/.test(ed), true);
  check("X3c no rotation pivot left on the element's centre (a.w / 2 · a.h / 2)",
    /const cxPx = \(a\.w \* s\) \/ 2;|existing\.x \+ existing\.w \/ 2/.test(ed), false);
}

console.log(`\nannot-text: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
