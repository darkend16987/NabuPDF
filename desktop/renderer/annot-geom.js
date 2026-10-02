"use strict";

/*
 * Pure geometry for the overlay editor — lifted out of editor.js at v0.2.48.
 * The cloud + arrow bodies were verified line-by-line against v0.2.47's editor.js
 * before the move: byte-identical, so this was a change of address, not a rewrite.
 * `resizeRect` is newer — it arrived with the 4-corner-handles work in this same
 * release, so its reference point is test:geom's 39 cases rather than a shipped file.
 *
 * WHY THIS FILE EXISTS (docs/REGRESSION-GUARD.md §1). Two jobs live here, and both
 * fail quietly:
 *   · `cloudPath` / `cloudPathPoly` emit ONE SVG path string that drives BOTH the
 *     on-screen <svg> overlay AND pdf-lib's drawSvgPath at bake time. There is no
 *     second implementation to disagree with — but the local-origin/`pad` bookkeeping
 *     the two consumers rely on is easy to break, and the result is a revision cloud
 *     that sits somewhere else in the saved PDF than the user drew it.
 *   · `resizeRect` decides which corner stays pinned while a grip is dragged. Get it
 *     wrong and boxes creep or flip. It was ALREADY under test before this split, by
 *     lifting the source out of editor.js at run time and eval'ing it; now it is a
 *     plain require() and `npm run test:geom` no longer needs that trick for it.
 *
 * EXPOSURE — the `wire.js` tier of §2 (bare names at classic-script top level), not
 * the `page-range.js` tier. These names had 11 call sites in editor.js; keeping them
 * bare meant the editor.js half of this change is a pure deletion, with no chance of
 * a mistyped `AnnotGeom.` sneaking in. `module.exports` is for node, `window.AnnotGeom`
 * is the same set under a name a probe can assert on.
 *
 * TRADE-OFF (same as wire.js / annot-text.js): this file MUST load BEFORE editor.js
 * in index.html, and a rename here without a matching call-site edit is a runtime
 * ReferenceError with no build-time warning — BI-14. The grid is the net.
 *
 * Everything here is pure: no DOM, no `ed`, no `state`. Angles/points are in the
 * annotation's own scale-1 PDF-point space with a TOP-LEFT origin and y pointing
 * DOWN (the pdf.js viewport at scale 1) — not pdf-lib's bottom-left user space.
 */

// ---- which SHAPE FAMILY a kind belongs to ---------------------------------
//
// Three families, and almost every function below has to know which one it is looking
// at: a BOX (x/y/w/h), a POINT LIST (`pts`) and — since the text highlighter — a QUAD
// LIST (`quads`, one box per line of selected text). The split used to be spelled out
// as `a.kind === "draw" || a.kind === "cloudpen"` inline in annotBounds, translateAnnot,
// and five places in editor.js. Adding `poly` to an inline chain in six files is exactly
// the drift editor.js's RESIZABLE_KINDS note warns about, so the chain gets a name.
//
// `poly` sits with draw/cloudpen and NOT with box/ellipse even though it can be closed
// and filled: what decides membership is the STORAGE shape, because that is what every
// caller here is branching on.
//
// Declared at the top of the file rather than beside annotBounds: these are `const`s,
// and annot-geom.js is a classic script whose names are read from editor.js. Anything
// that ran at load time and reached a function below would hit their TDZ. Nothing does
// today — keeping them first keeps it that way (same argument as editor.js COLOR_SLOTS).
const PTS_KINDS = new Set(["draw", "cloudpen", "poly"]);
const QUAD_KINDS = new Set(["texthl"]);
function isPtsKind(k) { return PTS_KINDS.has(k); }
function isQuadKind(k) { return QUAD_KINDS.has(k); }

// ---- arrow label ---------------------------------------------------------

// Centre point (in whatever coord space the endpoints are given) where an arrow's
// label sits. `sx,sy`=tail (x1,y1), `ex,ey`=head/tip (x2,y2), `ang`=head direction
// (atan2(ey-sy, ex-sx)), `hl`=head length, `fs`=label font size. labelEnd "tail"
// puts it just beyond the base pointing away from the tip; anything else = head
// (the historical default, so arrows without a labelEnd render unchanged).
function arrowLabelPos(a, sx, sy, ex, ey, ang, hl, fs) {
  const gap = hl + fs * 0.6;
  if (a.labelEnd === "tail") {
    return { x: sx - Math.cos(ang) * gap, y: sy - Math.sin(ang) * gap };
  }
  return { x: ex + Math.cos(ang) * gap, y: ey + Math.sin(ang) * gap };
}

// ---- dragging one end of a two-point annotation --------------------------

