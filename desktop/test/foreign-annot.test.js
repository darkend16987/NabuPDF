"use strict";

// Regression net for "another program's shapes are editable, and left alone when not edited" —
// BI-100, renderer/foreign-annot.js + its use in editor-bake.js (Đợt 3b of
// docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md).
//
//   1. readForeign: every rule that leaves an annotation alone (N3) — each one is a real way the
//      Nabu copy would say something different from the partner's original;
//   2. toObjects: the mapping per subtype, on a plain and on a /Rotate 90 page (real pdf.js
//      viewports — the same mapping the bake writes back through);
//   3. planForeign: N1 decided by VALUE (move-and-back = untouched; a paste does not disturb the
//      original; multi-stroke Ink is one original);
//   4. removeOriginal (N2): only the exact annotation goes, with its /Popup; a shared appearance
//      survives; anything that no longer matches is refused;
//   5. END TO END through the SHIPPED editor-bake.js (vm sandbox, real pdf-lib + real pdf.js,
//      the real codec): import an Acrobat-style file, bake without touching → every partner
//      annotation is the same object, unchanged; move / recolour / delete → exactly those
//      originals are replaced (author + comment kept) or gone, the rest untouched; re-import
//      reads the edited ones back at the same place, also on the rotated page.
//
// Run:  node desktop/test/foreign-annot.test.js      (or: npm run test:foreign)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const PDFLib = require("pdf-lib");
const { PDFDocument, PDFName, PDFString, PDFHexString, PDFDict, PDFRef, PDFArray } = PDFLib;
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const FA = require("../renderer/foreign-annot.js");

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
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const R = path.join(__dirname, "..", "renderer");

// ---- fixture: an Acrobat-style file ---------------------------------------------------------

async function makeFixture() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const p1 = doc.addPage([600, 800]);
  const p2 = doc.addPage([600, 800]);
  p2.node.set(PDFName.of("Rotate"), ctx.obj(90));
  const ap = (ops) => ctx.register(ctx.stream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] }));
  const S = (s) => PDFHexString.fromText(s);
  const reg = (d) => ctx.register(ctx.obj(d));
  const base = (sub, rect, nm, extra) => Object.assign({ Type: "Annot", Subtype: sub, Rect: rect, F: 4, C: [1, 0, 0], NM: S(nm), T: S("hang_"), AP: { N: ap("0 0 1 1 re S") } }, extra || {});
  const R1 = {};
  R1.cloud = reg(base("Square", [100, 600, 220, 680], "sq-cloud", { RD: [5, 5, 5, 5], BE: { S: "C", I: 1 }, Contents: S("Sửa chỗ này") }));
  R1.popup = reg({ Type: "Annot", Subtype: "Popup", Rect: [300, 600, 400, 700], Parent: R1.cloud, Open: false });
  ctx.lookup(R1.cloud).set(PDFName.of("Popup"), R1.popup);
  R1.square = reg(base("Square", [300, 600, 400, 660], "sq-plain", { BS: { W: 2, S: "D" }, IC: [1, 1, 0] }));
  R1.circle = reg(base("Circle", [420, 600, 500, 660], "circ"));
  R1.arrow = reg(base("Line", [99, 499, 301, 551], "ln-arrow", { L: [100, 500, 300, 550], LE: ["None", "OpenArrow"], IT: "LineArrow" }));
  R1.arrowRev = reg(base("Line", [99, 449, 301, 471], "ln-rev", { L: [100, 450, 300, 470], LE: ["ClosedArrow", "None"] }));
  R1.line = reg(base("Line", [99, 399, 201, 451], "ln-plain", { L: [100, 400, 200, 450] }));
  R1.ink = reg(base("Ink", [50, 100, 250, 200], "ink-2", { InkList: [[60, 110, 80, 130, 100, 120], [150, 150, 200, 190]] }));
  R1.ink3 = reg(base("Ink", [50, 250, 250, 300], "ink-3", { InkList: [[60, 260, 80, 280], [150, 260, 200, 290]] }));
  R1.polygon = reg(base("Polygon", [300, 100, 400, 200], "pgon", { Vertices: [300, 100, 400, 100, 350, 200], IC: [0, 0, 1] }));
  R1.cloudPoly = reg(base("Polygon", [420, 100, 520, 200], "pgon-cloud", { Vertices: [420, 100, 520, 100, 470, 200], IT: "PolygonCloud" }));
  R1.polyline = reg(base("PolyLine", [300, 250, 400, 300], "pline", { Vertices: [300, 250, 350, 300, 400, 250], IC: [0, 1, 0] }));
  // ---- the ones that must be LEFT ALONE
  const left = {};
  left.translucent = reg(base("Square", [10, 10, 40, 40], "x-ca", { CA: 0.5 }));
  left.locked = reg(base("Square", [50, 10, 80, 40], "x-lock", { F: 4 | 128 }));
  left.bothEnds = reg(base("Line", [90, 10, 120, 40], "x-both", { L: [90, 10, 120, 40], LE: ["OpenArrow", "OpenArrow"] }));
  left.dimension = reg(base("Line", [130, 10, 160, 40], "x-dim", { L: [130, 10, 160, 40], IT: "LineDimension" }));
  left.cloudCircle = reg(base("Circle", [170, 10, 200, 40], "x-cc", { BE: { S: "C", I: 1 } }));
  left.noColor = reg(Object.assign(base("Square", [210, 10, 240, 40], "x-noc"), {}));
  ctx.lookup(left.noColor).delete(PDFName.of("C"));
  left.zero = reg(base("Square", [250, 10, 280, 40], "x-zero", { BS: { W: 0 } }));
  left.parent = reg(base("Square", [290, 10, 320, 40], "x-parent"));
  left.reply = reg({ Type: "Annot", Subtype: "Text", Rect: [290, 50, 310, 70], IRT: left.parent, Contents: S("đồng ý"), T: S("tuyetpta") });
  left.freetext = reg(base("FreeText", [330, 10, 380, 40], "x-ft", { Contents: S("hello"), DA: PDFString.of("/Helv 10 Tf 0 g") }));
  left.oc = reg(base("Square", [390, 10, 420, 40], "x-oc", { OC: ctx.obj({ Type: "OCG", Name: S("Layer") }) }));
  const inline = ctx.obj(base("Square", [430, 10, 460, 40], "x-inline"));
  p1.node.set(PDFName.of("Annots"), ctx.obj([...Object.values(R1), ...Object.values(left), inline]));
  // page 2, /Rotate 90
  const R2 = {};
  R2.square = reg(base("Square", [100, 100, 300, 200], "rot-sq"));
  R2.line = reg(base("Line", [99, 299, 301, 401], "rot-ln", { L: [100, 300, 300, 400] }));
  p2.node.set(PDFName.of("Annots"), ctx.obj(Object.values(R2)));
  return { bytes: await doc.save(), R1, R2, left };
}

