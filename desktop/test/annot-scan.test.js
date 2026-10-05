"use strict";

// Regression net for renderer/annot-scan.js — the reader behind the left column's "Chú thích"
// list (Đợt 2b of docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md).
//
// Everything here runs on REAL pdf-lib documents (save → reload, so the reader parses bytes,
// not objects we still hold), and Nabu's own annotations are built with the REAL
// serializeManaged from managed-codec.js — the exact payload editor-bake.js writes — so a
// change to that format turns this red instead of silently blanking the list.
//
// The worker half is exercised too: the file is run in a vm sandbox that looks like a
// WorkerGlobalScope (no window, no module, an importScripts), and spoken to by message.
//
// Run:  node desktop/test/annot-scan.test.js      (or: npm run test:annotscan)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const PDFLib = require("pdf-lib");
const { PDFDocument, PDFName, PDFHexString, PDFString } = PDFLib;
const A = require("../renderer/annot-scan.js");
const M = require("../renderer/managed-codec.js");

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

// ---- 1. small readers ----------------------------------------------------------------

check("colorOf gray", A.colorOf([0.5]), "#808080");
check("colorOf rgb", A.colorOf([1, 0, 0]), "#ff0000");
check("colorOf cmyk (naive)", A.colorOf([0, 1, 1, 0]), "#ff0000");
check("colorOf rejects junk", [A.colorOf(null), A.colorOf([]), A.colorOf([1, "x", 0]), A.colorOf([1, 2])], [null, null, null, null]);
check("FreeText colour: /DS wins over /DA (Acrobat writes DA white)", A.freeTextColor("font-family:Arial;color:#FF0000;", "1 1 1 rg /F1 10 Tf"), "#ff0000");
check("FreeText colour: /DA rg when no /DS", A.freeTextColor("", "0 0 1 rg /Helv 12 Tf"), "#0000ff");
check("FreeText colour: /DA g", A.freeTextColor("", "0 g /Helv 12 Tf"), "#000000");
check("FreeText colour: none", A.freeTextColor("", ""), null);
check("dateOf PDF date", A.dateOf("D:20260617114210+07'00'"), "2026-06-17");
check("dateOf year only", A.dateOf("D:2026"), "2026-01-01");
check("dateOf junk", A.dateOf("hôm qua"), null);
check("plainFromRich: tags, breaks, entities", A.plainFromRich('<?xml version="1.0"?><body><p>Điều 5 &amp; 6</p><p>sửa &lt;lại&gt;</p></body>'), "Điều 5 & 6\nsửa <lại>");

// ---- 2. labels -----------------------------------------------------------------------

check("label: Nabu kind wins over subtype", A.labelOf({ kind: "text", subtype: "Stamp" }), "Hộp văn bản");
check("label: callout", A.labelOf({ subtype: "FreeText", it: "FreeTextCallout" }), "Hộp văn bản có mũi tên");
check("label: Line with arrowhead = arrow", A.labelOf({ subtype: "Line", arrow: true }), "Mũi tên");
check("label: plain Line", A.labelOf({ subtype: "Line", arrow: false }), "Đường kẻ");
check("label: cloudy Square = revision cloud", A.labelOf({ subtype: "Square", cloudy: true }), "Khoanh mây");
check("label: unknown subtype falls back to its name", A.labelOf({ subtype: "Weird" }), "Weird");

