"use strict";

// Regression net for page-range arithmetic (renderer/page-range.js) — the maths
// behind "Xoá nhiều trang theo khoảng" and the page-spec fields. A silent
// off-by-one here deletes the wrong page of a real document, so this is the one
// piece of the new page-ops work that gets an automated grid.
//
// Run:  node desktop/test/page-range.test.js      (or: npm run test:pages)

const PR = require("../renderer/page-range.js");

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

const spec = (s, n) => [...PR.parseSpec(s, n)].sort((x, y) => x - y);

// ---- parseSpec -----------------------------------------------------------

check("bare number → 0-based", spec("5", 10), [4]);
check("simple range", spec("2-4", 10), [1, 2, 3]);
check("mixed list", spec("1-3,5,8-10", 10), [0, 1, 2, 4, 7, 8, 9]);
check("spaces tolerated", spec(" 1 - 3 , 5 ", 10), [0, 1, 2, 4]);
check("semicolon separator", spec("1;3", 10), [0, 2]);
check("reversed pair swaps", spec("7-3", 10), [2, 3, 4, 5, 6]);
check("clamped above page count", spec("8-99", 10), [7, 8, 9]);
check("clamped below 1", spec("0", 10), [0]);
check("duplicates collapse", spec("2,2,1-2", 10), [0, 1]);
check("en dash accepted", spec("2–4", 10), [1, 2, 3]);
check("junk token skipped", spec("abc,3", 10), [2]);
check("leading dash is junk, not negative", spec("-3,5", 10), [4]);
check("empty spec → empty", spec("", 10), []);
check("null spec → empty", spec(null, 10), []);
check("zero pages → empty", spec("1-5", 0), []);

// ---- computeRange --------------------------------------------------------

check("plain range", PR.computeRange(2, 5, "", 10).indices, [1, 2, 3, 4]);
check("range minus one page", PR.computeRange(2, 5, "3", 10).indices, [1, 3, 4]);
check("range minus a sub-range", PR.computeRange(1, 10, "3-8", 10).indices, [0, 1, 8, 9]);
check(
  "exceptions outside the range are ignored",
  PR.computeRange(2, 4, "9", 10).indices,
  [1, 2, 3]
);
check("single page", PR.computeRange(7, 7, "", 10).indices, [6]);
check("reversed from/to swaps", PR.computeRange(5, 2, "", 10).indices, [1, 2, 3, 4]);
check("out-of-range clamps", PR.computeRange(0, 999, "1-9", 10).indices, [9]);
check("kept counts the survivors", PR.computeRange(1, 4, "2", 10).kept, 7);

// Refusals — each must be reported, never silently "fixed".
check("everything excluded → empty", PR.computeRange(2, 4, "2-4", 10).error, "empty");
check("whole document → all", PR.computeRange(1, 10, "", 10).error, "all");
check("whole doc via clamping → all", PR.computeRange(1, 500, "", 10).error, "all");
check("no document → no-doc", PR.computeRange(1, 5, "", 0).error, "no-doc");
check("valid request has no error", PR.computeRange(1, 9, "", 10).error, null);
// Guard case: leaving exactly one page is legal, taking that last one is not.
check("leaving 1 page is allowed", PR.computeRange(1, 9, "", 10).indices.length, 9);

// ---- formatList ----------------------------------------------------------

check("empty list", PR.formatList([]), "");
check("single page is 1-based", PR.formatList([0]), "1");
check("consecutive pages collapse", PR.formatList([0, 1, 2]), "1–3");
check("mixed groups", PR.formatList([0, 2, 3, 4, 8]), "1, 3–5, 9");
check("unsorted input is sorted", PR.formatList([8, 0, 3, 2, 4]), "1, 3–5, 9");
check("pairs stay explicit", PR.formatList([0, 1]), "1–2");
check(
  "long lists are truncated",
  PR.formatList([0, 2, 4, 6, 8, 10, 12, 14, 16, 18], 3),
  "1, 3, 5…"
);

// ---- extractFileName -----------------------------------------------------

const fn = (n, base = "HopDong") => PR.extractFileName(base, [...Array(n).keys()]);

