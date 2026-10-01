"use strict";

// Regression net for how the Compare screen (renderer/compare.js) rasterises while the user
// zooms — R4 and R5 of docs/REVIEW-2026-10-01.
//
// R4 · the drawing OVERLAY ("Chồng lớp"). Every zoom step / Ctrl+wheel notch / tint toggle
//   called renderOverlay(), and several ran at once. Two passes drew onto the SAME two canvases:
//   ovRenderPage resizes the canvas (which wipes it) while the other pass's render is painting
//   it; pdf.js refuses a second render() on a canvas that already has one and rejects, and nobody
//   catches that; and because every pass re-read ov.scale after its own awaits, the base layer
//   could finish at one scale and the top layer at another. Each step also paid a full
//   getImageData of both layers (128 MB at the 400% ceiling) for a raster about to be thrown away.
//   Now: one pass at a time; requests that arrive meanwhile share its promise and cost ONE more
//   pass at the latest scale; a pass snapshots scale/tint once so both layers agree.
//
// R5 · the two comparison PANES. A zoom step rebuilds a whole pane (host.innerHTML = ""), and
//   renders still running on the discarded slots carried on painting detached canvases at the old
//   scale, competing in the pdf.js worker with the slots the user is waiting for. Now the
//   rebuild cancels them (per pane), and closing the comparison cancels both.
//
// The functions are lifted out of the shipped compare.js (they live inside its IIFE) and run
// with stubs; pdf.js is replaced by pages whose render() stays pending until the test releases
// it and which model the canvas rule above.
//
// Run:  node desktop/test/compare-render.test.js      (or: npm test -- compare-render)

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

