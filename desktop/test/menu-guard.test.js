"use strict";

// Regression net for the NATIVE MENU's guard (BI-105).
//
// WHY THIS GRID EXISTS. The native menu (main.js buildMenu) has no enabled state: its
// items fire whatever the toolbar is showing. The toolbar freezes page-structure
// commands while annotating / text-editing (page indices must not move under a live
// overlay) and needs a document for them; the Delete key yields to an open dialog. The
// menu used to skip all of that — only replaceSelectedFromFile carried the freeze — so
// Trang → Xoay / Xóa / Ghép / Chèn ran under a live annotation session
// (docs/REVIEW-2026-10-12-menu-bar.md M1/M2).
//
// What is pinned:
//   A. menuBlockReason() — lifted out of the SHIPPED app.js and run on a truth table.
//   B. the dispatcher consults it BEFORE running the action (a guard nobody calls is
//      worth nothing), and reads the same state updateToolbar() reads.
//   C. main.js ⇄ app.js contract: every send("x") in the menu template has an action,
//      every action has a menu item, and every command the guard names exists (a typo
//      in the guard's lists would silently un-guard that command).
//   D. mergeFiles / insertFile refuse before the file picker with no document, and
//      rotateSelected says why it did nothing.
//
// Run:  node desktop/test/menu-guard.test.js      (or: npm run test:menu)

const fs = require("fs");
const path = require("path");

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
function ok(name, cond) {
  check(name, !!cond, true);
}

const APP = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

// Source of `function NAME(...) { ... }` by brace matching (same helper as
// print-range.test.js). Throws loudly if the function is gone or renamed.
function fnSource(src, name) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found — renamed or removed?`);
  if (src.slice(at - 6, at) === "async ") at -= 6;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

// Body of the arrow passed to window.desktop.onMenuCommand(...).
function dispatcherSource() {
  const at = APP.indexOf("window.desktop.onMenuCommand(");
  if (at < 0) throw new Error("onMenuCommand dispatcher not found in app.js");
  const open = APP.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < APP.length; i++) {
    if (APP[i] === "{") depth++;
    else if (APP[i] === "}" && --depth === 0) return APP.slice(open, i + 1);
  }
  throw new Error("unbalanced dispatcher");
}

// ---- A. truth table -------------------------------------------------------
// eslint-disable-next-line no-eval
const menuBlockReason = eval("(" + fnSource(APP, "menuBlockReason") + ")");
const OK_CTX = { has: true, editing: false, modal: false, busy: false };
const ctx = (o) => Object.assign({}, OK_CTX, o);
const blocked = (cmd, o) => menuBlockReason(cmd, ctx(o)) !== null;

const PAGE = ["rotateL", "rotateR", "delete", "merge", "insert", "replace", "extract"];
const JOB = ["print", "encrypt", "extractImages", "pdfToImages", "imagesToPdf"];
const FREE = ["open", "save", "saveAs", "undo", "redo", "zoomIn", "zoomOut", "zoomReset", "presentation", "guide", "settings"];

for (const c of PAGE) {
  check(`A1 ${c}: allowed with a document, idle`, blocked(c, {}), false);
  check(`A2 ${c}: blocked with no document`, blocked(c, { has: false }), true);
  check(`A3 ${c}: blocked while editing (the M1 hole)`, blocked(c, { editing: true }), true);
  check(`A4 ${c}: blocked under an open dialog`, blocked(c, { modal: true }), true);
  check(`A5 ${c}: blocked while a job runs`, blocked(c, { busy: true }), true);
}
for (const c of JOB) {
  check(`A6 ${c}: allowed idle`, blocked(c, {}), false);
  // Their functions check for a document themselves (convertReady/printDoc) — and
  // "Ảnh → PDF" needs none at all, so the guard must NOT add that check.
  check(`A7 ${c}: not the guard's job to require a document`, blocked(c, { has: false }), false);
  check(`A8 ${c}: allowed while editing (they bake pending first)`, blocked(c, { editing: true }), false);
  check(`A9 ${c}: blocked under an open dialog`, blocked(c, { modal: true }), true);
  check(`A10 ${c}: blocked while a job runs`, blocked(c, { busy: true }), true);
}
for (const c of FREE) {
  // Save and zoom stay available while editing, exactly as on the toolbar; Ctrl+S /
  // Ctrl+O are real menu accelerators, so blocking them here would change the keyboard.
  check(`A11 ${c}: never blocked by the menu guard`, blocked(c, { has: false, editing: true, modal: true, busy: true }), false);
}
check("A12 unknown command passes through (dispatcher ignores it anyway)", blocked("nope", { busy: true }), false);
check("A13 refusal text is a string", typeof menuBlockReason("rotateL", ctx({ editing: true })), "string");

