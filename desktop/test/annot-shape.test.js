"use strict";

// Regression net for the two shape families added in v0.2.71:
//   · `texthl` — tô sáng theo đoạn chữ được chọn: a QUAD LIST, one box per line.
//   · `poly`   — hình tự do: a POINT LIST that can be closed and filled, and that
//                (with draw / cloudpen) can now be RESIZED by its bounding box.
//
// WHY THESE FOUR FUNCTIONS ARE WORTH A GRID OF THEIR OWN.
//
//  1. `quadsFromRects` is the only thing standing between the browser's raw selection
//     rectangles and a patchy highlight. Measured on 1.TCVN 3890 - 2023.pdf, a 14-line
//     selection came back as **154 rectangles with exact duplicates among them**; a
//     highlight paints with `mix-blend-mode: multiply`, so a doubled quad is a visibly
//     DARKER band. The bug is invisible in the numbers and obvious in a screenshot,
//     which is exactly the kind a unit grid has to pin instead.
//  2. `polyPath` emits ONE path string for the on-screen <svg>, the round-trip /AP and
//     the flattened bake (BI-40 / BI-69). A missing `Z` means pdf-lib strokes instead
//     of fills, i.e. the saved file loses the shape's background.
//  3. `scalePts` is new maths with no shipped reference: it moves `draw` and `cloudpen`,
//     two tools that have been in users' hands for releases, into a gesture they never
//     had. A sign error here silently mangles existing annotations.
//  4. `annotBounds` / `translateAnnot` decide whether a shape can be reached, clamped
//     and dragged at all. Both grew a branch per family.
//
// Run:  node desktop/test/annot-shape.test.js      (or: npm run test:shape)

const G = require("../renderer/annot-geom.js");
const { quadsFromRects, polyPath, scalePts, countDistinct,
        annotBounds, translateAnnot, isPtsKind, isQuadKind, resizeRect } = G;

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
// Do any two quads in the list overlap? This is THE property the highlighter needs —
// see the note above about multiply. Written as a predicate rather than asserted case
// by case so every fixture below can be run through it.
function anyOverlap(qs) {
  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) {
      const A = qs[i], B = qs[j];
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) return true;
    }
  }
  return false;
}

// ==========================================================================
// 1. Shape-family predicates
// ==========================================================================

check("poly joins draw/cloudpen as a point-list kind",
  ["draw", "cloudpen", "poly"].map(isPtsKind), [true, true, true]);
check("box kinds are NOT point-list kinds",
  ["box", "ellipse", "cloud", "highlight", "text", "image"].map(isPtsKind),
  [false, false, false, false, false, false]);
check("texthl is the quad kind, and the rectangle highlighter is not",
  [isQuadKind("texthl"), isQuadKind("highlight"), isQuadKind("poly")], [true, false, false]);

// ==========================================================================
// 2. quadsFromRects — the duplicate/multiply defect
// ==========================================================================

// The measured defect, in miniature: the same line handed back twice.
check("an exact duplicate rect collapses to ONE quad (else multiply paints it twice)",
  quadsFromRects([{ x: 10, y: 20, w: 100, h: 12 }, { x: 10, y: 20, w: 100, h: 12 }]),
  [{ x: 10, y: 20, w: 100, h: 12 }]);
check("a rect CONTAINED in another on the same line is swallowed",
  quadsFromRects([{ x: 10, y: 20, w: 100, h: 12 }, { x: 30, y: 21, w: 20, h: 10 }]),
  [{ x: 10, y: 20, w: 100, h: 12 }]);
check("no pair of output quads ever overlaps",
  anyOverlap(quadsFromRects([
    { x: 10, y: 20, w: 100, h: 12 }, { x: 10, y: 20, w: 100, h: 12 },
    { x: 60, y: 20.4, w: 80, h: 12 }, { x: 10, y: 36, w: 90, h: 12 },
  ])), false);

