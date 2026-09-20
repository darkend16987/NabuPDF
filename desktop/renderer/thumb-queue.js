"use strict";

/**
 * Nabu PDF — the order thumbnails are rasterised in. Pure, no DOM, no pdf.js.
 *
 * WHY THIS IS ITS OWN FILE (same reason as page-range.js and raster-cap.js): the
 * failure mode is silent. A thumbnail costs a FULL page render — measured on an A1
 * CAD sheet, rasterising it at 150 px takes 162 ms, at 600 px 161 ms, at 36 MP
 * 189 ms, because the price is replaying the page's ~77 000 drawing operators, not
 * filling pixels (docs/RESEARCH-2026-09-20b-cad-perf-real-files.md §3.2). renderAll
 * runs renderThumbs BEFORE renderViewer, so eight of those used to run before the
 * page the user is waiting for: first page visible at 1241 ms on a real 10-page A1
 * drawing, 1238 ms on a 22-page one. Gating them behind the viewer's first pages
 * moves that to 299 ms / 254 ms — same work, same end state, different order.
 *
 * Getting that gate subtly wrong does not throw: the sidebar simply stays blank, or
 * (worse) a pump left over from the PREVIOUS document races ahead of the new
 * document's first page and the slowdown quietly comes back. Hence a grid:
 * desktop/test/thumb-queue.test.js.
 *
 * Loaded as a classic <script> (shared global scope, like every renderer file) AND
 * requireable from node. Callers use `window.ThumbQueue`, never a bare name (BI-14).
 */
(function () {
  /**
   * @param {object} deps
   * @param {(i:number)=>Promise<void>} deps.render  rasterise thumbnail `i`
   * @param {()=>Promise<void>} deps.idle            resolve on the next idle slice
   */
  function createThumbQueue(deps) {
    const render = deps.render;
    const idle = deps.idle;
    let queue = [];
    let open = false;
    let pumping = false;

    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        // `open` is re-read EVERY lap on purpose. reset() closes it for a new
        // document, and a pump still in flight for the old one has to notice and
        // stop — otherwise it keeps spending the main thread exactly when the new
        // document's first page needs it, which is the whole bug this file exists
        // to prevent.
        while (open && queue.length) {
          await idle();
          if (!open) break; // closed while we were waiting for the idle slice
          const i = queue.shift();
          if (i === undefined) break;
          try {
            await render(i);
          } catch (_) {
            // One bad page must not wedge the rest of the sidebar.
          }
        }
      } finally {
        pumping = false;
      }
    }

    return {
      /** Ask for thumbnail `i`. Deduplicated; drawn now if the gate is open. */
      queue(i) {
        if (queue.indexOf(i) === -1) queue.push(i);
        pump();
      },
      /** The viewer has its first pages up — the sidebar may have the main thread. */
      open() {
        open = true;
        pump();
      },
      /** New document: drop everything pending and shut the gate again. */
      reset() {
        queue = [];
        open = false;
      },
      // --- inspection, for the grid and for debugging ---
      pending() {
        return queue.slice();
      },
      isOpen() {
        return open;
      },
      isPumping() {
        return pumping;
      },
    };
  }

  const api = { createThumbQueue };
  if (typeof window !== "undefined") window.ThumbQueue = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
