"use strict";

/**
 * Nabu PDF — Tạo bản theo mẫu (one drawing set → N copies with one code changed).
 *
 * WHAT IT IS. A department hands over the pile-plan set of tower I1 and needs the same
 * set for I2, I3, I4…: identical pages, identical drawings, only the structure code
 * changed ("DAOL.I1_BD-S-5.001" → "DAOL.I2_BD-S-5.001", "THÁP I1" → "THÁP I2"). By hand
 * that is: duplicate the file, Ctrl+H, Thay tất cả, save as — once per tower. This does
 * the loop, from the document that is open, without touching it.
 *
 * WHY IT IS BUILT ON TÌM & THAY THẾ AND NOT BESIDE IT. Every write goes through the
 * same /edit-text payload find-replace.js builds (`FindReplace.pure.groupEdits`), so the
 * redraw keeps everything that path earned: glyph-only redaction (BI-23), the original
 * font ladder (BI-21), the geometry recovery (BI-25 — including the PDFsharp case this
 * very feature exposed), rotated sheets (BI-66), a clean text layer (BI-102). There is
 * no second write path to keep in step.
 *
 * WHAT IT REFUSES TO DO SILENTLY, because a wrong drawing set is worse than none:
 *   · match a code inside a longer one — "Khớp nguyên mã" (on by default) stops "I1"
 *     from matching in I10 / I11 / PI1 (/text-find `code_boundary`);
 *   · promise "every occurrence" after a scan that hit the 5000-match ceiling;
 *   · write a file it has not re-read: each output is scanned again, and a count that
 *     does not come out exactly as predicted means that file is NOT written;
 *   · overwrite a file that already exists without asking (main's file:write-new-pdf).
 *
 * The open document is never modified: no pushUndo, no state.bytes write (BI-3 does not
 * apply because nothing here moves the bytes). The outputs are built from what is open
 * NOW — unsaved edits included — which is what the user is looking at.
 *
 * Structure follows find-replace.js: a DOM-free pure half `require()`-able from node
 * (desktop/test/batch-variants.test.js), then the DOM half behind a
 * `typeof document` gate. One global, `window.BatchVariants` (+ the lexical
 * `BatchVariantsPure`) — no bare helper names (BI-14).
 */

