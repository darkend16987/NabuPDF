"use strict";

/**
 * Single entry point for the desktop JS test suite — the counterpart of the repo
 * root's `run_tests.py`. `/deploy` runs this, so a suite that exists but is not
 * wired in can no longer ship a regression silently.
 *
 * Each `test/*.test.js` is a plain script that exits non-zero on failure (no test
 * framework in the repo), so every file runs in its own child process: module-level
 * state and `process.exit` in one file cannot leak into the next.
 *
 * Usage:
 *   npm test                  # run all
 *   npm test -- tabs wire     # run the subset whose file name contains any selector
 *
 * Exit code is 0 only if every selected file exits 0 (and at least one matched).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TEST_DIR = path.join(__dirname, "..", "test");
const selectors = process.argv.slice(2);

const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => selectors.length === 0 || selectors.some((s) => f.includes(s)))
  .sort();

if (files.length === 0) {
  console.error("No test files matched.");
  process.exit(1);
}

const results = [];
for (const f of files) {
  console.log(`\n${"=".repeat(60)}\nRUN ${f}\n${"=".repeat(60)}`);
  const t0 = Date.now();
  const proc = spawnSync(process.execPath, [path.join(TEST_DIR, f)], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
  results.push({ f, ok: proc.status === 0, secs: (Date.now() - t0) / 1000, signal: proc.signal });
}

console.log(`\n${"=".repeat(60)}\nSUMMARY\n${"=".repeat(60)}`);
let passed = 0;
for (const r of results) {
  if (r.ok) passed++;
  const why = r.ok ? "" : r.signal ? ` [killed: ${r.signal}]` : "";
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.f}  (${r.secs.toFixed(1)}s)${why}`);
}
console.log(`\n${passed}/${results.length} test files passed.`);
process.exit(passed === results.length ? 0 : 1);
