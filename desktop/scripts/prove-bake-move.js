#!/usr/bin/env node
"use strict";

// Proves that moving the baking half of editor.js into editor-bake.js changed NOTHING but
// where the lines live (docs/PROPOSAL-2026-10-01-split-editor-baking.md, step 1).
//
//   node desktop/scripts/prove-bake-move.js [--base <git-rev>]
//
// `--base` is the revision BEFORE the move (default HEAD, which is right while the move is
// still uncommitted). Four independent claims, each printed PASS/FAIL, exit 1 on any FAIL:
//
//   1. the block cut out of the base editor.js ("PNG rasterisation for baking" banner up to the
//      "watermark dialog" banner) appears in editor-bake.js, between its BEGIN/END markers,
//      BYTE FOR BYTE — first differing line printed if not;
//   2. the new editor.js is the base editor.js with that block replaced by the documented stub
//      and by nothing else (everything before the block and everything after it is untouched);
//   3. the bare names the block references that are NOT its own are exactly the ten passed to
//      create(), the PDFLib destructure, and the listed classic-script globals — so nothing was
//      silently left behind in editor.js, and the interface cannot grow without this failing;
//   4. editor-bake.js's wrapper does what its header says (destructures the same ten, returns the
//      same two).
//
// The scan in (3) is a token scan, not a parser: it masks strings/comments/regexes, ignores
// `.name` property accesses and `name:` object keys, and cannot see a local that shadows one of
// the names. Treat a PASS as "no reference was missed that this method can see"; the real
// safety net for the rest is the test grids that run these functions per annotation kind
// (test:rotate, test:managed) and the byte comparison of baked PDFs in a real Electron.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RENDERER = path.join(__dirname, "..", "renderer");
const BANNER_FROM = "  // ---- PNG rasterisation for baking ---------------------------------------\n";
const BANNER_TO = "  // ---- watermark dialog ----------------------------------------------------\n";
const STUB_FROM = "  // ---- baking + PNG rasterisation (moved to editor-bake.js) ----------------\n";
const BEGIN = '// ======== BEGIN verbatim block: editor.js "PNG rasterisation for baking" + "baking" ========\n';
const END = "// ======== END verbatim block ========\n";

// The interface, pinned. Changing it is a design decision: edit these lists, the header of
// editor-bake.js and the call in editor.js together.
const DEPS = ["ed", "annotsFor", "hasAny", "clearEdHistory", "syncOverlays", "hexRgb", "hexToRgba", "dataUrlToBytes", "SYMBOL_KINDS", "noteThreadText"];
const PDFLIB_NAMES = ["PDFLib", "PDFDocument", "rgb", "PDFName", "PDFHexString", "PDFRawStream", "PDFDict", "degrees"]; // what the wrapper takes from window.PDFLib
const PDFLIB_USED = ["PDFLib", "PDFDocument", "rgb", "PDFName", "PDFHexString", "PDFRawStream", "PDFDict"]; // what the block actually references
const EXPECTED_GLOBALS = {
  "annot-text.js": ["normTextStyle", "layoutTextBox", "measureCtx", "rotatedBox", "textFont"],
  "annot-geom.js": ["arrowLabelPos", "isPtsKind", "TEXTHL_OPACITY", "cloudPath", "bumpOf", "cloudPathPoly", "symbolStrokes"],
  "managed-codec.js": [
    "isVectorKind", "serializeManaged", "strToBytes", "pushPageAnnot", "apRotatable", "sniffImage", "normAngle",
    "apMatrixFor", "apRectFor", "NABU_KIND", "NABU_DATA", "NABU_SRC", "shapeAppearance", "managedSrcBytes",
    "managedSrcDataUrl", "makeMap", "isManagedKind", "pageRotate", "stripManagedAnnots", "stripManagedFromPage", "freeManagedTrash",
  ],
  "app.js": ["state", "pdfjsLib", "toast", "showOverlay", "hideOverlay", "rerenderChanged"],
};
const MOVED_NAMES = [
  "renderTextPng", "renderArrowPng", "renderWatermarkPng", "rasterRedacted", "deserializeManaged", "addManagedAnnot",
  "importManaged", "drawAnnots", "drawOneAnnot", "drawWatermark", "bakeInPlace", "bakeWithRedaction",
  "rememberSignatureWidths", "bakePending",
];

