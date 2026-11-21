#!/usr/bin/env node
"use strict";

// Quét corpus: mở → sửa → lưu MỌI file PDF trong một thư mục, rồi soi kết quả bằng một trọng
// tài ĐỘC LẬP (qpdf). Mượn từ PdfCraft — xem docs/RESEARCH-2026-11-21-pdfcraft-learnings.md §2.4.
//
//   node desktop/scripts/corpus-sweep.js [--limit 50] [--jobs 6] [--filter rotat]
//   node desktop/scripts/corpus-sweep.js --update-baseline
//
// VÌ SAO: lưới `npm test` không chạy được đường ghi file thật (pdf-lib) trên file đời thật.
// Lưới này chạy — trên 1.100 file méo đủ kiểu của bộ test pdf.js — và bắt đúng loại lỗi mà
// test đơn vị không thấy: file lưu ra xong thì hỏng, mất trang, mất góc xoay, pdf-lib treo.
//
// NÓ KHÔNG phải cổng của /deploy: cần corpus (153 MB) và qpdf nằm NGOÀI repo. Chạy tay khi
// đụng vào đường đọc/ghi PDF, hoặc trước một bản phát hành.
//
// Cài đặt một lần (đường dẫn mặc định, đổi được bằng biến môi trường):
//   corpus : D:\GitHub\_refs\pdfjs-corpus\test\pdfs   (NABU_CORPUS_DIR)
//            git clone --filter=blob:none --no-checkout --depth 1 \
//              https://github.com/mozilla/pdf.js.git pdfjs-corpus
//            cd pdfjs-corpus && git sparse-checkout init --cone \
//              && git sparse-checkout set test/pdfs && git checkout
//   qpdf   : D:\GitHub\_refs\tools\qpdf\qpdf-12.4.2-msvc64\bin\qpdf.exe   (NABU_QPDF)
//            https://github.com/qpdf/qpdf/releases (bản *-msvc64.zip, giải nén là chạy)
//
// Kết quả: desktop/.sweep/report.json (không commit) + bảng tóm tắt ra màn hình.
// Mốc so sánh: desktop/test/corpus-baseline.json (CÓ commit). Thoát 1 khi có file xấu đi so
// với mốc — đó là tín hiệu "thay đổi vừa rồi làm hỏng thêm", không phải "corpus có file hỏng".

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HERE = __dirname;
const DESKTOP = path.resolve(HERE, "..");
const DEFAULT_CORPUS = "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
const DEFAULT_QPDF = "D:\\GitHub\\_refs\\tools\\qpdf\\qpdf-12.4.2-msvc64\\bin\\qpdf.exe";
const BASELINE = path.join(DESKTOP, "test", "corpus-baseline.json");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes("--" + name);

const corpusDir = path.resolve(arg("corpus", process.env.NABU_CORPUS_DIR || DEFAULT_CORPUS));
const qpdf = path.resolve(arg("qpdf", process.env.NABU_QPDF || DEFAULT_QPDF));
const limit = Number(arg("limit", "0")) || 0;
const filter = arg("filter", "");
const timeoutMs = Number(arg("timeout", "60000"));
const jobs = Math.max(1, Math.min(16, Number(arg("jobs", String(Math.max(2, Math.min(8, os.cpus().length - 1)))))));
const outPath = path.resolve(arg("out", path.join(DESKTOP, ".sweep", "report.json")));

function die(msg) {
  console.error("\n" + msg + "\n");
  process.exit(2);
}

if (!fs.existsSync(corpusDir)) die("Không thấy corpus: " + corpusDir + "\nXem phần hướng dẫn ở đầu file này.");
if (!fs.existsSync(qpdf)) die("Không thấy qpdf: " + qpdf + "\nXem phần hướng dẫn ở đầu file này.");

const files = fs
  .readdirSync(corpusDir)
  .filter((f) => f.toLowerCase().endsWith(".pdf"))
  .filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()))
  .sort();
const todo = limit ? files.slice(0, limit) : files;
if (!todo.length) die("Không có file .pdf nào khớp trong " + corpusDir);

// Mỗi file một tiến trình con, có hạn giờ: file méo làm pdf-lib treo thì giết riêng nó.
function sweepOne(file) {
  return new Promise((resolve) => {
    const full = path.join(corpusDir, file);
    const child = spawn(process.execPath, [path.join(HERE, "corpus-sweep-one.js"), full], {
      env: Object.assign({}, process.env, { NABU_QPDF: qpdf }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGKILL");
        } catch (_) {}
        resolve({ file, verdict: "timeout", note: timeoutMs + " ms", ms: timeoutMs });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop();
      try {
        resolve(JSON.parse(line));
      } catch (_) {
        resolve({
          file,
          verdict: code === 0 ? "harness_error" : "crash",
          note: (err || out || "exit " + code).slice(0, 300),
        });
      }
    });
  });
}

