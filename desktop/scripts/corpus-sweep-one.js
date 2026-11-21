#!/usr/bin/env node
"use strict";

// Quét MỘT file PDF của corpus — tiến trình con của scripts/corpus-sweep.js.
//
//   node desktop/scripts/corpus-sweep-one.js <file.pdf>
//
// Chạy riêng một tiến trình cho mỗi file là CỐ Ý: pdf-lib có thể treo hoặc nổ heap trên file
// méo, và tiến trình cha cần giết được nó mà không chết theo (đây chính là "watchdog bỏ qua
// trang bệnh lý" của PdfCraft, xem docs/RESEARCH-2026-11-21-pdfcraft-learnings.md §4).
//
// In ra stdout ĐÚNG MỘT dòng JSON. Mọi thứ khác (log của thư viện) đi stderr.
//
// Ba bước, theo đúng đường mà app thật đi khi lưu (pdf-lib là nơi MỌI đường lưu của renderer
// đi qua):
//   1. qpdf --check trên file GỐC   → biết file vốn đã hỏng hay chưa (corpus pdf.js cố tình
//      chứa file hỏng; không có bước này thì mọi lỗi đều đổ oan cho mình);
//   2. load → save KHÔNG sửa gì      → qpdf --check trên kết quả;
//   3. load → xoay trang 1 thêm 90°  → qpdf --check, rồi mở lại bằng pdf-lib để xác nhận
//      góc xoay thật sự còn đó sau vòng round-trip (BI-59/BI-65: bù xoay là việc của
//      primitive, và trang 0° phải ra byte y hệt).
//
// "Hỏng" chỉ được tính khi GỐC sạch mà KẾT QUẢ hỏng. Gốc hỏng sẵn → ghi nhận, không tính.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const QPDF = process.env.NABU_QPDF;

