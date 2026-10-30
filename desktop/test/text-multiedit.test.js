"use strict";

// Regression net for BI-118 — style a Ctrl+click GROUP of text boxes at once.
//
// Until v0.2.81 the font bar, the Format panel and the border read the PRIMARY box alone
// (colour / stroke already took the whole selection), so bolding three labels bolded one.
// Every handler now goes through editor.js's textTargets / forTextTargets, and what these
// cases pin is the CONTRACT: a group is written together, ONE undo step, non-text members
// and a partner's FreeText are left alone, and a lone selection behaves exactly as it did.
//
// HOW. editor.js is a DOM-bound IIFE this grid cannot run, so — like fmt-panel.test.js — each
// block is CUT OUT of the shipping file by its comment markers and run against a fake DOM
// with the REAL group helpers prepended. A rename or move fails the cut loudly instead of
// silently testing nothing.
//
// Run:  node desktop/test/text-multiedit.test.js      (or: npm run test:multiedit)

const fs = require("fs");
const path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", "renderer", f), "utf8").replace(/\r\n/g, "\n");
const ED = R("editor.js");
const HTML = R("index.html");
const AT = require("../renderer/annot-text.js");

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
function cut(start, end) {
  const i = ED.indexOf(start);
  const j = ED.indexOf(end, i + 1);
  if (i < 0 || j < 0 || ED.indexOf(start, i + 1) >= 0) throw new Error("cut markers not found once: " + start);
  return ED.slice(i, j);
}
function cutFunction(name) {
  const at = ED.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`function ${name}() not found in editor.js — renamed?`);
  const open = ED.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < ED.length; i++) {
    if (ED[i] === "{") depth++;
    else if (ED[i] === "}" && --depth === 0) return ED.slice(at, i + 1);
  }
  throw new Error("unbalanced braces cutting " + name);
}

const HELP_SRC = cut("  const textTargets = ", "  // Ctrl/Cmd+click: add to (or remove from)");

// ---- a fake DOM element (auto-created per id) -------------------------------
function fakeEl(props) {
  const ls = {};
  const cls = new Set();
  return Object.assign({
    value: "", checked: false, disabled: false, hidden: false, max: "", textContent: "",
    addEventListener: (t, f) => (ls[t] = ls[t] || []).push(f),
    fire: (t, ev) => (ls[t] || []).forEach((f) => f(ev || { preventDefault() {} })),
    classList: {
      toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; want ? cls.add(c) : cls.delete(c); return want; },
      contains: (c) => cls.has(c),
    },
  }, props);
}

const tb = (id, extra) => Object.assign({
  id, kind: "text", text: "Nhãn " + id, fontSize: 16, font: "sans", x: 10 * id, y: 10, w: 80, h: 32, color: "#000000",
}, extra || {});

// A selection of `boxes` (all on one page, in this order) with `selected` ids, `primary` first.
function rig(boxes, selected, primary, src, ret, extraEnv) {
  const ed = {
    sel: primary == null ? null : primary, selMore: new Set(selected.filter((i) => i !== primary)),
    fontSize: 16, font: "sans", bold: false, italic: false, underline: false, textRot: 0, indent: 0, listType: "none",
  };
  const undo = [];
  let overlays = 0;
  const ctl = {};
  const env = {
    ed,
    $: (id) => (ctl[id] = ctl[id] || fakeEl()),
    selIds: () => (ed.sel == null ? [] : [ed.sel, ...ed.selMore]),
    selAnnots: () => boxes.filter((b) => (ed.sel != null && (b.id === ed.sel || ed.selMore.has(b.id)))),
    findAnnot: (id) => { const a = boxes.find((b) => b.id === id); return a ? { a, page: 0 } : null; },
    pushEdUndo: (k) => undo.push(k === undefined ? "(none)" : k),
    syncOverlays: () => overlays++,
    syncFmtPanel: () => {},
    syncControls: () => {},
    // Stub layout: width grows with size / bold / wrap width, so a re-measure is visible.
    measureText: (t, size, st) => ({ w: size * 10 + (st.bold ? 1 : 0) + (st.boxW || 0), h: size * 2 + (st.boxW ? 1 : 0) }),
    textStyle: (a) => AT.normTextStyle(a),
    normTextStyle: AT.normTextStyle,
    normRot: AT.normRot,
    MIN_BOX_W: 24,
    window: { AnnotText: AT },
  };
  Object.assign(env, extraEnv || {});
  const fn = new Function(...Object.keys(env), HELP_SRC + "\n" + src + "\n;return {" + (ret || []).join(",") + "};");
  const api = fn(...Object.values(env));
  return Object.assign({ ed, ctl, undo, overlays: () => overlays, boxes }, api);
}
const dims = (a) => [a.w, a.h];

