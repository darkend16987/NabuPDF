"use strict";

// Regression net for Thứ tự chồng (z-order) — BI-93.
//
// The design has no `z` field: an annotation's stacking order IS its index in
// `ed.annots[page]`. That is what makes the feature small, and also what makes it easy to
// break without any error — so this grid pins the three links of the chain separately:
//   1. reorderZ (annot-geom.js)  — the pure move: four ops, groups, edges, no mutation;
//   2. the WRITER — addManagedAnnot appends to /Annots in the order it is called, and a
//      save → load round trip keeps that order (this is what importManaged reads back);
//   3. the WIRING in editor.js — context-menu entries, the keyboard chord, Alt+click,
//      the undo step, in-place splice — pinned on the source, because editor.js cannot
//      run here (DOM). A pin that goes red after a rename is a signal to look, not to
//      "fix the regex".
//
// Run:  node desktop/test/annot-zorder.test.js     (or: npm run test:zorder)

const fs = require("fs");
const path = require("path");
const PDFLib = require("pdf-lib");
const { PDFDocument, rgb, PDFName, PDFDict, PDFRawStream, PDFHexString, degrees } = PDFLib;
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const G = require("../renderer/annot-geom.js");
const { reorderZ } = G;
const Z_OPS = ["front", "forward", "backward", "back"];

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

// ---- 1. reorderZ ----------------------------------------------------------

const L = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((a) => a.id);
const R = (list, sel, op) => ids(reorderZ(L(...list), sel, op));

check("Z_OPS names the four operations", Z_OPS, ["front", "forward", "backward", "back"]);

// single object, every op, every position of a 4-deep stack [1 2 3 4] (4 = topmost)
check("front: bottom → top", R([1, 2, 3, 4], [1], "front"), [2, 3, 4, 1]);
check("front: middle → top", R([1, 2, 3, 4], [2], "front"), [1, 3, 4, 2]);
check("back: top → bottom", R([1, 2, 3, 4], [4], "back"), [4, 1, 2, 3]);
check("back: middle → bottom", R([1, 2, 3, 4], [3], "back"), [3, 1, 2, 4]);
check("forward: one slot up", R([1, 2, 3, 4], [2], "forward"), [1, 3, 2, 4]);
check("backward: one slot down", R([1, 2, 3, 4], [3], "backward"), [1, 3, 2, 4]);
check("forward: bottom → one up", R([1, 2, 3, 4], [1], "forward"), [2, 1, 3, 4]);
check("backward: top → one down", R([1, 2, 3, 4], [4], "backward"), [1, 2, 4, 3]);

// edges are no-ops — the caller relies on "same order" meaning "record no undo step"
check("front on the topmost changes nothing", R([1, 2, 3], [3], "front"), [1, 2, 3]);
check("forward on the topmost changes nothing", R([1, 2, 3], [3], "forward"), [1, 2, 3]);
check("back on the bottom changes nothing", R([1, 2, 3], [1], "back"), [1, 2, 3]);
check("backward on the bottom changes nothing", R([1, 2, 3], [1], "backward"), [1, 2, 3]);

// groups keep their internal order, and move as a block
check("group front keeps internal order", R([1, 2, 3, 4, 5], [2, 4], "front"), [1, 3, 5, 2, 4]);
check("group back keeps internal order", R([1, 2, 3, 4, 5], [2, 4], "back"), [2, 4, 1, 3, 5]);
check("selection ORDER does not matter, page order does", R([1, 2, 3, 4, 5], [4, 2], "front"), [1, 3, 5, 2, 4]);
check("group forward: each member steps over its nearest unselected neighbour",
  R([1, 2, 3, 4, 5], [2, 4], "forward"), [1, 3, 2, 5, 4]);
check("group backward", R([1, 2, 3, 4, 5], [2, 4], "backward"), [2, 1, 4, 3, 5]);
check("adjacent group forward moves as a block, not a cascade",
  R([1, 2, 3, 4, 5], [2, 3], "forward"), [1, 4, 2, 3, 5]);
check("adjacent group at the top stays put", R([1, 2, 3, 4], [3, 4], "forward"), [1, 2, 3, 4]);
check("adjacent group backward as a block", R([1, 2, 3, 4, 5], [3, 4], "backward"), [1, 3, 4, 2, 5]);