// New position for the end of a line being dragged, with `fx,fy` the end that stays
// put and `px,py` the cursor. Plain follow-the-cursor unless `snap` (Shift held), in
// which case the direction is quantised to ANGLE_SNAP_DEG about the fixed end while the
// LENGTH is left alone — so Shift reads as "swing this arrow to a clean angle", not as
// "resize it". That is the useful gesture on a drawing: 0/15/…/345° covers horizontal,
// vertical, both diagonals and the common leader-line angles.
//
// `snap` is read LIVE off the mouse event by the caller, the same rule as `resizeRect`'s
// `ratio` and `strokeExtend`'s `straight` (BI-42): pressing or releasing Shift mid-drag
// has to take effect on the next move, and a latched keydown flag would stick on if
// Shift were released while the window had lost focus.
//
// A zero-length drag has no angle to quantise, so it passes the cursor through rather
// than picking an arbitrary one — otherwise grabbing an endpoint and holding Shift
// without moving would snap the arrow to 0° on the first pixel of travel.
const ANGLE_SNAP_DEG = 15;
function snapLineEnd(fx, fy, px, py, snap) {
  if (!snap) return { x: px, y: py };
  const dx = px - fx;
  const dy = py - fy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: px, y: py };
  const step = (ANGLE_SNAP_DEG * Math.PI) / 180;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: fx + Math.cos(ang) * len, y: fy + Math.sin(ang) * len };
}

// ---- revision clouds -----------------------------------------------------

// Revision-cloud outline as an SVG path. The perimeter of the a.w×a.h box is
// replaced by outward semicircular scallops — the construction-industry standard
// "khoanh mây". Coordinates are shifted by `pad` so the bulges stay ≥ 0, letting
// the same string drive both the overlay <svg> (0-origin viewBox) and pdf-lib's
// drawSvgPath at bake time. Returns { d, pad, W, H }.
const CLOUD_BUMP = 16; // default scallop diameter in scale-1 PDF points
const CLOUD_BUMP_MIN = 6; // tightest/densest cloud the size control allows
const CLOUD_BUMP_MAX = 28; // puffiest cloud the size control allows
// Per-annotation scallop size. Users asked for smaller/denser clouds, so each
// cloud carries its own `bump`; clouds drawn before this was configurable have
// no `bump` and fall back to the historical default so they render unchanged.
const bumpOf = (a) => (a && a.bump) || CLOUD_BUMP;
function cloudPath(w, h, bump) {
  bump = bump || CLOUD_BUMP;
  const pad = bump; // room for the outward bulges
  const x0 = pad;
  const y0 = pad;
  const x1 = pad + Math.max(1, w);
  const y1 = pad + Math.max(1, h);
  const parts = [];
  // Emit `n` semicircular arcs along the straight edge A→B, each bulging outward.
  // Traversing the rectangle clockwise (in the y-down overlay space), a sweep
  // flag of 1 puts every bump on the outer side.
  const side = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / bump));
    const r = len / n / 2;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      parts.push(`A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${px.toFixed(2)} ${py.toFixed(2)}`);
    }
  };
  side(x0, y0, x1, y0); // top: left → right
  side(x1, y0, x1, y1); // right: top → bottom
  side(x1, y1, x0, y1); // bottom: right → left
  side(x0, y1, x0, y0); // left: bottom → top
  const d = `M ${x0} ${y0} ` + parts.join(" ") + " Z";
  return { d, pad, W: Math.max(1, w) + 2 * pad, H: Math.max(1, h) + 2 * pad };
}

// Freehand / polygon revision cloud: scallop a *closed* polygon given by an
// ordered point list (scale-1 space). The perimeter is resampled into ~`bump`
// spaced points and each span becomes an outward semicircular bump. "Outward"
// is decided per-span relative to the polygon centroid, so it works for any
// winding. Returns { d, minX, minY, pad, W, H } (local 0-origin, y-down —
// drives both the overlay <svg> and pdf-lib's drawSvgPath, like cloudPath) or
// null if there aren't enough distinct points. Corners are lightly rounded.
// Apex (farthest point) of the SVG elliptical-arc A→B with rx=ry=rr, x-rotation
// 0 and large-arc-flag 0, for a given sweep flag. Uses the SVG endpoint→center
// parameterisation. Lets cloudPathPoly decide which sweep bulges outward.
function arcApex(A, B, rr, sweep) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const chord = Math.hypot(dx, dy) || 1;
  rr = Math.max(rr, chord / 2 + 0.01);
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const h = Math.sqrt(Math.max(0, rr * rr - (chord / 2) * (chord / 2)));
  const ux = -dy / chord, uy = dx / chord; // unit perpendicular to the chord
  const sign = sweep ? 1 : -1; // large-arc-flag is 0, so center sign = ±1 by sweep
  const ccx = mx + sign * h * ux, ccy = my + sign * h * uy;
  let vx = mx - ccx, vy = my - ccy;
  const vl = Math.hypot(vx, vy) || 1;
  return { x: ccx + (rr * vx) / vl, y: ccy + (rr * vy) / vl };
}

