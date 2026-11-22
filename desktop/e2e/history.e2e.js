"use strict";

// BI-141 / ma trận §5 hàng 2–3 — LỊCH SỬ HOÀN TÁC (`pushUndo` · BI-3) trong APP ELECTRON THẬT.
//
// Tự động hoá ca test tay: "Ctrl+Z–Ctrl+Y sau xoay, xoá trang, chèn trang, sắp xếp lại, đánh số trang · chấm ● xuất hiện ·
// Lưu ra file mở lại được". Mỗi thao tác sửa tài liệu phải: (1) gọi `pushUndo()` TRƯỚC khi `state.bytes` đổi — quên thì mất Ctrl+Z
// HOẶC đóng cửa sổ mà không hỏi lưu; (2) bật cờ bẩn (chấm ● ở tiêu đề). Test này đo cả hai trên THAO TÁC THẬT, bằng SHA-256 của
// `state.bytes` (không phải "trông có vẻ đúng"):
//   · Hoàn tác trả về ĐÚNG byte trước thao tác; làm lại trả về ĐÚNG byte sau thao tác.
//   · Sửa mới sau khi hoàn tác xoá hàng đợi làm lại.
//   · Chuỗi 5 thao tác rồi hoàn tác hết ⇒ byte gốc; làm lại hết ⇒ byte cuối.
//   · Phím Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z đi qua handler `keydown` THẬT của trang (CDP `Input.dispatchKeyEvent`).
//   · Lưu qua hộp Lưu (móc hộp thoại) rồi MỞ LẠI từ đĩa bằng hộp Mở: số trang, góc xoay, nội dung trang còn đúng.
//
// KHÔNG phủ: bake chú thích và sửa nội dung (cần chuột/ô gõ — hàng 2 còn ghi "bake chú thích, sửa nội dung" cho test tay); ghép/chèn
// từ file khác (hộp chọn file). Xem BI-141.
//
// Chạy:  cd desktop ; node e2e/history.e2e.js     (hoặc: npm run e2e -- history)

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

