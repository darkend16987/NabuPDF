"use strict";

// Regression net for BI-113: the Nét box must set the stroke of EVERY kind it is shown for.
//
// THE BUG. KIND_CTLS showed "penwidth" for a selected dimension line (dim), but the two
// hand-copied kind lists behind the box — the ed-penwidth handler and syncControls — both
// left "dim" out. Typing Nét 6 on a selected dimension line changed nothing (on screen or
// in the saved file, measured: 1pt), and the box kept showing the typed 6 as if it had.
//
// HOW. One Set (PEN_WIDTH_KINDS) now feeds both, and this grid pins it to KIND_CTLS — so a
// new kind that shows Nét without being in the set (or the reverse) fails here. The handler
// is cut out of editor.js and run against a fake selection.
//
// Run:  node desktop/test/pen-width.test.js     (or: npm run test:penwidth)

const fs = require("fs");
const path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8").replace(/\r\n/g, "\n");
const ED = R("editor.js");
const BAKE = R("editor-bake.js");

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

function objLiteral(name) {
  const at = ED.indexOf("  const " + name + " = {");
  if (at < 0) throw new Error(name + " not found");
  const open = ED.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < ED.length; i++) {
    if (ED[i] === "{") depth++;
    else if (ED[i] === "}" && --depth === 0) return eval("(" + ED.slice(open, i + 1) + ")"); // eslint-disable-line no-eval
  }
  throw new Error(name + " unterminated");
}
const m = ED.match(/  const PEN_WIDTH_KINDS = new Set\((\[[^\]]*\])\);/);
if (!m) throw new Error("PEN_WIDTH_KINDS not found — moved or renamed");
const PEN = JSON.parse(m[1]);
const KIND = objLiteral("KIND_CTLS");
const showsNet = Object.keys(KIND).filter((k) => KIND[k].includes("penwidth")).sort();

check("P1 PEN_WIDTH_KINDS is exactly the kinds KIND_CTLS shows Nét for", [...PEN].sort(), showsNet);
check("P1b …and that includes the dimension line (the BI-113 bug)", PEN.includes("dim"), true);
check("P2 declared before `ed` (syncControls must never meet it in the TDZ)",
  ED.indexOf("const PEN_WIDTH_KINDS") < ED.indexOf("  const ed = {"), true);
check("P3 no hand-copied stroke-kind list is left to drift",
  /"poly", "arrow", "check", "cross"\]/.test(ED), false);
check("P4 selecting shows the object's own width for every such kind",
  /if \(PEN_WIDTH_KINDS\.has\(a\.kind\) && a\.width\) \$\("ed-penwidth"\)\.value = String\(a\.width\);/.test(ED), true);

// the handler, cut out and run
const S = ED.indexOf('  $("ed-penwidth").oninput = (e) => {');
const E = ED.indexOf("\n  };\n", S);
if (S < 0 || E < 0) throw new Error("ed-penwidth handler not found");
const HANDLER = ED.slice(S, E + 5);
function rig(sel) {
  const log = { undo: [], sync: 0 };
  const box = {};
  const ed = { sel: sel.length ? sel[0].id : null, penWidth: 1 };
  const env = {
    ed, DEFAULT_PEN_WIDTH: 1, PEN_WIDTH_KINDS: new Set(PEN),
    $: (id) => { if (id !== "ed-penwidth") throw new Error("unexpected $(" + id + ")"); return box; },
    selAnnots: () => sel,
    pushEdUndo: (k) => log.undo.push(k),
    syncOverlays: () => log.sync++,
  };
  new Function(...Object.keys(env), HANDLER)(...Object.values(env));
  return { fire: (v) => box.oninput({ target: { value: v } }), ed, log };
}
{
  const dim = { id: 4, kind: "dim", width: 1 };
  const box = { id: 5, kind: "box", width: 1 };
  const text = { id: 6, kind: "text" };
  const r = rig([dim, box, text]);
  r.fire("6");
  check("H1 a selected dimension line takes the new width", dim.width, 6);
  check("H1b …as does every other stroked kind in the selection", box.width, 6);
  check("H1c …a text box does not grow a width", "width" in text, false);
  check("H1d one undo step, one repaint", [r.log.undo, r.log.sync], [["pwidth:4"], 1]);
  check("H1e the session width follows", r.ed.penWidth, 6);
}
{
  const r = rig([{ id: 9, kind: "dim", width: 2 }]);
  r.fire("");
  check("H2 an empty box falls back to the default width, not 0", r.ed.penWidth, 1);
}

// …and the width it writes is the one both painters read for a dimension line
const dimOverlay = ED.slice(ED.indexOf('if (a.kind === "dim") {'), ED.indexOf('if (a.kind === "cloud") {'));
check("O1 the overlay strokes a dimension line with a.width", /String\(a\.width \|\| 2\)/.test(dimOverlay), true);
const dimBake = BAKE.slice(BAKE.indexOf('} else if (a.kind === "dim") {'), BAKE.indexOf('} else if (a.kind === "note") {'));
check("O2 the flatten draws it with a.width (line + ticks)", /const w = a\.width \|\| 2;/.test(dimBake) && (dimBake.match(/thickness: w/g) || []).length >= 2, true);

console.log(`\npen-width: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
