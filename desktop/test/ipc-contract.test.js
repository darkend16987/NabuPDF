"use strict";

// Contract test for the Electron IPC surface: preload (what a renderer may call) ⇄
// main (what is actually registered).
//
// Channels are plain strings on both sides of a process boundary, so a typo or a
// half-finished rename produces NO error anywhere: `invoke("file:opn")` just rejects
// with "No handler registered" the one time someone clicks it, and a `send` to a name
// nobody listens on is dropped silently. This reads the real sources and requires:
//
//   1. every channel a preload invokes/sends has an `ipcMain` handler (any src/*.js —
//      license.js, signing.js, updater.js … register their own, not only main.js);
//   2. every `ipcMain` handler is reachable from some preload (an orphan is dead code
//      or a bridge someone forgot to expose);
//   3. every channel a preload listens on is actually sent from the main side (the
//      sends go through helpers like `askRenderer(wc, channel)`, so the check is "the
//      literal appears in main-side code", and literal `.send("x")` calls must be heard);
//   4. channel names stay `namespace:action` (the convention the split-view / tab
//      code relies on to tell who owns a channel);
//   5. the read-only split-view pane keeps its deliberately tiny surface (BI-55,
//      view-preload.js header): four calls out, four events in, all `view:*`. Widening
//      it should be a conscious edit to THIS list in review, never an accident.
//
// Static text scan — the same technique the other suites use on renderer sources; it
// cannot see a channel built at runtime, so the last section also fails if one appears.
//
// Run:  node desktop/test/ipc-contract.test.js      (or: npm test -- ipc-contract)

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const PRELOADS = ["preload.js", "view-preload.js", "shell-preload.js"];

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

// ---- extraction ------------------------------------------------------------

const lits = (s, re) => [...s.matchAll(re)].map((m) => m[1]);

/** Channels registered with ipcMain.handle / .on / .once, by literal name. */
const handledIn = (s) => lits(s, /ipcMain\.(?:handle|on|once)\(\s*"([^"]+)"/g);
/** Channels a preload sends to main (invoke = request/response, send/sendSync = fire). */
const outgoingIn = (s) => lits(s, /ipcRenderer\.(?:invoke|send|sendSync)\(\s*"([^"]+)"/g);
/** Channels a preload listens on — direct, or through view-preload's local on(channel, cb). */
const incomingIn = (s) => [
  ...lits(s, /ipcRenderer\.(?:on|once|removeListener)\(\s*"([^"]+)"/g),
  ...lits(s, /(?<![\w.])on\(\s*"([^"]+)"/g),
];
/** Main → renderer sends with a literal channel name. */
const literalSendsIn = (s) => lits(s, /\.send\(\s*"([^"]+)"/g);
/** Any `.send(<identifier>` — a channel built outside the literal scan. */
const indirectSendsIn = (s) => lits(s, /\.send\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g);

const uniq = (a) => [...new Set(a)].sort();
const minus = (a, b) => a.filter((x) => !b.includes(x));

function collect(read) {
  const all = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));
  const mainSide = all.filter((f) => !PRELOADS.includes(f));
  const mainText = mainSide.map(read).join("\n");
  return {
    handled: uniq(mainSide.flatMap((f) => handledIn(read(f)))),
    literalSends: uniq(mainSide.flatMap((f) => literalSendsIn(read(f)))),
    mainText,
    outgoing: uniq(PRELOADS.flatMap((f) => outgoingIn(read(f)))),
    incoming: uniq(PRELOADS.flatMap((f) => incomingIn(read(f)))),
  };
}

const NAMESPACED = /^[a-z0-9-]+:[a-z0-9:-]+$/i;

/** All contract violations for a collected surface, as readable strings. */
function violations(c) {
  const v = [];
  for (const ch of minus(c.outgoing, c.handled)) v.push(`preload calls "${ch}" but no ipcMain handler exists`);
  for (const ch of minus(c.handled, c.outgoing)) v.push(`ipcMain handles "${ch}" but no preload exposes it`);
  for (const ch of c.incoming) if (!c.mainText.includes(`"${ch}"`)) v.push(`preload listens on "${ch}" but main never mentions it`);
  for (const ch of minus(c.literalSends, c.incoming)) v.push(`main sends "${ch}" but no preload listens on it`);
  for (const ch of uniq([...c.handled, ...c.outgoing, ...c.incoming])) {
    if (!NAMESPACED.test(ch)) v.push(`"${ch}" is not namespace:action`);
  }
  return v;
}

