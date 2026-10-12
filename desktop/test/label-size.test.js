"use strict";

// Regression net for Cỡ nhãn (P7): the label font size of an arrow and of a dimension line.
//
// The field `labelSize` existed long before its control — every reader fell back to 14
// (overlay <svg>, renderArrowPng, drawOneAnnot, /NabuData) — but nothing could set it. P7
// adds the edit-bar box. What can break:
//   1. the clamp (normLabelSize) — junk must read as the default, not as the floor;
//   2. the readers' fallback drifting from LABEL_SIZE_DEFAULT (an unsized label would
//      change size, and a saved arrow's /NabuData bytes would change — BI-59);
//   3. the wiring: which tools / kinds show the box, that creation stamps the session
//      size, that selecting shows the object's size, that switching tool shows the next
//      one's;
//   4. the handler itself (cut out of editor.js and run): selection-wide, kind-filtered,
//      one undo per burst, no undo when nothing changes, clamped write-back on `change`;
//   5. /NabuData: a resized arrow keeps its size; a default one is byte-identical to an
//      arrow written before this control existed.
//
// Run:  node desktop/test/label-size.test.js     (or: npm run test:labelsize)

const fs = require("fs");
const path = require("path");
const G = require("../renderer/annot-geom.js");
const MC = require("../renderer/managed-codec.js");
const { LABEL_SIZE_MIN, LABEL_SIZE_MAX, LABEL_SIZE_DEFAULT, normLabelSize } = G;
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8").replace(/\r\n/g, "\n");
const ED = R("editor.js");
const BAKE = R("editor-bake.js");
const CODEC = R("managed-codec.js");
const HTML = R("index.html");
const I18N = R("i18n.js");

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

// ---- 1. the clamp ------------------------------------------------------------------------

check("constants: 6 / 72 / 14", [LABEL_SIZE_MIN, LABEL_SIZE_MAX, LABEL_SIZE_DEFAULT], [6, 72, 14]);
for (const junk of [undefined, null, "", "abc", NaN, 0, -5, Infinity, {}]) {
  check(`normLabelSize(${String(junk)}) → the default, not the floor`, normLabelSize(junk), 14);
}
check("below the floor clamps up", normLabelSize(3), 6);
check("above the ceiling clamps down", normLabelSize(500), 72);
check("the bounds themselves are kept", [normLabelSize(6), normLabelSize(72)], [6, 72]);
check("a number field's string value is read", normLabelSize("24"), 24);
check("fractions round (the box steps by 1)", [normLabelSize(13.6), normLabelSize(13.4)], [14, 13]);

// ---- 2. every reader falls back to the same default --------------------------------------

const fallbacks = [ED, BAKE, CODEC].join("\n").match(/labelSize \|\| (\d+)/g) || [];
check("the readers still fall back with `labelSize || N` (overlay ×2, bake ×3, codec)", fallbacks.length >= 6, true);
check("…and every N is LABEL_SIZE_DEFAULT", [...new Set(fallbacks.map((m) => +m.split("|| ")[1]))], [LABEL_SIZE_DEFAULT]);

// ---- 3. wiring ---------------------------------------------------------------------------

const ctl = HTML.match(/<label class="ctl" data-ctl="labelsize"[^>]*>[^<]*<input type="number" id="ed-labelsize"([^>]*)\/>/);
check("index.html has the Cỡ nhãn box under data-ctl=labelsize", !!ctl, true);
if (ctl) {
  const attr = (k) => +(ctl[1].match(new RegExp(k + '="([^"]*)"')) || [])[1];
  check("its min / max / value are the module's constants", [attr("min"), attr("max"), attr("value")],
    [LABEL_SIZE_MIN, LABEL_SIZE_MAX, LABEL_SIZE_DEFAULT]);
}
const title = (HTML.match(/data-ctl="labelsize" title="([^"]*)"/) || [])[1];
check("i18n has the box's title", !!title && I18N.includes('"' + title + '"'), true);
check('i18n has "Cỡ nhãn"', I18N.includes('"Cỡ nhãn": "Label size"'), true);

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
const showing = (tbl) => Object.keys(tbl).filter((k) => tbl[k].includes("labelsize")).sort();
check("TOOL_CTLS: the box shows for the arrow and measure tools only", showing(objLiteral("TOOL_CTLS")), ["arrow", "measure"]);
check("KIND_CTLS: …and for a selected arrow or dimension line only", showing(objLiteral("KIND_CTLS")), ["arrow", "dim"]);
check("LABEL_SIZE_KINDS is exactly arrow + dim",
  /const LABEL_SIZE_KINDS = new Set\(\["arrow", "dim"\]\);/.test(ED), true);
check("LABEL_SIZE_KINDS is declared before `ed` (syncControls must not meet it in the TDZ)",
  ED.indexOf("const LABEL_SIZE_KINDS") >= 0 && ED.indexOf("const LABEL_SIZE_KINDS") < ED.indexOf("  const ed = {"), true);
