"use strict";

// BI-141 / ma trận §5 — TRANG ẨN CÓ KHOÁ (page-vault.js; BI-72/73/74/91/130) trong APP ELECTRON THẬT.
//
// Đây là tính năng AN TOÀN DỮ LIỆU: "ẩn" mà bản rõ vẫn nằm trong lịch sử hoàn tác, bản phục hồi trên đĩa hay một revision cũ của
// file thì không phải ẩn. Oracle là CHUỖI DÒ vẽ lên trang bí mật (fixtures `marks`) và `containsText` — tìm nó trong byte thô lẫn
// trong mọi luồng Flate đã giải nén, độc lập với app. Mã hoá AES thì chuỗi không còn ở cả hai nơi.
//
//   W0  tiền điều kiện CÓ NGHĨA: trước khi ẩn, bản rõ ĐANG nằm trong bytes, trong lịch sử hoàn tác và trong khe phục hồi
//   (BI-143: bản rõ của trang gốc từng còn trong file như đối tượng mồ côi — đã sửa; các phép kiểm "không còn chuỗi dò" dưới đây là khẳng định cứng)
//   W1  hộp thoại đặt mật khẩu: để trống / không khớp bị chặn; ẩn xong: bytes KHÔNG còn chuỗi dò, lịch sử hoàn tác BỊ XOÁ,
//       khe phục hồi BỊ GHI ĐÈ (không file nào trong khe còn chuỗi dò), Ctrl+Z không lộ lại trang
//   W2  Lưu ⇒ file trên đĩa không có chuỗi dò (BI-130); mở lại file đó ⇒ vẫn nhận ra 1 trang ẩn
//   W3  bỏ ẩn: hộp mật khẩu hiện GỢI Ý của file; sai mật khẩu ⇒ hỏi lại và tài liệu KHÔNG đổi; đúng ⇒ chuỗi dò quay lại; hoàn tác
//       (BI-3) được và trả đúng trạng thái đang ẩn
//   W4  Huỷ hộp mật khẩu ⇒ không đổi gì; không ẩn được TOÀN BỘ trang (có thông báo, không hộp thoại)
//   W5  ẩn → sắp xếp lại trang → bỏ ẩn đúng mật khẩu vẫn được, chuỗi dò quay lại (BI-72)
//   W6  "Xuất bản sao không kèm trang ẩn": file ra thiếu đúng trang đó, không chuỗi dò, không dấu vết NabuVault
//
// KHÔNG tự động hoá (cần chuột/phần mềm ngoài): menu chuột phải "Ẩn/Bỏ ẩn trang", mở bằng Acrobat/Chrome, in trang giữ chỗ,
// kéo-thả thumbnail, chuyển trang ẩn sang tab khác (đường kéo), khoá cả file bằng /encrypt rồi bỏ ẩn, nén/đánh số trang xong bỏ ẩn.
//
// Cần phiên có giao diện. Không cần sidecar.
//
// Chạy:  cd desktop ; node e2e/vault.e2e.js     (hoặc: npm run e2e -- vault)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { launch } = require("./lib/app-driver");
const { makePdf, containsText } = require("./lib/fixtures");

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

