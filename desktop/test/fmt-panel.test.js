"use strict";

// Regression net for the text-box Format panel's two controls added in Đợt B of
// docs/RESEARCH-2026-10-12-text-format-panel.md (BI-107):
//   P1 · #fmt-collapse — thu gọn / mở rộng the panel, remembered per machine;
//   P2 · #fmt-boxw     — "Bề rộng khung (pt)", the wrap width of a fixed-width box as
//                         a number (the only way to resize a ROTATED box: no grips).
//
// HOW. editor.js is a DOM-bound IIFE the grid cannot run, so — like menu-guard's F
// group — each block is CUT OUT of the shipping file by its comment markers and run
// against a fake DOM. A rename or a move fails the cut loudly instead of silently
// testing nothing. Markup / CSS / i18n are pinned by reading the files.
//
// Run:  node desktop/test/fmt-panel.test.js      (or: npm run test:fmtpanel)

const fs = require("fs");
const path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8");
const ED = R("editor.js");
const HTML = R("index.html");
const CSS = R("app.css");
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

// Cut [start, end) out of editor.js; both markers must exist exactly once.
function cut(start, end) {
  const i = ED.indexOf(start);
  const j = ED.indexOf(end, i + 1);
  if (i < 0 || j < 0 || ED.indexOf(start, i + 1) >= 0) throw new Error("cut markers not found once: " + start);
  return ED.slice(i, j);
}

// A fake element: value / disabled / attributes / classList / listeners.
function el(props) {
  const ls = {};
  const cls = new Set();
  const attrs = {};
  return Object.assign({
    value: "", disabled: false, max: "",
    addEventListener: (t, f) => (ls[t] = ls[t] || []).push(f),
    fire: (t, ev) => (ls[t] || []).forEach((f) => f(ev || { preventDefault() {} })),
    setAttribute: (k, v) => (attrs[k] = v),
    getAttribute: (k) => attrs[k],
    classList: {
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    },
  }, props);
}

// =============================================================================
// P2 · Bề rộng khung
// =============================================================================
const BOXW_SRC = cut("  // Bề rộng khung (pt) — the grip drag's arithmetic", "  // Numeric spacing / scale / opacity");

function boxwRig(annot, opts) {
  const o = opts || {};
  const bw = el({ max: "14400" });
  const undo = [];
  let overlays = 0;
  const ed = { sel: o.noSel ? null : 7 };
  const env = {
    $: (id) => (id === "fmt-boxw" ? bw : null),
    ed,
    findAnnot: (id) => (id === 7 && annot ? { a: annot, page: 0 } : null),
    pushEdUndo: (k) => undo.push(k),
    // Stub layout: width = boxW + 2·pad, height = one line per 50pt of text over boxW.
    measureText: (text, size, st) => ({ w: st.boxW + 3, h: Math.ceil(400 / st.boxW) * 13 }),
    textStyle: (a) => ({ boxW: a.boxW || 0 }),
    syncOverlays: () => overlays++,
    MIN_BOX_W: 24,
  };
  new Function(...Object.keys(env), BOXW_SRC)(...Object.values(env));
  return { bw, undo, overlays: () => overlays, a: annot };
}

{
  const r = boxwRig({ kind: "text", text: "x", fontSize: 10, boxW: 200, w: 203, h: 26, x: 5, y: 6 });
  r.bw.value = "1";
  r.bw.fire("input");
  check("K1 typing the first digit of 150 does NOT squash the box to the minimum", [r.a.boxW, r.undo.length], [200, 0]);
  r.bw.value = "15";
  r.bw.fire("input");
  check("K1b …nor does the second (15 < MIN_BOX_W)", r.a.boxW, 200);
  r.bw.value = "150";
  r.bw.fire("input");
  check("K2 a valid width applies live: wrap width set, size re-measured", [r.a.boxW, r.a.w, r.a.h], [150, 153, 39]);
  check("K2b …x/y stay (the grip's east-edge rule)", [r.a.x, r.a.y], [5, 6]);
  check("K2c …one undo step, keyed per box (coalesced while typing)", r.undo, ["boxw:7"]);
  check("K2d …and the overlay is redrawn", r.overlays(), 1);
  r.bw.value = "5";
  r.bw.fire("change");
  check("K3 leaving the field with a too-small width clamps to the minimum and shows it", [r.a.boxW, r.bw.value], [24, "24"]);
  r.bw.value = "999999";
  r.bw.fire("change");
  check("K3b …and a huge one to the field's max", [r.a.boxW, r.bw.value], [14400, "14400"]);
  r.bw.value = "";
  r.bw.fire("change");
  check("K3c an empty / junk value puts the current width back, changes nothing", [r.a.boxW, r.bw.value], [14400, "14400"]);
  r.bw.value = "abc";
  r.bw.fire("change");
  check("K3d …same for text", [r.a.boxW, r.bw.value], [14400, "14400"]);
  const n = r.undo.length;
  r.bw.value = "14400";
  r.bw.fire("change");
  check("K3e the same width again records no undo step", r.undo.length, n);
}
{
  const r = boxwRig({ kind: "text", text: "x", fontSize: 10, boxW: 0, w: 50, h: 16 });
  r.bw.value = "120";
  r.bw.fire("input");
  r.bw.fire("change");
  check("K4 a POINT box (no wrap width) is never turned into a fixed box by this field", [r.a.boxW, r.undo.length], [0, 0]);
}
{
  const r = boxwRig({ kind: "text", text: "x", fontSize: 10, boxW: 100, rot: 90, w: 103, h: 52 });
  r.bw.value = "80";
  r.bw.fire("input");
  check("K5 a ROTATED fixed box is resized (it has no grips — BI-104)", r.a.boxW, 80);
}
{
  const r = boxwRig({ kind: "box", boxW: 100 });
  r.bw.value = "80";
  r.bw.fire("input");
  check("K6 a non-text selection is ignored", [r.a.boxW, r.undo.length], [100, 0]);
  const r2 = boxwRig({ kind: "text", boxW: 100 }, { noSel: true });
  r2.bw.value = "80";
  r2.bw.fire("input");
  check("K6b no selection → nothing happens", r2.a.boxW, 100);
}