function cloudPathPoly(rawPts, bump) {
  bump = bump || CLOUD_BUMP;
  const pts = [];
  for (const p of rawPts || []) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) pts.push({ x: p.x, y: p.y });
  }
  if (pts.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  const loop = pts.concat([pts[0]]);
  let L = 0;
  for (let i = 1; i < loop.length; i++) L += Math.hypot(loop[i].x - loop[i - 1].x, loop[i].y - loop[i - 1].y);
  if (L < 1) return null;
  const n = Math.max(6, Math.round(L / bump));
  const step = L / n;
  // Resample n points evenly along the closed perimeter.
  const samples = [];
  let segI = 1, dist = 0;
  let segStart = loop[0], segEnd = loop[1];
  let segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (target > dist + segLen && segI < loop.length - 1) {
      dist += segLen;
      segI++;
      segStart = loop[segI - 1];
      segEnd = loop[segI];
      segLen = Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y);
    }
    const t = segLen > 0 ? Math.min(1, (target - dist) / segLen) : 0;
    samples.push({ x: segStart.x + (segEnd.x - segStart.x) * t, y: segStart.y + (segEnd.y - segStart.y) * t });
  }
  const xs = samples.map((s) => s.x), ys = samples.map((s) => s.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  const pad = bump;
  const lx = (x) => (x - minX + pad).toFixed(2);
  const ly = (y) => (y - minY + pad).toFixed(2);
  const rNum = step / 2;
  const r = rNum.toFixed(2);
  const parts = [];
  for (let k = 0; k < n; k++) {
    const a = samples[k], b = samples[(k + 1) % n];
    // Bulge each span outward. The two sweep flags put the arc apex on opposite
    // sides of the chord; pick the one whose apex is farther from the centroid.
    // Winding-independent, so it's correct for either polygon orientation.
    const ap1 = arcApex(a, b, rNum, 1), ap0 = arcApex(a, b, rNum, 0);
    const d1 = Math.hypot(ap1.x - cx, ap1.y - cy), d0 = Math.hypot(ap0.x - cx, ap0.y - cy);
    const sweep = d1 > d0 ? 1 : 0;
    parts.push(`A ${r} ${r} 0 0 ${sweep} ${lx(b.x)} ${ly(b.y)}`);
  }
  const d = `M ${lx(samples[0].x)} ${ly(samples[0].y)} ` + parts.join(" ") + " Z";
  return { d, minX, minY, pad, W: maxX - minX + 2 * pad, H: maxY - minY + 2 * pad };
}

// ---- freehand stroke: the Shift-straight rule ----------------------------

// Next point list for a freehand (`draw`) stroke, given the cursor at `p`.
//
//   straight   Shift held right now — read LIVE off the mouse event, so it can be
//              pressed and released mid-drag (same rule as resizeRect's `ratio`).
//   anchor     index in `pts` the straight segment pivots on, or null while the
//              user is scribbling freely.
//
// Returns { pts, anchor }; the caller stores `anchor` back on its drag state.
//
// THE WHOLE POINT OF THE `anchor` PARAMETER, and the only way to get this wrong:
// the pivot must be captured ONCE, on the first move after Shift goes down, and
// then reused. Re-deriving it as "the last point" on every mousemove pins it to
// the point we just wrote, so the segment is always cursor→cursor and the line
// collapses to nothing. test:cloud has a guard case for exactly that.
//
// Releasing Shift hands control back with `anchor: null`, so drawing resumes from
// wherever the straight segment ended — that is what makes polylines possible
// (straight, freehand, straight… all inside one stroke).
//
// A new array per move rather than an in-place push: `pts` is truncated on the
// straight path anyway, and the cost is nothing next to renderLayer(), which
// already rebuilds the entire SVG path string from every point on every move.
function strokeExtend(pts, p, straight, anchor) {
  const src = pts || [];
  if (!straight) return { pts: src.concat([p]), anchor: null };
  // First move with Shift down → pin the pivot to the stroke's current tip.
  const at = anchor == null ? Math.max(0, src.length - 1) : anchor;
  return { pts: src.slice(0, at + 1).concat([p]), anchor: at };
}

// ---- tick / cross symbols ------------------------------------------------

// Side length (scale-1 PDF points) of a symbol dropped with a plain click rather
// than dragged out. ~18pt reads at about the size of a checkbox in a contract.
const SYMBOL_SIZE = 18;

// A ✓ or ✗ as polylines inside the box (x, y, w, h) — annot space, top-left
// origin, y DOWN. Like cloudPath, this is the SINGLE source of truth read twice:
// by the on-screen <svg> and by pdf-lib's drawLine at bake time. Two readings of
// one function can't disagree; two implementations silently would, and the bake
// half is the one nobody sees until the file is delivered.
//
// The fractions keep the ink clear of the box edge so the stroke isn't clipped by
// the overlay element and lines up with the resize grips. Unknown kind → [], so a
// stray annot renders as nothing instead of throwing mid-bake.
function symbolStrokes(kind, x, y, w, h) {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  const px = (f) => x + W * f;
  const py = (f) => y + H * f;
  if (kind === "check") {
    // Down-stroke to the low point at ~38% across, then the long up-stroke.
    return [[
      { x: px(0.1), y: py(0.55) },
      { x: px(0.38), y: py(0.84) },
      { x: px(0.9), y: py(0.14) },
    ]];
  }
  if (kind === "cross") {
    return [
      [{ x: px(0.14), y: py(0.14) }, { x: px(0.86), y: py(0.86) }],
      [{ x: px(0.86), y: py(0.14) }, { x: px(0.14), y: py(0.86) }],
    ];
  }
  return [];
}

// ---- moving a whole annotation (used by copy/paste) -----------------------