(async () => {
  const fx = await makeFixture();
  const doc = await PDFDocument.load(fx.bytes, { updateMetadata: false });
  const targets = FA.replyTargets(PDFLib, doc);
  const annotsOf = (d, i) => {
    const arr = d.getPages()[i].node.Annots();
    return arr ? arr.asArray() : [];
  };
  const recOf = (raw) => FA.readForeign(PDFLib, doc, raw, doc.context.lookup(raw), targets);
  const byNm = new Map();
  for (const raw of annotsOf(doc, 0).concat(annotsOf(doc, 1))) {
    const d = doc.context.lookup(raw);
    const nm = d.lookup(PDFName.of("NM"));
    if (nm) byNm.set(nm.decodeText(), raw);
  }

  // ---- 1. readForeign: what is left alone, and why ------------------------------------------
  const why = (nm) => recOf(byNm.get(nm)).skip || "imported";
  check("translucent (/CA 0.5) → left alone: a Nabu shape has no stroke opacity", why("x-ca"), "opacity");
  check("Locked flag → left alone", why("x-lock"), "flags");
  check("Line with arrowheads at BOTH ends → left alone (Nabu arrow has one head)",
    FA.toObjects(recOf(byNm.get("x-both")), (x, y) => [x, y]).skip, "line-ends");
  check("dimension line → left alone", why("x-dim"), "dimension");
  check("cloudy circle → left alone (Nabu clouds are boxes / polygons)", why("x-cc"), "cloudy-circle");
  check("no /C → left alone (no colour to stroke with)", why("x-noc"), "no-color");
  check("zero-width border → left alone (Nabu reads width 0 as 2)", why("x-zero"), "no-border");
  check("an annotation someone REPLIED to → left alone (removing it would orphan the thread)", why("x-parent"), "has-replies");
  check("optional content (layer) → left alone", why("x-oc"), "optional-content");
  check("FreeText → not this wave (group A keeps its own type, Đợt 3c)", why("x-ft"), "subtype");
  const inlineRaw = annotsOf(doc, 0).find((r) => !(r instanceof PDFRef));
  check("inline annotation dict → left alone (no object number to find it by, N2)",
    FA.readForeign(PDFLib, doc, inlineRaw, inlineRaw, targets).skip, "inline");
  check("the reply itself (/IRT) → left alone", FA.readForeign(PDFLib, doc, fx.left.reply, doc.context.lookup(fx.left.reply), targets).skip, "subtype");
  const nabu = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [0, 0, 1, 1], C: [0, 0, 0], NabuKind: PDFName.of("box") });
  check("a Nabu annotation is never 'foreign'", FA.readForeign(PDFLib, doc, doc.context.register(nabu), nabu, targets).skip, "nabu");

  const cloud = recOf(fx.R1.cloud);
  check("cloudy Square read: colour, width default 1, /RD, cloudy, kept author + comment + NM",
    [cloud.color, cloud.width, cloud.rd, cloud.cloudy, cloud.keep],
    ["#ff0000", 1, [5, 5, 5, 5], true, { T: "hang_", Contents: "Sửa chỗ này", NM: "sq-cloud" }]);
  const sq = recOf(fx.R1.square);
  check("plain Square read: /BS /W 2 dashed, /IC fill", [sq.width, sq.dashed, sq.fill, sq.cloudy], [2, true, "#ffff00", false]);

  // ---- 2. toObjects ----------------------------------------------------------------------------
  const pdf = await pdfjs.getDocument({ data: fx.bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const vp0 = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const vp90 = (await pdf.getPage(2)).getViewport({ scale: 1 });
  const tv = (vp) => (x, y) => vp.convertToViewportPoint(x, y);
  const objs = (raw, vp = vp0) => FA.toObjects(recOf(raw), tv(vp));
  const r2 = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)));
  check("cloudy Square → cloud on the path inside /RD (view space: y from the top)",
    r2(objs(fx.R1.cloud)), [{ kind: "cloud", x: 105, y: 125, w: 110, h: 70, color: "#ff0000", width: 1 }]);
  check("Square without /RD → box inset by half the border, dash + fill kept",
    r2(objs(fx.R1.square)), [{ kind: "box", x: 301, y: 141, w: 98, h: 58, color: "#ff0000", width: 2, fill: "#ffff00", fillOpacity: 1, dash: "dash" }]);
  check("Circle → ellipse", objs(fx.R1.circle)[0].kind, "ellipse");
  check("Line LE [None OpenArrow] → arrow, head at the END point",
    r2(objs(fx.R1.arrow)), [{ kind: "arrow", x1: 100, y1: 300, x2: 300, y2: 250, labelEnd: "head", color: "#ff0000", width: 1 }]);
  check("Line LE [ClosedArrow None] → arrow, head at the START point",
    r2(objs(fx.R1.arrowRev)).map((o) => [o.x1, o.y1, o.x2, o.y2]), [[300, 330, 100, 350]]);
  check("Line without heads → open 2-point poly (Nabu has no plain-line kind)",
    r2(objs(fx.R1.line)), [{ kind: "poly", pts: [{ x: 100, y: 400 }, { x: 200, y: 350 }], closed: false, color: "#ff0000", width: 1 }]);
  check("Ink with 2 strokes → 2 draw objects", objs(fx.R1.ink).map((o) => [o.kind, o.pts.length]), [["draw", 3], ["draw", 2]]);
  check("Polygon → closed poly with fill", (() => { const o = objs(fx.R1.polygon)[0]; return [o.kind, o.closed, o.fill, o.pts.length]; })(), ["poly", true, "#0000ff", 3]);
  check("PolygonCloud → cloudpen", objs(fx.R1.cloudPoly)[0].kind, "cloudpen");
  check("PolyLine → OPEN poly, and its /IC (line-ending colour) is NOT a fill", (() => { const o = objs(fx.R1.polyline)[0]; return [o.closed, o.fill]; })(), [false, undefined]);
  const rsq = r2(objs(fx.R2.square, vp90))[0];
  check("on a /Rotate 90 page the box is mapped through the rotated viewport (w/h swap)",
    [rsq.kind, rsq.w, rsq.h], ["box", 99, 199]);

  // ---- 3. planForeign ---------------------------------------------------------------------------
  const sig = (a) => JSON.stringify([a.kind, a.x, a.y, a.pts]);
  const mk = (id, key, x) => ({ id, kind: "box", x, y: 0, _foreign: { fileRef: key } });
  const E = (key, page, sigs, hideId) => ({ key, page, sigs, hideId });
  {
    const a = mk(1, "5 0 R", 10);
    const entries = [E("5 0 R", 0, [sig(a)], "5R")];
    let p = FA.planForeign(entries, [{ page: 0, a }], sig);
    check("untouched → skipped by the bake, original kept, nothing removed", [[...p.skipIds], [...p.keepIds], p.remove.length], [[1], ["5R"], 0]);
    a.x = 20;
    p = FA.planForeign(entries, [{ page: 0, a }], sig);
    check("moved → original removed, the copy is written", [[...p.skipIds], p.remove.map((e) => e.key)], [[], ["5 0 R"]]);
    a.x = 10;
    check("moved and moved back (undo) → untouched again: decided by value", FA.planForeign(entries, [{ page: 0, a }], sig).remove.length, 0);
    check("deleted → original removed", FA.planForeign(entries, [], sig).remove.map((e) => e.key), ["5 0 R"]);
    check("moved to another page → original removed", FA.planForeign(entries, [{ page: 1, a }], sig).remove.length, 1);
    const twin = mk(2, "5 0 R", 10);
    check("a second object claiming the same original (stray clone) → replace, both get written", FA.planForeign(entries, [{ page: 0, a }, { page: 0, a: twin }], sig).remove.length, 1);
    const s1 = mk(3, "9 0 R", 1), s2 = mk(4, "9 0 R", 2);
    const inkE = [E("9 0 R", 0, [sig(s1), sig(s2)], "9R")];
    check("multi-stroke Ink, both strokes as imported (any order) → untouched", FA.planForeign(inkE, [{ page: 0, a: s2 }, { page: 0, a: s1 }], sig).remove.length, 0);
    check("…one stroke deleted → the original goes, the remaining stroke is written", FA.planForeign(inkE, [{ page: 0, a: s1 }], sig).remove.length, 1);
    s1._foreign.keep = { T: "hang_", NM: "ink-x" };
    s2._foreign.keep = { T: "hang_", NM: "ink-x" };
    s1.x = 50; s2.x = 60;
    const kp = FA.planForeign(inkE, [{ page: 0, a: s2 }, { page: 0, a: s1 }], sig).keepFor;
    check("both strokes of one Ink edited → both written, author on both, the unique /NM on ONE (the first imported)",
      [kp.get(3), kp.get(4)], [{ T: "hang_", NM: "ink-x" }, { T: "hang_" }]);
    check("…and the plan never mutates the objects' own keep", s2._foreign.keep, { T: "hang_", NM: "ink-x" });
    check("objects without _foreign never touch the plan", FA.planForeign(entries, [{ page: 0, a }, { page: 0, a: { id: 9, kind: "box" } }], sig).remove.length, 0);
  }

  // ---- 4. removeOriginal (N2) ---------------------------------------------------------------------
  {
    const d = await PDFDocument.load(fx.bytes, { updateMetadata: false });
    const entry = (raw, over) => Object.assign({ page: 0, num: raw.objectNumber, gen: raw.generationNumber,
      subtype: "Square", rect: [100, 600, 220, 680], nm: "sq-cloud" }, over || {});
    const count = () => d.getPages()[0].node.Annots().size();
    const n0 = count();
    check("refused when /Subtype differs", FA.removeOriginal(PDFLib, d, entry(fx.R1.cloud, { subtype: "Circle" })), false);
    check("refused when /Rect differs (the file moved it since)", FA.removeOriginal(PDFLib, d, entry(fx.R1.cloud, { rect: [100, 600, 221, 680] })), false);
    check("refused when /NM differs (another annotation now at that number)", FA.removeOriginal(PDFLib, d, entry(fx.R1.cloud, { nm: "other" })), false);
    check("refused when the number is not on that page", FA.removeOriginal(PDFLib, d, entry(fx.R1.cloud, { page: 1 })), false);
    check("…and a refusal changes nothing", count(), n0);
    const apRef = d.context.lookup(fx.R1.cloud).lookup(PDFName.of("AP")).get(PDFName.of("N"));
    check("exact match → removed", FA.removeOriginal(PDFLib, d, entry(fx.R1.cloud)), true);
    const left = d.getPages()[0].node.Annots().asArray().map((r) => (r instanceof PDFRef ? r.toString() : "inline"));
    check("…with its /Popup, and nothing else", [count(), left.includes(fx.R1.cloud.toString()), left.includes(fx.R1.popup.toString())], [n0 - 2, false, false]);
    check("…the dict, the popup and its unshared appearance are freed",
      [d.context.lookup(fx.R1.cloud), d.context.lookup(fx.R1.popup), d.context.lookup(apRef)].map((x) => x === undefined), [true, true, true]);
    // a SHARED appearance stream stays for the other annotation that uses it
    const shared = d.context.lookup(fx.R1.circle).lookup(PDFName.of("AP")).get(PDFName.of("N"));
    d.context.lookup(fx.R1.square).lookup(PDFName.of("AP")).set(PDFName.of("N"), shared);
    check("shared appearance: the annotation goes…", FA.removeOriginal(PDFLib, d, entry(fx.R1.circle, { subtype: "Circle", rect: [420, 600, 500, 660], nm: "circ" })), true);
    check("…but the stream another annotation still uses is kept", d.context.lookup(shared) !== undefined, true);
  }

  // ---- 5. applyKeep -------------------------------------------------------------------------------
  {
    const d = await PDFDocument.create();
    const pg = d.addPage([100, 100]);
    const nabuRef = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 1, 1], NabuKind: PDFName.of("box"), Contents: PDFHexString.fromText("nabu") }));
    pg.node.set(PDFName.of("Annots"), d.context.obj([nabuRef]));
    check("applyKeep writes T / NM onto the Nabu annotation just appended", FA.applyKeep(PDFLib, d, pg, { T: "hang_", NM: "sq-cloud", Contents: "partner" }), true);
    const nd = d.context.lookup(nabuRef);
    check("…without overwriting a key Nabu wrote itself", ["T", "NM", "Contents"].map((k) => nd.lookup(PDFName.of(k)).decodeText()), ["hang_", "sq-cloud", "nabu"]);
    const other = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Square", Rect: [0, 0, 1, 1] }));
    pg.node.Annots().push(other);
    check("…and refuses when the last annotation is not a Nabu one", FA.applyKeep(PDFLib, d, pg, { T: "x" }), false);
  }

  // ---- 6. end to end through the shipped editor-bake.js -------------------------------------------
  const EDITOR = fs.readFileSync(path.join(R, "editor.js"), "utf8");
  const sandbox = { console, TextEncoder, TextDecoder, Uint8Array, atob, btoa, setTimeout, clearTimeout, Blob };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => { throw new Error("DOM touched"); } };
  const ctx = vm.createContext(sandbox);
  const run = (file, abs) => vm.runInContext(fs.readFileSync(abs || path.join(R, file), "utf8"), ctx, { filename: file });
  run("pdf-lib.min.js", path.join(R, "vendor", "pdf-lib.min.js"));
  for (const f of ["wire.js", "annot-text.js", "annot-geom.js", "managed-codec.js", "annot-hide.js", "annot-scan.js", "foreign-annot.js", "editor-bake.js"]) run(f);
  const cutFn = (name) => {
    const at = EDITOR.indexOf("  function " + name + "(");
    const open = EDITOR.indexOf("{", EDITOR.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < EDITOR.length; i++) {
      if (EDITOR[i] === "{") depth++;
      else if (EDITOR[i] === "}" && --depth === 0) return EDITOR.slice(at, i + 1);
    }
    throw new Error(name);
  };
  vm.runInContext("const { rgb } = PDFLib;", ctx);
  const real = vm.runInContext("({" + ["hexRgb", "hexToRgba", "dataUrlToBytes", "noteThreadText"].map((n) => `${n}: ${cutFn(n).replace(/^\s*function\s+\w+/, "function")}`).join(", ") + "})", ctx);
  const toasts = [];
  const ed = { annots: {}, watermark: null, seq: 1, _managedPages: new Set(), _taCommit: null, _importedManaged: 0,
               _owned: new Map(), _foreignImported: [], sel: null, _dirty: true, active: true, _exiting: true };
  const api = sandbox.EditorBake.create({
    ed, annotsFor: (i) => (ed.annots[i] = ed.annots[i] || []), hasAny: () => Object.values(ed.annots).some((l) => l.length),
    clearEdHistory() {}, syncOverlays() {}, ...real, SYMBOL_KINDS: new Set(["check", "cross"]),
  });
  Object.assign(sandbox, { toast: (m) => toasts.push(m), showOverlay() {}, hideOverlay() {}, rerenderChanged: async () => {}, pdfjsLib: pdfjs });
  sandbox.window.DocHistory = { pushUndo() {} };
  const openBytes = async (bytes) => {
    sandbox.state = { bytes, numPages: 2, pdf: await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise };
  };
  const reimport = async () => { ed.annots = {}; ed._managedPages = new Set(); return api.importManaged(); };
  const live = () => Object.entries(ed.annots).flatMap(([p, l]) => l.map((a) => ({ page: +p, a })));
  const dictStr = async (bytes) => {
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    const m = new Map();
    for (let i = 0; i < 2; i++) {
      for (const raw of annotsOf(d, i)) {
        const dd = d.context.lookup(raw);
        const nm = dd.lookup(PDFName.of("NM"));
        const t = dd.lookup(PDFName.of("T"));
        const c = dd.lookup(PDFName.of("Contents"));
        m.set((nm ? nm.decodeText() : raw.toString()) + "@" + i, { ref: raw.toString(), str: dd.toString(), nabu: !!dd.get(PDFName.of("NabuKind")),
          sub: String(dd.get(PDFName.of("Subtype"))), T: t ? t.decodeText() : null, C: c ? c.decodeText() : null });
      }
    }
    return m;
  };

  await openBytes(fx.bytes);
  const n = await reimport();
  const kinds = live().map((l) => l.a.kind);
  check("import: 13 partner annotations become overlay objects (each 2-stroke Ink as 2 draws)",
    [n, kinds], [13, ["cloud", "box", "ellipse", "arrow", "arrow", "poly", "draw", "draw", "draw", "draw", "poly", "cloudpen", "poly", "box", "poly"]]);
  check("…15 objects in all, on the right pages", [live().filter((l) => l.page === 0).length, live().filter((l) => l.page === 1).length], [13, 2]);
  check("…each original recorded for the bake, and owned (hidden on screen while editing)",
    [ed._foreignImported.length, (ed._owned.get(0) || []).length, (ed._owned.get(1) || []).length], [13, 11, 2]);
  check("…the copies carry the original's reference and author", live().filter((l) => l.a._foreign.keep.T === "hang_").length, 15);

  // A. bake with NOTHING changed (a Nabu object added elsewhere forces the bake to run)
  const before = await dictStr(fx.bytes);
  ed.annots[1].push({ id: ed.seq++, kind: "box", x: 10, y: 10, w: 20, h: 20, color: "#00ff00", width: 2 });
  check("bake runs", await api.bakePending(), true);
  const afterA = await dictStr(sandbox.state.bytes);
  const partner = [...before.keys()];
  check("A: every partner annotation is still there, at the SAME object number, with the SAME dict",
    partner.filter((k) => !afterA.has(k) || afterA.get(k).ref !== before.get(k).ref || afterA.get(k).str !== before.get(k).str), []);
  check("A: the only Nabu annotation is the new box", [...afterA.values()].filter((v) => v.nabu).length, 1);
  const warns = () => toasts.filter((t) => t !== "Đã áp dụng chỉnh sửa.");
  check("A: no warning", warns(), []);

  // B. move the cloud, recolour the rotated square, delete the plain line, delete one ink stroke
  await openBytes(sandbox.state.bytes);
  await reimport();
  const find = (nm, page = 0) => live().filter((l) => l.page === page && l.a._foreign && l.a._foreign.keep.NM === nm).map((l) => l.a);
  const cloudObj = find("sq-cloud")[0];
  const cloudAt = [cloudObj.x, cloudObj.y, cloudObj.w, cloudObj.h];
  cloudObj.x += 30;
  const rotObj = find("rot-sq", 1)[0];
  const rotAt = [rotObj.x, rotObj.y, rotObj.w, rotObj.h];
  rotObj.color = "#0000ff";
  ed.annots[0] = ed.annots[0].filter((a) => !(a._foreign && a._foreign.keep.NM === "ln-plain"));
  const ink = find("ink-2");
  ed.annots[0] = ed.annots[0].filter((a) => a !== ink[1]);
  for (const a of find("ink-3")) for (const p of a.pts) p.y += 10; // BOTH strokes of the other Ink
  const beforeB = await dictStr(sandbox.state.bytes);
  check("bake runs", await api.bakePending(), true);
  const afterB = await dictStr(sandbox.state.bytes);
  const popupKey = [...beforeB.keys()].find((k) => beforeB.get(k).sub === "/Popup");
  const gone = ["sq-cloud@0", "rot-sq@1", "ln-plain@0", "ink-2@0", "ink-3@0", popupKey];
  check("B: the edited / deleted originals are gone (with the cloud's popup)",
    [gone.map((k) => afterB.has(k) && !afterB.get(k).nabu), [...afterB.values()].some((v) => v.sub === "/Popup")], [[false, false, false, false, false, false], false]);
  check("B: every OTHER partner annotation is byte-for-byte the same dict at the same number",
    [...beforeB.keys()].filter((k) => !gone.includes(k) && !beforeB.get(k).nabu)
      .filter((k) => !afterB.has(k) || afterB.get(k).str !== beforeB.get(k).str || afterB.get(k).ref !== beforeB.get(k).ref), []);
  check("B: the moved cloud, the recoloured square and the kept ink stroke are now Nabu annotations, keeping author + comment + NM",
    ["sq-cloud@0", "rot-sq@1", "ink-2@0"].map((k) => afterB.has(k) && [afterB.get(k).nabu, afterB.get(k).T]), [[true, "hang_"], [true, "hang_"], [true, "hang_"]]);
  check("B: …and the cloud keeps its comment text", afterB.get("sq-cloud@0") && afterB.get("sq-cloud@0").C, "Sửa chỗ này");
  check("B: the plain line is gone entirely", afterB.has("ln-plain@0"), false);
  check("B: no warning", warns(), []);
  {
    const d = await PDFDocument.load(sandbox.state.bytes, { updateMetadata: false });
    const nms = [];
    let draws = 0;
    for (const raw of annotsOf(d, 0)) {
      const x = d.context.lookup(raw);
      if (String(x.get(PDFName.of("NabuKind"))) !== "/draw") continue;
      const t = x.lookup(PDFName.of("T"));
      if (t && t.decodeText() === "hang_") draws++;
      const nm = x.lookup(PDFName.of("NM"));
      if (nm) nms.push(nm.decodeText());
    }
    check("B: the 2-stroke Ink edited → 2 Nabu draws, both by hang_ (+1 kept stroke of ink-2)", draws, 3);
    check("B: …but each /NM appears ONCE (the name is unique per annotation)", nms.sort(), ["ink-2", "ink-3"]);
  }

  // C. re-import: the edited ones come back as Nabu objects, at the place they were edited to
  await openBytes(sandbox.state.bytes);
  await reimport();
  const nabuOf = (page, kind, color) => (ed.annots[page] || []).filter((a) => !a._foreign && a.kind === kind && (!color || a.color === color));
  const c2 = nabuOf(0, "cloud")[0];
  check("C: the moved cloud reads back 30 pt to the right, same size",
    c2 && [near(c2.x, cloudAt[0] + 30), near(c2.y, cloudAt[1]), near(c2.w, cloudAt[2]), near(c2.h, cloudAt[3])], [true, true, true, true]);
  const r2b = nabuOf(1, "box", "#0000ff")[0];
  check("C: on the /Rotate 90 page the recoloured square reads back exactly where the partner's was (BI-45)",
    r2b && [near(r2b.x, rotAt[0]), near(r2b.y, rotAt[1]), near(r2b.w, rotAt[2]), near(r2b.h, rotAt[3])], [true, true, true, true]);
  check("C: untouched partner annotations are imported as partner annotations again (13 − 5)", ed._foreignImported.length, 8);

  // D. a changed file (N2): the original no longer matches → kept, user told, Nabu copy still written
  {
    const d = await PDFDocument.load(sandbox.state.bytes, { updateMetadata: false });
    await openBytes(sandbox.state.bytes);
    await reimport();
    const pg = find("pgon")[0];
    pg.pts[0].x += 5;
    // someone else's save between import and bake moved the original
    const raw = annotsOf(d, 0).find((r) => { const dd = d.context.lookup(r); const nm = dd.lookup(PDFName.of("NM")); return nm && nm.decodeText() === "pgon"; });
    d.context.lookup(raw).set(PDFName.of("Rect"), d.context.obj([0, 0, 5, 5]));
    sandbox.state.bytes = await d.save();
    toasts.length = 0;
    await api.bakePending();
    const dd = await PDFDocument.load(sandbox.state.bytes, { updateMetadata: false });
    const pg0 = annotsOf(dd, 0).map((r) => dd.context.lookup(r)).filter((x) => { const nm = x.lookup(PDFName.of("NM")); return nm && nm.decodeText() === "pgon"; });
    check("D: original that no longer matches is KEPT (two copies beat a lost comment), and the user is told",
      [pg0.map((x) => !!x.get(PDFName.of("NabuKind"))).sort(), warns().length === 1 && /không gỡ được bản gốc/.test(warns()[0])], [[false, true], true]);
  }
  await pdf.destroy();

  // ---- 6b. STAMPS (3b-2): only the /Rect may change, the appearance never --------------------
  {
    const sd = await PDFDocument.create();
    const c = sd.context;
    const q1 = sd.addPage([600, 800]);
    const q2 = sd.addPage([600, 800]);
    q2.node.set(PDFName.of("Rotate"), c.obj(90));
    const form = (bbox, ops, extra) => c.register(c.stream(ops, Object.assign({ Type: "XObject", Subtype: "Form", BBox: bbox }, extra || {})));
    const S = (s) => PDFHexString.fromText(s);
    const reg = (d) => c.register(c.obj(d));
    const st = (rect, nm, ap, extra) => reg(Object.assign({ Type: "Annot", Subtype: "Stamp", Rect: rect, F: 4, NM: S(nm), T: S("hang_"), Subj: S("Stamp"), AP: { N: ap } }, extra || {}));
    const apA = form([0, 0, 20, 10], "0 0 1 rg 0 0 20 10 re f");
    const SR = {};
    SR.a = st([100, 100, 140, 120], "st-a", apA, { CA: 0.6, Name: PDFName.of("clipboard.image.1") });
    SR.popup = reg({ Type: "Annot", Subtype: "Popup", Rect: [300, 300, 400, 400], Parent: SR.a });
    c.lookup(SR.a).set(PDFName.of("Popup"), SR.popup);
    SR.b = st([200, 200, 240, 220], "st-b", form([5, 5, 25, 15], "1 0 0 rg 5 5 20 10 re f", { Matrix: [1, 0, 0, 1, -5, -5] }));
    SR.turned = st([300, 100, 340, 120], "st-rot", form([0, 0, 20, 10], "0 g 0 0 20 10 re f"), { Rotate: 90 });
    SR.noAp = reg({ Type: "Annot", Subtype: "Stamp", Rect: [400, 100, 440, 120], F: 4, NM: S("st-noap") });
    q1.node.set(PDFName.of("Annots"), c.obj(Object.values(SR)));
    const SR2 = { c: st([100, 100, 160, 130], "st-c", form([0, 0, 60, 30], "0 1 0 rg 0 0 60 30 re f")) };
    q2.node.set(PDFName.of("Annots"), c.obj(Object.values(SR2)));
    const sbytes = await sd.save();

    const sdoc = await PDFDocument.load(sbytes, { updateMetadata: false });
    const srec = (raw) => FA.readForeign(PDFLib, sdoc, raw, sdoc.context.lookup(raw), new Set());
    const ra = srec(SR.a);
    check("Stamp read: /Rect, the form's /BBox + identity /Matrix, /CA kept (it is never re-drawn by Nabu)",
      [ra.subtype, ra.rect, ra.bbox, ra.matrix, ra.ca, ra.keep.NM], ["Stamp", [100, 100, 140, 120], [0, 0, 20, 10], [1, 0, 0, 1, 0, 0], 0.6, "st-a"]);
    check("a stamp turned by its own /Rotate → left alone", srec(SR.turned).skip, "rotated-stamp");
    check("a stamp without an appearance → left alone", srec(SR.noAp).skip, "no-appearance");
    check("Stamp → image object over its /Rect, showing the proxy picture",
      FA.toObjects(ra, (x, y) => [x, 800 - y], { dataUrl: "data:image/png;base64,AA" }),
      [{ kind: "image", x: 100, y: 680, w: 40, h: 20, dataUrl: "data:image/png;base64,AA", fmt: "png" }]);
    check("…and no proxy → not imported", FA.toObjects(ra, (x, y) => [x, y]).skip, "no-proxy");

    // the proxy, read back by the shipped pdf.js: what it would paint
    const opsOf = async (bytes) => {
      const p = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
      const pg = await p.getPage(1);
      const vp = pg.getViewport({ scale: 1 });
      const ol = await pg.getOperatorList();
      const out = { w: vp.width, h: vp.height, form: ol.fnArray.includes(pdfjs.OPS.paintFormXObjectBegin), gstate: ol.fnArray.includes(pdfjs.OPS.setGState),
                    cm: (ol.argsArray[ol.fnArray.indexOf(pdfjs.OPS.transform)] || []).map((v) => Math.round(v * 1000) / 1000) };
      await p.destroy();
      return out;
    };
    check("proxy of stamp A: 40×20 pt, the form drawn once, scaled 2× onto the box, /CA as a graphics state",
      await opsOf(await FA.stampProxyPdf(PDFLib, sdoc, ra, 0)), { w: 40, h: 20, form: true, gstate: true, cm: [2, 0, 0, 2, 0, 0] });
    check("proxy of stamp B: its /Matrix is honoured (BBox through Matrix = 0..20 × 0..10), no /CA → no graphics state",
      await opsOf(await FA.stampProxyPdf(PDFLib, sdoc, srec(SR.b), 0)), { w: 40, h: 20, form: true, gstate: false, cm: [2, 0, 0, 2, 0, 0] });
    const rc = FA.readForeign(PDFLib, sdoc, SR2.c, sdoc.context.lookup(SR2.c), new Set());
    const pc = await opsOf(await FA.stampProxyPdf(PDFLib, sdoc, rc, 90));
    check("proxy on a /Rotate 90 page is turned with the page (60×30 box shows as 30×60)", [pc.w, pc.h], [30, 60]);
    {
      const fresh = await PDFDocument.load(sbytes, { updateMetadata: false });
      await FA.stampProxyPdf(PDFLib, fresh, FA.readForeign(PDFLib, fresh, SR.a, fresh.context.lookup(SR.a), new Set()), 0);
      check("building a proxy leaves the source document untouched (same objects, same bytes on save)",
        Buffer.compare(Buffer.from(await fresh.save()), Buffer.from(await (await PDFDocument.load(sbytes, { updateMetadata: false })).save())), 0);
    }

    // unit: planForeign for stamps
    const im = (id, x, key) => ({ id, kind: "image", x, y: 0, w: 1, h: 1, _foreign: { fileRef: key, keep: { T: "hang_", NM: "st" } } });
    const isig = (a) => JSON.stringify([a.x, a.y, a.w, a.h]);
    const p0 = im(7, 10, "5 0 R");
    const SE = [{ key: "5 0 R", page: 0, sigs: [isig(p0)], hideId: "5R", stamp: true, primaryId: 7 }];
    let pl = FA.planForeign(SE, [{ page: 0, a: p0 }], isig);
    check("stamp untouched → skipped, original kept", [[...pl.skipIds], [...pl.keepIds], pl.rects.length, pl.remove.length], [[7], ["5R"], 0, 0]);
    p0.x = 40;
    pl = FA.planForeign(SE, [{ page: 0, a: p0 }], isig);
    check("stamp moved → a /Rect update, NOT a removal, and not drawn", [pl.rects.map((r) => r.a.id), [...pl.rectIds], pl.remove.length, [...pl.skipIds]], [[7], [7], 0, []]);
    check("stamp deleted → original removed", FA.planForeign(SE, [], isig).remove.length, 1);
    const stray = im(9, 10, "5 0 R");
    pl = FA.planForeign(SE, [{ page: 0, a: p0 }, { page: 0, a: stray }], isig);
    check("a second object carrying the stamp's original is a COPY: written, without the original's /NM", [pl.keepFor.get(9), pl.rects.length], [{ T: "hang_" }, 1]);

    // end to end through the shipped editor-bake.js, with the proxy renderer stubbed (no canvas here)
    const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const proxyBytes = [];
    const realPdfjs = sandbox.pdfjsLib;
    sandbox.pdfjsLib = {
      AnnotationMode: pdfjs.AnnotationMode,
      getDocument: ({ data }) => {
        proxyBytes.push(data);
        return { promise: Promise.resolve({
          getPage: async () => ({ getViewport: ({ scale }) => ({ width: 10 * scale, height: 10 * scale }), render: () => ({ promise: Promise.resolve() }) }),
          destroy: async () => {},
        }) };
      },
    };
    const realCreate = sandbox.document.createElement;
    sandbox.document.createElement = (t) => (t === "canvas" ? { width: 0, height: 0, getContext: () => ({}), toDataURL: () => PNG1 } : realCreate(t));
    const sdict = async (bytes) => {
      const d = await PDFDocument.load(bytes, { updateMetadata: false });
      const m = new Map();
      for (let i = 0; i < 2; i++) for (const raw of annotsOf(d, i)) {
        const x = d.context.lookup(raw);
        const nm = x.lookup(PDFName.of("NM"));
        let key = (nm ? nm.decodeText() : raw.toString()) + "@" + i;
        while (m.has(key)) key += "+";
        const ent = {};
        for (const [k, v] of x.entries()) ent[k.decodeText()] = v.toString();
        m.set(key, { ref: raw.toString(), ent, nabu: !!x.get(PDFName.of("NabuKind")) });
      }
      return m;
    };
    await openBytes(sbytes);
    sandbox.state.numPages = 2;
    await reimport();
    const sl = live();
    check("stamps import as image objects with the proxy picture (A, B; C on the turned page)",
      sl.map((l) => [l.page, l.a.kind, l.a._foreign.keep.NM, l.a.dataUrl === PNG1]), [[0, "image", "st-a", true], [0, "image", "st-b", true], [1, "image", "st-c", true]]);
    check("…one proxy PDF rendered per stamp", proxyBytes.length, 3);
    check("…recorded as stamps, the imported object as the primary", ed._foreignImported.map((e) => [e.stamp, e.primaryId === sl.find((l) => l.a._foreign.fileRef === e.key).a.id]), [[true, true], [true, true], [true, true]]);

    const s0 = await sdict(sbytes);
    ed.annots[0].push({ id: ed.seq++, kind: "box", x: 10, y: 10, w: 20, h: 20, color: "#00ff00", width: 2 });
    await api.bakePending();
    const s1 = await sdict(sandbox.state.bytes);
    check("untouched stamps: same number, same dict, key for key",
      ["st-a@0", "st-b@0", "st-c@1"].filter((k) => !s1.has(k) || s1.get(k).ref !== s0.get(k).ref || JSON.stringify(s1.get(k).ent) !== JSON.stringify(s0.get(k).ent)), []);

    await openBytes(sandbox.state.bytes);
    await reimport();
    const findS = (nm) => live().find((l) => l.a._foreign && l.a._foreign.keep.NM === nm);
    const A = findS("st-a").a;
    A.x += 30;
    const C = findS("st-c").a;
    const cAt = [C.x, C.y, C.w, C.h];
    C.w += 10;
    ed.annots[0] = ed.annots[0].filter((a) => !(a._foreign && a._foreign.keep.NM === "st-b"));
    const pre = await sdict(sandbox.state.bytes);
    const bApNum = +(/\/N\s+(\d+)\s+0\s+R/.exec(pre.get("st-b@0").ent.AP) || [])[1];
    check("fixture: stamp B's appearance is an indirect stream we can watch", bApNum > 0, true);
    toasts.length = 0;
    await api.bakePending();
    const s2 = await sdict(sandbox.state.bytes);
    const diffKeys = (k) => Object.keys(Object.assign({}, pre.get(k).ent, s2.get(k).ent)).filter((x) => pre.get(k).ent[x] !== s2.get(k).ent[x]);
    check("moved stamp A: SAME object number, still the partner's (no NabuKind), and ONLY /Rect changed",
      [s2.get("st-a@0").ref === pre.get("st-a@0").ref, s2.get("st-a@0").nabu, diffKeys("st-a@0")], [true, false, ["Rect"]]);
    check("…its /Rect moved 30 pt right, same size", s2.get("st-a@0").ent.Rect.replace(/\s+/g, " "), "[ 130 100 170 120 ]");
    check("resized stamp C on the /Rotate 90 page: same number, only /Rect changed", [s2.get("st-c@1").ref === pre.get("st-c@1").ref, diffKeys("st-c@1")], [true, ["Rect"]]);
    check("deleted stamp B is gone, and nothing Nabu was written for any stamp",
      [s2.has("st-b@0"), [...s2.values()].filter((v) => v.nabu).length], [false, 1]);
    const dB = await PDFDocument.load(sandbox.state.bytes, { updateMetadata: false });
    check("…its appearance stream is freed (no orphan copy of the picture)", dB.context.lookup(PDFLib.PDFRef.of(bApNum)), undefined);
    check("no warning", toasts.filter((t) => t !== "Đã áp dụng chỉnh sửa."), []);

    await openBytes(sandbox.state.bytes);
    await reimport();
    const C2 = findS("st-c").a;
    check("re-import: the resized stamp on the turned page reads back exactly as left (BI-45)",
      [near(C2.x, cAt[0]), near(C2.y, cAt[1]), near(C2.w, cAt[2] + 10), near(C2.h, cAt[3])], [true, true, true, true]);
    const A2 = findS("st-a").a;
    // a paste-like copy (no _foreign) + a stray clone that still carries the original
    ed.annots[0].push({ id: ed.seq++, kind: "image", x: 10, y: 10, w: 40, h: 20, dataUrl: PNG1, fmt: "png" });
    ed.annots[0].push(Object.assign(JSON.parse(JSON.stringify(A2)), { id: ed.seq++, x: 400 }));
    const pre3 = await sdict(sandbox.state.bytes);
    await api.bakePending();
    const s3 = await sdict(sandbox.state.bytes);
    check("copies of a stamp → new Nabu images; the original stamp itself is untouched (same number, same dict)",
      [[...s3.values()].filter((v) => v.nabu && /image/.test(v.ent.NabuKind)).length, s3.get("st-a@0").ref === pre3.get("st-a@0").ref && JSON.stringify(s3.get("st-a@0").ent) === JSON.stringify(pre3.get("st-a@0").ent)],
      [2, true]);
    check("…and no copy took the original's /NM", [...s3.keys()].filter((k) => k.startsWith("st-a@0")).length, 1);

    // N2: the file changed under us — the stamp is left where it is, the user is told
    await openBytes(sandbox.state.bytes);
    await reimport();
    findS("st-c").a.x += 5;
    const dd = await PDFDocument.load(sandbox.state.bytes, { updateMetadata: false });
    const rawC = annotsOf(dd, 1).find((r) => { const x = dd.context.lookup(r); const nm = x.lookup(PDFName.of("NM")); return nm && nm.decodeText() === "st-c"; });
    dd.context.lookup(rawC).set(PDFName.of("Rect"), dd.context.obj([0, 0, 5, 5]));
    sandbox.state.bytes = await dd.save();
    toasts.length = 0;
    await api.bakePending();
    const s4 = await sdict(sandbox.state.bytes);
    check("N2: a stamp that no longer matches is NOT moved (its /Rect stays what the file says), and the user is told",
      [s4.get("st-c@1").ent.Rect.replace(/\s+/g, " "), toasts.filter((t) => /không cập nhật được vị trí/.test(t)).length], ["[ 0 0 5 5 ]", 1]);
    sandbox.pdfjsLib = realPdfjs;
    sandbox.document.createElement = realCreate;
  }

  // ---- 7. wiring pins (DOM side; the probe runs them for real) ----------------------------------
  const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
  const ED = read("editor.js");
  const SP = require("../renderer/side-panels.js");
  check("copySelected drops _foreign from the copy", /^\s*delete a\._foreign;/m.test(ED), true);
  check("reset() forgets the imported originals", /ed\._foreignImported = \[\];/.test(ED), true);
  check("listObjects reports fileRef + author for imported objects", /fileRef: a\._foreign \? a\._foreign\.fileRef : null,/.test(ED) && /author: a\._foreign \? a\._foreign\.keep\.T \|\| "" : "",/.test(ED), true);
  check("Chú thích list: an imported partner annotation is listed once (live), not again from the file",
    SP.composeItems([{ ref: "12 0 R", kind: null, page: 0 }, { ref: "13 0 R", kind: null, page: 0 }], [{ id: 1, fileRef: "12 0 R", page: 0 }], true).map((it) => [it.live, it.ref || it.fileRef]),
    [[true, "12 0 R"], [false, "13 0 R"]]);
  // The redaction bake cannot run here (canvas); pin its three BI-100 steps on the source.
  const BK = read("editor-bake.js");
  const bwr = BK.slice(BK.indexOf("async function bakeWithRedaction()"), BK.indexOf("async function bakePending()"));
  check("bakeWithRedaction removes edited/deleted originals from `src` BEFORE copying pages out of it",
    bwr.indexOf("removeForeign(src, fp.remove);") > 0 && bwr.indexOf("removeForeign(src, fp.remove);") < bwr.indexOf("out.copyPages("), true);
  check("…skips untouched copies, and lets the raster keep untouched originals",
    /annotsFor\(i\)\.filter\(\(a\) => !fp\.skipIds\.has\(a\.id\)\)/.test(bwr) && /rasterRedacted\(i, redacts, vp1, fp\.keepIds\)/.test(bwr), true);
  const bip = BK.slice(BK.indexOf("async function bakeInPlace()"), BK.indexOf("async function bakeWithRedaction()"));
  check("bakeInPlace: plan → strip ours → remove partner originals → move stamps by /Rect → draw all but the untouched / moved stamps",
    /const fp = foreignPlan\(\);[\s\S]*stripManagedAnnots\(doc\);[\s\S]*removeForeign\(doc, fp\.remove\);[\s\S]*await applyStampRects\(doc, fp\.rects\);[\s\S]*annotsFor\(i\)\.filter\(\(a\) => !fp\.skipIds\.has\(a\.id\) && !fp\.rectIds\.has\(a\.id\)\)/.test(bip), true);
  check("bakeWithRedaction: stamps moved by /Rect in `src` before copying; drawn as a picture only on a page rebuilt from one",
    bwr.indexOf("await applyStampRects(src, fp.rects);") > 0 && bwr.indexOf("await applyStampRects(src, fp.rects);") < bwr.indexOf("out.copyPages(") &&
    /const anns = redacts\.length \? all : all\.filter\(\(a\) => !fp\.rectIds\.has\(a\.id\)\);/.test(bwr), true);
  const AS = require("../renderer/annot-scan.js");
  check("list label: an imported plain Line (a 2-point poly in the editor) is still 'Đường kẻ'; a Nabu poly keeps its own",
    [AS.labelOf({ kind: "poly", subtype: "Line" }), AS.labelOf({ kind: "poly" }) === AS.KIND_LABEL.poly], ["Đường kẻ", true]);
  check("list label: an imported Stamp (an image object in the editor) is still 'Con dấu / ảnh'; a Nabu image keeps its own",
    [AS.labelOf({ kind: "image", subtype: "Stamp" }), AS.labelOf({ kind: "image" }) === AS.KIND_LABEL.image], [AS.SUBTYPE_LABEL.Stamp, true]);
  check("listObjects passes the original subtype", /subtype: a\._foreign \? a\._foreign\.subtype : null,/.test(ED), true);
  check("index.html loads foreign-annot.js after annot-scan.js",
    (() => { const h = read("index.html"); const a = h.indexOf('src="annot-scan.js"'), b = h.indexOf('src="foreign-annot.js"'); return a > 0 && b > a; })(), true);

  console.log(`\nforeign-annot: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e && e.stack);
  process.exit(1);
});
