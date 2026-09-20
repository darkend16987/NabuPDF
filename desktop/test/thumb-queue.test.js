"use strict";

// Regression net for the thumbnail scheduling order (renderer/thumb-queue.js).
//
// Why this file exists: the bug it prevents is SILENT. A thumbnail costs a full
// page render (162 ms at 150 px, 161 ms at 600 px on a real A1 CAD sheet — the
// price is the operator list, not the pixels), and the sidebar's observer fires
// ~9 ms after a document opens. Let those run before the viewer's first pages and
// nothing errors; the file just takes 1.2 s longer to show anything
// (docs/RESEARCH-2026-09-20b-cad-perf-real-files.md §3.3).
//
// The nastiest case is #5: a pump still draining the PREVIOUS document must notice
// that reset() shut the gate and stop, instead of spending the main thread exactly
// when the new document's first page needs it.
//
// Run:  node desktop/test/thumb-queue.test.js      (or: npm run test:thumbs)

const path = require("path");
const { createThumbQueue } = require(path.join(__dirname, "..", "renderer", "thumb-queue.js"));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       got      ${a}\n       expected ${e}`);
  }
}

// A controllable stand-in for requestIdleCallback: every lap parks here until the
// test says "go", so the interleaving is deterministic instead of timing-dependent.
function makeHarness(opts) {
  const drawn = [];
  const waiters = [];
  const q = createThumbQueue({
    render: async (i) => {
      if (opts && opts.throwOn === i) throw new Error("boom");
      drawn.push(i);
    },
    idle: () => new Promise((r) => waiters.push(r)),
  });
  // Release one parked idle slice and let its microtasks settle.
  async function tick(n) {
    for (let k = 0; k < (n || 1); k++) {
      const w = waiters.shift();
      if (w) w();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
  }
  return { q, drawn, tick, parked: () => waiters.length };
}

async function main() {
  // 1 — the gate is shut on a fresh queue: enqueueing draws nothing.
  {
    const h = makeHarness();
    h.q.queue(0);
    h.q.queue(1);
    await h.tick(3);
    check("1 closed gate draws nothing", h.drawn, []);
    check("1 but the work is remembered", h.q.pending(), [0, 1]);
    check("1 and nothing is parked on idle", h.parked(), 0);
  }

  // 2 — open() drains in FIFO order, one per idle slice.
  {
    const h = makeHarness();
    h.q.queue(0);
    h.q.queue(1);
    h.q.queue(2);
    h.q.open();
    await h.tick(1);
    check("2 one idle slice = one thumbnail", h.drawn, [0]);
    await h.tick(1);
    check("2 next slice, next thumbnail", h.drawn, [0, 1]);
    await h.tick(1);
    check("2 FIFO to the end", h.drawn, [0, 1, 2]);
    check("2 queue emptied", h.q.pending(), []);
    check("2 pump released", h.q.isPumping(), false);
  }

  // 3 — enqueueing AFTER open() (the scroll case) still draws.
  {
    const h = makeHarness();
    h.q.open();
    h.q.queue(7);
    await h.tick(1);
    check("3 late enqueue draws", h.drawn, [7]);
  }

  // 4 — an index is queued once, however many times the observer reports it.
  {
    const h = makeHarness();
    h.q.queue(4);
    h.q.queue(4);
    h.q.queue(4);
    check("4 deduplicated", h.q.pending(), [4]);
    h.q.open();
    await h.tick(2);
    check("4 drawn once", h.drawn, [4]);
  }

  // 5 — THE ONE THAT MATTERS: reset() stops a pump that is already in flight.
  //     Old document draining; a new document arrives mid-drain; the pump must not
  //     keep eating the main thread, and must not draw the new document's pages
  //     before renderViewer opens the gate again.
  {
    const h = makeHarness();
    h.q.queue(0);
    h.q.queue(1);
    h.q.queue(2);
    h.q.open();
    await h.tick(1);
    check("5 old document started", h.drawn, [0]);
    h.q.reset(); // renderThumbs for the new document
    check("5 reset drops the pending work", h.q.pending(), []);
    check("5 reset shuts the gate", h.q.isOpen(), false);
    h.q.queue(0); // the new document's observer fires immediately
    h.q.queue(1);
    await h.tick(3);
    check("5 nothing drawn while the gate is shut", h.drawn, [0]);
    h.q.open(); // renderViewer has the new document's first pages up
    await h.tick(2);
    check("5 the new document then drains", h.drawn, [0, 0, 1]);
  }

  // 6 — a page that fails to rasterise must not wedge the ones behind it.
  {
    const h = makeHarness({ throwOn: 1 });
    h.q.queue(0);
    h.q.queue(1);
    h.q.queue(2);
    h.q.open();
    await h.tick(3);
    check("6 a throwing page is skipped, the rest still draw", h.drawn, [0, 2]);
    check("6 pump released", h.q.isPumping(), false);
  }

  // 7 — open() twice (renderViewer + renderAll's safety net) must not start a
  //     second pump that double-draws.
  {
    const h = makeHarness();
    h.q.queue(0);
    h.q.queue(1);
    h.q.open();
    h.q.open();
    await h.tick(2);
    check("7 open() is idempotent", h.drawn, [0, 1]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
