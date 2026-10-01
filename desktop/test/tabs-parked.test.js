"use strict";

// Regression net for PARKED tabs (src/tabs.js) — M5 of docs/REVIEW-2026-10-01.
//
// Session restore opens every remembered tab but reads the file of only the one being looked
// at ("deferred"). That parked only the FILE: each parked tab still loaded a complete
// renderer. Measured with a stored session (real Electron): 1180 MB / 15 processes for 8
// tabs against 514 MB / 8 for one — about 93 MB per tab nobody had looked at. A
// WebContentsView that has never navigated owns no renderer process, so a parked tab now
// does not load its page at all until it is first activated.
//
// The risk in that is every place that assumed "the tab has a live renderer":
//   · waking: the page must be loaded, then do what an ordinary tab does on load
//     (`tab:reserved`, the file, the presentation state) - once;
//   · closing: "window:before-close" sent to a page that is not there (or still loading) is
//     LOST and the close waits for an answer forever. Found by the real-Electron probe: closing
//     the window with parked tabs hung (>20 s; 0.5 s before). The cause was a chain: closing
//     the active tab activates its neighbour, which woke a parked tab that was itself about to
//     be closed;
//   · cancelling a window close must still leave the tab the user is looking at loaded.
//
// tabs.js is loaded with `electron` stubbed (like tabs-logic.test.js) and driven through its
// prototype with fake views, so what is checked is the shipped code.
//
// Run:  node desktop/test/tabs-parked.test.js      (or: npm test -- tabs-parked)

const path = require("path");
const Module = require("module");

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
let finished = false;
process.on("exit", () => {
  if (!finished) {
    process.stderr.write("FAIL the test exited before finishing: a promise never settled\n");
    process.exitCode = 1;
  }
});

// ---- fake electron --------------------------------------------------------------------------
class FakeWC {
  constructor() {
    this.loaded = []; // loadFile calls
    this.sent = [];
    this.handlers = {};
    this.loading = false;
    this.destroyed = false;
    this.focused = 0;
  }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push({ fn, once: false }); }
  once(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push({ fn, once: true }); }
  listenerCount(ev) { return (this.handlers[ev] || []).length; }
  emit(ev, ...a) {
    const hs = this.handlers[ev] || [];
    this.handlers[ev] = hs.filter((h) => !h.once);
    for (const h of hs) h.fn(...a);
  }
  loadFile(f) { this.loaded.push(f); this.loading = true; }
  finishLoad() { this.loading = false; this.emit("did-finish-load"); }
  send(ch, ...a) { this.sent.push([ch, ...a]); }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  focus() { this.focused++; }
  close() { this.destroyed = true; }
}
class FakeView { constructor() { this.webContents = new FakeWC(); } setBounds() {} }

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { BaseWindow: class {}, WebContentsView: FakeView, screen: {} };
  return origLoad.call(this, request, ...rest);
};
const Tabs = require(path.join(__dirname, "..", "src", "tabs.js"));
Module._load = origLoad;
const P = Tabs.TabbedWindow.prototype;

let filesSent;
Tabs.configure({
  RENDERER: "/renderer",
  docPreload: "preload.js",
  hardenNav() {},
  attachContextMenu() {},
  sendFileToView: (wc, p) => filesSent.push([wc, p]),
  sendCombineToView() {},
  isQuitting: () => false,
});

