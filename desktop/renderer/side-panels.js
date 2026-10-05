"use strict";

/*
 * Nabu PDF — the left column's MODES (docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md
 * §4.3, Đợt 2). Foxit/Acrobat let the left column show the page thumbnails OR the document's
 * bookmarks OR its comments; until v0.2.77 Nabu's column could only show thumbnails, so a
 * contract's table of contents was invisible here even though the file carried one.
 *
 * WHAT THIS FILE OWNS: the tab strip, the bookmark (outline) pane, and the annotation list
 * pane "Chú thích" (Đợt 2b — it replaced the right-hand "Ghi chú" panel, which listed sticky
 * notes only). It does NOT own the thumbnails: `#thumbs` keeps its own DOM, observer
 * and queue in app.js, untouched. A hidden thumbnail pane is `display:none`, so its
 * IntersectionObserver simply stops firing and the queue idles; nothing here needs to pause it.
 *
 * EXPOSURE (BI-14): one name, `window.SidePanels`. Everything it needs from app.js (state.pdf,
 * the page metas, scrollToPage…) is handed in through `init(deps)` — never read as a bare
 * global, so this file has no load-order trap beyond "before app.js", which calls `init` at
 * load time (rule in test/global-scope.test.js). The pure half — `resolveOutline` — is also
 * `module.exports` for node: test/side-panels.test.js runs it against mock pdf.js documents.
 */