// Small selections keep the friendly explicit form (unchanged behaviour).
check("single page", PR.extractFileName("HopDong", [0]), "HopDong-trang-1.pdf");
check("a few pages listed", PR.extractFileName("HopDong", [0, 2, 4]), "HopDong-trang-1_3_5.pdf");
check("50 pages still explicit", fn(50).startsWith("HopDong-trang-1_2_3_"), true);
check("no pages → base only", PR.extractFileName("HopDong", []), "HopDong.pdf");
check("empty base falls back", PR.extractFileName("", [0]), "document-trang-1.pdf");

// The regression: an unbounded name used to reach the Windows save dialog.
check("200 pages fits the budget", fn(200).length <= 200, true);
check("200 pages collapses to a range", fn(200), "HopDong-trang-1-200.pdf");
check("2000 pages fits the budget", fn(2000).length <= 200, true);
check(
  "scattered big selection is summarised and bounded",
  PR.extractFileName("HopDong", [...Array(300).keys()].filter((i) => i % 2 === 0)).length <= 200,
  true
);
check(
  "scattered summary uses filename-safe separators",
  /^[^\\/:*?"<>|]+$/.test(
    PR.extractFileName("HopDong", [...Array(300).keys()].filter((i) => i % 2 === 0))
  ),
  true
);
// An oversized base name must be trimmed, never the page part.
const longBase = "x".repeat(400);
const longName = PR.extractFileName(longBase, [0, 1, 2]);
check("oversized base is trimmed", longName.length <= 200, true);
// The page part collapses first (it's the cheaper cut), then the base is trimmed —
// so the pages survive in summary form, which is what makes the file identifiable.
check("oversized base keeps the page part", longName.endsWith("-trang-1-3.pdf"), true);
check("oversized base is what got cut", longName.startsWith("xxxx"), true);
// Guard case: prove the OLD naming really did overflow, so this test can't pass
// vacuously if the budget check is ever removed.
check(
  "guard — naming every page overflows 255",
  `HopDong-trang-${[...Array(200).keys()].map((i) => i + 1).join("_")}.pdf`.length > 255,
  true
);

// ---- contiguousRun / replacePlan (Thay trang, v0.2.72) ----------------------

check("run: single page", PR.contiguousRun([4]), { start: 4, count: 1 });
check("run: unsorted contiguous", PR.contiguousRun(new Set([5, 3, 4])), { start: 3, count: 3 });
check("run: duplicates ignored", PR.contiguousRun([2, 2, 3]), { start: 2, count: 2 });
check("run: a gap is refused", PR.contiguousRun([1, 4]), null);
check("run: empty is refused", PR.contiguousRun([]), null);
check("run: junk only is refused", PR.contiguousRun(["a", -1, 1.5]), null);

check("plan: all source pages", PR.replacePlan([2], 10, "", 3), { start: 2, remove: 1, take: [0, 1, 2], error: null });
check("plan: null spec = all", PR.replacePlan([2], 10, null, 2).take, [0, 1]);
check("plan: whitespace spec = all", PR.replacePlan([2], 10, "   ", 2).take, [0, 1]);
check("plan: chosen pages, ascending", PR.replacePlan([2], 10, "4, 1-2", 5).take, [0, 1, 3]);
check("plan: en dash from Word", PR.replacePlan([0], 3, "2–3", 5).take, [1, 2]);
check("plan: range of targets", PR.replacePlan(new Set([3, 4, 5]), 10, "1", 2), { start: 3, remove: 3, take: [0], error: null });
check("plan: overlarge source number clamps", PR.replacePlan([0], 3, "99", 4).take, [3]);
check("plan: gap refused", PR.replacePlan([1, 3], 10, "", 2).error, "gap");
check("plan: nothing selected refused", PR.replacePlan([], 10, "", 2).error, "gap");
check("plan: selection past the end refused", PR.replacePlan([9, 10], 10, "", 2).error, "gap");
check("plan: junk spec refused", PR.replacePlan([0], 3, "abc", 4).error, "empty");
check("plan: empty source refused", PR.replacePlan([0], 3, "", 0).error, "no-src");
check("plan: empty doc refused", PR.replacePlan([0], 0, "", 3).error, "no-doc");

// ---- replaceInDoc against REAL pdf-lib documents ----------------------------
//
// Pages are told apart by their WIDTH (target pages 100+i pt wide, source pages
// 500+i), so the assertion reads the actual page tree after save → reload, not
// our own bookkeeping.

