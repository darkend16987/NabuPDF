"use strict";

// Regression net for Tạo bản theo mẫu (renderer/batch-variants.js).
//
// WHY THIS EXISTS. The feature's whole promise is "the copies differ from the original
// in the code and nowhere else" — and every way to break that is silent: a file name
// rule that renames the wrong part, a value list that quietly drops or repeats a tower,
// two outputs that collide on Windows' case-insensitive disk, a verification that
// accepts a wrong count. The DOM half cannot run under node; everything that decides a
// number or a name lives in the pure half and is pinned here.
//
// Run:  node desktop/test/batch-variants.test.js      (or: npm test -- batch-variants)

const fs = require("fs");
const path = require("path");
const BV = require(path.join(__dirname, "..", "renderer", "batch-variants.js"));

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

const CODE = { matchCase: true, codeBoundary: true };

// ---- findCodes / replaceCodes: the SAME rule as api.py code_boundary ----------
// (test_text_find.py C1–C5 pin the sidecar side with the same strings.)
const at = (t, q, o) => BV.findCodes(t, q, o || CODE).map((x) => [x.start, x.end]);
check("C1 separators are boundaries",
  ["I1_BD-S-5.001", "DAOL.I1", "A-I1-B", "THÁP I1"].map((t) => at(t, "I1")),
  [[[0, 2]], [[5, 7]], [[2, 4]], [[5, 7]]]);
check("C2 a continuing letter/digit run is not a match",
  ["I10", "I11_BD", "PI1", "I1A", "ĐI1"].map((t) => at(t, "I1")), [[], [], [], [], []]);
check("C3 only the real code among its look-alikes", at("I10 I1 I11 I1_X", "I1"), [[4, 6], [11, 13]]);
check("C4 a needle starting with a separator checks nothing before it", at("A-I1", "-I1"), [[1, 4]]);
check("C5 case-insensitive keeps the boundary", at("i10 i1", "I1", { matchCase: false, codeBoundary: true }), [[4, 6]]);
check("C6 without code boundary it is a plain substring search",
  at("I10 I1", "I1", { matchCase: true, codeBoundary: false }), [[0, 2], [4, 6]]);
check("C7 empty needle finds nothing", at("abc", ""), []);
check("R1 replace every code occurrence, right to left",
  BV.replaceCodes("I1 và I1_BD, I10", "I1", "I22", CODE), "I22 và I22_BD, I10");

// ---- parseValues ---------------------------------------------------------------
check("V1 commas, semicolons and new lines all separate",
  BV.parseValues("I2, I3;I4\nI5", "I1").values, ["I2", "I3", "I4", "I5"]);
check("V2 duplicates and the token itself are dropped",
  BV.parseValues("I2, I2, I1, I3", "I1").values, ["I2", "I3"]);
check("V3 a range expands", BV.parseValues("I2..I5", "I1").values, ["I2", "I3", "I4", "I5"]);
check("V3b …with the prefix written once", BV.parseValues("I2..5", "I1").values, ["I2", "I3", "I4", "I5"]);
check("V3c …keeping zero padding", BV.parseValues("P08..P11", "P07").values, ["P08", "P09", "P10", "P11"]);
check("V4 a backwards range is an error, not an empty list",
  BV.parseValues("I5..I2", "I1"), { values: [], errors: ["I5..I2"] });
check("V5 a runaway range is refused", BV.parseValues("I2..I2000", "I1").errors, ["I2..I2000"]);
check("V6 mismatched prefixes are a literal value, not a range",
  BV.parseValues("A2..B5", "I1").values, ["A2..B5"]);
check("V7 blank input is an empty plan", BV.parseValues("  , ;", "I1"), { values: [], errors: [] });

// ---- file names ----------------------------------------------------------------
const NAME = "DAOL.I1.S-HS TKCS (PHAN THAP).pdf";
check("N1 the code in the name changes, nothing else",
  BV.variantFileName(NAME, "I1", "I2", CODE), "DAOL.I2.S-HS TKCS (PHAN THAP).pdf");
check("N2 a name without the code gets the value appended",
  BV.variantFileName("mat-bang-coc.pdf", "I1", "I2", CODE), "mat-bang-coc_I2.pdf");
check("N3 I10 in a name is not I1", BV.variantFileName("THAP I10.pdf", "I1", "I2", CODE), "THAP I10_I2.pdf");
check("N4 reserved characters in a value cannot reach the disk",
  BV.variantFileName("A I1.pdf", "I1", "I2/3:x", CODE), "A I2_3_x.pdf");
check("N5 trailing dots/spaces are removed (Explorer cannot open them)",
  BV.sanitizeFileName("abc. . "), "abc");
check("N6 no name at all still yields a .pdf", BV.variantFileName("", "I1", "I2", CODE), "document_I2.pdf");
check("N7 collisions are found case-insensitively",
  BV.duplicateNames(["A I2.pdf", "B.pdf", "a i2.pdf"]).sort(), ["A I2.pdf", "a i2.pdf"]);

// ---- contexts / selection -------------------------------------------------------
const H = (page, span_text, replaceable = true) => ({ page, span_text, replaceable });
const hits = [H(1, "-THÁP I1"), H(1, "I1_BD-S-5.001"), H(2, "-THÁP I1"), H(0, "THÁP I1"), H(3, "Bên I1", false)];
check("X1 one row per distinct run text, ordered by first page",
  BV.contexts(hits).map((c) => [c.key, c.count, c.pages, c.locked]),
  [["THÁP I1", 1, [1], 0], ["-THÁP I1", 2, [2, 3], 0], ["I1_BD-S-5.001", 1, [2], 0], ["Bên I1", 1, [4], 1]]);