const read = (f) => fs.readFileSync(path.join(RENDERER, f), "utf8");

function blockOf(src) {
  const a = src.indexOf(BANNER_FROM);
  const b = src.indexOf(BANNER_TO);
  if (a < 0 || b < 0 || b < a) throw new Error("block banners not found (or out of order) in the base editor.js");
  return { a, b, before: src.slice(0, a), block: src.slice(a, b), after: src.slice(b) };
}

/** A mask: 1 where the character is CODE (not inside a string, comment, template text or regex). */
function codeMask(src) {
  const n = src.length;
  const code = new Uint8Array(n);
  let i = 0;
  let prev = "";
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; } i++; prev = "s"; continue; }
    if (c === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") { depth--; if (!depth) break; }
            code[i] = 1;
            i++;
          }
          i++;
          continue;
        }
        i++;
      }
      i++;
      prev = "s";
      continue;
    }
    if (c === "/" && (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === "")) {
      i++;
      let cls = false;
      while (i < n && (src[i] !== "/" || cls) && src[i] !== "\n") { if (src[i] === "\\") i++; else if (src[i] === "[") cls = true; else if (src[i] === "]") cls = false; i++; }
      i++;
      while (/[a-z]/.test(src[i] || "")) i++;
      prev = "s";
      continue;
    }
    code[i] = 1;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return code;
}

/** Identifiers used as bare names in `text` (code only; not `.prop`, not `key:`), with counts. */
function bareIdentifiers(text) {
  const code = codeMask(text);
  const out = new Map();
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(text))) {
    if (!code[m.index]) continue;
    // Look back/forward over whitespace AND over comments/strings (not code): a comment that ends
    // in a full stop right above a statement must not make the statement look like `.name`.
    let k = m.index - 1;
    while (k >= 0 && (/\s/.test(text[k]) || !code[k])) k--;
    if (text[k] === "." && text[k - 1] !== ".") continue; // property access (but keep spread)
    let a = m.index + m[0].length;
    while (a < text.length && (/\s/.test(text[a]) || !code[a])) a++;
    if (text[a] === ":" && text[a + 1] !== ":" && (text[k] === "{" || text[k] === ",")) continue; // object key
    out.set(m[0], (out.get(m[0]) || 0) + 1);
  }
  return out;
}

/** Names declared anywhere in `text` (function/const/let/var/class/params-ish destructures). Over-approximates on purpose. */
function declaredNames(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) for (const p of m[1].split(",")) { const nm = p.split(":").pop().split("=")[0].trim(); if (nm) out.add(nm); }
  for (const m of text.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) for (const p of m[1].split(",")) { const nm = p.split("=")[0].trim(); if (nm) out.add(nm); }
  for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) for (const p of m[1].split(",")) { const nm = p.split("=")[0].replace(/[{}[\].]/g, "").trim(); if (nm) out.add(nm); }
  for (const m of text.matchAll(/\bfunction\s*\*?\s*[\w$]*\s*\(([^()]*)\)/g)) for (const p of m[1].split(",")) { const nm = p.split("=")[0].replace(/[{}[\].]/g, "").trim(); if (nm) out.add(nm); }
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  for (const m of text.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+(?:\[([^\]]*)\]|\{([^}]*)\}|([A-Za-z_$][\w$]*))/g)) {
    const list = m[1] || m[2] || m[3] || "";
    for (const p of list.split(",")) { const nm = p.split(":").pop().split("=")[0].trim(); if (nm) out.add(nm); }
  }
  return out;
}

/**
 * Free bare names of editor-bake.js's block: identifiers that are in the vocabulary of editor.js's
 * own IIFE scope or of the other renderer files' top level, but are not declared inside the block.
 * Returns { editorScope: [...], globals: { file: [...] } }.
 */