(function () {
  const PANES = ["thumbs", "outline", "annots"];
  const PANE_KEY = "nabu-side-pane";

  // ---- pure: pdf.js outline → a tree with page indices ---------------------------------
  //
  // pdf.js gives each outline item a `dest` that is EITHER a name (look it up with
  // getDestination) OR an explicit array [pageRef, {name: "XYZ"|"Fit"|…}, …args]. The page is
  // a ref to resolve with getPageIndex — or, rarely, a plain integer page index. Any step can
  // throw: a bookmark that points at a page the user has since deleted fails with "Kid
  // reference not found" (measured, Đợt 1 / BI-96). Such an item is KEPT, with page = null, so
  // the tree keeps its shape and the item can say why it does nothing — dropping it would
  // silently renumber what the user sees against what Foxit shows for the same file.
  //
  // `top`/`left` are PDF user-space coordinates of the target point (null = "the page"):
  //   XYZ  [left, top, zoom]       FitH / FitBH  [top]       FitR  [left, bottom, right, top]
  //   Fit / FitB / FitV            → page only
  function destTarget(dest) {
    const kind = dest[1] && dest[1].name;
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
    if (kind === "XYZ") return { left: num(dest[2]), top: num(dest[3]) };
    if (kind === "FitH" || kind === "FitBH") return { left: null, top: num(dest[2]) };
    if (kind === "FitR") return { left: num(dest[2]), top: num(dest[5]) };
    return { left: null, top: null };
  }

  async function resolveItem(pdf, it) {
    const node = {
      title: String((it && it.title) || "").trim(),
      page: null,
      top: null,
      left: null,
      bold: !!(it && it.bold),
      italic: !!(it && it.italic),
      color: null,
      // PDF /Count: negative = the item is closed in the file. pdf.js passes it through as
      // `count` (undefined when absent = open, which is also what Acrobat does).
      open: !(it && typeof it.count === "number" && it.count < 0),
      url: (it && (it.url || it.unsafeUrl)) || null,
      children: [],
    };
    // pdf.js colours are Uint8ClampedArray [r,g,b] 0..255; pure black is the default, not a choice.
    const c = it && it.color;
    if (c && c.length >= 3 && (c[0] || c[1] || c[2])) node.color = `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
    try {
      let dest = it && it.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (Array.isArray(dest) && dest.length) {
        const ref = dest[0];
        const idx = Number.isInteger(ref) ? ref : await pdf.getPageIndex(ref);
        if (Number.isInteger(idx) && idx >= 0 && idx < pdf.numPages) {
          node.page = idx;
          const t = destTarget(dest);
          node.top = t.top;
          node.left = t.left;
        }
      }
    } catch (_) {
      // dangling / malformed destination — node.page stays null (see above)
    }
    const kids = (it && it.items) || [];
    node.children = await Promise.all(kids.map((k) => resolveItem(pdf, k)));
    return node;
  }

  /** pdf.js document → [] (no bookmarks) or a tree of {title, page, top, left, open, children…}. */
  async function resolveOutline(pdf) {
    const raw = await pdf.getOutline();
    if (!raw || !raw.length) return [];
    return Promise.all(raw.map((it) => resolveItem(pdf, it)));
  }

  // ---- pure: what the Chú thích list shows -----------------------------------------------
  //
  // OUTSIDE the editor the list is the FILE: every item annot-scan.js read. INSIDE it, Nabu's
  // own annotations live in the overlay (importManaged lifted them out of the file, and the
  // overlay holds unsaved ones too), so the list is the overlay's live objects PLUS the file's
  // items that are NOT Nabu's (kind == null) — listing the file's Nabu items as well would show
  // every text box twice, and one of the two copies would be stale.
  // `live` items come from Editor.listObjects(): { id, page, kind, text, color, top, replies }.
  function composeItems(fileItems, liveItems, editing) {
    if (!editing) return (fileItems || []).map((it) => ({ ...it, live: false }));
    const foreign = (fileItems || []).filter((it) => !it.kind).map((it) => ({ ...it, live: false }));
    return (liveItems || []).map((it) => ({ ...it, live: true })).concat(foreign);
  }

  // Group by page (ascending) and, within a page, top-to-bottom by `top(item)` — display units
  // from the page's top edge, supplied by the caller (it needs the page's viewport). Stable:
  // equal tops keep their input order (= /Annots order = the order they were drawn).
  function groupByPage(items, top) {
    const pages = new Map();
    items.forEach((it, k) => {
      if (!pages.has(it.page)) pages.set(it.page, []);
      pages.get(it.page).push({ it, k, y: top(it) });
    });
    return [...pages.keys()]
      .sort((a, b) => a - b)
      .map((page) => ({
        page,
        items: pages.get(page).sort((p, q) => p.y - q.y || p.k - q.k).map((e) => e.it),
      }));
  }

  // Filter by the label shown (type) and by author; "" = no filter on that axis.
  function filterItems(items, labelOf, type, author) {
    return items.filter((it) => (!type || labelOf(it) === type) && (!author || it.author === author));
  }

  const pure = { resolveOutline, destTarget, composeItems, groupByPage, filterItems, PANES };
  if (typeof module !== "undefined" && module.exports) module.exports = pure;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  // ---- DOM ---------------------------------------------------------------------------

  const tr = (vi, p) => (window.t ? window.t(vi, p) : vi);
  const $ = (id) => document.getElementById(id);
  let deps = null;
  let current = "thumbs";
  // The outline is read once per pdf.js document. `gen` drops a slow read that a newer
  // document overtook (open file B while file A's outline is still resolving).
  const ol = { pdf: null, gen: 0 };

  function init(d) {
    deps = d;
    for (const btn of document.querySelectorAll(".side-tab[data-pane]")) {
      btn.addEventListener("click", () => show(btn.dataset.pane));
    }
    const ex = $("outline-expand");
    const co = $("outline-collapse");
    if (ex) ex.addEventListener("click", () => setAllOpen(true));
    if (co) co.addEventListener("click", () => setAllOpen(false));
    for (const id of ["annots-ftype", "annots-fauthor"]) {
      const sel = $(id);
      if (sel) sel.addEventListener("change", () => {
        an.filterType = $("annots-ftype").value;
        an.filterAuthor = $("annots-fauthor").value;
        refreshAnnots();
      });
    }
    let saved = null;
    try {
      saved = localStorage.getItem(PANE_KEY);
    } catch (_) {
      /* storage unreadable — start on the thumbnails */
    }
    show(PANES.includes(saved) ? saved : "thumbs", false);
  }

  function show(name, persist) {
    if (!PANES.includes(name)) return;
    current = name;
    for (const p of document.querySelectorAll(".side-pane[data-pane]")) p.hidden = p.dataset.pane !== name;
    for (const b of document.querySelectorAll(".side-tab[data-pane]")) {
      const on = b.dataset.pane === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (persist !== false) {
      try {
        localStorage.setItem(PANE_KEY, name);
      } catch (_) {
        /* the choice just won't be remembered */
      }
    }
    // The toolbar "Ghi chú" button opens this tab (it used to open a right-hand panel), so it
    // lights up exactly when the tab is showing.
    const bc = $("btn-comments");
    if (bc) bc.classList.toggle("active", name === "annots");
    if (name === "outline") ensureOutline();
    if (name === "annots") refreshAnnots();
    // The thumbnail list was display:none — its "current page" highlight may have moved on
    // while hidden, and it could not scroll itself into view then (zero height).
    if (name === "thumbs" && deps && deps.onThumbsShown) deps.onThumbsShown();
  }

  // app.js calls this whenever state.pdf is replaced (renderAll, rerenderChanged). Cheap when
  // the outline pane is not showing: it only marks the cached tree stale. The annotation scan
  // runs regardless of the tab — the toolbar badge counts its result — but in a worker.
  function docChanged() {
    ol.pdf = null;
    if (current === "outline") ensureOutline();
    scheduleScan();
  }

  function outlineMessage(text) {
    const tree = $("outline-tree");
    const empty = $("outline-empty");
    if (tree) tree.innerHTML = "";
    if (empty) {
      empty.textContent = text;
      empty.hidden = false;
    }
  }

  async function ensureOutline() {
    const pdf = deps && deps.getPdf();
    if (!pdf) {
      ol.pdf = null;
      outlineMessage(tr("Chưa có tài liệu."));
      return;
    }
    if (ol.pdf === pdf) return;
    ol.pdf = pdf;
    const gen = ++ol.gen;
    outlineMessage(tr("Đang đọc dấu trang…"));
    let tree;
    try {
      tree = await resolveOutline(pdf);
    } catch (err) {
      if (gen !== ol.gen) return;
      console.error("side-panels: outline read failed", err);
      outlineMessage(tr("Không đọc được dấu trang của tài liệu này."));
      return;
    }
    if (gen !== ol.gen || deps.getPdf() !== pdf) return; // a newer document took over
    if (!tree.length) {
      outlineMessage(tr("Tài liệu này không có dấu trang."));
      return;
    }
    $("outline-empty").hidden = true;
    const root = $("outline-tree");
    root.innerHTML = "";
    for (const n of tree) root.appendChild(outlineNode(n, 1));
  }

  function outlineNode(n, depth) {
    const box = document.createElement("div");
    box.className = "ol-node";
    const row = document.createElement("div");
    row.className = "ol-row";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(depth));
    row.style.paddingLeft = 4 + (depth - 1) * 14 + "px";
    const twisty = document.createElement("button");
    twisty.type = "button";
    twisty.className = "ol-twisty";
    twisty.tabIndex = -1;
    const title = document.createElement("span");
    title.className = "ol-title";
    title.textContent = n.title || tr("(không tên)");
    if (n.bold) title.style.fontWeight = "600";
    if (n.italic) title.style.fontStyle = "italic";
    if (n.color) title.style.color = n.color;
    row.append(twisty, title);
    box.appendChild(row);

    if (n.children.length) {
      const kids = document.createElement("div");
      kids.className = "ol-kids";
      kids.setAttribute("role", "group");
      for (const c of n.children) kids.appendChild(outlineNode(c, depth + 1));
      box.appendChild(kids);
      box.classList.toggle("open", n.open);
      row.setAttribute("aria-expanded", n.open ? "true" : "false");
      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = !box.classList.contains("open");
        box.classList.toggle("open", open);
        row.setAttribute("aria-expanded", open ? "true" : "false");
      });
    } else {
      twisty.classList.add("leaf");
    }

    if (n.page != null) {
      row.title = n.title + " — " + tr("trang {n}", { n: n.page + 1 });
      row.addEventListener("click", () => {
        const prev = document.querySelector("#outline-tree .ol-row.current");
        if (prev) prev.classList.remove("current");
        row.classList.add("current");
        goTo(n.page, n.top);
      });
    } else {
      row.classList.add("dead");
      row.title = n.url
        ? tr("Liên kết ra ngoài: {u}", { u: n.url })
        : tr("Dấu trang này trỏ tới một trang không còn trong tài liệu.");
    }
    return box;
  }

  function setAllOpen(open) {
    for (const box of document.querySelectorAll("#outline-tree .ol-node")) {
      if (!box.querySelector(":scope > .ol-kids")) continue;
      box.classList.toggle("open", open);
      const row = box.querySelector(":scope > .ol-row");
      if (row) row.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }

  // Scroll so PDF point (…, top) of page i sits just under the viewer's top edge. Measured
  // against the page-wrap's LIVE box, as a fraction of a scale-1 viewport (which carries the
  // page's /Rotate and MediaBox origin), so it is right mid-zoom too — the wrap is resized
  // immediately on zoom while the bitmap catches up later (BI-36).
  function goTo(i, top) {
    const m = deps.getPageMeta(i);
    const viewer = deps.viewer();
    if (top == null || !m || !m.page || !m.wrap || !viewer) return deps.scrollToPage(i);
    const vp1 = m.page.getViewport({ scale: 1 });
    const [, vy] = vp1.convertToViewportPoint(0, top);
    const fy = Math.max(0, Math.min(1, vy / vp1.height));
    const wr = m.wrap.getBoundingClientRect();
    const vr = viewer.getBoundingClientRect();
    if (deps.renderPage) deps.renderPage(i); // eager, like scrollToPage
    viewer.scrollTo({ top: viewer.scrollTop + (wr.top - vr.top) + fy * wr.height - 8, behavior: "smooth" });
  }

  // ---- Chú thích: the annotation list ------------------------------------------------------

  // `bytes` is the state.bytes the cached `items` were read from: a different array (every
  // edit makes a new one) means the list is stale and a scan is due. `gen` drops a scan that
  // a newer one overtook.
  const an = { bytes: null, items: null, err: null, gen: 0, scanTimer: null, renderTimer: null, filterType: "", filterAuthor: "" };

  // One long-lived worker running annot-scan.js (see that file for why). If it cannot start
  // or dies loading, every pending and later scan falls back to this thread — slower on a
  // huge file, but a list rather than none.
  let worker = null;
  let workerBroken = false;
  let reqSeq = 0;
  const waiting = new Map();
  const scanHere = (bytes) => window.AnnotScan.scanAnnots(window.PDFLib, bytes);
  function failWorker(why) {
    if (!workerBroken) console.warn("side-panels: annotation worker unavailable, scanning on the UI thread —", why);
    workerBroken = true;
    try {
      if (worker) worker.terminate();
    } catch (_) {
      /* already gone */
    }
    worker = null;
    for (const w of waiting.values()) scanHere(w.bytes).then(w.res, w.rej);
    waiting.clear();
  }
  function scanBytes(bytes) {
    if (!workerBroken) {
      try {
        if (!worker) {
          worker = new Worker("annot-scan.js");
          worker.onmessage = (e) => {
            const m = e.data || {};
            const w = waiting.get(m.id);
            if (!w) return;
            waiting.delete(m.id);
            if (m.ok) w.res(m.items);
            else w.rej(new Error(m.error || "scan failed"));
          };
          worker.onerror = (e) => failWorker((e && e.message) || "worker error");
        }
        return new Promise((res, rej) => {
          const id = ++reqSeq;
          // A COPY goes to the worker (and is transferred, not cloned twice): pdf-lib must
          // never see the live state.bytes, and the copy's buffer is the worker's to keep.
          const copy = bytes.slice();
          waiting.set(id, { res, rej, bytes });
          worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
        });
      } catch (err) {
        failWorker(err && err.message);
      }
    }
    return scanHere(bytes);
  }

  function scheduleScan() {
    clearTimeout(an.scanTimer);
    an.scanTimer = setTimeout(runScan, 200);
  }
  async function runScan() {
    const bytes = deps && deps.getBytes();
    if (!bytes) {
      an.bytes = null;
      an.items = [];
      an.err = null;
      refreshAnnots();
      return;
    }
    if (bytes === an.bytes && an.items) return;
    const gen = ++an.gen;
    an.bytes = bytes;
    an.items = null;
    an.err = null;
    refreshAnnots(); // "Đang đọc chú thích…"
    try {
      const items = await scanBytes(bytes);
      if (gen !== an.gen) return;
      an.items = items;
    } catch (err) {
      if (gen !== an.gen) return;
      console.error("side-panels: annotation scan failed", err);
      an.err = err;
    }
    refreshAnnots();
  }

  // editor.js → window.updateComments → here, after any overlay change (debounced: it fires
  // on every syncOverlays, which includes zoom steps).
  function annotsChanged() {
    clearTimeout(an.renderTimer);
    an.renderTimer = setTimeout(refreshAnnots, 120);
  }

  function editorNow() {
    const ed = deps && deps.editor();
    return ed && ed.active ? ed : null;
  }

  // The list as it should read right now, or null while the file is still being read.
  function currentItems() {
    const bytes = deps && deps.getBytes();
    if (!bytes) return [];
    if (bytes !== an.bytes) {
      scheduleScan(); // a change we were not told about — never show a stale file
      return null;
    }
    if (!an.items) return null;
    const ed = editorNow();
    return composeItems(an.items, ed && ed.listObjects ? ed.listObjects() : [], !!ed);
  }

  function refreshAnnots() {
    const items = currentItems();
    if (deps && deps.setBadge) deps.setBadge(items ? items.length : null);
    if (current === "annots") renderAnnots(items);
  }

  const labelOf = (it) => window.AnnotScan.labelOf(it);

  function fillSelect(sel, values, allLabel, keep) {
    sel.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    sel.appendChild(all);
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v.value;
      o.textContent = v.text;
      sel.appendChild(o);
    }
    sel.value = values.some((v) => v.value === keep) ? keep : "";
    sel.hidden = values.length < 2;
    return sel.value;
  }

  // Display-space top of an item on its page (for top-to-bottom order): live items carry it;
  // file items have a PDF /Rect, converted through the page's scale-1 viewport so a rotated
  // page sorts by what the reader sees.
  function topOf(it) {
    if (it.live) return it.top || 0;
    const m = deps.getPageMeta(it.page);
    if (!m || !m.page) return 0;
    const r = m.page.getViewport({ scale: 1 }).convertToViewportRectangle(it.rect);
    return Math.min(r[1], r[3]);
  }

  function annotsMessage(text) {
    const list = $("annots-list");
    const empty = $("annots-empty");
    if (list) list.innerHTML = "";
    if (empty) {
      empty.textContent = text;
      empty.hidden = !text;
    }
  }

  function renderAnnots(items) {
    const count = $("annots-count");
    const filters = $("annots-filters");
    if (items == null) {
      if (count) count.textContent = "";
      if (filters) filters.hidden = true;
      annotsMessage(an.err ? tr("Không đọc được danh sách chú thích của tài liệu này.") : tr("Đang đọc chú thích…"));
      return;
    }
    if (!deps.getBytes()) {
      if (count) count.textContent = "";
      if (filters) filters.hidden = true;
      annotsMessage(tr("Chưa có tài liệu."));
      return;
    }
    // Filters offer only what this document has; a choice that no longer exists falls back
    // to "all" instead of showing an empty list with no visible reason.
    const types = [...new Set(items.map(labelOf))].sort().map((l) => ({ value: l, text: tr(l) }));
    const authors = [...new Set(items.map((it) => it.author).filter(Boolean))].sort().map((a) => ({ value: a, text: a }));
    an.filterType = fillSelect($("annots-ftype"), types, tr("Mọi loại"), an.filterType);
    an.filterAuthor = fillSelect($("annots-fauthor"), authors, tr("Mọi người"), an.filterAuthor);
    filters.hidden = types.length < 2 && authors.length < 2;
    const shown = filterItems(items, labelOf, an.filterType, an.filterAuthor);
    count.textContent = shown.length === items.length ? `(${items.length})` : `(${shown.length}/${items.length})`;
    if (!items.length) {
      annotsMessage(
        editorNow()
          ? tr("Chưa có chú thích nào. Dùng các công cụ trên thanh Chú thích để thêm.")
          : tr("Tài liệu này chưa có chú thích nào.")
      );
      return;
    }
    annotsMessage("");
    const list = $("annots-list");
    const editing = !!editorNow();
    for (const g of groupByPage(shown, topOf)) {
      const head = document.createElement("div");
      head.className = "an-page-head";
      head.textContent = tr("Trang {n}", { n: g.page + 1 }) + " · " + g.items.length;
      list.appendChild(head);
      for (const it of g.items) list.appendChild(annotRow(it, editing));
    }
  }

  function annotRow(it, editing) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "comment-item";
    const meta = document.createElement("div");
    meta.className = "cmt-meta";
    const dot = document.createElement("span");
    dot.className = "cmt-dot";
    if (it.color) dot.style.background = it.color;
    else dot.classList.add("none");
    const kind = document.createElement("span");
    kind.className = "cmt-kind";
    kind.textContent = tr(labelOf(it));
    meta.append(dot, kind);
    if (it.author) {
      const a = document.createElement("span");
      a.className = "cmt-author";
      a.textContent = it.author;
      meta.appendChild(a);
    }
    if (it.replies) {
      const r = document.createElement("span");
      r.className = "cmt-replies";
      r.textContent = tr("{n} trả lời", { n: it.replies });
      meta.appendChild(r);
    }
    el.appendChild(meta);
    if (it.text) {
      const txt = document.createElement("div");
      txt.className = "cmt-text";
      txt.textContent = it.text;
      el.appendChild(txt);
    }
    const tip = [];
    if (it.date) tip.push(it.date.split("-").reverse().join("/"));
    // In the editor, other software's annotations are shown but not yet editable (Đợt 3).
    if (editing && !it.live) {
      el.classList.add("foreign");
      tip.push(tr("Chú thích từ phần mềm khác — chưa sửa được trong Nabu."));
    }
    if (tip.length) el.title = tip.join(" · ");
    el.addEventListener("click", () => {
      const prev = document.querySelector("#annots-list .comment-item.current");
      if (prev) prev.classList.remove("current");
      el.classList.add("current");
      const ed = editorNow();
      if (it.live && ed && ed.focusObject && ed.focusObject(it.id)) return;
      if (it.live) return deps.scrollToPage(it.page);
      goToRect(it.page, it.rect);
    });
    return el;
  }

  // Scroll a file annotation into view and outline it for a moment. Same live-box arithmetic
  // as goTo(); the flash is a plain absolutely-positioned box in the page-wrap, sized in % so
  // a zoom during its 1.6 s keeps it on target.
  function goToRect(i, rect) {
    const m = deps.getPageMeta(i);
    const viewer = deps.viewer();
    if (!m || !m.page || !m.wrap || !viewer) return deps.scrollToPage(i);
    const vp1 = m.page.getViewport({ scale: 1 });
    const r = vp1.convertToViewportRectangle(rect);
    const fx0 = Math.max(0, Math.min(r[0], r[2]) / vp1.width);
    const fy0 = Math.max(0, Math.min(r[1], r[3]) / vp1.height);
    const fx1 = Math.min(1, Math.max(r[0], r[2]) / vp1.width);
    const fy1 = Math.min(1, Math.max(r[1], r[3]) / vp1.height);
    const wr = m.wrap.getBoundingClientRect();
    const vr = viewer.getBoundingClientRect();
    if (deps.renderPage) deps.renderPage(i);
    // Put the annotation a third of the way down the view; sideways only if it is out of view.
    const top = viewer.scrollTop + (wr.top - vr.top) + fy0 * wr.height - vr.height / 3;
    const x0 = wr.left - vr.left + fx0 * wr.width;
    const x1 = wr.left - vr.left + fx1 * wr.width;
    let left = viewer.scrollLeft;
    if (x0 < 0 || x1 > vr.width) left += x0 - Math.max(16, (vr.width - (x1 - x0)) / 2);
    viewer.scrollTo({ top, left, behavior: "smooth" });
    const old = m.wrap.querySelector(".annot-flash");
    if (old) old.remove();
    const f = document.createElement("div");
    f.className = "annot-flash";
    f.style.left = fx0 * 100 + "%";
    f.style.top = fy0 * 100 + "%";
    f.style.width = Math.max(0, fx1 - fx0) * 100 + "%";
    f.style.height = Math.max(0, fy1 - fy0) * 100 + "%";
    m.wrap.appendChild(f);
    setTimeout(() => f.remove(), 1600);
  }

  window.SidePanels = { init, show, docChanged, annotsChanged, current: () => current };
})();
