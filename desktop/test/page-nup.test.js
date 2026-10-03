"use strict";

// Regression net for N-up page layout (renderer/page-nup.js): "ghép 2 trang vào 1 tờ".
// The risks are silent: a /Rotate page drawn sideways, a CropBox ignored, a blank page
// that throws inside pdf-lib, an odd page count that drops the last page. This file
// checks the arithmetic as pure maths AND runs the real build against real pdf-lib
// documents. What it cannot check is how a viewer RENDERS the result — that was probed
// separately against MuPDF (see HANDOFF v0.2.76).
//
// Run:  node desktop/test/page-nup.test.js      (or: npm run test:nup)

const { PDFDocument, PDFName, PDFString, degrees, rgb } = require("pdf-lib");
const N = require("../renderer/page-nup.js");

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
const near = (name, a, b, eps = 1e-6) => check(name, Math.abs(a - b) <= eps ? "ok" : a, "ok");
const lib = { degrees, rgb };

// ---- options ------------------------------------------------------------------------
check("defaults", N.normOpts(), { per: 2, sheet: "a4", orient: "portrait", margin: 24, gap: 12, border: false });
check("per other than 4 → 2", N.normOpts({ per: 3 }).per, 2);
check("per 4 kept", N.normOpts({ per: "4" }).per, 4);
check("unknown sheet → a4", N.normOpts({ sheet: "zz" }).sheet, "a4");
check("proto key is not a sheet", N.normOpts({ sheet: "constructor" }).sheet, "a4");
check("margin clamped", N.normOpts({ margin: 9999 }).margin, 100);
check("negative gap clamped", N.normOpts({ gap: -5 }).gap, 0);
check("junk margin → default", N.normOpts({ margin: "abc" }).margin, 24);

// ---- sheet + cells ------------------------------------------------------------------
check("a4 portrait", N.sheetSize("a4", "portrait").map(Math.round), [595, 842]);
check("a4 landscape", N.sheetSize("a4", "landscape").map(Math.round), [842, 595]);
check("letter portrait", N.sheetSize("letter", "portrait"), [612, 792]);
check("a3 portrait", N.sheetSize("a3", "portrait").map(Math.round), [842, 1191]);

{
  const [W, H] = N.sheetSize("a4", "portrait");
  const c = N.cellRects(W, H, 2, 24, 12);
  check("2-up portrait = 2 cells stacked", c.length, 2);
  check("2-up first cell is the TOP one", c[0].y > c[1].y, true);
  near("cells same width", c[0].w, c[1].w);
  near("cell width = sheet - 2 margins", c[0].w, W - 48);
  near("cells + gap + margins fill the height", c[0].h + c[1].h + 12 + 48, H);
  near("no overlap: gap preserved", c[0].y - (c[1].y + c[1].h), 12);
  near("top margin", H - (c[0].y + c[0].h), 24);
  near("bottom margin", c[1].y, 24);
}
{
  const [W, H] = N.sheetSize("a4", "landscape");
  const c = N.cellRects(W, H, 2, 24, 12);
  check("2-up landscape = side by side", [c.length, c[0].x < c[1].x, c[0].y === c[1].y], [2, true, true]);
  const q = N.cellRects(W, H, 4, 24, 12);
  check("4-up = 4 cells", q.length, 4);
  check("4-up reading order: row by row", [q[0].x < q[1].x, q[0].y > q[2].y, q[2].x === q[0].x], [true, true, true]);
}
{
  const c = N.cellRects(595, 842, 2, 100, 100); // legal values, but leaves little room
  check("max margin+gap still leaves positive cells", c.every((r) => r.w >= 20 && r.h >= 20), true);
  const z = N.cellRects(595, 842, 2, 0, 0);
  near("zero margin: cell width = sheet width", z[0].w, 595);
  near("zero margin: cells tile the height", z[0].h + z[1].h, 842);
}

// ---- rotation / display size --------------------------------------------------------
check("display size 0", N.displaySize(842, 595, 0), { w: 842, h: 595 });
check("display size 90 swaps", N.displaySize(595, 842, 90), { w: 842, h: 595 });
check("display size 270 swaps", N.displaySize(595, 842, 270), { w: 842, h: 595 });
check("display size 180 keeps", N.displaySize(842, 595, 180), { w: 842, h: 595 });
check("negative rotation snaps", N.displaySize(10, 20, -90), { w: 20, h: 10 });
check("450 = 90", N.displaySize(10, 20, 450), { w: 20, h: 10 });

