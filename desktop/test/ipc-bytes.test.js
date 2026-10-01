"use strict";

// Regression net for src/ipc-bytes.js — the no-copy path for saving bytes that arrived
// over IPC (docs/REVIEW-2026-10-01 M4).
//
// The save handlers used `writeFile(path, Buffer.from(data))`. For a Uint8Array that
// is a full COPY of the document on every Lưu / Lưu thành / autosave. `asWritable`
// passes a typed array straight through and keeps `Buffer.from` for everything else.
// What must hold:
//   1. a view (Uint8Array / Buffer / DataView) is returned as-is — no copy, which is the
//      whole point;
//   2. a view onto the MIDDLE of a bigger buffer writes exactly its own range to disk;
//   3. every non-view input still converts exactly as `Buffer.from` did (ArrayBuffer,
//      number[], string) — `writeFile` would throw on a bare ArrayBuffer, so dropping the
//      fallback would turn a speed-up into a data-loss bug for any caller that sends one;
//   4. null/undefined still throw (same TypeError as before, handler's try/catch intact);
//   5. main.js does not reintroduce a `Buffer.from(...)` inside a writeFile call.
//
// Run:  node desktop/test/ipc-bytes.test.js      (or: npm test -- ipc-bytes)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { asWritable } = require("../src/ipc-bytes.js");

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

(async () => {
  // ---- 1. views pass through untouched ---------------------------------------------
  const u8 = new Uint8Array([1, 2, 3, 4]);
  check("Uint8Array: same object (no copy)", asWritable(u8) === u8, true);
  const buf = Buffer.from([9, 8, 7]);
  check("Buffer: same object (no copy)", asWritable(buf) === buf, true);
  const dv = new DataView(new ArrayBuffer(4));
  check("DataView: same object", asWritable(dv) === dv, true);
  const big = new Uint8Array(32 * 1024 * 1024);
  check("a 32 MB array is not duplicated", asWritable(big) === big, true);

  // ---- 2. a sub-view writes exactly its own range ------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-ipcbytes-"));
  try {
    const backing = new Uint8Array([0, 0, 10, 11, 12, 13, 0, 0]);
    const view = backing.subarray(2, 6);
    const f = path.join(dir, "sub.bin");
    await fs.promises.writeFile(f, asWritable(view));
    check("subarray view: only its bytes land on disk", [...fs.readFileSync(f)], [10, 11, 12, 13]);

    const f2 = path.join(dir, "full.bin");
    const payload = new Uint8Array(1024 * 1024).map((_, i) => (i * 31) & 0xff);
    await fs.promises.writeFile(f2, asWritable(payload));
    check("1 MB round-trips byte-for-byte", Buffer.compare(fs.readFileSync(f2), Buffer.from(payload)), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 3. everything else converts exactly as Buffer.from did -------------------------
  const ab = new Uint8Array([5, 6, 7]).buffer;
  const fromAb = asWritable(ab);
  check("ArrayBuffer: converted to a Buffer with the same bytes", [Buffer.isBuffer(fromAb), [...fromAb]], [true, [5, 6, 7]]);
  const fromArr = asWritable([1, 2, 255]);
  check("number[]: converted", [Buffer.isBuffer(fromArr), [...fromArr]], [true, [1, 2, 255]]);
  const fromStr = asWritable("Việt");
  check("string: converted as utf8", fromStr.toString("utf8"), "Việt");
  // `writeFile` itself would reject a bare ArrayBuffer — prove the fallback is load-bearing
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-ipcbytes-"));
  try {
    let bareThrows = false;
    try {
      await fs.promises.writeFile(path.join(dir2, "x"), ab);
    } catch (_) {
      bareThrows = true;
    }
    check("control: writeFile rejects a bare ArrayBuffer (so the fallback matters)", bareThrows, true);
    await fs.promises.writeFile(path.join(dir2, "y"), asWritable(ab));
    check("…but asWritable(ArrayBuffer) writes fine", [...fs.readFileSync(path.join(dir2, "y"))], [5, 6, 7]);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // ---- 4. missing data still throws like before ----------------------------------------
  for (const [label, v] of [["undefined", undefined], ["null", null]]) {
    let name = "no throw";
    try {
      asWritable(v);
    } catch (e) {
      name = e.name;
    }
    check(`${label}: still throws TypeError (handler's try/catch unchanged)`, name, "TypeError");
  }

  // ---- 5. main.js has no copy inside a writeFile call -------------------------------------
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const offenders = main
    .split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /writeFile\(/.test(l) && /Buffer\.from\(/.test(l) && !/^\s*\/\//.test(l))
    .map(([n]) => n);
  check("main.js: no writeFile(…, Buffer.from(…)) (use asWritable)", offenders, []);
  check("main.js: the four byte-writing handlers use asWritable", (main.match(/writeFile\([^;]*asWritable\(/g) || []).length >= 4, true);
  check("main.js requires ./ipc-bytes", /require\("\.\/ipc-bytes"\)/.test(main), true);

  console.log(`\nipc-bytes: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