const MARK = "BI-MAT-XYZ-7421";
const PW = "Mat-khau-1";
const HINT = "goi-y-abc";

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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-vault-"));
  const diskFile = path.join(work, "bi-mat.pdf");
  const doc = await makePdf(3, { marks: { 1: MARK } });
  fs.writeFileSync(diskFile, doc);
  const slotFiles = (app, docId) => {
    const dir = path.join(app.userDataDir, "recovery", docId);
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
  };
  let app = null;
  try {
    app = await launch();
    const page = await app.ready({ sidecar: false });
    await app.openPdf(doc, "bi-mat.pdf", { srcPath: diskFile });
    const st = () => page.eval(`({ n: state.numPages, vault: [...state.vaultPages], dirty: state.dirty, nUndo: history.undo.length, nRedo: history.redo.length,
      undoOff: document.getElementById("btn-undo").disabled })`);
    const toastText = () => page.eval(`document.getElementById("toast").textContent`);
    const visibleModal = (id) => page.waitFor(`!document.getElementById(${J(id)}).hidden`, { timeout: 8000, what: `hộp ${id} hiện` });
    const setVal = (id, v) => page.eval(`(() => { const e = document.getElementById(${J(id)}); e.value = ${J(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const click = (id) => page.click("#" + id);

    // ---- W0 -----------------------------------------------------------------------------------------------------
    console.log("W0  tiền điều kiện: bản rõ ĐANG có trong bytes, lịch sử hoàn tác và khe phục hồi");
    await page.eval(`(async () => { state.selected = new Set([0]); await rotateSelected(90); })()`); // tạo một bước hoàn tác chứa bản rõ
    const docId = await page.eval(`state.docId`);
    await page.eval(`autosaveTick()`);
    expect(containsText(await page.stateBytes(), MARK), "bytes đang chứa chuỗi dò");
    expect((await st()).nUndo === 1, "lịch sử hoàn tác có 1 bước (giữ bản rõ)");
    const slotBefore = slotFiles(app, docId);
    expect(slotBefore.length > 0 && slotBefore.some((f) => containsText(fs.readFileSync(f), MARK)), `khe phục hồi đang chứa chuỗi dò (${slotBefore.length} file)`);

    await page.clearToast();
    expect((await page.eval(`hidePagesWithPassword([0, 1, 2])`)) === false, "ẩn CẢ 3 trang khi chưa ẩn gì ⇒ từ chối");
    expect(/Không thể ẩn toàn bộ trang/.test(await toastText()), `có thông báo: ${J(await toastText())}`);
    expect(await page.eval(`document.getElementById("vault-modal").hidden`), "hộp mật khẩu không mở");

    // ---- W1 -----------------------------------------------------------------------------------------------------
    console.log("\nW1  ẩn trang 2 bằng mật khẩu ⇒ bản rõ BIẾN KHỎI bytes, lịch sử hoàn tác và khe phục hồi");
    await page.eval(`window.__hide = hidePagesWithPassword([1]); true`);
    await visibleModal("vault-modal");
    await click("vault-ok"); // để trống
    expect(/Hãy đặt một mật khẩu/.test(await page.eval(`document.getElementById("vault-err").textContent`)), "để trống mật khẩu bị chặn kèm lời nhắc");
    await setVal("vault-pw", PW);
    await setVal("vault-pw2", PW + "x");
    await click("vault-ok");
    expect(/không khớp/.test(await page.eval(`document.getElementById("vault-err").textContent`)), "hai lần nhập lệch bị chặn");
    expect(await page.eval(`!document.getElementById("vault-modal").hidden`), "hộp vẫn mở sau khi bị chặn (chưa ẩn gì)");
    expect(!(await st()).vault.length, "chưa ẩn trang nào khi còn bị chặn");
    await setVal("vault-pw2", PW);
    await setVal("vault-hint", HINT);
    await click("vault-ok");
    expect((await page.eval(`window.__hide`)) === true, "hidePagesWithPassword trả true");
    let s = await st();
    expect(s.n === 3 && J(s.vault) === "[1]", `vẫn 3 trang, trang 2 ẩn: ${J([s.n, s.vault])}`);
    expect(!containsText(await page.stateBytes(), MARK), "bytes KHÔNG còn chuỗi dò (đã mã hoá)");
    expect(s.nUndo === 0 && s.nRedo === 0 && s.undoOff, `lịch sử hoàn tác bị XOÁ: undo=${s.nUndo} redo=${s.nRedo} nút tắt=${s.undoOff}`);
    expect(s.dirty === true, "tài liệu bẩn (chấm ●)");
    expect(/Không hoàn tác được/.test(await toastText()), `toast báo không hoàn tác được: ${J(await toastText())}`);
    const slotAfter = slotFiles(app, docId);
    expect(slotAfter.length > 0, "khe phục hồi vẫn còn (bản đã niêm phong)");
    expect(slotAfter.every((f) => !containsText(fs.readFileSync(f), MARK)), `KHÔNG file nào trong khe phục hồi còn chuỗi dò (${slotAfter.length} file)`);
    const hashHidden = await page.eval(HASH);
    // Khe phục hồi phải là BẢN ĐÃ NIÊM PHONG hiện tại (ghi đè bằng `scrub:true`, BI-137), không phải bản rõ trước khi ẩn — so băm với bytes.
    const slotPdf = slotAfter.find((x) => x.endsWith("autosave.pdf"));
    expect(!!slotPdf && require("crypto").createHash("sha256").update(fs.readFileSync(slotPdf)).digest("hex") === hashHidden, "khe phục hồi == bytes đã niêm phong hiện tại (đã ghi đè, không còn bản trước khi ẩn)");
    expect((await page.eval(`state.contentRemoved`)) === true, "state.contentRemoved = true (BI-130: cấm lưu nối thêm giữ byte cũ)");
    await page.press("z", { ctrl: true });
    await sleep(500);
    expect((await page.eval(HASH)) === hashHidden, "Ctrl+Z không làm gì: bytes y nguyên từng byte (không có bước hoàn tác để lộ trang)");

    // ---- W2 -----------------------------------------------------------------------------------------------------
    console.log("\nW2  Lưu ⇒ file trên đĩa không có bản rõ; mở lại vẫn nhận ra trang ẩn");
    await page.eval(`saveDoc()`);
    expect(await until(async () => !(await st()).dirty), "đã lưu (hết chấm ●)");
    const onDisk = fs.readFileSync(diskFile);
    expect(!containsText(onDisk, MARK), "file trên đĩa KHÔNG còn chuỗi dò (BI-130)");
    const rd = await PDFDocument.load(onDisk);
    expect(rd.getPageCount() === 3 && rd.getPages()[0].getRotation().angle === 90, "file hợp lệ, 3 trang, giữ xoay trang 1");
    await app.openPdf(onDisk, "bi-mat.pdf", { srcPath: diskFile });
    s = await st();
    expect(J(s.vault) === "[1]" && s.n === 3 && !s.dirty, `mở lại: nhận ra 1 trang ẩn: ${J([s.n, s.vault, s.dirty])}`);
    // Ẩn một trang trên tài liệu SẠCH ⇒ chấm ● phải bật (hidePagesWithPassword không gọi pushUndo nên tự đặt `state.dirty`).
    await page.eval(`window.__h3 = hidePagesWithPassword([0]); true`);
    await visibleModal("vault-modal");
    await setVal("vault-pw", PW);
    await setVal("vault-pw2", PW);
    await click("vault-ok");
    await page.eval(`window.__h3`);
    s = await st();
    expect(s.dirty === true && J(s.vault) === "[0,1]", `ẩn thêm 1 trang trên tài liệu sạch ⇒ bẩn (chấm ●) và 2 trang ẩn: ${J([s.dirty, s.vault])}`);
    await app.openPdf(onDisk, "bi-mat.pdf", { srcPath: diskFile }); // quay lại đúng bản đã lưu (sạch, 1 trang ẩn) cho ca sau
    const hashReopened = await page.eval(HASH);

    // ---- W3 -----------------------------------------------------------------------------------------------------
    console.log("\nW3  bỏ ẩn: gợi ý hiện ra; SAI mật khẩu ⇒ hỏi lại, tài liệu không đổi; ĐÚNG ⇒ bản rõ quay lại; hoàn tác được");
    await page.eval(`window.__unhide = unhidePagesWithPassword([1]); true`);
    await visibleModal("pw-modal");
    expect((await page.eval(`document.getElementById("pw-note").textContent`)).includes(HINT), `hộp mật khẩu hiện gợi ý của file: ${J(await page.eval(`document.getElementById("pw-note").textContent`))}`);
    await setVal("pw-input", "sai-mat-khau");
    await click("pw-ok");
    expect(await until(async () => /Sai mật khẩu/.test(await toastText()), 15000), `toast báo sai mật khẩu: ${J(await toastText())}`);
    await visibleModal("pw-modal"); // hỏi lại
    expect((await page.eval(HASH)) === hashReopened, "sai mật khẩu: tài liệu y nguyên từng byte");
    await setVal("pw-input", PW);
    await click("pw-ok");
    expect((await page.eval(`window.__unhide`)) === true, "đúng mật khẩu ⇒ unhidePagesWithPassword trả true");
    s = await st();
    expect(!s.vault.length && s.n === 3, `không còn trang ẩn: ${J([s.n, s.vault])}`);
    expect(containsText(await page.stateBytes(), MARK), "chuỗi dò QUAY LẠI trong bytes");
    expect(s.nUndo === 1, `bỏ ẩn có 1 bước hoàn tác (BI-3): ${s.nUndo}`);
    await page.press("z", { ctrl: true });
    expect(await until(async () => (await page.eval(HASH)) === hashReopened), "Ctrl+Z ⇒ về ĐÚNG trạng thái đang ẩn");
    expect(await until(async () => J((await st()).vault) === "[1]", 8000), `trang lại ở trạng thái ẩn: ${J((await st()).vault)}`);

    // ---- W4 -----------------------------------------------------------------------------------------------------
    console.log("\nW4  Huỷ hộp mật khẩu ⇒ không đổi; không ẩn được TOÀN BỘ trang");
    await page.eval(`(state.selected.clear(), true)`);
    const hashW4 = await page.eval(HASH);
    await page.eval(`window.__c = hidePagesWithPassword([0]); true`);
    await visibleModal("vault-modal");
    await click("vault-cancel");
    expect((await page.eval(`window.__c`)) === false, "Huỷ ⇒ trả false");
    expect((await page.eval(HASH)) === hashW4, "Huỷ ⇒ bytes y nguyên");
    expect(J((await st()).vault) === "[1]", `Huỷ ⇒ vẫn đúng 1 trang ẩn: ${J((await st()).vault)}`);
    // QUAN SÁT (không phải khẳng định): luật 'phải chừa lại ít nhất một trang' chỉ đếm danh sách MỚI (`list.length >= numPages`), không đếm
    // trang đã ẩn. Đang ẩn trang 2 mà ẩn nốt [1, 3] vẫn được mời nhập mật khẩu ⇒ cuối cùng KHÔNG còn trang thật nào. Không mất dữ liệu (mọi
    // trang vẫn mở lại được bằng mật khẩu) nên chỉ ghi lại; cố ý không ghim vì chủ dự án chưa quyết đây có phải ý định không.
    await page.eval(`window.__rest = hidePagesWithPassword([0, 2]); true`);
    const opened = await until(() => page.eval(`!document.getElementById("vault-modal").hidden`), 5000);
    console.log(`  QUAN SÁT: đang ẩn 1/3 trang, ẩn nốt 2 trang còn lại ${opened ? "VẪN được mời nhập mật khẩu (sẽ ẩn hết)" : "bị từ chối"}`);
    if (opened) await click("vault-cancel");
    await page.eval(`window.__rest`);
    expect((await page.eval(HASH)) === hashW4 && J((await st()).vault) === "[1]", "Huỷ lần đó: tài liệu vẫn y nguyên, vẫn 1 trang ẩn");
    // ---- W5 -----------------------------------------------------------------------------------------------------
    console.log("\nW5  ẩn → sắp xếp lại trang → bỏ ẩn đúng mật khẩu vẫn được (BI-72)");
    await page.eval(`reorderPage(0, 2)`); // [p1, V, p3] → [V, p3, p1]
    s = await st();
    expect(J(s.vault) === "[0]", `trang ẩn đi theo khi sắp xếp: ${J(s.vault)}`);
    expect(!containsText(await page.stateBytes(), MARK), "sau khi sắp xếp, vẫn không có bản rõ");
    await page.eval(`window.__u2 = unhidePagesWithPassword([...state.vaultPages]); true`);
    await visibleModal("pw-modal");
    await setVal("pw-input", PW);
    await click("pw-ok");
    expect((await page.eval(`window.__u2`)) === true, "bỏ ẩn sau khi sắp xếp: trả true");
    expect(containsText(await page.stateBytes(), MARK) && !(await st()).vault.length, "chuỗi dò quay lại, hết trang ẩn");

    // ---- W6 -----------------------------------------------------------------------------------------------------
    console.log("\nW6  'Xuất bản sao không kèm trang ẩn' ⇒ thiếu đúng trang đó, không chuỗi dò, không dấu vết NabuVault");
    const secretIdx = 0; // [V,p3,p1] → bỏ ẩn → [trang bí mật,p3,p1]
    await page.eval(`(state.selected = new Set([${secretIdx}]), true)`);
    await page.eval(`window.__h2 = hidePagesWithPassword([${secretIdx}]); true`);
    await visibleModal("vault-modal");
    await setVal("vault-pw", PW);
    await setVal("vault-pw2", PW);
    await click("vault-ok");
    await page.eval(`window.__h2`);
    const copyPath = path.join(work, "ban-sao.pdf");
    app.dialogs.answer({ showSaveDialog: [copyPath] });
    await page.eval(`exportWithoutHiddenPages()`);
    expect(await until(() => fs.existsSync(copyPath), 15000), "bản sao đã được ghi");
    const cp = fs.readFileSync(copyPath);
    const cd = await PDFDocument.load(cp);
    expect(cd.getPageCount() === 2, `bản sao có 2 trang (bỏ trang ẩn): ${cd.getPageCount()}`);
    expect(!containsText(cp, MARK), "bản sao KHÔNG có chuỗi dò (copyPages chỉ mang theo đối tượng được tham chiếu ⇒ sạch)");
    expect(!containsText(cp, "NabuVault"), "bản sao không còn dấu vết NabuVault (không mang bản mã đi)");

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
  console.log("Trang ẩn có khoá đúng ở cả 7 ca (W0–W6). Menu chuột phải, Acrobat/Chrome, in, kéo-thả vẫn phải test tay.");
})();
