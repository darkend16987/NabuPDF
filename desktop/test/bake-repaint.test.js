"use strict";

// Source pins for "Ctrl+S in the middle of an annotation session repaints each page ONCE"
// — R8 of docs/REVIEW-2026-10-01.
//
// bakePending() used to end its mid-session branch with repaintRenderedPages(), which
// re-rasterised every page on screen a second time: the changed ones had just been repainted
// by rerenderChanged, the unchanged ones were already right (measured in real Chromium with a
// real text box: 3 page rasters → 1, identical canvas pixels on all three pages).
//
// Removing it is only sound because of a premise that lives in ANOTHER file: renderPageCanvas
// paints with annotations DISABLED whenever Editor.active, so rerenderChanged (run while the
// editor is still active) already hides the baked copy of the annots the overlay owns again.
// If either side changes the other must be re-thought, so both are pinned here. These are
// pins on text because the editor needs a DOM; the behaviour itself was verified by the
// real-Electron probe quoted in the commit.
//
// Run:  node desktop/test/bake-repaint.test.js      (or: npm test -- bake-repaint)

const fs = require("fs");
const path = require("path");

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

const R = path.join(__dirname, "..", "renderer");
const EDITOR = fs.readFileSync(process.env.BAKE_EDITOR || path.join(R, "editor.js"), "utf8");
const APP = fs.readFileSync(process.env.BAKE_APP || path.join(R, "app.js"), "utf8");

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

const bake = body(EDITOR, "async function bakePending()");
const exit = body(EDITOR, "async function exit()");
const discard = body(EDITOR, "async function discardExit()");
const enter = body(EDITOR, "async function enter()");
const render = body(APP, "async function renderPageCanvas(");

// the mid-session branch
const mid = bake.slice(bake.indexOf("if (ed.active && !ed._exiting)"));
check("bakePending repaints the changed pages through rerenderChanged", /await rerenderChanged\(changed\)/.test(bake), true);
check("…while it still re-reads the managed annots and re-syncs the overlay", /importManaged\(\)/.test(mid) && /syncOverlays\(\)/.test(mid), true);
check("bakePending has no executable call to repaintRenderedPages at all (a comment may mention it)",
  /^[^/\n]*repaintRenderedPages\(\)/m.test(bake), false);

// the places that MUST still repaint, because the same bytes are shown with annotations toggled
check("enter() repaints after importing managed annots (hides their baked copies)", /repaintRenderedPages\(\)/.test(enter), true);
check("exit() repaints so baked text/notes show again in view mode", /repaintRenderedPages\(\)/.test(exit), true);
check("discardExit() repaints for the same reason", /repaintRenderedPages\(\)/.test(discard), true);

// the premise
check("renderPageCanvas derives `editing` from Editor.active", /const editing = !!\(window\.Editor && window\.Editor\.active\);/.test(render), true);
check("…and turns annotations off when editing", /annotationMode: editing \? pdfjsLib\.AnnotationMode\.DISABLE/.test(render), true);
check("Editor.active stays true through a mid-session bake (bakePending never clears ed.active)", /ed\.active\s*=\s*false/.test(bake), false);

console.log(`\nbake-repaint: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
