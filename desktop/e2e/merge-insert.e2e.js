"use strict";

// BI-141 / ma trận §5 — GHÉP / CHÈN / THAY TRANG TỪ FILE KHÁC trong APP ELECTRON THẬT (đường nút → hộp chọn file native do móc
// hộp thoại trả lời → hộp "chọn vị trí" của app → pdf-lib → viewer).
//
// Đây chính là mục "còn test tay" của hàng `pushUndo`/history ("Ctrl+Z–Ctrl+Y sau ghép, chèn từ file khác"), cộng thêm mục Thay
// trang (v0.2.72) — "một lần pushUndo, một lần load/save". Mỗi trang mẫu có BỀ RỘNG RIÊNG nên đọc lại `state.bytes` bằng pdf-lib ở
// Node là biết trang nào đứng ở đâu, độc lập với app.
//
//   MI1 Ghép 2 file vào ĐẦU / CUỐI / SAU trang n: thứ tự trang đúng; một bước hoàn tác; hoàn tác & làm lại trả ĐÚNG byte
//   MI2 Chèn 1 file vào giữa: đúng vị trí; hoàn tác đúng byte
//   MI3 Huỷ hộp chọn file / huỷ hộp chọn vị trí ⇒ KHÔNG đổi gì, không thêm bước hoàn tác, không bẩn
//   MI4 Thay trang: tất cả trang nguồn / một khoảng; một bước hoàn tác; tick RỜI RẠC ⇒ từ chối, không đổi gì
//   MI5 File nguồn hỏng: thông báo rõ, tài liệu và lịch sử hoàn tác không đổi
//
// KHÔNG tự động hoá: kéo-thả file vào cột trang, nút trong menu chuột phải (gọi đúng hàm đích), hộp chọn file thật.
//
// Cần phiên có giao diện. Không cần sidecar.
//
// Chạy:  cd desktop ; node e2e/merge-insert.e2e.js     (hoặc: npm run e2e -- merge-insert)

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

const HASH = `(async () => { const d = await crypto.subtle.digest("SHA-256", state.bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); })()`;

