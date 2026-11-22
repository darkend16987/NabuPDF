"use strict";

// BI-141 / ma trận §5 hàng 28 — GUARD ĐÓNG (BI-6) trong APP ELECTRON THẬT, đường NÚT X của cửa sổ.
//
// Tự động hoá ca test tay "nút X vs menu Thoát vs Ctrl+Q — cả 3 đường": CHỈ đường nút X (WM_CLOSE — `taskkill /PID` không kèm /F,
// đúng thứ Windows gửi khi bấm ✕/Alt+F4). HAI ĐƯỜNG CÒN LẠI (menu Thoát, Ctrl+Q) đi qua `role:"quit"` của menu NATIVE: CDP không bấm
// được, và gửi phím thật cho cửa sổ nền trước có thể rơi vào một cửa sổ khác của người dùng — chúng VẪN LÀ TEST TAY.
//
// Đo trên app thật (hộp "Lưu / Không lưu / Huỷ" là hộp NATIVE do móc hộp thoại trả lời):
//   C1  tài liệu SẠCH: đóng ⇒ thoát ngay, KHÔNG hộp thoại.
//   C2  tài liệu BẨN + "Huỷ": hộp đúng nhãn/mặc định (Lưu = mặc định, Esc = Huỷ), app SỐNG, tài liệu còn nguyên từng byte, khe phục
//       hồi còn đó.
//   C3  cùng app, "Không lưu": thoát; khe phục hồi bị xoá; file trên đĩa y nguyên.
//   C4  bẩn + CÓ đường dẫn + "Lưu": ghi đúng file đó (không hỏi Lưu thành), rồi thoát; file mang thay đổi.
//   C5  bẩn + KHÔNG đường dẫn + "Lưu" + chọn nơi lưu: ghi ra nơi đã chọn rồi thoát.
//   C6  bẩn + KHÔNG đường dẫn + "Lưu" nhưng HUỶ hộp Lưu thành: app KHÔNG ĐƯỢC thoát (đóng giữa chừng sẽ mất dữ liệu), tài liệu còn bẩn.
//
// Cần phiên có giao diện. Không cần sidecar (sidecar:false) — chỉ file ghi qua `file:write-pdf` thường.
//
// Chạy:  cd desktop ; node e2e/close-guard.e2e.js     (hoặc: npm run e2e -- close)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { launch } = require("./lib/app-driver");
const { makePdf } = require("./lib/fixtures");

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};

const HASH = `(async () => { const d = await crypto.subtle.digest("SHA-256", state.bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); })()`;

