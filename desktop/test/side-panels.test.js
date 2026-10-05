"use strict";

// Regression net for the left column's modes (renderer/side-panels.js, Đợt 2 of
// docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md).
//
// The DOM half only runs in the app (probe it); what runs here is the part that can be wrong
// silently: turning pdf.js's outline into page indices. A bookmark that resolves to the
// wrong page looks like it works — the panel scrolls somewhere — so the cases below check
// the page AND the target point, first on mock documents (every destination shape the PDF
// spec has), then on a REAL file written by pdf-lib and read back by the shipped pdf.js,
// including one whose bookmarked page was deleted (the BI-96 "Kid reference not found" case).
//
// Run:  node desktop/test/side-panels.test.js      (or: npm run test:side)

const fs = require("fs");
const path = require("path");
const SP = require("../renderer/side-panels.js");
const { PDFDocument, PDFName, PDFString, PDFHexString } = require("pdf-lib");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

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

// Compact view of a resolved tree: [title, page, top, left, open, children…]
const flat = (nodes) => nodes.map((n) => [n.title, n.page, n.top, n.left, n.open, ...(n.children.length ? [flat(n.children)] : [])]);

// ---- 1. destTarget: every destination shape -------------------------------------

const R = { num: 1, gen: 0 };
check("XYZ → left + top", SP.destTarget([R, { name: "XYZ" }, 72, 700, 0]), { left: 72, top: 700 });
check("XYZ with null top → page only", SP.destTarget([R, { name: "XYZ" }, null, null, null]), { left: null, top: null });
check("FitH → top", SP.destTarget([R, { name: "FitH" }, 500]), { left: null, top: 500 });
check("FitBH → top", SP.destTarget([R, { name: "FitBH" }, 420]), { left: null, top: 420 });
check("FitR → its TOP is the 4th number", SP.destTarget([R, { name: "FitR" }, 10, 20, 300, 640]), { left: 10, top: 640 });
check("Fit → page only", SP.destTarget([R, { name: "Fit" }]), { left: null, top: null });
check("FitV → page only", SP.destTarget([R, { name: "FitV" }, 100]), { left: null, top: null });
check("no kind at all → page only", SP.destTarget([R]), { left: null, top: null });

// ---- 2. resolveOutline on mock pdf.js documents ----------------------------------

function mockPdf(outline, { named = {}, pages = { "1": 0, "2": 1, "3": 2 }, numPages = 3 } = {}) {
  return {
    numPages,
    getOutline: async () => outline,
    getDestination: async (name) => {
      if (!(name in named)) throw new Error("no such destination");
      return named[name];
    },
    getPageIndex: async (ref) => {
      const k = String(ref.num);
      if (!(k in pages)) throw new Error("Kid reference not found in parent's kids.");
      return pages[k];
    },
  };
}
const ref = (n) => ({ num: n, gen: 0 });

