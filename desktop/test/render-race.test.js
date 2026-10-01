"use strict";

// Regression net for "a zoom that lands while a page is being rasterised" — R1 of
// docs/REVIEW-2026-10-01 (BI-36 coming back by a new road).
//
// The sequence that went wrong:
//   1. renderPageCanvas(i) starts at scale 1 (it captured `vp` BEFORE the await) and holds
//      m.rendering = true while pdf.js works.
//   2. The user zooms to 2. applyScaleToDom stretches the CSS box; 160 ms later commitScale
//      runs, finds the page flagged rendered="1" but at the wrong scale, sets rendered="0"
//      and calls renderPageCanvas(i) - which returns at once because m.rendering is true.
//   3. The render in flight lands: a scale-1 bitmap goes into the canvas and the page is
//      stamped `paintScale = state.scale` = 2 - the scale it is NOT at.
// Result: commitScale thinks the page is crisp (paintScale === scale) and never looks again,
// the page stays blurry until it happens to leave and re-enter the viewport, and because
// rendered === "0" freePageCanvas refuses to release a bitmap that is very much there.
//
// What must hold now:
//   · paintScale is the scale actually rasterised, never the scale at completion;
//   · commitScale leaves a page that is mid-render alone (it must not flip its flag);
//   · when such a render lands stale, one more pass is requested (debounced) and the page
//     ends up crisp at the CURRENT scale with rendered="1", so it can be freed later;
//   · nothing changes for the ordinary cases (no zoom in flight → exactly one render).
//
// Like thumb-refresh / search-index this lifts the REAL functions out of the shipped
// app.js and runs them with stubs, so what is checked is what runs. pdf.js is replaced by
// a page whose render() stays pending until the test releases it - that is the only way
// to hold a render "in flight" deterministically.
//
// Run:  node desktop/test/render-race.test.js      (or: npm test -- render-race)

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
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

const APP = fs.readFileSync(process.env.RENDER_RACE_APP || path.join(__dirname, "..", "renderer", "app.js"), "utf8");
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
const SCALE_COMMIT_MS = 5; // the app uses 160; the logic is the same, the test just waits less
const KEEP_MARGIN_PX = 1500;
let scaleCommitTimer = null;
let scaleCommitting = false;
let scaleCommitPending = false;

let state, log, viewerRect;
const search = { matches: [] };
const window = {
  RasterCap: { viewRasterDpr: (cw, ch, dpr) => dpr },
  Editor: undefined,
  TextEdit: undefined,
  FindReplace: undefined,
};
const pdfjsLib = { AnnotationMode: { ENABLE: 1, DISABLE: 0 } };
const document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
};
const $ = (id) => (id === "viewer" ? { getBoundingClientRect: () => viewerRect } : null);
async function addTextLayer(_i, m) { log.layers.push(m.vp.scale); }
async function addNoteMarkers() {}
function drawSearchLayer() {}

const renderPageCanvas = lift("renderPageCanvas");
const freePageCanvas = lift("freePageCanvas");
const pageFarFromViewport = lift("pageFarFromViewport");
const applyScaleToDom = lift("applyScaleToDom");
const commitScale = lift("commitScale");
const scheduleScaleCommit = lift("scheduleScaleCommit");

/** A pdf.js page whose render() stays pending until `release(n)` is called for that render. */
function makePage(i) {
  const renders = [];
  return {
    renders,
    getViewport: ({ scale }) => ({ scale, width: 100 * scale, height: 150 * scale }),
    render: ({ viewport }) => {
      let release, failWith;
      const promise = new Promise((res, rej) => { release = res; failWith = rej; });
      renders.push({ scale: viewport.scale, release: () => release(), fail: (e) => failWith(e) });
      log.rendersStarted.push({ page: i, scale: viewport.scale });
      return { promise };
    },
  };
}