// syncFmtPanel's half: enabled only for a selected FIXED box, rounded, never clobbering
// the field while it is being typed into.
check("K7 syncFmtPanel enables the field only for a selected fixed box",
  /bw\.disabled = !\(hit && hit\.a\.kind === "text" && s\.boxW > 0\);/.test(ED), true);
check("K7b …shows the rounded width, blank when disabled, and skips the focused field",
  /if \(bw !== active\) bw\.value = bw\.disabled \? "" : String\(Math\.round\(s\.boxW\)\);/.test(ED), true);
check("K7c a grip drag ends with the panel re-synced (the field shows the new width)",
  /renderLayer\(layer, page\);\s*\/\/[^\n]*\n[^\n]*\n\s*syncFmtPanel\(\);\s*\}/.test(ED), true);
{
  const m = /<input type="number" id="fmt-boxw" min="(\d+)" max="(\d+)"/.exec(HTML);
  const minW = /const MIN_BOX_W = (\d+);/.exec(ED);
  check("K8 #fmt-boxw exists, its min equals editor.js MIN_BOX_W", m && minW && m[1] === minW[1], true);
  check("K8b …and it sits right after the wrap checkbox (same paragraph group)",
    /id="fmt-wrap"[^\n]*\n(?:\s*<!--[\s\S]*?-->\s*\n)?\s*<label class="fmt-row"[^>]*>Bề rộng khung <input type="number" id="fmt-boxw"/.test(HTML), true);
}

// =============================================================================
// P1 · Thu gọn / mở rộng
// =============================================================================
const COLL_SRC = cut("  const FMT_COLLAPSED_KEY = ", "  // Alignment buttons");

