"use strict";

// Regression net for Kiểu nét (line style: liền / nét đứt / chấm) — BI-94.
//
// FOUR writers have to paint the same dashed line: the overlay <svg> (renderAnnot), the
// round-trip /AP (managed-codec shapeAppearance), the arrow's canvas PNG (renderArrowPng) and
// the flattening fallback (drawOneAnnot). They all read ONE spec from annot-geom.js
// (dashSpec), so this grid pins the pieces separately:
//   1. the pure maths — normDash / dashSpec / dashSegments;
//   2. the /AP operators for each of the four vector kinds (and that a SOLID shape still
//      emits exactly what it emitted before this existed — BI-59);
//   3. /NabuData: the `dash` key is written only when not solid, read back only for the
//      five kinds, and a stray key on a cloud / tick is ignored;
//   4. the real writers, lifted out of editor-bake.js and run: addManagedAnnot (the /AP in
//      the saved file) and drawOneAnnot (the flatten fallback, on a rotated page too);
//   5. the wiring in editor.js / index.html / i18n, pinned on the source because the
//      renderer cannot run here (DOM) — the arrow PNG's setLineDash among them.
//
// Run:  node desktop/test/annot-dash.test.js     (or: npm run test:dash)

const fs = require("fs");
const path = require("path");
const PDFLib = require("pdf-lib");
const { PDFDocument, rgb, PDFName, PDFDict, PDFRawStream, PDFHexString, degrees, drawRectangle, drawEllipse, drawSvgPath,
  setLineJoin, LineCapStyle, LineJoinStyle } = PDFLib;
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const G = require("../renderer/annot-geom.js");
const { DASH_KINDS, normDash, dashSpec, dashSegments } = G;

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
  if (typeof actual === "number" && Math.abs(actual - expected) <= (eps == null ? 1e-6 : eps)) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ≈${expected}\n  actual   ${actual}`);
  }
}

// ---- 1. the pure maths ----------------------------------------------------------

check("DASH_KINDS is exactly the five kinds with a straight outline",
  [...DASH_KINDS].sort(), ["arrow", "box", "draw", "ellipse", "poly"]);
for (const k of ["cloud", "cloudpen", "check", "cross", "dim", "text", "highlight"]) {
  check(`${k} is NOT dashable`, DASH_KINDS.has(k), false);
}

check("normDash keeps dash", normDash("dash"), "dash");
check("normDash keeps dot", normDash("dot"), "dot");
for (const junk of [undefined, null, "", "solid", "DASH", "dashed", 5, {}, []]) {
  check(`normDash(${JSON.stringify(junk)}) → solid`, normDash(junk), "solid");
}

check("dashSpec: solid is null (the caller must not touch the pen)", dashSpec("solid", 2), null);
check("dashSpec: a junk style is null too", dashSpec("wavy", 2), null);
check("dashSpec: undefined style is null", dashSpec(undefined, 2), null);
check("dashSpec dash @2pt: 4w on, 3w off, BUTT cap", dashSpec("dash", 2), { array: [8, 6], cap: "butt" });
check("dashSpec dot @2pt: a near-zero dash with a ROUND cap", dashSpec("dot", 2), { array: [0.01, 4], cap: "round" });
check("dashSpec scales with the pen", dashSpec("dash", 8), { array: [32, 24], cap: "butt" });
check("dashSpec: a missing width reads as the 2pt default every writer uses", dashSpec("dash"), dashSpec("dash", 2));
check("dashSpec: a hairline is floored at 1pt so the dashes stay visible", dashSpec("dash", 0.2), { array: [4, 3], cap: "butt" });
check("dashSpec dot @1pt", dashSpec("dot", 1), { array: [0.01, 2], cap: "round" });

// dashSegments
const line = (n, step) => Array.from({ length: Math.floor(n / step) + 1 }, (_, i) => ({ x: i * step, y: 0 }));
const len = (seg) => Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
const total = (segs) => segs.reduce((s, q) => s + len(q), 0);
{
  const one = dashSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }], [8, 6]);
  // period 14: seven full dashes (56) + the first 2pt of the eighth
  check("a straight 100pt line @[8,6] → 8 dashes", one.length, 8);
  near("…of total length 58 (7×8 + 2)", total(one), 58);
  near("…the first starts at 0 and ends at 8", one[0][1].x, 8);
  near("…the second starts at 14 (8 on + 6 off)", one[1][0].x, 14);
  near("…the last is the 2pt remainder", len(one[7]), 2);
}
{
  // the property the flatten fallback exists for: a freehand stroke is MANY short segments,
  // and the rhythm must survive them. 1pt steps vs one 100pt segment: same ink.
  const fine = dashSegments(line(100, 1), [8, 6]);
  near("100 × 1pt segments carry the same ink as one 100pt segment", total(fine), 58);
  check("no piece is longer than a dash", fine.every((q) => len(q) <= 8 + 1e-9), true);
  const wiggly = dashSegments([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }], [8, 6]);
  // 30 + 40 + 30 = 100pt of path round two corners: the same 58pt of ink as a straight 100pt line
  near("a corner does not reset the pattern: 100pt round two corners → 58pt of ink", total(wiggly), 58);
}
{
  const dots = dashSegments([{ x: 0, y: 0 }, { x: 40, y: 0 }], [0.01, 4]);
  check("a 40pt line @dot(2pt) → ten dots", dots.length, 10);
  check("each dot is (nearly) zero length — the round cap is what makes it a circle", dots.every((q) => len(q) <= 0.0100001), true);
}
check("fewer than two points → nothing", dashSegments([{ x: 0, y: 0 }], [8, 6]), []);
check("no points → nothing", dashSegments([], [8, 6]), []);
check("repeated points do not loop or emit",
  dashSegments([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }], [8, 6]), []);
check("a zero in the pattern would never advance → refused, not an infinite loop",
  dashSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }], [0, 6]), []);
check("a one-element pattern is refused", dashSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }], [8]), []);
check("the input points are not mutated",
  (() => { const p = [{ x: 0, y: 0 }, { x: 20, y: 0 }]; dashSegments(p, [8, 6]); return p; })(),
  [{ x: 0, y: 0 }, { x: 20, y: 0 }]);

// ---- 2. the /AP operators ---------------------------------------------------------

const MC = require("../renderer/managed-codec.js");
const { shapeAppearance, serializeManaged } = MC;
const RED = rgb(1, 0, 0);
const base = {
  box: { kind: "box", x: 20, y: 20, w: 100, h: 60, color: "#ff0000", width: 2 },
  ellipse: { kind: "ellipse", x: 20, y: 20, w: 100, h: 60, color: "#ff0000", width: 2 },
  draw: { kind: "draw", pts: [{ x: 10, y: 10 }, { x: 60, y: 40 }, { x: 110, y: 15 }], color: "#ff0000", width: 2 },
  poly: { kind: "poly", pts: [{ x: 10, y: 10 }, { x: 90, y: 20 }, { x: 50, y: 70 }], closed: true, color: "#ff0000", width: 2 },
};
const ops = (a) => shapeAppearance(a, RED, null, 1).ops;
const lines = (s) => s.split("\n");
const dashOp = (s) => lines(s).filter((l) => / d$/.test(l));

for (const k of ["box", "ellipse", "draw", "poly"]) {
  const solid = ops(base[k]);
  check(`${k}: no dash key == dash "solid" == a junk dash (all byte-identical)`,
    [ops({ ...base[k], dash: "solid" }), ops({ ...base[k], dash: "wavy" })], [solid, solid]);
  check(`${k}: a solid shape emits the empty dash [] 0 d and no cap other than its own`, dashOp(solid), ["[] 0 d"]);

  const dashed = ops({ ...base[k], dash: "dash" });
  check(`${k}: "dash" @2pt emits [8 6] 0 d`, dashOp(dashed), ["[8 6] 0 d"]);
  const dotted = ops({ ...base[k], dash: "dot" });
  check(`${k}: "dot" @2pt emits [0.01 4] 0 d`, dashOp(dotted), ["[0.01 4] 0 d"]);
  check(`${k}: "dot" has a round cap (1 J)`, lines(dotted).includes("1 J"), true);
  check(`${k}: "dash" has NO round cap — a round cap would swallow the gap`, lines(dashed).includes("1 J"), false);

  // the form's size must not depend on the style: the BBox pad is one pen width either way
  const s0 = shapeAppearance(base[k], RED, null, 1);
  const s1 = shapeAppearance({ ...base[k], dash: "dash" }, RED, null, 1);
  check(`${k}: the /AP box and anchor are the same dashed or solid`,
    [s1.wPt, s1.hPt, s1.ox, s1.oy, s1.pad], [s0.wPt, s0.hPt, s0.ox, s0.oy, s0.pad]);
}
check("a box's dashes scale with its pen", dashOp(ops({ ...base.box, dash: "dash", width: 5 })), ["[20 15] 0 d"]);
check("a dashed box keeps its fill + fill alpha (the pattern is stroke-only)",
  lines(shapeAppearance({ ...base.box, dash: "dash" }, RED, rgb(0, 0, 1), 0.5).ops).some((l) => /\/NabuGS gs/.test(l)), true);

// SOLID == WHAT SHIPPED BEFORE. Rebuild the old operators by hand, straight from pdf-lib, with
// no dash option anywhere, and demand shapeAppearance matches them exactly (BI-59).
{
  const lw = 2;
  const common = { borderWidth: lw, borderColor: RED, color: undefined, rotate: degrees(0) };
  const boxOld = drawRectangle({ ...common, xSkew: degrees(0), ySkew: degrees(0), x: lw, y: lw, width: 100, height: 60 }).map(String).join("\n");
  check("solid box == the hand-built pre-dash operators", ops(base.box), boxOld);
  const ellOld = drawEllipse({ ...common, x: lw + 50, y: lw + 30, xScale: 50, yScale: 30 }).map(String).join("\n");
  check("solid ellipse == the hand-built pre-dash operators", ops(base.ellipse), ellOld);
  const g = G.strokePath(base.draw.pts);
  const hPt = g.H + 2 * lw;
  const dOld = drawSvgPath(g.d, { ...common, x: lw, y: hPt - lw, borderLineCap: LineCapStyle.Round });
  dOld.splice(1, 0, setLineJoin(LineJoinStyle.Round));
  check("solid draw == the hand-built pre-dash operators", ops(base.draw), dOld.map(String).join("\n"));
  const pg = G.polyPath(base.poly.pts, true);
  const pOld = drawSvgPath(pg.d, { ...common, x: lw, y: pg.H + 2 * lw - lw, borderLineCap: LineCapStyle.Round });
  pOld.splice(1, 0, setLineJoin(LineJoinStyle.Round));
  check("solid poly == the hand-built pre-dash operators", ops(base.poly), pOld.map(String).join("\n"));
}

// kinds outside DASH_KINDS never grow a pattern, even with a stray key
for (const a of [
  { kind: "cloud", x: 20, y: 20, w: 100, h: 60, color: "#ff0000", width: 2 },
  { kind: "check", x: 20, y: 20, w: 20, h: 20, color: "#00aa00", width: 2 },
]) {
  check(`${a.kind} with a stray dash key still draws solid`,
    shapeAppearance({ ...a, dash: "dash" }, RED, null, 1).ops, shapeAppearance(a, RED, null, 1).ops);
}

// ---- 3. /NabuData ----------------------------------------------------------------

const arrow = { kind: "arrow", x1: 10, y1: 10, x2: 90, y2: 40, color: "#ff0000", width: 2, label: "A", labelEnd: "head", labelSize: 14 };
for (const k of ["box", "ellipse", "draw", "poly"]) {
  check(`${k}: a solid shape writes NO dash key (the payload bytes are unchanged)`,
    "dash" in serializeManaged(base[k]), false);
  check(`${k}: dashed writes dash`, serializeManaged({ ...base[k], dash: "dash" }).dash, "dash");
  check(`${k}: dotted writes dot`, serializeManaged({ ...base[k], dash: "dot" }).dash, "dot");
  check(`${k}: an explicit "solid" is not written either`, "dash" in serializeManaged({ ...base[k], dash: "solid" }), false);
}
check("arrow: solid writes no dash key", "dash" in serializeManaged(arrow), false);
check("arrow: dashed writes dash", serializeManaged({ ...arrow, dash: "dash" }).dash, "dash");
check("a cloud never writes dash", "dash" in serializeManaged({ kind: "cloud", x: 1, y: 1, w: 50, h: 50, color: "#f00", width: 2, dash: "dash" }), false);
check("a tick never writes dash", "dash" in serializeManaged({ kind: "check", x: 1, y: 1, w: 20, h: 20, color: "#0a0", width: 2, dash: "dot" }), false);
// the exact old payload for a solid box: same keys, same order
check("a solid box's payload is exactly the pre-dash shape",
  JSON.stringify(serializeManaged(base.box)),
  JSON.stringify({ k: "box", color: "#ff0000", width: 2, x: 20, y: 20, w: 100, h: 60 }));

// ---- 4. the real writers, lifted out of editor-bake.js ------------------------

const SRC = ["editor.js", "editor-bake.js"]
  .map((f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8"))
  .join("\n");
function fnSource(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found — renamed or removed?`);
  if (SRC.slice(at - 6, at) === "async ") at -= 6;
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}
// The module-scope names the lifted functions read (same set annot-rotate.test.js provides).
const { cloudPath, cloudPathPoly, bumpOf, symbolStrokes, arrowLabelPos,
  TEXTHL_OPACITY, isPtsKind, isQuadKind, polyPath, quadsFromRects, scalePts } = G;
