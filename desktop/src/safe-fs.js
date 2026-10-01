"use strict";

// ---------------------------------------------------------------------------
// File-system probes that never block the main process (docs/REVIEW-2026-10-01 M1, M3).
//
// The main process is the app's one event loop: while it sits in a synchronous
// fs call, EVERY window is "Not Responding". Local disks answer in microseconds, so
// `existsSync` / `readFileSync` looked free — until the path is a UNC share, a mapped
// drive on a VPN that dropped, a NAS or a spun-down HDD. Windows then waits tens of
// seconds (measured 21 s for an unreachable share) per call, and the session restore
// does one call PER remembered tab.
//
// Two things here:
//
//   probe()          stat a path asynchronously and stop WAITING after `ms`. The stat
//                    itself cannot be cancelled (it holds a libuv thread-pool slot until
//                    the OS gives up) but the app no longer waits for it, so a dead share
//                    costs a bounded delay instead of freezing every window.
//   createOrdered()  run async jobs for the same key (one webContents) strictly one after
//                    another. Sending a document used to be synchronous and therefore
//                    ordered by construction; once the read is async, two quick sends to
//                    the same renderer could otherwise arrive in the order their reads
//                    FINISHED (a small file overtaking a big one).
//
// Pure Node, no Electron import: tested directly (test/safe-fs.test.js).
// ---------------------------------------------------------------------------

const fs = require("fs");

// How long a caller waits for a stat before giving up. Long enough for a slow-but-alive
// NAS to answer, short enough that launching with a dead share feels like a pause and
// not a hang.
const PROBE_TIMEOUT_MS = 3000;

/**
 * Stat `p` without blocking and without throwing.
 * Resolves to `{ stats, timedOut }`: `stats` is the fs.Stats or null (missing / not
 * accessible / timed out); `timedOut` is true only when we stopped waiting.
 */
function probe(p, { ms = PROBE_TIMEOUT_MS, fsp = fs.promises } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done({ stats: null, timedOut: true }), ms);
    let pending;
    try {
      pending = fsp.stat(p);
    } catch (_) {
      done({ stats: null, timedOut: false });
      return;
    }
    pending.then(
      (stats) => done({ stats, timedOut: false }),
      () => done({ stats: null, timedOut: false })
    );
  });
}

async function exists(p, opts) {
  const { stats } = await probe(p, opts);
  return !!stats;
}

async function isFile(p, opts) {
  const { stats } = await probe(p, opts);
  return !!stats && stats.isFile();
}

async function isDirectory(p, opts) {
  const { stats } = await probe(p, opts);
  return !!stats && stats.isDirectory();
}

/**
 * Probe many paths at once (so N dead shares cost ONE timeout, not N).
 * Resolves to a Map path -> "exists" | "missing" | "timeout".
 */
async function probeMany(paths, opts) {
  const unique = [...new Set(paths.filter((p) => typeof p === "string" && p))];
  const states = await Promise.all(
    unique.map(async (p) => {
      const { stats, timedOut } = await probe(p, opts);
      return [p, timedOut ? "timeout" : stats ? "exists" : "missing"];
    })
  );
  return new Map(states);
}

/**
 * Per-key serial execution. `run(key, fn)` calls `fn()` once every earlier job for the same
 * key has settled, and resolves/rejects with fn's outcome. A failing job never blocks the
 * ones behind it. Keys are held weakly, so a closed webContents leaves nothing behind.
 */
function createOrdered() {
  const tails = new WeakMap();
  return {
    run(key, fn) {
      const prev = tails.get(key) || Promise.resolve();
      const job = prev.then(() => fn());
      // The tail must never reject, or the next job would be skipped over a stale error.
      const tail = job.then(
        () => undefined,
        () => undefined
      );
      tails.set(key, tail);
      return job;
    },
  };
}

module.exports = { PROBE_TIMEOUT_MS, probe, exists, isFile, isDirectory, probeMany, createOrdered };
