"use strict";

// Regression net for cancelling a page render that the user has already scrolled past — R2
// of docs/REVIEW-2026-10-01.
//
// Before: nothing in the renderer ever cancelled. Drag the scrollbar through a big CAD set
// and every page the thumb passed was rasterised in full (1–3 s per A1 sheet), queued in the
// pdf.js worker AHEAD of the page the hand finally stopped on. Measured in Chromium with a
// heavy 30-page A1 file: 35 renders started and 35 finished for one fling.
//
// What must hold now:
//   · a page that leaves the render band while it is being rasterised has its RenderTask
//     cancelled; pdf.js rejects with RenderingCancelledException, which is "asked for", not
//     an error (no console noise), and leaves the page cleanly retryable;
//   · a cancelled page gives its bitmaps back (off-screen one, and any older stale-scale one:
//     a bitmap behind rendered="0" is what freePageCanvas can never release — see R1);
//   · a page that is idle, or whose render already finished, is left alone;
//   · one IntersectionObserver batch can say "in, out, in" about the same page — only the
//     LAST record counts, otherwise the second "in" is refused while the cancelled render is
//     still unwinding and the page stays blank forever;
//   · coming back into the band repaints the page from scratch;
//   · real failures still log.
//
// Like render-race / thumb-refresh this lifts the REAL functions out of the shipped app.js
// and runs them with stubs; pdf.js is replaced by a page whose render() stays pending until
// the test releases it and whose cancel() behaves like pdf.js's (rejects the promise,
// synchronously, unless it already settled).
//
// Run:  node desktop/test/render-cancel.test.js      (or: npm test -- render-cancel)

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
    if (process.env.TRACE) console.error("ok  ", name);
  } else {
    fail++;
    // stderr directly, NOT console.error: several scenarios run with console.error swapped
    // for a collector, and a failure reported through it would never be seen.
    process.stderr.write(`FAIL ${name}\n  expected ${b}\n  actual   ${a}\n`);
  }
}

// A promise that never settles empties the event loop and Node exits 0 - a silent pass.
let finished = false;
process.on("exit", () => {
  if (!finished) {
    // stderr directly: a scenario may have swapped console.error for a collector
    process.stderr.write("FAIL the test exited before finishing: a promise never settled\n");
    process.exitCode = 1;
  }
});

