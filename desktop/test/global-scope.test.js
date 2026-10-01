"use strict";

// Contract test for the renderer's shared script scope (REGRESSION-GUARD §2, BI-14).
//
// The renderer is classic `<script>` files sharing ONE global scope — no modules, no
// bundler. That makes two failure modes invisible to `node --check` and to every other
// suite here, because both are syntactically valid and only bite in the browser:
//
//   1. A duplicate top-level binding. `const`/`let`/`class` twice in the same scope is
//      a SyntaxError that kills the WHOLE second script (app goes blank — it has
//      happened twice, BI-14). `function`/`var` twice is worse: no error, the later
//      file silently replaces the earlier one.
//   2. A load-order dependency broken by reordering <script> tags. The ordering used to
//      live only in HTML comments; a file moved above what it needs throws a
//      ReferenceError at load, or — for calls resolved lazily — only when the user
//      clicks the one feature that needs it.
//
// This test reads each HTML page's script list exactly as the browser would, and checks
// (a) every renderer/*.js is loaded by some page, (b) no global name is declared by two
// files of the same page, (c) the ordering rules below. The rules are the ones the HTML
// comments state; each carries its reason so a failure explains itself. If you add a
// script with a load-time dependency, add its rule HERE (and keep the comment).
//
// A checker that cannot fail is worthless, so the last section feeds the same functions
// deliberately broken inputs and requires them to be caught.
//
// Run:  node desktop/test/global-scope.test.js      (or: npm test -- global-scope)

const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");

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

// ---- extraction ------------------------------------------------------------

/** External <script src> list of an HTML page, in document order (inline scripts have no src). */
function scriptList(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
}

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Names a script puts into the shared scope:
 *  - column-0 function / class / const / let / var (an indented one lives inside an
 *    IIFE or a block and is not global),
 *  - the keys of a column-0 destructuring `const { a, b: c } = ...` (the BI-14 shape),
 *  - `window.X = ...` anywhere (the UMD / IIFE publish pattern),
 *  - `Object.assign(window, NAME)` → the shorthand keys of `const NAME = { … }`.
 */