check("the session default is LABEL_SIZE_DEFAULT", /labelSize: window\.AnnotGeom\.LABEL_SIZE_DEFAULT,/.test(ED), true);

const block = (marker) => {
  const i = ED.indexOf(marker);
  return i < 0 ? "" : ED.slice(i, ED.indexOf("return;", i));
};
check("a new arrow is stamped with the session size", /labelSize: ed\.labelSize/.test(block('if (ed.tool === "arrow") {')), true);
check("a new dimension line is stamped with the session size (no hard 14 any more)",
  /labelSize: ed\.labelSize/.test(block('if (ed.tool === "measure") {')), true);
check("selecting an arrow / dimension line shows ITS size",
  /if \(LABEL_SIZE_KINDS\.has\(a\.kind\)\) \$\("ed-labelsize"\)\.value = String\(window\.AnnotGeom\.normLabelSize\(a\.labelSize\)\);/.test(ED), true);
check("switching tool shows the size the NEXT one gets",
  /const lpick = \$\("ed-labelsize"\);[^\n]*\n\s*if \(lpick\) lpick\.value = String\(ed\.labelSize\);/.test(ED), true);
check("both input (live) and change (final) are wired",
  /\$\("ed-labelsize"\)\.oninput = \(e\) => applyLabelSize\(e\.target\.value, false\);\s*\$\("ed-labelsize"\)\.onchange = \(e\) => applyLabelSize\(e\.target\.value, true\);/.test(ED), true);

// ---- 4. the handler, cut out and run -----------------------------------------------------

const S = ED.indexOf("  const applyLabelSize = ");
const E = ED.indexOf("  $(\"ed-labelsize\").oninput", S);
if (S < 0 || E < 0) throw new Error("applyLabelSize not found — moved or renamed");
const HANDLER = ED.slice(S, E);

function rig(sel) {
  const log = { undo: [], sync: 0 };
  const box = { value: "" };
  const ed = { sel: sel.length ? sel[0].id : null, labelSize: 14 };
  const env = {
    ed, window: { AnnotGeom: G },
    LABEL_SIZE_KINDS: new Set(["arrow", "dim"]),
    $: (id) => { if (id !== "ed-labelsize") throw new Error("unexpected $(" + id + ")"); return box; },
    selAnnots: () => sel,
    pushEdUndo: (k) => log.undo.push(k),
    syncOverlays: () => log.sync++,
  };
  const apply = new Function(...Object.keys(env), HANDLER + "\nreturn applyLabelSize;")(...Object.values(env));
  return { apply, ed, box, log };
}
{
  const arrow = { id: 7, kind: "arrow", labelSize: 14 };
  const dim = { id: 8, kind: "dim" }; // no key at all = 14
  const boxA = { id: 9, kind: "box", width: 2 };
  const r = rig([arrow, dim, boxA]);
  r.apply("24", false);
  check("H1 the selection's arrows AND dimension lines take the size", [arrow.labelSize, dim.labelSize], [24, 24]);
  check("H1b …other kinds in the selection are untouched", "labelSize" in boxA, false);
  check("H1c one undo step, keyed for coalescing", r.log.undo, ["labelsize:7"]);
  check("H1d the overlays repaint once", r.log.sync, 1);
  check("H1e the next arrow / dimension line gets it too", r.ed.labelSize, 24);
  check("H1f a live (input) edit does not rewrite the box the user is typing in", r.box.value, "");
  r.apply("24", true);
  check("H2 the change that follows the same value adds no second undo", r.log.undo.length, 1);
  check("H2b …and writes the clamped value back", r.box.value, "24");
  r.apply("500", true);
  check("H3 an out-of-range entry is clamped on the object and in the box", [arrow.labelSize, r.box.value], [72, "72"]);
}
{
  const plain = { id: 3, kind: "arrow" }; // an arrow drawn before P7: no key
  const r = rig([plain]);
  r.apply("14", true);
  check("H4 setting the default on an unsized arrow is a no-op (no undo, no key written)",
    [r.log.undo.length, "labelSize" in plain], [0, false]);
}
{
  const r = rig([]);
  r.apply("30", true);
  check("H5 with nothing selected only the session size changes", [r.ed.labelSize, r.log.undo.length, r.log.sync], [30, 0, 0]);
}

// ---- 5. /NabuData --------------------------------------------------------------------------

const A0 = { kind: "arrow", x1: 10, y1: 10, x2: 90, y2: 40, color: "#ff0000", width: 2, label: "A", labelEnd: "head" };
check("a resized arrow writes its size", MC.serializeManaged({ ...A0, labelSize: 24 }).labelSize, 24);
check("an arrow stamped with the default is byte-identical to one written before P7 (BI-59)",
  JSON.stringify(MC.serializeManaged({ ...A0, labelSize: LABEL_SIZE_DEFAULT })), JSON.stringify(MC.serializeManaged(A0)));
check("deserializeManaged still reads labelSize back (default 14)", /labelSize: \+data\.labelSize \|\| 14,/.test(BAKE), true);

console.log(`\nlabel-size: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
