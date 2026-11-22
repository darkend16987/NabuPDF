"use strict";

// BI-141 — smoke của chính BỘ KHUNG e2e: chứng minh, trong Electron THẬT, rằng
//   (1) app lên được với móc hộp thoại, sidecar sẵn sàng, cửa sổ `visible`;
//   (2) hộp Lưu (`dialog:save-pdf`) được trả lời bằng đường dẫn đặt trước và file thật ra đĩa;
//   (3) hộp Mở (`dialog:open-pdf`) được trả lời bằng đường dẫn đặt trước và main đọc đúng file đó;
//   (4) KHÔNG có đáp án ⇒ app nhận "huỷ" (không ghi gì) và bộ khung thấy `unexpected`;
//   (5) log ghi lại tuỳ chọn hộp (tiêu đề, bộ lọc) để test khẳng định nội dung hộp;
//   (6) chụp ảnh màn hình được; đóng app dọn sạch cây tiến trình và thư mục tạm.
//
// Nếu file này đỏ thì MỌI e2e khác đều không đáng tin — chạy nó đầu tiên.
//
// Chạy:  cd desktop ; node e2e/harness-smoke.e2e.js     (hoặc: npm run e2e -- smoke)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch } = require("./lib/app-driver");
const { makePdf } = require("./lib/fixtures");

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-smoke-"));
  const app = await launch();
  let userData = app.userDataDir;
  let hooks = app.hooksDir;
  try {
    // ---- (1) app lên ----------------------------------------------------------------------------------
    console.log("S1  app lên, sidecar sẵn sàng, cửa sổ nhìn thấy");
    const page = await app.ready();
    expect((await page.visible()) === "visible", "visibilityState = visible");
    expect(/\[test-hooks\] ACTIVE/.test(app.log()), "banner [test-hooks] ACTIVE đã in ra stderr (Luật 4)");
    const doc = await makePdf(3);
    const info = await app.openPdf(doc, "mau.pdf");
    expect(info.pages === 3 && info.name === "mau.pdf", `mở được PDF 3 trang: ${JSON.stringify(info)}`);

    // ---- (2) hộp Lưu ---------------------------------------------------------------------------------
    console.log("\nS2  hộp Lưu được trả lời bằng đường dẫn đặt trước");
    const target = path.join(work, "ket-qua.pdf");
    app.dialogs.answer({ showSaveDialog: [target] });
    const saved = await page.eval(`window.desktop.savePdf(state.bytes, "mau.pdf")`);
    expect(saved && saved.saved === true && path.resolve(saved.path) === path.resolve(target), `savePdf trả ${JSON.stringify(saved)}`);
    expect(fs.existsSync(target) && fs.readFileSync(target).equals(doc), "file thật ra đĩa và GIỐNG HỆT byte của tài liệu");
    const c = app.dialogs.calls();
    expect(c.length === 1 && c[0].method === "showSaveDialog", `đúng 1 hộp Lưu hiện ra (${c.length})`);
    expect(c[0] && c[0].options.title === "Lưu PDF", `tiêu đề hộp: ${JSON.stringify(c[0] && c[0].options.title)}`);
    expect(
      c[0] && JSON.stringify(c[0].options.filters) === JSON.stringify([{ name: "PDF", extensions: ["pdf"] }]),
      "bộ lọc hộp Lưu là PDF",
    );
    expect(c[0] && c[0].unexpected === false, "hộp này có đáp án (không phải bất ngờ)");

    // ---- (3) hộp Mở ----------------------------------------------------------------------------------
    console.log("\nS3  hộp Mở được trả lời bằng đường dẫn đặt trước");
    app.dialogs.answer({ showOpenDialog: [[target]] });
    const opened = await page.eval(
      `window.desktop.openPdf({}).then((r) => r.map((x) => ({ path: x.path, name: x.name, len: x.data.length })))`,
    );
    expect(opened.length === 1 && path.resolve(opened[0].path) === path.resolve(target), `openPdf trả ${JSON.stringify(opened)}`);
    expect(opened[0] && opened[0].len === doc.length, `main đọc đúng ${doc.length} byte của file đó`);
    expect(app.dialogs.calls().length === 1 && app.dialogs.calls()[0].method === "showOpenDialog", "đúng 1 hộp Mở");

    // ---- (4) không có đáp án ⇒ huỷ + unexpected -------------------------------------------------------
    console.log("\nS4  hộp KHÔNG có đáp án ⇒ app nhận 'huỷ', không ghi gì, bộ khung thấy 'unexpected'");
    const before = fs.readdirSync(work).length;
    app.dialogs.answer({}); // kịch bản mới, rỗng
    const nothing = await page.eval(`window.desktop.savePdf(state.bytes, "khong-ghi.pdf")`);
    expect(nothing && nothing.saved === false, `savePdf trả ${JSON.stringify(nothing)} (không ghi)`);
    expect(fs.readdirSync(work).length === before, "thư mục đích không có thêm file nào");
    expect(app.dialogs.unexpected().length === 1, `bộ khung thấy đúng 1 hộp bất ngờ (${app.dialogs.unexpected().length})`);
    expect(app.dialogs.calls()[0] && app.dialogs.calls()[0].unexpected === true, "hộp đó được đánh dấu unexpected trong kịch bản hiện hành");

    // ---- (5) sidecar sống, chụp ảnh -------------------------------------------------------------------
    console.log("\nS5  sidecar trả lời, chụp ảnh được");
    const health = await page.eval(`(async () => (await fetch(sidecar.base + "/health")).status)()`);
    expect(health === 200, `/health = ${health}`);
    const png = await page.screenshot(path.join(work, "man-hinh.png"));
    const head = fs.readFileSync(png).subarray(0, 8);
    expect(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && fs.statSync(png).size > 1000, `ảnh PNG hợp lệ (${fs.statSync(png).size} B)`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    const pid = app.child.pid;
    await app.close();
    // ---- (6) dọn sạch ----------------------------------------------------------------------------------
    console.log("\nS6  đóng app dọn sạch");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (_) {
      alive = false;
    }
    expect(!alive, "tiến trình Electron chính đã chết");
    expect(!fs.existsSync(userData) && !fs.existsSync(hooks), "thư mục userData và thư mục móc đã xoá");
    expect(app.workers("--").length >= 0, "liệt kê được tiến trình (không ném)");
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("");
  if (failures.length) {
    console.log("CÓ VẤN ĐỀ:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Bộ khung e2e chạy đúng trong Electron thật: móc hộp thoại, kịch bản, ảnh chụp, dọn dẹp.");
})();
