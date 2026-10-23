"use strict";

// Regression net for the PURE geometry behind rotating / flipping an inserted image
// (BI-116, docs/PLAN-2026-10-23-image-rotate-flip.md). Everything under test lives in
// renderer/annot-geom.js and is a plain require() — no DOM, no canvas.
//
// What this grid pins, and why each group exists:
//   A  normImgRot / cosSinDeg   the fold must equal annot-text.js normRot (two files, one
//                               convention: a stored number round-trips through /NabuData),
//                               and quarter turns must be EXACT (no 6e-17 dust in a PDF).
//   B  imageXformed             the gate every writer uses to stay on the OLD path (BI-59).
//   C  imageCorners / Bounds    direction of the turn (anti-clockwise on screen, y down),
//                               order flip-then-turn, and "rot 0 = the annot's own box".
//   D  imageOp                  a screen mirror of a TURNED picture negates the angle too.
//   E  resizeRotated            rot 0 == resizeRect; the corner opposite the grip stays put
//                               IN PAGE SPACE at any angle (the property that matters).
//   F  rotateDragAngle          relative to the grab point, Shift = 15°, up = 0.
//   G  annotBounds              an image reports its TURNED box (paste/place clamping).
//
// Run:  node desktop/test/image-xform.test.js      (or: npm run test:imgxf)