const SRC = fs.readFileSync(process.env.COMPARE_JS || path.join(__dirname, "..", "renderer", "compare.js"), "utf8");
function lift(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in compare.js — renamed or removed?`);
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
const flush = () => sleep(0);
const CMP_KEEP_MARGIN_PX = 1200;
const OV_ZOOM_MIN = 0.2;
const OV_ZOOM_MAX = 4;

let cmp, ov, els, log, observers;
let ovJob = null;
let ovAgain = false;
const window = { RasterCap: { viewRasterDpr: (cw, ch, dpr) => dpr }, devicePixelRatio: 1 };

/** A minimal DOM node: enough for buildPane / renderPage / the overlay functions. */
function node(tag = "div") {
  const n = {
    tag, style: {}, dataset: {}, children: [], className: "", textContent: "", hidden: false, checked: false, value: "",
    parentElement: null,
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 100 }),
    querySelector: () => null,
    remove() {},
  };
  Object.defineProperty(n, "innerHTML", {
    get: () => "",
    set: (v) => { if (v === "") { n.children.forEach((c) => (c.parentElement = null)); n.children = []; } },
  });
  return n;
}
const document = {
  createElement: (tag) => (tag === "canvas" ? { style: {}, width: 0, height: 0, getContext: () => ({}) } : node(tag)),
};
const el = (id) => els[id] || (els[id] = node());
class IntersectionObserver {
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.targets = []; observers.push(this); }
  observe(t) { this.targets.push(t); }
  disconnect() { this.targets = []; }
}
function drawBoxes() {}

// pdf.js model: render() pends until released; two live renders on one canvas context are refused.
function makePdf(label) {
  const live = new Map(); // ctx -> count of live renders
  const pdf = {
    label, numPages: 3, tasks: [], overlap: 0, rendersStarted: 0,
    async getPage(n) {
      return {
        n,
        getViewport: ({ scale }) => ({ scale, width: 100 * scale, height: 150 * scale }),
        render({ canvasContext, viewport }) {
          pdf.rendersStarted++;
          const ctx = canvasContext;
          if ((live.get(ctx) || 0) > 0) pdf.overlap++; // pdf.js would reject this one; we only count it
          live.set(ctx, (live.get(ctx) || 0) + 1);
          let done = false, res, rej;
          const promise = new Promise((a, b) => { res = a; rej = b; });
          const task = {
            page: n, scale: viewport.scale, canceled: 0,
            promise,
            release() { if (!done) { done = true; live.set(ctx, live.get(ctx) - 1); res(); } },
            cancel() { task.canceled++; if (!done) { done = true; live.set(ctx, live.get(ctx) - 1); rej(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" })); } },
            fail(e) { if (!done) { done = true; live.set(ctx, live.get(ctx) - 1); rej(e); } },
          };
          pdf.tasks.push(task);
          return task;
        },
      };
    },
  };
  return pdf;
}

function canvas(name) {
  const ctx = {
    name,
    setTransform() {}, clearRect() {},
    getImageData: (x, y, w, h) => { log.imageData.push({ name, w, h }); return { data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) }; },
    putImageData: (im) => { log.put.push({ name, px: [...im.data.slice(0, 3)] }); },
  };
  const c = { name, style: {}, _w: 0, _h: 0, getContext: () => ctx, ctx };
  Object.defineProperty(c, "width", { get: () => c._w, set: (v) => { c._w = v; log.widthSets.push({ name, v }); } });
  Object.defineProperty(c, "height", { get: () => c._h, set: (v) => { c._h = v; } });
  return c;
}

const keyOutBackground = lift("keyOutBackground");
const ovRenderPage = lift("ovRenderPage");
const renderOverlay = lift("renderOverlay");
const renderOverlayPass = lift("renderOverlayPass");
const applyOverlayView = lift("applyOverlayView");
const ovZoomBy = lift("ovZoomBy");
const buildPane = lift("buildPane");
const renderPage = lift("renderPage");
const cancelPaneRenders = lift("cancelPaneRenders");
const freeCmpPage = lift("freeCmpPage");
const slotFarFromPane = lift("slotFarFromPane");
const reset = lift("reset");

function setup() {
  log = { imageData: [], widthSets: [], put: [] };
  observers = [];
  els = {
    "overlay-base": canvas("base"), "overlay-top": canvas("top"), "overlay-stack": node(), "overlay-zoom": node(),
    "overlay-tint": Object.assign(node(), { checked: false }), "overlay-align": Object.assign(node(), { checked: false }),
    "overlay-opacity": Object.assign(node(), { value: "50" }),
    "compare-a": node(), "compare-b": node(),
  };
  ovJob = null;
  ovAgain = false;
  const pdfA = makePdf("A"), pdfB = makePdf("B");
  cmp = {
    pdfA, pdfB, scale: 1, wrapsA: [], wrapsB: [], obsA: null, obsB: null, keepA: null, keepB: null,
    tasksA: new Set(), tasksB: new Set(), aBoxes: {}, bBoxes: {}, a: {}, b: {}, report: {}, changes: [], sel: null, owner: null,
    changeIdx: -1, mode: "auto", fit: true,
  };
  ov = { pairs: [{ a: 0, b: 0, dx: 0, dy: 0 }], idx: 0, scale: 1, fit: true, dx: 0, dy: 0, mdx: 0, mdy: 0 };
}
/** Release every pending render on both documents until none is left (bounded). */
async function drainAll() {
  for (let n = 0; n < 400; n++) {
    let any = false;
    for (const pdf of [cmp.pdfA, cmp.pdfB]) for (const t of pdf.tasks) { t.release(); }
    await sleep(2);
    if (!ovJob) { if (!any) return; }
  }
  throw new Error("overlay never settled");
}

(async () => {
  // ================= R4 · overlay =====================================================================
  {
    setup();
    ov.scale = 1;
    const p = renderOverlay();
    await flush();
    check("one request → one pass, base layer first", [cmp.pdfA.rendersStarted, cmp.pdfB.rendersStarted], [1, 0]);
    cmp.pdfA.tasks[0].release();
    await flush(); await flush();
    cmp.pdfB.tasks[0].release();
    await p;
    check("…then the top layer; each layer was read back exactly once", [cmp.pdfB.rendersStarted, log.imageData.map((x) => x.name)], [1, ["base", "top"]]);
    check("…and nothing overlapped", [cmp.pdfA.overlap, cmp.pdfB.overlap], [0, 0]);
  }

  {
    setup();
    ov.scale = 1;
    const first = renderOverlay(); // pass at scale 1 in flight on the base layer
    await flush();
    // a burst of zoom steps while it runs (what Ctrl+wheel sends)
    const burst = [ovZoomBy(1.1), ovZoomBy(1.1), ovZoomBy(1.1)];
    await flush();
    check("steps arriving mid-pass start NO concurrent render", [cmp.pdfA.rendersStarted, cmp.pdfA.overlap], [1, 0]);
    check("…they all share the running promise", burst.every((x) => x === first || x instanceof Promise), true);

    cmp.pdfA.tasks[0].release();
    await flush(); await flush();
    cmp.pdfB.tasks[0].release();
    await flush(); await flush(); await flush();
    // pass 2 starts with the latest scale
    check("a second pass follows, once, at the LATEST scale", [cmp.pdfA.rendersStarted, +cmp.pdfA.tasks[1].scale.toFixed(3)], [2, 1.331]);
    cmp.pdfA.tasks[1].release();
    await flush(); await flush();
    cmp.pdfB.tasks[1].release();
    await Promise.all([first, ...burst]);
    check("4 requests (1 + 3 steps) cost 2 passes, not 4: the intermediate scales were never rasterised",
      [cmp.pdfA.tasks.map((t) => +t.scale.toFixed(3)), cmp.pdfB.tasks.map((t) => +t.scale.toFixed(3))], [[1, 1.331], [1, 1.331]]);
    check("…so only 2 × 2 layer read-backs happened, not 8", log.imageData.length, 4);
    check("no render ever overlapped on a canvas", [cmp.pdfA.overlap, cmp.pdfB.overlap], [0, 0]);
    check("every awaiting caller resolved only after the final pass", ovJob, null);
    check("the canvas is never resized under a live render (the wipe)", (() => {
      // widthSets after the first release belong to pass 2; a width set while a render is live would have shown as overlap
      return cmp.pdfA.overlap + cmp.pdfB.overlap;
    })(), 0);
  }

  {
    setup();
    ov.scale = 1;
    const p = renderOverlay();
    await flush();
    ov.scale = 2; // changes while the base layer is rendering
    cmp.pdfA.tasks[0].release();
    await flush(); await flush();
    check("both layers of one pass use the SAME scale (the snapshot), although ov.scale moved mid-pass",
      [cmp.pdfA.tasks[0].scale, cmp.pdfB.tasks[0].scale], [1, 1]);
    cmp.pdfB.tasks[0].release();
    await flush(); await flush();
    renderOverlay(); // (the zoom handler would have asked for this)
    for (let i = 0; i < 6; i++) { for (const pdf of [cmp.pdfA, cmp.pdfB]) pdf.tasks.forEach((t) => t.release()); await sleep(2); }
    await p;
    check("…and the next pass picks up the new scale for both", [cmp.pdfA.tasks[cmp.pdfA.tasks.length - 1].scale, cmp.pdfB.tasks[cmp.pdfB.tasks.length - 1].scale], [2, 2]);
  }

  {
    setup();
    ov.scale = 1;
    const p = renderOverlay();
    await flush();
    ov.pairs = []; // the overlay was closed while the base layer rendered
    cmp.pdfA.tasks[0].release();
    let threw = false;
    try { await p; } catch (_) { threw = true; }
    check("closing the overlay mid-pass: no throw, the top layer is not even started", [threw, cmp.pdfB.rendersStarted], [false, 0]);
    const q = renderOverlay();
    await q;
    check("…and a later call on a closed overlay is a no-op that does not wedge the loop", [ovJob, cmp.pdfA.rendersStarted], [null, 1]);
  }

  {
    setup();
    ov.scale = 1;
    const p = renderOverlay();
    await flush();
    cmp.pdfA.tasks[0].fail(new Error("worker gone"));
    let msg = null;
    try { await p; } catch (e) { msg = e.message; }
    check("a failing pass rejects to its caller…", msg, "worker gone");
    check("…and clears the busy state, so the NEXT request runs", ovJob, null);
    const again = renderOverlay();
    await flush();
    check("…it really starts a fresh pass", cmp.pdfA.rendersStarted, 2);
    cmp.pdfA.tasks[1].release(); await flush(); await flush(); cmp.pdfB.tasks[0].release();
    await again;
  }

  {
    setup();
    ov.scale = 1;
    const p = renderOverlay();
    await flush();
    els["overlay-tint"].checked = true; // tint toggled mid-pass
    renderOverlay();
    cmp.pdfA.tasks[0].release(); await flush(); await flush(); cmp.pdfB.tasks[0].release();
    await flush(); await flush(); await flush();
    for (let i = 0; i < 6; i++) { for (const pdf of [cmp.pdfA, cmp.pdfB]) pdf.tasks.forEach((t) => t.release()); await sleep(2); }
    await p;
    check("a tint toggled mid-pass is honoured by the follow-up pass (2 passes)", cmp.pdfA.rendersStarted, 2);
    const lastPut = (n) => log.put.filter((x) => x.name === n).pop();
    check("…and the layers really were recoloured: base red, top blue (untinted first pass left ink alone)",
      [log.put[0].px, lastPut("base").px, lastPut("top").px], [[255, 255, 255], [0xe0, 0x10, 0x10], [0x10, 0x60, 0xe0]]);
  }

  // ================= R5 · panes ========================================================================
  {
    setup();
    cmp.scale = 1;
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    const oldSlots = cmp.wrapsA.slice();
    renderPage("a", cmp.pdfA, 0, oldSlots[0], {});
    renderPage("a", cmp.pdfA, 1, oldSlots[1], {});
    await flush(); await flush();
    check("two slot renders are in flight and tracked", [cmp.pdfA.tasks.length, cmp.tasksA.size], [2, 2]);

    cmp.scale = 1.5; // the user zoomed: the pane is rebuilt
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    await flush(); await flush();
    check("the rebuild CANCELLED both renders on the discarded slots", cmp.pdfA.tasks.map((t) => t.canceled), [1, 1]);
    check("…and the pane tracks nothing stale", cmp.tasksA.size, 0);
    check("the old slots are detached and flagged retryable", [oldSlots[0].parentElement, oldSlots[0].dataset.rendered, oldSlots[0].dataset.rendering], [null, "0", "0"]);
    check("new slots exist for the new scale", [cmp.wrapsA.length === oldSlots.length, cmp.wrapsA[0] !== oldSlots[0]], [true, true]);
  }

  {
    setup();
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    buildPane("b", cmp.pdfB, cmp.bBoxes);
    renderPage("a", cmp.pdfA, 0, cmp.wrapsA[0], {});
    renderPage("b", cmp.pdfB, 0, cmp.wrapsB[0], {});
    await flush(); await flush();
    buildPane("a", cmp.pdfA, cmp.aBoxes); // only pane A is rebuilt
    await flush();
    check("rebuilding pane A cancels A's render and leaves B's alone", [cmp.pdfA.tasks[0].canceled, cmp.pdfB.tasks[0].canceled, cmp.tasksA.size, cmp.tasksB.size], [1, 0, 0, 1]);
    cmp.pdfB.tasks[0].release();
    await flush(); await flush();
    check("B's render completes normally and un-tracks itself", [cmp.tasksB.size, cmp.wrapsB[0].dataset.rendered], [0, "1"]);
  }

  {
    setup();
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    renderPage("a", cmp.pdfA, 0, cmp.wrapsA[0], {});
    await flush(); await flush();
    cmp.pdfA.tasks[0].release();
    await flush(); await flush();
    check("a render that finishes normally leaves nothing tracked", cmp.tasksA.size, 0);

    renderPage("a", cmp.pdfA, 1, cmp.wrapsA[1], {});
    await flush(); await flush();
    cmp.pdfA.tasks[1].fail(new Error("boom"));
    await flush(); await flush();
    check("a render that fails leaves nothing tracked and the slot retryable", [cmp.tasksA.size, cmp.wrapsA[1].dataset.rendered], [0, "0"]);
  }

  {
    setup();
    buildPane("a", cmp.pdfA, cmp.aBoxes);
    buildPane("b", cmp.pdfB, cmp.bBoxes);
    renderPage("a", cmp.pdfA, 0, cmp.wrapsA[0], {});
    renderPage("b", cmp.pdfB, 0, cmp.wrapsB[0], {});
    await flush(); await flush();
    const pa = cmp.pdfA, pb = cmp.pdfB; // reset() nulls them
    reset(); // closing the comparison
    await flush();
    check("closing the comparison cancels the renders of BOTH panes", [pa.tasks[0].canceled, pb.tasks[0].canceled, cmp.tasksA.size, cmp.tasksB.size], [1, 1, 0, 0]);
  }

  {
    // Rebuild with nothing in flight, and cancelPaneRenders on an empty set, must be harmless.
    setup();
    let threw = false;
    try { cancelPaneRenders("a"); cancelPaneRenders("b"); buildPane("a", cmp.pdfA, cmp.aBoxes); } catch (_) { threw = true; }
    check("cancelling with nothing in flight is harmless", threw, false);
  }

  finished = true;
  console.log(`\ncompare-render: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
