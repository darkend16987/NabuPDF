"use strict";

// Regression net for "the main process never waits on the disk" — M1 and M3 of
// docs/REVIEW-2026-10-01.
//
// What went wrong: main.js read documents with readFileSync and asked existsSync/statSync
// about remembered paths. The main process is the one event loop every window shares, so
// while it sat in one of those calls EVERY window was "Not Responding" — 161 ms for a warm
// 256 MB file, seconds on a NAS, and tens of seconds (21 s measured) per call on a share
// that is no longer reachable. The session restore made one such call per remembered tab.
//
// What must now hold:
//   · SafeFs.probe stops WAITING after `ms` (the stat cannot be cancelled), never throws,
//     and tells "slow" (timedOut) apart from "gone" (missing);
//   · N unreachable paths cost ONE timeout when probed together;
//   · sends to the same renderer stay in the order they were asked for, although their
//     reads finish out of order, and one failing send never blocks the next;
//   · a renderer closed while the disk was busy gets nothing (and nothing throws);
//   · the session restore keeps a tab whose path TIMED OUT (slow is not deleted) and drops
//     one that is MISSING;
//   · none of the functions that feed a renderer or open a dialog makes a synchronous fs
//     call any more (source pin on the shipped main.js — the behaviour tests below use a
//     stub reader, which cannot tell a sync read from an async one).
//
// The send functions are lifted out of the shipped main.js and run with stubs, like
// viewer-geom / thumb-refresh do for app.js, so what is checked is what runs.
//
// Run:  node desktop/test/safe-fs.test.js      (or: npm test -- safe-fs)

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const SafeFs = require("../src/safe-fs.js");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {}); // a stat that the OS never answers

// ---- tabs.js (electron stubbed, as tabs-logic.test.js does) ---------------------------------
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { BaseWindow: class {}, WebContentsView: class {}, screen: {} };
  return origLoad.call(this, request, ...rest);
};
const Tabs = require("../src/tabs.js");
Module._load = origLoad;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safefs-"));
const realFile = path.join(tmp, "a.pdf");
fs.writeFileSync(realFile, Buffer.from("%PDF-1.4 hello"));