function setup({ pages = 3, scale = 1, painted = [] } = {}) {
  clearTimeout(scaleCommitTimer);
  scaleCommitTimer = null;
  scaleCommitting = false;
  scaleCommitPending = false;
  log = { rendersStarted: [], layers: [] };
  viewerRect = { top: 0, bottom: 1000 };
  state = { scale, pageMetas: [] };
  for (let i = 0; i < pages; i++) {
    const page = makePage(i);
    const vp = page.getViewport({ scale });
    const wasPainted = painted.includes(i);
    state.pageMetas.push({
      page,
      vp,
      cw: Math.floor(vp.width),
      ch: Math.floor(vp.height),
      dpr: 1,
      rendering: false,
      paintScale: wasPainted ? scale : undefined,
      canvas: {
        width: wasPainted ? Math.floor(vp.width) : 0,
        height: wasPainted ? Math.floor(vp.height) : 0,
        style: {},
        getContext: () => ({ drawImage() {} }),
      },
      wrap: {
        dataset: { rendered: wasPainted ? "1" : "0", index: String(i) },
        querySelector: () => null,
        getBoundingClientRect: () => ({ top: 100 + i * 200, bottom: 280 + i * 200 }),
      },
    });
  }
}

/** Zoom the way the app does: state.scale, then the cheap synchronous half. */
function zoomTo(s) {
  state.scale = s;
  applyScaleToDom();
}

/** Wait until nothing is rendering and no commit is pending/running - bounded, never forever. */
async function settle(releaseAll = true) {
  for (let n = 0; n < 400; n++) {
    if (releaseAll) for (const m of state.pageMetas) for (const r of m.page.renders) r.release(); // idempotent
    const timerPending = !!scaleCommitTimer && scaleCommitTimer._destroyed === false; // the app never nulls it after it fires
    const busy = state.pageMetas.some((m) => m.rendering) || timerPending || scaleCommitting || scaleCommitPending;
    if (!busy) return;
    await sleep(3);
  }
  throw new Error("render/commit never settled");
}
const flush = () => sleep(0);

// A promise that never settles empties the event loop and Node exits 0 - a silent pass. Make
// that a loud failure instead.
let finished = false;
process.on("exit", () => {
  if (!finished) {
    // stderr directly: a scenario may have swapped console.error for a collector
    process.stderr.write("FAIL the test exited before finishing: a promise never settled\n");
    process.exitCode = 1;
  }
});