function globalNames(src) {
  const s = stripBlockComments(src);
  const names = new Set();
  for (const m of s.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of s.matchAll(/^(?:class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of s.matchAll(/^(?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) {
    for (const part of m[1].split(",")) {
      const n = part.split(":").pop().split("=")[0].trim();
      if (n) names.add(n);
    }
  }
  for (const m of s.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1]);
  for (const m of s.matchAll(/Object\.assign\(\s*window\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const obj = new RegExp(`const\\s+${m[1]}\\s*=\\s*\\{([^}]*)\\}`).exec(s);
    if (obj) {
      for (const k of obj[1].split(",")) {
        const n = k.replace(/\/\/.*$/gm, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
      }
    }
  }
  return names;
}

/** `[{ name, files: [a, b] }]` for each global name declared by two different files. */
function duplicates(files) {
  const owner = new Map();
  const out = [];
  for (const f of files) {
    for (const n of globalNames(f.src)) {
      if (owner.has(n) && owner.get(n) !== f.name) out.push({ name: n, files: [owner.get(n), f.name] });
      else owner.set(n, f.name);
    }
  }
  return out;
}

/** Rules `[before, after, why]` the `order` list violates (a rule whose files are absent is skipped). */
function orderViolations(order, rules) {
  const bad = [];
  for (const [before, after, why] of rules) {
    const i = order.indexOf(before);
    const j = order.indexOf(after);
    if (i < 0 || j < 0) continue;
    if (i > j) bad.push(`${before} must load before ${after} (${why})`);
  }
  return bad;
}

// ---- the rules (each one restates a comment in the page it applies to) -------

const INDEX_RULES = [
  ["vendor/pdf-lib.min.js", "managed-codec.js", "needs window.PDFLib at load"],
  ["vendor/pdf-lib.min.js", "page-vault.js", "needs window.PDFLib at load"],
  ["raster-cap.js", "app.js", "renderPageCanvas calls window.RasterCap on every page (BI-78)"],
  ["thumb-queue.js", "app.js", "app.js calls ThumbQueue.createThumbQueue at load time"],
  ["page-vault.js", "app.js", "app.js reads window.PageVault while rendering thumbnails"],
  ["wire.js", "app.js", "bare pdfJsonBody / b64ToU8"],
  ["wire.js", "text-edit.js", "bare pdfJsonBody / b64ToU8"],
  ["wire.js", "compare.js", "bare pdfJsonBody / b64ToU8"],
  ["wire.js", "editor.js", "bare pdfJsonBody / b64ToU8"],
  ["wire.js", "sign.js", "bare pdfJsonBody / b64ToU8"],
  ["wire.js", "managed-codec.js", "pushB64Chunks"],
  ["wire.js", "find-replace.js", "bare pdfJsonBody"],
  ["annot-text.js", "editor.js", "layoutTextBox / normTextStyle / measureText… by bare name"],
  ["annot-geom.js", "editor.js", "cloudPath / arcApex / resizeRect… by bare name"],
  ["annot-text.js", "managed-codec.js", "normTextStyle"],
  ["managed-codec.js", "editor.js", "editor.js calls its bare names"],
  ["page-range.js", "page-move.js", "PageRange.actionSet"],
  ["i18n.js", "help.js", "window.I18N"],
  // everything below uses app.js's bare globals ($, state, toast, sidecarFetch, …)
  ["app.js", "pan.js", "$ / state / isTyping come from app.js"],
  ["pan.js", "editor.js", "its capture-phase viewer listener must register first"],
  ["pan.js", "capture.js", "its capture-phase viewer listener must register first"],
  ["app.js", "editor.js", "shares app.js globals"],
  ["app.js", "text-edit.js", "shares app.js globals"],
  ["app.js", "find-replace.js", "wires its buttons at load time on app.js globals (BI-14)"],
  ["app.js", "compare.js", "shares app.js globals"],
  ["app.js", "capture.js", "shares app.js globals"],
  ["app.js", "page-move.js", "bare insertBuffersAt / deletePages / thumbGapAt…"],
  ["app.js", "sign.js", "shares app.js globals"],
  ["app.js", "signatures.js", "shares app.js globals"],
  ["app.js", "help.js", "needs $ from app.js"],
  ["editor.js", "signatures.js", "calls Editor.placeSignature"],
  ["capture.js", "signatures.js", "calls Capture.showMenu"],
];

const VIEW_RULES = [
  ["raster-cap.js", "view.js", "view.js calls window.RasterCap.viewRasterDpr (BI-78)"],
  ["i18n.js", "view.js", "view.js uses window.I18N"],
];

const PAGES = [
  { html: "index.html", rules: INDEX_RULES },
  { html: "view.html", rules: VIEW_RULES },
  { html: "shell.html", rules: [] },
];

// ---- 1. the real pages -----------------------------------------------------

const loadedAnywhere = new Set();
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(RENDERER, page.html), "utf8");
  const list = scriptList(html);
  check(`${page.html}: loads at least one script`, list.length > 0, true);

  const missing = list.filter((f) => !fs.existsSync(path.join(RENDERER, f)));
  check(`${page.html}: every <script src> exists on disk`, missing, []);

  const dupList = list.filter((f, i) => list.indexOf(f) !== i);
  check(`${page.html}: no script loaded twice`, dupList, []);

  const own = list.filter((f) => !f.startsWith("vendor/"));
  own.forEach((f) => loadedAnywhere.add(f));
  const files = own.map((f) => ({ name: f, src: fs.readFileSync(path.join(RENDERER, f), "utf8") }));
  check(
    `${page.html}: no global name declared by two files`,
    duplicates(files).map((d) => `${d.name}: ${d.files.join(" & ")}`),
    []
  );
  check(`${page.html}: load-order rules hold`, orderViolations(list, page.rules), []);

  // A rule naming a file the page no longer loads is a stale rule, not a pass.
  const stale = page.rules.flat().filter((x, i) => i % 3 !== 2 && !list.includes(x));
  check(`${page.html}: every file named by a rule is still loaded`, [...new Set(stale)], []);
}

const onDisk = fs.readdirSync(RENDERER).filter((f) => f.endsWith(".js"));
check(
  "every renderer/*.js is loaded by some page (orphan = dead code or a forgotten <script>)",
  onDisk.filter((f) => !loadedAnywhere.has(f)),
  []
);

// ---- 2. negative controls: the checker must be able to fail ---------------------

check("extract: column-0 declarations", [...globalNames("function a(){}\nconst b=1;\n  const inner=2;\nclass C{}")].sort(), ["C", "a", "b"]);
check("extract: destructuring keys incl. rename", [...globalNames("const { x, y: z } = w;")].sort(), ["x", "z"]);
check("extract: window.X publish", [...globalNames("(function(){ window.Foo = {}; })();")], ["Foo"]);
check(
  "extract: Object.assign(window, SURFACE) keys",
  [...globalNames("(function(){ const S = { a, b, // c\n c };\n Object.assign(window, S); })();")].sort(),
  ["a", "b", "c"]
);
check("extract: ignores names inside a block comment", [...globalNames("/*\nfunction ghost(){}\n*/\nfunction real(){}")], ["real"]);
check("extract: ignores `window.x ==` comparison", [...globalNames("if (window.x == 1) {}")], []);

check(
  "duplicates: same const in two files is caught (BI-14)",
  duplicates([
    { name: "a.js", src: "const { PDFDocument } = window.PDFLib;" },
    { name: "b.js", src: "const { PDFDocument, degrees } = window.PDFLib;" },
  ]),
  [{ name: "PDFDocument", files: ["a.js", "b.js"] }]
);
check(
  "duplicates: function in one file vs window.X publish in another is caught",
  duplicates([
    { name: "a.js", src: "function toast(){}" },
    { name: "b.js", src: "window.toast = () => {};" },
  ]).length,
  1
);
check(
  "duplicates: the same name twice in ONE file is not a cross-file clash",
  duplicates([{ name: "a.js", src: "const t = 1;\nwindow.t = t;" }]),
  []
);
check(
  "duplicates: an IIFE-local name is not global",
  duplicates([
    { name: "a.js", src: "(function(){\n  const x = 1;\n})();" },
    { name: "b.js", src: "(function(){\n  const x = 2;\n})();" },
  ]),
  []
);

check(
  "order: a broken order is reported with its reason",
  orderViolations(["app.js", "wire.js"], [["wire.js", "app.js", "bare pdfJsonBody"]]),
  ["wire.js must load before app.js (bare pdfJsonBody)"]
);
check("order: a correct order is clean", orderViolations(["wire.js", "app.js"], [["wire.js", "app.js", "x"]]), []);
check("order: a rule on an absent file is skipped, not failed", orderViolations(["app.js"], [["wire.js", "app.js", "x"]]), []);
check("scriptList: ignores inline scripts, keeps order", scriptList('<script>x</script><script src="b.js"></script><script src="a.js"></script>'), ["b.js", "a.js"]);

console.log(`\nglobal-scope: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
