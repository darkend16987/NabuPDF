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

const PAGE = [
  "rotateL", "rotateR", "delete", "merge", "insert", "replace", "extract",
  "blank", "splitFiles", "deleteRange", "nup", "pageNumbers", "selectAllPages",
];
const TOOL = [
  "find", "findReplace", "batchVariants", "annotate", "editText",
  "extractAI", "searchable", "translate", "compress", "compare", "copyImage", "sign", "office",
];
const JOB = ["print", "encrypt", "extractImages", "pdfToImages", "imagesToPdf", "combine"];
const FREE = [
  "open", "save", "saveAs", "undo", "redo", "zoomIn", "zoomOut", "zoomReset", "presentation", "guide", "settings",
  "fitWidth", "fitHeight", "fitPage", "sidebar", "comments", "updates", "about",
];

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
for (const c of TOOL) {
  check(`A14 ${c}: allowed idle`, blocked(c, {}), false);
  // "Chú thích" is a toggle: from the menu while editing it would END the session.
  check(`A15 ${c}: blocked while editing`, blocked(c, { editing: true }), true);
  check(`A16 ${c}: blocked under an open dialog`, blocked(c, { modal: true }), true);
  check(`A17 ${c}: blocked while a job runs`, blocked(c, { busy: true }), true);
  // Compare needs no open document — the document rule is the toolbar button's.
  check(`A18 ${c}: the guard itself never requires a document`, blocked(c, { has: false }), false);
}
check("A19 tool refusal while editing is the generic one (not 'trước khi thao tác trang')",
  menuBlockReason("annotate", ctx({ editing: true })), "Bấm Xong ở chế độ chỉnh sửa trước đã.");
// eslint-disable-next-line no-eval
const menuDisabledReason = eval("(" + fnSource(APP, "menuDisabledReason") + ")");
const R0 = { has: true, editing: false, ready: true };
check("A20 disabled: no document wins", menuDisabledReason({ ...R0, has: false, editing: true, ready: false }), "Mở PDF trước.");
check("A21 disabled: then editing", menuDisabledReason({ ...R0, editing: true, ready: false }), "Bấm Xong ở chế độ chỉnh sửa trước đã.");
check("A22 disabled: then the engine", menuDisabledReason({ ...R0, ready: false }), "Engine chưa sẵn sàng.");
check("A23 disabled: otherwise a generic line", menuDisabledReason(R0), "Lệnh này chưa dùng được lúc này.");
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
ok("C3 guard lists parsed", named.length === PAGE.length + TOOL.length + JOB.length);
check("C3b guard lists = this grid's lists (a command moved between sets must be re-judged here)",
  [...named].sort(), [...PAGE, ...TOOL, ...JOB].sort());
for (const c of named) ok(`C4 guarded command "${c}" is a real menu command`, actions.has(c) && sent.has(c));

