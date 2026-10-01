"use strict";

// Guards for the split of editor.js into editor.js + editor-bake.js
// (docs/PROPOSAL-2026-10-01-split-editor-baking.md).
//
// The baking half of the editor (PNG rasterisation, the managed-annotation round trip, drawing
// annotations into pages, bakeInPlace / bakeWithRedaction, bakePending) now lives in
// editor-bake.js, moved VERBATIM. What can still go wrong after a verbatim move is the
// SEAM: a name the block uses from editor.js's own scope that nobody passes in, a name that is
// passed but never used, a script loaded in the wrong order, a function quietly re-declared in
// both files. None of those changes a byte of the block, so the byte-for-byte proof
// (scripts/prove-bake-move.js, run once against the pre-move revision) cannot see them later —
// this file does, on every `npm test`:
//
//   · the interface is exactly the pinned one: ten names in, two out, the PDFLib names, and the
//     listed classic-script globals — adding a bare-name dependency fails here until the header
//     of editor-bake.js, the pins and the call in editor.js are updated TOGETHER;
//   · the moved functions are not declared (or called) in editor.js any more;
//   · the file really loads in a context that has only what it declares (real pdf-lib, the real
//     annot-text / annot-geom / managed-codec, stubs for app.js's globals) and create() returns
//     the two functions — so a reference to something that does not exist at LOAD time fails
//     here, not in a user's window;
//   · the ten dependencies passed in are the ones actually USED (distinct stubs, observed calls).
//
// Run:  node desktop/test/bake-split.test.js      (or: npm test -- bake-split)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const P = require("../scripts/prove-bake-move.js");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    process.stderr.write(`FAIL ${name}\n  expected ${b}\n  actual   ${a}\n`);
  }
}
let finished = false;
process.on("exit", () => {
  if (!finished) {
    process.stderr.write("FAIL the test exited before finishing: a promise never settled\n");
    process.exitCode = 1;
  }
});

const R = path.join(__dirname, "..", "renderer");
const read = (f) => fs.readFileSync(path.join(R, f), "utf8").replace(/\r\n/g, "\n");
const EDITOR = read("editor.js");
const BAKE = read("editor-bake.js");

// ---- structure -------------------------------------------------------------------------------------
const bi = BAKE.indexOf(P.BEGIN);
const ei = BAKE.indexOf(P.END);
check("editor-bake.js has exactly one BEGIN/END marker pair", bi >= 0 && ei > bi && BAKE.indexOf(P.BEGIN, bi + 1) < 0 && BAKE.indexOf(P.END, ei + 1) < 0, true);
const block = BAKE.slice(bi + P.BEGIN.length, ei);
const wrapper = BAKE.slice(0, bi) + BAKE.slice(ei + P.END.length);

check("the wrapper destructures the pinned ten, in order",
  JSON.stringify(((/const \{ ([^}]*) \} = deps;/.exec(wrapper) || [])[1] || "").split(",").map((x) => x.trim())), JSON.stringify(P.DEPS));
check("the wrapper returns exactly { bakePending, importManaged }", /return \{ bakePending, importManaged \};/.test(wrapper), true);
check("one global is published: EditorBake = { create }", (wrapper.match(/window\.[A-Za-z]+\s*=/g) || []).join("|"), "window.EditorBake =");
check("…and it is { create }", /window\.EditorBake = \{ create \};/.test(wrapper), true);
check("the file is strict-mode and an IIFE (no top-level declarations leak into the shared script scope)",
  /^"use strict";/.test(BAKE) && /\n\(function \(\) \{\n/.test(BAKE) && /\n\}\)\(\);\n$/.test(BAKE), true);

// ---- editor.js side of the seam ----------------------------------------------------------------------
const stubAt = EDITOR.indexOf(P.STUB_FROM);
const stubEnd = EDITOR.indexOf("  // ---- watermark dialog");
const stub = stubAt >= 0 && stubEnd > stubAt ? EDITOR.slice(stubAt, stubEnd) : "";
// the stub region may hold comments, blank lines and the ONE create() statement - nothing else
const stubCode = stub.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).join(" ").replace(/\s+/g, " ").trim();
check("the stub region is comments plus the single create() statement and nothing else",
  /^const \{ bakePending, importManaged \} = window\.EditorBake\.create\(\{ [^}]* \}\);$/.test(stubCode), true);
const call = /window\.EditorBake\.create\(\{([^}]*)\}\)/.exec(stub);
check("editor.js calls create() once, passing exactly the pinned ten in order",
  JSON.stringify(call ? call[1].split(",").map((x) => x.trim()).filter(Boolean) : null), JSON.stringify(P.DEPS));
