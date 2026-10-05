"use strict";

/*
 * Nabu PDF — the left column's MODES (docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md
 * §4.3, Đợt 2). Foxit/Acrobat let the left column show the page thumbnails OR the document's
 * bookmarks OR its comments; until v0.2.77 Nabu's column could only show thumbnails, so a
 * contract's table of contents was invisible here even though the file carried one.
 *
 * WHAT THIS FILE OWNS: the tab strip, the bookmark (outline) pane, and — from Đợt 2b — the
 * annotation list pane. It does NOT own the thumbnails: `#thumbs` keeps its own DOM, observer
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
  const PANES = ["thumbs", "outline"];
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

  const pure = { resolveOutline, destTarget, PANES };
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
    if (name === "outline") ensureOutline();
    // The thumbnail list was display:none — its "current page" highlight may have moved on
    // while hidden, and it could not scroll itself into view then (zero height).
    if (name === "thumbs" && deps && deps.onThumbsShown) deps.onThumbsShown();
  }

  // app.js calls this whenever state.pdf is replaced (renderAll, rerenderChanged). Cheap when
  // the outline pane is not showing: it only marks the cached tree stale.
  function docChanged() {
    ol.pdf = null;
    if (current === "outline") ensureOutline();
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

  window.SidePanels = { init, show, docChanged, current: () => current };
})();