function interfaceOfBlock(blockText, editorNoBlock) {
  const used = bareIdentifiers(blockText);
  const own = declaredNames(blockText);
  // vocabulary 1: names declared at the IIFE scope of editor.js outside the block (2-space indent)
  const editorScope = new Set();
  for (const m of editorNoBlock.matchAll(/^  (?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^  (?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) editorScope.add(m[1] || m[2]);
  for (const m of editorNoBlock.matchAll(/^  (?:const|let|var)\s*\{([^}]*)\}\s*=/gm)) for (const p of m[1].split(",")) { const nm = p.split(":").pop().split("=")[0].trim(); if (nm) editorScope.add(nm); }
  const intoFromEditor = [...used.keys()].filter((nm) => editorScope.has(nm) && !own.has(nm)).sort();
  // vocabulary 2: top-level names of the other classic scripts
  const globals = {};
  for (const f of fs.readdirSync(RENDERER).filter((x) => x.endsWith(".js") && x !== "editor.js" && x !== "editor-bake.js")) {
    const s = fs.readFileSync(path.join(RENDERER, f), "utf8");
    const top = new Set();
    for (const m of s.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) top.add(m[1] || m[2]);
    // managed-codec.js publishes its names through `const _SURFACE = { a, b, … }` (see its tail)
    const sur = s.match(/const _SURFACE = \{([^}]*)\}/);
    if (sur) for (const x of sur[1].split(",").map((y) => y.trim())) if (/^[A-Za-z_$][\w$]*$/.test(x)) top.add(x);
    const hit = [...used.keys()].filter((nm) => top.has(nm) && !own.has(nm) && !editorScope.has(nm));
    if (hit.length) globals[f] = hit.sort();
  }
  return { intoFromEditor, globals };
}

function firstDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return `line ${i + 1}:\n    base: ${JSON.stringify(la[i])}\n    new : ${JSON.stringify(lb[i])}`;
  return "(no line differs; lengths differ)";
}