(async () => {
  // ---- 1. probe ---------------------------------------------------------------------------
  {
    const hit = await SafeFs.probe(realFile);
    check("probe: existing file → stats, not timed out", [!!hit.stats, hit.stats.isFile(), hit.timedOut], [true, true, false]);
    const miss = await SafeFs.probe(path.join(tmp, "nope.pdf"));
    check("probe: missing → no stats, NOT a timeout", [miss.stats, miss.timedOut], [null, false]);

    const t0 = Date.now();
    const hang = await SafeFs.probe("\\\\dead-share\\x", { ms: 60, fsp: { stat: never } });
    const waited = Date.now() - t0;
    check("probe: a stat that never answers → gives up, flagged timedOut", [hang.stats, hang.timedOut], [null, true]);
    check("…and it did so in about the timeout, not never", waited >= 50 && waited < 1000, true);

    let late;
    const slow = await SafeFs.probe("x", { ms: 30, fsp: { stat: () => new Promise((r) => (late = r)) } });
    late({ isFile: () => true }); // the answer arrives AFTER we stopped waiting
    await sleep(10);
    check("probe: a late answer cannot overturn a timeout", [slow.stats, slow.timedOut], [null, true]);

    const rej = await SafeFs.probe("x", { ms: 500, fsp: { stat: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) } });
    check("probe: stat rejects → missing, not a timeout", [rej.stats, rej.timedOut], [null, false]);
    const thr = await SafeFs.probe("x", { ms: 500, fsp: { stat: () => { throw new Error("sync boom"); } } });
    check("probe: stat throws synchronously → handled", [thr.stats, thr.timedOut], [null, false]);
    const quick = Date.now();
    await SafeFs.probe(realFile, { ms: 5000 });
    check("probe: a fast answer does not wait for the timer", Date.now() - quick < 500, true);

    check("exists/isFile/isDirectory on real paths", [
      await SafeFs.exists(tmp), await SafeFs.isFile(tmp), await SafeFs.isDirectory(tmp),
      await SafeFs.isFile(realFile), await SafeFs.isDirectory(realFile), await SafeFs.exists(path.join(tmp, "nope")),
    ], [true, false, true, true, false, false]);
    check("isFile on a hanging path → false (and returns)", await SafeFs.isFile("x", { ms: 30, fsp: { stat: never } }), false);
  }

  // ---- 2. probeMany ---------------------------------------------------------------------------
  {
    const hung = { stat: never };
    const t0 = Date.now();
    const m = await SafeFs.probeMany(["a", "b", "c", "d", "e"], { ms: 120, fsp: hung });
    const took = Date.now() - t0;
    check("probeMany: 5 unreachable paths cost ONE timeout, not five", took < 120 * 3, true);
    check("probeMany: all flagged timeout", [...m.values()], ["timeout", "timeout", "timeout", "timeout", "timeout"]);

    const mixed = await SafeFs.probeMany([realFile, path.join(tmp, "gone.pdf"), realFile, "", null, 42]);
    check("probeMany: exists / missing; duplicates and junk ignored", [...mixed.entries()], [[realFile, "exists"], [path.join(tmp, "gone.pdf"), "missing"]]);
    check("probeMany: nothing to probe → empty", (await SafeFs.probeMany([])).size, 0);
  }

  // ---- 3. createOrdered -----------------------------------------------------------------------
  {
    const q = SafeFs.createOrdered();
    const key = {};
    const log = [];
    const slowFirst = q.run(key, async () => { await sleep(60); log.push("first"); return 1; });
    const fastSecond = q.run(key, async () => { log.push("second"); return 2; });
    const [r1, r2] = await Promise.all([slowFirst, fastSecond]);
    check("ordered: same key runs in submission order although the first is slower", [log, r1, r2], [["first", "second"], 1, 2]);

    const k1 = {}, k2 = {};
    const log2 = [];
    const a = q.run(k1, async () => { await sleep(60); log2.push("k1"); });
    const b = q.run(k2, async () => { log2.push("k2"); });
    await Promise.all([a, b]);
    check("ordered: different keys do not wait for each other", log2, ["k2", "k1"]);

    const k3 = {};
    const log3 = [];
    const bad = q.run(k3, async () => { throw new Error("read failed"); });
    const next = q.run(k3, async () => { log3.push("ran"); return "ok"; });
    let msg = null;
    try { await bad; } catch (e) { msg = e.message; }
    check("ordered: a failing job rejects to its caller…", msg, "read failed");
    let nextOutcome;
    try { nextOutcome = await next; } catch (e) { nextOutcome = "POISONED by the earlier failure: " + e.message; }
    check("…and does not block or poison the one behind it", [nextOutcome, log3], ["ok", ["ran"]]);
  }

  // ---- 4. restore decisions (tabs.js) -----------------------------------------------------------
  {
    const state = { a: "exists", b: "missing", c: "timeout" };
    const st = (p) => state[p];
    check("isRestorable: exists → keep", Tabs.isRestorable("a", st), true);
    check("isRestorable: missing → drop", Tabs.isRestorable("b", st), false);
    check("isRestorable: TIMEOUT → keep (slow is not deleted)", Tabs.isRestorable("c", st), true);
    check("isRestorable: not probed → falls back to the real check (present)", Tabs.isRestorable(realFile, st), true);
    check("isRestorable: not probed → falls back to the real check (absent)", Tabs.isRestorable(path.join(tmp, "nope"), st), false);
    check("isRestorable: no probe results at all → the old synchronous behaviour", [Tabs.isRestorable(realFile), Tabs.isRestorable(path.join(tmp, "nope"))], [true, false]);

    check("sessionPaths: tabs and panes of every window, junk ignored", Tabs.sessionPaths([
      { tabs: ["x.pdf", "", 7, "y.pdf"], panes: ["p.pdf", null] },
      null,
      { tabs: ["z.pdf"] },
      { tabs: "not-an-array", panes: ["q.pdf"] },
    ]), ["x.pdf", "y.pdf", "p.pdf", "z.pdf", "q.pdf"]);
    check("sessionPaths: not a list → []", [Tabs.sessionPaths(null), Tabs.sessionPaths({})], [[], []]);
  }

  // ---- 5. the send functions, lifted from the shipped main.js ----------------------------------
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  function body(name) {
    let at = MAIN.indexOf("function " + name + "(");
    if (at < 0) throw new Error(`${name}() not found in main.js — renamed or removed?`);
    const start = MAIN.slice(at - 6, at) === "async " ? at - 6 : at;
    const open = MAIN.indexOf("{", MAIN.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < MAIN.length; i++) {
      if (MAIN[i] === "{") depth++;
      else if (MAIN[i] === "}" && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}()`);
  }

  // stubs the lifted code closes over
  let fsStub, safeStub, sent;
  const fakeFs = { get promises() { return fsStub.promises; } };
  const shellCombine = { isPdfPath: (p) => /\.pdf$/i.test(p || "") };
  const sendQueue = SafeFs.createOrdered();
  const SafeFsProxy = {
    probe: (...a) => safeStub.probe(...a),
    isFile: (...a) => safeStub.isFile(...a),
  };
  // eslint-disable-next-line no-eval
  const sendFileToView = eval(`(function(fs, path, SafeFs, ShellCombine, sendQueue){ return ${body("sendFileToView")}; })`)(fakeFs, path, SafeFsProxy, shellCombine, sendQueue);
  // eslint-disable-next-line no-eval
  const sendFileToPane = eval(`(function(fs, path, SafeFs, ShellCombine, sendQueue){ return ${body("sendFileToPane")}; })`)(fakeFs, path, SafeFsProxy, shellCombine, sendQueue);
  // eslint-disable-next-line no-eval
  const sendCombineToView = eval(`(function(fs, path, SafeFs, ShellCombine, sendQueue){ return ${body("sendCombineToView")}; })`)(fakeFs, path, SafeFsProxy, shellCombine, sendQueue);

  const real = { promises: { readFile: (p) => fs.promises.readFile(p) } };
  const realSafe = { probe: (p) => SafeFs.probe(p), isFile: (p) => SafeFs.isFile(p) };
  function wc({ destroyedAfter = Infinity } = {}) {
    let calls = 0;
    const w = {
      isDestroyed: () => ++calls > destroyedAfter,
      send: (ch, payload) => sent.push({ ch, payload }),
    };
    return w;
  }
  const reset = () => { fsStub = real; safeStub = realSafe; sent = []; };

  {
    reset();
    await sendFileToView(wc(), realFile);
    check("sendFileToView: reads the file and sends it on file:open with its bytes", sent.map((s) => [s.ch, s.payload.path, s.payload.name, Buffer.from(s.payload.data).toString()]), [["file:open", realFile, "a.pdf", "%PDF-1.4 hello"]]);

    reset();
    await sendFileToView(wc(), path.join(tmp, "a.txt"));
    await sendFileToView(wc(), path.join(tmp, "missing.pdf"));
    await sendFileToView(wc(), "");
    await sendFileToView(wc(), tmp + "\\dir.pdf");
    check("sendFileToView: non-pdf / missing / empty path → nothing sent, nothing thrown", sent, []);

    reset();
    await sendFileToView(null, realFile);
    await sendFileToView(undefined, realFile);
    check("sendFileToView: no webContents → no-op", sent, []);

    reset();
    await sendFileToView(wc({ destroyedAfter: 0 }), realFile);
    check("sendFileToView: renderer already gone → nothing sent", sent, []);
    reset();
    await sendFileToView(wc({ destroyedAfter: 1 }), realFile); // alive at the start, gone after the read
    check("sendFileToView: renderer closed WHILE the disk was busy → nothing sent", sent, []);

    reset();
    fsStub = { promises: { readFile: () => Promise.reject(new Error("EBUSY")) } };
    let threw = false;
    try { await sendFileToView(wc(), realFile); } catch (_) { threw = true; }
    check("sendFileToView: unreadable file → swallowed, nothing sent", [threw, sent], [false, []]);
  }

  {
    // ordering: the FIRST send reads slowly, the SECOND is instant
    reset();
    const big = path.join(tmp, "big.pdf");
    const small = path.join(tmp, "small.pdf");
    fs.writeFileSync(big, "BIG");
    fs.writeFileSync(small, "SMALL");
    fsStub = { promises: { readFile: async (p) => { if (p === big) await sleep(80); return fs.promises.readFile(p); } } };
    const w = wc();
    await Promise.all([sendFileToView(w, big), sendFileToView(w, small)]);
    check("ordering: a small file asked for second does not overtake a big one asked for first", sent.map((s) => s.payload.name), ["big.pdf", "small.pdf"]);

    // two DIFFERENT renderers do not wait for each other
    reset();
    fsStub = { promises: { readFile: async (p) => { if (p === big) await sleep(80); return fs.promises.readFile(p); } } };
    const w1 = wc(), w2 = wc();
    w1.tag = "w1"; w2.tag = "w2";
    const order = [];
    w1.send = () => order.push("w1"); w2.send = () => order.push("w2");
    await Promise.all([sendFileToView(w1, big), sendFileToView(w2, small)]);
    check("different renderers are independent", order, ["w2", "w1"]);

    // the loop keeps ticking while a (slow) read is in flight
    reset();
    fsStub = { promises: { readFile: async () => { await sleep(150); return Buffer.from("x"); } } };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await sendFileToView(wc(), realFile);
    clearInterval(timer);
    check("the event loop keeps ticking while a read is in flight", ticks >= 5, true);

    // a failing send does not block the next one for the same renderer
    reset();
    let n = 0;
    fsStub = { promises: { readFile: async (p) => { if (++n === 1) throw new Error("EBUSY"); return fs.promises.readFile(p); } } };
    const w3 = wc();
    await Promise.all([sendFileToView(w3, realFile), sendFileToView(w3, realFile)]);
    check("a failed send does not block the next", sent.length, 1);
  }

  {
    // pane
    reset();
    await sendFileToPane(wc(), realFile);
    const s0 = sent[0];
    check("sendFileToPane: default channel view:open, with savedAt and bytes", [s0.ch, s0.payload.name, typeof s0.payload.savedAt, Buffer.from(s0.payload.data).toString()], ["view:open", "a.pdf", "number", "%PDF-1.4 hello"]);

    reset();
    await sendFileToPane(wc(), realFile, "view:reload");
    check("sendFileToPane: the channel argument is honoured (view:reload)", sent.map((s) => s.ch), ["view:reload"]);

    reset();
    await sendFileToPane(wc(), path.join(tmp, "missing.pdf"));
    check("sendFileToPane: missing file → view:clear with the 'not on disk' reason", sent.map((s) => [s.ch, s.payload.reason]), [["view:clear", "Không còn thấy file này trên đĩa."]]);

    reset();
    safeStub = { probe: async () => ({ stats: null, timedOut: true }), isFile: async () => false };
    await sendFileToPane(wc(), realFile);
    check("sendFileToPane: an unresponsive disk says so (not 'gone')", sent.map((s) => [s.ch, /không phản hồi/.test(s.payload.reason)]), [["view:clear", true]]);

    reset();
    fsStub = { promises: { readFile: () => Promise.reject(new Error("EBUSY")) } };
    await sendFileToPane(wc(), realFile);
    check("sendFileToPane: unreadable → view:clear with the 'could not read' reason", sent.map((s) => [s.ch, s.payload.reason]), [["view:clear", "Không đọc được file này."]]);

    reset();
    let reads = 0;
    fsStub = { promises: { readFile: (p) => { reads++; return fs.promises.readFile(p); } } };
    await sendFileToPane(wc({ destroyedAfter: 1 }), realFile);
    check("sendFileToPane: renderer closed while the disk was busy → nothing sent, and the (possibly huge) file is not even read", [sent, reads], [[], 0]);

    reset();
    await sendFileToPane(wc(), path.join(tmp, "x.txt"));
    check("sendFileToPane: non-pdf → nothing", sent, []);
  }

  {
    // combine
    reset();
    const f1 = path.join(tmp, "c1.pdf"), f2 = path.join(tmp, "c2.pdf");
    fs.writeFileSync(f1, "ONE");
    fs.writeFileSync(f2, "TWO");
    await sendCombineToView(wc(), [f1, path.join(tmp, "gone.pdf"), path.join(tmp, "notes.txt"), f2], 3);
    check("sendCombineToView: valid PDFs in order, missing/non-pdf skipped, dropped count carried", sent.map((s) => [s.ch, s.payload.files.map((f) => [f.name, Buffer.from(f.data).toString()]), s.payload.dropped]), [["combine:prefill", [["c1.pdf", "ONE"], ["c2.pdf", "TWO"]], 3]]);

    reset();
    fsStub = { promises: { readFile: async (p) => { if (p === f1) throw new Error("EBUSY"); return fs.promises.readFile(p); } } };
    await sendCombineToView(wc(), [f1, f2], 0);
    check("sendCombineToView: one locked file costs only itself", sent.map((s) => s.payload.files.map((f) => f.name)), [["c2.pdf"]]);

    reset();
    await sendCombineToView(wc(), [path.join(tmp, "gone.pdf")], 0);
    check("sendCombineToView: nothing usable → nothing sent", sent, []);

    reset();
    const t0 = Date.now();
    safeStub = { probe: SafeFs.probe, isFile: (p) => SafeFs.isFile(p, { ms: 100, fsp: { stat: never } }) };
    await sendCombineToView(wc(), [f1, f2, path.join(tmp, "c3.pdf"), path.join(tmp, "c4.pdf")], 0);
    check("sendCombineToView: 4 unreachable files cost ONE timeout", Date.now() - t0 < 100 * 3, true);
  }

  // ---- 6. source pins on the shipped main.js -----------------------------------------------------
  {
    const noSync = (name) => !/\b\w+Sync\(/.test(body(name));
    for (const fn of ["sendFileToView", "sendFileToPane", "sendCombineToView", "openDefault", "saveDefault", "readPicked"]) {
      check(`main.js ${fn}() makes no synchronous fs call`, noSync(fn), true);
    }
    const handler = (channel) => {
      const at = MAIN.indexOf(`ipcMain.handle("${channel}"`);
      if (at < 0) throw new Error(`handler ${channel} not found`);
      const open = MAIN.indexOf("{", MAIN.indexOf("=>", at));
      let depth = 0;
      for (let i = open; i < MAIN.length; i++) {
        if (MAIN[i] === "{") depth++;
        else if (MAIN[i] === "}" && --depth === 0) return MAIN.slice(at, i + 1);
      }
      throw new Error("unbalanced " + channel);
    };
    for (const ch of ["dialog:open-pdf", "dialog:pick-pdfs", "dialog:open-files", "dialog:save-pdf", "dialog:save-file", "shell:show-in-folder"]) {
      check(`main.js handler ${ch} makes no synchronous fs call`, !/\b\w+Sync\(/.test(handler(ch)), true);
    }
    // An un-awaited async openDefault() would be spread as a Promise → {} and the dialog
    // would silently lose its remembered folder, so every call must be awaited.
    const calls = (re) => (MAIN.match(re) || []).length;
    check("every openDefault() call is awaited (definition + N awaited calls)", calls(/\bopenDefault\(/g), calls(/await openDefault\(/g) + 1);
    check("every saveDefault() call is awaited (definition + N awaited calls)", calls(/\bsaveDefault\(/g), calls(/await saveDefault\(/g) + 1);
    check("startup restore probes the remembered paths asynchronously first",
      /SafeFs\.probeMany\(Tabs\.sessionPaths\(/.test(MAIN) && /Tabs\.restoreSession\(prev, \{ pathState:/.test(MAIN), true);
    check("the ready handler is async (it awaits that probe)", /app\.whenReady\(\)\.then\(async \(\) =>/.test(MAIN), true);
    check("the senders go through the per-renderer ordered queue", (MAIN.match(/sendQueue\.run\(webContents,/g) || []).length, 3);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsafe-fs: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
