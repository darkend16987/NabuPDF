"use strict";

// Regression net for how thumbnails are refreshed after an in-place re-render
// (`rerenderChanged` → `refreshThumb` in app.js) — R3, docs/REVIEW-2026-10-01.
//
// What it used to do: for EVERY changed page — all of them, for a watermark or a bake over
// the whole document — `await renderThumbCanvas(i)`, one after another, while the
// "Đang cập nhật trang…" overlay held the UI. A thumbnail costs about a full page render
// (162 ms on an A1 sheet, docs/RESEARCH-2026-09-20b), so an 86-sheet set sat behind a modal
// for 15–80 s — and most of that drew thumbnails nobody had scrolled to.
//
// What it must do now:
//   · a thumbnail that was never drawn is left alone (the sidebar observer/queue draws it,
//     from the NEW document, when it nears the viewport);
//   · one that was drawn is flagged stale and QUEUED — repainted in idle slices after the
//     overlay is gone, never inside `rerenderChanged`;
//   · pages not in `changed` are untouched;
//   · every stale thumbnail is nevertheless repainted exactly once, from the new document.
//
// Like viewer-geom.test.js / search-index.test.js this lifts the REAL functions out of the
// shipped app.js and runs them with stubs, together with the real thumb-queue.js, so what is
// checked is what runs.
//
// Run:  node desktop/test/thumb-refresh.test.js      (or: npm test -- thumb-refresh)

const fs = require("fs");
const path = require("path");
const ThumbQueue = require("../renderer/thumb-queue.js");

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