// ---- B. the dispatcher actually uses it --------------------------------------
const DISP = dispatcherSource();
const iGuard = DISP.indexOf("menuBlockReason(cmd, menuGuardContext())");
const iRun = DISP.lastIndexOf("fn();");
ok("B1 dispatcher calls menuBlockReason(cmd, menuGuardContext())", iGuard >= 0);
ok("B2 … before running the action", iGuard >= 0 && iRun > iGuard);
ok("B3 … and returns on a refusal", /if \(why\) \{[\s\S]*?return;[\s\S]*?\}\s*fn\(\);/.test(DISP));
const CTX_SRC = fnSource(APP, "menuGuardContext");
ok("B4 context: editing covers Editor AND TextEdit", /Editor\.active/.test(CTX_SRC) && /TextEdit\.active/.test(CTX_SRC));
ok("B5 context: modal via modalOpen()", /modalOpen\(\)/.test(CTX_SRC));
ok("B6 context: busy via the #overlay", /\$\("overlay"\)\.hidden/.test(CTX_SRC));
// `Editor.active` is a GETTER — calling it threw a TypeError once (see the keydown ladder).
ok("B7 context: Editor.active read as a property, not called", !/\.active\(\)/.test(CTX_SRC));

// ---- C. main.js ⇄ app.js contract ------------------------------------------
const tplAt = MAIN.indexOf("function buildMenu(");
const tpl = fnSource(MAIN.slice(tplAt), "buildMenu");
const sent = new Set([...tpl.matchAll(/send\("([A-Za-z]+)"\)/g)].map((m) => m[1]));
const actAt = DISP.indexOf("const actions = {");
const actEnd = DISP.indexOf("\n  };", actAt);
const actSrc = DISP.slice(actAt, actEnd);
// Keys = identifiers at the start of an object line: `name:` or shorthand `name,`.
const actions = new Set([...actSrc.matchAll(/^\s{4}([A-Za-z]+)\s*[:,]/gm)].map((m) => m[1]));
ok("C0 parsed a plausible number of menu commands", sent.size >= 20 && actions.size >= 20);
for (const c of sent) ok(`C1 menu sends "${c}" → renderer has an action`, actions.has(c));
for (const c of actions) ok(`C2 renderer action "${c}" → menu has an item`, sent.has(c));
const GUARD_SRC = fnSource(APP, "menuBlockReason");
const named = [...GUARD_SRC.matchAll(/new Set\(\[([^\]]*)\]\)/g)].flatMap((m) => [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]));
ok("C3 guard lists parsed", named.length === PAGE.length + JOB.length);
for (const c of named) ok(`C4 guarded command "${c}" is a real menu command`, actions.has(c) && sent.has(c));

// The menu is bilingual, so the refusal is too: the dispatcher passes it through t(),
// which only translates strings that are keys of i18n.js's EN dictionary.
const I18N = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
const refusals = [...GUARD_SRC.matchAll(/return "([^"]+)";/g)].map((m) => m[1]);
ok("C5 refusal strings parsed", refusals.length === 4);
for (const s of refusals) ok(`C6 refusal "${s}" has an English entry in i18n.js`, I18N.includes(JSON.stringify(s) + ":"));
ok("C7 dispatcher translates the refusal", /toast\(window\.t \? window\.t\(why\) : why/.test(DISP));

// ---- D. function-level refusals ---------------------------------------------
for (const name of ["mergeFiles", "insertFile"]) {
  const s = fnSource(APP, name);
  const iDoc = s.indexOf("if (!state.bytes)");
  const iPick = s.indexOf("openPdf(");
  ok(`D1 ${name} checks for a document`, iDoc >= 0);
  ok(`D2 ${name} … before the file picker`, iDoc >= 0 && iPick > iDoc);
}
ok("D3 rotateSelected toasts when nothing is selected", /state\.selected\.size === 0\) \{\s*toast\(/.test(fnSource(APP, "rotateSelected")));

// ---- E. the guide names only menus that exist ---------------------------------
// help.js told users for a year that "Tập tin" had "Tách ra cửa sổ riêng" — an item of
// the TAB's right-click menu (REVIEW-2026-10-12 M3). Prose cannot be checked for truth,
// but a menu name can: every `menu **X**` (vi) / `**X** … menu` (en) in the guide must be
// a top-level menu of the real template, so renaming or regrouping a menu (Đợt 3) turns
// this red until the guide follows.
// eslint-disable-next-line no-eval
const MENU_STR = eval("(" + MAIN.match(/const MENU_STR = (\{[\s\S]*?\n\});/)[1] + ")");
const topKeys = [...tpl.matchAll(/^\s{6}label: L\.([A-Za-z]+),$/gm)].map((m) => m[1]);
ok("E0 parsed the top-level menus", topKeys.length >= 5);
const TOP_VI = new Set(topKeys.map((k) => MENU_STR.vi[k]));
const HELP = fs.readFileSync(path.join(__dirname, "..", "renderer", "help.js"), "utf8");
const named2 = [
  ...[...HELP.matchAll(/[Mm]enu \*\*([^*]+)\*\*/g)].map((m) => m[1]),
  ...[...HELP.matchAll(/\*\*([^*]+)\*\*(?: \([^)]*\))? menu\b/g)].map((m) => m[1]),
]
  .filter((x) => !/ ▾$/.test(x)) // "Trang ▾" is the TOOLBAR button, not the menu
  .filter((x) => !x.includes(" / ")); // "menu **Sao chép / Dán…**" lists a right-click menu's ITEMS
ok("E1 found menu references in help.js", named2.length >= 3);
for (const x of new Set(named2)) ok(`E2 help.js names menu "${x}" — it exists`, TOP_VI.has(x));

console.log(`menu-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
