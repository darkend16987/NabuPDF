"use strict";

/**
 * Nabu PDF — renderer (Phase 6: native text editing).
 *
 * Unlike the P4 overlay editor (which draws *on top* of the page), this edits the
 * page's real text: it asks the sidecar for the text spans on the current page,
 * shows a clickable box over each one, and on "Áp dụng" sends the edits back. The
 * backend physically removes the old glyphs (redaction) and redraws the new text
 * in place — so the original text is gone, not merely covered.
 *
 * Only works on PDFs that carry a real text layer (exported from Word/Excel/…),
 * not scans/flattened images — those report has_text:false and we tell the user
 * to use OCR/Searchable instead.
 *
 * Coordinates: span boxes come back in PDF-point space, top-left origin, which is
 * exactly the pdf.js scale-1 viewport space — so on screen they're just `* scale`
 * (same convention as editor.js). Shares app.js globals (classic-script scope):
 * state, $, toast, showOverlay/hideOverlay, renderAll, updateToolbar, scrollToPage,
 * sidecarFetch, sidecar — plus pdfJsonBody from wire.js (same shared scope).
 */

(function () {
  const te = {
    active: false,
    page: -1, // page index being edited
    spans: [], // [{ id, text, bbox, size, font, color, flags }]
    edits: {}, // spanId -> { page, bbox, new_text, size, color, bold, italic, underline, bg, font }
    meta: null, // /text-spans response (width/height/rotation)
    editing: null, // span id currently open in a textarea (null = none)
    lastSpanId: null, // last span clicked (target for toolbar control changes)
    _ta: null, // the open <textarea> element (for the OCR-this-box button)
    _sp: null, // the span object currently open
    _dragged: false, // the last press on a span box was a drag → swallow its click
  };

  // ---- formatting controls (text colour / bg / font / size / B I U) --------

  function packedToHex(c) {
    const n = typeof c === "number" ? c : 0;
    return "#" + (((n >> 16) & 255) << 16 | ((n >> 8) & 255) << 8 | (n & 255)).toString(16).padStart(6, "0");
  }
  // PyMuPDF span flags: bit1 (2)=italic, bit4 (16)=bold.
  function flagsBold(f) {
    return !!(f & 16);
  }
  function flagsItalic(f) {
    return !!(f & 2);
  }
  function setFmtBtn(id, on) {
    const b = $(id);
    if (b) b.classList.toggle("active", !!on);
  }
  // Push a span's (or its pending edit's) style into the toolbar controls.
  function syncControls(sp) {
    const ed = te.edits[sp.id];
    $("te-font").value = ed ? ed.font || "__keep__" : "__keep__";
    $("te-size").value = String(ed ? ed.size : Math.round(sp.size * 10) / 10);
    $("te-color").value = ed ? ed.color : packedToHex(sp.color);
    $("te-bg-on").checked = ed ? !!ed.bg : false;
    if (ed && ed.bg) $("te-bg").value = ed.bg;
    setFmtBtn("te-bold", ed ? ed.bold : flagsBold(sp.flags));
    setFmtBtn("te-italic", ed ? ed.italic : flagsItalic(sp.flags));
    setFmtBtn("te-underline", ed ? ed.underline : false);
  }
  // Read the current toolbar control values into a style object.
  function readControls() {
    return {
      font: $("te-font").value || "__keep__",
      size: Math.max(4, parseFloat($("te-size").value) || 11),
      color: $("te-color").value || "#000000",
      bg: $("te-bg-on").checked ? $("te-bg").value : null,
      bold: $("te-bold").classList.contains("active"),
      italic: $("te-italic").classList.contains("active"),
      underline: $("te-underline").classList.contains("active"),
    };
  }

  // The span a toolbar control change should affect: the one being edited, else
  // the last one clicked.
  function targetSpanId() {
    return te.editing != null ? te.editing : te.lastSpanId;
  }
  // The edit a span starts from: its own text and style, unchanged.
  function seedEdit(sp) {
    return {
      page: te.page,
      bbox: sp.bbox,
      origin: sp.origin,
      new_text: sp.text,
      size: Math.round(sp.size * 10) / 10,
      color: packedToHex(sp.color),
      bg: null,
      bold: flagsBold(sp.flags),
      italic: flagsItalic(sp.flags),
      underline: false,
      font: "__keep__", // keep the span's original font unless changed
    };
  }
  // Ensure a staged edit exists for a span (seeded from its current text/style).
  function ensureEdit(spId) {
    const sp = te.spans.find((s) => s.id === spId);
    if (!sp) return null;
    if (!te.edits[spId]) te.edits[spId] = seedEdit(sp);
    return te.edits[spId];
  }

  // ---- di chuyển chữ (v0.2.73) -----------------------------------------------
  //
  // A staged edit may carry `offset: [dx, dy]` — points, in the DISPLAYED space the
  // boxes are drawn in (bbox_view). The sidecar keeps the redaction on the original
  // bbox and redraws at origin + offset, converting for /Rotate itself (api.py
  // _view_offset_to_page). Absent = in place, which is every edit before this existed.
  //
  // Screen px, not points, for both thresholds: they are about the hand, not the page,
  // and must feel the same at 25% and 400%.
  const DRAG_START_PX = 4; // below this a press is a click → open the editor
  const SNAP_HOME_PX = 5; // dropped this close to where it was → "not moved"

  function offsetOf(id) {
    const ed = te.edits[id];
    return ed && ed.offset ? ed.offset : [0, 0];
  }
  function isMoved(off) {
    return !!off && (Math.abs(off[0]) > 0.01 || Math.abs(off[1]) > 0.01);
  }
  // Is `ed` nothing but the span as it already is (ignoring any offset)? Compared
  // against seedEdit field by field, so dragging a span home again drops an edit that
  // only the move created — instead of leaving one that redraws the text in place for
  // no reason (a redraw can substitute the font; a no-op must not risk that).
  function isPristine(sp, ed) {
    const seed = seedEdit(sp);
    return ["new_text", "size", "color", "bg", "bold", "italic", "underline", "font"].every(
      (k) => ed[k] === seed[k]
    );
  }

  // Press on a span box. A press that does not travel DRAG_START_PX stays a click and
  // the box's click handler opens the editor exactly as before; one that does becomes
  // a drag. Listens on WINDOW and re-finds the box by id on every move, because
  // committing an open editor (its blur) rebuilds every box — the element pressed may
  // no longer be in the DOM a few pixels later. Moves only the one element's left/top
  // while dragging; the full rebuild happens once, on release.
  function startDrag(e, sp) {
    if (e.button !== 0) return;
    te._dragged = false; // a fresh gesture — never let a stale flag eat this click
    const s = state.scale;
    const [x0, y0, x1, y1] = sp.bbox_view || sp.bbox;
    const base = offsetOf(sp.id).slice();
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    let cur = base;

    const boxEl = () => document.querySelector(`#viewer .tedit-layer .span-box[data-id="${sp.id}"]`);
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("span-dragging");
    };
    const onMove = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        // Garbled legacy-font text: moving it would redraw the garbage in a readable
        // face. The click path OCRs it first — make the user go through that.
        if (sp.suspect && !te.edits[sp.id]) {
          cleanup();
          toast("Chữ lỗi font — bấm vào ô để OCR lấy lại chữ đúng rồi mới di chuyển.", "bad");
          return;
        }
        dragging = true;
        const open = document.querySelector(".span-input");
        if (open) open.blur(); // stage whatever was being typed first
        const sel = window.getSelection && window.getSelection();
        if (sel) sel.removeAllRanges();
        document.body.classList.add("span-dragging");
      }
      ev.preventDefault();
      const layer = layerForPage(te.page);
      const W = layer ? layer.clientWidth / s : Infinity;
      const H = layer ? layer.clientHeight / s : Infinity;
      // Keep the whole box on the page: text dropped past the edge would be written
      // into the file where nobody can see or select it again.
      let ox = Math.max(-x0, Math.min(base[0] + dx / s, W - x1));
      let oy = Math.max(-y0, Math.min(base[1] + dy / s, H - y1));
      if (Math.hypot(ox, oy) * s < SNAP_HOME_PX) ox = oy = 0;
      cur = [ox, oy];
      const el = boxEl();
      if (el) {
        el.classList.add("dragging");
        el.style.left = (x0 + ox) * s + "px";
        el.style.top = (y0 + oy) * s + "px";
      }
    };
    const onUp = () => {
      cleanup();
      if (!dragging) return;
      te._dragged = true; // the click that may follow this release is not a click
      commitMove(sp, cur);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function commitMove(sp, off) {
    if (isMoved(off)) {
      const ed = ensureEdit(sp.id);
      if (ed) ed.offset = [off[0], off[1]];
    } else if (te.edits[sp.id]) {
      delete te.edits[sp.id].offset;
      if (isPristine(sp, te.edits[sp.id])) delete te.edits[sp.id];
    }
    te.lastSpanId = sp.id;
    renderBoxes();
    updateHint();
  }

  // Rough CSS family for the preview. The real redraw resolves fonts on the sidecar;
  // this only has to look like the same KIND of letter while the box is in flight.
  function previewFamily(sp, ed) {
    const f = String(ed.font === "__keep__" ? sp.font || "" : ed.font).toLowerCase();
    if (/times|tiro|serif|roman|cambria|georgia/.test(f)) return '"Times New Roman", serif';
    if (/cour|mono|consol/.test(f)) return '"Courier New", monospace';
    return 'Arial, "Segoe UI", sans-serif';
  }
  // A toolbar formatting control changed → apply it to the target span's edit.
  function onControlChange() {
    const id = targetSpanId();
    if (id == null) return;
    const ed = ensureEdit(id);
    if (!ed) return;
    const st = readControls();
    const open = document.querySelector(".span-input");
    if (open) ed.new_text = open.value; // don't lose in-progress typing
    ed.size = st.size;
    ed.color = st.color;
    ed.bg = st.bg;
    ed.bold = st.bold;
    ed.italic = st.italic;
    ed.underline = st.underline;
    ed.font = st.font;
    renderBoxes();
    updateHint();
  }

  // ---- page + layer helpers ------------------------------------------------

  // The page whose centre is closest to the viewer's vertical centre.
  function currentPageIndex() {
    const wraps = [...document.querySelectorAll("#viewer .page-wrap")];
    if (!wraps.length) return state.selected.size ? Math.min(...state.selected) : 0;
    const vr = $("viewer").getBoundingClientRect();
    const mid = vr.top + vr.height / 2;
    let best = 0;
    let bestDist = Infinity;
    for (const w of wraps) {
      const r = w.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestDist) {
        bestDist = d;
        best = +w.dataset.index;
      }
    }
    return best;
  }

  function layerForPage(i) {
    const wrap = document.querySelector(`#viewer .page-wrap[data-index="${i}"]`);
    if (!wrap) return null;
    let layer = wrap.querySelector(".tedit-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "tedit-layer";
      wrap.appendChild(layer);
    }
    const canvas = wrap.querySelector("canvas");
    if (canvas) {
      layer.style.width = (parseFloat(canvas.style.width) || canvas.width) + "px";
      layer.style.height = (parseFloat(canvas.style.height) || canvas.height) + "px";
    }
    return layer;
  }

  function clearLayers() {
    document.querySelectorAll("#viewer .tedit-layer").forEach((l) => l.remove());
  }

  // ---- rendering -----------------------------------------------------------

  function renderBoxes() {
    clearLayers();
    const layer = layerForPage(te.page);
    if (!layer) return;
    layer.innerHTML = "";
    const s = state.scale;
    for (const sp of te.spans) {
      // bbox_view is the box in DISPLAYED (rotation-applied) space — the same space
      // as the pdf.js canvas — so rotated CAD/Revit pages line up. Falls back to the
      // raw bbox for older sidecars that don't send it.
      const [x0, y0, x1, y1] = sp.bbox_view || sp.bbox;
      const ed = te.edits[sp.id];
      const off = offsetOf(sp.id);
      const moved = isMoved(off);
      const bw = Math.max(4, x1 - x0) * s;
      const bh = Math.max(6, y1 - y0) * s;
      // Where it WAS: the canvas still paints the original glyphs there until Áp dụng,
      // so mark the spot as "goes away" rather than leave two copies looking equal.
      if (moved) {
        const ghost = document.createElement("div");
        ghost.className = "span-ghost";
        ghost.style.left = x0 * s + "px";
        ghost.style.top = y0 * s + "px";
        ghost.style.width = bw + "px";
        ghost.style.height = bh + "px";
        layer.appendChild(ghost);
      }
      const box = document.createElement("div");
      // `suspect` = legacy/broken font whose text get_text mis-decoded; clicking it
      // auto-OCRs the region to recover the real Vietnamese.
      box.className =
        "span-box" + (ed ? " edited" : sp.suspect ? " suspect" : "") + (moved ? " moved" : "");
      box.style.left = (x0 + off[0]) * s + "px";
      box.style.top = (y0 + off[1]) * s + "px";
      box.style.width = bw + "px";
      box.style.height = bh + "px";
      box.title = sp.suspect
        ? "Chữ lỗi font — bấm để tự OCR lấy lại chữ đúng"
        : "Bấm để sửa · kéo để di chuyển: " + sp.text;
      box.dataset.id = String(sp.id);
      // Preview of what Áp dụng will write at the new place — plain DOM text, one node
      // per MOVED span only, so it costs nothing on a page of hundreds of spans. Skipped
      // for text that runs vertically on screen (a box taller than wide holding more
      // than one character): a horizontal preview there would be more wrong than none.
      if (moved && ed && ed.new_text && ed.new_text.trim()) {
        const vertical = y1 - y0 > (x1 - x0) * 1.2 && ed.new_text.trim().length > 1;
        if (!vertical) {
          const pv = document.createElement("span");
          pv.className = "span-preview";
          pv.textContent = ed.new_text;
          pv.style.fontSize = Math.max(4, ed.size * s) + "px";
          pv.style.lineHeight = bh + "px";
          pv.style.color = ed.color;
          pv.style.fontFamily = previewFamily(sp, ed);
          if (ed.bold) pv.style.fontWeight = "700";
          if (ed.italic) pv.style.fontStyle = "italic";
          if (ed.underline) pv.style.textDecoration = "underline";
          if (ed.bg) pv.style.background = ed.bg;
          box.appendChild(pv);
        }
      }
      box.addEventListener("pointerdown", (e) => startDrag(e, sp));
      box.addEventListener("click", () => {
        if (te._dragged) {
          te._dragged = false;
          return;
        }
        beginEdit(sp, box);
      });
      layer.appendChild(box);
    }
  }

  // Extra px of typing room the span editor gets beyond the span it replaces.
  // Screen px, NOT document points, so it stays a constant amount of room at any
  // zoom instead of shrinking away when zoomed out.
  const SPAN_INPUT_SLACK = 48;

  function beginEdit(sp, box) {
    const layer = box.parentElement;
    if (!layer) return;
    // Commit any other open editor first.
    layer.querySelectorAll(".span-input").forEach((t) => t.blur());

    te.editing = sp.id;
    te.lastSpanId = sp.id;
    syncControls(sp); // reflect this span's style in the toolbar controls

    const ta = document.createElement("textarea");
    ta.className = "span-input";
    ta.rows = 2; // a plain textarea is 2 rows already, but say so — see minWidth below
    ta.value = te.edits[sp.id] ? te.edits[sp.id].new_text : sp.text;
    ta.style.left = box.style.left;
    ta.style.top = box.style.top;
    // Floor the box at the span's own width PLUS room to grow: sized to exactly the
    // span, retyping a longer line scrolls sideways inside a box the width of the
    // original, which is where the "ô sửa chữ quá bé" complaint comes from. Only a
    // FLOOR — `resize: both` still applies, and the width has no bearing on the
    // result: what gets written is `ta.value`, and the redraw geometry comes from
    // the span's own bbox on the server side (BI-25), never from this element.
    ta.style.minWidth = `calc(${box.style.width} + ${SPAN_INPUT_SLACK}px)`;
    ta.style.fontSize = Math.max(9, sp.size * state.scale * 0.92) + "px";
    layer.appendChild(ta);
    ta.focus();
    ta.select();

    // Track the open editor so the "OCR ô này" button can target it.
    te._ta = ta;
    te._sp = sp;
    $("te-ocr").disabled = false;
    // Suspect spans (legacy/broken font) carry garbled text — recover via OCR the
    // moment the box is opened, so the user sees the real Vietnamese to edit.
    if (sp.suspect && !te.edits[sp.id]) ocrSpan(sp, ta);

    let done = false;
    // Stage the edit into te.edits. Keeps it if text OR style changed from the
    // original span; otherwise drops it. Returns whether an edit is now staged.
    const stage = () => {
      const val = ta.value;
      const st = readControls();
      // A move staged earlier survives retyping/restyling the same span.
      const off = offsetOf(sp.id);
      const moved = isMoved(off);
      const styleChanged =
        st.bold !== flagsBold(sp.flags) ||
        st.italic !== flagsItalic(sp.flags) ||
        st.underline ||
        st.bg ||
        st.font !== "__keep__" ||
        Math.abs(st.size - sp.size) > 0.01 ||
        st.color.toLowerCase() !== packedToHex(sp.color).toLowerCase();
      if (val !== sp.text || styleChanged || moved) {
        te.edits[sp.id] = {
          page: te.page,
          bbox: sp.bbox,
          origin: sp.origin,
          new_text: val,
          size: st.size,
          color: st.color,
          bg: st.bg,
          bold: st.bold,
          italic: st.italic,
          underline: st.underline,
          font: st.font,
        };
        if (moved) te.edits[sp.id].offset = [off[0], off[1]];
        return true;
      }
      delete te.edits[sp.id];
      return false;
    };
    const clearOpen = () => {
      te.editing = null;
      te._ta = null;
      te._sp = null;
      $("te-ocr").disabled = true;
    };
    const commit = () => {
      if (done) return;
      done = true;
      ta.remove();
      clearOpen();
      stage();
      renderBoxes();
      updateHint();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ta.remove();
      clearOpen();
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Enter = stage this edit AND write it to the PDF immediately.
        e.preventDefault();
        done = true;
        ta.removeEventListener("blur", commit);
        ta.remove();
        te.editing = null;
        stage();
        renderBoxes();
        updateHint();
        apply();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ta.blur(); // stage only (Áp dụng later)
      } else if (e.key === "Escape") {
        e.preventDefault();
        ta.removeEventListener("blur", commit);
        cancel();
      }
    });
  }

  // #te-hint is a COUNTER, not advice. The instruction tails it used to carry
  // ("— bấm Áp dụng để ghi vào PDF." / "Bấm vào đoạn để sửa.") moved to
  // Trợ giúp → Hướng dẫn sử dụng, same as the annotate bar's hints. The numbers stay:
  // how many spans this page offers, and how many are staged, is state nothing else
  // reports — and #te-apply's enabled/disabled below is the "there is something to
  // write" cue the removed sentence was duplicating.
  function updateHint() {
    const n = Object.keys(te.edits).length;
    const hint = $("te-hint");
    if (hint) {
      hint.textContent = n
        ? `${n} đoạn đã sửa`
        : `${te.spans.length} đoạn chữ trên trang ${te.page + 1}`;
    }
    const apply = $("te-apply");
    if (apply) apply.disabled = n === 0;
  }

  // ---- lifecycle -----------------------------------------------------------

  // Guarded exit: staged edits prompt "ghi hay bỏ" instead of vanishing.
  async function confirmExit() {
    const n = Object.keys(te.edits).length;
    if (n && (await window.uiConfirm(`Còn ${n} đoạn đã sửa chưa ghi vào PDF. Ghi trước khi thoát?\n(OK = ghi, Cancel = bỏ các sửa đổi)`, { okText: "Ghi", cancelText: "Bỏ sửa đổi" }))) {
      apply(); // apply() exits by itself on success
      return;
    }
    exit();
  }

  async function enter() {
    if (te.active) return confirmExit();
    if (!state.bytes) {
      toast("Mở PDF trước.", "bad");
      return;
    }
    if (sidecar.state !== "ready" || !sidecar.base) {
      toast("Engine chưa sẵn sàng.", "bad");
      return;
    }
    const page = currentPageIndex();
    showOverlay("Đang đọc chữ trên trang…");
    let data;
    try {
      const res = await sidecarFetch("/text-spans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pdfJsonBody(state.bytes, { page }),
      });
      data = await res.json();
    } catch (e) {
      hideOverlay();
      toast("Lỗi đọc chữ: " + e.message, "bad");
      return;
    }
    hideOverlay();
    if (!data.success) {
      toast("Đọc chữ lỗi: " + (data.error || data.detail || "không rõ"), "bad");
      return;
    }
    if (!data.has_text) {
      toast("Trang này là ảnh scan — không có chữ để sửa. Hãy dùng Searchable hoặc Bóc tách.", "bad");
      return;
    }

    te.active = true;
    te.page = page;
    te.spans = data.spans || [];
    te.meta = data;
    te.edits = {};
    $("tedit-bar").hidden = false;
    document.body.classList.add("text-editing");
    $("btn-text-edit").classList.add("active");
    // (Rotated pages are handled: overlay uses bbox_view in displayed space and the
    // redraw uses the unrotated bbox/origin, so no position warning is needed.)
    updateToolbar();
    scrollToPage(page);
    renderBoxes();
    updateHint();
    loadSystemFonts(); // fill the font picker with installed families (once)
  }

  // Recover a span's real text by OCR-ing its pixels (for legacy .Vn / broken-font
  // text get_text mis-decodes). Fills the open textarea with the result. Runs
  // automatically when a suspect box is opened, and on demand via the "OCR ô này"
  // button. Sends the UNROTATED bbox — the sidecar handles page rotation.
  async function ocrSpan(sp, ta) {
    if (!ta || typeof sidecar === "undefined" || sidecar.state !== "ready" || !sidecar.base) {
      toast("Engine OCR chưa sẵn sàng.", "bad");
      return;
    }
    const prev = ta.value;
    // readOnly (not disabled) keeps focus — disabling would blur the textarea and
    // its blur handler would commit+remove it mid-request.
    ta.value = "⏳ đang OCR…";
    ta.readOnly = true;
    $("te-ocr").disabled = true;
    let data = null;
    let err = null;
    try {
      const res = await sidecarFetch("/ocr-span", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pdfJsonBody(state.bytes, { page: te.page, bbox: sp.bbox }),
      });
      data = await res.json();
    } catch (e) {
      err = e;
    }
    // The editor may have been closed (blur/commit) while OCR was running — bail if
    // this textarea is no longer the open one.
    if (te._ta !== ta) return;
    ta.readOnly = false;
    $("te-ocr").disabled = false;
    if (err) {
      ta.value = prev;
      toast("Lỗi OCR: " + err.message, "bad");
    } else if (data && data.success && data.text) {
      ta.value = data.text;
      toast("Đã OCR lại chữ — kiểm tra rồi Áp dụng.", "good");
    } else {
      ta.value = prev;
      toast("OCR không đọc được chữ ở ô này.", "");
    }
    ta.focus();
  }

  // Populate the "Font máy" optgroup from the sidecar's /fonts list. Runs once;
  // silently no-ops if the engine isn't ready or the call fails (built-in choices
  // still work). Each option's value is the family name sent straight to /edit-text.
  let fontsLoaded = false;
  async function loadSystemFonts() {
    if (fontsLoaded) return;
    const grp = $("te-font-system");
    if (!grp || sidecar.state !== "ready" || !sidecar.base) return;
    try {
      const res = await sidecarFetch("/fonts", { method: "GET" });
      const data = await res.json();
      if (!data.success || !Array.isArray(data.families)) return;
      const frag = document.createDocumentFragment();
      for (const name of data.families) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name;
        frag.appendChild(o);
      }
      grp.appendChild(frag);
      fontsLoaded = true;
    } catch (_) {
      /* keep built-in font choices */
    }
  }

  async function apply() {
    // Resolve the font choice per edit: "__keep__" → the span's original font name
    // (the backend cleans/looks it up); every other value passes through unchanged.
    const edits = Object.keys(te.edits).map((id) => {
      const ed = { ...te.edits[id] };
      const sp = te.spans.find((s) => String(s.id) === id);
      if (ed.font === "__keep__") ed.font = (sp && sp.font) || "default";
      // The span as it stands on the page. The backend measures these to reproduce
      // the geometry the document drew it at: without them a replacement in a
      // substituted face comes out both too long (collides with the next span) and
      // too tall (visibly out of step with the untouched lines around it).
      if (sp) {
        ed.orig_text = sp.text;
        ed.orig_size = sp.size;
        // Which way this run is written, in the same UNROTATED space as `bbox`. The
        // sidecar draws in that space and ignores /Rotate, so without this every
        // redraw on a rotated CAD sheet comes out turned 90° — and page rotation
        // alone cannot say it, because one sheet carries upright text AND vertical
        // labels (BI-66). Absent (older sidecar) → null → left-to-right, as before.
        ed.dir = sp.dir || null;
      }
      return ed;
    });
    if (!edits.length) {
      toast("Chưa sửa đoạn nào.", "");
      return;
    }
    showOverlay("Đang ghi thay đổi vào PDF…");
    try {
      // ?raw=1: on success the sidecar returns the PDF bytes directly
      // (Content-Type application/pdf), so we read them with arrayBuffer() and
      // skip the base64 decode that OOM'd the renderer on large files. On failure
      // it returns JSON with an error message.
      const res = await sidecarFetch("/edit-text?raw=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pdfJsonBody(state.bytes, { edits }),
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || ct.includes("json")) {
        let msg = res.statusText || "không rõ";
        try {
          const data = await res.json();
          msg = data.error || data.detail || msg;
        } catch (_) {}
        toast("Sửa lỗi: " + msg, "bad");
        return;
      }
      const buf = await res.arrayBuffer();
      if (window.DocHistory) window.DocHistory.pushUndo();
      state.bytes = new Uint8Array(buf);
      const n = edits.length;
      await exit(new Set([te.page])); // only the edited page changed — repaint just it
      toast(`Đã ghi ${n} sửa đổi vào PDF.`, "good");
    } catch (e) {
      toast("Lỗi sửa: " + e.message, "bad");
    } finally {
      hideOverlay();
    }
  }

  // Leave edit mode and redraw cleanly (drops the box layer; shows latest bytes).
  // `changed` (a Set of page indices) is passed only by the apply path, where the
  // bytes were rewritten — then we repaint just those pages. A plain toggle-off
  // leaves the bytes untouched, so dropping the box layer is all that's needed.
  async function exit(changed) {
    te.active = false;
    te.spans = [];
    te.edits = {};
    te.page = -1;
    te.meta = null;
    te.editing = null;
    te.lastSpanId = null;
    const bar = $("tedit-bar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("text-editing");
    const btn = $("btn-text-edit");
    if (btn) btn.classList.remove("active");
    updateToolbar();
    clearLayers();
    if (changed && state.bytes) await rerenderChanged(changed);
  }

  // Re-place boxes after a re-render (e.g. zoom). No-op when inactive.
  function syncOverlays() {
    if (!te.active) {
      clearLayers();
      return;
    }
    renderBoxes();
  }

  function reset() {
    te.active = false;
    te.page = -1;
    te.spans = [];
    te.edits = {};
    te.meta = null;
    te.editing = null;
    te.lastSpanId = null;
    te._ta = null;
    te._sp = null;
    const bar = $("tedit-bar");
    if (bar) bar.hidden = true;
    const ocrBtn = $("te-ocr");
    if (ocrBtn) ocrBtn.disabled = true;
    document.body.classList.remove("text-editing");
    const btn = $("btn-text-edit");
    if (btn) btn.classList.remove("active");
    clearLayers();
  }

  // ---- wiring --------------------------------------------------------------

  $("btn-text-edit").onclick = enter;
  $("te-apply").onclick = apply;
  // Exiting with staged (un-applied) edits used to drop them silently — ask first.
  $("te-exit").onclick = confirmExit;

  // "OCR ô này": re-recognise the currently-open span. preventDefault on mousedown
  // so clicking the button doesn't blur (and thereby commit/close) the textarea.
  {
    const ob = $("te-ocr");
    if (ob) {
      ob.addEventListener("mousedown", (e) => e.preventDefault());
      ob.addEventListener("click", () => {
        if (te._sp && te._ta) ocrSpan(te._sp, te._ta);
      });
    }
  }

  // Format toggle buttons: preventDefault on mousedown so the open span textarea
  // keeps focus (clicking a button would otherwise blur+commit it).
  ["te-bold", "te-italic", "te-underline"].forEach((id) => {
    const b = $(id);
    if (!b) return;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      b.classList.toggle("active");
      onControlChange();
    });
  });
  // Selects / colour / size inputs: apply on change (these legitimately take focus).
  ["te-font", "te-size", "te-color", "te-bg", "te-bg-on"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("change", onControlChange);
  });

  // ---- public surface (consumed by app.js) ---------------------------------

  window.TextEdit = {
    get active() {
      return te.active;
    },
    syncOverlays,
    reset,
  };
})();