// ---- 1. the real sources -----------------------------------------------------

const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const real = collect(read);

check("found the surface (guards against a scan that silently matches nothing)", [real.handled.length > 50, real.outgoing.length > 50, real.incoming.length > 15], [true, true, true]);
check("IPC contract: no violations", violations(real), []);

// ---- 2. the read-only pane's surface (BI-55) -----------------------------------

const viewSrc = read("view-preload.js");
check("view pane: outgoing channels are exactly the four it was designed with", uniq(outgoingIn(viewSrc)), ["view:close", "view:edit-this", "view:pick-source", "view:ready"]);
check("view pane: incoming channels are exactly the four it was designed with", uniq(incomingIn(viewSrc)), ["view:clear", "view:open", "view:reload", "view:state"]);
check("view pane: nothing outside view:* (no dialog/file/recovery/ocr bridge)", uniq([...outgoingIn(viewSrc), ...incomingIn(viewSrc)]).filter((c) => !c.startsWith("view:")), []);

// ---- 3. a channel built at runtime is invisible to this scan ----------------------
//
// main.js forwards through three helpers that take the channel as a parameter. That is
// fine as long as the call SITES pass literals (they are in mainText, check 3 above).
// What would blind the scan is a NEW indirect send, so pin the known ones.

const indirect = uniq(fs.readdirSync(SRC).filter((f) => f.endsWith(".js") && !PRELOADS.includes(f)).flatMap((f) => indirectSendsIn(read(f)).map((id) => `${f}:${id}`)));
check("indirect sends are only the known channel-parameter helpers", indirect, ["main.js:channel"]);

// ---- 4. negative controls: the checker must be able to fail ---------------------

const fake = (files) => collect((f) => files[f] || "");
const preBase = { "preload.js": 'ipcRenderer.invoke("a:go");', "view-preload.js": "", "shell-preload.js": "" };

check("control: balanced surface is clean", violations(fake({ ...preBase, "main.js": 'ipcMain.handle("a:go", f);' })), []);
check(
  "control: typo'd invoke is caught, both directions",
  violations(fake({ ...preBase, "main.js": 'ipcMain.handle("a:goo", f);' })),
  ['preload calls "a:go" but no ipcMain handler exists', 'ipcMain handles "a:goo" but no preload exposes it']
);
check(
  "control: handler living in another src file counts",
  violations(fake({ ...preBase, "main.js": "", "license.js": 'ipcMain.handle("a:go", f);' })),
  []
);
check(
  "control: orphan handler is caught",
  violations(fake({ ...preBase, "main.js": 'ipcMain.handle("a:go", f); ipcMain.on("a:extra", f);' })),
  ['ipcMain handles "a:extra" but no preload exposes it']
);
check(
  "control: listener nobody sends to is caught",
  violations(fake({ "preload.js": 'ipcRenderer.invoke("a:go"); ipcRenderer.on("a:evt", h);', "view-preload.js": "", "shell-preload.js": "", "main.js": 'ipcMain.handle("a:go", f);' })),
  ['preload listens on "a:evt" but main never mentions it']
);
check(
  "control: a literal send with no listener is caught",
  violations(fake({ ...preBase, "main.js": 'ipcMain.handle("a:go", f); win.webContents.send("a:lost", 1);' })),
  ['main sends "a:lost" but no preload listens on it']
);
check(
  "control: view-preload's local on() wrapper counts as a listener",
  violations(fake({ "preload.js": 'ipcRenderer.invoke("a:go");', "view-preload.js": 'const x = on("v:evt", cb);', "shell-preload.js": "", "main.js": 'ipcMain.handle("a:go", f); wc.send("v:evt", 1);' })),
  []
);
check(
  "control: a non-namespaced channel is caught",
  violations(fake({ "preload.js": 'ipcRenderer.invoke("go");', "view-preload.js": "", "shell-preload.js": "", "main.js": 'ipcMain.handle("go", f);' })),
  ['"go" is not namespace:action']
);

console.log(`\nipc-contract: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
