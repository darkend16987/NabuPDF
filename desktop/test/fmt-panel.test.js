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

console.log(`\nfmt-panel: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