function mkWindow() {
  const w = Object.create(P);
  w.tabs = [];
  w.activeId = null;
  w.viewPanes = [];
  w.paneRatios = null;
  w._presenting = false;
  w._pendingClose = new Map();
  w._forceClose = false;
  w._closing = false;
  w.closeCalls = 0;
  w.base = {
    contentView: { addChildView() {}, removeChildView() {} },
    isDestroyed: () => false,
    close() { w.closeCalls++; },
  };
  w._layout = () => {};
  w._emit = () => {};
  return w;
}
const wcOf = (t) => t.view.webContents;
const flush = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  filesSent = [];

  // ---- 1. creating tabs ----------------------------------------------------------------------------
  {
    const w = mkWindow();
    const normal = w.createTab({ openPath: "a.pdf", background: true });
    const parked = w.createTab({ openPath: "b.pdf", deferred: true, background: true });
    const empty = w.createTab({ background: true });
    check("an ordinary tab loads its renderer", wcOf(normal).loaded.length, 1);
    check("an empty tab loads its renderer", wcOf(empty).loaded.length, 1);
    check("a PARKED tab does not load anything (no renderer process)", [wcOf(parked).loaded.length, wcOf(parked).listenerCount("did-finish-load")], [0, 0]);
    check("…but remembers its file, and shows its name", [parked.pendingPath, parked.path, parked.title], ["b.pdf", "b.pdf", "b.pdf"]);
    check("deferred without a file is not parked (nothing to wait for)", wcOf(w.createTab({ deferred: true, background: true })).loaded.length, 1);
    check("a combine tab is never parked", wcOf(w.createTab({ combinePaths: ["x.pdf"], deferred: true, background: true })).loaded.length, 1);

    // an ordinary tab still behaves as before: reserved + file on load
    wcOf(normal).finishLoad();
    check("an ordinary tab, once loaded, is told it is spoken for and sent its file",
      [wcOf(normal).sent.map((s) => s[0]), filesSent.filter(([wc]) => wc === wcOf(normal)).map(([, p]) => p)], [["tab:reserved"], ["a.pdf"]]);
  }

  // ---- 2. waking -------------------------------------------------------------------------------------------
  {
    filesSent = [];
    const w = mkWindow();
    const a = w.createTab({ openPath: "a.pdf", background: true });
    const b = w.createTab({ openPath: "b.pdf", deferred: true, background: true });
    w.activeId = a.id;
    w.activateTab(b.id);
    check("activating a parked tab loads its page, once, and clears the park", [wcOf(b).loaded, b.pendingPath], [[path.join("/renderer", "index.html")], null]);
    check("…nothing is sent before the page is up", [wcOf(b).sent.filter((s) => s[0] === "tab:reserved").length, filesSent.length], [0, 0]);
    wcOf(b).finishLoad();
    check("…then it is told it is spoken for and sent its file", [wcOf(b).sent.filter((s) => s[0] === "tab:reserved").length, filesSent.map(([, p]) => p)], [1, ["b.pdf"]]);
    w.activateTab(a.id);
    w.activateTab(b.id);
    check("activating it again does not load or send twice", [wcOf(b).loaded.length, filesSent.length], [1, 1]);

    // full-screen reading mode: the message activateTab sends before the load reached nobody
    const w2 = mkWindow();
    const x = w2.createTab({ openPath: "x.pdf", background: true });
    const y = w2.createTab({ openPath: "y.pdf", deferred: true, background: true });
    w2._presenting = true; // entered full screen AFTER the tab was parked (no creation-time hook for it)
    w2.activeId = x.id;
    w2.activateTab(y.id);
    wcOf(y).sent.length = 0;
    wcOf(y).finishLoad();
    check("presentation state is re-sent once the woken page is up", wcOf(y).sent.filter((s) => s[0] === "window:presentation").length >= 1, true);
  }

  // ---- 3. closing ------------------------------------------------------------------------------------------------
  {
    const w = mkWindow();
    const a = w.createTab({ openPath: "a.pdf", background: true });
    const b = w.createTab({ openPath: "b.pdf", deferred: true, background: true });
    w.activeId = a.id;
    const decision = await w._requestClose(b);
    check("closing a parked tab: answered at once, with nothing asked of a page that is not there",
      [decision, wcOf(b).sent.filter((s) => s[0] === "window:before-close").length, wcOf(b).loaded.length, w.activeId === a.id], [true, 0, 0, true]);
  }
  {
    const w = mkWindow();
    const a = w.createTab({ openPath: "a.pdf", background: true });
    w.activeId = a.id;
    wcOf(a).loading = true; // the page is still loading
    const p = w._requestClose(a);
    check("a tab still loading is NOT asked yet (the question would be lost)", wcOf(a).sent.filter((s) => s[0] === "window:before-close").length, 0);
    wcOf(a).finishLoad();
    check("…it is asked as soon as the page is up", wcOf(a).sent.filter((s) => s[0] === "window:before-close").length, 1);
    w._resolveClose(a.id, true);
    check("…and the answer resolves the close", await p, true);
  }
  {
    const w = mkWindow();
    const a = w.createTab({ openPath: "a.pdf", background: true });
    w.activeId = a.id;
    wcOf(a).loading = false;
    const p = w._requestClose(a);
    check("a loaded tab is asked immediately", wcOf(a).sent.filter((s) => s[0] === "window:before-close").length, 1);
    w._resolveClose(a.id, false);
    check("a cancel answer is passed through", await p, false);
  }

  // ---- 4. closing the WINDOW with parked tabs: the hang the real probe found ----------------------------------
  const answerWhenAsked = (w, decide) => {
    for (const t of w.tabs) {
      const wc = wcOf(t);
      const orig = wc.send.bind(wc);
      wc.send = (ch, ...a) => {
        orig(ch, ...a);
        if (ch === "window:before-close") setImmediate(() => w._resolveClose(t.id, decide(t)));
      };
    }
  };
  {
    // [parked, loaded+active, parked]: closing the active one activates a parked neighbour
    const w = mkWindow();
    const p1 = w.createTab({ openPath: "p1.pdf", deferred: true, background: true });
    const x = w.createTab({ openPath: "x.pdf", background: true });
    const p2 = w.createTab({ openPath: "p2.pdf", deferred: true, background: true });
    wcOf(x).finishLoad();
    w.activeId = x.id;
    answerWhenAsked(w, () => true);
    const done = await Promise.race([w._guardAndClose().then(() => "closed"), new Promise((r) => setTimeout(() => r("HUNG"), 1500))]);
    check("closing a window that holds parked tabs completes (it used to wait forever)", done, "closed");
    check("…no parked tab was woken just to be closed", [wcOf(p1).loaded.length, wcOf(p2).loaded.length], [0, 0]);
    check("…and the window really closed", [w.closeCalls, w.tabs.length], [1, 0]);
  }
  {
    // the user cancels: the tab that asked is the active one and is loaded; the parked ones stay parked
    const w = mkWindow();
    const z = w.createTab({ openPath: "z.pdf", background: true });
    const p = w.createTab({ openPath: "p.pdf", deferred: true, background: true });
    wcOf(z).finishLoad();
    w.activeId = p.id;
    answerWhenAsked(w, () => false); // Z says Cancel
    await w._guardAndClose();
    check("cancelling a window close: the asked tab is active and loaded, the parked one stays parked, the window lives",
      [w.activeId === z.id, wcOf(z).loaded.length, wcOf(p).loaded.length, p.pendingPath, w._closing, w.closeCalls], [true, 1, 0, "p.pdf", false, 0]);
  }
  {
    // activating a parked tab while the window is closing does not wake it
    const w = mkWindow();
    const a = w.createTab({ openPath: "a.pdf", background: true });
    const b = w.createTab({ openPath: "b.pdf", deferred: true, background: true });
    w.activeId = a.id;
    w._closing = true;
    w.activateTab(b.id);
    check("activateTab while the window is closing does not load a parked tab", [wcOf(b).loaded.length, b.pendingPath], [0, "b.pdf"]);
  }

  // ---- 5. the rest of the lifecycle still works on a parked tab -------------------------------------------------------
  {
    const w = mkWindow();
    const a = w.createTab({ openPath: "a.pdf", background: true });
    const b = w.createTab({ openPath: "b.pdf", deferred: true, background: true });
    w.activeId = a.id;
    w.destroyTab(b.id, { closeIfEmpty: false });
    check("destroying a parked tab closes its (never-loaded) view and keeps the rest", [wcOf(b).destroyed, w.tabs.map((t) => t.path)], [true, ["a.pdf"]]);
    const snap = Tabs.snapshotSession([{ base: { isDestroyed: () => false, getNormalBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }), isMaximized: () => false }, tabs: [{ id: 1, path: "a.pdf" }, { id: 2, path: "b.pdf", pendingPath: "b.pdf" }], activeId: 1, _livePanes: () => [], _closing: false }]);
    check("a parked tab is still recorded in the session", snap.windows[0].tabs, ["a.pdf", "b.pdf"]);
  }

  finished = true;
  console.log(`\ntabs-parked: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