// Word gaps inside one line must merge; a real column gap must not.
check("spans 1.4pt apart are one run",
  quadsFromRects([{ x: 0, y: 0, w: 10, h: 12 }, { x: 11.4, y: 0, w: 10, h: 12 }]),
  [{ x: 0, y: 0, w: 21.4, h: 12 }]);
check("spans 1.6pt apart stay two runs (a two-column page must not join up)",
  quadsFromRects([{ x: 0, y: 0, w: 10, h: 12 }, { x: 11.6, y: 0, w: 10, h: 12 }]).length, 2);

// Line separation. The grouping test is symmetric on purpose.
check("two consecutive lines stay two quads",
  quadsFromRects([{ x: 0, y: 0, w: 100, h: 12 }, { x: 0, y: 14, w: 90, h: 12 }]).length, 2);
check("a tall run does NOT swallow the line above or below it",
  quadsFromRects([
    { x: 0, y: 0, w: 100, h: 12 },     // line 1
    { x: 0, y: 14, w: 40, h: 12 },     // line 2, normal
    { x: 45, y: 8, w: 30, h: 24 },     // a big-font run straddling both bands
  ]).length, 3);

// Junk in, nothing out.
check("zero-size and sub-pixel rects are dropped (pdf.js emits zero-height spans)",
  quadsFromRects([{ x: 0, y: 0, w: 0, h: 12 }, { x: 0, y: 0, w: 10, h: 0 },
                  { x: 0, y: 0, w: 0.3, h: 0.3 }]), []);
check("NaN / missing rects cannot reach the output",
  quadsFromRects([null, { x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: NaN, w: 10, h: 10 }]), []);
check("an empty selection yields an empty list, not a crash", quadsFromRects([]), []);
check("a missing argument is the same as an empty selection", quadsFromRects(), []);

// Coordinates are what lands in the file.
check("quads are rounded to 2dp, like every other geometry that goes in the file",
  quadsFromRects([{ x: 1.23456, y: 2.34567, w: 3.45678, h: 4.56789 }]),
  [{ x: 1.23, y: 2.35, w: 3.46, h: 4.57 }]);

// The order a highlight is stored in is the order it is painted and written; a stable
// top-to-bottom, left-to-right order keeps a re-saved file byte-comparable.
check("output is ordered down the page, then across",
  quadsFromRects([{ x: 50, y: 30, w: 10, h: 12 }, { x: 0, y: 0, w: 10, h: 12 },
                  { x: 0, y: 30, w: 10, h: 12 }])
    .map((q) => [q.x, q.y]),
  [[0, 0], [0, 30], [50, 30]]);

// ==========================================================================
// 3. polyPath — the `Z` is what makes a fill possible
// ==========================================================================

check("a closed triangle ends with Z and reports closed",
  (() => { const g = polyPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true);
           return [g.d.endsWith(" Z"), g.closed, g.W, g.H]; })(),
  [true, true, 10, 10]);
check("the same points left open have no Z",
  polyPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false).d.endsWith("Z"), false);
// Two points cannot enclose anything — the shape survives, the CLOSING is refused.
check("two points asked to close come back open rather than as a sliver",
  (() => { const g = polyPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], true);
           return [g.closed, g.d.endsWith("Z")]; })(), [false, false]);
check("fewer than two DISTINCT points is not a shape at all (both writers draw nothing)",
  [polyPath([{ x: 5, y: 5 }], true), polyPath([{ x: 5, y: 5 }, { x: 5, y: 5 }], true),
   polyPath([], true), polyPath(null, true)],
  [null, null, null, null]);
check("coordinates are LOCAL to the shape's own box, with minX/minY reported back",
  (() => { const g = polyPath([{ x: 100, y: 200 }, { x: 110, y: 200 }, { x: 110, y: 210 }], true);
           return [g.d.startsWith("M 0.00 0.00"), g.minX, g.minY]; })(),
  [true, 100, 200]);
check("countDistinct ignores repeats and junk",
  [countDistinct([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }]),
   countDistinct([{ x: 1, y: 1 }, null, { x: NaN, y: 1 }]), countDistinct([])],
  [2, 1, 0]);