// =============================================================================
// H · the helpers themselves
// =============================================================================
{
  const a = tb(1), b = tb(2), c = tb(3), r = { id: 4, kind: "box", x: 0, y: 0, w: 5, h: 5 };
  const g = rig([a, b, c, r], [1, 2, 3, 4], 3, "", ["textTargets", "selSig", "forTextTargets", "textRef"]);
  check("H1 textTargets = the text boxes of the selection, in page order, rectangle left out",
    g.textTargets().map((x) => x.id), [1, 2, 3]);
  check("H2 selSig is the sorted ids — the same string whichever one is primary", g.selSig(), "1,2,3,4");
  check("H3 textRef prefers the primary when it is a text box", g.textRef().id, 3);
  const g2 = rig([a, b, c, r], [1, 2, 4], 4, "", ["textRef", "textTargets"]);
  check("H3b …else the first text box of the group (primary is a rectangle)", g2.textRef().id, 1);
  const g3 = rig([r], [4], 4, "", ["forTextTargets", "textRef"]);
  check("H4 nothing to act on ⇒ false, no undo step, no redraw", [g3.forTextTargets("k", () => {}), g3.undo, g3.overlays(), g3.textRef()], [false, [], 0, null]);
  const g4 = rig([tb(7)], [7], 7, "", ["forTextTargets"]);
  g4.forTextTargets("fsize", (x) => { x.fontSize = 20; }, true);
  check("H5 a LONE selection keeps the old undo key: <key>:<id>", g4.undo, ["fsize:7"]);
  check("H5b …and is re-measured (a.w / a.h follow the new size)", dims(g4.boxes[0]), [200, 40]);
  g4.forTextTargets(null, () => {});
  check("H5c key null ⇒ never coalesced (B/I/U, font)", g4.undo[1], "(none)");
}