// qpdf: 0 = sạch, 3 = chỉ cảnh báo, 2 = lỗi. Mã khác (crash) coi như lỗi.
function qpdfCheck(file) {
  if (!QPDF) return { level: "skipped", text: "" };
  let status = 0;
  let out = "";
  try {
    out = execFileSync(QPDF, ["--check", file], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = typeof e.status === "number" ? e.status : 2;
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  const level = status === 0 ? "ok" : status === 3 ? "warn" : "error";
  // qpdf nói về mã hoá bằng "R = <revision>" + "stream encryption method:", KHÔNG phải
  // "File is encrypted" (file không mã hoá thì in "File is not encrypted").
  const encrypted = /encryption method:/i.test(out) || /^\s*R = \d/m.test(out);
  return { level, text: firstProblem(out), encrypted };
}

// Lấy dòng đầu tiên thật sự nói về lỗi/cảnh báo, để báo cáo đọc được.
function firstProblem(out) {
  const lines = String(out).split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (/no syntax or stream encoding errors found/i.test(t)) continue; // câu "sạch" của qpdf
    if (/^(WARNING|ERROR|qpdf:)/i.test(t)) return t.slice(0, 300);
  }
  return "";
}

async function main() {
  const file = process.argv[2];
  const res = {
    file: path.basename(file),
    bytes: 0,
    orig: null,
    pages: null,
    noop: null,
    rotate: null,
    verdict: "ok",
    note: "",
    ms: 0,
  };
  const t0 = Date.now();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-sweep-"));
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  };

  try {
    const bytes = fs.readFileSync(file);
    res.bytes = bytes.length;

    res.orig = qpdfCheck(file);
    if (res.orig.encrypted) {
      // pdf-lib + ignoreEncryption cho ra file vô nghĩa với tài liệu mã hoá; Nabu giải mã qua
      // sidecar trước. Ghi nhận rồi dừng, đừng tính là lỗi của mình.
      res.verdict = "encrypted";
      res.ms = Date.now() - t0;
      process.stdout.write(JSON.stringify(res) + "\n");
      return cleanup();
    }

    // Quét phải đi đúng đường mà app đi: renderer nạp bản vá này qua <script>, main qua require.
    require("../renderer/pdflib-stream-length.js").applyStreamLengthFix(require("pdf-lib"));
    const { PDFDocument, degrees } = require("pdf-lib");
    const loadOpts = { ignoreEncryption: true, updateMetadata: false };

    let doc;
    try {
      doc = await PDFDocument.load(bytes, loadOpts);
    } catch (e) {
      res.verdict = res.orig.level === "error" ? "load_fail_broken_input" : "load_fail";
      res.note = String(e && e.message).slice(0, 300);
      res.ms = Date.now() - t0;
      process.stdout.write(JSON.stringify(res) + "\n");
      return cleanup();
    }
    // Dấu hiệu thứ hai, do chính pdf-lib báo: chắc chắn hơn việc đọc chữ của qpdf.
    if (doc.isEncrypted) {
      res.verdict = "encrypted";
      res.ms = Date.now() - t0;
      process.stdout.write(JSON.stringify(res) + "\n");
      return cleanup();
    }

    // Mở được chưa chắc dùng được: cây trang có thể hỏng và chỉ nổ khi đi qua nó.
    try {
      res.pages = doc.getPageCount();
    } catch (e) {
      res.verdict = res.orig.level === "error" ? "load_fail_broken_input" : "load_fail";
      res.note = "getPageCount: " + String(e && e.message).slice(0, 280);
      res.ms = Date.now() - t0;
      process.stdout.write(JSON.stringify(res) + "\n");
      return cleanup();
    }

    // --- bước 2: lưu mà không sửa gì ---
    try {
      const outBytes = await doc.save({ updateFieldAppearances: false });
      const p = path.join(tmpDir, "noop.pdf");
      fs.writeFileSync(p, outBytes);
      res.noop = qpdfCheck(p);
      res.noop.bytes = outBytes.length;
      // Byte y hệt gần như không bao giờ xảy ra với pdf-lib (nó dựng lại file), nhưng ghi lại
      // để thấy mức phình: >2x là tín hiệu đáng nhìn.
      res.noop.growth = res.bytes ? +(outBytes.length / res.bytes).toFixed(2) : null;
    } catch (e) {
      res.noop = { level: "save_fail", text: String(e && e.message).slice(0, 300) };
    }

    // --- bước 3: một sửa đổi thật (xoay trang 1 thêm 90°) ---
    try {
      let want;
      let doc2;
      try {
        doc2 = await PDFDocument.load(bytes, loadOpts);
        const page = doc2.getPage(0);
        want = (page.getRotation().angle + 90) % 360;
        page.setRotation(degrees(want));
      } catch (e) {
        res.rotate = { level: "edit_fail", text: String(e && e.message).slice(0, 300) };
        throw { handled: true };
      }
      const outBytes = await doc2.save({ updateFieldAppearances: false });
      const p = path.join(tmpDir, "rot.pdf");
      fs.writeFileSync(p, outBytes);
      res.rotate = qpdfCheck(p);
      // Mở lại kết quả: góc xoay có sống qua round-trip không, và số trang có đổi không.
      try {
        const back = await PDFDocument.load(fs.readFileSync(p), loadOpts);
        res.rotate.angle = back.getPage(0).getRotation().angle;
        res.rotate.wanted = want;
        res.rotate.pages = back.getPageCount();
      } catch (e) {
        res.rotate.reopen = String(e && e.message).slice(0, 200);
      }
    } catch (e) {
      if (!(e && e.handled)) res.rotate = { level: "save_fail", text: String(e && e.message).slice(0, 300) };
    }

    res.verdict = verdictOf(res);
  } catch (e) {
    res.verdict = "harness_error";
    res.note = String(e && e.stack).slice(0, 500);
  }

  res.ms = Date.now() - t0;
  process.stdout.write(JSON.stringify(res) + "\n");
  cleanup();
}

// Xếp hạng một file thành MỘT từ. Thứ tự dưới đây là thứ tự nghiêm trọng giảm dần.
function verdictOf(res) {
  const orig = res.orig ? res.orig.level : "skipped";
  const steps = [res.noop, res.rotate];

  for (const s of steps) if (s && s.level === "save_fail") return "save_fail";
  for (const s of steps) if (s && s.level === "edit_fail") return orig === "error" ? "broken_input" : "edit_fail";
  if (res.rotate && res.rotate.reopen) return "reopen_fail";
  if (res.rotate && typeof res.rotate.angle === "number" && res.rotate.angle !== res.rotate.wanted)
    return "rotate_lost";
  if (res.rotate && typeof res.rotate.pages === "number" && res.rotate.pages !== res.pages)
    return "pagecount_changed";

  // Chỉ tính là mình làm hỏng khi GỐC không hỏng.
  if (orig !== "error") {
    for (const s of steps) if (s && s.level === "error") return "output_error";
    if (orig === "ok") for (const s of steps) if (s && s.level === "warn") return "output_warn";
  } else {
    for (const s of steps) if (s && s.level === "error") return "broken_input";
  }
  return "ok";
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({ file: path.basename(process.argv[2] || ""), verdict: "harness_error", note: String(e && e.stack).slice(0, 500) }) + "\n"
  );
});