// Every overlay kind editor.js can create must have a label — a new kind added there without
// one would show its raw code name in the list.
const editorSrc = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");
const literalKinds = [...new Set([...editorSrc.matchAll(/\bkind: "([a-z]+)"/g)].map((m) => m[1]))];
const toolKinds = [...new Set([...fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8").matchAll(/data-tool="([a-z]+)"/g)].map((m) => m[1]))]
  .filter((t) => t !== "select" && t !== "measure"); // select draws nothing; measure creates kind "dim"
check("every editor kind has a label", [...literalKinds, ...toolKinds, ...M.MANAGED_KINDS].filter((k) => !A.KIND_LABEL[k]), []);

// Every label must have an English entry (side-panels.js passes them through tr()).
const i18n = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
const labels = [...new Set([...Object.values(A.KIND_LABEL), ...Object.values(A.SUBTYPE_LABEL), ...Object.values(A.EXTRA_LABEL)])];
check("every label is in the i18n dictionary", labels.filter((l) => !i18n.includes(JSON.stringify(l) + ":")), []);

// ---- 3. scanDoc on a real document ---------------------------------------------------

async function build() {
  const doc = await PDFDocument.create();
  const p0 = doc.addPage([595, 842]);
  const p1 = doc.addPage([595, 842]);
  const ctx = doc.context;
  const add = (page, dict) => {
    const ref = ctx.register(ctx.obj(dict));
    let arr = page.node.Annots();
    if (!arr) {
      arr = ctx.obj([]);
      page.node.set(PDFName.of("Annots"), arr);
    }
    arr.push(ref);
    return ref;
  };
  const T = (s) => PDFHexString.fromText(s);

  // page 1 — "another program", shaped like the customer's Acrobat file (§3.5)
  add(p0, { Type: "Annot", Subtype: "FreeText", Rect: [100, 700, 300, 740], Contents: T("Điều 5 sửa lại"),
            T: T("hang_"), M: PDFString.of("D:20260617114210+07'00'"), DA: PDFString.of("1 1 1 rg /F1 10 Tf"),
            DS: PDFString.of("font-family:Arial;font-size:10pt;color:#FF0000;"), C: [1, 1, 1], NM: PDFString.of("uuid-1") });
  add(p0, { Type: "Annot", Subtype: "FreeText", IT: "FreeTextCallout", Rect: [50, 500, 300, 600], Contents: T("Callout"),
            LE: "OpenArrow", DS: PDFString.of("color:#000000;") });
  add(p0, { Type: "Annot", Subtype: "Square", Rect: [10, 10, 60, 60], C: [1, 0, 0], BE: { S: "C", I: 1 } });
  add(p0, { Type: "Annot", Subtype: "Line", Rect: [0, 0, 100, 20], L: [0, 0, 100, 20], LE: ["None", "OpenArrow"], C: [1, 0, 0] });
  add(p0, { Type: "Annot", Subtype: "Line", Rect: [0, 0, 100, 20], L: [0, 0, 100, 20], C: [1, 0, 0] });
  const note = add(p0, { Type: "Annot", Subtype: "Text", Rect: [400, 800, 420, 820], Contents: T("Ghi chú gốc"), T: T("Partner B") });
  add(p0, { Type: "Annot", Subtype: "Popup", Rect: [420, 700, 600, 800], Parent: note });
  add(p0, { Type: "Annot", Subtype: "Text", Rect: [400, 800, 420, 820], Contents: T("trả lời 1"), IRT: note });
  add(p0, { Type: "Annot", Subtype: "Text", Rect: [400, 800, 420, 820], Contents: T("trả lời 2"), IRT: note });
  add(p0, { Type: "Annot", Subtype: "Text", Rect: [400, 780, 420, 800], Contents: T("nhóm"), IRT: note, RT: "Group" });
  add(p0, { Type: "Annot", Subtype: "Square", Rect: [0, 0, 5, 5], F: 2 }); // Hidden → not listed
  add(p0, { Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5] });
  add(p0, { Type: "Annot", Subtype: "Widget", Rect: [0, 0, 5, 5], FT: "Tx" });
  add(p0, { Type: "Annot", Subtype: "FreeText", Rect: [0, 0, 5, 5], RC: T("<body><p>chỉ có rich text</p></body>") });
  add(p0, { Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 5, 5], C: [0, 1, 1, 0] });
  add(p0, { Type: "Annot", Subtype: "Text", Rect: [0, 0, 5, 5], Contents: T("mồ côi"), IRT: ctx.nextRef() }); // parent missing
  // junk that must not stop the scan: a non-dict entry and a dict with a broken /Rect
  p0.node.Annots().push(ctx.obj(42));
  add(p0, { Type: "Annot", Subtype: "Ink", Rect: ["a", "b"] });

  // page 2 — Nabu's own, payloads from the REAL serializer
  const nabu = (page, subtype, kind, a, extra) => {
    const d = ctx.obj({ Type: "Annot", Subtype: subtype, Rect: [100, 100, 200, 150], ...(extra || {}) });
    d.set(PDFName.of("NabuKind"), PDFName.of(kind));
    d.set(PDFName.of("NabuData"), PDFHexString.fromText(JSON.stringify(M.serializeManaged(a))));
    const ref = ctx.register(d);
    let arr = page.node.Annots();
    if (!arr) {
      arr = ctx.obj([]);
      page.node.set(PDFName.of("Annots"), arr);
    }
    arr.push(ref);
  };
  nabu(p1, "Stamp", "text", { kind: "text", x: 1, y: 2, w: 3, h: 4, text: "Xin chào Nabu", font: "sans", fontSize: 14, color: "#112233" });
  nabu(p1, "Stamp", "arrow", { kind: "arrow", x1: 0, y1: 0, x2: 9, y2: 9, color: "#00ff00", width: 2, label: "Nhãn mũi tên" });
  nabu(p1, "Text", "note", { kind: "note", x: 0, y: 0, w: 18, h: 18, text: "Ghi chú Nabu", color: "#ffd54a", replies: [] }, { Contents: T("Ghi chú Nabu") });
  // a payload a foreign editor mangled: still listed, labelled by its kind
  const bad = ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 1, 1], C: [0, 0, 1] });
  bad.set(PDFName.of("NabuKind"), PDFName.of("box"));
  bad.set(PDFName.of("NabuData"), PDFString.of("{not json"));
  p1.node.Annots().push(ctx.register(bad));
  return doc;
}