// =============================================================================
// F · font bar: size · font · turn
// =============================================================================
const BAR_SRC = cut('  $("ed-fontsize").oninput = (e) => {', "  // B / I / U toggles.");
function barRig(boxes, selected, primary) {
  const r = rig(boxes, selected, primary, BAR_SRC);
  return r;
}
{
  const boxes = [tb(1), tb(2), tb(3), { id: 4, kind: "box", x: 0, y: 0, w: 5, h: 5 }];
  const r = barRig(boxes, [1, 2, 3, 4], 1);
  r.ctl["ed-fontsize"].oninput({ target: { value: "24" } });
  check("F1 cỡ chữ: every selected text box gets the size", boxes.slice(0, 3).map((x) => x.fontSize), [24, 24, 24]);
  check("F1b …each is re-measured, ONE undo step for the group, one redraw", [boxes.slice(0, 3).map((x) => x.w), r.undo, r.overlays()], [[240, 240, 240], ["fsize:1,2,3,4"], 1]);
  check("F1c …the rectangle in the group is untouched", boxes[3], { id: 4, kind: "box", x: 0, y: 0, w: 5, h: 5 });
  check("F1d …and the palette default follows", r.ed.fontSize, 24);
  r.ctl["ed-fontsize"].oninput({ target: { value: "26" } });
  check("F1e a burst on the same group coalesces (same key)", r.undo, ["fsize:1,2,3,4", "fsize:1,2,3,4"]);

  const lone = barRig([tb(5), tb(6)], [5], 5);
  lone.ctl["ed-fontsize"].oninput({ target: { value: "20" } });
  check("F2 a LONE selection changes only itself, key as before", [lone.boxes.map((x) => x.fontSize), lone.undo], [[20, 16], ["fsize:5"]]);

  const none = barRig([{ id: 9, kind: "box", x: 0, y: 0, w: 1, h: 1 }], [9], 9);
  none.ctl["ed-fontsize"].oninput({ target: { value: "30" } });
  check("F3 a selection with no text box: palette default only, no undo, no redraw", [none.ed.fontSize, none.undo, none.overlays()], [30, [], 0]);
  const empty = barRig([tb(1)], [], null);
  empty.ctl["ed-fontsize"].oninput({ target: { value: "30" } });
  check("F3b nothing selected: only the palette default", [empty.ed.fontSize, empty.boxes[0].fontSize, empty.undo], [30, 16, []]);
}
{
  const boxes = [tb(1), tb(2, { font: "serif" }), tb(3)];
  const r = barRig(boxes, [1, 2, 3], 2);
  r.ctl["ed-font"].value = "mono";
  r.ctl["ed-font"].onchange({ target: { value: "mono" } });
  check("F4 phông: every selected box, re-measured, one un-coalesced step", [boxes.map((x) => x.font), r.undo], [["mono", "mono", "mono"], ["(none)"]]);
}
{
  const boxes = [tb(1, { rot: 0 }), tb(2, { rot: 30 }), tb(3, { rot: 100 })];
  const r = barRig(boxes, [1, 2, 3], 1);
  r.ctl["ed-textrot"].oninput({ target: { value: "45" } });
  check("F5 Xoay typed: the angle is ABSOLUTE — the whole group gets it", boxes.map((x) => x.rot), [45, 45, 45]);
  check("F5b …one step, key per group; the palette default follows", [r.undo, r.ed.textRot], [["trot:1,2,3"], 45]);
  const r2 = barRig([tb(1, { rot: 0 }), tb(2, { rot: 30 }), tb(3, { rot: 100 })], [1, 2, 3], 1);
  r2.ctl["ed-textrot-90"].onclick();
  check("F6 +90°: RELATIVE — each box from its own angle, wrapped into (−180,180]", r2.boxes.map((x) => x.rot), [90, 120, -170]);
  check("F6b …ONE undo step, and the default follows the primary", [r2.undo, r2.ed.textRot], [["trot:1,2,3"], 90]);
  const r3 = barRig([tb(1, { rot: 10 })], [1], 1);
  r3.ctl["ed-textrot-90"].onclick();
  check("F7 +90° on a LONE box is still 'its angle + 90' with the old key", [r3.boxes[0].rot, r3.undo], [100, ["trot:1"]]);
}

// =============================================================================
// U · B / I / U
// =============================================================================
const BIU_SRC = cut("  // B / I / U toggles.", "  // ---- text-box Format panel");
{
  const boxes = [tb(1), tb(2, { bold: true }), tb(3)];
  const r = rig(boxes, [1, 2, 3], 1, BIU_SRC);
  r.ctl["ed-bold"].fire("click");
  check("U1 B on a group: the primary's button flips to ON ⇒ EVERY box becomes bold (Word's rule, never half-bold)",
    boxes.map((x) => !!x.bold), [true, true, true]);
  check("U1b …re-measured (bold widens), one un-coalesced step", [boxes.map((x) => x.w), r.undo], [[161, 161, 161], ["(none)"]]);
  r.ctl["ed-bold"].fire("click");
  check("U1c clicking again turns it OFF for all of them", boxes.map((x) => !!x.bold), [false, false, false]);
  r.ctl["ed-italic"].fire("click");
  r.ctl["ed-underline"].fire("click");
  check("U2 italic / underline the same way", [boxes.map((x) => !!x.italic), boxes.map((x) => !!x.underline)], [[true, true, true], [true, true, true]]);
}