// degenerate input
check("no selection → unchanged", R([1, 2, 3], [], "front"), [1, 2, 3]);
check("unknown id → unchanged", R([1, 2, 3], [99], "front"), [1, 2, 3]);
check("empty page → empty", R([], [1], "front"), []);
check("single object page → unchanged", R([7], [7], "back"), [7]);
check("unknown op → unchanged (no throw)", R([1, 2, 3], [1], "sideways"), [1, 2, 3]);

// pure: the input list is never touched, and the result is a different array
{
  const src = L(1, 2, 3);
  const out = reorderZ(src, [1], "front");
  check("input array is not mutated", ids(src), [1, 2, 3]);
  check("result is a fresh array", out === src, false);
  check("objects are the same references (no cloning)", out[2] === src[0], true);
}

// property: for every op and every non-empty subset of a 5-stack, the result is a
// permutation, and the selected objects keep their relative order
{
  const base = [1, 2, 3, 4, 5];
  let bad = 0;
  for (let mask = 1; mask < 1 << 5; mask++) {
    const sel = base.filter((_, k) => mask & (1 << k));
    for (const op of Z_OPS) {
      const out = R(base, sel, op);
      const perm = out.slice().sort().join() === base.join();
      const rel = out.filter((x) => sel.includes(x)).join() === sel.join();
      if (!perm || !rel) bad++;
    }
  }
  check("every op × every subset: a permutation that keeps the selection's relative order", bad, 0);
}

// ---- 2. the writer: /Annots order survives bake AND save → load ----------------

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

// The same module-scope names annot-rotate.test.js gives the lifted addManagedAnnot.
const { cloudPath, cloudPathPoly, bumpOf, symbolStrokes, arrowLabelPos,
  TEXTHL_OPACITY, isPtsKind, isQuadKind, polyPath, quadsFromRects, scalePts } = G;
const {
  makeMap, pageRotate, sniffImage, strToBytes, serializeManaged, pushPageAnnot,
  normAngle, apRotatable, apMatrixFor, apRectFor, shapeAppearance, isVectorKind,
  NABU_KIND, NABU_DATA, NABU_SRC,
} = require("../renderer/managed-codec.js");
const { normTextStyle } = require("../renderer/annot-text.js");
// eslint-disable-next-line no-unused-vars
const { b64ToU8 } = require("../renderer/wire.js");
const SYMBOL_KINDS = new Set(["check", "cross"]);
const renderTextPng = () => { throw new Error("canvas-backed kinds are not driven here"); };
const renderArrowPng = renderTextPng;
const noteThreadText = renderTextPng;
// eslint-disable-next-line no-eval
const lift = (name) => eval("(" + fnSource(name) + ")");
const hexRgb = lift("hexRgb");
const dataUrlToBytes = lift("dataUrlToBytes");
const addManagedAnnot = lift("addManagedAnnot");
const f = (n) => (+n).toFixed(2);

// What importManaged reads: each Nabu annotation's /NabuData kind, in /Annots order.
function annotKinds(doc) {
  const out = [];
  const arr = doc.getPages()[0].node.Annots();
  for (let j = 0; arr && j < arr.size(); j++) {
    const dict = doc.context.lookup(arr.get(j));
    if (!(dict instanceof PDFDict) || !dict.get(NABU_KIND)) continue;
    out.push(JSON.parse(dict.get(NABU_DATA).decodeText()).k);
  }
  return out;
}

async function bakeInOrder(annots) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const pdf = await pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false }).promise;
  const vp1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const share = new Map();
  for (const a of annots) {
    const ok = await addManagedAnnot(doc, page, a, makeMap(vp1, "orig"), share);
    if (ok !== true) throw new Error("expected a managed (vector) annotation for " + a.kind);
  }
  return doc;
}