const {
  makeMap, pageRotate, sniffImage, strToBytes, pushPageAnnot,
  normAngle, apRotatable, apMatrixFor, apRectFor, isVectorKind,
  NABU_KIND, NABU_DATA, NABU_SRC,
} = MC;
const { normTextStyle } = require("../renderer/annot-text.js");
// eslint-disable-next-line no-unused-vars
const { b64ToU8 } = require("../renderer/wire.js");
const SYMBOL_KINDS = new Set(["check", "cross"]);
const renderTextPng = () => { throw new Error("canvas-backed kinds are not driven here"); };
const renderArrowPng = renderTextPng;
const noteThreadText = renderTextPng;
const ed = { seq: 1 };
// eslint-disable-next-line no-eval
const lift = (name) => eval("(" + fnSource(name) + ")");
const hexRgb = lift("hexRgb");
const dataUrlToBytes = lift("dataUrlToBytes");
const addManagedAnnot = lift("addManagedAnnot");
const drawOneAnnot = lift("drawOneAnnot");
const deserializeManaged = lift("deserializeManaged");
const f = (n) => (+n).toFixed(2);

async function makePage(rot) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.setRotation(degrees(rot || 0));
  const pdf = await pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false }).promise;
  const vp1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
  return { doc, page, vp1 };
}
// operators of the page content stream, as strings
const pageOps = (page) => page.getContentStream().operators.map(String);
// the AP form's content stream of the LAST managed annotation, as text
function apText(doc, page) {
  const arr = page.node.Annots();
  const dict = doc.context.lookup(arr.get(arr.size() - 1));
  const ap = doc.context.lookup(dict.get(PDFName.of("AP")));
  const stream = doc.context.lookup(ap.get(PDFName.of("N")));
  if (!(stream instanceof PDFRawStream)) throw new Error("expected a raw AP stream");
  return Buffer.from(stream.contents).toString("latin1");
}
// every "x y m" ... "x y l" pair drawn by drawLine in the content stream
function drawnSegments(opsList) {
  const out = [];
  let m = null;
  for (const o of opsList) {
    let r = /^(-?[\d.]+) (-?[\d.]+) m$/.exec(o);
    if (r) { m = [+r[1], +r[2]]; continue; }
    r = /^(-?[\d.]+) (-?[\d.]+) l$/.exec(o);
    if (r && m) out.push([m, [+r[1], +r[2]]]);
  }
  return out;
}
const segLen = (s) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);