function collRig(stored, opts) {
  const o = opts || {};
  const panel = el();
  const btn = el();
  const writes = [];
  const localStorage = {
    getItem: (k) => {
      if (o.throwGet) throw new Error("denied");
      return k === "nabu-fmt-collapsed" ? stored : null;
    },
    setItem: (k, v) => {
      if (o.throwSet) throw new Error("denied");
      writes.push([k, v]);
    },
  };
  const $ = (id) => (id === "fmt-panel" ? panel : id === "fmt-collapse" ? btn : null);
  new Function("$", "localStorage", COLL_SRC)($, localStorage);
  return { panel, btn, writes };
}
{
  const r = collRig(null);
  check("C1 first launch: expanded, aria-expanded true, nothing written",
    [r.panel.classList.contains("collapsed"), r.btn.getAttribute("aria-expanded"), r.writes], [false, "true", []]);
  r.btn.fire("click");
  check("C2 click collapses and remembers it", [r.panel.classList.contains("collapsed"), r.btn.getAttribute("aria-expanded"), r.writes],
    [true, "false", [["nabu-fmt-collapsed", "1"]]]);
  r.btn.fire("click");
  check("C2b click again expands and remembers that", [r.panel.classList.contains("collapsed"), r.writes[1]], [false, ["nabu-fmt-collapsed", "0"]]);
}
check("C3 a remembered collapse is restored at load", collRig("1").panel.classList.contains("collapsed"), true);
check("C3b anything but \"1\" means expanded", ["0", "", "true", null].map((v) => collRig(v).panel.classList.contains("collapsed")), [false, false, false, false]);
{
  let ok = true;
  let r;
  try {
    r = collRig("1", { throwGet: true, throwSet: true });
    r.btn.fire("click");
  } catch (_) {
    ok = false;
  }
  check("C4 unreadable / unwritable storage never throws (private window, blocked site data)", ok, true);
  check("C4b …it just starts expanded and still toggles", r && r.panel.classList.contains("collapsed"), true);
}
check("C5 the toggle keeps an open text editor focused (mousedown preventDefault)",
  /b\.addEventListener\("mousedown", \(ev\) => ev\.preventDefault\(\)\);\s*b\.addEventListener\("click", \(\) => setFmtCollapsed/.test(COLL_SRC), true);
check("C6 the button lives in the panel head (the part a collapsed panel keeps)",
  /<div class="fmt-head"><b>Định dạng văn bản<\/b>\s*<button class="fmt-ic fmt-collapse" id="fmt-collapse"/.test(HTML), true);
check("C6b a collapsed panel hides everything but the head, and the head's title",
  /\.fmt-panel\.collapsed > :not\(\.fmt-head\), \.fmt-panel\.collapsed \.fmt-head b \{ display: none; \}/.test(CSS), true);
check("C6c …and is a narrow strip, not the full 236px",
  /\.fmt-panel\.collapsed \{ width: (\d+)px;/.test(CSS) && +/\.fmt-panel\.collapsed \{ width: (\d+)px;/.exec(CSS)[1] <= 48, true);
check("C7 collapse is a class, independent of `hidden` (updateFmtPanel still decides WHEN)",
  /panel\.classList\.toggle\("collapsed", on\)/.test(COLL_SRC) && !/hidden/.test(COLL_SRC.replace(/\/\/[^\n]*/g, "")), true);
{
  // The button's title is static on purpose (no SKIP_IDS needed, BI-10); every new
  // string has its English entry.
  const STR = ["Bề rộng khung", "Bề rộng chữ xuống dòng của hộp đang chọn (chỉ hộp tự xuống dòng theo khung).",
    "Thu gọn / mở rộng bảng Định dạng"];
  check("C8 every new string has an EN entry in i18n.js", STR.map((s) => I18N.includes(JSON.stringify(s) + ":")), STR.map(() => true));
  check("C8b …and each one appears verbatim in index.html (the dictionary key matches the markup)",
    STR.map((s) => HTML.includes(s)), STR.map(() => true));
  check("C8c no JS writes the toggle's title (static text, nothing for i18n to fight)",
    /fmt-collapse[^\n]*\.title\s*=/.test(ED), false);
}

// =============================================================================
// P3 · Ký tự đặc biệt
// =============================================================================
const AT = require("../renderer/annot-text.js");
const INSERT_SRC = cut("    ed._taInsert = (str) => {", "    // Width hook for the \"textbox\" drag");
function insertRig(execOk) {
  const calls = [];
  const ta = {
    selectionStart: 2, selectionEnd: 4,
    focus: () => calls.push("focus"),
    setRangeText: (s, a, b, mode) => calls.push(["setRangeText", s, a, b, mode]),
    dispatchEvent: (ev) => calls.push(["dispatch", ev.type, ev.bubbles]),
  };
  const document = { execCommand: (cmd, ui, s) => (calls.push(["exec", cmd, s]), execOk) };
  const ed = {};
  class Event { constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); } }
  new Function("ed", "ta", "document", "Event", INSERT_SRC)(ed, ta, document, Event);
  ed._taInsert("²");
  return calls;
}
check("S1 the insert goes through insertText (keeps the field's own Ctrl+Z, fires input)",
  insertRig(true), ["focus", ["exec", "insertText", "²"]]);
check("S1b …and falls back to setRangeText + an 'input' event if the command is refused",
  insertRig(false), ["focus", ["exec", "insertText", "²"], ["setRangeText", "²", 2, 4, "end"], ["dispatch", "input", true]]);
check("S2 closing the editor drops the insert hook with the others (no write into a dead field)",
  /function clearTaHooks\(\) \{[\s\S]{0,300}?ed\._taInsert = null;/.test(ED), true);

const SYM_SRC = cut("  // Ký tự đặc biệt. Only while a text editor is open", "  // ---- the text default (Đặt làm mặc định");
function symRig(withEditor) {
  const inserted = [];
  const toasts = [];
  let prevented = 0;
  const btns = ["²", "⌀"].map((ch) => el({ dataset: { ch } }));
  const document = { querySelectorAll: (q) => (q === "#fmt-symbols [data-ch]" ? btns : []) };
  const ed = withEditor ? { _taInsert: (s) => inserted.push(s) } : {};
  const window = { t: (s) => "EN:" + s };
  const toast = (m, k) => toasts.push([m, k]);
  new Function("document", "ed", "window", "toast", SYM_SRC)(document, ed, window, toast);
  btns[1].fire("mousedown", { preventDefault: () => prevented++ });
  btns[1].fire("click");
  return { inserted, toasts, prevented };
}
{
  const r = symRig(true);
  check("S3 with the editor open, a symbol button inserts ITS character", r.inserted, ["⌀"]);
  check("S3b …and its mousedown keeps the field focused (preventDefault)", r.prevented, 1);
  const r2 = symRig(false);
  check("S4 no editor open: nothing inserted, a translated hint instead", [r2.inserted.length, r2.toasts.length, /^EN:/.test(r2.toasts[0][0])], [0, 1, true]);
}
{
  const m = /<div class="fmt-grid fmt-sym" id="fmt-symbols">([\s\S]*?)<\/div>/.exec(HTML);
  const chs = m ? [...m[1].matchAll(/data-ch="([^"]+)">([^<]+)</g)].map((x) => [x[1], x[2]]) : [];
  check("S5 the symbol set (RESEARCH P3): m² m³ ± ⌀ ° × ≤ ≥ ‰ µ, each button labelled with its own character",
    chs, [["²", "²"], ["³", "³"], ["±", "±"], ["⌀", "⌀"], ["°", "°"], ["×", "×"], ["≤", "≤"], ["≥", "≥"], ["‰", "‰"], ["µ", "µ"]]);
}

// =============================================================================
// P4 · Đặt làm mặc định / Xoá định dạng
// =============================================================================
const DEF_SRC = cut("  const TEXT_DEFAULT_LS = ", "  // ---- Sao chép / Dán định dạng (format painter) ----");
// The palette's factory state, as the `ed` literal in editor.js declares it.
const edFactory = () => ({
  sel: null, font: "sans", fontSize: 16, bold: false, italic: false, underline: false, strike: false, align: "left",
  lineHeight: 1.3, paraSpacing: 0, letterSpacing: 0, wordSpacing: 0, charScale: 1, indent: 0, listType: "none",
  textOpacity: 1, textRot: 0,
});
function defRig(opts) {
  const o = opts || {};
  const ed = edFactory();
  const ctl = { "ed-font": el(), "ed-fontsize": el(), "fmt-set-default": el(), "fmt-clear": el() };
  const btnState = {};
  const writes = [];
  const toasts = [];
  const log = [];
  const box = o.box || null;
  if (box) ed.sel = 7;
  const localStorage = {
    getItem: () => { if (o.throwGet) throw new Error("denied"); return o.stored == null ? null : o.stored; },
    setItem: (k, v) => { if (o.throwSet) throw new Error("denied"); writes.push([k, v]); },
  };
  const env = {
    $: (id) => ctl[id] || null,
    ed,
    findAnnot: (id) => (id === 7 && box ? { a: box, page: 0 } : null),
    localStorage,
    window: { AnnotText: AT, t: (s) => s },
    toast: (m, k) => toasts.push([m, k]),
    setFmtBtn: (id, on) => (btnState[id] = !!on),
    syncFmtPanel: () => log.push("syncFmtPanel"),
    syncControls: () => log.push("syncControls"),
    syncOverlays: () => log.push("syncOverlays"),
    pushEdUndo: (k) => log.push("undo:" + k),
    measureText: (t, size, st) => ({ w: size * 10 + (st.bold ? 1 : 0), h: size * 2 }),
    textStyle: (a) => AT.normTextStyle(a),
    // editor.js edTextStyle: the palette bundle a NEW box inherits (opacity ← textOpacity).
    edTextStyle: () => ({ font: ed.font, bold: ed.bold, italic: ed.italic, underline: ed.underline, strike: ed.strike,
      align: ed.align, lineHeight: ed.lineHeight, paraSpacing: ed.paraSpacing, letterSpacing: ed.letterSpacing,
      wordSpacing: ed.wordSpacing, charScale: ed.charScale, indent: ed.indent, listType: ed.listType,
      opacity: ed.textOpacity, rot: ed.textRot, fill: "none", fillOpacity: 1 }),
  };
  new Function(...Object.keys(env), DEF_SRC)(...Object.values(env));
  return { ed, ctl, btnState, writes, toasts, log, box };
}
{
  const saved = JSON.stringify(Object.assign(AT.pickTextDefault({}), { font: "Tahoma", fontSize: 12, bold: true, align: "center", opacity: 0.5 }));
  const r = defRig({ stored: saved });
  check("D1 a saved default seeds the palette at load (opacity → ed.textOpacity)",
    [r.ed.font, r.ed.fontSize, r.ed.bold, r.ed.align, r.ed.textOpacity, "opacity" in r.ed], ["Tahoma", 12, true, "center", 0.5, false]);
  check("D1b …and the font bar shows it", [r.ctl["ed-font"].value, r.ctl["ed-fontsize"].value, r.btnState["ed-bold"]], ["Tahoma", "12", true]);
  check("D1c nothing saved → the palette stays factory, nothing written", [JSON.stringify(defRig().ed), defRig().writes.length],
    [JSON.stringify(edFactory()), 0]);
  check("D1d junk in storage → factory (re-validated, never reaches a box)", JSON.stringify(defRig({ stored: "{oops" }).ed), JSON.stringify(edFactory()));
  let ok = true;
  try { defRig({ throwGet: true, throwSet: true }).ctl["fmt-set-default"].fire("click"); } catch (_) { ok = false; }
  check("D1e unreadable / unwritable storage never throws", ok, true);
}
{
  // Đặt làm mặc định with NOTHING selected: the palette as it stands, size included.
  const r = defRig();
  r.ed.fontSize = 20;
  r.ed.italic = true;
  r.ed.textOpacity = 0.7;
  r.ctl["fmt-set-default"].fire("click");
  const w = r.writes[0] && JSON.parse(r.writes[0][1]);
  check("D2 nothing selected: the palette is saved (size + italic + opacity), under its own key",
    [r.writes.length, r.writes[0] && r.writes[0][0], w && w.fontSize, w && w.italic, w && w.opacity], [1, "nabu-text-default", 20, true, 0.7]);
  check("D2b …the payload is exactly a pickTextDefault (no colour / rotation / fill)", w && Object.keys(w).sort(), AT.TEXT_DEFAULT_KEYS.slice().sort());
  check("D2c …and says so", r.toasts, [["Hộp chữ mới sẽ dùng kiểu này.", "good"]]);
}
{
  const box = { kind: "text", text: "a", font: "Arial", fontSize: 30, bold: true, align: "right", listType: "bullet", color: "#00f", rot: 45, boxW: 100, opacity: 0.6 };
  const r = defRig({ box });
  r.ctl["ed-font"].value = "Arial (box)"; // what syncControls put there for the selected box
  r.ctl["fmt-set-default"].fire("click");
  check("D3 a selected box: ITS style becomes the default for new boxes",
    [r.ed.font, r.ed.fontSize, r.ed.bold, r.ed.align, r.ed.listType, r.ed.textOpacity], ["Arial", 30, true, "right", "bullet", 0.6]);
  check("D3b …colour and rotation are NOT carried into the palette", [r.ed.textRot, "color" in r.ed, "rot" in r.ed], [0, false, false]);
  check("D3c …the font bar keeps showing the selected box (not overwritten)", r.ctl["ed-font"].value, "Arial (box)");
  check("D3d …no undo step: a preference, not an edit of the document", r.log.filter((x) => /^undo:/.test(x)), []);
  check("D3e the box itself is untouched", [box.font, box.rot, box.color], ["Arial", 45, "#00f"]);
}
{
  const r = defRig({ throwSet: true });
  r.ed.bold = true;
  r.ctl["fmt-set-default"].fire("click");
  check("D4 storage refuses: the default still applies for this session, and the toast says it was not saved",
    [r.ed.bold, r.toasts[0] && r.toasts[0][1]], [true, "bad"]);
}
{
  const r = defRig();
  r.ctl["fmt-clear"].fire("click");
  check("D5 Xoá định dạng with nothing selected does nothing", r.log, []);
  const box = { kind: "text", text: "abc", font: "Arial", fontSize: 30, bold: true, italic: true, underline: true, strike: true,
    align: "justify", lineHeight: 2, paraSpacing: 6, letterSpacing: 1, wordSpacing: 3, charScale: 0.8, indent: 36, listType: "number",
    opacity: 0.4, color: "#0000ff", fill: "#ffff00", fillOpacity: 0.5, rot: 30, boxW: 150, x: 10, y: 20, w: 1, h: 1 };
  const r2 = defRig({ box, stored: JSON.stringify(Object.assign(AT.pickTextDefault({}), { fontSize: 40 })) });
  r2.ctl["fmt-clear"].fire("click");
  const f = AT.pickTextDefault({});
  check("D6 a selected box returns to the FACTORY style (not the saved default)",
    AT.TEXT_DEFAULT_KEYS.map((k) => box[k]), AT.TEXT_DEFAULT_KEYS.map((k) => f[k]));
  check("D6b …keeping colour, background, rotation, wrap width, text and position",
    [box.color, box.fill, box.fillOpacity, box.rot, box.boxW, box.text, box.x, box.y], ["#0000ff", "#ffff00", 0.5, 30, 150, "abc", 10, 20]);
  check("D6c …re-measured at the new size", [box.w, box.h], [160, 32]);
  check("D6d …one undo step keyed per box, then overlay + font bar + panel redrawn",
    r2.log.slice(-4), ["undo:clearfmt:7", "syncOverlays", "syncControls", "syncFmtPanel"]);
}
check("D7 syncFmtPanel: Xoá định dạng is enabled only with a text box selected",
  /clr\.disabled = !\(hit && hit\.a\.kind === "text"\);/.test(ED), true);
{
  // The factory has three spellings that must agree: ed's literal, the size field's
  // markup, and pickTextDefault({}) (what Xoá định dạng writes).
  const f = AT.pickTextDefault({});
  const lit = (k) => { const m = new RegExp("^    " + k + ": ([^,]+),", "m").exec(ED); return m ? m[1].trim() : null; };
  check("D8 the ed literal's text fields equal the factory style",
    ["fontSize", "font", "bold", "italic", "underline", "strike", "align", "lineHeight", "paraSpacing", "letterSpacing",
      "wordSpacing", "charScale", "indent", "listType", "textOpacity"].map(lit),
    [String(f.fontSize), '"sans"', "false", "false", "false", "false", '"left"', "1.3", "0", "0", "0", "1", "0", '"none"', "1"]);
  const fs_ = /<input type="number" id="ed-fontsize" min="(\d+)" max="(\d+)" value="(\d+)"/.exec(HTML);
  check("D8b #ed-fontsize min / max / value = TEXT_SIZE_MIN / MAX / DEFAULT",
    fs_ && [+fs_[1], +fs_[2], +fs_[3]], [AT.TEXT_SIZE_MIN, AT.TEXT_SIZE_MAX, AT.TEXT_SIZE_DEFAULT]);
}
check("D9 the system-font list arriving late puts the palette's font back into the picker",
  /grp\.appendChild\(frag\);\s*fontsLoaded = true;[\s\S]{0,500}?if \(!\(selHit && selHit\.a\.kind === "text"\)\) \$\("ed-font"\)\.value = ed\.font;/.test(ED), true);
check("D10 editor.js reaches the pure half through window.AnnotText, never new bare names (BI-14)",
  /[^.\w](pickTextDefault|parseTextDefault|TEXT_DEFAULT_KEYS)\(/.test(DEF_SRC.replace(/window\.AnnotText\.\w+/g, "")), false);
{
  const STR = ["Ký tự đặc biệt", "Chèn vào chỗ con trỏ khi đang gõ chữ.",
    "Bấm vào trang (hoặc bấm đúp một hộp chữ) để gõ, rồi bấm ký tự cần chèn.",
    "Kiểu chữ", "Đặt làm mặc định", "Xoá định dạng",
    "Hộp chữ mới sẽ dùng kiểu của hộp đang chọn (hoặc kiểu đang đặt): font, cỡ, đậm / nghiêng / gạch, căn lề, giãn, danh sách, độ mờ. App nhớ cho lần sau.",
    "Đưa hộp chữ đang chọn về kiểu gốc của app. Giữ nguyên màu, nền, góc xoay và bề rộng khung.",
    "Hộp chữ mới sẽ dùng kiểu này.", "Đã đặt cho lần làm việc này — không lưu được cho lần mở sau."];
  check("D11 every new P3/P4 string has an EN entry", STR.map((s) => I18N.includes(JSON.stringify(s) + ":")), STR.map(() => true));
  check("D11b …and each one is spelled exactly as the markup / editor.js writes it",
    STR.map((s) => HTML.includes(s) || ED.includes(s)), STR.map(() => true));
}

// =============================================================================
// P5 · Sao chép / Dán định dạng
// =============================================================================
const PAINT_SRC = cut("  function copyTextFmt() {", '  [["fmt-copy-style", copyTextFmt]');
function paintRig(sel, page) {
  const log = [];
  const toasts = [];
  const annots = page;
  const ed = { sel };
  const env = {
    ed,
    findAnnot: (id) => { const a = annots.find((x) => x.id === id); return a ? { a, page: 0 } : null; },
    selAnnots: () => annots.filter((x) => x._sel),
    window: { AnnotText: AT, t: (s) => s },
    toast: (m, k) => toasts.push([m, k]),
    pushEdUndo: (k) => log.push("undo:" + (k || "")),
    measureText: (t, size) => ({ w: size * 10, h: size * 2 }),
    textStyle: (a) => AT.normTextStyle(a),
    syncOverlays: () => log.push("syncOverlays"),
    syncControls: () => log.push("syncControls"),
    syncFmtPanel: () => log.push("syncFmtPanel"),
  };
  // fmtClip is the banner-level `let` — give the cut code its own.
  const api = new Function(...Object.keys(env), "let fmtClip = null;\n" + PAINT_SRC +
    "\nreturn { copyTextFmt, pasteTextFmt, clip: () => fmtClip };")(...Object.values(env));
  return Object.assign(api, { log, toasts, ed });
}
{
  const src = { id: 1, kind: "text", text: "A", font: "Tahoma", fontSize: 20, bold: true, color: "#0000ff",
    borderColor: "#ff0000", rot: 45, _sel: true };
  const t1 = { id: 2, kind: "text", text: "B", fontSize: 10, color: "#000000", rot: 0, boxW: 80 };
  const t2 = { id: 3, kind: "text", text: "C", fontSize: 10, color: "#000000", _foreign: { ft: {} }, borderColor: "#123456" };
  const shape = { id: 4, kind: "box", color: "#00ff00", width: 2 };
  const page = [src, t1, t2, shape];
  const r = paintRig(1, page);
  check("P5a nothing copied yet ⇒ paste does nothing", [r.pasteTextFmt(), r.log], [false, []]);
  check("P5b copy from the selected text box", [r.copyTextFmt(), r.clip() && r.clip().font, r.toasts[0][1]], [true, "Tahoma", "good"]);
  // select the three targets (a Ctrl+click group): two text boxes and a shape
  src._sel = false; t1._sel = t2._sel = shape._sel = true; r.ed.sel = 2;
  r.log.length = 0;
  check("P5c paste onto the selection", r.pasteTextFmt(), true);
  check("P5d every selected TEXT box takes the look (font, size, colour) and is re-measured",
    [t1.font, t1.fontSize, t1.color, t1.w, t2.font, t2.color], ["Tahoma", 20, "#0000ff", 200, "Tahoma", "#0000ff"]);
  check("P5e …the shape in the group is left alone", JSON.stringify(shape), JSON.stringify({ id: 4, kind: "box", color: "#00ff00", width: 2, _sel: true }));
  check("P5f …own rotation / wrap width kept; a partner's FreeText keeps ITS border",
    [t1.rot, t1.boxW, t1.borderColor, t2.borderColor], [0, 80, "#ff0000", "#123456"]);
  check("P5g …ONE undo step for the whole group, then redraw + font bar + panel",
    r.log, ["undo:", "syncOverlays", "syncControls", "syncFmtPanel"]);
  check("P5h …and the toast counts the boxes", r.toasts[1][0], "Đã dán định dạng vào 2 hộp chữ.");
  const r2 = paintRig(4, [Object.assign({}, shape, { _sel: true })]);
  check("P5i copy with a NON-text selection does nothing", [r2.copyTextFmt(), r2.clip()], [false, null]);
}
check("P5j fmtClip is declared BEFORE syncFmtPanel (a later `let` = TDZ crash on its first call)",
  ED.indexOf("  let fmtClip = null;") > 0 && ED.indexOf("  let fmtClip = null;") < ED.indexOf("  function syncFmtPanel()"), true);
check("P5k syncFmtPanel: copy needs a text box; paste needs a clip AND a selected text box",
  /cpy\.disabled = !\(hit && hit\.a\.kind === "text"\);[\s\S]{0,200}?pst\.disabled = !fmtClip \|\| !selAnnots\(\)\.some\(\(x\) => x\.kind === "text"\);/.test(ED), true);
check("P5l Ctrl+Shift+C / V by physical key, never while typing, claimed only when it did something",
  /e\.shiftKey && !e\.altKey && !typing && !e\.repeat &&\s*\(e\.code === "KeyC" \|\| e\.code === "KeyV"\)\) \{\s*if \(e\.code === "KeyC" \? copyTextFmt\(\) : pasteTextFmt\(\)\) e\.preventDefault\(\);/.test(ED), true);
check("P5m …and the plain Ctrl+C object copy still refuses Shift (so the two never both fire)",
  /\(e\.key === "c" \|\| e\.key === "C"\) && \(e\.ctrlKey \|\| e\.metaKey\) && !e\.shiftKey/.test(ED), true);

// =============================================================================
// P6 · Viền khung
// =============================================================================
const BORDER_SRC = cut("  function writeBorder(final) {", '  $("ed-penwidth").oninput');
function borderRig(box, ctlv) {
  const log = [];
  const c = {
    "fmt-border": el({ checked: !!ctlv.on }),
    "fmt-border-color": el({ value: ctlv.color || "#000000" }),
    "fmt-border-width": el({ value: ctlv.width == null ? "1" : String(ctlv.width) }),
    "fmt-border-dash": el({ value: ctlv.dash || "solid" }),
  };
  const ed = { sel: box ? 7 : null };
  const env = {
    $: (id) => c[id] || null, ed,
    findAnnot: (id) => (id === 7 && box ? { a: box, page: 0 } : null),
    window: { AnnotText: AT },
    pushEdUndo: (k) => log.push("undo:" + k),
    syncOverlays: () => log.push("syncOverlays"),
    syncFmtPanel: () => log.push("syncFmtPanel"),
  };
  new Function(...Object.keys(env), BORDER_SRC)(...Object.values(env));
  return { c, log, box };
}
{
  const box = { kind: "text", text: "A", color: "#0000ff" };
  const r = borderRig(box, { on: true, color: "#ff0000", width: 2, dash: "dash" });
  r.c["fmt-border"].fire("change");
  check("B1 ticking Viền writes colour / width / dash onto the selected box",
    [box.borderColor, box.borderWidth, box.borderDash], ["#ff0000", 2, "dash"]);
  check("B1b …one undo step keyed per box, then redraw", r.log, ["undo:border:7", "syncOverlays", "syncFmtPanel"]);
  r.c["fmt-border-dash"].value = "solid";
  r.c["fmt-border-dash"].fire("change");
  check("B2 back to solid ⇒ the dash key is REMOVED (not stored as \"solid\")", ["borderDash" in box, box.borderColor], [false, "#ff0000"]);
  r.c["fmt-border-width"].value = "0";
  r.c["fmt-border-width"].fire("input");
  check("B3 typing an invalid width mid-way changes nothing", box.borderWidth, 2);
  r.c["fmt-border-width"].value = "50";
  r.c["fmt-border-width"].fire("change");
  check("B3b leaving the field clamps to 12pt and shows it", [box.borderWidth, r.c["fmt-border-width"].value], [12, "12"]);
  const n = r.log.length;
  r.c["fmt-border-width"].fire("change");
  check("B3c the same value again records nothing", r.log.length, n);
  r.c["fmt-border"].checked = false;
  r.c["fmt-border"].fire("change");
  check("B4 unticking DELETES all three keys (the shape of a box that never had a border — BI-59)",
    ["borderColor", "borderWidth", "borderDash"].filter((k) => k in box), []);
}
{
  const fb = { kind: "text", text: "A", color: "#000000", _foreign: { ft: { border: { width: 1, color: "#000000" } } } };
  const r = borderRig(fb, { on: true, color: "#ff0000" });
  r.c["fmt-border"].fire("change");
  check("B5 a partner's FreeText is never given a Nabu border (it keeps its file's)", ["borderColor" in fb, r.log], [false, []]);
  const r2 = borderRig(null, { on: true });
  r2.c["fmt-border"].fire("change");
  check("B5b nothing selected ⇒ nothing happens", r2.log, []);
}
check("B6 syncFmtPanel disables the border controls for a partner's FreeText, and the sub-controls while off",
  /bdC\.disabled = !box \|\| !!box\._foreign;[\s\S]{0,200}?const off = bdC\.disabled \|\| !bd;/.test(ED), true);
{
  // The overlay half — renderAnnot cannot run in node, so its shape is pinned.
  check("B7 renderAnnot draws the border on the RASTER's rectangle (textRasterBoxPt), and the wash with it",
    /const bd = window\.AnnotText\.normTextBorder\(a\);\s*const rb = bd \? window\.AnnotText\.textRasterBoxPt\(a\.text, st, a\.fontSize\) : \{ w: a\.w, h: a\.h \};/.test(ED) &&
    /bg\.style\.width = \(rb\.w \* s\) \/ st\.charScale \+ "px";\s*bg\.style\.height = rb\.h \* s \+ "px";/.test(ED), true);
  check("B7b …as an <svg> in pt stretched with preserveAspectRatio=none (cancels scaleX: uniform stroke)",
    /svg\.setAttribute\("viewBox", `0 0 \$\{rb\.w\} \$\{rb\.h\}`\);\s*svg\.setAttribute\("preserveAspectRatio", "none"\);/.test(ED), true);
  check("B7c …inset by half the pen, dashed by dashSpec (renderTextPng's numbers)",
    /r\.setAttribute\("x", String\(lw \/ 2\)\);[\s\S]{0,400}?const ds = dashSpec\(bd\.dash, bd\.width\);/.test(ED), true);
  const BAKE = R("editor-bake.js");
  check("B8 renderTextPng takes its rectangle from textRasterGeom (one formula, two readers)",
    /const \{ pad, cw, chh \} = window\.AnnotText\.textRasterGeom\(lay\.width, lay\.height, fpx\);/.test(BAKE), true);
  check("B8b writeFreeText strips a Nabu border from a partner's box before rasterising",
    /delete style\.fill;[^\n]*\n\s*delete style\.borderColor;/.test(BAKE), true);
  check("B8c the border controls exist: tick, colour, width (min/max = TEXT_BORDER_MIN/MAX), style",
    (() => { const m = /id="fmt-border-width" min="([\d.]+)" max="([\d.]+)"/.exec(HTML); return !!m && +m[1] === AT.TEXT_BORDER_MIN && +m[2] === AT.TEXT_BORDER_MAX &&
      /id="fmt-border"/.test(HTML) && /id="fmt-border-color"/.test(HTML) && /<select id="fmt-border-dash"><option value="solid">Liền<\/option><option value="dash">Nét đứt<\/option><option value="dot">Chấm<\/option><\/select>/.test(HTML); })(), true);
}
{
  const STR = ["Sao chép định dạng", "Dán định dạng",
    "Sao chép định dạng của hộp chữ đang chọn: font, cỡ, đoạn văn, màu, nền, viền (Ctrl+Shift+C).",
    "Áp định dạng đã sao chép vào các hộp chữ đang chọn (Ctrl+Shift+V). Không đổi chữ, góc xoay, bề rộng khung.",
    "Đã sao chép định dạng — chọn hộp chữ khác rồi bấm Dán định dạng (Ctrl+Shift+V).",
    "Đã dán định dạng vào {n} hộp chữ.", "Viền khung", "Viền quanh hộp chữ",
    "Kẻ khung quanh hộp chữ đang chọn — dùng cho nhãn, ghi chú trên bản vẽ.", "Màu viền", "Độ dày",
    "Kiểu nét", "Liền", "Nét đứt", "Chấm"];
  check("P56 every P5/P6 string has an EN entry", STR.map((s) => I18N.includes(JSON.stringify(s) + ":")), STR.map(() => true));
  check("P56b …spelled exactly as markup / editor.js write it", STR.map((s) => HTML.includes(s) || ED.includes(s)), STR.map(() => true));
}

console.log(`\nfmt-panel: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