// =============================================================================
// P · Format panel: applyTextFmt · wrap · width · clear
// =============================================================================
const FMT_SRC = cut("  function applyTextFmt(", "  // Move the selected text box relative");
{
  const boxes = [tb(1), tb(2, { align: "center" }), tb(3)];
  const r = rig(boxes, [1, 2, 3], 1, FMT_SRC, ["applyTextFmt"]);
  r.applyTextFmt("align", "right", { undoKey: "align" });
  check("P1 căn lề: every selected box, one step", [boxes.map((x) => x.align), r.undo], [["right", "right", "right"], ["align:1,2,3"]]);
  r.applyTextFmt("lineHeight", 2, { remeasure: true, undoKey: "lineh" });
  check("P2 giãn dòng (re-measure on): all boxes, sizes follow",
    [boxes.map((x) => x.lineHeight), r.undo[1]], [[2, 2, 2], "lineh:1,2,3"]);
  check("P2b …and the palette default is still written (a new box inherits it)", r.ed.lineHeight, 2);
  const one = rig([tb(1), tb(2)], [2], 2, FMT_SRC, ["applyTextFmt"]);
  one.applyTextFmt("strike", true, { undoKey: "strike" });
  check("P3 a LONE selection: only itself, key as before", [one.boxes.map((x) => !!x.strike), one.undo], [[false, true], ["strike:2"]]);
  const rect = rig([{ id: 4, kind: "box" }], [4], 4, FMT_SRC, ["applyTextFmt"]);
  rect.applyTextFmt("align", "center", { undoKey: "align" });
  check("P4 a rectangle selected: palette only — no undo step, nothing written to it", [rect.ed.align, rect.undo, rect.boxes[0]], ["center", [], { id: 4, kind: "box" }]);
}
{
  const WRAP_SRC = cut("  // Tự xuống dòng theo khung.", "  // Bề rộng khung (pt)");
  // Different sizes ⇒ different natural widths in the stub layout (size × 10): a shared width is visible.
  const boxes = [tb(1, { fontSize: 10 }), tb(2, { fontSize: 20 }), tb(3, { boxW: 90 })];
  const r = rig(boxes, [1, 2, 3], 1, WRAP_SRC);
  const c = r.ctl["fmt-wrap"];
  c.checked = true;
  c.fire("change");
  check("P5 Tự xuống dòng ON: each box starts at ITS OWN natural width (natural − 2·0.15·size)", boxes.map((x) => x.boxW), [97, 194, 155.2]);
  check("P5b …ONE step for the group, boxes re-measured", [r.undo, boxes.map((x) => x.h)], [["wrap:1,2,3"], [21, 41, 33]]);
  c.checked = false;
  c.fire("change");
  check("P5c OFF: every box goes back to a point box (the key is deleted, not zeroed)", boxes.map((x) => "boxW" in x), [false, false, false]);
  const none = rig([{ id: 9, kind: "box" }], [9], 9, WRAP_SRC);
  none.ctl["fmt-wrap"].checked = true;
  none.ctl["fmt-wrap"].fire("change");
  check("P5d no text box in the selection ⇒ the tick snaps back, nothing recorded", [none.ctl["fmt-wrap"].checked, none.undo], [false, []]);
}
{
  const BOXW_SRC = cut("  // Bề rộng khung (pt) — the grip drag's arithmetic", "  // Numeric spacing / scale / opacity");
  const boxes = [tb(1, { boxW: 100 }), tb(2, { boxW: 140 }), tb(3), tb(4, { boxW: 100, rot: 90 })];
  const r = rig(boxes, [1, 2, 3, 4], 2, BOXW_SRC);
  r.ctl["fmt-boxw"].max = "14400";
  r.ctl["fmt-boxw"].value = "120";
  r.ctl["fmt-boxw"].fire("input");
  check("P6 Bề rộng khung: every WRAPPING box gets the width (turned ones too — they have no grips)",
    boxes.map((x) => x.boxW || 0), [120, 120, 0, 120]);
  check("P6b …a POINT box in the group is NOT turned into a fixed one", "boxW" in boxes[2], false);
  check("P6c …one step per group; re-measured", [r.undo, boxes[0].h], [["boxw:1,2,3,4"], 33]);
  const n = r.undo.length;
  r.ctl["fmt-boxw"].fire("change");
  check("P6d the same width again records nothing", r.undo.length, n);
  const pts = rig([tb(5), tb(6)], [5, 6], 5, BOXW_SRC);
  pts.ctl["fmt-boxw"].value = "120";
  pts.ctl["fmt-boxw"].fire("input");
  check("P6e a group of POINT boxes: nothing happens", [pts.undo, pts.boxes.map((x) => "boxW" in x)], [[], [false, false]]);
}
{
  const CLEAR_SRC = cut('  {\n    const b = $("fmt-clear");', "  // ---- Sao chép / Dán định dạng");
  const boxes = [tb(1, { bold: true, align: "right", color: "#ff0000", fill: "#ffff00", rot: 30 }), tb(2, { italic: true, fontSize: 30 }), { id: 3, kind: "box" }];
  const r = rig(boxes, [1, 2, 3], 1, CLEAR_SRC, [], { toast() {}, edTextStyle: () => ({}) });
  r.ctl["fmt-clear"].fire("click");
  const f = AT.pickTextDefault({});
  check("P7 Xoá định dạng: each text box back to the factory style", boxes.slice(0, 2).map((x) => [x.bold, x.italic, x.align, x.fontSize]),
    [[f.bold, f.italic, f.align, f.fontSize], [f.bold, f.italic, f.align, f.fontSize]]);
  check("P7b …colour, background and turn kept; one step for the group", [boxes[0].color, boxes[0].fill, boxes[0].rot, r.undo], ["#ff0000", "#ffff00", 30, ["clearfmt:1,2,3"]]);
  check("P7c …the rectangle is untouched", boxes[2], { id: 3, kind: "box" });
}