const G = require("../renderer/annot-geom.js");
const T = require("../renderer/annot-text.js");

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
  const tol = eps == null ? 1e-9 : eps;
  if (typeof actual === "number" && Math.abs(actual - expected) <= tol) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ≈${expected}\n  actual   ${actual}`);
  }
}
const nearPt = (name, p, x, y, eps) => {
  near(name + ".x", p.x, x, eps);
  near(name + ".y", p.y, y, eps);
};

// ---- A. normalisation -------------------------------------------------------

for (const v of [0, 1, -1, 90, 180, -180, 181, 270, 350, -350, 360, 720.5, "45", "x", NaN, Infinity, null, undefined]) {
  check(`A normImgRot == normRot (${v})`, G.normImgRot(v), T.normRot(v));
}
check("A no -0", Object.is(G.normImgRot(-0), 0) && Object.is(G.normImgRot(360), 0), true);
for (const [d, c, s] of [[0, 1, 0], [90, 0, 1], [180, -1, 0], [-90, 0, -1], [270, 0, -1], [360, 1, 0]]) {
  const r = G.cosSinDeg(d);
  check(`A cosSinDeg exact ${d}`, [r.c, r.s], [c, s]);
}
near("A cosSinDeg 30 cos", G.cosSinDeg(30).c, Math.cos(Math.PI / 6));
near("A cosSinDeg 30 sin", G.cosSinDeg(30).s, 0.5);

// ---- B. the gate ------------------------------------------------------------

check("B plain", G.imageXformed({ kind: "image", x: 1, y: 2, w: 3, h: 4 }), false);
check("B rot 0 / 360", G.imageXformed({ rot: 0 }) || G.imageXformed({ rot: 360 }), false);
check("B flags false", G.imageXformed({ flipH: false, flipV: false }), false);
check("B rot", G.imageXformed({ rot: 10 }), true);
check("B flipH", G.imageXformed({ flipH: true }), true);
check("B flipV", G.imageXformed({ flipV: true }), true);
check("B null", G.imageXformed(null), false);

// ---- C. corners / bounds ----------------------------------------------------

{
  // 100 x 40 box at (10, 20): centre (60, 40).
  const a = { x: 10, y: 20, w: 100, h: 40 };
  const k0 = G.imageCorners(a);
  nearPt("C rot0 tl", k0.tl, 10, 20);
  nearPt("C rot0 tr", k0.tr, 110, 20);
  nearPt("C rot0 bl", k0.bl, 10, 60);
  nearPt("C rot0 br", k0.br, 110, 60);
  // +90 is ANTI-clockwise on screen: the top-left corner swings to the BOTTOM-left, the
  // top-right to the top-left. (A clockwise turn would put tl at the top-right.)
  const k90 = G.imageCorners({ ...a, rot: 90 });
  nearPt("C rot90 tl", k90.tl, 40, 90);
  nearPt("C rot90 tr", k90.tr, 40, -10);
  nearPt("C rot90 bl", k90.bl, 80, 90);
  nearPt("C rot90 br", k90.br, 80, -10);
  const k180 = G.imageCorners({ ...a, rot: 180 });
  nearPt("C rot180 tl", k180.tl, 110, 60);
  nearPt("C rot180 br", k180.br, 10, 20);
  // Flip is INSIDE the image frame: flipH moves the image's own TL to the right edge.
  const kh = G.imageCorners({ ...a, flipH: true });
  nearPt("C flipH tl", kh.tl, 110, 20);
  nearPt("C flipH tr", kh.tr, 10, 20);
  nearPt("C flipH bl", kh.bl, 110, 60);
  const kv = G.imageCorners({ ...a, flipV: true });
  nearPt("C flipV tl", kv.tl, 10, 60);
  nearPt("C flipV bl", kv.bl, 10, 20);
  // Order: flip first, THEN turn. flipH + rot 90: tl goes (flip) to the right edge (50,0)
  // relative to centre, then the turn sends offset (50,-20) → (-20, -50), i.e. page (40, -10).
  const kfr = G.imageCorners({ ...a, flipH: true, rot: 90 });
  nearPt("C flipH+rot90 tl", kfr.tl, 40, -10);
  // Turned-box bounds: |w cos| + |h sin| across (60° here), same as rotatedBox.
  const b60 = G.imageBounds({ ...a, rot: 60 });
  const rb = T.rotatedBox(100, 40, 60);
  near("C bounds60 w", b60.w, rb.w);
  near("C bounds60 h", b60.h, rb.h);
  near("C bounds60 cx", b60.x + b60.w / 2, 60);
  near("C bounds60 cy", b60.y + b60.h / 2, 40);
  // A flip never changes the bounds; rot 0 returns the annot's own numbers verbatim.
  check("C bounds flip only", G.imageBounds({ ...a, flipH: true, flipV: true }), { x: 10, y: 20, w: 100, h: 40 });
  check("C bounds rot0 verbatim", G.imageBounds({ x: 0.1, y: 0.2, w: 0.3, h: 0.7 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.7 });
  const b90 = G.imageBounds({ ...a, rot: 90 });
  check("C bounds90 swaps", [b90.x, b90.y, b90.w, b90.h], [40, -10, 40, 100]);
}

// ---- D. menu commands -------------------------------------------------------

{
  const id = { rot: 0, flipH: false, flipV: false };
  check("D rotL", G.imageOp({}, "rotL"), { rot: 90, flipH: false, flipV: false });
  check("D rotR", G.imageOp({}, "rotR"), { rot: -90, flipH: false, flipV: false });
  check("D rotL x4", ["rotL", "rotL", "rotL", "rotL"].reduce((s, op) => ({ ...s, ...G.imageOp(s, op) }), { rot: 0 }), id);
  check("D rotL+rotR", G.imageOp({ rot: 90 }, "rotR"), id);
  check("D flipH", G.imageOp({}, "flipH"), { rot: 0, flipH: true, flipV: false });
  check("D flipH twice", G.imageOp(G.imageOp({ rot: 30 }, "flipH"), "flipH"), { rot: 30, flipH: false, flipV: false });
  check("D flipV", G.imageOp({}, "flipV"), { rot: 0, flipH: false, flipV: true });
  check("D reset", G.imageOp({ rot: 33, flipH: true, flipV: true }, "reset"), id);
  // THE point of D: a screen mirror negates the angle. Mirror the corners on screen by
  // hand and compare with what the op produces.
  const a = { x: 10, y: 20, w: 100, h: 40, rot: 30, flipV: true };
  const k = G.imageCorners(a);
  const cx = 60;
  const mirrored = (p) => ({ x: 2 * cx - p.x, y: p.y }); // mirror about the vertical axis through the centre
  const after = { ...a, ...G.imageOp(a, "flipH") };
  const k2 = G.imageCorners(after);
  for (const name of ["tl", "tr", "bl", "br"]) {
    const m = mirrored(k[name]);
    nearPt(`D screen mirror H ${name}`, k2[name], m.x, m.y, 1e-9);
  }
  const cy = 40;
  const after2 = { ...a, ...G.imageOp(a, "flipV") };
  const k3 = G.imageCorners(after2);
  for (const name of ["tl", "tr", "bl", "br"]) {
    nearPt(`D screen mirror V ${name}`, k3[name], k[name].x, 2 * cy - k[name].y, 1e-9);
  }
  // A quarter turn is a rotation of the corners about the centre by 90° anti-clockwise.
  const kl = G.imageCorners({ ...a, ...G.imageOp(a, "rotL") });
  nearPt("D rotL tl", kl.tl, cx + (k.tl.y - cy), cy - (k.tl.x - cx), 1e-9);
}

// ---- E. resize of a turned box ----------------------------------------------

{
  const orig = { x: 10, y: 20, w: 100, h: 40 };
  // rot 0 must be resizeRect itself, for every corner, with and without the ratio lock.
  for (const dir of ["nw", "ne", "sw", "se"]) {
    for (const ratio of [false, true]) {
      const want = G.resizeRect(dir, orig, 17, -9, ratio, 4);
      const got = G.resizeRotated(dir, orig, 17, -9, ratio, 4, 0);
      for (const k of ["x", "y", "w", "h"]) near(`E rot0 ${dir} ${ratio} ${k}`, got[k], want[k], 1e-9);
    }
  }
  // At any angle the corner OPPOSITE the held one must not move in page space.
  const pinned = (box, rot, dir) => {
    const west = dir.indexOf("w") >= 0;
    const north = dir.indexOf("n") >= 0;
    // the image's own corner that is opposite the grip: east/south when holding west/north
    const k = G.imageCorners({ ...box, rot });
    return west ? (north ? k.br : k.tr) : north ? k.bl : k.tl;
  };
  for (const rot of [0, 30, 90, 137, -45, 180]) {
    for (const dir of ["nw", "ne", "sw", "se"]) {
      for (const ratio of [false, true]) {
        const before = pinned(orig, rot, dir);
        const g = G.resizeRotated(dir, orig, 13, 29, ratio, 4, rot);
        const after = pinned(g, rot, dir);
        nearPt(`E pin ${dir} rot${rot} r${ratio}`, after, before.x, before.y, 1e-9);
      }
    }
  }
  // The held corner follows the pointer: dragging "se" along the box's own x axis by d
  // widens it by exactly d at any angle (the drag is brought into the box frame).
  for (const rot of [0, 30, 90, -120]) {
    const r = (rot * Math.PI) / 180;
    const d = 25;
    // the box's own +x axis in page space (y down, anti-clockwise turn): (cos, -sin)
    const g = G.resizeRotated("se", orig, d * Math.cos(r), -d * Math.sin(r), false, 4, rot);
    near(`E along-x w rot${rot}`, g.w, orig.w + d, 1e-9);
    near(`E along-x h rot${rot}`, g.h, orig.h, 1e-9);
  }
  // minimum side is honoured, and still pins the far corner.
  // (drag given as a vector in the box's OWN frame, turned into page space first)
  const rr = (40 * Math.PI) / 180;
  const pdx = -500 * Math.cos(rr) + -500 * Math.sin(rr);
  const pdy = 500 * Math.sin(rr) + -500 * Math.cos(rr);
  const tiny = G.resizeRotated("se", orig, pdx, pdy, false, 4, 40);
  check("E min side", [tiny.w, tiny.h], [4, 4]);
}

// ---- F. rotate-grip drag ----------------------------------------------------

{
  const c = { x: 100, y: 100 };
  // Grab straight above, drag to the LEFT of the centre: +90 (anti-clockwise).
  near("F up→left", G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 50, y: 100 }, 0, false), 90);
  near("F up→right", G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 150, y: 100 }, 0, false), -90);
  near("F up→down", Math.abs(G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 100, y: 150 }, 0, false)), 180);
  near("F no move keeps rot", G.rotateDragAngle(c, { x: 130, y: 50 }, { x: 130, y: 50 }, 33, false), 33);
  // Relative: grabbing OFF the grip's centre does not jump — same pointer, same angle.
  near("F relative", G.rotateDragAngle(c, { x: 140, y: 60 }, { x: 140, y: 60 }, 12, false), 12);
  // Shift snaps the RESULT to 15°.
  near("F snap 20→15", G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 100 - 50 * Math.sin((20 * Math.PI) / 180), y: 100 - 50 * Math.cos((20 * Math.PI) / 180) }, 0, true), 15);
  near("F snap 23→30", G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 100 - 50 * Math.sin((23 * Math.PI) / 180), y: 100 - 50 * Math.cos((23 * Math.PI) / 180) }, 0, true), 30);
  near("F snap keeps 90 reachable", G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 50, y: 98 }, 0, true), 90);
  // Result is always folded into (-180, 180].
  const wrap = G.rotateDragAngle(c, { x: 100, y: 50 }, { x: 50, y: 100 }, 150, false);
  check("F folded", wrap > -180 && wrap <= 180, true);
}

// ---- H. imageCm: the matrix both writers share -------------------------------

{
  const a = { x: 40, y: 60, w: 120, h: 90 };
  const pdfY = (x, y) => [x, 842 - y]; // a page-height flip, like makeMap(vp1, "image")
  // Untouched: the matrix the old writers emit, [w 0 0 h x y_lowerleft].
  check("H untouched = [w 0 0 h x y]", G.imageCm(a, pdfY).map((v) => +v.toFixed(9)), [120, 0, 0, 90, 40, 842 - 150]);
  // The unit square through the matrix lands on imageCorners (BL, BR, TR, TL).
  for (const over of [{}, { rot: 30 }, { rot: -135, flipH: true }, { flipV: true }, { rot: 90, flipH: true, flipV: true }]) {
    const t = { ...a, ...over };
    const m = G.imageCm(t, pdfY);
    const k = G.imageCorners(t);
    const apply = ([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
    const exp = [k.bl, k.br, k.tr, k.tl].map((p) => pdfY(p.x, p.y));
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((uv, i) => {
      const got = apply(uv);
      near(`H ${JSON.stringify(over)} corner ${i} x`, got[0], exp[i][0], 1e-9);
      near(`H ${JSON.stringify(over)} corner ${i} y`, got[1], exp[i][1], 1e-9);
    });
  }
  // A flip is a NEGATIVE determinant in the matrix, a turn alone is positive (in y-up space).
  const det = (m) => m[0] * m[3] - m[1] * m[2];
  check("H det > 0 for a plain turn", det(G.imageCm({ ...a, rot: 40 }, pdfY)) > 0, true);
  check("H det > 0 for no change", det(G.imageCm(a, pdfY)) > 0, true);
  // In y-up space a display-space (y-down) mapping already mirrors, so the sign convention
  // to pin is "flip toggles the sign relative to the unflipped matrix":
  check("H a flip reverses the determinant's sign",
    Math.sign(det(G.imageCm({ ...a, rot: 40, flipH: true }, pdfY))) === -Math.sign(det(G.imageCm({ ...a, rot: 40 }, pdfY))), true);
  check("H two flips restore it",
    Math.sign(det(G.imageCm({ ...a, flipH: true, flipV: true }, pdfY))), Math.sign(det(G.imageCm(a, pdfY))));
}

// ---- G. annotBounds / translate / union -------------------------------------

{
  const a = { kind: "image", x: 10, y: 20, w: 100, h: 40 };
  check("G annotBounds plain image", G.annotBounds(a), { x: 10, y: 20, w: 100, h: 40 });
  check("G annotBounds flip image", G.annotBounds({ ...a, flipH: true }), { x: 10, y: 20, w: 100, h: 40 });
  check("G annotBounds rot90 image", G.annotBounds({ ...a, rot: 90 }), { x: 40, y: -10, w: 40, h: 100 });
  // A turned image that sticks out above the sheet is pulled back by fitShift via its
  // TURNED box (the whole reason annotBounds changed).
  const s = G.fitShift(G.unionBounds([{ ...a, rot: 90 }]), 600, 800);
  near("G fitShift dy", s.dy, 10);
  // Other kinds are untouched by the image branch.
  check("G box unchanged", G.annotBounds({ kind: "box", x: 1, y: 2, w: 3, h: 4, rot: 90 }), { x: 1, y: 2, w: 3, h: 4 });
  // translate keeps rot / flips (they are not coordinates).
  const t = G.translateAnnot({ ...a, rot: 30, flipH: true }, 5, 7);
  check("G translate keeps xform", [t.x, t.y, t.rot, t.flipH], [15, 27, 30, true]);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