// The box an annotation's INK occupies, whatever shape it is underneath — the three
// families the editor stores are a box (x/y/w/h), a point list (`pts`) and a pair of
// endpoints (x1,y1,x2,y2), and every caller that has to reason about "where is this
// thing" would otherwise re-derive that split. Returns { x, y, w, h }.
//
// Clouds report their PADDED box, i.e. including the scallops: the bulges are ink, and
// a caller clamping a cloud to the page using the bare w×h would let a whole ring of
// them hang over the edge. `cloudPath`'s `pad` is the same number the overlay <svg>
// and the bake both use (BI-40), so this stays in step with them by construction.
//
// This is a BOUND, not a promise about every pixel: an arrow's text label and a thick
// pen's stroke width both reach a little past it. Callers use it to keep an object
// reachable on the page, not to compute a crop.
function annotBounds(a) {
  if (!a) return { x: 0, y: 0, w: 0, h: 0 };
  if (a.kind === "arrow" || a.kind === "dim") {
    const x = Math.min(a.x1, a.x2);
    const y = Math.min(a.y1, a.y2);
    return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  if (isQuadKind(a.kind)) {
    // A text highlight is N line boxes, not one — its bound is their union. An empty
    // list is a real state (a selection that hit no glyphs), and a zero box is what
    // keeps fitShift / unionBounds from reading NaN out of Math.min of nothing.
    const qs = a.quads || [];
    if (!qs.length) return { x: 0, y: 0, w: 0, h: 0 };
    const x = Math.min(...qs.map((q) => q.x));
    const y = Math.min(...qs.map((q) => q.y));
    return {
      x, y,
      w: Math.max(...qs.map((q) => q.x + q.w)) - x,
      h: Math.max(...qs.map((q) => q.y + q.h)) - y,
    };
  }
  if (isPtsKind(a.kind)) {
    const pts = a.pts || [];
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    // A freehand cloud is scalloped outward like a boxed one, so it carries the same
    // one-bump margin; a plain `draw` stroke and a `poly` are just the polyline.
    const pad = a.kind === "cloudpen" ? bumpOf(a) : 0;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
  }
  if (a.kind === "cloud") {
    const pad = bumpOf(a);
    return { x: (a.x || 0) - pad, y: (a.y || 0) - pad,
             w: (a.w || 0) + 2 * pad, h: (a.h || 0) + 2 * pad };
  }
  return { x: a.x || 0, y: a.y || 0, w: a.w || 0, h: a.h || 0 };
}

// Shift an annotation by (dx, dy) IN PLACE, touching whichever coordinate fields its
// kind actually has. Mutating rather than returning a copy matches the existing drag
// handlers, which move the live object the overlay is already rendering. Returns `a`.
function translateAnnot(a, dx, dy) {
  if (!a) return a;
  if (a.kind === "arrow" || a.kind === "dim") {
    a.x1 += dx; a.y1 += dy;
    a.x2 += dx; a.y2 += dy;
  } else if (isQuadKind(a.kind)) {
    a.quads = (a.quads || []).map((q) => ({ x: q.x + dx, y: q.y + dy, w: q.w, h: q.h }));
  } else if (isPtsKind(a.kind)) {
    a.pts = (a.pts || []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
  } else {
    a.x = (a.x || 0) + dx;
    a.y = (a.y || 0) + dy;
  }
  return a;
}

// The single box enclosing a whole list of annotations — what a Ctrl+click group has to
// be clamped by. Clamping each member on its own instead would SHEAR the group: an
// object near the edge would slide while its neighbours stayed, and a diagram pasted
// onto a smaller page would come apart. Empty list → a zero box.
function unionBounds(list) {
  const bs = (list || []).map(annotBounds);
  if (!bs.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return {
    x, y,
    w: Math.max(...bs.map((b) => b.x + b.w)) - x,
    h: Math.max(...bs.map((b) => b.y + b.h)) - y,
  };
}

// The extra (dx, dy) that pulls box `b` fully onto a pageW×pageH page. Zero when it is
// already inside, so it is safe to apply unconditionally.
//
// WHY THIS EXISTS: BI-42 recorded the same requirement for the ✓/✗ stamps — an object
// left hanging over the edge of the sheet cannot be grabbed back, because the grips
// that would move it are off-paper too. Pasting hits that harder than stamping did: the
// target page can be a DIFFERENT SIZE from the one copied from (one PDF, many page
// sizes is normal in this app's world), so coordinates that were comfortably inside the
// source page can land outside the destination.
//
// An object BIGGER than the page can't be made to fit; pin its top-left instead of
// pushing it up and left off the other side, so at least its origin and one grip stay
// reachable. A non-positive page size means "unknown" (the caller could not read the
// page box) → don't move it, since guessing would be worse than leaving it be.
function fitShift(b, pageW, pageH) {
  const axis = (lo, size, page) => {
    if (!(page > 0)) return 0;
    if (size >= page || lo < 0) return -lo;
    if (lo + size > page) return page - (lo + size);
    return 0;
  };
  return { dx: axis(b.x, b.w, pageW), dy: axis(b.y, b.h, pageH) };
}

// ---- corner-grip resize --------------------------------------------------

// New box for a corner-grip drag. PURE arithmetic in the annot's own scale-1,
// y-down space, which is why it can be tested outside the browser:
// test/viewer-geom.test.js drives THIS function (docs/REGRESSION-GUARD.md §1).
//
//   dir    which corner is held — "nw" | "ne" | "sw" | "se".
//   orig   the box as it was when the drag started ({x, y, w, h}).
//   dx,dy  how far the cursor has moved since then.
//   ratio  true (Shift held) → keep orig's aspect ratio. The axis the user pulled
//          further wins, so the box follows the cursor instead of jittering
//          between the two candidate sizes.
//   min    smallest allowed side.
//
// The corner OPPOSITE the held one stays pinned; that is the whole job of the
// returned x/y. Dragging past that corner clamps at `min` rather than flipping.
function resizeRect(dir, orig, dx, dy, ratio, min) {
  const m = min > 0 ? min : 4;
  const west = dir.indexOf("w") >= 0;
  const north = dir.indexOf("n") >= 0;
  let w = orig.w + (west ? -dx : dx);
  let h = orig.h + (north ? -dy : dy);
  if (ratio && orig.w > 0 && orig.h > 0) {
    const r = orig.w / orig.h;
    // |Δw|/w vs |Δh|/h, cross-multiplied to dodge the divisions.
    if (Math.abs(w - orig.w) * orig.h >= Math.abs(h - orig.h) * orig.w) h = w / r;
    else w = h * r;
    // Clamping one side has to re-derive the other, or Shift would silently stop
    // holding the ratio as soon as the box reached the minimum.
    if (w < m) { w = m; h = m / r; }
    if (h < m) { h = m; w = m * r; }
  }
  w = Math.max(m, w);
  h = Math.max(m, h);
  return {
    x: west ? orig.x + orig.w - w : orig.x,
    y: north ? orig.y + orig.h - h : orig.y,
    w: w,
    h: h,
  };
}

// Stretch a POINT LIST so that its bounding box becomes `box` — the resize gesture for
// the shapes that have no x/y/w/h of their own (draw / cloudpen / poly).
//
// `from` is the bounding box the points had when the drag STARTED, and `pts` must be
// the points from that same moment: the caller keeps both in `drag.orig` and recomputes
// from them on every move, exactly like resizeRect. Deriving `from` fresh each move
// instead would compound the rounding of the previous move into the next one and the
// shape would creep away from the cursor.
//
// A zero-width or zero-height source (a perfectly horizontal stroke, which is a real
// thing on a drawing) cannot be scaled on that axis — there is nothing to scale FROM.
// Those points are TRANSLATED on that axis instead of being multiplied by infinity, so
// a flat stroke slides with the grip rather than vanishing into NaN.
//
// The PEN WIDTH is deliberately not touched: `width` is a property of the mark, not of
// its geometry, and a reviewer scaling a callout down does not want the line to thin
// out. Same for a cloud's `bump`. Both are what the GUI grid rows 13/14 pin.
function scalePts(pts, from, box) {
  const src = pts || [];
  if (!from || !box) return src.map((p) => ({ x: p.x, y: p.y }));
  const kx = from.w > 1e-6 ? box.w / from.w : 0;
  const ky = from.h > 1e-6 ? box.h / from.h : 0;
  return src.map((p) => ({
    x: kx ? box.x + (p.x - from.x) * kx : box.x + (p.x - from.x),
    y: ky ? box.y + (p.y - from.y) * ky : box.y + (p.y - from.y),
  }));
}

// ---- freehand stroke: the path, and thinning it for the file ---------------

// The SVG `d` of a freehand stroke, in LOCAL coordinates (its own bounding box's
// top-left is 0,0), plus that box. Same job cloudPathPoly does for a revision
// cloud, and the same reason: ONE string feeds the on-screen <svg>, pdf-lib's
// drawSvgPath inside the round-trip /AP, and (via the same point list) the
// flattened bake. Two implementations of "where is this scribble" would disagree
// the first time anyone touched either.
//
// NO `pad` HERE, unlike cloudPathPoly — and that is the whole difference between
// the two. A cloud's scallops bulge OUTSIDE the polygon the user clicked, so its
// path has to be shifted into positive coordinates before anything can measure it.
// A stroke's path is exactly the points; the only thing sticking out is half the
// pen width, which is the caller's `lw` padding, not geometry.
//
// Fewer than two DISTINCT points is not a stroke: null means "draw nothing", which
// is also what drawOneAnnot's `for (k = 1; k < pts.length; k++)` does with a single
// point. Both writers agree without either knowing about the other.
//
// Coordinates are emitted at 2dp: these are PDF points, so that is 1/100 pt ≈ 3.5
// µm — three orders of magnitude below anything a printer or screen resolves, and
// it keeps the string (which is also what goes in the file) about half the length.
function strokePath(pts) {
  const src = [];
  for (const p of pts || []) {
    if (!p || !isFinite(+p.x) || !isFinite(+p.y)) continue;
    const last = src[src.length - 1];
    if (!last || last.x !== +p.x || last.y !== +p.y) src.push({ x: +p.x, y: +p.y });
  }
  if (src.length < 2) return null;
  let minX = src[0].x, minY = src[0].y, maxX = src[0].x, maxY = src[0].y;
  for (const p of src) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const d = src
    .map((p, k) => (k ? "L " : "M ") + (p.x - minX).toFixed(2) + " " + (p.y - minY).toFixed(2))
    .join(" ");
  return { d, minX, minY, W: maxX - minX, H: maxY - minY };
}

// The SVG `d` of a FREE SHAPE (hình tự do): the same polyline strokePath emits, plus a
// `Z` when the shape is closed. Separate function rather than a flag on strokePath
// because the two have different callers and different failure answers, and because
// `Z` is not cosmetic — it is what lets pdf-lib fill the interior (`B` instead of `S`)
// and what makes the last corner a JOIN instead of two caps.
//
// Same contract as strokePath in every other respect: LOCAL coordinates (the shape's
// own bounding box top-left is 0,0), 2dp, and null for fewer than two distinct points.
// ONE string drives the on-screen <svg>, the round-trip /AP and the flattened bake
// (BI-40 / BI-69) — there is deliberately no second implementation to disagree with.
//
// A closed shape needs THREE distinct points to enclose anything; two would be a
// degenerate "there and back" sliver. It still returns a path (the user drew it, and a
// 2-point open segment is a legitimate thing to keep) — the CLOSING is what is refused,
// by falling back to the open form. Callers that must know ask `closed` back.
function polyPath(pts, closed) {
  const g = strokePath(pts);
  if (!g) return null;
  const shut = !!closed && countDistinct(pts) >= 3;
  return { d: shut ? g.d + " Z" : g.d, minX: g.minX, minY: g.minY, W: g.W, H: g.H, closed: shut };
}

// How many DISTINCT consecutive points a list carries. Shared by polyPath and the
// editor's "is this worth keeping?" guards so the two cannot disagree about whether a
// shape exists — the same reason cloudPathPoly's null is read by both writers.
function countDistinct(pts) {
  let n = 0;
  let last = null;
  for (const p of pts || []) {
    if (!p || !isFinite(+p.x) || !isFinite(+p.y)) continue;
    if (!last || last.x !== +p.x || last.y !== +p.y) { n++; last = { x: +p.x, y: +p.y }; }
  }
  return n;
}

// Ramer–Douglas–Peucker: drop the points that carry no shape.
//
// WHY A FREEHAND STROKE NEEDS THIS AND A KHOANH MÂY DOES NOT. `cloudpen` is a
// handful of CLICKED corners, so serializeManaged stores its `pts` verbatim.
// `draw` appends a point on EVERY mousemove (editor.js, the `drag.type === "draw"`
// branch), so one lazy diagonal across an A4 page is several hundred points and a
// signature-sized scribble runs into the thousands. Those all have to fit in the
// annotation's /NabuData hex string, on every page, on every save.
//
// TOLERANCE 0.3 pt ≈ 0.1 mm — a tenth of the width of the thinnest pen the toolbar
// offers, and below what 600 dpi print resolves (0.042 mm/px ⇒ 2.5 px). Measured on
// real scribbles it removes 85–95% of the points and the curve does not visibly move.
//
// IDEMPOTENT, and that matters more than the ratio: every surviving point is by
// construction farther than `tol` from the chord of its neighbours, so running this
// on its own output returns it unchanged. That is what makes save → reopen → save
// converge instead of eroding the stroke a little further each round (the same class
// of bug as re-translating an already-translated file).
//
// `maxPts` is a backstop, not the main mechanism: if a pathological stroke is still
// over budget the tolerance doubles and it runs again, rather than truncating the
// stroke — losing the TAIL of someone's signature is worse than a slightly coarser
// curve. The doubling is bounded so a degenerate input cannot spin here.
const STROKE_TOL = 0.3;
const STROKE_MAX_PTS = 2000;
function simplifyStroke(pts, tol, maxPts) {
  tol = tol == null ? STROKE_TOL : tol;
  maxPts = maxPts == null ? STROKE_MAX_PTS : maxPts;
  const src = (pts || []).filter((p) => p && isFinite(+p.x) && isFinite(+p.y))
    .map((p) => ({ x: +p.x, y: +p.y }));
  if (src.length <= 2) return src;
  let out = src;
  for (let round = 0; round < 12; round++) {
    out = strokeRdp(src, tol);
    if (out.length <= maxPts) break;
    tol *= 2;
  }
  return out;
}

// One RDP pass. Iterative (an explicit stack, not recursion): a 20 000-point
// scribble recurses ~as deep as it is long in the degenerate case, and blowing the
// renderer's stack mid-save would lose the whole bake, not just this annotation.
//
// `strokeRdp`, not `rdp`, and the prefix is load-bearing rather than decorative: this
// file is a CLASSIC SCRIPT, so every top-level name here lands in the scope SHARED by
// app.js, editor.js and a dozen others — even one that is never exported. A second
// top-level `rdp` anywhere in renderer/ would be two `function` declarations of one
// name in one scope, and the whole app goes white with a SyntaxError that no node test
// can see. That is BI-14, and the cheapest defence against it is not owning a
// three-letter generic noun in the global namespace.
function strokeRdp(pts, tol) {
  const n = pts.length;
  const keep = new Array(n).fill(false);
  keep[0] = keep[n - 1] = true;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const a = pts[lo], b = pts[hi];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let far = -1, best = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i];
      // Distance to the SEGMENT's line; for a closed loop (a === b) the chord has
      // no direction, so fall back to distance from the shared endpoint.
      const dist = len < 1e-9
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
      if (dist > best) { best = dist; far = i; }
    }
    if (best > tol && far > lo) {
      keep[far] = true;
      stack.push([lo, far], [far, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// ---- text highlight: selection rectangles → one quad per line ---------------

// Turn the raw rectangles a DOM Range hands back (`getClientRects()`, already converted
// to the annotation's scale-1 page space by the caller) into ONE quad per line of text.
//
// WHY THIS IS NOT "just use the rects". Measured on a real Vietnamese standards PDF
// (1.TCVN 3890 - 2023.pdf, 14 selected lines): the browser returned **154 rectangles**,
// several of them EXACT DUPLICATES of each other. A highlight is painted with
// `mix-blend-mode: multiply`, so two stacked quads multiply twice and that line comes
// out VISIBLY DARKER than its neighbours — a patchy wash, not a highlight. The first
// version of this grouped by a rounded y-bucket and still left 18 quads for 14 lines,
// with the doubling plainly visible in the screenshot. Grouping by vertical OVERLAP
// leaves 14 quads, 0 overlapping pairs, all exactly one line high. See
// docs/RESEARCH-2026-09-20c-text-highlight-free-shape.md §3.2 for the pictures.
//
// The line test is SYMMETRIC — this rect's centre must fall inside the line's band AND
// the line's centre inside this rect. A one-sided test lets a tall rect (a superscript,
// or a run in a bigger font) swallow the line above or below it into one giant quad.
//
// GAP is in PDF points: quads closer than this on the same line are one run of text
// with an inter-word or inter-span gap, and merging them is what stops a highlight from
// looking like a row of separate stickers. 1.5pt ≈ half a space at 12pt.
//
// Degenerate rects (zero or sub-pixel size) are dropped up front: pdf.js emits
// zero-height `markedContent` spans, and a selection that starts at the very end of a
// span produces empty rects. 7 of 71 rects on the cover page of that same file.
const QUAD_GAP = 1.5;
const QUAD_MIN = 0.4;
// The wash strength of a text highlight, in ONE place because four writers have to agree
// to the digit: the overlay quads (editor.js renderAnnot), the flattened bake
// (drawOneAnnot), the round-trip /AP (addManagedAnnot) and the rotation grid. 0.4 is what
// the rectangle highlighter has always used on screen (app.css `.an-highlight`), and
// matching it is the point — the two tools lay down the SAME mark, so a document with
// both must not show two shades of yellow.
const TEXTHL_OPACITY = 0.4;
function quadsFromRects(rects, gap) {
  const g = gap == null ? QUAD_GAP : gap;
  const src = (rects || [])
    .filter((r) => r && isFinite(r.x) && isFinite(r.y) && r.w > QUAD_MIN && r.h > QUAD_MIN)
    .map((r) => ({ x: +r.x, y: +r.y, w: +r.w, h: +r.h }))
    .sort((p, q) => p.y - q.y || p.x - q.x);
  const lines = [];
  for (const r of src) {
    const mid = r.y + r.h / 2;
    let line = null;
    for (const L of lines) {
      const lmid = L.y + L.h / 2;
      if (mid > L.y && mid < L.y + L.h && lmid > r.y && lmid < r.y + r.h) { line = L; break; }
    }
    if (!line) { lines.push({ y: r.y, h: r.h, items: [r] }); continue; }
    const top = Math.min(line.y, r.y);
    const bot = Math.max(line.y + line.h, r.y + r.h);
    line.y = top;
    line.h = bot - top;
    line.items.push(r);
  }
  const out = [];
  for (const L of lines) {
    L.items.sort((p, q) => p.x - q.x);
    let cur = null;
    for (const r of L.items) {
      if (!cur) { cur = { x: r.x, y: r.y, w: r.w, h: r.h }; continue; }
      if (r.x <= cur.x + cur.w + g) {
        const right = Math.max(cur.x + cur.w, r.x + r.w);
        const top = Math.min(cur.y, r.y);
        const bot = Math.max(cur.y + cur.h, r.y + r.h);
        cur.x = Math.min(cur.x, r.x);
        cur.w = right - cur.x;
        cur.y = top;
        cur.h = bot - top;
      } else {
        out.push(cur);
        cur = { x: r.x, y: r.y, w: r.w, h: r.h };
      }
    }
    if (cur) out.push(cur);
  }
  // 2dp for the same reason strokePath rounds: these numbers go in the file, and
  // 1/100 pt is three orders of magnitude finer than anything that renders.
  return out.map((q) => ({
    x: +q.x.toFixed(2), y: +q.y.toFixed(2), w: +q.w.toFixed(2), h: +q.h.toFixed(2),
  }));
}

// ---- nét đứt (line style) ----------------------------------------------------
//
// ONE source of numbers for FOUR writers that have to paint the same line (BI-40): the
// overlay <svg> (renderAnnot), the round-trip /AP (managed-codec shapeAppearance), the
// arrow's canvas PNG (renderArrowPng) and the flattening fallback (drawOneAnnot). Each of
// them used to need nothing here — a solid line has no pattern to disagree about — so the
// moment a second one reads its own idea of "dashed", a saved file stops matching the screen.
//
// SOLID IS ABSENCE. `normDash` maps anything unknown (a missing key, a hand-edited file) to
// "solid" and `dashSpec` returns null for it, so a solid line goes through the exact code
// it went through before this existed and 0° documents stay byte-identical (BI-59).
//
// Lengths scale with the pen width, so a hairline and an 8pt stroke both read as dashed.
// The CAP is part of the style, not a free choice: a round cap lengthens every dash by one
// pen width at each end and would close a short gap, so "dash" uses butt caps; "dot" is a
// near-zero-length dash drawn with a ROUND cap, which paints a true circle. 0.01 rather
// than 0: a zero-length dash is legal PDF, but not every reader honours it.
const DASH_KINDS = new Set(["box", "ellipse", "draw", "poly", "arrow"]);
function normDash(d) { return d === "dash" || d === "dot" ? d : "solid"; }
function dashSpec(dash, width) {
  const d = normDash(dash);
  if (d === "solid") return null;
  const w = Math.max(1, +width || 2);
  const r = (n) => +n.toFixed(2);
  return d === "dot"
    ? { array: [0.01, r(w * 2)], cap: "round" }
    : { array: [r(w * 4), r(w * 3)], cap: "butt" };
}

// Walk a polyline and return its ON stretches as [from, to] point pairs. Needed ONLY by the
// flattening fallback for freehand strokes and polygons: that path draws one drawLine per
// segment (to stay correct on a /Rotate page), and a dash pattern restarts at every
// drawLine — on a freehand stroke made of 2pt segments that turns "dashed" into "solid".
// Walking the whole path once and emitting the pieces keeps the rhythm. Pure, in the
// caller's own coordinate space; the caller maps each endpoint (an isometry at scale 1).
function dashSegments(pts, array) {
  const out = [];
  if (!pts || pts.length < 2 || !array || array.length < 2) return out;
  if (!array.every((v) => v > 0.001)) return out; // a 0 would never advance
  let idx = 0, left = array[0], on = true;
  for (let k = 1; k < pts.length; k++) {
    let x = pts[k - 1].x, y = pts[k - 1].y;
    const dx = pts[k].x - x, dy = pts[k].y - y;
    let seg = Math.hypot(dx, dy);
    if (!(seg > 0)) continue;
    const ux = dx / seg, uy = dy / seg;
    while (seg > 1e-9) {
      const step = Math.min(left, seg);
      const nx = x + ux * step, ny = y + uy * step;
      if (on) out.push([{ x, y }, { x: nx, y: ny }]);
      x = nx; y = ny; seg -= step; left -= step;
      if (left <= 1e-9) { idx = (idx + 1) % array.length; on = !on; left = array[idx]; }
    }
  }
  return out;
}

// ---- z-order (thứ tự chồng) ------------------------------------------------
//
// An annotation's stacking order IS its position in `ed.annots[page]`: renderLayer
// appends elements in array order, the bake adds the managed ones to /Annots in array
// order, and importManaged reads /Annots back in that order — so reordering the array is
// the WHOLE feature, and there is deliberately no `z` field to fall out of step with it.
// BI-93.
//
// `list` is the page's annots (bottom → top), `ids` the selected ids. Returns a NEW
// array (never mutates), so the caller can compare it with the old one and skip the undo
// step when nothing would move.
//
// "forward"/"backward" move the selected block ONE step past its nearest UNSELECTED
// neighbour — the Office rule — so a group keeps its internal order and a selection that
// is already at the edge simply stays put. "front"/"back" gather the selection at the
// end/start, again keeping its internal order.
function reorderZ(list, ids, op) {
  const out = list.slice();
  const sel = new Set(ids);
  if (!sel.size) return out;
  const on = (a) => sel.has(a.id);
  if (op === "front" || op === "back") {
    const picked = out.filter(on);
    const rest = out.filter((a) => !on(a));
    return op === "front" ? rest.concat(picked) : picked.concat(rest);
  }
  if (op === "forward") {
    // Top-down, so a block moves up by exactly one slot instead of cascading.
    for (let i = out.length - 2; i >= 0; i--) {
      if (on(out[i]) && !on(out[i + 1])) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
    }
  } else if (op === "backward") {
    for (let i = 1; i < out.length; i++) {
      if (on(out[i]) && !on(out[i - 1])) { const t = out[i]; out[i] = out[i - 1]; out[i - 1] = t; }
    }
  }
  return out;
}

// node (tests) takes the module export; the browser already has the bare names
// above in the shared script scope. window.AnnotGeom is the same set under a name a
// probe can assert on. Mirrors the tail of wire.js / annot-text.js exactly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CLOUD_BUMP, CLOUD_BUMP_MIN, CLOUD_BUMP_MAX, bumpOf, SYMBOL_SIZE,
    ANGLE_SNAP_DEG, STROKE_TOL, STROKE_MAX_PTS, QUAD_GAP, QUAD_MIN, TEXTHL_OPACITY,
    PTS_KINDS, QUAD_KINDS, isPtsKind, isQuadKind, reorderZ, DASH_KINDS, normDash, dashSpec, dashSegments,
    annotBounds, arrowLabelPos, cloudPath, arcApex, cloudPathPoly, countDistinct,
    fitShift, polyPath, quadsFromRects, resizeRect, scalePts, simplifyStroke,
    snapLineEnd, strokeExtend, strokePath, symbolStrokes,
    translateAnnot, unionBounds,
  };
}
if (typeof window !== "undefined") {
  window.AnnotGeom = {
    CLOUD_BUMP, CLOUD_BUMP_MIN, CLOUD_BUMP_MAX, bumpOf, SYMBOL_SIZE,
    ANGLE_SNAP_DEG, STROKE_TOL, STROKE_MAX_PTS, QUAD_GAP, QUAD_MIN, TEXTHL_OPACITY,
    PTS_KINDS, QUAD_KINDS, isPtsKind, isQuadKind, reorderZ, DASH_KINDS, normDash, dashSpec, dashSegments,
    annotBounds, arrowLabelPos, cloudPath, arcApex, cloudPathPoly, countDistinct,
    fitShift, polyPath, quadsFromRects, resizeRect, scalePts, simplifyStroke,
    snapLineEnd, strokeExtend, strokePath, symbolStrokes,
    translateAnnot, unionBounds,
  };
}
