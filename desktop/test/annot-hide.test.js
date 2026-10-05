"use strict";

// Regression net for "edit mode hides OUR baked annotations, and only ours" — BI-99,
// renderer/annot-hide.js (docs/RESEARCH-2026-10-05 §3.4-1 / -3, Đợt 3a).
//
// Before: entering "Chú thích" painted every page with AnnotationMode.DISABLE, so a partner's
// FreeText, cloud marks and every form value vanished from the screen, and a redaction bake on
// a page that also held a Nabu text box dropped the partner's annotations from the saved file.
//
// What is checked, and why it is enough:
//   1. the pure pieces (id spelling, rect compare, entryOf on real pdf-lib objects);
//   2. `plan` — every "not sure" road answers "all" (= DISABLE, the old behaviour), so a
//      wrong list can only ever hide TOO MUCH, never paint our object twice;
//   3. `render` — the storage entries exist exactly while render() is called, and are gone
//      afterwards even if render throws;
//   4. THE MECHANISM ON THE SHIPPED pdf.js (pdfjs-dist 3.11.174, the version vendored):
//      a real file with a Nabu stamp, a Nabu image whose source is unreadable, a foreign
//      FreeText, a foreign Square and a filled form field. The operator list — what the
//      canvas is actually painted from — must lose the Nabu stamp and nothing else; a list
//      taken from renumbered bytes must be refused; removing the entries right after the
//      call must not change what the in-flight render paints.
//   5. source pins on the three call sites (they need a DOM; the probe runs them for real).
//
// Run:  node desktop/test/annot-hide.test.js      (or: npm run test:annothide)

const fs = require("fs");
const path = require("path");
const PDFLib = require("pdf-lib");
const { PDFDocument, PDFName, PDFHexString, PDFString, PDFDict } = PDFLib;
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const AH = require("../renderer/annot-hide.js");
const MC = require("../renderer/managed-codec.js");

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

// ---- 1. pure pieces -----------------------------------------------------------------

check("refId: generation 0 is '<num>R' (pdf.js Ref.toString)", AH.refId(12, 0), "12R");
check("refId: other generations append it", AH.refId(12, 3), "12R3");
check("normRect orders the corners", AH.normRect([150, 120, 100, 100]), [100, 100, 150, 120]);
check("normRect refuses junk", [AH.normRect(null), AH.normRect([1, 2, 3]), AH.normRect([0, 0, NaN, 1])], [null, null, null]);
check("sameRect ignores corner order and float noise", AH.sameRect([100, 100, 150, 120.0004], [150, 120, 100, 100]), true);
check("sameRect sees a moved annotation", AH.sameRect([100, 100, 150, 120], [101, 100, 151, 120]), false);
check("sameRect: missing rect is never 'the same'", AH.sameRect(null, null), false);

// ---- 2. plan --------------------------------------------------------------------------

const pageWith = (annots) => ({ getAnnotations: async () => annots });
const E = (id, subtype = "Stamp", rect = [100, 100, 150, 120]) => ({ id, subtype, rect });
const S = (id, subtype = "Stamp", rect = [100, 100, 150, 120]) => ({ id, subtype, rect });