async function until(fn, ms = 15000, step = 150) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    try {
      v = await fn();
      if (v) return v;
    } catch (_) {
      v = null;
    }
    await sleep(step);
  }
  return v;
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-mi-"));
  const X = path.join(work, "X.pdf");
  const M1 = path.join(work, "M1.pdf");
  const M2 = path.join(work, "M2.pdf");
  const BAD = path.join(work, "hong.pdf");
  const xBytes = await makePdf(3, { widths: [410, 420, 430] });
  fs.writeFileSync(X, xBytes);
  fs.writeFileSync(M1, await makePdf(2, { widths: [510, 520] }));
  fs.writeFileSync(M2, await makePdf(1, { widths: [610] }));
  fs.writeFileSync(BAD, "đây không phải PDF — chỉ là chữ");
  let app = null;
  try {
    app = await launch();
    const page = await app.ready({ sidecar: false });
    await app.openPdf(xBytes, "X.pdf", { srcPath: X });
    const widths = async () => (await PDFDocument.load(await page.stateBytes())).getPages().map((p) => Math.round(p.getWidth()));
    const st = () => page.eval(`({ n: state.numPages, dirty: state.dirty, nUndo: history.undo.length, nRedo: history.redo.length })`);
    const toastText = () => page.eval(`document.getElementById("toast").textContent`);
    const modalOpen = (id) => page.waitFor(`!document.getElementById(${J(id)}).hidden`, { timeout: 10000, what: `hộp ${id} hiện` });
    const resetToX = async () => {
      await app.openPdf(xBytes, "X.pdf", { srcPath: X });
      await page.clearToast();
    };
    // Chạy `expr` (hàm bất đồng bộ của app) KHÔNG đợi — vì nó đợi hộp thoại của app; trả khi hộp `modal` hiện.
    const start = async (expr, modal) => {
      await page.eval(`window.__op = ${expr}; true`);
      await modalOpen(modal);
    };
    const choosePos = async (mode, after) => {
      await page.eval(`(() => { const m = document.getElementById("pos-mode"); m.value = ${J(mode)}; m.dispatchEvent(new Event("change", { bubbles: true }));
        ${after ? `const a = document.getElementById("pos-after"); a.value = ${J(String(after))};` : ""} return true; })()`);
      await page.click("#pos-ok");
      await page.eval(`window.__op`);
    };

    // ---- MI1: ghép ----------------------------------------------------------------------------------------------
    console.log("MI1  ghép 2 file vào đầu / cuối / sau trang n");
    const h0 = await page.eval(HASH);
    expect(J(await widths()) === J([410, 420, 430]), "tiền điều kiện: X = [410,420,430]");
    app.dialogs.answer({ showOpenDialog: [[M1, M2]] });
    await start(`mergeFiles()`, "pos-modal");
    expect(/3 trang/.test(await page.eval(`document.getElementById("pos-hint").textContent`)), "hộp vị trí nói tài liệu có 3 trang");
    await choosePos("start");
    expect(J(await widths()) === J([510, 520, 610, 410, 420, 430]), `ghép vào ĐẦU: ${J(await widths())}`);
    let s = await st();
    expect(s.n === 6 && s.dirty && s.nUndo === 1, `6 trang, bẩn, đúng 1 bước hoàn tác: ${J(s)}`);
    expect(/Đã ghép 2 file \(\+3 trang\) vào đầu/.test(await toastText()), `toast: ${J(await toastText())}`);
    const hMerged = await page.eval(HASH);
    await page.eval(`undo()`);
    expect(await until(async () => (await page.eval(HASH)) === h0), "hoàn tác ⇒ ĐÚNG byte ban đầu");
    // QUAN SÁT: `snapshot()` không lưu cờ bẩn nên hoàn tác về đúng byte ban đầu VẪN để chấm ● (thận trọng: không bao giờ tắt cảnh báo chưa lưu). Không ghim.
    console.log(`  QUAN SÁT: sau hoàn tác về đúng byte ban đầu, chấm ● ${(await st()).dirty ? "vẫn còn (thận trọng)" : "đã tắt"}`);
    await page.eval(`redo()`);
    expect(await until(async () => (await page.eval(HASH)) === hMerged), "làm lại ⇒ ĐÚNG byte đã ghép");

    await resetToX();
    app.dialogs.answer({ showOpenDialog: [[M1, M2]] });
    await start(`mergeFiles()`, "pos-modal");
    await choosePos("end");
    expect(J(await widths()) === J([410, 420, 430, 510, 520, 610]), `ghép vào CUỐI: ${J(await widths())}`);

    await resetToX();
    app.dialogs.answer({ showOpenDialog: [[M1, M2]] });
    await start(`mergeFiles()`, "pos-modal");
    await choosePos("after", 2);
    expect(J(await widths()) === J([410, 420, 510, 520, 610, 430]), `ghép SAU trang 2: ${J(await widths())}`);

    // ---- MI2: chèn ----------------------------------------------------------------------------------------------
    console.log("\nMI2  chèn 1 file vào giữa (sau trang 1) rồi hoàn tác");
    await resetToX();
    app.dialogs.answer({ showOpenDialog: [[M1]] });
    await start(`insertFile()`, "pos-modal");
    await choosePos("after", 1);
    expect(J(await widths()) === J([410, 510, 520, 420, 430]), `chèn SAU trang 1: ${J(await widths())}`);
    s = await st();
    expect(s.nUndo === 1 && s.dirty, `đúng 1 bước hoàn tác: ${J(s)}`);
    await page.eval(`undo()`);
    expect(await until(async () => (await page.eval(HASH)) === h0), "hoàn tác ⇒ ĐÚNG byte ban đầu");

    // ---- MI3: huỷ ------------------------------------------------------------------------------------------------
    console.log("\nMI3  huỷ hộp chọn file / huỷ hộp vị trí ⇒ không đổi gì");
    await resetToX();
    app.dialogs.answer({ showOpenDialog: [null] });
    await page.eval(`mergeFiles()`);
    s = await st();
    expect((await page.eval(HASH)) === h0 && !s.dirty && s.nUndo === 0, `huỷ hộp chọn file: tài liệu y nguyên, không bẩn, không bước hoàn tác: ${J(s)}`);
    expect(await page.eval(`document.getElementById("pos-modal").hidden`), "hộp vị trí không mở");
    app.dialogs.answer({ showOpenDialog: [[M1]] });
    await start(`insertFile()`, "pos-modal");
    await page.click("#pos-cancel");
    await page.eval(`window.__op`);
    s = await st();
    expect((await page.eval(HASH)) === h0 && !s.dirty && s.nUndo === 0, `huỷ hộp vị trí: tài liệu y nguyên, không bẩn, không bước hoàn tác: ${J(s)}`);

    // ---- MI4: thay trang ---------------------------------------------------------------------------------------
    console.log("\nMI4  thay trang: tất cả / một khoảng; tick rời rạc bị từ chối");
    await resetToX();
    await page.eval(`(state.selected = new Set([1]), true)`);
    app.dialogs.answer({ showOpenDialog: [[M1]] });
    await start(`replaceSelectedFromFile()`, "replace-modal");
    expect(/Thay trang 2 bằng trang của: M1\.pdf \(2 trang\)/.test(await page.eval(`document.getElementById("replace-what").textContent`)), "hộp nói đúng trang đích và file nguồn");
    await page.click("#replace-ok"); // mặc định: tất cả trang nguồn
    await page.eval(`window.__op`);
    expect(J(await widths()) === J([410, 510, 520, 430]), `thay trang 2 bằng cả M1: ${J(await widths())}`);
    s = await st();
    expect(s.nUndo === 1, `đúng 1 bước hoàn tác (một lần load/save): ${s.nUndo}`);
    await page.eval(`undo()`);
    expect(await until(async () => (await page.eval(HASH)) === h0), "hoàn tác ⇒ ĐÚNG byte ban đầu");

    await page.eval(`(state.selected = new Set([1]), true)`);
    app.dialogs.answer({ showOpenDialog: [[M1]] });
    await start(`replaceSelectedFromFile()`, "replace-modal");
    await page.eval(`(() => { document.getElementById("replace-pick").checked = true;
      const i = document.getElementById("replace-spec"); i.value = "2"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await page.click("#replace-ok");
    await page.eval(`window.__op`);
    expect(J(await widths()) === J([410, 520, 430]), `thay trang 2 bằng trang 2 của M1: ${J(await widths())}`);

    await resetToX();
    await page.eval(`(state.selected = new Set([0, 2]), true)`); // rời rạc: không có nghĩa duy nhất
    app.dialogs.answer({ showOpenDialog: [[M1]] });
    const hGap = await page.eval(HASH);
    await page.eval(`replaceSelectedFromFile()`);
    await sleep(800);
    s = await st();
    expect((await page.eval(HASH)) === hGap && s.nUndo === 0 && !s.dirty, `tick rời rạc: không đổi gì: ${J(s)}`);
    expect(await page.eval(`document.getElementById("replace-modal").hidden`), "hộp thay trang không mở");

    // Lớp bảo vệ THỨ HAI: `replaceSelectedWith` (nhận bytes thẳng, không qua hộp chọn file) cũng phải từ chối tick rời rạc — đường vào
    // `replaceSelectedFromFile` đã chặn trước, nên chỉ gọi thẳng hàm này mới thấy được lớp thứ hai.
    await resetToX();
    await page.eval(`(state.selected = new Set([0, 2]), true)`);
    const m1b64 = fs.readFileSync(M1).toString("base64");
    await page.eval(`replaceSelectedWith(Uint8Array.from(atob(${J(m1b64)}), (c) => c.charCodeAt(0)), "M1.pdf")`).catch(() => {});
    await sleep(600);
    s = await st();
    expect((await page.eval(HASH)) === h0 && s.nUndo === 0 && (await page.eval(`document.getElementById("replace-modal").hidden`)), `replaceSelectedWith với tick rời rạc: không mở hộp, không đổi gì: ${J(s)}`);
    // ---- MI5: file nguồn hỏng ------------------------------------------------------------------------------------
    console.log("\nMI5  file nguồn hỏng khi THAY TRANG ⇒ thông báo rõ, tài liệu và lịch sử không đổi");
    await resetToX();
    await page.eval(`(state.selected = new Set([1]), true)`);
    app.dialogs.answer({ showOpenDialog: [[BAD]] });
    await page.eval(`replaceSelectedFromFile()`);
    await sleep(800);
    s = await st();
    expect(/Không đọc được file nguồn/.test(await toastText()), `toast: ${J(await toastText())}`);
    expect((await page.eval(HASH)) === h0 && s.nUndo === 0 && !s.dirty, `tài liệu/lịch sử không đổi: ${J(s)}`);

    // QUAN SÁT (không phải khẳng định): GHÉP với file hỏng. `mergeFiles` gọi `pushUndo()` rồi `PDFDocument.load` KHÔNG có `catch` — khác
    // "Thay trang" ở trên (đọc nguồn TRƯỚC, báo rõ). Ghi lại điều đo được; cố ý không ghim vì chủ dự án chưa quyết.
    await resetToX();
    app.dialogs.answer({ showOpenDialog: [[BAD]] });
    await start(`mergeFiles()`, "pos-modal");
    await page.eval(`(() => { document.getElementById("pos-mode").value = "end"; document.getElementById("pos-ok").click(); return true; })()`);
    const rejected = await page.eval(`window.__op.then(() => "ok", (e) => "nem loi: " + (e && e.message ? e.message.slice(0, 70) : e))`);
    await sleep(500);
    s = await st();
    console.log(`  QUAN SÁT: ghép file hỏng ⇒ ${rejected}; số trang ${s.n}, bước hoàn tác ${s.nUndo}, bẩn ${s.dirty}, toast ${J(await toastText())}, lớp phủ ${(await page.eval(`!document.getElementById("overlay").hidden`)) ? "CÒN" : "đã tắt"}`);
    expect((await page.eval(HASH)) === h0, "ghép file hỏng: byte tài liệu không đổi");
    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ (${app.dialogs.unexpected().length})`);
    await page.eval(`(state.dirty = false, true)`);
    await app.close();
    app = null;
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.stack);
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
  console.log("Ghép / chèn / thay trang đúng ở cả 5 nhóm ca. Kéo-thả file và menu chuột phải vẫn phải test tay.");
})();