// Apply pdf-lib's drawPage transform (translate -> rotate -> scale) to the corners of the
// stored w x h box and compare with where the DISPLAYED rectangle must be. This is the
// independent check of placement(): it knows nothing about the formulas inside it.
function mapCorner(pl, s, u, v) {
  const a = (pl.angle * Math.PI) / 180;
  const x = s * u;
  const y = s * v;
  return { x: pl.x + x * Math.cos(a) - y * Math.sin(a), y: pl.y + x * Math.sin(a) + y * Math.cos(a) };
}
for (const rot of [0, 90, 180, 270]) {
  const w = 300;
  const h = 500;
  const s = 0.7;
  const X = 40;
  const Y = 60;
  const d = N.displaySize(w, h, rot);
  const pl = N.placement(rot, X, Y, w, h, s);
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([u, v]) => mapCorner(pl, s, u, v));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  near(`rot ${rot}: left edge`, Math.min(...xs), X);
  near(`rot ${rot}: right edge`, Math.max(...xs), X + d.w * s);
  near(`rot ${rot}: bottom edge`, Math.min(...ys), Y);
  near(`rot ${rot}: top edge`, Math.max(...ys), Y + d.h * s);
  // Where does the stored BOTTOM-LEFT corner go? /Rotate is clockwise:
  //   0 → bottom-left, 90 → top-left, 180 → top-right, 270 → bottom-right
  const bl = mapCorner(pl, s, 0, 0);
  const want = {
    0: { x: X, y: Y },
    90: { x: X, y: Y + d.h * s },
    180: { x: X + d.w * s, y: Y + d.h * s },
    270: { x: X + d.w * s, y: Y },
  }[rot];
  near(`rot ${rot}: stored bottom-left lands at the right corner (x)`, bl.x, want.x);
  near(`rot ${rot}: stored bottom-left lands at the right corner (y)`, bl.y, want.y);
}

// fit
{
  const f = N.fitInCell({ x: 10, y: 20, w: 500, h: 300 }, 842, 595);
  near("fit: scale = limiting side", f.s, Math.min(500 / 842, 300 / 595));
  check("fit: stays inside the cell", [f.x >= 10 - 1e-9, f.y >= 20 - 1e-9, f.x + f.w <= 510 + 1e-9, f.y + f.h <= 320 + 1e-9], [true, true, true, true]);
  const g = N.fitInCell({ x: 0, y: 0, w: 500, h: 500 }, 100, 50);
  near("fit: small page scales UP to the cell", g.w, 500);
  near("fit: centred vertically", g.y, (500 - 250) / 2);
}

// ---- plan ---------------------------------------------------------------------------
{
  const p = N.plan(6, [0, 1, 2, 3, 4, 5], 2);
  check("plan: all pages, 2-up → 3 sheets", p.items, [{ sheet: [0, 1] }, { sheet: [2, 3] }, { sheet: [4, 5] }]);
  check("plan: odd count keeps the last page alone", N.plan(5, [0, 1, 2, 3, 4], 2).items, [{ sheet: [0, 1] }, { sheet: [2, 3] }, { sheet: [4] }]);
  check("plan: 4-up", N.plan(5, [0, 1, 2, 3, 4], 4).items, [{ sheet: [0, 1, 2, 3] }, { sheet: [4] }]);
  check("plan: range in the middle keeps the rest in place", N.plan(6, [2, 3], 2).items, [{ page: 0 }, { page: 1 }, { sheet: [2, 3] }, { page: 4 }, { page: 5 }]);
  check("plan: gap in the choice → sheets at the first chosen page", N.plan(6, [1, 4], 2).items, [{ page: 0 }, { sheet: [1, 4] }, { page: 2 }, { page: 3 }, { page: 5 }]);
  check("plan: duplicates / out-of-range / junk dropped", N.plan(3, [1, 1, 9, -1, 1.5, "x"], 2).items, [{ page: 0 }, { sheet: [1] }, { page: 2 }]);
  check("plan: unsorted input is consumed in page order", N.plan(4, [3, 0], 2).items, [{ sheet: [0, 3] }, { page: 1 }, { page: 2 }]);
  check("plan: nothing chosen = nothing changes", N.plan(3, [], 2).items, [{ page: 0 }, { page: 1 }, { page: 2 }]);
  check("plan: counts", [N.plan(7, [0, 1, 2, 3, 4, 5, 6], 2).sheets, N.plan(7, [0, 1, 2, 3, 4, 5, 6], 2).chosen.length], [4, 7]);
  // every input page appears exactly once in the output
  const items = N.plan(9, [2, 3, 4, 7], 2).items;
  const flat = items.flatMap((it) => (it.page !== undefined ? [it.page] : it.sheet)).sort((a, b) => a - b);
  check("plan: no page lost or duplicated", flat, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
}

// ---- real pdf-lib documents ---------------------------------------------------------
async function makeSource() {
  const doc = await PDFDocument.create();
  const mk = (w, h, color) => {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 0, y: 0, width: w, height: h, color });
    p.drawRectangle({ x: 10, y: 10, width: 30, height: 30, color: rgb(1, 1, 1) });
    return p;
  };
  const a = mk(842, 595, rgb(0.9, 0.2, 0.2)); // 0 landscape
  const b = mk(595, 842, rgb(0.2, 0.7, 0.2)); // 1 stored portrait, /Rotate 90 → landscape
  b.setRotation(degrees(90));
  const c = mk(842, 595, rgb(0.2, 0.2, 0.9)); // 2 landscape with a CropBox
  c.setCropBox(100, 100, 400, 300);
  doc.addPage([842, 595]); // 3 blank — NO /Contents (what "Thêm trang trắng" makes)
  const e = mk(842, 595, rgb(0.5, 0.5, 0.5)); // 4 landscape with a link annotation
  const link = doc.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [10, 10, 100, 40], Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com") },
  });
  e.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  doc.addPage([842, 595]).drawRectangle({ x: 0, y: 0, width: 5, height: 5, color: rgb(0, 0, 0) }); // 5
  return PDFDocument.load(await doc.save());
}

