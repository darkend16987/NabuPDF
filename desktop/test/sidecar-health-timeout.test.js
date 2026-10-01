"use strict";

// A sidecar that never passes its health check must not be left running (M7,
// docs/REVIEW-2026-10-01).
//
// startSidecar() spawns the child, then awaits waitForHealth(), which gives up after 180 s.
// On that rejection nothing held the child any more — `handle` is only returned on success —
// so it kept running after the failure was reported and after the app quit: an orphan
// sidecar.exe holding resources/sidecar open (EBUSY on the next rebuild) plus whatever
// models it had loaded. startSidecar now stops it on the way out.
//
// This drives the REAL startSidecar/stopSidecar with a stand-in child (a node process that
// listens on nothing), through the `opts` test seam. `electron` is stubbed the same way
// sidecar-lifecycle.test.js does — the module only wants `app.isPackaged`.
//
// Checked:
//   1. the promise rejects with the health-timeout message (behaviour unchanged);
//   2. the child is actually DEAD afterwards (polled — taskkill is asynchronous);
//   3. the exit that follows is ours: onExit (the "crashed" report) is NOT called;
//   4. control: with the kill removed the child stays alive (so (2) can fail);
//   5. stopSidecar leaves an already-dead child alone — on Windows that means no
//      `taskkill /pid` against a PID the OS may since have given to something else.
//
// Does not need the Python venv. Run:  node desktop/test/sidecar-health-timeout.test.js

const path = require("path");
const cp = require("child_process");

// ---- stubs, installed BEFORE sidecar.js is loaded -------------------------------------
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { isPackaged: false } },
};

const realSpawn = cp.spawn;
const taskkillCalls = [];
const spawned = []; // every child sidecar.js starts, in order
// sidecar.js binds `spawn` when it is required, so this wrapper must be in place first
// and is the only one that can see its calls.
cp.spawn = function (command, args, options) {
  if (String(command).toLowerCase().includes("taskkill")) taskkillCalls.push((args || []).join(" "));
  const child = realSpawn.call(this, command, args, options);
  spawned.push({ command, args, child });
  return child;
};

const sidecarPath = path.join(__dirname, "..", "src", "sidecar.js");
const { startSidecar, stopSidecar } = require(sidecarPath);

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
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours — still alive
  }
}
async function waitDead(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

// A "sidecar" that boots and then never serves anything.
const STALL = {
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
  cwd: process.cwd(),
};

(async () => {
  // ---- 1-3. the real fix --------------------------------------------------------------
  let exitReports = 0;
  const spawnedBefore = spawned.length;

  let message = null;
  const t0 = Date.now();
  try {
    await startSidecar("tok", () => exitReports++, { healthTimeoutMs: 600, spawnSpec: STALL });
    message = "(resolved)";
  } catch (e) {
    message = e.message;
  }
  const elapsed = Date.now() - t0;
  check("startSidecar rejects with the health-timeout message", /không phản hồi \/health/.test(message), true);
  check("…after about the configured timeout, not instantly and not 180 s", elapsed >= 500 && elapsed < 5000, true);
  const ours = spawned.slice(spawnedBefore).find((x) => x.command === STALL.command && x.args[0] === "-e");
  check("the stand-in child was really spawned", ours && typeof ours.child.pid, "number");
  check("the child is DEAD after the rejection (no orphan)", await waitDead(ours.child.pid, 5000), true);
  await sleep(300); // give a late exit event time to arrive
  check("the deliberate stop is not reported as a crash (onExit not called)", exitReports, 0);

  // ---- 4. control: without the kill, the same child outlives the failure ---------------
  const ctl = realSpawn(STALL.command, STALL.args, { stdio: "ignore" });
  await sleep(300);
  check("control: an unattended stand-in child stays alive", alive(ctl.pid), true);
  ctl.kill();
  await waitDead(ctl.pid, 3000);

  // ---- 5. an already-dead child is left alone -----------------------------------------------
  if (process.platform === "win32") {
    const dead = realSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => dead.once("exit", r));
    const before = taskkillCalls.length;
    stopSidecar({ child: dead, port: 0, stopping: false });
    check("stopSidecar on a dead child runs no taskkill (PID may be reused)", taskkillCalls.length, before);

    const live = realSpawn(STALL.command, STALL.args, { stdio: "ignore" });
    await sleep(200);
    const before2 = taskkillCalls.length;
    const handle = { child: live, port: 0, stopping: false };
    stopSidecar(handle);
    check("stopSidecar on a live child still kills its tree", [taskkillCalls.length - before2, handle.stopping], [1, true]);
    check("…and it dies", await waitDead(live.pid, 5000), true);
  } else {
    pass++; // taskkill path is win32-only
  }

  console.log(`\nsidecar-health-timeout: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
