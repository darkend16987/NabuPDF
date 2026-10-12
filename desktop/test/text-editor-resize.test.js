"use strict";

// Regression net for BI-111: the inline text editor's "drag the field wider ⇒ fixed-width
// box" rule (BI-104) must fire for the USER's drag only.
//
// THE BUG. A point box's field is `cols` wide — 26 average glyphs of its current font — so
// any re-paint of its style changes its width: pressing Đậm (B), changing the size or the
// font while typing (paint, via ed._taPreview). The ResizeObserver took every such change
// for a drag of the resize corner and turned the label into a fixed-width box at the
// field's width. Measured in the real app (Chú thích → T → click → type → B): a 254pt
// fixed box for a 44pt label; size 24 ⇒ 310pt.
//
// HOW. editor.js cannot run in node, so the observer + pointer block is CUT OUT of the
// shipping file by its markers and driven with a fake ResizeObserver, field and document.
// A rename or a move fails the cut loudly instead of silently testing nothing.
//
// Run:  node desktop/test/text-editor-resize.test.js      (or: npm run test:taresize)

const fs = require("fs");
const path = require("path");
const ED = fs.readFileSync(path.join(__dirname, "..", "renderer", "editor.js"), "utf8");

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

const START = "    let baseW = null;\n    let pressed = false;";
const END = "    // Retyping a TURNED box";
const norm = ED.replace(/\r\n/g, "\n");
const i = norm.indexOf(START);
const j = norm.indexOf(END, i + 1);
if (i < 0 || j < 0 || norm.indexOf(START, i + 1) >= 0) throw new Error("cut markers not found once — the observer block moved or was renamed");
const SRC = norm.slice(i, j);

function rig(opts) {
  const o = opts || {};
  const calls = [];
  const docL = {};
  let roCb = null;
  const ta = {
    isConnected: true,
    offsetWidth: 212,
    clientWidth: 208,
    _l: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    fire(t) { (this._l[t] || []).forEach((f) => f({})); },
  };
  const document = {
    addEventListener(t, f) { (docL[t] = docL[t] || []).push(f); },
    removeEventListener(t, f) { docL[t] = (docL[t] || []).filter((g) => g !== f); },
    fire(t) { (docL[t] || []).slice().forEach((f) => f({})); },
    count: () => Object.values(docL).reduce((n, a) => n + a.length, 0),
  };
  class ResizeObserver {
    constructor(cb) { roCb = cb; }
    observe() {}
    disconnect() { calls.push("disconnect"); }
  }
  const env = {
    ta, document, ResizeObserver,
    state: { scale: o.scale || 1 },
    getComputedStyle: () => ({ paddingLeft: "2px", paddingRight: "2px" }),
    setBox: (left, w) => calls.push(["setBox", left, w]),
  };
  // `ownW` is the enclosing function's `let` (the width WE last gave the field).
  const api = new Function(...Object.keys(env), "let ownW = " + JSON.stringify(o.ownW == null ? null : o.ownW) + ";\n" + SRC +
    "\nreturn { setOwnW: (v) => { ownW = v; } };")(...Object.values(env));
  const layout = (w) => { ta.offsetWidth = w; ta.clientWidth = w - 4; if (roCb) roCb(); };
  return { ta, document, calls, layout, api, roFire: () => roCb && roCb() };
}

{
  const r = rig();
  r.layout(212); // first layout
  r.layout(255); // Đậm pressed while typing: the field re-paints wider
  check("W1 the app re-painting the field (B / size / font) does NOT make a fixed box", r.calls, []);
  r.layout(308); // size 24
  check("W1b …nor does a second re-paint", r.calls, []);
  // the user now clicks in the field to move the caret — a press with NO width change
  r.ta.fire("pointerdown");
  r.document.fire("pointerup");
  check("W2 a click in the field after a re-paint changes nothing (the baseline moved with the re-paint)", r.calls, []);
}
{
  const r = rig();
  r.layout(212);
  r.ta.fire("pointerdown");
  r.layout(292); // the resize corner is dragged 80px wider
  check("W3 dragging the resize corner (pressed + width change) makes the fixed box, live, at the CONTENT width",
    r.calls, [["setBox", null, 292 - 4 - 4]]);
  r.document.fire("pointerup");
  check("W3b …and the release does not add a second, duplicate conversion", r.calls.length, 1);
}
{
  // Shrinking drags the pointer OUTSIDE the field, so the release lands elsewhere — the
  // listener is on the document. Afterwards a re-paint must again be ignored.
  const r = rig();
  r.layout(212);
  r.ta.fire("pointerdown");
  r.layout(120);
  r.document.fire("pointerup");
  r.layout(160); // a later palette change
  check("W4 a release outside the field ends the press; a later re-paint is ignored again",
    r.calls, [["setBox", null, 120 - 4 - 4]]);
  check("W4b …and the one-shot listeners are gone (no leak per editor)", r.document.count(), 0);
}
{
  // The drag's last frame: the width changed while pressed but the observer has not run
  // yet when the pointer is released — the release re-checks.
  const r = rig();
  r.layout(212);
  r.ta.fire("pointerdown");
  r.ta.offsetWidth = 250; r.ta.clientWidth = 246; // laid out, observer not yet called
  r.document.fire("pointerup");
  check("W5 the release catches a drag whose last frame the observer has not reported yet", r.calls, [["setBox", null, 246 - 4]]);
}
{
  // Mid-drag, setBox → applyBox writes the field's width itself (ownW); its echo through the
  // observer must not count as another drag. The baseline is still the pre-drag 212 here,
  // so only the ownW test can tell the echo apart.
  const r = rig();
  r.layout(212);
  r.ta.fire("pointerdown");
  r.api.setOwnW(260);
  r.layout(260.4); // our own write echoing back
  check("W6 while pressed, our own width write is still not a user drag", r.calls, []);
  r.document.fire("pointercancel");
  check("W6b pointercancel ends the press too", r.document.count(), 0);
}
{
  const r = rig();
  r.layout(212);
  r.ta.isConnected = false;
  r.roFire();
  check("W7 a field that is gone disconnects its observer", r.calls, ["disconnect"]);
}
check("W8 the observer only acts while pressed (the gate itself)",
  /if \(baseW == null \|\| !pressed\) \{\s*(?:\/\/[^\n]*\n\s*)*baseW = ta\.offsetWidth;\s*return;\s*\}/.test(SRC), true);

console.log(`\ntext-editor-resize: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