check("…and takes back exactly bakePending and importManaged", /const \{ bakePending, importManaged \} = window\.EditorBake\.create/.test(stub), true);
check("create() is called exactly once in editor.js", (EDITOR.match(/EditorBake\.create\(/g) || []).length, 1);

const outsideStub = EDITOR.replace(stub, "");
const redeclared = P.MOVED_NAMES.filter((nm) => new RegExp("^  (?:async\\s+)?function\\s+" + nm + "\\b|^  (?:const|let|var)\\s+" + nm + "\\b", "m").test(outsideStub));
check("none of the moved functions is declared in editor.js any more", redeclared, []);
const bare = P.bareIdentifiers(outsideStub);
const private_ = P.MOVED_NAMES.filter((nm) => nm !== "bakePending" && nm !== "importManaged");
check("editor.js does not reference the 12 private moved names", private_.filter((nm) => bare.has(nm)), []);
check("the two that come back are used by editor.js (they are its way in)", ["bakePending", "importManaged"].map((nm) => bare.has(nm)), [true, true]);

// every name passed in is declared in editor.js ABOVE the call (consts would otherwise be in their TDZ)
const callAt = EDITOR.indexOf("window.EditorBake.create(");
const above = EDITOR.slice(0, callAt);
const declaredAbove = P.DEPS.filter((nm) => new RegExp("^  (?:async\\s+)?function\\s+" + nm + "\\b|^  (?:const|let|var)\\s+" + nm + "\\b", "m").test(above));
check("all ten passed names are declared before the call (no temporal-dead-zone read)", declaredAbove, P.DEPS);
const constsAbove = P.DEPS.filter((nm) => new RegExp("^  (?:const|let)\\s+" + nm + "\\b", "m").test(EDITOR));
check("…and the only ones that are const are declared above it too", constsAbove.every((nm) => above.includes("  const " + nm) || above.includes("  let " + nm)), true);

// ---- the pinned interface of the block -------------------------------------------------------------------
const iface = P.interfaceOfBlock(block, outsideStub);
check("from editor.js's scope the block uses exactly the ten + the PDFLib names",
  iface.intoFromEditor, P.DEPS.concat(P.PDFLIB_USED).sort());
const sortedMap = (m) => Object.fromEntries(Object.keys(m).sort().map((f) => [f, m[f].slice().sort()]));
check("its bare globals from other scripts are exactly the pinned list (a new one must be added to the header, the pin and the load order)",
  sortedMap(iface.globals), sortedMap(P.EXPECTED_GLOBALS));

// ---- loads for real ----------------------------------------------------------------------------------------
function makeContext() {
  const sandbox = { console, TextEncoder, TextDecoder, Uint8Array, atob, btoa, setTimeout, clearTimeout, Blob };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => { throw new Error("DOM touched at load/construct time"); } };
  const ctx = vm.createContext(sandbox);
  const run = (file, abs) => vm.runInContext(fs.readFileSync(abs || path.join(R, file), "utf8"), ctx, { filename: file });
  run("pdf-lib.min.js", path.join(R, "vendor", "pdf-lib.min.js"));
  for (const f of ["wire.js", "annot-text.js", "annot-geom.js", "managed-codec.js"]) run(f);
  return { ctx, run, sandbox };
}