const APP = fs.readFileSync(process.env.RENDER_CANCEL_APP || path.join(__dirname, "..", "renderer", "app.js"), "utf8");
function lift(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in app.js — renamed or removed?`);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  const open = APP.indexOf("{", APP.indexOf(")", at));
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

// ---- the environment the lifted functions close over -------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCALE_COMMIT_MS = 5;
const KEEP_MARGIN_PX = 1500;
let scaleCommitTimer = null;
let scaleCommitting = false;
let scaleCommitPending = false;

let state, log, viewerRect, errors;
const search = { matches: [] };
const window = { RasterCap: { viewRasterDpr: (cw, ch, dpr) => dpr }, Editor: undefined, TextEdit: undefined, FindReplace: undefined };
const pdfjsLib = { AnnotationMode: { ENABLE: 1, DISABLE: 0 } };
let offs = []; // every canvas created through document.createElement = the off-screen ones
const document = { createElement: () => { const c = makeCanvas(); offs.push(c); return c; } };
const $ = (id) => (id === "viewer" ? { getBoundingClientRect: () => viewerRect } : null);
async function addTextLayer(i) { log.layers.push(i); }
async function addNoteMarkers() {}
function drawSearchLayer() {}
function makeCanvas() { return { width: 0, height: 0, style: {}, getContext: () => ({ drawImage() {} }) }; }

const renderPageCanvas = lift("renderPageCanvas");
const freePageCanvas = lift("freePageCanvas");
const pageFarFromViewport = lift("pageFarFromViewport");
const cancelPageRender = lift("cancelPageRender");
const onPageBandChange = lift("onPageBandChange");
const applyScaleToDom = lift("applyScaleToDom");
const commitScale = lift("commitScale");
const scheduleScaleCommit = lift("scheduleScaleCommit");

const cancelled = () => Object.assign(new Error("Rendering cancelled, page"), { name: "RenderingCancelledException" });

/** A pdf.js page: render() is pending until released; cancel() rejects it (a no-op once settled). */
function makePage(i) {
  return {
    renders: [],
    getViewport: ({ scale }) => ({ scale, width: 100 * scale, height: 150 * scale }),
    render({ viewport }) {
      let settled = false;
      let res, rej;
      const promise = new Promise((a, b) => { res = a; rej = b; });
      const rec = {
        scale: viewport.scale,
        settled: () => settled,
        cancelCalls: 0,
        release: () => { if (!settled) { settled = true; res(); } },
        fail: (e) => { if (!settled) { settled = true; rej(e); } },
      };
      this.renders.push(rec);
      log.started.push(i);
      return {
        promise,
        cancel: () => { rec.cancelCalls++; if (!settled) { settled = true; rej(cancelled()); } },
      };
    },
  };
}

function setup({ pages = 3, scale = 1, painted = [] } = {}) {
  clearTimeout(scaleCommitTimer);
  scaleCommitTimer = null;
  scaleCommitting = false;
  scaleCommitPending = false;
  log = { started: [], layers: [] };
  errors = [];
  offs = [];
  viewerRect = { top: 0, bottom: 1000 };
  state = { scale, pageMetas: [] };
  for (let i = 0; i < pages; i++) {
    const page = makePage(i);
    const vp = page.getViewport({ scale });
    const has = painted.includes(i);
    state.pageMetas.push({
      page, vp, cw: Math.floor(vp.width), ch: Math.floor(vp.height), dpr: 1, rendering: false, renderTask: null,
      paintScale: has ? scale : undefined,
      canvas: { ...makeCanvas(), width: has ? Math.floor(vp.width) : 0, height: has ? Math.floor(vp.height) : 0 },
      wrap: { dataset: { rendered: has ? "1" : "0", index: String(i) }, querySelector: () => null, getBoundingClientRect: () => ({ top: 100 + i * 200, bottom: 280 + i * 200 }) },
    });
  }
}

const entry = (i, isIntersecting) => ({ target: { dataset: { index: String(i) } }, isIntersecting });
const lastRender = (i) => state.pageMetas[i].page.renders[state.pageMetas[i].page.renders.length - 1];
const flush = () => sleep(0);
async function withQuietConsole(fn) {
  const orig = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 80));
  try { return await fn(); } finally { console.error = orig; }
}

(async () => {
  // ---- 1. a page leaves the band mid-render → cancelled, cleanly ---------------------------------
  await withQuietConsole(async () => {
    setup({ pages: 1 });
    const m = state.pageMetas[0];
    onPageBandChange([entry(0, true)]);
    await flush();
    check("precondition: rendering, and the task is kept for cancelling", [m.rendering, !!m.renderTask, log.started], [true, true, [0]]);

    onPageBandChange([entry(0, false)]);
    await flush();
    await flush();
    check("the RenderTask was cancelled (once)", lastRender(0).cancelCalls, 1);
    check("…and the page unwound cleanly: not rendering, flag 0, task dropped", [m.rendering, m.wrap.dataset.rendered, m.renderTask], [false, "0", null]);
    check("a cancel is not an error: nothing logged", errors, []);
    check("the abandoned off-screen bitmap was handed back (width/height 0)", [offs.length, offs.every((c) => c.width === 0 && c.height === 0)], [1, true]);
    check("nothing was painted or layered for the abandoned render", [m.paintScale, m.canvas.width, log.layers], [undefined, 0, []]);
  });

  // ---- 2. idle pages and finished renders are left alone ---------------------------------------------
  await withQuietConsole(async () => {
    setup({ pages: 2, painted: [1] });
    onPageBandChange([entry(0, false), entry(1, false)]);
    await flush();
    check("exit for an idle page and for a painted page: nothing cancelled, bitmap kept",
      [state.pageMetas.flatMap((m) => m.page.renders).length, state.pageMetas[1].canvas.width, state.pageMetas[1].wrap.dataset.rendered], [0, 100, "1"]);

    setup({ pages: 1 });
    const m = state.pageMetas[0];
    onPageBandChange([entry(0, true)]);
    await flush();
    lastRender(0).release();
    await flush();
    await flush();
    check("the render finished", [m.rendering, m.wrap.dataset.rendered, m.paintScale, m.canvas.width, m.renderTask], [false, "1", 1, 100, null]);
    onPageBandChange([entry(0, false)]);
    await flush();
    check("exit AFTER it finished: cancel is a no-op, the bitmap stays", [lastRender(0).cancelCalls, m.canvas.width, m.wrap.dataset.rendered], [0, 100, "1"]);
  });

  // ---- 3. coming back repaints it ---------------------------------------------------------------------
  await withQuietConsole(async () => {
    setup({ pages: 1 });
    const m = state.pageMetas[0];
    onPageBandChange([entry(0, true)]);
    await flush();
    onPageBandChange([entry(0, false)]);
    await flush();
    await flush();
    onPageBandChange([entry(0, true)]); // the user scrolled back
    await flush();
    check("back in the band: a new render starts", [log.started, m.rendering], [[0, 0], true]);
    lastRender(0).release();
    await flush();
    await flush();
    check("…and completes: bitmap painted, flagged, layers built", [m.canvas.width, m.wrap.dataset.rendered, m.paintScale, log.layers], [100, "1", 1, [0]]);
    check("still no console noise", errors, []);
  });

  // ---- 4. one batch, several records about the same page: only the last counts ----------------------------
  await withQuietConsole(async () => {
    setup({ pages: 1 });
    const m = state.pageMetas[0];
    onPageBandChange([entry(0, true), entry(0, false), entry(0, true)]);
    await flush();
    check("[in, out, in]: ends IN - exactly one render, not cancelled", [log.started, lastRender(0).cancelCalls, m.rendering], [[0], 0, true]);
    lastRender(0).release();
    await flush();
    await flush();
    check("…and the page is painted (the old sequential handling left it blank)", [m.canvas.width, m.wrap.dataset.rendered], [100, "1"]);

    setup({ pages: 1 });
    onPageBandChange([entry(0, true)]);
    await flush();
    onPageBandChange([entry(0, false), entry(0, true)]);
    await flush();
    check("[out, in] while rendering: stays IN, the render in flight is NOT cancelled", [lastRender(0).cancelCalls, state.pageMetas[0].rendering], [0, true]);

    setup({ pages: 1 });
    onPageBandChange([entry(0, true), entry(0, false)]);
    await flush();
    await flush();
    check("[in, out] in one batch: the page ends OUT, so no render is even started", [log.started, state.pageMetas[0].rendering, state.pageMetas[0].wrap.dataset.rendered], [[], false, "0"]);
  });

  // ---- 5. the fling: every page passes through the band, only the last stays ------------------------------
  await withQuietConsole(async () => {
    setup({ pages: 10 });
    for (let i = 0; i < 10; i++) {
      onPageBandChange([entry(i, true)]); // page i enters…
      if (i > 0) onPageBandChange([entry(i - 1, false)]); // …and the previous one leaves
      await flush();
    }
    await flush();
    const cancelledPages = state.pageMetas.filter((m) => m.page.renders.length && m.page.renders[0].cancelCalls === 1).length;
    check("10 pages flung through: 10 renders started, 9 cancelled", [log.started.length, cancelledPages], [10, 9]);
    lastRender(9).release();
    await flush();
    await flush();
    check("only the page the hand stopped on is painted", state.pageMetas.map((m) => m.canvas.width > 0), [false, false, false, false, false, false, false, false, false, true]);
    check("none of the cancelled pages is stuck 'rendering'", state.pageMetas.some((m) => m.rendering), false);
    check("fling logged nothing", errors, []);
  });

  // ---- 6. real failures still log ------------------------------------------------------------------------------
  await withQuietConsole(async () => {
    setup({ pages: 1, painted: [0] });
    const m = state.pageMetas[0];
    m.wrap.dataset.rendered = "0"; // asked to repaint
    onPageBandChange([entry(0, true)]);
    await flush();
    lastRender(0).fail(new Error("worker crashed"));
    await flush();
    await flush();
    check("a genuine failure is still reported", errors.length, 1);
    check("…and keeps the previous bitmap (stale but present), flag reset, retryable", [m.canvas.width, m.wrap.dataset.rendered, m.rendering], [100, "0", false]);
  });

  // ---- 7. cancelling a re-raster releases the stale bitmap (the R1 leak, via cancellation) -------------------------
  await withQuietConsole(async () => {
    setup({ pages: 1, scale: 1, painted: [0] });
    const m = state.pageMetas[0];
    state.scale = 2;
    applyScaleToDom(); // the page is now a stretched scale-1 bitmap
    const pass = commitScale(); // re-rasterise at 2 …
    await flush();
    check("precondition: the re-raster is in flight", m.rendering, true);
    onPageBandChange([entry(0, false)]); // … and the user flings away
    await pass;
    await flush();
    check("cancelled re-raster: stale bitmap released, flag 0 (no bitmap behind a 0 flag)", [m.canvas.width, m.canvas.height, m.wrap.dataset.rendered], [0, 0, "0"]);
    check("…and no follow-up repaint is requested for a page nobody is looking at", [scaleCommitTimer, log.started.length], [null, 1]);
    freePageCanvas(0);
    check("freePageCanvas on it is a harmless no-op", [m.canvas.width, m.wrap.dataset.rendered], [0, "0"]);
    onPageBandChange([entry(0, true)]);
    await flush();
    lastRender(0).release();
    await flush();
    await flush();
    check("scrolled back: repainted at the CURRENT scale", [m.paintScale, m.canvas.width], [2, 200]);
  });

  // ---- 8. odds and ends ---------------------------------------------------------------------------------------------
  {
    let threw = false;
    try {
      state = { pageMetas: null };
      cancelPageRender(0);
      state = { pageMetas: [] };
      cancelPageRender(5);
      onPageBandChange([]);
    } catch (_) { threw = true; }
    check("cancelPageRender / onPageBandChange tolerate no pages and bad indices", threw, false);

    setup({ pages: 1 });
    state.pageMetas[0].rendering = true; // flagged but the RenderTask is not created yet
    cancelPageRender(0);
    check("a render that has not created its task yet cannot be cancelled (and must not throw)", state.pageMetas[0].rendering, true);
  }

  // ---- 9. the wiring: the observer really is the cancelling handler -------------------------------------------------
  check("renderViewer builds pageObserver with onPageBandChange (an inline closure that only renders would undo R2)",
    /pageObserver = new IntersectionObserver\(onPageBandChange,/.test(APP), true);
  check("the render keeps its task for cancelPageRender", /m\.renderTask = task;/.test(APP) && /await task\.promise;/.test(APP), true);

  finished = true;
  console.log(`\nrender-cancel: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