// ==========================================================================
// 4. scalePts — the resize gesture draw/cloudpen/poly never had
// ==========================================================================

const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
const boxL = { x: 0, y: 0, w: 10, h: 10 };

check("doubling the box doubles the point spread",
  scalePts(L, boxL, { x: 0, y: 0, w: 20, h: 20 }),
  [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }]);
check("a moved box carries the points with it",
  scalePts(L, boxL, { x: 100, y: 50, w: 10, h: 10 }),
  [{ x: 100, y: 50 }, { x: 110, y: 50 }, { x: 110, y: 60 }]);
check("halving is exact (no drift at the pinned corner)",
  scalePts(L, boxL, { x: 0, y: 0, w: 5, h: 5 }),
  [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);
// A perfectly horizontal stroke is a real thing on a drawing. Its height is 0, so
// there is nothing to scale FROM on that axis — the points must slide, not go NaN.
check("a flat (zero-height) stroke translates on that axis instead of exploding",
  scalePts([{ x: 0, y: 7 }, { x: 10, y: 7 }], { x: 0, y: 7, w: 10, h: 0 },
           { x: 0, y: 20, w: 20, h: 0 }),
  [{ x: 0, y: 20 }, { x: 20, y: 20 }]);
check("a zero-WIDTH stroke does the same on x",
  scalePts([{ x: 3, y: 0 }, { x: 3, y: 10 }], { x: 3, y: 0, w: 0, h: 10 },
           { x: 40, y: 0, w: 0, h: 20 }),
  [{ x: 40, y: 0 }, { x: 40, y: 20 }]);
check("no source box → the points come back untouched (a copy, not the same array)",
  (() => { const out = scalePts(L, null, { x: 0, y: 0, w: 99, h: 99 });
           return [out, out[0] === L[0]]; })(),
  [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false]);

// The gesture as the editor actually performs it: resizeRect decides the new box, and
// scalePts maps the points into it. Pinning the pair here is what keeps the two halves
// of the drag in step — the same reasoning as BI-42's "one set of maths, two callers".
check("resizeRect + scalePts: dragging the NW grip pins the SE corner",
  (() => {
    const box = resizeRect("nw", boxL, 5, 5, false, 1);   // drag the NW corner inwards
    const out = scalePts(L, boxL, box);
    return [box, out[out.length - 1]];
  })(),
  [{ x: 5, y: 5, w: 5, h: 5 }, { x: 10, y: 10 }]);

// ==========================================================================
// 5. annotBounds / translateAnnot for the new families
// ==========================================================================

check("a text highlight's bound is the union of its line quads",
  annotBounds({ kind: "texthl", quads: [{ x: 10, y: 5, w: 100, h: 12 },
                                        { x: 8, y: 20, w: 60, h: 12 }] }),
  { x: 8, y: 5, w: 102, h: 27 });
check("a highlight with no quads is a zero box, not NaN",
  annotBounds({ kind: "texthl", quads: [] }), { x: 0, y: 0, w: 0, h: 0 });
check("a poly bounds its points with NO cloud padding",
  annotBounds({ kind: "poly", pts: [{ x: 10, y: 10 }, { x: 30, y: 40 }] }),
  { x: 10, y: 10, w: 20, h: 30 });
// The rectangle highlighter must keep behaving as a box — the whole point of giving the
// text highlighter its own kind was that these two do not share a shape.
check("the old rectangle highlight is still a plain box",
  annotBounds({ kind: "highlight", x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });

check("translating a text highlight moves every quad and resizes none",
  translateAnnot({ kind: "texthl", quads: [{ x: 0, y: 0, w: 10, h: 12 },
                                           { x: 5, y: 20, w: 8, h: 12 }] }, 3, -2).quads,
  [{ x: 3, y: -2, w: 10, h: 12 }, { x: 8, y: 18, w: 8, h: 12 }]);
check("translating a poly moves its points",
  translateAnnot({ kind: "poly", pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }, 5, 5).pts,
  [{ x: 5, y: 5 }, { x: 15, y: 15 }]);

console.log(`\nannot-shape: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
