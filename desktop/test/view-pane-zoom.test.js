"use strict";

// Regression net for the read-only split-view pane (renderer/view.js) when the user zooms
// while a page is still being rasterised — R9 of docs/REVIEW-2026-10-01, the same shape as
// R1 in the main viewer.
//
// renderPage(i) captures the page's viewport before its await. zoomTo replaces m.vp with a
// new object, frees every bitmap and asks for repaints — but renderPage refuses while
// m.rendering, so the render already in flight is the only one. It lands carrying pixels for
// the OLD scale, is attached to the page and stored in m.canvas, and m.canvas is exactly the
// guard that makes renderPage (and the next zoomTo's repaint) believe the page is done. The
// page stays soft until the next zoom. Measured in Chromium with two back-to-back zoom steps
// (what a Ctrl+wheel burst sends): bitmap 604 px in a 756 px box, still there 9 s later.
//
// What must hold now:
//   · a render that lands after the viewport was replaced is DROPPED (bitmap released, not
//     attached, m.canvas stays empty) and the page is repainted at the current scale;
//   · that repaint only happens for a page near the viewport and for the same document;
//   · nothing changes for the ordinary cases (one render, attached, no repaint).
//
// The functions are lifted out of the shipped view.js (they live inside its IIFE) and run
// with stubs; pdf.js is replaced by a page whose render() stays pending until released.
//
// Run:  node desktop/test/view-pane-zoom.test.js      (or: npm test -- view-pane-zoom)

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
    if (process.env.TRACE) process.stderr.write("ok   " + name + "\n");
  } else {
    fail++;
    process.stderr.write(`FAIL ${name}\n  expected ${b}\n  actual   ${a}\n`);
  }
}

// A promise that never settles empties the event loop and Node exits 0 - a silent pass.
let finished = false;
process.on("exit", () => {
  if (!finished) {
    process.stderr.write("FAIL the test exited before finishing: a promise never settled\n");
    process.exitCode = 1;
  }
});

