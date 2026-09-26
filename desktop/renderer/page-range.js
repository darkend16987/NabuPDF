"use strict";

/**
 * Nabu PDF — page-range arithmetic (pure, no DOM).
 *
 * Lives in its own file for ONE reason: this is the only new logic where an
 * off-by-one silently destroys user data ("xoá từ trang 5 đến 12, trừ 7" must
 * never take page 7 with it). Keeping it DOM-free makes it testable under plain
 * node — see desktop/test/page-range.test.js — which the rest of the renderer
 * is not (see docs/REGRESSION-GUARD.md §1).
 *
 * Loaded as a classic <script> (shared global scope, like every renderer file)
 * AND requireable from node. Callers use `window.PageRange.*`, never bare names,
 * so a missing file fails loudly at the call site instead of poisoning the
 * shared scope (BI-14).
 *
 * Convention: everything the USER types is 1-based; everything returned is
 * 0-based page indices, matching state.selected.
 */
(function () {
  // Hyphen variants people actually type/paste: ASCII, en dash, em dash, minus.
  const DASH = /[-‐‑‒–—−]/;

  /**
   * Parse "1-3, 5, 8-10" into a Set of 0-based page indices.
   *
   * Mirrors the sidecar's _parse_ranges (src/pdf/util.py) on purpose so the same
   * text means the same pages in "Tách theo khoảng" and here: invalid tokens are
   * skipped, reversed pairs are swapped, out-of-range numbers are clamped into
   * [1, pageCount]. An empty/blank spec yields an empty set.
   */
  function parseSpec(spec, pageCount) {
    const out = new Set();
    const n = Math.max(0, Math.floor(pageCount) || 0);
    if (!n) return out;
    // Strip ALL whitespace before splitting (like the sidecar does) so a typed
    // "1 - 3, 5" is one range and a five, not the three junk tokens you get from
    // splitting on spaces too.
    const flat = String(spec == null ? "" : spec).replace(/\s+/g, "");
    for (const tok of flat.split(/[,;]/)) {
      if (!tok) continue;
      let a;
      let b;
      const at = [...tok].findIndex((c) => DASH.test(c));
      if (at >= 0) {
        // Either side empty ("-3", "3-") is junk, NOT a negative number that
        // would silently clamp to page 1 and delete the wrong page.
        const lo = tok.slice(0, at);
        const hi = tok.slice(at + 1);
        if (!lo || !hi) continue;
        a = Number(lo);
        b = Number(hi);
      } else {
        a = b = Number(tok);
      }
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue; // junk token
      if (a > b) [a, b] = [b, a];
      a = Math.max(1, Math.min(a, n));
      b = Math.max(1, Math.min(b, n));
      for (let p = a; p <= b; p++) out.add(p - 1);
    }
    return out;
  }

  /**
   * "Delete pages `from`..`to` except `exceptSpec`" → { indices, kept, error }.
   *
   * `from`/`to` are 1-based and inclusive (swapped if given backwards, clamped
   * to the document). `indices` is sorted 0-based. `error` is a non-null reason
   * code when the request must be refused:
   *   "empty"   — nothing left to delete after the exceptions
   *   "all"     — it would delete every page (a PDF needs ≥1 page)
   *   "no-doc"  — pageCount < 1
   * Callers translate the code; this file stays language-free.
   */
  function computeRange(from, to, exceptSpec, pageCount) {
    const n = Math.max(0, Math.floor(pageCount) || 0);
    if (!n) return { indices: [], kept: 0, error: "no-doc" };
    let a = Math.floor(Number(from));
    let b = Math.floor(Number(to));
    if (!Number.isFinite(a)) a = 1;
    if (!Number.isFinite(b)) b = n;
    if (a > b) [a, b] = [b, a];
    a = Math.max(1, Math.min(a, n));
    b = Math.max(1, Math.min(b, n));
    const skip = parseSpec(exceptSpec, n);
    const indices = [];
    for (let p = a; p <= b; p++) {
      if (!skip.has(p - 1)) indices.push(p - 1);
    }
    const kept = n - indices.length;
    if (!indices.length) return { indices, kept, error: "empty" };
    if (indices.length >= n) return { indices, kept, error: "all" };
    return { indices, kept, error: null };
  }

  /**
   * Format 0-based indices as a human 1-based summary: [1,3,4,5,9] → "1, 4–6, 10".
   * `max` caps how many groups are spelled out before an ellipsis, so a 900-page
   * selection can't blow up the dialog's layout.
   */
  function formatList(indices, max = 8) {
    const sorted = [...new Set(indices)].sort((x, y) => x - y);
    if (!sorted.length) return "";
    const groups = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i];
      if (i < sorted.length && cur === prev + 1) {
        prev = cur;
        continue;
      }
      groups.push(start === prev ? String(start + 1) : `${start + 1}–${prev + 1}`);
      start = cur;
      prev = cur;
    }
    if (groups.length <= max) return groups.join(", ");
    return groups.slice(0, max).join(", ") + "…";
  }

  /**
   * Suggested filename for "extract these pages into a new PDF".
   *
   * Naming every page ("doc-trang-1_2_3.pdf") is the friendliest form and stays,
   * but it is UNBOUNDED: ~80 selected pages already pushes the name past the
   * 255-character limit Windows puts on a single filename component, and the
   * oversized string goes straight into the Save dialog's defaultPath. So the
   * budget is checked on the FINAL string — `base` is user data of unknown length
   * — and the page part collapses to a summary ("1-200", "1_3-5_9+") when needed.
   *
   * `indices` are 0-based; `max` is the character budget (kept under 255 so a
   * ".pdf" and a bit of headroom always fit).
   */
  function extractFileName(base, indices, max = 200) {
    const order = [...new Set(indices)].sort((x, y) => x - y);
    const safeBase = String(base == null ? "" : base) || "document";
    if (!order.length) return `${safeBase}.pdf`;
    const build = (b, tail) => `${b}-trang-${tail}.pdf`;

    let tail = order.map((i) => i + 1).join("_");
    if (build(safeBase, tail).length > max) {
      // Summary form. formatList caps the number of groups, so this is bounded no
      // matter how scattered the selection is. Its typographic characters are
      // legal in filenames but ugly there, so map them onto the "_" / "-" the
      // explicit form already uses.
      tail = formatList(order, 4)
        .replace(/–/g, "-")
        .replace(/,\s*/g, "_")
        .replace(/…/g, "+");
    }
    let name = build(safeBase, tail);
    if (name.length > max) {
      // Even the summary doesn't fit ⇒ the base name itself is oversized. Order
      // matters: the page part is collapsed above FIRST (the cheaper cut), and only
      // the BASE is trimmed here. The page numbers are what make the extracted file
      // identifiable, so they are the last thing to go; a shortened base is still
      // recognisable.
      const overhead = name.length - safeBase.length;
      name = build(safeBase.slice(0, Math.max(1, max - overhead)), tail);
    }
    return name;
  }

  /**
   * Which pages a page-level command acts on: just the page the user grabbed, or
   * the whole ticked set when that page is one of them.
   *
   * This is the convention the thumbnail right-click menu has always used (act on
   * one page outside the selection, keep the selection intact inside it — the same
   * rule Explorer and Acrobat use), lifted out here because the cross-document
   * page move needs the identical answer and getting it wrong means moving pages
   * the user never pointed at.
   *
   * `index` is 0-based; `ticked` is state.selected (a Set) or any array of
   * indices. Returns a sorted, de-duplicated 0-based array — never empty for a
   * valid index, so a caller can act on it without a second guard.
   */
  function actionSet(index, ticked) {
    const i = Math.floor(Number(index));
    if (!Number.isInteger(i) || i < 0) return [];
    const set = ticked instanceof Set ? ticked : new Set(Array.isArray(ticked) ? ticked : []);
    if (!set.has(i)) return [i];
    const out = [...set].filter((k) => Number.isInteger(k) && k >= 0).sort((a, b) => a - b);
    // A Set that holds `i` cannot filter down to nothing, but a caller passing a
    // hand-built array of junk plus `i` could — fall back to the grabbed page
    // rather than returning "act on no pages" for a perfectly valid grab.
    return out.length ? out : [i];
  }

  /**
   * The selection as ONE unbroken run of pages → { start, count }, or null when it is
   * empty or has a gap.
   *
   * "Thay trang" is only offered on a contiguous run (docs/RESEARCH-2026-09-26-…§1):
   * replacing pages 2 and 5 with three source pages has no single obvious meaning —
   * all at 2? split 1+2? — and a guess that lands pages in the wrong place of a
   * contract is exactly the silent data loss this file exists to prevent. Duplicates
   * and non-integers are ignored, so a Set, an array or state.selected all work.
   */
  function contiguousRun(indices) {
    const src = indices instanceof Set ? [...indices] : Array.isArray(indices) ? indices : [];
    const sorted = [...new Set(src.filter((k) => Number.isInteger(k) && k >= 0))].sort((a, b) => a - b);
    if (!sorted.length) return null;
    for (let k = 1; k < sorted.length; k++) if (sorted[k] !== sorted[k - 1] + 1) return null;
    return { start: sorted[0], count: sorted.length };
  }

  /**
   * Plan "replace the selected pages with pages of another PDF" (PDF24's Replace).
   *
   *   targetSel    — the pages being replaced (0-based; Set or array), must be contiguous
   *   targetCount  — pages in the document being edited
   *   srcSpec      — null/"" = ALL source pages, otherwise a user range ("1-3, 5")
   *   srcCount     — pages in the source PDF
   *
   * → { start, remove, take, error:null }  where the edit is: remove `remove` pages at
   *   `start`, then insert source pages `take` (0-based, ascending, de-duplicated) at
   *   `start`. Or { error } with a language-free code the caller translates:
   *   "no-doc" · "no-src" · "gap" (selection not contiguous / empty / out of range) ·
   *   "empty" (the spec named no source page).
   *
   * Ascending order is deliberate — "5, 2" means pages 2 and 5 in their own order,
   * same as every other range box in the app (parseSpec returns a set, not a list).
   */
  function replacePlan(targetSel, targetCount, srcSpec, srcCount) {
    const n = Math.max(0, Math.floor(targetCount) || 0);
    const m = Math.max(0, Math.floor(srcCount) || 0);
    if (!n) return { error: "no-doc" };
    if (!m) return { error: "no-src" };
    const run = contiguousRun(targetSel);
    if (!run || run.start + run.count > n) return { error: "gap" };
    const all = srcSpec == null || String(srcSpec).trim() === "";
    const take = all
      ? [...Array(m).keys()]
      : [...parseSpec(srcSpec, m)].sort((a, b) => a - b);
    if (!take.length) return { error: "empty" };
    return { start: run.start, remove: run.count, take, error: null };
  }

  /**
   * Carry out a replacePlan on pdf-lib documents: `doc` is edited in place, `src` is
   * only read. Resolves to the number of pages inserted.
   *
   * Lives here, not in app.js, so the grid runs it against REAL pdf-lib documents —
   * the order of the three steps is the whole correctness argument and it is
   * invisible to a reader of the call site:
   *   1. copyPages FIRST, while nothing has moved (and before any removal, so a
   *      same-document source — never offered by the UI, but cheap to be right
   *      about — still sees its original pages);
   *   2. INSERT before removing, at start + k in order — so replacing EVERY page of
   *      the document never passes through an empty page tree (a state pdf-lib is
   *      not built to be in); the old run is now shifted to start + inserted;
   *   3. remove that shifted run high → low, so each removal leaves the indices
   *      still to go intact (deletePages' rule).
   * The file touches no pdf-lib import of its own — it only calls methods on the
   * documents it is handed — so it stays DOM-free and dependency-free.
   */
  async function replaceInDoc(doc, src, plan) {
    if (!plan || plan.error) throw new Error("replaceInDoc: invalid plan");
    const pages = await doc.copyPages(src, plan.take);
    pages.forEach((p, k) => doc.insertPage(plan.start + k, p));
    const from = plan.start + pages.length;
    for (let k = from + plan.remove - 1; k >= from; k--) doc.removePage(k);
    return pages.length;
  }

  const api = { parseSpec, computeRange, formatList, extractFileName, actionSet, contiguousRun, replacePlan, replaceInDoc };
  if (typeof window !== "undefined") window.PageRange = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