(async () => {
  // ---- 1. the bug: a zoom lands while the page is mid-render ---------------------------------
  {
    setup({ pages: 1, scale: 1 });
    const m = state.pageMetas[0];
    const first = renderPageCanvas(0); // starts at scale 1 and stays in flight
    await flush();
    check("precondition: the render is in flight at scale 1", [m.rendering, m.page.renders.length, m.page.renders[0].scale], [true, 1, 1]);

    zoomTo(2);
    await commitScale(); // the debounce has fired while pdf.js is still working
    check("commitScale leaves a mid-render page ALONE (does not flip its flag to 0)", m.wrap.dataset.rendered, "1");

    m.page.renders[0].release(); // the scale-1 render lands
    await first;
    check("paintScale is the scale actually rasterised (1), not the scale at completion (2)", m.paintScale, 1);
    check("the bitmap that landed is the scale-1 one", m.canvas.width, 100);

    await settle(); // one more pass was requested; let it run
    check("the page is repainted at the CURRENT scale", [m.paintScale, m.canvas.width, m.canvas.height], [2, 200, 300]);
    check("it was rasterised exactly twice: once at 1, once at 2", log.rendersStarted, [{ page: 0, scale: 1 }, { page: 0, scale: 2 }]);
    check("rendered stays 1 - the page is not left in the 'no bitmap' state", m.wrap.dataset.rendered, "1");

    freePageCanvas(0);
    check("…so it CAN be released later (this is the leak the old code had)", [m.canvas.width, m.canvas.height, m.wrap.dataset.rendered], [0, 0, "0"]);
  }

  // ---- 2. the zoom lands and the render finishes BEFORE commitScale ever runs ----------------
  {
    setup({ pages: 1, scale: 1 });
    const m = state.pageMetas[0];
    const first = renderPageCanvas(0);
    await flush();
    zoomTo(2);
    m.page.renders[0].release(); // lands first; the debounce has not fired yet
    await first;
    check("lands before the debounce: still stamped with the scale it was drawn at", m.paintScale, 1);
    check("…and a commit has been requested", !!scaleCommitTimer, true);
    await settle();
    check("…which repaints it crisp", [m.paintScale, m.canvas.width, log.rendersStarted.length], [2, 200, 2]);
  }

  // ---- 3. two zoom steps during one render: it chases the LATEST scale, once -----------------
  {
    setup({ pages: 1, scale: 1 });
    const m = state.pageMetas[0];
    const first = renderPageCanvas(0);
    await flush();
    zoomTo(2);
    zoomTo(3);
    m.page.renders[0].release();
    await first;
    await settle();
    check("ends crisp at the final scale", [m.paintScale, m.canvas.width], [3, 300]);
    check("two zoom steps cost one extra render, not two", log.rendersStarted.map((r) => r.scale), [1, 3]);
  }

  // ---- 4. no zoom in flight: nothing changes ---------------------------------------------------
  {
    setup({ pages: 1, scale: 1.5 });
    const m = state.pageMetas[0];
    const p = renderPageCanvas(0);
    await flush();
    m.page.renders[0].release();
    await p;
    check("ordinary render: one render, stamped with its own scale", [log.rendersStarted.length, m.paintScale, m.canvas.width], [1, 1.5, 150]);
    check("…and no commit is requested", scaleCommitTimer, null);
    check("…the text layer was built at that same scale", log.layers, [1.5]);
  }

  // ---- 5. the old behaviour for idle pages is unchanged -------------------------------------------
  {
    setup({ pages: 3, scale: 1, painted: [0, 1] }); // 0 and 1 hold bitmaps, 2 does not
    zoomTo(2);
    const pass1 = commitScale(); // awaits each render, so the renders must be released meanwhile
    await settle();
    await pass1;
    check("idle painted pages are repainted at the new scale, once each", log.rendersStarted.map((r) => r.page + "@" + r.scale).sort(), ["0@2", "1@2"]);
    check("an unpainted page is left for the observer (no bitmap made)", [state.pageMetas[2].canvas.width, state.pageMetas[2].wrap.dataset.rendered], [0, "0"]);
    await commitScale();
    check("a page already crisp at the scale is skipped: a second commit renders nothing", log.rendersStarted.length, 2);
  }

  // ---- 6. a stale render that landed far from the viewport is released, not chased ----------------
  {
    setup({ pages: 1, scale: 1 });
    const m = state.pageMetas[0];
    const first = renderPageCanvas(0);
    await flush();
    zoomTo(2);
    m.wrap.getBoundingClientRect = () => ({ top: 9000, bottom: 9180 }); // flung far away meanwhile
    m.page.renders[0].release();
    await first;
    check("far from the viewport when it lands: the bitmap is freed", [m.canvas.width, m.wrap.dataset.rendered], [0, "0"]);
    check("…and no pointless repaint is requested", [scaleCommitTimer, log.rendersStarted.length], [null, 1]);
  }

  // ---- 7. a failing render still leaves the page retryable --------------------------------------------
  {
    setup({ pages: 1, scale: 1 });
    const m = state.pageMetas[0];
    const origErr = console.error;
    console.error = () => {};
    try {
      const p = renderPageCanvas(0);
      await flush();
      zoomTo(2);
      m.page.renders[0].fail(new Error("worker destroyed"));
      await p;
    } finally {
      console.error = origErr;
    }
    check("failed render: flag reset so the observer retries, nothing thrown, no commit loop", [m.rendering, m.wrap.dataset.rendered, scaleCommitTimer], [false, "0", null]);
  }

  finished = true;
  console.log(`\nrender-race: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