// The menu is bilingual, so the refusal is too: the dispatcher passes it through t(),
// which only translates strings that are keys of i18n.js's EN dictionary.
const I18N = fs.readFileSync(path.join(__dirname, "..", "renderer", "i18n.js"), "utf8");
const refusals = [
  ...new Set([...(GUARD_SRC + fnSource(APP, "menuDisabledReason")).matchAll(/return "([^"]+)";/g)].map((m) => m[1])),
];
ok("C5 refusal strings parsed", refusals.length === 7);
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

// ---- F. clickToolbarFor — the menu inherits the BUTTON's rules ------------------
// Run the shipped function against a fake DOM: a button, optionally inside a dropdown
// whose trigger is the gated one (the "Công cụ ▾" / "Xuất ▾" case — openOffice,
// Compare.open, Capture.toggle carry no licence gate of their own).
function runProxy({ id, gatedIds = [], blocked = false, disabled = false, triggerId = null, triggerDisabled = false }) {
  const log = { clicked: false, gated: false, toast: null };
  const trigger = triggerId ? { id: triggerId, disabled: triggerDisabled } : null;
  const dd = trigger ? { querySelector: (sel) => (sel === ":scope > button" ? trigger : null) } : null;
  const btn = { id, disabled, closest: (sel) => (sel === ".dropdown" ? dd : null), click: () => (log.clicked = true) };
  const make = new Function(
    "$", "GATED_BTNS", "gateProFeature", "toast", "menuGuardContext", "menuDisabledReason", "window",
    fnSource(APP, "clickToolbarFor") + "; return clickToolbarFor;"
  );
  const fn = make(
    (x) => (x === id ? btn : null),
    gatedIds,
    () => { if (blocked) { log.gated = true; return true; } return false; },
    (m) => (log.toast = m),
    () => ({ has: true, editing: false, ready: false }),
    menuDisabledReason,
    {}
  );
  fn(id);
  return log;
}
check("F1 enabled, free → clicks", runProxy({ id: "btn-nup" }), { clicked: true, gated: false, toast: null });
check("F2 disabled → no click, says why", runProxy({ id: "btn-ocr", disabled: true }), { clicked: false, gated: false, toast: "Engine chưa sẵn sàng." });
check("F3 own id gated + unlicensed → licence gate, no click", runProxy({ id: "btn-sign", gatedIds: ["btn-sign"], blocked: true }), { clicked: false, gated: true, toast: null });
check("F4 own id gated + licensed → clicks", runProxy({ id: "btn-sign", gatedIds: ["btn-sign"] }), { clicked: true, gated: false, toast: null });
check("F5 item of a GATED dropdown + unlicensed → gated (the openOffice hole)",
  runProxy({ id: "btn-to-office", triggerId: "btn-export", gatedIds: ["btn-export"], blocked: true }), { clicked: false, gated: true, toast: null });
check("F6 item of an UNgated dropdown + unlicensed → not gated (Trang ▾ stays free)",
  runProxy({ id: "btn-nup", triggerId: "btn-pages", gatedIds: ["btn-export"], blocked: true }), { clicked: true, gated: false, toast: null });
check("F7 item enabled but its dropdown disabled → refused",
  runProxy({ id: "mi-encrypt", triggerId: "btn-tools", triggerDisabled: true }), { clicked: false, gated: false, toast: "Engine chưa sẵn sàng." });

// ---- G. every proxied button exists, and its gate matches the toolbar path ---------
const HTML = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
const proxied = [...actSrc.matchAll(/clickToolbarFor\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);
ok("G0 proxied buttons parsed", proxied.length >= 20);
const gatedList = [...APP.match(/const GATED_BTNS = \[([\s\S]*?)\];/)[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
// Map each dropdown item to its trigger: <div class="dropdown" …><button id="TRIGGER">…</div>
const ddOf = {};
for (const m of HTML.matchAll(/<div class="dropdown"[^>]*>\s*<button id="([a-z0-9-]+)"([\s\S]*?)\n\s{8}<\/div>/g)) {
  for (const it of m[2].matchAll(/id="([a-z0-9-]+)"/g)) ddOf[it[1]] = m[1];
}
ok("G1 dropdown membership parsed (Trang/Công cụ/Xuất)", ["btn-pages", "btn-tools", "btn-export"].every((t) => Object.values(ddOf).includes(t)));
for (const id of proxied) {
  ok(`G2 proxied #${id} exists in index.html`, HTML.includes(`id="${id}"`));
}
// The toolbar path to a dd-item is gated when the item OR its trigger is gated; the
// licence-sensitive ones must therefore be inside a gated dropdown or gated themselves.
for (const id of ["btn-to-office", "btn-diff", "btn-copy-img", "btn-searchable", "btn-translate", "btn-compress"]) {
  ok(`G3 #${id}: toolbar path is gated (own id or dropdown) — the menu inherits it`,
    gatedList.includes(id) || gatedList.includes(ddOf[id]), { own: gatedList.includes(id), dd: ddOf[id] });
}
for (const id of ["btn-sign", "btn-edit", "btn-text-edit", "btn-ocr", "btn-find-replace"]) {
  ok(`G4 #${id} is in GATED_BTNS (no dropdown to inherit from)`, gatedList.includes(id));
}

// Which command stands in for which button. Pinned exactly: replacing a proxy with a
// direct call to the handler (openOffice(), Compare.open()…) silently drops the
// button's enable rule AND, for dropdown items, the licence gate (F5).
const PROXY_MAP = {
  combine: "btn-combine", blank: "btn-blank", splitFiles: "mi-split", deleteRange: "mi-delete-range",
  nup: "btn-nup", pageNumbers: "mi-page-numbers", selectAllPages: "btn-select-all",
  findReplace: "btn-find-replace", annotate: "btn-edit", editText: "btn-text-edit", extractAI: "btn-ocr",
  searchable: "btn-searchable", translate: "btn-translate", compress: "btn-compress", compare: "btn-diff",
  copyImage: "btn-copy-img", sign: "btn-sign", office: "btn-to-office",
  fitWidth: "btn-fit-width", fitHeight: "btn-fit-height", fitPage: "btn-fit-page", comments: "btn-comments",
};
const parsedMap = {};
for (const m of actSrc.matchAll(/^\s{4}([A-Za-z]+): \(\) =>[^\n]*clickToolbarFor\("([a-z0-9-]+)"\)/gm)) parsedMap[m[1]] = m[2];
check("G5 command → toolbar button map", parsedMap, PROXY_MAP);

// ---- H. accelerators the renderer owns are shown, never registered ----------------
// Registering one would fire the command twice (keydown + menu). Ctrl+S/O/T/N/W and
// F1 are the menu's own and stay registered.
for (const acc of ["CmdOrCtrl+F", "CmdOrCtrl+H", "F4", "F11", "CmdOrCtrl+P", "CmdOrCtrl+Z", "CmdOrCtrl+Y", "Delete"]) {
  const line = tpl.split("\n").find((l) => l.includes(`accelerator: "${acc}"`));
  ok(`H1 ${acc} is on the menu`, !!line);
  ok(`H2 ${acc} has registerAccelerator: false`, !!line && /registerAccelerator: false/.test(line));
}

console.log(`menu-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