check("X2 unticked contexts and locked hits are not rewritten",
  BV.selectedHits(hits, new Set(["-THÁP I1"])).map((h) => h.span_text), ["I1_BD-S-5.001", "THÁP I1"]);
check("X3 pages without a match, 1-based", BV.pagesWithout(hits, 6), [5, 6]);
check("X4 page lists read as ranges", BV.pageRanges([1, 2, 3, 5, 7, 8]), "1–3, 5, 7–8");

// ---- verification: what a correct output must read back as ---------------------
const exp = (o) => BV.expectedCounts(Object.assign({ opts: CODE }, o));
check("E1 the plain case predicts both counts",
  exp({ token: "I1", value: "I2", beforeToken: 25, beforeValue: 0, replaced: 25 }), { token: 0, value: 25 });
check("E2 unticked / locked ones stay counted as the old code",
  exp({ token: "I1", value: "I2", beforeToken: 25, beforeValue: 3, replaced: 20 }), { token: 5, value: 23 });
check("E3 a value containing the code cannot predict the code count",
  exp({ token: "I1", value: "I1 B", beforeToken: 4, beforeValue: 0, replaced: 4 }).token, null);
check("E4 a code containing the value cannot predict the value count",
  exp({ token: "I1 A", value: "I1", beforeToken: 4, beforeValue: 4, replaced: 4 }).value, null);
check("E5 matching counts pass", BV.countsMatch({ token: 0, value: 25 }, { token: 0, value: 25 }), []);
check("E6 a single missed replacement fails the file",
  BV.countsMatch({ token: 0, value: 25 }, { token: 1, value: 24 }), ["token", "value"]);
check("E7 an unpredictable side is not checked",
  BV.countsMatch({ token: null, value: 4 }, { token: 99, value: 4 }), []);

// ---- the wiring the DOM half depends on (source pins) ----------------------------
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const src = R("renderer/batch-variants.js");
const i18nSrc = R("renderer/i18n.js");
const appSrc = R("renderer/app.js");
const html = R("renderer/index.html");

// Every tr() key in the dictionary (a missing one is silently Vietnamese in EN).
const trKeys = new Set();
const re = /\btr\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
let m;
while ((m = re.exec(src))) trKeys.add(m[1].slice(1, -1).replace(/\\(['"\\])/g, "$1"));
check("tr() is used for runtime strings", trKeys.size > 20, true);
for (const key of trKeys) {
  check(`i18n has ${JSON.stringify(key)}`, i18nSrc.includes('"' + key.replace(/"/g, '\\"') + '"'), true);
}
for (const id of ["bv-status", "bv-contexts", "bv-names", "bv-dir"]) {
  check(`${id} is in SKIP_IDS (BI-10)`, new RegExp(`SKIP_IDS[\\s\\S]{0,4000}"${id}"`).test(i18nSrc), true);
}
// BI-9 + BI-26: the button is gated AND the function is.
check("btn-batch-variants is in GATED_BTNS", /GATED_BTNS[\s\S]{0,2500}"btn-batch-variants"/.test(appSrc), true);
check("canRun() gates the function", /function canRun\(\)[\s\S]{0,200}gateProFeature\(\)/.test(src), true);
// It must never write the open document (BI-3): no state.bytes assignment, no pushUndo.
check("never assigns state.bytes", /state\.bytes\s*=[^=]/.test(src), false);
check("never pushes undo (it does not touch the open document)", /pushUndo\s*\(/.test(src), false);
// The /edit-text payload is Tìm & Thay thế's, not a copy of it.
check("edits come from FindReplace.pure.groupEdits", /window\.FindReplace\.pure\.groupEdits\(/.test(src), true);
// Each output is re-scanned before it is written, with the code-boundary flag on the wire.
check("the scan sends code_boundary", /code_boundary=/.test(src), true);
// Pinned to the exact guard: a looser pattern let `if (false && bad.length)` through.
check("countsMatch gates the write",
  /const bad = P\.countsMatch\(exp, got\);\s*if \(bad\.length\) \{[\s\S]{0,500}?continue;\s*\}[\s\S]{0,300}?writeOne\(/.test(src), true);
// The dialog: one dismiss button (Esc/backdrop/✕ click it) and it sits BEFORE the
// confirm dialog so "Ghi đè?" paints on top of it.
// Up to the next dialog — not a "</div>\n" pattern: index.html is CRLF on Windows.
const bvAt = html.indexOf('id="bv-modal"');
const block = html.slice(bvAt, html.indexOf('<div class="modal"', bvAt));
check("the bv-modal block was found", bvAt > 0 && block.length > 200 && block.length < 6000, true);
check("bv-modal has exactly one data-modal-close", (block.match(/data-modal-close/g) || []).length, 1);
check("bv-modal comes before confirm-modal in the document",
  html.indexOf('id="bv-modal"') > 0 && html.indexOf('id="bv-modal"') < html.indexOf('id="confirm-modal"'), true);
check("batch-variants.js loads after find-replace.js",
  html.indexOf('src="batch-variants.js"') > html.indexOf('src="find-replace.js"'), true);

console.log(`\nbatch-variants: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