(async () => {
  // Three vector kinds, each recognisable by its serialised kind, created in this order.
  const mk = () => [
    { id: 1, kind: "box", x: 20, y: 20, w: 100, h: 60, color: "#ff0000", width: 2 },
    { id: 2, kind: "ellipse", x: 40, y: 40, w: 100, h: 60, color: "#00aa00", width: 2 },
    { id: 3, kind: "cloud", x: 60, y: 60, w: 100, h: 60, color: "#0000ff", width: 2 },
  ];

  const first = await bakeInOrder(mk());
  check("bake writes /Annots in creation order", annotKinds(first), ["box", "ellipse", "cloud"]);

  // send the box (bottom) to the front, then bake the REORDERED array
  const moved = reorderZ(mk(), [1], "front");
  const second = await bakeInOrder(moved);
  check("after reorderZ the bake follows the new order", annotKinds(second), ["ellipse", "cloud", "box"]);

  // save → load: the order importManaged will see in a reopened file
  const reopened = await PDFDocument.load(await second.save());
  check("the order survives save → load", annotKinds(reopened), ["ellipse", "cloud", "box"]);

  // and a second reorder on top of that round trip
  const again = reorderZ(
    [{ id: 2, kind: "ellipse", x: 40, y: 40, w: 100, h: 60, color: "#00aa00", width: 2 },
     { id: 3, kind: "cloud", x: 60, y: 60, w: 100, h: 60, color: "#0000ff", width: 2 },
     { id: 1, kind: "box", x: 20, y: 20, w: 100, h: 60, color: "#ff0000", width: 2 }],
    [1], "backward");
  check("backward from the front lands in the middle",
    annotKinds(await bakeInOrder(again)), ["ellipse", "box", "cloud"]);

  // ---- 3. wiring pins on editor.js / i18n / help --------------------------------
  const editor = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");
  const i18n = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
  const help = fs.readFileSync(path.join(__dirname, "..", "renderer", "help.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");

  const body = (name) => {
    const at = editor.indexOf("function " + name + "(");
    if (at < 0) throw new Error(`function ${name} not found in editor.js — renamed?`);
    const open = editor.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < editor.length; i++) {
      if (editor[i] === "{") depth++;
      else if (editor[i] === "}" && --depth === 0) return editor.slice(open, i + 1).replace(/^\s*\/\/.*$/gm, "");
    }
    throw new Error("unbalanced " + name);
  };

  const rs = body("reorderSelected");
  check("reorderSelected records an undo step BEFORE it mutates",
    rs.indexOf("pushEdUndo()") > -1 && rs.indexOf("pushEdUndo()") < rs.indexOf("splice("), true);
  check("reorderSelected reorders IN PLACE (splice), not by swapping the array", /\.splice\(0,/.test(rs), true);
  check("reorderSelected refuses mid-drag (the edUndo rule)", /if \(drag\) return false/.test(rs), true);
  check("reorderSelected skips the undo step when nothing would move", /if \(!plan\) return false/.test(rs), true);
  const zp = body("zPlan");
  check("zPlan compares against the current order", /some\(\(a, k\) => a !== cur\[k\]\)/.test(zp), true);
  check("zPlan reorders the page the PRIMARY selection is on", /findAnnot\(ed\.sel\)/.test(zp), true);

  // the four menu entries, each wired to its own op
  const menu = [
    ["Đưa lên trên cùng", "front"],
    ["Đưa lên một lớp", "forward"],
    ["Đưa xuống một lớp", "backward"],
    ["Đưa xuống dưới cùng", "back"],
  ];
  for (const [label, op] of menu) {
    check(`menu entry "${label}" runs op "${op}"`,
      editor.includes(`tr("${label}"), enabled: !!zPlan("${op}"), onClick: () => reorderSelected("${op}")`), true);
    check(`i18n has "${label}"`, i18n.includes(`"${label}":`), true);
  }

  // the chord goes by physical key and honours the same guards as the other shortcuts
  check("chord reads e.code (layout-proof)", /e\.code === "BracketRight" \|\| e\.code === "BracketLeft"/.test(editor), true);
  check("chord is skipped while typing", /!e\.altKey && !typing && !e\.repeat && ed\.sel != null/.test(editor), true);
  check("Shift selects the ends (front/back)", /e\.shiftKey \? \(up \? "front" : "back"\) : \(up \? "forward" : "backward"\)/.test(editor), true);

  // Alt+click is select-tool only and only when there is something to cycle through
  const od = body("onDown");
  check("Alt+click digging is gated on the select tool", /ed\.tool === "select" && e\.altKey && anEl/.test(od), true);
  const pu = body("pickUnder");
  check("pickUnder skips the watermark and other pages", /dataset\.kind !== "watermark"/.test(pu) && /layer\.contains\(an\)/.test(pu), true);
  check("pickUnder needs ≥2 overlapping objects", /stack\.length < 2/.test(pu), true);

  // no bar buttons: BI-41 (the edit bar has no spare width). If a button is ever added it
  // must be in KIND_CTLS and measured against the BI-41 table — fail loudly so someone looks.
  check("no palette row was added for z-order (BI-41)", /data-ctl="zorder"/.test(html), false);

  check("help documents the chord and Alt+click", help.includes("Ctrl+]") && help.includes("Alt+click"), true);

  console.log(`\nannot-zorder: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASH", e);
  process.exit(1);
});
