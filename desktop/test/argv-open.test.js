"use strict";

// Regression net for the last synchronous fs call on the launch path — M3 of
// docs/REVIEW-2026-10-01 (the other callers were fixed in the earlier batch).
//
// What went wrong: pdfPathFromArgv() asked existsSync + statSync about every *.pdf in the
// argv of a launch ("Open with", a double-click) and of every second-instance. On a share
// that is gone that is tens of seconds with every window frozen.
//
// What must now hold:
//   · it makes no synchronous fs call;
//   · a plain file is found, a missing one / a directory / a non-pdf / a switch is not;
//   · a path whose stat NEVER answers does not hang the launch, and is still returned (the
//     user asked for it - the open flow reports it) - not silently dropped;
//   · a MISSING file is skipped in favour of a later real one (same as before);
//   · second-instance launches stay in arrival order although their probes finish out of
//     order, and the combine branch is still asked first and synchronously (its drip order).
//
// The function is lifted out of the shipped main.js and run with a stub SafeFs, like
// safe-fs.test.js does for the senders.
//
// Run:  node desktop/test/argv-open.test.js      (or: npm test -- argv-open)

const fs = require("fs");
const os = require("os");
const path = require("path");
const SafeFs = require("../src/safe-fs.js");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    process.stderr.write(`FAIL ${name}\n  expected ${b}\n  actual   ${a}\n`);
  }
}
process.on("exit", (code) => {
  if (!process.exitCode && code === 0 && pass + fail === 0) process.stderr.write("FAIL no checks ran\n");
});

const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
function body(name) {
  const at = MAIN.indexOf("function " + name + "(");
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

const never = () => new Promise(() => {});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argvopen-"));
const real = path.join(tmp, "real.pdf");
fs.writeFileSync(real, "%PDF-1.4");
const dirPdf = path.join(tmp, "folder.pdf");
fs.mkdirSync(dirPdf);

// SafeFs with a short timeout so the "never answers" case is quick; `fsp` swappable.
let fspStub = fs.promises;
const SafeFsStub = { probe: (p) => SafeFs.probe(p, { ms: 150, fsp: { stat: (q) => fspStub.stat(q) } }) };
// eslint-disable-next-line no-eval
const pdfPathFromArgv = eval(`(function(SafeFs, path){ return ${body("pdfPathFromArgv")}; })`)(SafeFsStub, path);

(async () => {
  const exe = "C:\\app\\Nabu.exe";

  // ---- 1. what it finds ------------------------------------------------------------------------
  check("a real file is found (resolved)", await pdfPathFromArgv([exe, real]), path.resolve(real));
  check("a missing file is not", await pdfPathFromArgv([exe, path.join(tmp, "gone.pdf")]), null);
  check("a directory named *.pdf is not", await pdfPathFromArgv([exe, dirPdf]), null);
  check("a non-pdf is not (and is never stat'ed)", await (async () => {
    let touched = 0;
    fspStub = { stat: async () => { touched++; return fs.promises.stat(real); } };
    const r = await pdfPathFromArgv([exe, path.join(tmp, "notes.txt"), "--flag.pdf"]);
    fspStub = fs.promises;
    return [r, touched];
  })(), [null, 0]);
  check("switches and the exe path (argv[0]) are skipped", await pdfPathFromArgv([real, "--x", real]), path.resolve(real));
  check("a missing file is skipped in favour of a later real one", await pdfPathFromArgv([exe, path.join(tmp, "gone.pdf"), real]), path.resolve(real));
  check("not an array → null", await pdfPathFromArgv(undefined), null);
  check("empty argv → null", await pdfPathFromArgv([exe]), null);

  // ---- 2. a share that never answers -------------------------------------------------------------
  fspStub = { stat: never };
  const t0 = Date.now();
  const slow = await pdfPathFromArgv([exe, "\\\\dead\\share\\x.pdf"]);
  const took = Date.now() - t0;
  fspStub = fs.promises;
  check("an unanswered stat does not hang: gives up after the timeout", took >= 100 && took < 1500, true);
  check("…and the path is still returned (the open flow reports it), not silently dropped", slow, path.resolve("\\\\dead\\share\\x.pdf"));

  // ---- 3. source pins on the shipped main.js -----------------------------------------------------
  check("pdfPathFromArgv makes no synchronous fs call", !/\b\w+Sync\(/.test(body("pdfPathFromArgv")), true);
  check("pdfPathFromArgv is async", /^async function pdfPathFromArgv\(/.test(body("pdfPathFromArgv")), true);
  check("every call of pdfPathFromArgv is awaited (definition + N awaited calls)",
    (MAIN.match(/\bpdfPathFromArgv\(/g) || []).length, (MAIN.match(/await pdfPathFromArgv\(/g) || []).length + 1);
  // The combine branch must stay SYNCHRONOUS and first: Explorer drips one process per file, and an
  // await before bucket.add() would let the drip arrive out of order.
  const si = MAIN.slice(MAIN.indexOf('app.on("second-instance"'));
  const combineAt = si.indexOf("combineBucket.add(combinePath)");
  const queueAt = si.indexOf("argvQueue.run(argvKey");
  const firstAwait = si.indexOf("await ");
  check("second-instance: the combine branch comes first and before any await", combineAt > 0 && combineAt < queueAt && combineAt < firstAwait, true);
  check("second-instance: file launches go through the ordered queue", queueAt > 0, true);
  check("second-instance: a failing job is caught (no unhandled rejection in main)", /argvQueue\.run\(argvKey[\s\S]*?\}\)\.catch\(/.test(si), true);
  check("the launch path awaits it inside the async ready handler",
    /pendingOpenPath \|\| \(await pdfPathFromArgv\(process\.argv\)\)/.test(MAIN) && /app\.whenReady\(\)\.then\(async \(\) =>/.test(MAIN), true);

  // ---- 4. ordering: the queue keeps arrival order though the probes answer out of order -----------
  {
    const queue = SafeFs.createOrdered();
    const key = {};
    const opened = [];
    // first launch's disk is slow, second's is fast
    const delays = { a: 120, b: 5 };
    const launch = (id) => queue.run(key, async () => {
      await new Promise((r) => setTimeout(r, delays[id]));
      opened.push(id);
    });
    await Promise.all([launch("a"), launch("b")]);
    check("two quick launches open in arrival order", opened, ["a", "b"]);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`\nargv-open: ${pass} pass, ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})();