(async () => {
  // -- the round-trip annotation: /AP in the saved file, and what comes back on reopen
  for (const k of ["box", "ellipse", "draw", "poly"]) {
    const { doc, page, vp1 } = await makePage(0);
    const wrote = await addManagedAnnot(doc, page, { id: 1, ...base[k], dash: "dash" }, makeMap(vp1, "orig"), new Map());
    check(`${k}: addManagedAnnot writes a dashed shape as a real annotation`, wrote, true);
    check(`${k}: the saved /AP carries the dash operator`, /\[8 6\] 0 d/.test(apText(doc, page)), true);

    const reopened = await PDFDocument.load(await doc.save());
    const arr = reopened.getPages()[0].node.Annots();
    const dict = reopened.context.lookup(arr.get(0));
    const payload = JSON.parse(dict.get(NABU_DATA).decodeText());
    check(`${k}: /NabuData records dash after save → load`, payload.dash, "dash");
    const back = deserializeManaged(payload, null);
    check(`${k}: deserializeManaged restores a.dash`, back.dash, "dash");
    check(`${k}: …and re-serialising gives the same dash`, serializeManaged(back).dash, "dash");
  }
  {
    const { doc, page, vp1 } = await makePage(0);
    await addManagedAnnot(doc, page, { id: 1, ...base.box }, makeMap(vp1, "orig"), new Map());
    check("a SOLID box saved: the /AP has no dash pattern", dashOp(apText(doc, page)), ["[] 0 d"]);
    const reopened = await PDFDocument.load(await doc.save());
    const payload = JSON.parse(reopened.context.lookup(reopened.getPages()[0].node.Annots().get(0)).get(NABU_DATA).decodeText());
    check("a SOLID box saved: /NabuData has no dash key", "dash" in payload, false);
    check("…and reopens with no dash property at all", "dash" in deserializeManaged(payload, null), false);
  }
  // reading: old files, junk, and kinds that cannot carry a pattern
  check("deserialize: a payload without dash → no property (a file from before line styles)",
    "dash" in deserializeManaged({ k: "ellipse", color: "#f00", width: 2, x: 1, y: 1, w: 9, h: 9 }, null), false);
  check("deserialize: a junk dash value → solid (no property)",
    "dash" in deserializeManaged({ k: "box", color: "#f00", width: 2, x: 1, y: 1, w: 9, h: 9, dash: "wavy" }, null), false);
  check("deserialize: a cloud ignores a stray dash key",
    "dash" in deserializeManaged({ k: "cloud", color: "#f00", width: 2, x: 1, y: 1, w: 90, h: 90, dash: "dash" }, null), false);
  check("deserialize: an arrow restores dot",
    deserializeManaged({ k: "arrow", x1: 1, y1: 1, x2: 50, y2: 5, color: "#f00", width: 2, dash: "dot" }, null).dash, "dot");

  // -- the flatten fallback (drawOneAnnot)
  {
    const { doc, page, vp1 } = await makePage(0);
    await drawOneAnnot(doc, page, { ...base.box, dash: "dash" }, makeMap(vp1, "orig"));
    check("flatten box: dashed → [8 6] 0 d", pageOps(page).includes("[8 6] 0 d"), true);
  }
  {
    const { doc, page, vp1 } = await makePage(0);
    await drawOneAnnot(doc, page, { ...base.ellipse, dash: "dot" }, makeMap(vp1, "orig"));
    check("flatten ellipse: dotted → [0.01 4] 0 d and a round cap", [pageOps(page).includes("[0.01 4] 0 d"), pageOps(page).includes("1 J")], [true, true]);
  }
  {
    // solid flatten must still be what it was: the empty pattern, no stray cap
    const { doc, page, vp1 } = await makePage(0);
    await drawOneAnnot(doc, page, base.box, makeMap(vp1, "orig"));
    check("flatten box: solid → [] 0 d only", pageOps(page).filter((o) => / d$/.test(o)), ["[] 0 d"]);
  }
  {
    // the arrow dashes its SHAFT only: three lines drawn, exactly one carries the pattern
    const { doc, page, vp1 } = await makePage(0);
    await drawOneAnnot(doc, page, { ...arrow, label: "", dash: "dash" }, makeMap(vp1, "orig"));
    check("flatten arrow: shaft dashed, both head strokes solid", pageOps(page).filter((o) => / d$/.test(o)), ["[8 6] 0 d", "[] 0 d", "[] 0 d"]);
  }
  {
    const { doc, page, vp1 } = await makePage(0);
    await drawOneAnnot(doc, page, { ...arrow, label: "" }, makeMap(vp1, "orig"));
    check("flatten arrow: solid → three solid lines as before", pageOps(page).filter((o) => / d$/.test(o)), ["[] 0 d", "[] 0 d", "[] 0 d"]);
  }
  // freehand: the walker keeps the rhythm across many short segments (the reason it exists)
  {
    const pts = line(100, 1).map((p) => ({ x: p.x + 20, y: 50 }));
    const dashedInk = async (rot) => {
      const { doc, page, vp1 } = await makePage(rot);
      await drawOneAnnot(doc, page, { kind: "draw", pts, color: "#ff0000", width: 2, dash: "dash" }, makeMap(vp1, "orig"));
      return drawnSegments(pageOps(page));
    };
    const s0 = await dashedInk(0);
    const sum0 = s0.reduce((t, q) => t + segLen(q), 0);
    near("flatten draw: 100 one-point segments dashed @[8,6] still carry 58pt of ink", sum0, 58, 0.01);
    // pieces are cut at every vertex (1pt each here), so count the DASHES: runs of touching pieces
    let dashes = 0;
    s0.forEach((q, i) => { if (i === 0 || Math.hypot(q[0][0] - s0[i - 1][1][0], q[0][1] - s0[i - 1][1][1]) > 1e-6) dashes++; });
    check("…forming 8 dashes with 7 gaps (the pattern did not restart per segment)", dashes, 8);
    const solidPieces = drawnSegments(await (async () => {
      const { doc, page, vp1 } = await makePage(0);
      await drawOneAnnot(doc, page, { kind: "draw", pts, color: "#ff0000", width: 2 }, makeMap(vp1, "orig"));
      return pageOps(page);
    })());
    check("…while solid still draws one drawLine per segment, as before", solidPieces.length, 100);
    // rotation: ink is rigid — the same total on a /Rotate page
    for (const rot of [90, 180, 270]) {
      const sr = await dashedInk(rot);
      near(`flatten draw on a /Rotate ${rot} page carries the same 58pt of ink`, sr.reduce((t, q) => t + segLen(q), 0), 58, 0.01);
    }
  }
  {
    // hình tự do, closed: the closing edge is part of the walk
    const { doc, page, vp1 } = await makePage(0);
    await drawOneAnnot(doc, page, { ...base.poly, dash: "dash" }, makeMap(vp1, "orig"));
    const segs = drawnSegments(pageOps(page));
    const perimeter = [[10, 10, 90, 20], [90, 20, 50, 70], [50, 70, 10, 10]].reduce((t, [a, b, c, d]) => t + Math.hypot(c - a, d - b), 0);
    const on = segs.reduce((t, q) => t + segLen(q), 0);
    check("flatten poly: dashed ink is strictly between 0 and the whole perimeter", on > 0 && on < perimeter, true);
    near("…and is ≈ 4/7 of it (8 on of every 14)", on / perimeter, 8 / 14, 0.08);
  }

  // ---- 5. wiring pins ---------------------------------------------------------------
  const editor = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");
  const bake = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor-bake.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const i18n = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
  const help = fs.readFileSync(path.join(__dirname, "..", "renderer", "help.js"), "utf8");
  const body = (src, name) => {
    const at = src.indexOf("function " + name + "(");
    if (at < 0) throw new Error(`function ${name} not found — renamed?`);
    const open = src.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1).replace(/^\s*\/\/.*$/gm, "");
    }
    throw new Error("unbalanced " + name);
  };

  // the arrow PNG: scaled with the supersample, round/butt per style, and CLEARED before anything else strokes
  const png = body(bake, "renderArrowPng");
  check("renderArrowPng sets the dash scaled by RS", /setLineDash\(dsAr\.array\.map\(\(v\) => v \* RS\)\)/.test(png), true);
  check("renderArrowPng takes its cap from the style", /cx\.lineCap = dsAr\.cap/.test(png), true);
  check("renderArrowPng clears the dash straight after the shaft", /cx\.stroke\(\);\s*if \(dsAr\) cx\.setLineDash\(\[\]\)/.test(png), true);
  check("the dash is set BEFORE the shaft's stroke()", png.indexOf("setLineDash(dsAr") < png.indexOf("cx.stroke()"), true);

  // the overlay: the four SVG kinds go through applyDashSvg, the two CSS-bordered ones through appendDashedOutline
  const ra = body(editor, "renderAnnot");
  check("renderAnnot: draw / poly / arrow call applyDashSvg", (ra.match(/applyDashSvg\(/g) || []).length, 3);
  check("renderAnnot: box and ellipse try the dashed outline first, keeping the border for solid",
    (ra.match(/if \(!appendDashedOutline\(el, a\)\) el\.style\.border/g) || []).length, 2);
  const ads = body(editor, "applyDashSvg");
  check("applyDashSvg is a no-op for solid", /if \(!ds\) return;/.test(ads), true);
  check("applyDashSvg takes the cap from the spec (not a literal)", /ds\.cap/.test(ads), true);
  const ado = body(editor, "appendDashedOutline");
  check("the dashed outline passes through applyDashSvg", /applyDashSvg\(shape, a\)/.test(ado), true);
  // Measured on the real app (width 1, model width never changed): a CENTRED anti-aliased stroke
  // spreads over 2 rows (and +25/+50% ink at 125/150%) where the solid CSS border is one crisp
  // row. Inset by half a pen + crispEdges matches it exactly at 100/125/150/200%. BI-94.
  check("a dashed BOX is inset by half a pen (where the CSS border sits)",
    /"x", String\(lw \/ 2\)/.test(ado) && /"y", String\(lw \/ 2\)/.test(ado) &&
    /Math\.max\(0\.01, w - lw\)/.test(ado) && /Math\.max\(0\.01, h - lw\)/.test(ado), true);
  check("…and un-anti-aliased (crispEdges)", /"shape-rendering", "crispEdges"/.test(ado), true);
  // crispEdges belongs to the rect branch only: on an oval it aliases the curve into stair-steps
  const ellipseBranch = ado.slice(ado.indexOf('a.kind === "ellipse"'), ado.indexOf("} else {"));
  check("the OVAL branch never gets crispEdges", /crispEdges/.test(ellipseBranch), false);
  check("the oval stays centred (cx/cy = half the box, rx/ry = half the box)",
    /"cx", String\(w \/ 2\)/.test(ellipseBranch) && /"rx", String\(w \/ 2\)/.test(ellipseBranch), true);
  check("the stroke width is the model's width, floored at 1 like the CSS border", /"stroke-width", String\(lw\)/.test(ado) && /const lw = Math\.max\(1, a\.width \|\| 2\)/.test(ado), true);
  check("stampDash writes nothing for solid", /ed\.dash !== "solid"/.test(body(editor, "stampDash")), true);
  check("stampDash is called at all four creation sites", (editor.match(/stampDash\(a\);/g) || []).length, 4);

  // palette: exactly the five dashable kinds, in BOTH maps, and no other kind
  const block = (name) => {
    const at = editor.indexOf("const " + name + " = {");
    const open = editor.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < editor.length; i++) {
      if (editor[i] === "{") depth++;
      else if (editor[i] === "}" && --depth === 0) return editor.slice(open, i + 1).replace(/^\s*\/\/.*$/gm, "");
    }
    throw new Error("unbalanced " + name);
  };
  for (const name of ["TOOL_CTLS", "KIND_CTLS"]) {
    const b = block(name);
    const withDash = [...b.matchAll(/^\s*(\w+): \[([^\]]*)\],?$/gm)].filter((m) => /"dash"/.test(m[2])).map((m) => m[1]).sort();
    check(`${name}: "dash" is offered for exactly the five dashable kinds`, withDash, ["arrow", "box", "draw", "ellipse", "poly"]);
  }

  // markup + i18n
  check("index.html has the Kiểu nét select with the three values normDash accepts",
    /<select id="ed-dash">\s*<option value="solid">Liền<\/option>\s*<option value="dash">Nét đứt<\/option>\s*<option value="dot">Chấm<\/option>\s*<\/select>/.test(html), true);
  check("…inside a data-ctl=\"dash\" label (so syncCtlVisibility can show/hide it)", /data-ctl="dash"[^>]*>Kiểu nét\s*<select id="ed-dash">/.test(html), true);
  check("editor.js wires #ed-dash", editor.includes('$("ed-dash").onchange'), true);
  check("choosing Liền REMOVES the key instead of writing \"solid\"", /ed\.dash === "solid"\) delete a\.dash/.test(editor), true);
  check("the dash change is ONE undo step, coalesced per object", /pushEdUndo\("dash:" \+ ed\.sel\)/.test(editor), true);
  check("setTool re-points the box at the next stroke's style", /dpick\.value = ed\.dash/.test(editor), true);
  check("selecting an object shows ITS style", /DASH_KINDS\.has\(a\.kind\)\) \$\("ed-dash"\)\.value = normDash\(a\.dash\)/.test(editor), true);
  check("the default is session-only (no localStorage key for it)", /dash: "solid"/.test(editor) && !/nabu-annot-dash/.test(editor), true);
  for (const key of ["Kiểu nét", "Liền", "Nét đứt", "Chấm",
    "Kiểu nét: liền, nét đứt hoặc chấm — áp cho hình đang chọn và các hình vẽ sau"]) {
    check(`i18n has "${key.slice(0, 24)}…"`, i18n.includes('"' + key + '"'), true);
    check(`index.html uses "${key.slice(0, 24)}…"`, html.includes(key), true);
  }
  check("help documents Kiểu nét", help.includes("**Kiểu nét**") && help.includes("**Line style**"), true);
  // no 'dash' for the kinds that have none
  check("a cloud selection does not offer Kiểu nét", !/cloud: \[[^\]]*"dash"/.test(block("KIND_CTLS")), true);

  console.log(`\nannot-dash: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASH", e);
  process.exit(1);
});