(async () => {
  const { ctx, run, sandbox } = makeContext();
  check("real pdf-lib loaded into the context", typeof sandbox.PDFLib.PDFDocument, "function");
  let loadError = null;
  try { run("editor-bake.js"); } catch (e) { loadError = String(e && e.message); }
  check("editor-bake.js LOADS in a context holding only what it declares", loadError, null);
  check("…and publishes exactly { create }", Object.keys(sandbox.EditorBake || {}), ["create"]);

  // The four small pure helpers editor.js owns are taken from the SHIPPING editor.js (cut out, evaluated in the
  // same context), so the round trip below uses the real colour/data-URL/thread-text code, not a stand-in.
  const cutFn = (name) => {
    const at = EDITOR.indexOf("  function " + name + "(");
    if (at < 0) throw new Error(name + "() not found in editor.js");
    const open = EDITOR.indexOf("{", EDITOR.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < EDITOR.length; i++) {
      if (EDITOR[i] === "{") depth++;
      else if (EDITOR[i] === "}" && --depth === 0) return EDITOR.slice(at, i + 1);
    }
    throw new Error("unbalanced " + name);
  };
  vm.runInContext("const { rgb } = PDFLib;", ctx);
  const real = vm.runInContext("(" + ["hexRgb", "hexToRgba", "dataUrlToBytes", "noteThreadText"].map((n) => `${n}: ${cutFn(n).replace(/^\s*function\s+\w+/, "function")}`).join(", ").replace(/^/, "{") + "})", ctx);

  // distinct stubs, observed
  const calls = {};
  const mark = (n, v) => (...a) => { calls[n] = (calls[n] || 0) + 1; return typeof v === "function" ? v(...a) : v; };
  const ed = { annots: {}, watermark: null, seq: 0, _managedPages: new Set(), _taCommit: null, _importedManaged: 0, highlightColor: "#ffd54a", sel: null, _dirty: false, active: false, _exiting: false };
  const deps = {
    ed,
    annotsFor: mark("annotsFor", (i) => (ed.annots[i] = ed.annots[i] || [])),
    hasAny: mark("hasAny", false),
    clearEdHistory: mark("clearEdHistory"),
    syncOverlays: mark("syncOverlays"),
    hexRgb: mark("hexRgb", real.hexRgb),
    hexToRgba: mark("hexToRgba", real.hexToRgba),
    dataUrlToBytes: mark("dataUrlToBytes", real.dataUrlToBytes),
    SYMBOL_KINDS: new Set(["check", "cross"]),
    noteThreadText: mark("noteThreadText", real.noteThreadText),
  };
  let api = null;
  let createError = null;
  try { api = sandbox.EditorBake.create(deps); } catch (e) { createError = String(e && e.message); }
  check("create() runs with the ten dependencies", createError, null);
  check("…and returns exactly { bakePending, importManaged }", api && Object.keys(api).sort(), ["bakePending", "importManaged"]);
  check("both are functions", api && [typeof api.bakePending, typeof api.importManaged], ["function", "function"]);

  // bakePending with nothing to do must ask the INJECTED hasAny and return false without touching the document
  sandbox.state = { bytes: null };
  sandbox.window.desktop = null;
  const r0 = await api.bakePending();
  check("bakePending() with nothing to bake returns false after asking the injected hasAny", [r0, calls.hasAny], [false, 1]);

  // arrays must be created INSIDE the context: pdf-lib checks `instanceof Array`, which is false across realms
  const inCtx = (code) => vm.runInContext(code, ctx);
  const mkPage = inCtx("(w, h) => [w, h]");

  // importManaged on a document without managed annots: real pdf-lib, real codec constants, nothing found
  const doc = await sandbox.PDFLib.PDFDocument.create();
  doc.addPage(mkPage(300, 300));
  sandbox.state = { bytes: await doc.save() };
  check("importManaged() parses a real PDF with the real codec and finds no managed annots", await api.importManaged(), 0);
  sandbox.state = { bytes: null };
  check("importManaged() with no document returns 0", await api.importManaged(), 0);

  // A REAL bake through the wrapper, then a REAL re-import: a box goes in as an overlay object, comes out as a managed
  // PDF annotation (written by the real managed-codec), and importManaged turns it back into an overlay object that lands in
  // the INJECTED annotsFor. Everything between the stubs is the shipped code.
  sandbox.state = {
    bytes: await doc.save(),
    pdf: { getPage: async () => ({ getViewport: () => ({ width: 300, height: 300, rotation: 0, scale: 1, convertToPdfPoint: (x, y) => [x, 300 - y] }) }) },
  };
  Object.assign(sandbox, {
    toast: mark("toast"), showOverlay: mark("showOverlay"), hideOverlay: mark("hideOverlay"),
    rerenderChanged: mark("rerenderChanged", async () => {}), pdfjsLib: {},
  });
  sandbox.window.DocHistory = { pushUndo: mark("pushUndo") };
  ed.annots = { 0: [{ id: 7, kind: "box", x: 20, y: 30, w: 100, h: 60, color: "#ff0000", width: 2 }] };
  const before = sandbox.state.bytes;
  // the wrapper closed over the ORIGINAL hasAny (false); give it a fresh instance whose hasAny says yes
  const api2 = sandbox.EditorBake.create({ ...deps, hasAny: mark("hasAny3", true) });
  calls.pushUndo = 0;
  const baked = await api2.bakePending();
  check("bakePending() bakes a box through the wrapper using the injected hasAny", [baked, calls.hasAny3], [true, 1]);
  check("…the document changed, history got one undo step, the overlay was shown and hidden", [sandbox.state.bytes !== before, calls.pushUndo, calls.showOverlay >= 1 && calls.hideOverlay >= 1], [true, 1, true]);
  check("…the injected clearEdHistory ran and ed was reset in place (the SAME object)", [calls.clearEdHistory >= 1, JSON.stringify(ed.annots), ed._dirty], [true, "{}", false]);

  const baked2 = await sandbox.PDFLib.PDFDocument.load(sandbox.state.bytes);
  const annots = baked2.getPage(0).node.Annots();
  check("the baked page carries one annotation written by the real codec", annots ? annots.size() : 0, 1);

  ed.annots = {};
  calls.annotsFor = 0;
  const imported = await api2.importManaged();
  check("importManaged() stores through the INJECTED annotsFor (a direct ed.annots write would bypass it)", calls.annotsFor >= 1, true);
  check("importManaged() reads it back: one object", imported, 1);
  const back = (ed.annots[0] || [])[0] || {};
  check("…as the same box, in the injected annotsFor's store", [back.kind, Math.round(back.x), Math.round(back.y), Math.round(back.w), Math.round(back.h)], ["box", 20, 30, 100, 60]);
  check("…and the page is remembered in ed._managedPages", [...ed._managedPages], [0]);

  finished = true;
  console.log(`\nbake-split: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stderr.write("FAIL unexpected: " + (e && e.stack) + "\n"); process.exit(1); });