const view = (items) =>
  items.map((it) => [it.page, A.labelOf(it), it.kind, it.text, it.author, it.color, it.date, it.replies]);

(async () => {
  const bytes = await (await build()).save();
  const items = await A.scanAnnots(PDFLib, bytes);
  check("scan: what the list shows, in order", view(items), [
    [0, "Hộp văn bản", null, "Điều 5 sửa lại", "hang_", "#ff0000", "2026-06-17", 0],
    [0, "Hộp văn bản có mũi tên", null, "Callout", "", "#000000", null, 0],
    [0, "Khoanh mây", null, "", "", "#ff0000", null, 0],
    [0, "Mũi tên", null, "", "", "#ff0000", null, 0],
    [0, "Đường kẻ", null, "", "", "#ff0000", null, 0],
    [0, "Ghi chú", null, "Ghi chú gốc", "Partner B", null, null, 2],
    [0, "Ghi chú", null, "nhóm", "", null, null, 0],
    [0, "Hộp văn bản", null, "chỉ có rich text", "", null, null, 0],
    [0, "Con dấu / ảnh", null, "", "", "#ff0000", null, 0],
    // the Ink with a broken /Rect is still an annotation on the page: listed (rect 0,0,0,0 →
    // a click goes to the page), never silently dropped. The non-dict entry is skipped.
    [0, "Nét vẽ tay", null, "", "", null, null, 0],
    [1, "Hộp văn bản", "text", "Xin chào Nabu", "", "#112233", null, 0],
    [1, "Mũi tên", "arrow", "Nhãn mũi tên", "", "#00ff00", null, 0],
    [1, "Ghi chú", "note", "Ghi chú Nabu", "", "#ffd54a", null, 0],
    [1, "Hình chữ nhật", "box", "", "", "#0000ff", null, 0],
    [0, "Ghi chú", null, "mồ côi", "", null, null, 0],
  ]);
  check("scan: rect normalised, ref kept", [items[0].rect, /^\d+ 0 R$/.test(items[0].ref)], [[100, 700, 300, 740], true]);
  check("scan: a broken /Rect reads as zeros", items[9].rect, [0, 0, 0, 0]);

  // ---- 4. the worker protocol, in a sandbox that looks like a WorkerGlobalScope ----------
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "annot-scan.js"), "utf8");
  const posted = [];
  const imported = [];
  const sandbox = {
    console,
    importScripts: (u) => {
      imported.push(u);
      sandbox.self.PDFLib = PDFLib; // what vendor/pdf-lib.min.js does in a worker
    },
    postMessage: (m) => posted.push(m),
    TextDecoder, Uint8Array, Map, Set, JSON, Promise,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  check("worker: loads pdf-lib from vendor/, relative to itself", imported, ["vendor/pdf-lib.min.js"]);
  check("worker: publishes nothing on a window", typeof sandbox.window, "undefined");
  const copy = bytes.slice();
  await sandbox.onmessage({ data: { id: 7, bytes: copy.buffer } });
  check("worker: answers by id with the same items", [posted[0].id, posted[0].ok, posted[0].items.length, posted[0].worker], [7, true, items.length, true]);
  await sandbox.onmessage({ data: { id: 8, bytes: new Uint8Array([1, 2, 3]).buffer } });
  check("worker: a broken file is an error reply, not a dead worker", [posted[1].id, posted[1].ok, typeof posted[1].error], [8, false, "string"]);

  console.log(`\nannot-scan: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