// Trạng thái quan sát được của tài liệu đang mở. `hash` là SHA-256 của canonical bytes.
const SNAP = `(async () => {
  const d = await crypto.subtle.digest("SHA-256", state.bytes);
  const hash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, len: state.bytes.length, pages: state.numPages, dirty: !!state.dirty, title: document.title,
           undoOff: document.getElementById("btn-undo").disabled, redoOff: document.getElementById("btn-redo").disabled,
           nUndo: history.undo.length, nRedo: history.redo.length };
})()`;

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-history-"));
  const app = await launch();
  try {
    const page = await app.ready();
    const snap = () => page.eval(SNAP);
    const short = (s) => s.hash.slice(0, 8);
    const base = await makePdf(5);
    const fresh = async () => {
      app.dialogs.answer({});
      await app.openPdf(base, "lich-su.pdf");
      await page.clearToast();
      return snap();
    };

    // Các thao tác sửa tài liệu THẬT của app (đúng hàm mà nút/menu gọi).
    const OPS = [
      { name: "xoay trang 1 (+90°)", run: `(async () => { state.selected = new Set([0]); await rotateSelected(90); })()` },
      { name: "xoá trang 2 và 3", run: `(async () => { state.selected = new Set([1, 2]); await deleteSelected(); })()` },
      { name: "chèn trang trắng ở vị trí 2", run: `addBlankPageAt(2)` },
      { name: "sắp xếp lại: chuyển trang 1 xuống cuối", run: `reorderPage(0, state.numPages - 1)` },
      {
        name: "đánh số trang (qua sidecar)",
        run: `(async () => {
          document.getElementById("pgnum-fmt").value = "n"; document.getElementById("pgnum-pos").value = "bottom-center";
          document.getElementById("pgnum-start").value = "1"; document.getElementById("pgnum-skip").value = "0";
          await runPageNumbers(); })()`,
        timeout: 120000,
      },
    ];

    // ---- 1. từng thao tác: bẩn ●, hoàn tác = byte trước, làm lại = byte sau ----------------------------------
    for (const op of OPS) {
      console.log(`\n=== ${op.name} ===`);
      const s0 = await fresh();
      expect(s0.dirty === false && !s0.title.startsWith("●") && s0.undoOff && s0.redoOff, `tài liệu mới mở: sạch, Hoàn tác/Làm lại đều tắt (title "${s0.title}")`);
      await page.eval(op.run, { timeout: op.timeout || 60000 });
      const s1 = await snap();
      expect(s1.hash !== s0.hash, `thao tác đã đổi byte (${short(s0)} → ${short(s1)})`);
      expect(s1.dirty === true && s1.title.startsWith("●"), `cờ bẩn bật, tiêu đề có chấm ● ("${s1.title}")`);
      expect(s1.undoOff === false && s1.redoOff === true && s1.nUndo === 1, `Hoàn tác BẬT (1 bước), Làm lại tắt — pushUndo đã chạy đúng một lần (nUndo=${s1.nUndo})`);

      await page.eval(`undo()`);
      const s2 = await snap();
      expect(s2.hash === s0.hash, `HOÀN TÁC trả đúng byte trước thao tác (${short(s2)} = ${short(s0)})`);
      expect(s2.pages === s0.pages, `… và số trang (${s2.pages} = ${s0.pages})`);
      expect(s2.undoOff === true && s2.redoOff === false, "Hoàn tác tắt, Làm lại bật");

      await page.eval(`redo()`);
      const s3 = await snap();
      expect(s3.hash === s1.hash, `LÀM LẠI trả đúng byte sau thao tác (${short(s3)} = ${short(s1)})`);
      expect(s3.undoOff === false && s3.redoOff === true, "Hoàn tác bật, Làm lại tắt");
    }

    // ---- 2. sửa mới sau hoàn tác xoá hàng đợi làm lại -----------------------------------------------------
    console.log("\n=== sửa mới sau hoàn tác xoá hàng đợi Làm lại ===");
    await fresh();
    await page.eval(OPS[0].run);
    await page.eval(`undo()`);
    expect((await snap()).redoOff === false, "tiền điều kiện: sau hoàn tác, Làm lại đang bật");
    await page.eval(OPS[2].run);
    const sNew = await snap();
    expect(sNew.redoOff === true && sNew.nRedo === 0, `thao tác mới ⇒ hàng đợi Làm lại bị xoá (nRedo=${sNew.nRedo})`);

    // ---- 3. chuỗi nhiều thao tác: hoàn tác hết ⇒ gốc, làm lại hết ⇒ cuối ----------------------------------
    console.log("\n=== chuỗi 5 thao tác: hoàn tác hết ⇒ byte gốc; làm lại hết ⇒ byte cuối ===");
    const g = await fresh();
    for (const op of OPS) await page.eval(op.run, { timeout: op.timeout || 60000 });
    const last = await snap();
    expect(last.nUndo === OPS.length, `có đúng ${OPS.length} bước hoàn tác (nUndo=${last.nUndo})`);
    const hashes = [last.hash];
    for (let i = 0; i < OPS.length; i++) {
      await page.eval(`undo()`);
      hashes.push((await snap()).hash);
    }
    expect(hashes[hashes.length - 1] === g.hash, `hoàn tác hết ⇒ ĐÚNG byte gốc (${hashes[hashes.length - 1].slice(0, 8)} = ${short(g)})`);
    expect(new Set(hashes).size === hashes.length, "mỗi bước hoàn tác ra một trạng thái KHÁC nhau (không bước nào là no-op)");
    for (let i = 0; i < OPS.length; i++) await page.eval(`redo()`);
    expect((await snap()).hash === last.hash, "làm lại hết ⇒ ĐÚNG byte cuối");

    // ---- 4. phím Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z qua handler keydown thật ---------------------------------
    console.log("\n=== phím tắt (handler keydown thật của trang) ===");
    const k0 = await fresh();
    await page.eval(OPS[0].run);
    const k1 = await snap();
    await page.press("z", { ctrl: true });
    await page.waitFor(`document.getElementById("btn-redo").disabled === false`, { timeout: 10000, what: "Ctrl+Z có tác dụng" });
    expect((await snap()).hash === k0.hash, "Ctrl+Z hoàn tác về byte gốc");
    await page.press("y", { ctrl: true });
    await page.waitFor(`document.getElementById("btn-redo").disabled === true`, { timeout: 10000, what: "Ctrl+Y có tác dụng" });
    expect((await snap()).hash === k1.hash, "Ctrl+Y làm lại về byte sau thao tác");
    await page.press("z", { ctrl: true });
    await page.waitFor(`document.getElementById("btn-redo").disabled === false`, { timeout: 10000, what: "Ctrl+Z lần hai" });
    await page.press("z", { ctrl: true, shift: true });
    await page.waitFor(`document.getElementById("btn-redo").disabled === true`, { timeout: 10000, what: "Ctrl+Shift+Z có tác dụng" });
    expect((await snap()).hash === k1.hash, "Ctrl+Shift+Z cũng làm lại");

    // ---- 4b. ảnh chụp hoàn tác ĐỘC LẬP với byte sống ------------------------------------------------------
    // `snapshot()` sao chép byte (`.slice()`), nên một writer ghi TẠI CHỖ vào `state.bytes` SAU `pushUndo()` không làm hỏng bước
    // hoàn tác. Hôm nay mọi writer đều gán mảng MỚI nên bản sao này không quan sát được từ các thao tác thật (đột biến "bỏ .slice()"
    // từng sống sót ở các ca trên — mutant tương đương với app hiện tại); ca này ghim nó trực tiếp cho ngày có writer ghi tại chỗ.
    console.log("\n=== ảnh chụp hoàn tác độc lập với byte sống (chống writer ghi tại chỗ) ===");
    const i0 = await fresh();
    await page.eval(`(() => { pushUndo(); state.bytes[100] = state.bytes[100] ^ 255; return true; })()`); // ghi tại chỗ SAU pushUndo
    expect((await snap()).hash !== i0.hash, "tiền điều kiện: ghi tại chỗ đã làm đổi byte sống");
    await page.eval(`undo()`);
    expect((await snap()).hash === i0.hash, "hoàn tác trả đúng byte NGUYÊN VẸN dù byte sống đã bị ghi tại chỗ (snapshot đã sao chép)");

    // ---- 5. Lưu ra file rồi MỞ LẠI từ đĩa: số trang, góc xoay, nội dung ---------------------------------------
    console.log("\n=== Lưu ra file rồi mở lại từ đĩa ===");
    await fresh();
    await page.eval(`(async () => { state.selected = new Set([0, 2]); await rotateSelected(90); })()`);
    await page.eval(`(async () => { state.selected = new Set([3]); await deleteSelected(); })()`);
    const before = await snap();
    const target = path.join(work, "da-luu.pdf");
    app.dialogs.answer({ showSaveDialog: [target] });
    const saved = await page.eval(`window.desktop.savePdf(state.bytes, "lich-su.pdf")`);
    expect(saved && saved.saved === true, `Lưu qua hộp Lưu: ${JSON.stringify(saved && { saved: saved.saved })}`);
    expect(fs.existsSync(target) && fs.readFileSync(target).length === before.len, "file ra đĩa đúng độ dài của canonical bytes");
    app.dialogs.answer({ showOpenDialog: [[target]] });
    const opened = await page.eval(`window.desktop.openPdf({}).then((r) => r.map((x) => ({ path: x.path, len: x.data.length })))`);
    expect(opened.length === 1 && opened[0].len === before.len, "mở lại bằng hộp Mở đọc đúng file");
    const reopened = await PDFDocument.load(fs.readFileSync(target));
    const rot = reopened.getPages().map((p) => p.getRotation().angle);
    expect(reopened.getPageCount() === 4, `file mở lại có 4 trang (đã xoá 1 trong 5): ${reopened.getPageCount()}`);
    expect(JSON.stringify(rot) === JSON.stringify([90, 0, 90, 0]), `góc xoay còn đủ sau khi lưu/mở: ${JSON.stringify(rot)}`);
    // Mở THẬT trong app (loadBytes) và so lại cái app thấy với cái đã ghi.
    await app.openPdf(fs.readFileSync(target), "da-luu.pdf", { srcPath: target });
    const re = await snap();
    expect(re.pages === 4 && re.dirty === false && !re.title.startsWith("●"), `mở lại trong app: 4 trang, sạch, không chấm ● ("${re.title}")`);
    expect(re.hash === before.hash, "byte app giữ sau khi mở lại == byte đã lưu (Lưu không âm thầm đổi tài liệu)");

    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ (${app.dialogs.unexpected().length})`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    await app.close();
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
  console.log("Lịch sử hoàn tác đúng trên mọi thao tác: byte trước/sau chính xác, cờ bẩn ●, phím tắt, và lưu/mở lại.");
})();