function main() {
  const args = process.argv.slice(2);
  const baseRev = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD";
  const base = execFileSync("git", ["show", `${baseRev}:desktop/renderer/editor.js`], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
  const newEditor = read("editor.js").replace(/\r\n/g, "\n");
  const newBake = read("editor-bake.js").replace(/\r\n/g, "\n");
  let failed = 0;
  const say = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) failed++; };

  const { before, block, after } = blockOf(base);
  say(true, `base ${baseRev}: block is ${block.split("\n").length - 1} lines, ${block.length} chars`);

  // 1
  const bi = newBake.indexOf(BEGIN);
  const ei = newBake.indexOf(END);
  const hasMarkers = bi >= 0 && ei > bi && newBake.indexOf(BEGIN, bi + 1) < 0;
  say(hasMarkers, "editor-bake.js has exactly one BEGIN/END marker pair");
  const moved = hasMarkers ? newBake.slice(bi + BEGIN.length, ei) : "";
  const same = moved === block;
  say(same, "the block in editor-bake.js is BYTE-IDENTICAL to the base block" + (same ? "" : "\n  first difference at " + firstDiff(block, moved)));

  // 2
  const sa = newEditor.indexOf(STUB_FROM);
  const sb = newEditor.indexOf(BANNER_TO);
  let stub = "";
  let outside = false;
  if (sa >= 0 && sb > sa) {
    stub = newEditor.slice(sa, sb);
    outside = newEditor.slice(0, sa) === before && newEditor.slice(sb) === after;
  }
  say(outside, "editor.js = base with the block replaced by the stub, and nothing else changed" +
    (outside ? "" : "\n  before-block equal: " + (sa >= 0 && newEditor.slice(0, sa) === before) + ", after-block equal: " + (sb >= 0 && newEditor.slice(sb) === after)));
  // The stub region may hold comments, blank lines and the ONE create() statement - nothing else. (Without this
  // a function declared inside the region would ride along unnoticed: it is "outside" the block and "inside" the stub.)
  const stubCode = stub.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).join(" ").replace(/\s+/g, " ").trim();
  say(/^const \{ bakePending, importManaged \} = window\.EditorBake\.create\(\{ [^}]* \}\);$/.test(stubCode),
    "the stub region holds comments and the single create() statement, nothing else" + (stubCode.length < 400 ? "" : "\n  stub code is " + stubCode.length + " chars"));
  const call = /window\.EditorBake\.create\(\{([^}]*)\}\)/.exec(stub);
  const passed = call ? call[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
  say(JSON.stringify(passed) === JSON.stringify(DEPS), `the stub passes exactly the ${DEPS.length} pinned names, in order` + (JSON.stringify(passed) === JSON.stringify(DEPS) ? "" : "\n  got " + passed.join(",")));
  const comesBack = /const\s*\{\s*bakePending\s*,\s*importManaged\s*\}\s*=\s*window\.EditorBake\.create/.test(stub);
  say(comesBack, "…and takes back exactly bakePending and importManaged");

  // 3
  const iface = interfaceOfBlock(block, before + after);
  // From editor.js's scope: the ten passed in, plus the PDFLib names (editor.js declares them; the
  // new file re-takes them from window.PDFLib, which is the same object).
  const expectIntoEditor = DEPS.concat(PDFLIB_USED).sort();
  say(JSON.stringify(iface.intoFromEditor) === JSON.stringify(expectIntoEditor), "the block references exactly the pinned names from editor.js's own scope" +
    (JSON.stringify(iface.intoFromEditor) === JSON.stringify(expectIntoEditor) ? ` (${expectIntoEditor.length})` : `\n  expected ${expectIntoEditor.join(",")}\n  found    ${iface.intoFromEditor.join(",")}`));
  const gOk = JSON.stringify(Object.keys(iface.globals).sort()) === JSON.stringify(Object.keys(EXPECTED_GLOBALS).sort()) &&
    Object.keys(EXPECTED_GLOBALS).every((f) => JSON.stringify((iface.globals[f] || []).slice().sort()) === JSON.stringify(EXPECTED_GLOBALS[f].slice().sort()));
  say(gOk, "the block's bare globals from other scripts are exactly the pinned list" + (gOk ? "" : "\n  found " + JSON.stringify(iface.globals)));
  const stillDeclaredInEditor = MOVED_NAMES.filter((nm) => new RegExp("^  (?:async\\s+)?function\\s+" + nm + "\\b|^  const\\s+" + nm + "\\b", "m").test(newEditor.replace(stub, "")));
  say(stillDeclaredInEditor.length === 0, "none of the moved functions is still declared in editor.js" + (stillDeclaredInEditor.length ? ": " + stillDeclaredInEditor.join(",") : ""));

  // 4
  const wrapper = newBake.slice(0, bi) + newBake.slice(ei + END.length);
  const destr = /const \{ ([^}]*) \} = deps;/.exec(wrapper);
  const wrapperDeps = destr ? destr[1].split(",").map((x) => x.trim()) : [];
  say(JSON.stringify(wrapperDeps) === JSON.stringify(DEPS), "editor-bake.js destructures the same names, in the same order");
  say(/return \{ bakePending, importManaged \};/.test(wrapper) && /window\.EditorBake = \{ create \};/.test(wrapper), "editor-bake.js returns exactly { bakePending, importManaged } and publishes one global");
  const wrapperUsesPdfLib = PDFLIB_NAMES.every((nm) => new RegExp("\\b" + nm + "\\b").test(wrapper));
  say(wrapperUsesPdfLib, "editor-bake.js takes PDFLib and its destructure from window.PDFLib");

  console.log(failed ? `\n${failed} claim(s) FAILED` : "\nAll claims hold: the move changed nothing but where the lines live.");
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = { blockOf, bareIdentifiers, declaredNames, interfaceOfBlock, DEPS, PDFLIB_NAMES, PDFLIB_USED, EXPECTED_GLOBALS, MOVED_NAMES, BEGIN, END, STUB_FROM };