const SRC = fs.readFileSync(process.env.VIEW_JS || path.join(__dirname, "..", "renderer", "view.js"), "utf8");
function lift(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in view.js — renamed or removed?`);
  if (SRC.slice(at - 6, at) === "async ") at -= 6;
  const open = SRC.indexOf("{", SRC.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) {
      // eslint-disable-next-line no-eval
      return eval("(" + SRC.slice(at, i + 1) + ")"); // direct eval: closes over THIS file's stubs below
    }
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

// ---- the environment the lifted functions close over -------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const RENDER_MARGIN_PX = 400;
let st, log, bodyRect, offs;
const window = { RasterCap: { viewRasterDpr: (cw, ch, dpr) => dpr }, devicePixelRatio: 1 };
const pdfjsLib = { AnnotationMode: { ENABLE: 1 } };
const document = { createElement: () => { const c = { width: 0, height: 0, getContext: () => ({}), remove() {} }; offs.push(c); return c; } };
const bodyEl = { getBoundingClientRect: () => bodyRect, scrollLeft: 0, scrollTop: 0 };
const $ = (id) => (id === "vw-body" ? bodyEl : null);
function syncZoomInput() {}
function syncPageInput() {}

const renderPage = lift("renderPage");
const freeCanvas = lift("freeCanvas");
const nearViewport = lift("nearViewport");
const zoomTo = lift("zoomTo");

function makePage(i) {
  return {
    renders: [],
    getViewport: ({ scale }) => ({ scale, width: 100 * scale, height: 150 * scale }),
    render({ viewport }) {
      let res, rej, settled = false;
      const promise = new Promise((a, b) => { res = a; rej = b; });
      this.renders.push({ scale: viewport.scale, release: () => { if (!settled) { settled = true; res(); } }, fail: (e) => { if (!settled) { settled = true; rej(e); } } });
      log.started.push(i + "@" + viewport.scale);
      return { promise };
    },
  };
}

function setup({ pages = 1, scale = 1 } = {}) {
  log = { started: [] };
  offs = [];
  bodyRect = { top: 0, bottom: 1000 };
  bodyEl.scrollLeft = 0;
  bodyEl.scrollTop = 0;
  st = { scale, token: 1, metas: [] };
  for (let i = 0; i < pages; i++) {
    const page = makePage(i);
    const wrapEl = {
      dataset: { index: String(i) },
      style: {},
      appended: [],
      appendChild(c) { this.appended.push(c); },
      getBoundingClientRect: () => ({ top: 50 + i * 200, bottom: 230 + i * 200 }),
    };
    st.metas.push({ page, vp: page.getViewport({ scale }), wrap: wrapEl, canvas: null, rendering: false });
  }
}
const lastRender = (i) => st.metas[i].page.renders[st.metas[i].page.renders.length - 1];
const flush = () => sleep(0);

(async () => {
  // ---- 1. the bug: two zoom steps while the first repaint is in flight --------------------------
  {
    setup({ pages: 1, scale: 1 });
    const m = st.metas[0];
    const first = renderPage(0); // in flight at scale 1
    await flush();
    zoomTo(1.25);
    zoomTo(1.5); // refused by `rendering`: the render in flight is the only one
    check("precondition: still one render, at the old scale", [log.started, m.rendering], [["0@1"], true]);

    lastRender(0).release(); // the scale-1 bitmap lands
    await first;
    await flush();
    check("the stale scale-1 bitmap was NOT attached", [m.wrap.appended.length, offs[0].width, offs[0].height], [0, 0, 0]);
    check("…so the page is repainted at the CURRENT scale", log.started, ["0@1", "0@1.5"]);
    lastRender(0).release();
    await flush();
    await flush();
    check("…and that one is attached: bitmap matches the box", [m.wrap.appended.length, m.canvas && m.canvas.width, m.vp.scale], [1, 150, 1.5]);
    check("not rendering any more", m.rendering, false);
  }

  // ---- 2. an ordinary render is untouched ------------------------------------------------------------
  {
    setup({ pages: 1, scale: 1.5 });
    const m = st.metas[0];
    const p = renderPage(0);
    await flush();
    lastRender(0).release();
    await p;
    check("no zoom: one render, attached at its own size", [log.started, m.wrap.appended.length, m.canvas.width], [["0@1.5"], 1, 150]);
    await renderPage(0);
    check("already painted: renderPage is a no-op", log.started.length, 1);
  }

  // ---- 3. zoom before any render has started: the normal path ------------------------------------------
  {
    setup({ pages: 1, scale: 1 });
    zoomTo(2);
    await flush();
    lastRender(0).release();
    await flush();
    await flush();
    check("zoom with nothing in flight: one render at the new scale, attached", [log.started, st.metas[0].canvas.width], [["0@2"], 200]);
  }

  // ---- 4. the stale page has since scrolled out of reach: no wasted repaint -------------------------------
  {
    setup({ pages: 1, scale: 1 });
    const m = st.metas[0];
    const p = renderPage(0);
    await flush();
    zoomTo(2);
    m.wrap.getBoundingClientRect = () => ({ top: 9000, bottom: 9300 }); // far outside the render margin
    lastRender(0).release();
    await p;
    await flush();
    check("stale and far away: dropped, not repainted (the observer will paint it on return)", [m.canvas, m.wrap.appended.length, log.started], [null, 0, ["0@1"]]);
  }

  // ---- 5. the document was swapped meanwhile: leave the new one alone -------------------------------------
  {
    setup({ pages: 1, scale: 1 });
    const m = st.metas[0];
    const p = renderPage(0);
    await flush();
    zoomTo(2);
    st.token++; // a reload replaced the document
    lastRender(0).release();
    await p;
    await flush();
    check("different document: nothing attached, no repaint for the old one", [m.canvas, m.wrap.appended.length, log.started], [null, 0, ["0@1"]]);
  }

  // ---- 6. three quick steps: one extra repaint at the FINAL scale, not three ------------------------------------
  {
    setup({ pages: 1, scale: 1 });
    const p = renderPage(0);
    await flush();
    zoomTo(1.25);
    zoomTo(1.5);
    zoomTo(2);
    lastRender(0).release();
    await p;
    await flush();
    lastRender(0).release();
    await flush();
    await flush();
    check("three steps while rendering: exactly one repaint, at the final scale", [log.started, st.metas[0].canvas.width], [["0@1", "0@2"], 200]);
  }

  // ---- 7. several pages, only the in-flight ones need the follow-up ---------------------------------------------
  {
    setup({ pages: 3, scale: 1 });
    const p0 = renderPage(0); // 0 in flight; 1 and 2 not started
    await flush();
    zoomTo(2); // starts 1 and 2 at scale 2 (near the viewport), refuses 0
    check("zoom starts the idle pages at once and refuses the busy one", log.started, ["0@1", "1@2", "2@2"]);
    for (const i of [1, 2]) lastRender(i).release();
    lastRender(0).release();
    await p0;
    await flush();
    lastRender(0).release();
    await flush();
    await flush();
    check("every page ends attached at scale 2", st.metas.map((m) => m.canvas && m.canvas.width), [200, 200, 200]);
    check("page 0 rendered twice (1 then 2), the others once", st.metas.map((m) => m.page.renders.length), [2, 1, 1]);
  }

  // ---- 8. a failing render leaves the page retryable and does not loop ---------------------------------------------
  {
    setup({ pages: 1, scale: 1 });
    const m = st.metas[0];
    const p = renderPage(0);
    await flush();
    zoomTo(2);
    lastRender(0).fail(new Error("worker gone"));
    await p;
    await flush();
    check("failed render: swallowed, not rendering, nothing attached, no retry loop", [m.rendering, m.canvas, m.wrap.appended.length, log.started], [false, null, 0, ["0@1"]]);
  }

  // ---- 9. no change to the unchanged-scale guard -----------------------------------------------------------------------
  {
    setup({ pages: 1, scale: 1 });
    zoomTo(1);
    check("zoomTo to the same scale does nothing", log.started, []);
  }

  finished = true;
  console.log(`\nview-pane-zoom: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
