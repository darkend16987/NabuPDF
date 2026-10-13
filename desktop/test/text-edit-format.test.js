"use strict";

// Regression net for the "Sửa chữ gốc" formatting fields (text-edit.js), extended by P8
// (BI-114: Gạch ngang `strike` + Căn lề `align`).
//
// A style field lives in FIVE places in text-edit.js, and one left out loses the format
// silently — the button lights up, Áp dụng writes the old look:
//   readControls (the bar → a style), onControlChange (style → the staged edit),
//   stage() inside beginEdit (the textarea commit), seedEdit (the span as it is) and
//   isPristine (is this edit a no-op?). Plus stage()'s `styleChanged`, which decides
//   whether a format-only change is kept at all.
// This grid pins the five to the same key set, runs the pure helpers, and checks the bar.
//
// Run:  node desktop/test/text-edit-format.test.js     (or: npm run test:teformat)

const fs = require("fs");
const path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8").replace(/\r\n/g, "\n");
const SRC = R("text-edit.js");
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

function block(start) {
  const at = SRC.indexOf(start);
  if (at < 0) throw new Error("not found: " + start);
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error("unterminated: " + start);
}
const keysOfLiteral = (src) => [...src.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const STYLE = ["size", "color", "bg", "bold", "italic", "underline", "strike", "align", "font"].sort();

// readControls → the style object
const rc = block("function readControls()");
check("F1 readControls reads every style field (strike + align included)", keysOfLiteral(rc).sort(), STYLE);
// onControlChange → assigns each onto the staged edit
const occ = block("function onControlChange()");
check("F2 onControlChange copies every style field onto the edit",
  [...occ.matchAll(/ed\.(\w+) = st\.\1;/g)].map((m) => m[1]).sort(), STYLE);
// seedEdit → the span as it is
const seed = block("function seedEdit(sp)");
const seedKeys = keysOfLiteral(seed);
check("F3 seedEdit seeds every style field", STYLE.every((k) => seedKeys.includes(k)), true);
check("F3b …with strike off and align left (what an edit did before P8)",
  [/strike: false,/.test(seed), /align: "left",/.test(seed)], [true, true]);
// isPristine → compares every field that can make an edit real
const pri = block("function isPristine(sp, ed)");
const priKeys = JSON.parse((pri.match(/return (\[[^\]]*\])\.every/) || [])[1].replace(/'/g, '"'));
check("F4 isPristine compares new_text + every style field", priKeys.slice().sort(), ["new_text", ...STYLE].sort());
// stage() inside beginEdit
const st = block("const stage = () =>");
const payload = st.slice(st.indexOf("te.edits[sp.id] = {"));
check("F5 stage() writes every style field into the staged edit",
  STYLE.every((k) => new RegExp("\\b" + k + ": st\\." + k + ",").test(payload)), true);
const changed = st.slice(st.indexOf("const styleChanged ="), st.indexOf("if (val !== sp.text"));
check("F6 a strike-only change is kept (styleChanged sees it)", /st\.strike \|\|/.test(changed), true);
check("F6b an align-only change is kept (anything but left)", /st\.align !== "left" \|\|/.test(changed), true);

// the pure helpers, run
const helpers = ["const TE_ALIGNS", "function normAlign(v)", "function setAlignBtns(v)", "function readAlign()"]
  .map((s) => (s.startsWith("const") ? SRC.slice(SRC.indexOf(s), SRC.indexOf("\n", SRC.indexOf(s)) + 1) : block(s))).join("\n");
function rigDoc() {
  const btns = ["left", "center", "right"].map((a) => ({
    dataset: { align: a }, cls: new Set(a === "left" ? ["active"] : []),
    classList: null,
  }));
  for (const b of btns) b.classList = { toggle: (c, on) => (on ? b.cls.add(c) : b.cls.delete(c)), contains: (c) => b.cls.has(c) };
  const document = {
    querySelectorAll: (q) => (q === "#te-align [data-align]" ? btns : []),
    querySelector: (q) => (q === "#te-align [data-align].active" ? btns.find((b) => b.cls.has("active")) || null : null),
  };
  return { btns, document };
}
const { btns, document } = rigDoc();
const H = new Function("document", helpers + "\nreturn { normAlign, setAlignBtns, readAlign };")(document);
for (const [v, e] of [["left", "left"], ["center", "center"], ["right", "right"], [undefined, "left"], ["justify", "left"], ["", "left"], [null, "left"]]) {
  check(`A1 normAlign(${JSON.stringify(v)}) → ${e}`, H.normAlign(v), e);
}
H.setAlignBtns("right");
check("A2 picking one lights exactly that one", btns.map((b) => b.cls.has("active")), [false, false, true]);
check("A3 readAlign reads it back", H.readAlign(), "right");
H.setAlignBtns("bogus");
check("A4 an unknown value lights Căn trái (the default)", [btns.map((b) => b.cls.has("active")), H.readAlign()], [[true, false, false], "left"]);
for (const b of btns) b.cls.delete("active");
check("A5 nothing lit reads as left", H.readAlign(), "left");

// syncControls reflects a staged edit's strike + align
const sc = block("function syncControls(sp)");
check("C1 syncControls shows the edit's strike", /setFmtBtn\("te-strike", ed \? !!ed\.strike : false\);/.test(sc), true);
check("C2 syncControls shows the edit's alignment", /setAlignBtns\(ed \? ed\.align : "left"\);/.test(sc), true);
check("C3 the strike button is wired like B / I / U (keeps the textarea's focus)",
  /\["te-bold", "te-italic", "te-underline", "te-strike"\]\.forEach/.test(SRC), true);
check("C4 the align buttons keep focus too and go through onControlChange",
  /#te-align \[data-align\]"\)\.forEach\(\(b\) => \{\s*b\.addEventListener\("mousedown", \(e\) => e\.preventDefault\(\)\);\s*b\.addEventListener\("click", \(\) => \{\s*setAlignBtns\(b\.dataset\.align\);\s*onControlChange\(\);/.test(SRC), true);
check("C5 the moved-span preview shows a strike", /ed\.strike && "line-through"/.test(SRC), true);

// BI-115: a format click while a span's field is open must NOT rebuild the layer (that
// removed the <textarea>: the field closed mid-typing and the next keystrokes went
// nowhere — measured: "12" + B + ".345" saved as "12"). onControlChange cut out and run.
function runOcc(openValue) {
  const calls = [];
  const staged = {};
  const env = {
    targetSpanId: () => 7,
    ensureEdit: () => staged,
    readControls: () => ({ size: 11, color: "#000000", bg: null, bold: true, italic: false, underline: false, strike: false, align: "right", font: "__keep__" }),
    document: { querySelector: (q) => (q === ".span-input" && openValue != null ? { value: openValue } : null) },
    renderBoxes: () => calls.push("renderBoxes"),
    updateHint: () => calls.push("updateHint"),
  };
  new Function(...Object.keys(env), occ + "\nonControlChange();")(...Object.values(env));
  return { calls, staged };
}
{
  const r = runOcc("12");
  check("K1 field open: the layer is NOT rebuilt (the field survives), the counter still updates", r.calls, ["updateHint"]);
  check("K1b …and the edit is staged with the typed text + the new format", [r.staged.new_text, r.staged.bold, r.staged.align], ["12", true, "right"]);
  const q = runOcc(null);
  check("K2 no field open (a span clicked earlier): the boxes repaint as before", q.calls, ["renderBoxes", "updateHint"]);
}
const be = block("function beginEdit(sp, box)");
check("K3 the edit as it stood when the field opened is kept for Esc",
  /const before = te\.edits\[sp\.id\] \? \{ \.\.\.te\.edits\[sp\.id\] \} : null;/.test(be), true);
const cancel = be.slice(be.indexOf("const cancel = () =>"), be.indexOf("ta.addEventListener(\"blur\", commit);"));
check("K4 Esc puts that edit back (or drops a fresh one) and re-syncs the bar",
  /if \(before\) te\.edits\[sp\.id\] = before;\s*else delete te\.edits\[sp\.id\];\s*syncControls\(sp\);[^\n]*\n\s*updateHint\(\);/.test(cancel), true);

// the bar
check("B1 index.html has the S button", /<button id="te-strike" class="icon-only te-fmt"/.test(HTML), true);
const grp = (HTML.match(/<span id="te-align"[\s\S]*?<\/span>/) || [""])[0];
check("B2 #te-align holds exactly left / center / right", [...grp.matchAll(/data-align="(\w+)"/g)].map((m) => m[1]), ["left", "center", "right"]);
check("B3 Căn trái is lit before any span is opened", /class="icon-only te-fmt active" data-align="left"/.test(grp), true);
const titles = [...grp.matchAll(/title="([^"]+)"/g)].map((m) => m[1]).concat([(HTML.match(/id="te-strike"[^>]*title="([^"]+)"/) || [])[1]]);
check("B4 every new title has an English entry", titles.length === 4 && titles.every((t) => I18N.includes('"' + t + '"')), true);

console.log(`\ntext-edit-format: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