// =============================================================================
// B · Viền khung
// =============================================================================
const BORDER_SRC = cut("  function writeBorder(final) {", '  $("ed-penwidth").oninput');
function borderRig(boxes, selected, primary, ctlv) {
  const r = rig(boxes, selected, primary, BORDER_SRC);
  r.ctl["fmt-border"].checked = !!ctlv.on;
  r.ctl["fmt-border-color"].value = ctlv.color || "#000000";
  r.ctl["fmt-border-width"].value = String(ctlv.width == null ? 1 : ctlv.width);
  r.ctl["fmt-border-dash"].value = ctlv.dash || "solid";
  return r;
}
{
  const foreign = tb(3, { _foreign: { ft: {} } });
  const boxes = [tb(1), tb(2), foreign];
  const r = borderRig(boxes, [1, 2, 3], 1, { on: true, color: "#ff0000", width: 2, dash: "dot" });
  r.ctl["fmt-border"].fire("change");
  check("B1 Viền on a group: every box gets colour / width / dash", boxes.slice(0, 2).map((x) => [x.borderColor, x.borderWidth, x.borderDash]),
    [["#ff0000", 2, "dot"], ["#ff0000", 2, "dot"]]);
  check("B1b …a partner's FreeText is skipped (it keeps its file's border)", ["borderColor" in foreign, r.undo], [false, ["border:1,2,3"]]);
  const n = r.undo.length;
  r.ctl["fmt-border"].fire("change");
  check("B2 the same border again ⇒ no step", r.undo.length, n);
  boxes[1].borderColor = "#00ff00";
  r.ctl["fmt-border"].fire("change");
  check("B3 only the boxes that DIFFER are rewritten (one already right is left byte-identical)",
    [boxes[1].borderColor, r.undo.length], ["#ff0000", n + 1]);
  r.ctl["fmt-border"].checked = false;
  r.ctl["fmt-border"].fire("change");
  check("B4 off: all three keys DELETED on every box (BI-59)", boxes.slice(0, 2).map((x) => ["borderColor", "borderWidth", "borderDash"].filter((k) => k in x)), [[], []]);
  const fo = borderRig([tb(8, { _foreign: {} })], [8], 8, { on: true });
  fo.ctl["fmt-border"].fire("change");
  check("B5 a group of nothing but partner boxes ⇒ nothing", fo.undo, []);
}