const { PDFDocument } = require("pdf-lib");
async function mk(n, base) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([base + i, 200]);
  return d;
}
const widths = async (d) => (await PDFDocument.load(await d.save())).getPages().map((p) => Math.round(p.getWidth()));

// ---- movePageInDoc (reorderPage, Đợt 1 of docs/RESEARCH-2026-10-05-…) ----------
//
// reorderPage used to rebuild the document (create() + copyPages) and lost everything on
// the catalog — bookmarks first of all. These cases run the in-place move on REAL pdf-lib
// documents, save → reload, and read the result back from the file.

const { PDFName, PDFString, PDFArray } = require("pdf-lib");

// Two bookmarks — "A" → page index 0, "B" → page index 3 — and an (empty) form, written
// the plain way a PDF producer does it: /Outlines with /First /Last, items linked by
// /Next /Prev, each with an explicit /Dest [pageRef /Fit].
function addOutline(doc) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const rootRef = ctx.nextRef();
  const aRef = ctx.nextRef();
  const bRef = ctx.nextRef();
  const item = (title, page, extra) =>
    ctx.obj({ Title: PDFString.of(title), Parent: rootRef, Dest: [pages[page].ref, "Fit"], ...extra });
  ctx.assign(aRef, item("A", 0, { Next: bRef }));
  ctx.assign(bRef, item("B", 3, { Prev: aRef }));
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: aRef, Last: bRef, Count: 2 }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [] }));
}

// Where each bookmark points, as the WIDTH of its target page and that page's index —
// read from the saved file, so a dangling or stale ref cannot pass.
async function outlineTargets(d) {
  const re = await PDFDocument.load(await d.save());
  const outlines = re.catalog.lookup(PDFName.of("Outlines"));
  if (!outlines) return null;
  const refs = re.getPages().map((p) => p.ref);
  const out = [];
  for (let it = outlines.lookup(PDFName.of("First")); it; it = it.lookup(PDFName.of("Next"))) {
    const dest = it.lookup(PDFName.of("Dest"), PDFArray);
    const idx = refs.indexOf(dest.get(0));
    out.push([it.lookup(PDFName.of("Title")).decodeText(), idx, idx >= 0 ? Math.round(re.getPage(idx).getWidth()) : null]);
  }
  return out;
}

// A NESTED page tree: root → [p0, mid → [p1, p2], p3], where `mid` carries
// /MediaBox [0 0 333 222] and /Rotate 90 that p1, p2 do NOT have themselves (they
// inherit them). p0, p3 keep their own MediaBox and have no /Rotate anywhere. Reloaded,
// so pdf-lib parses the tree from bytes like it would a real file.
async function nestedDoc() {
  const d = await mk(4, 100);
  const ctx = d.context;
  const [p0, p1, p2, p3] = d.getPages();
  const rootRef = d.catalog.get(PDFName.of("Pages"));
  const midRef = ctx.register(
    ctx.obj({ Type: "Pages", Kids: [p1.ref, p2.ref], Count: 2, Parent: rootRef, MediaBox: [0, 0, 333, 222], Rotate: 90 })
  );
  for (const p of [p1, p2]) {
    p.node.delete(PDFName.of("MediaBox"));
    p.node.set(PDFName.of("Parent"), midRef);
  }
  d.catalog.Pages().set(PDFName.of("Kids"), ctx.obj([p0.ref, midRef, p3.ref]));
  return PDFDocument.load(await d.save());
}
const geom = async (d) =>
  (await PDFDocument.load(await d.save())).getPages().map((p) => [Math.round(p.getWidth()), p.getRotation().angle]);