(async () => {
  check("plan: nothing owned → null (plain ENABLE)", [await AH.plan(null, pageWith([])), await AH.plan([], pageWith([]))], [null, null]);
  check("plan: every entry found with same subtype + rect → its ids",
    await AH.plan([E("7R"), E("9R", "Text", [10, 10, 30, 30])], pageWith([S("7R"), S("8R", "FreeText"), S("9R", "Text", [30, 30, 10, 10])])),
    ["7R", "9R"]);
  check("plan: duplicate entries are hidden once", await AH.plan([E("7R"), E("7R")], pageWith([S("7R")])), ["7R"]);
  check("plan: an inline annotation (no object number) → all", await AH.plan([E(null)], pageWith([S("7R")])), "all");
  check("plan: id not on this page (stale list) → all", await AH.plan([E("7R")], pageWith([S("8R")])), "all");
  check("plan: same id, other subtype (renumbered file) → all", await AH.plan([E("7R")], pageWith([S("7R", "FreeText")])), "all");
  check("plan: same id, moved rect → all", await AH.plan([E("7R")], pageWith([S("7R", "Stamp", [0, 0, 50, 20])])), "all");
  check("plan: getAnnotations throws → all", await AH.plan([E("7R")], { getAnnotations: async () => { throw new Error("x"); } }), "all");
  check("plan: does not even ask pdf.js when nothing is owned",
    await AH.plan([], { getAnnotations: () => { throw new Error("must not be called"); } }), null);

  // ---- 3. render ------------------------------------------------------------------------

  const MODE = { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 };
  function fakeStorage() {
    const m = new Map();
    return { m, setValue: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
  }
  function fakePage(storage, opts = {}) {
    const calls = [];
    return {
      calls,
      render(p) {
        calls.push({ mode: p.annotationMode, seen: [...storage.m.entries()], keys: Object.keys(p).sort() });
        if (opts.throws) throw new Error("render failed");
        return { promise: Promise.resolve(), tag: "task" };
      },
    };
  }
  {
    const st = fakeStorage();
    const pg = fakePage(st);
    const params = { canvasContext: {}, viewport: {}, transform: undefined };
    const t = AH.render(pg, params, null, MODE, st);
    check("render(null) → ENABLE, storage untouched, task handed back", [pg.calls[0].mode, pg.calls[0].seen, t.tag], [1, [], "task"]);
    AH.render(pg, params, "all", MODE, st);
    check("render('all') → DISABLE (the old behaviour)", pg.calls[1].mode, 0);
    AH.render(pg, params, ["7R", "9R"], MODE, st);
    check("render(ids) → ENABLE_STORAGE with noView on exactly those ids during the call",
      [pg.calls[2].mode, pg.calls[2].seen], [3, [["7R", { noView: true }], ["9R", { noView: true }]]]);
    check("…and the storage is empty again afterwards", st.m.size, 0);
    check("…and the caller's params object was not mutated", Object.keys(params).sort(), ["canvasContext", "transform", "viewport"]);
    AH.render(pg, params, ["7R"], MODE, null);
    check("render(ids) with no storage to write to → DISABLE, never a half-hidden page", pg.calls[3].mode, 0);
  }
  {
    const st = fakeStorage();
    const pg = fakePage(st, { throws: true });
    let threw = false;
    try { AH.render(pg, {}, ["7R"], MODE, st); } catch (_) { threw = true; }
    check("render that throws still clears the storage (and rethrows)", [threw, st.m.size], [true, 0]);
  }

  // ---- 4. the mechanism on the shipped pdf.js -----------------------------------------

  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const p1 = doc.addPage([400, 400]);
  const p2 = doc.addPage([400, 400]);
  const ap = (w, h, ops) => ctx.register(ctx.stream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h] }));
  const annot = (d) => ctx.register(ctx.obj(d));
  const nabuBox = annot({
    Type: "Annot", Subtype: "Stamp", Rect: [100, 100, 150, 120], F: 4,
    AP: { N: ap(50, 20, "0 0 1 rg 0 0 50 20 re f") },
    NabuKind: PDFName.of("box"), NabuData: PDFHexString.fromText('{"k":"box"}'),
  });
  // An image whose /NabuSrc is missing: the bake KEEPS it (stripManagedFromPage skips it),
  // so it is not the overlay's and must stay painted while editing.
  const nabuImgNoSrc = annot({
    Type: "Annot", Subtype: "Stamp", Rect: [200, 100, 260, 140], F: 4,
    AP: { N: ap(60, 40, "1 0 0 rg 0 0 60 40 re f") },
    NabuKind: PDFName.of("image"), NabuData: PDFHexString.fromText('{"k":"image"}'),
  });
  const freeText = annot({
    Type: "Annot", Subtype: "FreeText", Rect: [50, 300, 250, 330], F: 4, NM: PDFString.of("ft-1"),
    Contents: PDFHexString.fromText("INNO từ chối phê duyệt"), DA: PDFString.of("/Helv 10 Tf 1 0 0 rg"),
    AP: { N: ap(200, 30, "1 0 0 rg 2 2 196 26 re S") },
  });
  const square = annot({
    Type: "Annot", Subtype: "Square", Rect: [300, 200, 380, 260], F: 4, C: [1, 0, 0],
    AP: { N: ap(80, 60, "1 0 0 RG 1 1 78 58 re S") },
  });
  const field = annot({
    Type: "Annot", Subtype: "Widget", FT: PDFName.of("Tx"), T: PDFString.of("ngay"), V: PDFString.of("15/06/2026"),
    Rect: [50, 50, 200, 70], F: 4, AP: { N: ap(150, 20, "BT /Helv 10 Tf 2 6 Td (15/06/2026) Tj ET") },
  });
  p1.node.set(PDFName.of("Annots"), ctx.obj([nabuBox, nabuImgNoSrc, freeText, square, field]));
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [field] }));
  // Page 2: a Nabu annotation stored INLINE in /Annots — no object number, so pdf.js gives it
  // an invented id and we cannot name it. That page must fall back to DISABLE.
  const inline = ctx.obj({
    Type: "Annot", Subtype: "Stamp", Rect: [10, 10, 60, 30], F: 4,
    AP: { N: ap(50, 20, "0 g 0 0 50 20 re f") }, NabuKind: PDFName.of("box"), NabuData: PDFHexString.fromText('{"k":"box"}'),
  });
  p2.node.set(PDFName.of("Annots"), ctx.obj([inline]));
  const bytes = await doc.save();

  // The owned list, built exactly as importManaged builds it (pinned in §5 below).
  function ownedOf(d) {
    const out = new Map();
    d.getPages().forEach((pg, i) => {
      const arr = pg.node.Annots();
      if (!arr) return;
      for (let j = 0; j < arr.size(); j++) {
        const dict = d.context.lookup(arr.get(j));
        if (!(dict instanceof PDFDict) || !dict.get(MC.NABU_KIND)) continue;
        if (MC.replacedOnBake(d, dict)) {
          if (!out.has(i)) out.set(i, []);
          out.get(i).push(AH.entryOf(PDFLib, arr.get(j), dict));
        }
      }
    });
    return out;
  }
  const back = await PDFDocument.load(bytes, { updateMetadata: false });
  const owned = ownedOf(back);
  check("entryOf on the reloaded file: object number, subtype, normalised rect",
    owned.get(0), [{ id: AH.refId(nabuBox.objectNumber, 0), subtype: "Stamp", rect: [100, 100, 150, 120] }]);
  check("…the image the bake keeps is NOT owned; the inline one is owned but nameless",
    [owned.get(0).length, owned.get(1)], [1, [{ id: null, subtype: "Stamp", rect: [10, 10, 60, 30] }]]);

  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const page1 = await pdf.getPage(1);
  const page2 = await pdf.getPage(2);
  const ids = await AH.plan(owned.get(0), page1);
  check("plan on the real page: exactly the Nabu box", ids, [AH.refId(nabuBox.objectNumber, 0)]);
  check("plan on the page with an inline Nabu annotation → all", await AH.plan(owned.get(1), page2), "all");

  const BEGIN = pdfjs.OPS.beginAnnotation;
  const painted = (ol) => ol.fnArray.flatMap((fn, k) => (fn === BEGIN ? [ol.argsArray[k][0]] : []));
  const all = [nabuBox, nabuImgNoSrc, freeText, square, field].map((r) => AH.refId(r.objectNumber, 0));
  const M = pdfjs.AnnotationMode;
  check("pdf.js ENABLE paints all five (view mode, unchanged)",
    painted(await page1.getOperatorList({ annotationMode: M.ENABLE })), all);
  check("pdf.js DISABLE paints none — the old edit mode: the partner's text and the form value gone",
    painted(await page1.getOperatorList({ annotationMode: M.DISABLE })), []);

  // What AnnotHide.render does around page.render, done around getOperatorList (same
  // getRenderingIntent → storage snapshot path; node has no canvas to render into).
  const storage = pdf.annotationStorage;
  for (const id of ids) storage.setValue(id, { noView: true });
  const inFlight = page1.getOperatorList({ annotationMode: M.ENABLE_STORAGE });
  for (const id of ids) storage.remove(id); // removed BEFORE the worker has answered
  const hidden = painted(await inFlight);
  check("ENABLE_STORAGE + noView: everything but the Nabu box — partner FreeText, Square, form value, kept image",
    hidden, all.filter((id) => id !== ids[0]));
  check("…removing the entries right after the call did not change the in-flight paint", hidden.length, 4);
  check("…and nothing is left in the document's storage", storage.serializable.map ? storage.serializable.map.size : 0, 0);
  check("…so a later ENABLE_STORAGE render paints all five again",
    painted(await page1.getOperatorList({ annotationMode: M.ENABLE_STORAGE })), all);

  // A stale list: the same objects after a rebuild that renumbers them (what a redaction bake
  // or another tool's save does). The check must refuse rather than hide something else.
  const re = await PDFDocument.create();
  for (let k = 0; k < 40; k++) re.context.register(re.context.obj({})); // take object numbers first, so the copy lands elsewhere
  const [c1] = await re.copyPages(back, [0]);
  re.insertPage(0, c1);
  const rebytes = await re.save();
  const repdf = await pdfjs.getDocument({ data: rebytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const rePage = await repdf.getPage(1);
  const reAnn = await rePage.getAnnotations();
  const sameObj = reAnn.find((a) => a.id === ids[0]);
  check("fixture: the rebuild really renumbered (the old id is not the box any more)",
    !!(sameObj && sameObj.subtype === "Stamp" && AH.sameRect(sameObj.rect, [100, 100, 150, 120])), false);
  check("fixture: the rebuilt page still carries all five annotations", reAnn.length, 5);
  check("plan with the old list against the renumbered page → all", await AH.plan(owned.get(0), rePage), "all");
  check("…and a list re-read from the new bytes names the box again",
    (await AH.plan(ownedOf(await PDFDocument.load(rebytes)).get(0), rePage)).length, 1);
  await pdf.destroy();
  await repdf.destroy();

  // ---- 5. the call sites -----------------------------------------------------------------

  const R = path.join(__dirname, "..", "renderer");
  const read = (f) => fs.readFileSync(path.join(R, f), "utf8");
  function body(src, header) {
    const at = src.indexOf(header);
    if (at < 0) throw new Error(`${header} not found — renamed or moved?`);
    const open = src.indexOf("{", src.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error("unbalanced braces after " + header);
  }
  const APP = read("app.js");
  const BAKE = read("editor-bake.js");
  const EDITOR = read("editor.js");
  const MCSRC = read("managed-codec.js");
  const renderFn = body(APP, "async function renderPageCanvas(");
  check("renderPageCanvas plans from Editor.ownedAnnots(i) for the page it paints",
    /editing \? await window\.AnnotHide\.plan\(window\.Editor\.ownedAnnots\(i\), page\) : null/.test(renderFn), true);
  check("…paints through AnnotHide.render with the document's storage when there is a plan",
    /window\.AnnotHide\.render\(page, params, hide, pdfjsLib\.AnnotationMode, state\.pdf\.annotationStorage\)/.test(renderFn), true);
  check("…and no longer switches every annotation off for the whole edit mode",
    /editing \? pdfjsLib\.AnnotationMode\.DISABLE/.test(renderFn), false);
  // §3.4-3: the redaction raster is the page's ONLY content afterwards, so whatever it does not
  // paint is gone from the file — it must hide our owned annots and paint everyone else's.
  const raster = body(BAKE, "async function rasterRedacted(");
  check("rasterRedacted plans from ed._owned for the page it rasterises",
    /const hide = await window\.AnnotHide\.plan\(ed\._owned\.get\(i\) \|\| null, page\);/.test(raster), true);
  check("…and paints through AnnotHide.render with the document's storage",
    /window\.AnnotHide\.render\(page, \{ canvasContext: cx, viewport: vp \}, hide,\s*pdfjsLib\.AnnotationMode, state\.pdf\.annotationStorage\)\.promise/.test(raster), true);
  check("…and no longer drops every annotation on a page that holds one of ours",
    /AnnotationMode\.DISABLE/.test(raster) || /_managedPages/.test(raster), false);
  const imp = body(BAKE, "async function importManaged()");
  check("importManaged re-learns ownership from the bytes it reads (reset first)",
    imp.indexOf("ed._owned = new Map()") >= 0 && imp.indexOf("ed._owned = new Map()") < imp.indexOf("PDFDocument.load"), true);
  check("…and owns exactly what the bake replaces, recorded with entryOf",
    /window\.ManagedCodec\.replacedOnBake\(doc, dict\)/.test(imp) && /window\.AnnotHide\.entryOf\(PDFLib, arr\.get\(j\), dict\)/.test(imp), true);
  check("stripManagedFromPage reads the same predicate (one rule, two readers)",
    /if \(!replacedOnBake\(doc, dict\)\) continue;/.test(body(MCSRC, "function stripManagedFromPage(")), true);
  check("Editor exposes ownedAnnots", /ownedAnnots: \(i\) => ed\._owned\.get\(i\) \|\| null,/.test(EDITOR), true);
  check("reset() forgets ownership", /ed\._owned = new Map\(\);/.test(body(EDITOR, "function reset()")), true);
  const html = read("index.html");
  check("index.html loads annot-hide.js", /<script src="annot-hide\.js"><\/script>/.test(html), true);

  console.log(`\nannot-hide: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e && e.stack);
  process.exit(1);
});