const slotDir = (app, docId) => path.join(app.userDataDir, "recovery", docId);
const rotateFirst = (page) => page.eval(`(async () => { state.selected = new Set([0]); await rotateSelected(90); })()`);
const confirmBoxes = (app) => app.dialogs.calls().filter((c) => c.method === "showMessageBox");

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-close-"));
  const doc = await makePdf(3);
  const rotationsOf = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPages().map((p) => p.getRotation().angle);
  let app = null;
  try {
    // ---- C1: sạch ⇒ thoát ngay, không hỏi ---------------------------------------------------------------
    console.log("C1  tài liệu SẠCH + nút X ⇒ thoát ngay, không hộp thoại");
    app = await launch();
    let page = await app.ready({ sidecar: false });
    await app.openPdf(doc, "sach.pdf");
    app.dialogs.answer({});
    expect(app.requestClose(), "đã gửi WM_CLOSE (đường nút X)");
    expect(await app.waitExit(20000), "app thoát");
    expect(confirmBoxes(app).length === 0, `không hộp thoại nào (${confirmBoxes(app).length})`);
    await app.close();

    // ---- C2 + C3: bẩn ⇒ hỏi; Huỷ giữ nguyên; Không lưu thoát + xoá khe --------------------------------
    console.log("\nC2  tài liệu BẨN + nút X + 'Huỷ' ⇒ app SỐNG, tài liệu nguyên, khe phục hồi còn");
    app = await launch();
    page = await app.ready({ sidecar: false });
    const diskFile = path.join(work, "co-duong-dan.pdf");
    fs.writeFileSync(diskFile, doc);
    await app.openPdf(doc, "co-duong-dan.pdf", { srcPath: diskFile });
    await rotateFirst(page);
    const docId = await page.eval(`state.docId`);
    await page.eval(`autosaveTick()`); // bảo đảm khe phục hồi tồn tại để C3 chứng minh nó bị xoá
    const hBefore = await page.eval(HASH);
    expect(fs.existsSync(path.join(slotDir(app, docId), "autosave.pdf")), "tiền điều kiện: khe phục hồi đã có trên đĩa");
    app.dialogs.answer({ showMessageBox: [2] });
    app.requestClose();
    await page.waitFor(`true`, { timeout: 1000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    const boxes = confirmBoxes(app);
    expect(boxes.length === 1, `đúng 1 hộp hiện ra (${boxes.length})`);
    const o = (boxes[0] && boxes[0].options) || {};
    expect(JSON.stringify(o.buttons) === JSON.stringify(["Lưu", "Không lưu", "Huỷ"]), `nhãn nút: ${JSON.stringify(o.buttons)}`);
    expect(o.defaultId === 0 && o.cancelId === 2, `mặc định = Lưu (0), Esc = Huỷ (2): ${o.defaultId}/${o.cancelId}`);
    expect(/chưa lưu/.test(o.message || ""), `nội dung hộp: ${JSON.stringify(o.message)}`);
    expect(app.alive(), "app VẪN SỐNG sau 'Huỷ'");
    const after = await page.eval(`({ dirty: state.dirty, title: document.title })`).catch(() => null);
    expect(after && after.dirty === true && after.title.startsWith("●"), `tài liệu còn bẩn, còn chấm ●: ${JSON.stringify(after)}`);
    expect((await page.eval(HASH)) === hBefore, "tài liệu còn nguyên TỪNG BYTE");
    expect(fs.existsSync(path.join(slotDir(app, docId), "autosave.pdf")), "'Huỷ' KHÔNG xoá khe phục hồi");
    expect(confirmBoxes(app).length === 1, "không hiện hộp thứ hai");
    expect(fs.readFileSync(diskFile).equals(doc), "file trên đĩa chưa bị đụng");

    console.log("\nC3  cùng app, nút X + 'Không lưu' ⇒ thoát, xoá khe phục hồi, đĩa y nguyên");
    app.dialogs.answer({ showMessageBox: [1] });
    app.requestClose();
    expect(await app.waitExit(20000), "app thoát");
    expect(confirmBoxes(app).length === 1, `đã hỏi đúng 1 lần (${confirmBoxes(app).length})`);
    expect(!fs.existsSync(slotDir(app, docId)), "khe phục hồi đã bị xoá (đóng có chủ ý không để lại bản 'sập')");
    expect(fs.readFileSync(diskFile).equals(doc), "file trên đĩa y nguyên (Không lưu ⇒ không ghi)");
    await app.close();

    // ---- C4: có đường dẫn + Lưu ⇒ ghi đúng file đó, không hỏi Lưu thành ---------------------------------
    console.log("\nC4  bẩn + CÓ đường dẫn + 'Lưu' ⇒ ghi vào đúng file đó rồi thoát");
    app = await launch();
    page = await app.ready({ sidecar: false });
    const f4 = path.join(work, "c4.pdf");
    fs.writeFileSync(f4, doc);
    await app.openPdf(doc, "c4.pdf", { srcPath: f4 });
    await rotateFirst(page);
    const docId4 = await page.eval(`state.docId`);
    await page.eval(`autosaveTick()`); // có khe phục hồi trước khi đóng — để chứng minh "Lưu" rồi đóng KHÔNG để lại nó (BI-142)
    expect(fs.existsSync(path.join(slotDir(app, docId4), "autosave.pdf")), "tiền điều kiện: khe phục hồi đã có trên đĩa");
    app.dialogs.answer({ showMessageBox: [0] });
    app.requestClose();
    expect(await app.waitExit(25000), "app thoát sau khi lưu");
    expect(!fs.existsSync(slotDir(app, docId4)), "khe phục hồi đã bị xoá sau 'Lưu' + đóng (BI-142: trước đây còn lại 6/6 lần)");
    expect(JSON.stringify(await rotationsOf(f4)) === JSON.stringify([90, 0, 0]), `file mang thay đổi (xoay trang 1): ${JSON.stringify(await rotationsOf(f4))}`);
    expect(app.dialogs.calls().filter((c) => c.method === "showSaveDialog").length === 0, "không hỏi Lưu thành (đã có đường dẫn)");
    expect(!fs.readdirSync(work).some((f) => f.endsWith(".nabu-tmp")), "không còn file .nabu-tmp (BI-136)");
    await app.close();

    // ---- C5: không đường dẫn + Lưu + chọn nơi lưu --------------------------------------------------------
    console.log("\nC5  bẩn + KHÔNG đường dẫn + 'Lưu' + chọn nơi lưu ⇒ ghi ra đó rồi thoát");
    app = await launch();
    page = await app.ready({ sidecar: false });
    await app.openPdf(doc, "moi.pdf");
    await rotateFirst(page);
    const f5 = path.join(work, "c5-da-chon.pdf");
    app.dialogs.answer({ showMessageBox: [0], showSaveDialog: [f5] });
    app.requestClose();
    expect(await app.waitExit(25000), "app thoát sau khi lưu");
    expect(fs.existsSync(f5) && JSON.stringify(await rotationsOf(f5)) === JSON.stringify([90, 0, 0]), "file ra đúng nơi đã chọn, mang thay đổi");
    expect(app.dialogs.calls().filter((c) => c.method === "showSaveDialog").length === 1, "hộp Lưu thành hiện đúng 1 lần");
    await app.close();

    // ---- C6: Lưu nhưng HUỶ hộp Lưu thành ⇒ KHÔNG được thoát ---------------------------------------------
    console.log("\nC6  bẩn + KHÔNG đường dẫn + 'Lưu' nhưng HUỶ hộp Lưu thành ⇒ app KHÔNG thoát");
    app = await launch();
    page = await app.ready({ sidecar: false });
    await app.openPdf(doc, "chua-luu.pdf");
    await rotateFirst(page);
    const h6 = await page.eval(HASH);
    app.dialogs.answer({ showMessageBox: [0], showSaveDialog: [null] });
    app.requestClose();
    await new Promise((r) => setTimeout(r, 4000));
    expect(app.alive(), "app VẪN SỐNG (đóng giữa chừng sẽ mất công việc chưa lưu)");
    const s6 = await page.eval(`({ dirty: state.dirty, title: document.title })`).catch(() => null);
    expect(s6 && s6.dirty === true && s6.title.startsWith("●"), `tài liệu còn bẩn: ${JSON.stringify(s6)}`);
    expect((await page.eval(HASH)) === h6, "tài liệu còn nguyên từng byte");
    expect(app.dialogs.calls().filter((c) => c.method === "showSaveDialog").length === 1, "đã hỏi Lưu thành đúng 1 lần");
    expect(!fs.readdirSync(work).some((f) => /chua-luu/.test(f)), "không file nào được tạo");

    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ ở lần chạy cuối (${app.dialogs.unexpected().length})`);
    await app.close();
    app = null;
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    if (app) console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    if (app) await app.close().catch(() => {});
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
  console.log("Guard đóng (đường nút X) đúng ở cả 6 ca. Menu Thoát / Ctrl+Q vẫn phải test tay (menu native).");
})();