(async () => {
  check("no outline (null) → []", await SP.resolveOutline(mockPdf(null)), []);
  check("empty outline → []", await SP.resolveOutline(mockPdf([])), []);

  const tree = await SP.resolveOutline(
    mockPdf(
      [
        {
          title: "  Chương 1  ",
          dest: [ref(1), { name: "XYZ" }, 0, 700, 0],
          items: [
            { title: "Điều 1", dest: "d-dieu1", items: [] },
            { title: "Điều 2", dest: [ref(2), { name: "FitH" }, 400], items: [] },
          ],
        },
        { title: "Đóng sẵn", count: -2, dest: [ref(2), { name: "Fit" }], items: [{ title: "con", dest: [1, { name: "Fit" }], items: [] }] },
        { title: "Trang đã xoá", dest: [ref(9), { name: "Fit" }], items: [] },
        { title: "Tên hỏng", dest: "khong-co", items: [] },
        { title: "Ngoài phạm vi", dest: [7, { name: "Fit" }], items: [] },
        { title: "Web", url: "https://example.com", dest: null, items: [] },
      ],
      { named: { "d-dieu1": [ref(3), { name: "XYZ" }, null, 300, null] } }
    )
  );
  check("tree shape, pages and targets", flat(tree), [
    ["Chương 1", 0, 700, 0, true, [["Điều 1", 2, 300, null, true], ["Điều 2", 1, 400, null, true]]],
    ["Đóng sẵn", 1, null, null, false, [["con", 1, null, null, true]]],
    ["Trang đã xoá", null, null, null, true],
    ["Tên hỏng", null, null, null, true],
    ["Ngoài phạm vi", null, null, null, true],
    ["Web", null, null, null, true],
  ]);
  check("an external link keeps its URL", tree[5].url, "https://example.com");
  check("an integer dest[0] is a page index, not a ref", tree[1].children[0].page, 1);

  const styled = await SP.resolveOutline(
    mockPdf([
      { title: "Đỏ đậm", bold: true, italic: true, color: new Uint8ClampedArray([200, 0, 0]), dest: [ref(1), { name: "Fit" }], items: [] },
      { title: "Đen", color: new Uint8ClampedArray([0, 0, 0]), dest: [ref(1), { name: "Fit" }], items: [] },
      { title: "", dest: [ref(1), { name: "Fit" }], items: [] },
    ])
  );
  check("bold / italic / colour carried", [styled[0].bold, styled[0].italic, styled[0].color], [true, true, "rgb(200, 0, 0)"]);
  check("pure black is the default, not a colour", styled[1].color, null);
  check("an empty title stays empty (the panel shows '(không tên)')", styled[2].title, "");

  // ---- 3. a REAL file: pdf-lib writes it, the shipped pdf.js reads it -----------------

  async function makeDoc() {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([595, 842]);
    const ctx = doc.context;
    const p = doc.getPages();
    const rootRef = ctx.nextRef();
    const refs = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
    const items = [
      { title: "Chương 1", dest: [p[0].ref, "XYZ", 0, 700, 0] },
      { title: "Chương 2", dest: [p[1].ref, "FitH", 500] },
      { title: "Tên", dest: PDFString.of("muc-ten") },
      { title: "Phụ lục", dest: [p[2].ref, "Fit"] },
    ];
    items.forEach((it, k) => {
      // UTF-16 (hex) titles, as real producers write Vietnamese — PDFString.of would be PDFDocEncoding.
      const d = { Title: PDFHexString.fromText(it.title), Parent: rootRef, Dest: it.dest };
      if (k > 0) d.Prev = refs[k - 1];
      if (k < items.length - 1) d.Next = refs[k + 1];
      ctx.assign(refs[k], ctx.obj(d));
    });
    ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[3], Count: 4 }));
    doc.catalog.set(PDFName.of("Outlines"), rootRef);
    // A named destination the old way (/Dests in the catalog) — the "Tên" item uses it.
    doc.catalog.set(PDFName.of("Dests"), ctx.obj({ "muc-ten": [p[1].ref, "XYZ", null, 250, null] }));
    return doc;
  }
  const open = async (bytes) => pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 }).promise;

  let doc = await makeDoc();
  let pdf = await open(await doc.save());
  check("real pdf.js: every bookmark resolves to its page + point", flat(await SP.resolveOutline(pdf)), [
    ["Chương 1", 0, 700, 0, true],
    ["Chương 2", 1, 500, null, true],
    ["Tên", 1, 250, null, true],
    ["Phụ lục", 2, null, null, true],
  ]);
  await pdf.destroy();

  // Delete the last page IN PLACE (deletePages' way): its bookmark dangles. It must stay in
  // the tree (so the list matches what Foxit shows) but resolve to no page.
  doc = await makeDoc();
  doc.removePage(2);
  pdf = await open(await doc.save());
  check("real pdf.js: a bookmark to a deleted page is kept, page = null", flat(await SP.resolveOutline(pdf)), [
    ["Chương 1", 0, 700, 0, true],
    ["Chương 2", 1, 500, null, true],
    ["Tên", 1, 250, null, true],
    ["Phụ lục", null, null, null, true],
  ]);
  await pdf.destroy();

  // ---- 4. the Chú thích list: composition, order, filters ---------------------------------

  const file = [
    { page: 0, kind: null, subtype: "FreeText", author: "hang_", text: "đối tác" },
    { page: 0, kind: "text", subtype: "Stamp", author: "", text: "Nabu đã lưu" },
    { page: 2, kind: null, subtype: "Square", author: "tuyetpta", text: "" },
  ];
  const live = [{ id: 5, page: 1, kind: "box", text: "", top: 40 }, { id: 6, page: 0, kind: "text", text: "Nabu đang sửa", top: 10 }];
  const sum = (xs) => xs.map((x) => [x.page, x.live, x.kind, x.text]);
  check("view mode: the list IS the file (live objects ignored)", sum(SP.composeItems(file, live, false)), [
    [0, false, null, "đối tác"], [0, false, "text", "Nabu đã lưu"], [2, false, null, ""],
  ]);
  check("edit mode: overlay objects + ONLY other software's file items (no double Nabu copy)", sum(SP.composeItems(file, live, true)), [
    [1, true, "box", ""], [0, true, "text", "Nabu đang sửa"], [0, false, null, "đối tác"], [2, false, null, ""],
  ]);
  check("composeItems copies, never mutates its inputs", [file[0].live, live[0].live], [undefined, undefined]);
  check("nothing scanned + nothing live → empty", SP.composeItems(null, null, true), []);

  const its = [
    { page: 3, n: "c", y: 50 }, { page: 1, n: "a", y: 90 }, { page: 1, n: "b", y: 10 },
    { page: 3, n: "d", y: 50 }, { page: 0, n: "e", y: 0 },
  ];
  check("groupByPage: pages ascending, top-to-bottom inside, stable on ties",
    SP.groupByPage(its, (it) => it.y).map((g) => [g.page, g.items.map((x) => x.n)]),
    [[0, ["e"]], [1, ["b", "a"]], [3, ["c", "d"]]]);

  const lab = (it) => it.l;
  const pool = [{ l: "Ghi chú", author: "A" }, { l: "Mũi tên", author: "B" }, { l: "Ghi chú", author: "B" }, { l: "Ghi chú" }];
  check("filter: none", SP.filterItems(pool, lab, "", "").length, 4);
  check("filter: by type", SP.filterItems(pool, lab, "Ghi chú", "").length, 3);
  check("filter: by author (no author ≠ match)", SP.filterItems(pool, lab, "", "B").length, 2);
  check("filter: both", SP.filterItems(pool, lab, "Ghi chú", "B").length, 1);

  // ---- 5. wiring that can only be checked as text ------------------------------------

  const R_DIR = path.join(__dirname, "..", "renderer");
  const src = fs.readFileSync(path.join(R_DIR, "side-panels.js"), "utf8");
  const i18n = fs.readFileSync(path.join(R_DIR, "i18n.js"), "utf8");
  const html = fs.readFileSync(path.join(R_DIR, "index.html"), "utf8");

  const keys = [...src.matchAll(/\btr\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  check("side-panels.js has tr() strings to check (sanity)", keys.length > 5, true);
  check("every tr() key exists in the i18n dictionary", keys.filter((k) => !i18n.includes(`"${k}":`)), []);
  check(
    "runtime-rewritten ids are in SKIP_IDS (BI-10)",
    ["outline-tree", "outline-empty", "annots-count", "annots-list", "annots-empty", "annots-ftype", "annots-fauthor"]
      .filter((id) => !new RegExp(`SKIP_IDS[\\s\\S]{0,4000}"${id}"`).test(i18n)),
    []
  );
  check("the right-hand 'Ghi chú' panel is gone (Q2: one list, in the left column)", /id="comments-panel"/.test(html), false);
  const appSrc = fs.readFileSync(path.join(R_DIR, "app.js"), "utf8");
  check("app.js still publishes window.updateComments (editor.js calls it)", /window\.updateComments = updateComments;/.test(appSrc), true);
  const edSrc = fs.readFileSync(path.join(R_DIR, "editor.js"), "utf8");
  check("Editor exposes listObjects + focusObject, not the notes-only pair",
    [/\blistObjects,/.test(edSrc), /\bfocusObject,/.test(edSrc), /\bgetComments,/.test(edSrc), /\bfocusNote,/.test(edSrc)],
    [true, true, false, false]);
  // renderLayer, NOT syncOverlays: the 2b probe drew a box in the real editor and the list did
  // not change — drawing repaints its page with renderLayer and never calls syncOverlays.
  const rl = edSrc.slice(edSrc.indexOf("function renderLayer("), edSrc.indexOf("function noteThreadText("));
  check("renderLayer tells the list (the one place every model change passes)", /window\.updateComments\(\)/.test(rl), true);
  const tabs = [...html.matchAll(/class="side-tab[^"]*"[^>]*data-pane="([a-z]+)"/g)].map((m) => m[1]);
  const panes = [...html.matchAll(/class="side-pane"[^>]*data-pane="([a-z]+)"/g)].map((m) => m[1]);
  check("one tab per pane, same order as PANES", [tabs, panes], [SP.PANES, SP.PANES]);
  check("#thumbs still lives in the Trang pane", /data-pane="thumbs"[\s\S]{0,600}id="thumbs"/.test(html), true);

  console.log(`\nside-panels: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