(async () => {
  const src = await makeSource();
  check("source has 6 pages", src.getPageCount(), 6);

  // geometry as the viewer sees it
  const g1 = N.pageGeom(src.getPage(1));
  check("pageGeom: /Rotate 90 → display 842x595", [g1.rot, g1.disp.w, g1.disp.h], [90, 842, 595]);
  const g2 = N.pageGeom(src.getPage(2));
  check("pageGeom: CropBox wins over MediaBox", [g2.w, g2.h, g2.box.left, g2.box.bottom], [400, 300, 100, 100]);
  const g0 = N.pageGeom(src.getPage(0));
  check("pageGeom: plain page", [g0.w, g0.h, g0.rot], [842, 595, 0]);

  // the one pdf-lib gets wrong: confirm that we, not it, supply the rotation
  const probe = await PDFDocument.create();
  const raw = await probe.embedPage(src.getPage(1));
  check("pdf-lib alone IGNORES /Rotate (the reason placement() exists)", [raw.width, raw.height], [595, 842]);

  // annotations are counted so the UI can warn
  check("countAnnots: link on page 4", N.countAnnots(src, [0, 1, 2, 3, 4, 5]), 1);
  check("countAnnots: none on pages 0-3", N.countAnnots(src, [0, 1, 2, 3]), 0);

  // 2-up of the whole document: 6 pages → 3 sheets
  {
    const out = await PDFDocument.create();
    const plan = N.plan(6, [0, 1, 2, 3, 4, 5], 2);
    const r = await N.build(src, out, plan.items, { per: 2 }, lib);
    check("build: 3 sheets", r.sheets, 3);
    check("build: the blank page is reported, not fatal", r.blanks, 1);
    check("build: page count", out.getPageCount(), 3);
    const sz = out.getPage(0).getSize();
    check("build: sheet is A4 portrait", [Math.round(sz.width), Math.round(sz.height)], [595, 842]);
    const reload = await PDFDocument.load(await out.save());
    check("build: result re-opens", reload.getPageCount(), 3);
  }

  // untouched pages stay byte-for-byte pages of the source (counted + sized)
  {
    const out = await PDFDocument.create();
    const plan = N.plan(6, [2, 3], 2);
    await N.build(src, out, plan.items, { per: 2 }, lib);
    check("build: range keeps surrounding pages (6 - 2 + 1)", out.getPageCount(), 5);
    const sizes = out.getPages().map((p) => {
      const s = p.getSize();
      return [Math.round(s.width), Math.round(s.height)];
    });
    check("build: page order = 0, 1, SHEET, 4, 5", sizes, [[842, 595], [595, 842], [595, 842], [842, 595], [842, 595]]);
    check("build: kept page 1 still carries its /Rotate", out.getPage(1).getRotation().angle, 90);
  }

  // options reach the output
  {
    const out = await PDFDocument.create();
    await N.build(src, out, N.plan(6, [0, 1, 2, 3, 4, 5], 4).items, { per: 4, sheet: "a3", orient: "landscape", border: true }, lib);
    const sz = out.getPage(0).getSize();
    check("build: 4-up A3 landscape", [out.getPageCount(), Math.round(sz.width), Math.round(sz.height)], [2, 1191, 842]);
  }

  // odd count: last sheet is a legal page with one occupied cell
  {
    const out = await PDFDocument.create();
    await N.build(src, out, N.plan(5, [0, 1, 2, 3, 4], 2).items, { per: 2 }, lib);
    check("build: 5 pages 2-up → 3 sheets", out.getPageCount(), 3);
  }

  // the build never mutates the source
  const before = await src.save();
  const out2 = await PDFDocument.create();
  await N.build(src, out2, N.plan(6, [0, 1], 2).items, { per: 2 }, lib);
  const after = await src.save();
  check("build: source document untouched", Buffer.compare(Buffer.from(before), Buffer.from(after)), 0);

  console.log(`\npage-nup: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