async function moveCases() {
  // Same result as the old splice arithmetic, for EVERY (from, to) on a 5-page document.
  const N = 5;
  let bad = [];
  for (let from = 0; from < N; from++) {
    for (let to = 0; to < N; to++) {
      const order = [...Array(N).keys()];
      const [m] = order.splice(from, 1);
      order.splice(to, 0, m);
      const d = await mk(N, 100);
      const changed = PR.movePageInDoc(d, from, to);
      const got = await widths(d);
      const want = order.map((i) => 100 + i);
      if (JSON.stringify(got) !== JSON.stringify(want) || changed !== (from !== to)) bad.push([from, to, got]);
    }
  }
  check("move: matches reorderPage's splice order for all 25 (from, to)", bad, []);

  let threw = 0;
  for (const [f, t] of [[-1, 0], [0, 5], [5, 0], [1.5, 0], [0, NaN]]) {
    const d = await mk(5, 100);
    try { PR.movePageInDoc(d, f, t); } catch (_) { threw++; }
  }
  check("move: out-of-range / non-integer indices throw", threw, 5);

  // The reason for Đợt 1. First record what the OLD rebuild did, so this file says why.
  let d = await mk(5, 100);
  addOutline(d);
  const out = await PDFDocument.create();
  (await out.copyPages(d, [1, 2, 3, 4, 0])).forEach((p) => out.addPage(p));
  check("baseline: the old create()+copyPages rebuild DROPS the bookmarks", await outlineTargets(out), null);

  d = await mk(5, 100);
  addOutline(d);
  PR.movePageInDoc(d, 0, 4); // page "A" points at goes last
  check("move: bookmarks survive and follow their page (A → idx 4, B → idx 2)", await outlineTargets(d),
        [["A", 4, 100], ["B", 2, 103]]);
  const re = await PDFDocument.load(await d.save());
  check("move: the form (/AcroForm) survives", !!re.catalog.get(PDFName.of("AcroForm")), true);

  // Nested tree, inheritance. Before: [p0 100/0°, p1 333/90°, p2 333/90°, p3 103/0°].
  d = await nestedDoc();
  check("nested: fixture really inherits (sanity)", await geom(d), [[100, 0], [333, 90], [333, 90], [103, 0]]);
  // p1 leaves `mid` for the root: must KEEP the 333-wide box and the 90° it inherited.
  PR.movePageInDoc(d, 1, 3);
  check("nested: a page moved OUT of its parent keeps inherited MediaBox + Rotate", await geom(d),
        [[100, 0], [333, 90], [103, 0], [333, 90]]);
  // p0 (no /Rotate anywhere = default 0) is dropped INTO `mid` (/Rotate 90): must stay 0°.
  d = await nestedDoc();
  PR.movePageInDoc(d, 0, 1);
  check("nested: a page moved INTO a rotated parent keeps its default 0°", await geom(d),
        [[333, 90], [100, 0], [333, 90], [103, 0]]);
}

(async () => {
  let doc = await mk(5, 100);
  let src = await mk(4, 500);
  const n = await PR.replaceInDoc(doc, src, PR.replacePlan([2], 5, "", 4));
  check("real: replace page 3 with all 4", await widths(doc), [100, 101, 500, 501, 502, 503, 103, 104]);
  check("real: returns inserted count", n, 4);
  check("real: source untouched", await widths(src), [500, 501, 502, 503]);

  doc = await mk(5, 100);
  src = await mk(4, 500);
  await PR.replaceInDoc(doc, src, PR.replacePlan([1, 2, 3], 5, "4, 2", 4));
  check("real: replace 2-4 with source 2,4", await widths(doc), [100, 501, 503, 104]);

  doc = await mk(3, 100);
  src = await mk(2, 500);
  await PR.replaceInDoc(doc, src, PR.replacePlan([0, 1, 2], 3, "", 2));
  check("real: replace EVERY page (never an empty tree)", await widths(doc), [500, 501]);

  doc = await mk(3, 100);
  src = await mk(3, 500);
  await PR.replaceInDoc(doc, src, PR.replacePlan([2], 3, "1", 3));
  check("real: replace the LAST page", await widths(doc), [100, 101, 500]);

  doc = await mk(3, 100);
  src = await mk(3, 500);
  await PR.replaceInDoc(doc, src, PR.replacePlan([0], 3, "3", 3));
  check("real: replace the FIRST page", await widths(doc), [502, 101, 102]);

  let threw = false;
  try {
    await PR.replaceInDoc(doc, src, { error: "gap" });
  } catch (_) {
    threw = true;
  }
  check("real: an error plan is refused, doc untouched", [threw, await widths(doc)], [true, [502, 101, 102]]);

  await moveCases();

  console.log(`\npage-range: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