// =============================================================================
// A · Arrange / visibility
// =============================================================================
{
  const boxes = [tb(1), tb(2)];
  const r = rig(boxes, [1, 2], 1, cutFunction("arrangeSelected"), ["arrangeSelected"], {});
  r.arrangeSelected("left");
  check("A1 Arrange (page-relative) refuses a GROUP — it would stack them on one spot", [r.undo, boxes.map((x) => x.x)], [[], [10, 20]]);
  check("A1b …and the panel greys the seven buttons for 2+ boxes",
    /for \(const id of \["fmt-center-h"[\s\S]{0,260}?b\.disabled = tts\.length > 1;/.test(ED), true);
}
{
  // Which palette controls show: the primary's, plus the group-aware ones of the others.
  const VIS_SRC = cut("  // Which palette controls (data-ctl) are relevant per drawing tool.", "  function setTool(tool)");
  function visRig(boxes, selected, primary, tool) {
    const els = ["color", "font", "fontsize", "biu", "textrot", "fill", "penwidth", "dash", "labelsize", "arrowrev", "arrowlabel", "imgpages", "cloudsize", "redact", "measure"]
      .map((c) => ({ dataset: { ctl: c }, hidden: true }));
    const r = rig(boxes, selected, primary, VIS_SRC, ["syncCtlVisibility"], {
      document: { querySelectorAll: () => els },
      clip: null,
      updateFmtPanel: () => {},
    });
    r.syncCtlVisibility(tool || "select");
    return els.filter((e) => !e.hidden).map((e) => e.dataset.ctl).sort();
  }
  const T = tb(1), Tb = tb(2), Bx = { id: 3, kind: "box", x: 0, y: 0, w: 5, h: 5 }, Ar = { id: 4, kind: "arrow", x1: 0, y1: 0, x2: 1, y2: 1 };
  const loneT = visRig([T, Tb, Bx, Ar], [1], 1);
  check("V1 a LONE text box: exactly what it always showed", loneT, ["biu", "color", "fill", "font", "fontsize", "textrot"]);
  check("V2 two text boxes: the same controls", visRig([T, Tb, Bx, Ar], [1, 2], 1), loneT);
  check("V3 primary a RECTANGLE + a text box: the font bar appears (it acts on the text box)",
    visRig([T, Tb, Bx, Ar], [3, 1], 3).includes("fontsize") && visRig([T, Tb, Bx, Ar], [3, 1], 3).includes("penwidth"), true);
  const mixed = visRig([T, Tb, Bx, Ar], [1, 4], 1);
  check("V4 text + ARROW: arrow-reverse / arrow-label (primary-only handlers) do NOT appear for the arrow member", mixed.includes("arrowrev") || mixed.includes("arrowlabel"), false);
  check("V4b …but its group-aware controls do (Nét, Kiểu nét, Cỡ nhãn)", ["penwidth", "dash", "labelsize"].every((c) => mixed.includes(c)), true);
  const arrowPrimary = visRig([T, Tb, Bx, Ar], [4, 1], 4);
  check("V5 the PRIMARY keeps all of its own controls (arrow-reverse stays for a lone-ish arrow primary)", arrowPrimary.includes("arrowrev") && arrowPrimary.includes("arrowlabel"), true);
  check("V6 no selection: nothing", visRig([T], [], null), []);
  check("V7 GROUP_CTLS lists only controls whose handler takes the whole selection",
    /const GROUP_CTLS = new Set\(\["color", "font", "fontsize", "biu", "textrot", "fill", "penwidth", "dash", "labelsize"\]\);/.test(ED), true);
}
{
  // The panel shows for a group whose primary is NOT a text box.
  const UPD_SRC = cutFunction("updateFmtPanel");
  function panelRig(boxes, selected, primary, tool) {
    const panel = fakeEl({ hidden: true });
    let synced = 0;
    const r = rig(boxes, selected, primary, UPD_SRC, ["updateFmtPanel"], {
      $: (id) => (id === "fmt-panel" ? panel : fakeEl()),
      syncFmtPanel: () => synced++,
    });
    r.ed.active = true;
    r.ed.tool = tool || "select";
    r.updateFmtPanel();
    return { hidden: panel.hidden, synced };
  }
  const T = tb(1), Bx = { id: 3, kind: "box" };
  check("V8 panel: shown for a text box", panelRig([T, Bx], [1], 1).hidden, false);
  check("V8b …shown when the primary is a rectangle but the group holds a text box", panelRig([T, Bx], [3, 1], 3).hidden, false);
  check("V8c …hidden for a selection with no text box", panelRig([T, Bx], [3], 3).hidden, true);
  check("V8d …and with the Select tool + nothing selected", panelRig([T, Bx], [], null).hidden, true);
  check("V8e …shown under the Text tool even with nothing selected (as before)", panelRig([T], [], null, "text").hidden, false);
}

// =============================================================================
// S · structure: no handler is left on the primary alone
// =============================================================================
{
  // The retired spellings. Any of them coming back means a handler is acting on ONE box again.
  const gone = [
    ["font size", /pushEdUndo\("fsize:" \+ ed\.sel\)/],
    ["B/I/U", /pushEdUndo\(\);\s*hit\.a\[prop\] = ed\[prop\];/],
    ["font", /pushEdUndo\(\);\s*hit\.a\.font = ed\.font;/],
    ["turn", /pushEdUndo\("trot:" \+ ed\.sel\)/],
    ["applyTextFmt", /pushEdUndo\(\(o\.undoKey \|\| "fmt:" \+ annotKey\) \+ ":" \+ ed\.sel\)/],
    ["wrap", /pushEdUndo\("wrap:" \+ ed\.sel\)/],
    ["width", /pushEdUndo\("boxw:" \+ ed\.sel\)/],
    ["border", /pushEdUndo\("border:" \+ ed\.sel\)/],
    ["clear", /pushEdUndo\("clearfmt:" \+ ed\.sel\)/],
  ];
  for (const [n, re] of gone) check(`S1 ${n} no longer acts on the primary alone`, re.test(ED), false);
  check("S2 syncControls shows a text box of the group when the primary is something else",
    /const tx = a\.kind === "text" \? a : textTargets\(\)\[0\];\s*if \(tx\) \{\s*\$\("ed-fontsize"\)\.value = String\(tx\.fontSize\);/.test(ED), true);
  check("S3 the Format panel is built from textRef / textTargets, not from the primary",
    /const ref = textRef\(\);\s*const tts = textTargets\(\);/.test(ED), true);
  check("S4 the arrange refusal is the first line of arrangeSelected",
    /function arrangeSelected\(kind\) \{\s*if \(ed\.sel == null \|\| textTargets\(\)\.length > 1\) return;/.test(ED), true);
}

console.log(`\ntext-multiedit: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