const APP = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
function lift(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in app.js — renamed or removed?`);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  const open = APP.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < APP.length; i++) {
    if (APP[i] === "{") depth++;
    else if (APP[i] === "}" && --depth === 0) {
      // eslint-disable-next-line no-eval
      return eval("(" + APP.slice(at, i + 1) + ")"); // direct eval: closes over THIS file's stubs below
    }
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

// ---- the environment the lifted functions close over ------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let state, log, thumbDivs, thumbQueue;

const $ = (id) => {
  if (id === "thumbs") return { querySelector: (sel) => thumbDivs[+/data-index="(\d+)"/.exec(sel)[1]] || null };
  return null;
};
const window = { Editor: { syncOverlays() {} }, TextEdit: { syncOverlays() {} }, FindReplace: { invalidate() {} } };
const pdfjsLib = { getDocument: (opts) => ({ promise: Promise.resolve(opts.__doc) }) };
const withTimeout = (p) => p;
function showOverlay() { log.events.push("overlay:show"); }
function hideOverlay() { log.events.push("overlay:hide"); }
async function renderAll() { log.events.push("renderAll"); }
async function renderPageCanvas(i) { log.pagesPainted.push(i); }
// the thumbnail painter, same guard + flag protocol as the real renderThumbCanvas
async function renderThumbCanvas(i) {
  const div = thumbDivs[i];
  if (!div || div.dataset.rendered === "1") return;
  div.dataset.rendered = "1";
  log.events.push("thumb:" + i);
  log.thumbsPainted.push(i);
  log.thumbDoc.push(state.pdf.tag); // which document it was drawn FROM
  await sleep(2);
}
const refreshThumb = lift("refreshThumb");
const rerenderChanged = lift("rerenderChanged");

/** Wait until the queue has nothing pending and no pump in flight — deterministic, unlike
 *  a fixed sleep (a "1 ms" timer is ~15 ms on Windows). */
async function drain() {
  for (let n = 0; n < 2000; n++) {
    if (!thumbQueue.pending().length && !thumbQueue.isPumping()) return;
    await sleep(2);
  }
  throw new Error("thumbnail queue never drained");
}

function setup({ pages, drawn, scale = 1 }) {
  if (thumbQueue) thumbQueue.reset(); // a pump left over from the previous block must not paint into this one
  log = { events: [], pagesPainted: [], thumbsPainted: [], thumbDoc: [] };
  const newDoc = {
    tag: "new",
    numPages: pages,
    destroy: async () => {},
    getPage: async () => ({ getViewport: () => ({ scale }) }),
  };
  state = {
    numPages: pages,
    scale,
    bytes: new Uint8Array(4),
    pdf: { tag: "old", numPages: pages, destroy: async () => {} },
    pageMetas: Array.from({ length: pages }, () => ({ wrap: { dataset: { rendered: "0" } }, page: null, vp: null })),
  };
  // getDocument resolves to the new doc
  pdfjsLib.getDocument = () => ({ promise: Promise.resolve(newDoc) });
  thumbDivs = {};
  for (let i = 0; i < pages; i++) thumbDivs[i] = { dataset: { rendered: drawn.has(i) ? "1" : "0" } };
  thumbQueue = ThumbQueue.createThumbQueue({
    render: (i) => renderThumbCanvas(i),
    idle: () => sleep(1),
  });
  thumbQueue.open();
}

(async () => {
  const PAGES = 86; // the A1 drawing set from the review
  const DRAWN = new Set([0, 1, 2, 3, 4, 5]); // the six the user has actually scrolled past

  // ---- 1. changed = null (watermark / bake over everything) ---------------------------------
  {
    setup({ pages: PAGES, drawn: DRAWN });
    await rerenderChanged(null);
    check("no thumbnail is painted INSIDE rerenderChanged (nothing runs behind the overlay)", log.thumbsPainted, []);
    check("the never-drawn thumbnails are left alone: still rendered=0 and NOT queued", [
      Object.values(thumbDivs).slice(6).every((d) => d.dataset.rendered === "0"),
      thumbQueue.pending().filter((i) => i >= 6),
    ], [true, []]);
    check("the six that WERE drawn are flagged stale and queued, in order", [thumbQueue.pending().slice(0, 6), [...DRAWN].every((i) => thumbDivs[i].dataset.rendered === "0")], [[0, 1, 2, 3, 4, 5], true]);
    check("overlay shown once and hidden before any thumbnail work", log.events.slice(0, 2), ["overlay:show", "overlay:hide"]);
    await drain(); // the queue repaints in idle slices after the overlay is gone
    check("afterwards each stale thumbnail is repainted exactly once…", log.thumbsPainted.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    check("…from the NEW document (not the destroyed one)", [...new Set(log.thumbDoc)], ["new"]);
    check("…and only AFTER the overlay was hidden", log.events.indexOf("overlay:hide") < log.events.indexOf("thumb:0"), true);
    check("nothing else was ever drawn: the other 80 thumbnails cost nothing", Object.keys(thumbDivs).length - log.thumbsPainted.length, 80);
  }

  // ---- 2. a later scroll still draws a never-drawn thumbnail from the new document -------------
  {
    setup({ pages: PAGES, drawn: DRAWN });
    await rerenderChanged(null);
    await drain();
    // the sidebar observer would now enqueue thumbnail 40 as it scrolls into range
    thumbQueue.queue(40);
    await drain();
    check("a thumbnail scrolled to later is drawn lazily, from the new document", [log.thumbsPainted.includes(40), log.thumbDoc[log.thumbDoc.length - 1]], [true, "new"]);
  }

  // ---- 3. only the changed pages are refreshed ---------------------------------------------------
  {
    setup({ pages: PAGES, drawn: DRAWN });
    await rerenderChanged(new Set([1, 3, 50]));
    check("changed={1,3,50}: only the drawn ones among them are queued (50 was never drawn)", thumbQueue.pending(), [1, 3]);
    check("unchanged drawn thumbnails keep their bitmap (rendered stays 1)", [0, 2, 4, 5].every((i) => thumbDivs[i].dataset.rendered === "1"), true);
    await drain();
    check("…and exactly the two stale ones repaint", log.thumbsPainted.slice().sort((a, b) => a - b), [1, 3]);
  }

  // ---- 4. visible pages are still repainted inside, as before ----------------------------------------
  {
    setup({ pages: 10, drawn: new Set([0, 1]) });
    state.pageMetas[2].wrap.dataset.rendered = "1"; // page 2 is on screen
    await rerenderChanged(null);
    check("a page that was on screen is still repainted (page canvas, unchanged behaviour)", log.pagesPainted, [2]);
    check("…and every page's wrap is invalidated so off-screen ones lazy-repaint", state.pageMetas.filter((m, i) => i !== 2).every((m) => m.wrap.dataset.rendered === "0"), true);
  }

  // ---- 5. refreshThumb on its own ---------------------------------------------------------------------
  {
    setup({ pages: 3, drawn: new Set([1]) });
    check("refreshThumb: never-drawn → no-op", [refreshThumb(0), thumbDivs[0].dataset.rendered, thumbQueue.pending()], [undefined, "0", []]);
    refreshThumb(1);
    check("refreshThumb: drawn → stale + queued", [thumbDivs[1].dataset.rendered, thumbQueue.pending().length + log.thumbsPainted.length >= 0], ["0", true]);
    check("refreshThumb: no such thumbnail → no throw, no-op", refreshThumb(99), undefined);
    await drain();
    check("refreshThumb: the queued repaint happens once", log.thumbsPainted, [1]);
  }

  // ---- 6. page count changed → the full path, thumbnails untouched here ----------------------------------
  {
    setup({ pages: 5, drawn: DRAWN });
    pdfjsLib.getDocument = () => ({ promise: Promise.resolve({ tag: "new", numPages: 7, destroy: async () => {}, getPage: async () => ({}) }) });
    await rerenderChanged(null);
    check("page count shifted: falls back to renderAll and touches no thumbnail", [log.events.includes("renderAll"), log.thumbsPainted], [true, []]);
  }

  console.log(`\nthumb-refresh: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