// ---------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------
const BatchVariantsPure = (function () {
  const isAlnum = (ch) => /[\p{L}\p{N}]/u.test(ch);

  // Same rule as api.py `_find_occurrences(code_boundary=True)`, for the FILE NAME —
  // the only text this module matches itself; the document is matched by the sidecar.
  // Non-overlapping, left to right. `matchCase` false folds both sides only when the
  // fold keeps every length (the same guard api.py applies).
  function findCodes(text, token, opts) {
    const o = opts || {};
    const matchCase = o.matchCase !== false;
    const codeBoundary = o.codeBoundary !== false;
    const s = String(text == null ? "" : text);
    const t = String(token == null ? "" : token);
    if (!t) return [];
    let h = s;
    let n = t;
    if (!matchCase) {
      const hl = s.toLowerCase();
      const nl = t.toLowerCase();
      if (hl.length === s.length && nl.length === t.length) {
        h = hl;
        n = nl;
      }
    }
    const out = [];
    let i = 0;
    for (;;) {
      const j = h.indexOf(n, i);
      if (j < 0) break;
      const k = j + n.length;
      if (codeBoundary) {
        const beforeOk = j === 0 || !(isAlnum(n[0]) && isAlnum(h[j - 1]));
        const afterOk = k >= h.length || !(isAlnum(n[n.length - 1]) && isAlnum(h[k]));
        if (!(beforeOk && afterOk)) {
          i = j + 1;
          continue;
        }
      }
      out.push({ start: j, end: k });
      i = k;
    }
    return out;
  }

  function replaceCodes(text, token, value, opts) {
    const s = String(text == null ? "" : text);
    const occ = findCodes(s, token, opts);
    let out = s;
    for (let x = occ.length - 1; x >= 0; x--) {
      out = out.slice(0, occ[x].start) + value + out.slice(occ[x].end);
    }
    return out;
  }

  // "I2, I3; I4" / one per line / a range "I2..I6" (or "I2..6"). Ranges keep the width
  // of their first number ("P08..P11" → P08 P09 P10 P11) and are capped so a typo like
  // "I2..2000" cannot queue two thousand writes.
  const RANGE_MAX = 200;
  function parseValues(raw, token) {
    const values = [];
    const errors = [];
    const seen = new Set();
    const add = (v) => {
      if (!v || v === token || seen.has(v)) return;
      seen.add(v);
      values.push(v);
    };
    for (const piece of String(raw == null ? "" : raw).split(/[,;\n\r]+/)) {
      const p = piece.trim();
      if (!p) continue;
      const m = /^(.*?)(\d+)\s*\.\.\s*(.*?)(\d+)$/.exec(p);
      if (m && (m[3] === "" || m[3] === m[1])) {
        const a = parseInt(m[2], 10);
        const b = parseInt(m[4], 10);
        if (b < a || b - a + 1 > RANGE_MAX) {
          errors.push(p);
          continue;
        }
        for (let k = a; k <= b; k++) add(m[1] + String(k).padStart(m[2].length, "0"));
        continue;
      }
      add(p);
    }
    return { values, errors };
  }

  // A Windows file name out of anything: reserved characters become "_", trailing
  // dots/spaces go (Explorer cannot open "x." anyway).
  function sanitizeFileName(s) {
    return String(s == null ? "" : s)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .trim();
  }

  // "DAOL.I1.S-HS TKCS (PHAN THAP).pdf" + I1→I2 → "DAOL.I2.S-HS TKCS (PHAN THAP).pdf".
  // The SAME code rule as the document, so the name changes exactly where a code is.
  // A name that does not carry the code gets "_I2" appended instead of silently
  // producing N files with the original's name.
  function variantFileName(name, token, value, opts) {
    const base = String(name || "document.pdf").replace(/\.pdf$/i, "");
    let nb = replaceCodes(base, token, value, opts);
    if (nb === base) nb = base + "_" + value;
    const clean = sanitizeFileName(nb) || sanitizeFileName(value) || "document";
    return clean + ".pdf";
  }

  // Names that would collide on Windows (case-insensitive file system).
  function duplicateNames(names) {
    const seen = new Map();
    const dup = new Set();
    for (const n of names) {
      const k = String(n).toLowerCase();
      if (seen.has(k)) dup.add(n).add(seen.get(k));
      else seen.set(k, n);
    }
    return [...dup];
  }

  // Distinct contexts — the text of the run each match sits in — for the checklist the
  // user ticks. Grouping by the run's text is what makes an odd one stand out: twelve
  // "I1_BD-S-6.00x" and one "PI1" reads at a glance.
  function contexts(hits) {
    const by = new Map();
    for (const h of hits || []) {
      const key = String(h.span_text);
      if (!by.has(key)) by.set(key, { key, count: 0, locked: 0, pages: [] });
      const c = by.get(key);
      c.count++;
      if (!h.replaceable) c.locked++;
      if (!c.pages.includes(h.page + 1)) c.pages.push(h.page + 1);
    }
    return [...by.values()].sort((a, b) => a.pages[0] - b.pages[0] || (a.key < b.key ? -1 : 1));
  }

  // The hits that will actually be rewritten: in a ticked context, and replaceable.
  function selectedHits(hits, offKeys) {
    const off = offKeys || new Set();
    return (hits || []).filter((h) => h.replaceable && !off.has(String(h.span_text)));
  }

  // 1-based pages with no match at all — a page that "should" carry the code and does
  // not is worth a look before N copies are made of it.
  function pagesWithout(hits, numPages) {
    const has = new Set((hits || []).map((h) => h.page));
    const out = [];
    for (let i = 0; i < numPages; i++) if (!has.has(i)) out.push(i + 1);
    return out;
  }

  // "1, 3–7, 9" for a sorted list of page numbers.
  function pageRanges(list) {
    const xs = [...new Set(list || [])].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < xs.length; ) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      out.push(j > i ? `${xs[i]}–${xs[j]}` : String(xs[i]));
      i = j + 1;
    }
    return out.join(", ");
  }

  // What a correct output must read back as, or null for a count that cannot be
  // predicted from counts alone (then that side is not checked — never guessed):
  //   token: every replaced occurrence is gone, the rest stay — unless the new value
  //          itself contains the token (then new ones appear by design);
  //   value: exactly one new occurrence per replacement — unless the token contains
  //          the value (then each old one already counted as a value occurrence).
  function expectedCounts(o) {
    const { token, value, beforeToken, beforeValue, replaced, opts } = o;
    const valueHasToken = findCodes(value, token, opts).length > 0;
    const tokenHasValue = findCodes(token, value, opts).length > 0;
    return {
      token: valueHasToken ? null : beforeToken - replaced,
      value: tokenHasValue ? null : beforeValue + replaced,
    };
  }

  function countsMatch(expected, got) {
    const bad = [];
    if (expected.token != null && got.token !== expected.token) bad.push("token");
    if (expected.value != null && got.value !== expected.value) bad.push("value");
    return bad;
  }

  return {
    findCodes,
    replaceCodes,
    parseValues,
    sanitizeFileName,
    variantFileName,
    duplicateNames,
    contexts,
    selectedHits,
    pagesWithout,
    pageRanges,
    expectedCounts,
    countsMatch,
    RANGE_MAX,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = BatchVariantsPure;

// ---------------------------------------------------------------------------
// DOM half — skipped under node.
// ---------------------------------------------------------------------------
if (typeof document !== "undefined") {
  (function () {
    const P = BatchVariantsPure;
    const $ = (id) => document.getElementById(id);
    const tr = (vi, params) => (window.t ? window.t(vi, params) : vi);

    // Same ceiling find-replace.js holds /edit-text to (base64 JSON, ~200 MB of PDF).
    const MAX_EDIT_B64 = 280000000;

    const bv = {
      hits: [],
      off: new Set(), // context keys the user unticked
      scanned: null, // { token, matchCase, codeBoundary, bytes, truncated } of the last scan
      dir: null,
      busy: false,
      lastWritten: null,
    };

    function opts() {
      return { matchCase: $("bv-case").checked, codeBoundary: $("bv-code").checked };
    }

    function setStatus(msg, kind) {
      const el = $("bv-status");
      el.textContent = msg || "";
      el.className = "bv-status" + (kind ? " " + kind : "");
    }

    function dirOf(p) {
      if (!p) return null;
      const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
      return i > 0 ? p.slice(0, i) : null;
    }

    function canRun() {
      // BI-26: gated in the FUNCTION, not only through the button id.
      if (gateProFeature()) return false;
      if (!state.bytes) {
        toast(tr("Mở PDF trước."), "bad");
        return false;
      }
      if (sidecar.state !== "ready" || !sidecar.base) {
        toast(tr("Engine chưa sẵn sàng."), "bad");
        return false;
      }
      // Unbaked annotations / text edits are not in state.bytes yet — copies made now
      // would silently lack them. Same refusal Tìm & Thay thế makes (BI-2).
      if (window.Editor && window.Editor.active) {
        toast(tr('Thoát "Chú thích" trước khi tạo bản theo mẫu.'), "bad");
        return false;
      }
      if (window.TextEdit && window.TextEdit.active) {
        toast(tr('Thoát "Sửa nội dung" trước khi tạo bản theo mẫu.'), "bad");
        return false;
      }
      return true;
    }

    // ---- scan ---------------------------------------------------------------

    async function find(bytes, query, o, maxHits) {
      const qs =
        "?query=" + encodeURIComponent(query) +
        "&match_case=" + (o.matchCase ? "true" : "false") +
        "&code_boundary=" + (o.codeBoundary ? "true" : "false") +
        "&max_hits=" + (maxHits || 5000);
      const res = await sidecarFetch("/text-find-bin" + qs, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Blob([bytes], { type: "application/pdf" }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (!data || !data.success) {
        let msg = (data && (data.error || data.detail)) || (res.status ? "HTTP " + res.status : tr("không rõ"));
        if (typeof msg !== "string") msg = JSON.stringify(msg);
        throw new Error(msg);
      }
      return data;
    }

    function stale() {
      bv.scanned = null;
      bv.hits = [];
      bv.off = new Set();
      $("bv-contexts").replaceChildren();
      $("bv-run").disabled = true;
      refreshNames();
    }

    async function scan() {
      const token = ($("bv-token").value || "").trim();
      if (!token) {
        setStatus(tr("Nhập mã cần đổi (ví dụ I1)."), "warn");
        return;
      }
      if (!canRun()) return;
      setBusy(true);
      setStatus(tr("Đang quét…"));
      try {
        const o = opts();
        const data = await find(state.bytes, token, o);
        if (!data.has_text) {
          stale();
          setStatus(tr('PDF này không có chữ thật (bản scan) — chạy "OCR văn bản" trong Công cụ trước.'), "bad");
          return;
        }
        bv.hits = data.hits || [];
        bv.off = new Set();
        bv.scanned = { token, ...o, bytes: state.bytes, truncated: !!data.truncated };
        renderContexts();
        refreshSummary();
      } catch (err) {
        stale();
        setStatus(tr("Lỗi tìm: {msg}", { msg: err.message }), "bad");
      } finally {
        setBusy(false);
      }
    }

    function renderContexts() {
      const box = $("bv-contexts");
      box.replaceChildren();
      for (const c of P.contexts(bv.hits)) {
        const row = document.createElement("label");
        row.className = "chk bv-ctx" + (c.locked === c.count ? " locked" : "");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = c.locked < c.count && !bv.off.has(c.key);
        cb.disabled = c.locked === c.count;
        cb.onchange = () => {
          if (cb.checked) bv.off.delete(c.key);
          else bv.off.add(c.key);
          refreshSummary();
        };
        const txt = document.createElement("span");
        txt.className = "bv-ctx-text";
        txt.textContent = c.key;
        const meta = document.createElement("span");
        meta.className = "bv-ctx-meta";
        meta.textContent =
          (c.count > 1 ? `×${c.count} · ` : "") +
          tr("trang {p}", { p: P.pageRanges(c.pages) }) +
          (c.locked ? " · " + tr("không thay được") : "");
        if (c.locked) {
          row.title = tr("Từ khoá bị chia làm nhiều đoạn định dạng — không thay tự động được");
        }
        row.append(cb, txt, meta);
        box.appendChild(row);
      }
    }

    function refreshSummary() {
      if (!bv.scanned) return;
      const total = bv.hits.length;
      const sel = P.selectedHits(bv.hits, bv.off).length;
      const locked = bv.hits.filter((h) => !h.replaceable).length;
      if (!total) {
        setStatus(tr("Không tìm thấy \"{t}\".", { t: bv.scanned.token }), "warn");
        $("bv-run").disabled = true;
        return;
      }
      const pagesHit = new Set(bv.hits.map((h) => h.page)).size;
      const parts = [tr("{n} chỗ trên {p}/{N} trang — sẽ thay {s}.", { n: total, p: pagesHit, N: state.numPages, s: sel })];
      const none = P.pagesWithout(bv.hits, state.numPages);
      if (none.length && none.length < state.numPages) {
        parts.push(tr("Trang không có mã: {list}.", { list: P.pageRanges(none) }));
      }
      if (locked) parts.push(tr("{k} chỗ bị chia định dạng sẽ GIỮ NGUYÊN trong mọi bản.", { k: locked }));
      let kind = locked || none.length ? "warn" : "";
      if (bv.scanned.truncated) {
        parts.push(tr("Quá nhiều kết quả — lượt quét dừng sớm, không tạo bản được. Hãy nhập mã cụ thể hơn."));
        kind = "bad";
      }
      setStatus(parts.join(" "), kind);
      refreshNames();
    }

    // ---- names & folder -----------------------------------------------------

    function plan() {
      const token = ($("bv-token").value || "").trim();
      const { values, errors } = P.parseValues($("bv-values").value, token);
      const o = opts();
      const names = values.map((v) => P.variantFileName(state.name, token, v, o));
      return { token, values, errors, names, dups: P.duplicateNames(names) };
    }

    function refreshNames() {
      const box = $("bv-names");
      box.replaceChildren();
      const pl = plan();
      for (let i = 0; i < pl.values.length; i++) {
        const li = document.createElement("li");
        li.textContent = `${pl.values[i]} → ${pl.names[i]}`;
        if (pl.dups.includes(pl.names[i])) li.className = "bad";
        box.appendChild(li);
      }
      if (pl.errors.length) {
        const li = document.createElement("li");
        li.className = "bad";
        li.textContent = tr("Không hiểu: {v}", { v: pl.errors.join(", ") });
        box.appendChild(li);
      }
      $("bv-dir").value = bv.dir || "";
      const ready =
        !!bv.scanned && !bv.scanned.truncated && P.selectedHits(bv.hits, bv.off).length > 0 &&
        pl.values.length > 0 && !pl.errors.length && !pl.dups.length && !!bv.dir && !bv.busy;
      $("bv-run").disabled = !ready;
    }

    async function pickDir() {
      if (!window.desktop || !window.desktop.chooseDir) return;
      const d = await window.desktop.chooseDir(bv.dir || dirOf(state.path) || undefined);
      if (d) bv.dir = d;
      refreshNames();
    }

    // ---- generate -----------------------------------------------------------

    async function editBytes(bytes, edits) {
      const res = await sidecarFetch("/edit-text?raw=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: pdfJsonBody(bytes, { edits }),
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || ct.includes("json")) {
        let msg = res.statusText || tr("không rõ");
        try {
          const data = await res.json();
          msg = data.error || data.detail || msg;
        } catch (_) {}
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      return new Uint8Array(await res.arrayBuffer());
    }

    async function writeOne(name, bytes) {
      let r = await window.desktop.writeNewPdf(bv.dir, name, bytes, false);
      if (r && r.exists) {
        const ok = await uiConfirm(tr("Đã có file \"{f}\" trong thư mục này. Ghi đè?", { f: name }), {
          title: tr("Tạo bản theo mẫu"),
          okText: tr("Ghi đè"),
          cancelText: tr("Bỏ qua file này"),
        });
        if (!ok) return { skipped: true };
        r = await window.desktop.writeNewPdf(bv.dir, name, bytes, true);
      }
      if (!r || !r.saved) throw new Error((r && r.error) || tr("không ghi được file"));
      return { path: r.path };
    }

    async function run() {
      if (!canRun() || !bv.scanned) return;
      // The bytes the list was scanned on are the ONLY bytes its offsets are true of
      // (BI-50). Any change since — an undo, a rotate — means scan again.
      if (bv.scanned.bytes !== state.bytes) {
        stale();
        setStatus(tr("Tài liệu vừa thay đổi — bấm Quét lại."), "warn");
        return;
      }
      const o = opts();
      if (o.matchCase !== bv.scanned.matchCase || o.codeBoundary !== bv.scanned.codeBoundary ||
          ($("bv-token").value || "").trim() !== bv.scanned.token) {
        stale();
        setStatus(tr("Tuỳ chọn vừa đổi — bấm Quét lại."), "warn");
        return;
      }
      if (Math.ceil(state.bytes.length / 3) * 4 > MAX_EDIT_B64) {
        setStatus(tr("Tài liệu quá lớn để thay tự động — dùng Nén trước."), "bad");
        return;
      }
      const pl = plan();
      const sel = P.selectedHits(bv.hits, bv.off);
      const src = state.bytes;
      const token = bv.scanned.token;
      const ok = await uiConfirm(
        tr("Tạo {n} file mới, mỗi file thay {s} chỗ \"{t}\"? File đang mở không bị sửa.", {
          n: pl.values.length, s: sel.length, t: token,
        }) + "\n\n" + pl.names.join("\n"),
        { title: tr("Tạo bản theo mẫu"), okText: tr("Tạo file"), cancelText: tr("Hủy") }
      );
      if (!ok) return;

      setBusy(true);
      const done = [];
      const failed = [];
      const skipped = [];
      try {
        const beforeToken = bv.hits.length;
        // Every value counted on the ORIGINAL first ("I2" may already be on these
        // pages), all before the first output is scanned: the sidecar caches ONE
        // document's index, so interleaving would re-parse the original every round —
        // tens of seconds each on a several-hundred-page set.
        showOverlay(tr("Đang quét…"));
        const beforeValues = [];
        for (const value of pl.values) beforeValues.push((await find(src, value, o)).hits.length);
        for (let i = 0; i < pl.values.length; i++) {
          const value = pl.values[i];
          const name = pl.names[i];
          showOverlay(tr("Đang tạo {i}/{n}: {f}", { i: i + 1, n: pl.values.length, f: name }));
          try {
            const beforeValue = beforeValues[i];
            const out = await editBytes(src, window.FindReplace.pure.groupEdits(sel, value));
            const exp = P.expectedCounts({ token, value, beforeToken, beforeValue, replaced: sel.length, opts: o });
            const got = {
              token: (await find(out, token, o)).hits.length,
              value: (await find(out, value, o)).hits.length,
            };
            const bad = P.countsMatch(exp, got);
            if (bad.length) {
              failed.push(tr("{f}: kiểm tra lại không khớp (mong {e}, đọc được {g}) — KHÔNG ghi", {
                f: name,
                e: `${token}=${exp.token ?? "?"}, ${value}=${exp.value ?? "?"}`,
                g: `${token}=${got.token}, ${value}=${got.value}`,
              }));
              continue;
            }
            hideOverlay(); // the overwrite question must not sit under the overlay
            const w = await writeOne(name, out);
            if (w.skipped) skipped.push(name);
            else done.push(w.path);
          } catch (err) {
            failed.push(`${name}: ${err.message}`);
          }
        }
      } finally {
        hideOverlay();
        setBusy(false);
      }
      bv.lastWritten = done.length ? done[done.length - 1] : null;
      $("bv-open").hidden = !bv.lastWritten;
      const lines = [tr("Đã tạo {n}/{m} file.", { n: done.length, m: pl.values.length })];
      if (skipped.length) lines.push(tr("Bỏ qua: {list}", { list: skipped.join(", ") }));
      if (failed.length) lines.push(...failed);
      setStatus(lines.join(" "), failed.length ? "bad" : skipped.length ? "warn" : "good");
      toast(lines[0], failed.length ? "bad" : "good");
    }

    // ---- open / close / wiring ----------------------------------------------

    function setBusy(on) {
      bv.busy = !!on;
      // bv-close too: Esc / backdrop / ✕ all CLICK it (dismissModal), and a disabled
      // button ignores the click — so the dialog cannot vanish while files are still
      // being written behind it.
      for (const id of ["bv-scan", "bv-pick", "bv-token", "bv-values", "bv-case", "bv-code", "bv-close"]) {
        const el = $(id);
        if (el) el.disabled = !!on;
      }
      if (on) $("bv-run").disabled = true;
      else refreshNames();
    }

    function open() {
      if (!canRun()) return;
      const m = $("bv-modal");
      // Carry the Tìm & Thay thế query over: it is usually the code the user just found.
      const frq = $("fr-find") && $("fr-find").value.trim();
      if (frq && !$("bv-token").value.trim()) $("bv-token").value = frq;
      if (!bv.dir) bv.dir = dirOf(state.path);
      stale();
      setStatus(tr("Nhập mã cần đổi rồi bấm Quét."));
      $("bv-open").hidden = true;
      m.hidden = false;
      $("bv-token").focus();
    }

    function close() {
      $("bv-modal").hidden = true;
      stale();
    }

    const btn = $("btn-batch-variants");
    if (btn) btn.onclick = open;
    $("bv-close").onclick = close;
    $("bv-scan").onclick = scan;
    $("bv-pick").onclick = pickDir;
    $("bv-run").onclick = run;
    $("bv-open").onclick = () => {
      if (bv.lastWritten && window.desktop && window.desktop.showInFolder) window.desktop.showInFolder(bv.lastWritten);
    };
    // Anything that changes WHAT is matched drops the scan; the value list only
    // changes the names, so it re-plans without a rescan.
    for (const id of ["bv-token", "bv-case", "bv-code"]) {
      $(id).addEventListener(id === "bv-token" ? "input" : "change", () => {
        stale();
        setStatus(tr("Bấm Quét để xem các chỗ sẽ thay."));
      });
    }
    $("bv-values").addEventListener("input", refreshNames);
    $("bv-token").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!bv.busy) scan();
      }
    });

    window.BatchVariants = {
      open,
      close,
      get active() {
        return !$("bv-modal").hidden;
      },
      pure: P,
    };
  })();
}