async function run() {
  const results = [];
  let next = 0;
  let finished = 0;
  const t0 = Date.now();

  const tick = () => {
    if (!process.stderr.isTTY) return;
    const pct = Math.round((finished / todo.length) * 100);
    process.stderr.write("\r  " + finished + "/" + todo.length + " (" + pct + "%)   ");
  };

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const r = await sweepOne(todo[i]);
      results.push(r);
      finished++;
      tick();
    }
  }

  console.error("corpus : " + corpusDir + "  (" + todo.length + " file" + (limit ? ", giới hạn --limit" : "") + ")");
  console.error("qpdf   : " + qpdf);
  console.error("jobs   : " + jobs + ", timeout " + timeoutMs + " ms\n");

  await Promise.all(Array.from({ length: jobs }, worker));
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(30) + "\r");

  results.sort((a, b) => a.file.localeCompare(b.file));
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);

  const summary = {};
  for (const r of results) summary[r.verdict] = (summary[r.verdict] || 0) + 1;

  const report = {
    generated: new Date().toISOString(),
    corpus: { dir: corpusDir, files: todo.length, commit: corpusCommit() },
    qpdf: qpdf,
    seconds: Number(seconds),
    summary,
    results,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1));

  printSummary(report);
  if (has("update-baseline")) return writeBaseline(report);
  return compareBaseline(report);
}

function corpusCommit() {
  // Corpus được ghim theo commit: một bản corpus khác thì con số không so được với nhau.
  try {
    const git = path.resolve(corpusDir, "..", "..", ".git");
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) return fs.readFileSync(path.join(git, head.slice(5)), "utf8").trim();
    return head;
  } catch (_) {
    return null;
  }
}

// Thứ tự in: nặng trước. "ok", "encrypted", "broken_input" là trạng thái bình thường của corpus.
const ORDER = [
  "crash",
  "timeout",
  "harness_error",
  "save_fail",
  "edit_fail",
  "reopen_fail",
  "rotate_lost",
  "pagecount_changed",
  "output_error",
  "output_warn",
  "load_fail",
  "load_fail_broken_input",
  "broken_input",
  "encrypted",
  "ok",
];
const BENIGN = new Set(["ok", "encrypted", "broken_input", "load_fail_broken_input"]);

function printSummary(report) {
  const names = Object.keys(report.summary).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  console.log("\n=== Quét corpus: " + report.corpus.files + " file trong " + report.seconds + " s ===\n");
  for (const n of names) {
    const flag = BENIGN.has(n) ? "   " : " ! ";
    console.log(flag + n.padEnd(24) + String(report.summary[n]).padStart(5));
  }
  const bad = report.results.filter((r) => !BENIGN.has(r.verdict));
  if (bad.length) {
    console.log("\n--- file đáng nhìn (tối đa 25) ---");
    for (const r of bad.slice(0, 25)) {
      const detail = r.note || (r.noop && r.noop.text) || (r.rotate && r.rotate.text) || "";
      console.log("  " + r.verdict.padEnd(18) + r.file + (detail ? "  — " + detail.slice(0, 110) : ""));
    }
    if (bad.length > 25) console.log("  … còn " + (bad.length - 25) + " file nữa, xem " + outPath);
  }
  console.log("\nbáo cáo đầy đủ: " + outPath);
}

function knownOf(report) {
  const known = {};
  for (const r of report.results) if (!BENIGN.has(r.verdict)) known[r.file] = r.verdict;
  return known;
}

function writeBaseline(report) {
  const data = {
    note: "Mốc của lưới quét corpus (desktop/scripts/corpus-sweep.js). 'known' chỉ liệt kê file KHÔNG sạch; file xấu đi so với đây là hồi quy.",
    corpus: report.corpus,
    generated: report.generated,
    summary: report.summary,
    known: knownOf(report),
  };
  fs.writeFileSync(BASELINE, JSON.stringify(data, null, 1) + "\n");
  console.log("\nĐã ghi mốc: " + BASELINE + " (" + Object.keys(data.known).length + " file không sạch)");
  return 0;
}

function compareBaseline(report) {
  if (!fs.existsSync(BASELINE)) {
    console.log("\nChưa có mốc. Tạo bằng:  node desktop/scripts/corpus-sweep.js --update-baseline");
    return 0;
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (base.corpus && report.corpus.commit && base.corpus.commit && base.corpus.commit !== report.corpus.commit) {
    console.log("\nCẢNH BÁO: corpus khác commit với mốc (" + String(base.corpus.commit).slice(0, 10) + " ≠ " + String(report.corpus.commit).slice(0, 10) + ") — con số không so thẳng được.");
  }
  const now = knownOf(report);
  const seen = new Set(report.results.map((r) => r.file));
  const worse = [];
  const better = [];
  for (const f of Object.keys(now)) if (!base.known[f] || base.known[f] !== now[f]) worse.push(f + ": " + (base.known[f] || "ok") + " → " + now[f]);
  for (const f of Object.keys(base.known)) if (seen.has(f) && !now[f]) better.push(f + ": " + base.known[f] + " → ok");

  if (better.length) {
    console.log("\n--- đã sạch hơn mốc (" + better.length + ") ---");
    for (const l of better.slice(0, 15)) console.log("  " + l);
    console.log("  Cập nhật mốc:  node desktop/scripts/corpus-sweep.js --update-baseline");
  }
  if (worse.length) {
    console.log("\n*** HỒI QUY so với mốc (" + worse.length + ") ***");
    for (const l of worse.slice(0, 25)) console.log("  " + l);
    return 1;
  }
  console.log("\nKhông có file nào xấu đi so với mốc.");
  return 0;
}

run().then(
  (code) => process.exit(code || 0),
  (e) => {
    console.error(e);
    process.exit(2);
  }
);
