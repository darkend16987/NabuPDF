"use strict";

/**
 * Bộ chạy e2e (BI-141) — chị em của `run-tests.js`, nhưng CHO app Electron thật.
 *
 *   cd desktop ; npm run e2e                 # chạy tất cả `e2e/*.e2e.js`
 *   cd desktop ; npm run e2e -- smoke split  # chỉ những file có tên chứa một trong các từ khoá
 *
 * KHÔNG nằm trong `npm test` và KHÔNG là cổng của /deploy: cần phiên có giao diện (cửa sổ Electron thật), sidecar Python
 * (.venv), và một số kịch bản cần corpus/OpenSSL ngoài repo. Mỗi file chạy trong tiến trình riêng.
 *
 * Mã thoát của MỘT file: 0 = đạt · 1 = hỏng · 2 = BỎ QUA (thiếu điều kiện tiên quyết, vd corpus). BỎ QUA không làm cả đợt đỏ
 * nhưng được in rõ — một kịch bản bị bỏ qua thì CHƯA được kiểm, đừng đọc nó là "xanh".
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = path.join(__dirname, "..", "e2e");
const selectors = process.argv.slice(2);

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".e2e.js"))
  .filter((f) => selectors.length === 0 || selectors.some((s) => f.includes(s)))
  .sort();

if (files.length === 0) {
  console.error("Không có file e2e nào khớp.");
  process.exit(1);
}

const results = [];
for (const f of files) {
  console.log(`\n${"=".repeat(60)}\nE2E ${f}\n${"=".repeat(60)}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: "inherit", cwd: path.join(__dirname, "..") });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const status = r.status === 0 ? "PASS" : r.status === 2 ? "SKIP" : "FAIL";
  results.push({ f, status, secs });
}

console.log(`\n${"=".repeat(60)}\nKẾT QUẢ e2e\n${"=".repeat(60)}`);
for (const r of results) console.log(`  ${r.status}  ${r.f}  (${r.secs}s)`);
const pass = results.filter((r) => r.status === "PASS").length;
const skip = results.filter((r) => r.status === "SKIP").length;
const fail = results.filter((r) => r.status === "FAIL").length;
console.log(`\n${pass} đạt, ${fail} hỏng, ${skip} bỏ qua (CHƯA kiểm) / ${results.length} file.`);
process.exit(fail === 0 ? 0 : 1);
