"use strict";

// BI-141 / ma trận §5 hàng 29 — KHÔI PHỤC SAU SẬP (autosave · BI-7 · BI-137) trong APP ELECTRON THẬT.
//
// Tự động hoá ca test tay "sập giữa lúc autosave ⇒ bản cũ còn khôi phục được": app thật bị GIẾT CỨNG (`taskkill /F /T`, không kịp
// dọn gì), rồi KHỞI CHẠY LẠI trên CÙNG thư mục dữ liệu. Hộp mời khôi phục là hộp CỦA TRANG (`uiConfirm`, DOM thật — bấm bằng
// `.click()` thật), không phải hộp native.
//
//   R1  sập ⇒ khe phục hồi trên đĩa đúng byte tài liệu lúc sập (autosave.pdf + manifest.json tên đúng).
//   R2  mở lại ⇒ hộp mời hiện, đúng 3 nút ("Khôi phục" / "Để sau" / "Xoá, không hỏi lại"); bấm "Để sau" ⇒ khe VẪN CÒN.
//   R3  mở lại lần nữa ⇒ hộp lại hiện (một lần mỗi lần chạy — BI-7); bấm "Xoá, không hỏi lại" ⇒ khe bị xoá, toast báo.
//   R4  mở lại ⇒ KHÔNG còn hộp mời (không còn gì để mời).
//   R5  sập lần nữa ⇒ mở lại ⇒ bấm "Khôi phục": tài liệu về ĐÚNG byte lúc sập, đúng tên, vẫn BẨN (còn ●), `contentRemoved = true`
//       (BI-130: không biết phiên đã bôi đen/ẩn trang chưa ⇒ không đề nghị ghi nối), và khe được dùng xong thì bị xoá.
//
// Tài liệu thử KHÔNG có đường dẫn (mới/chưa lưu) — tài liệu có đường dẫn đi qua khôi phục PHIÊN (tab đặt chỗ), không qua hộp này.
// Không phủ: BI-7 "mở 2 tab thì chỉ tab đầu được hỏi" (cần mở tab thứ hai); sập GIỮA lúc ghi autosave (BI-137 — `test:recoveryatomic`,
// `test:atomic` giữ phần đó bằng giết tiến trình thật).
//
// Chạy:  cd desktop ; node e2e/recovery.e2e.js     (hoặc: npm run e2e -- recovery)

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

const HASH = `(async () => { const d = await crypto.subtle.digest("SHA-256", state.bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); })()`;
const sha = (buf) => require("crypto").createHash("sha256").update(buf).digest("hex");

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-recovery-"));
  const U = path.join(work, "userData");
  fs.mkdirSync(U);
  const doc = await makePdf(3);
  const recDir = () => path.join(U, "recovery");
  const slots = () => (fs.existsSync(recDir()) ? fs.readdirSync(recDir()) : []);
  let app = null;

  // Mở app trên cùng dữ liệu; trả trang. `sidecar` không cần cho khôi phục.
  const boot = async () => {
    app = await launch({ userDataDir: U });
    return app.ready({ sidecar: false });
  };
  // Mở tài liệu mới (không đường dẫn), sửa, ép autosave, rồi SẬP. Trả { docId, hash, name }.
  const editAndCrash = async () => {
    const page = await boot();
    await app.openPdf(doc, "phuc-hoi.pdf");
    await page.eval(`(async () => { state.selected = new Set([0]); await rotateSelected(90); })()`);
    const docId = await page.eval(`state.docId`);
    await page.eval(`autosaveTick()`);
    const hash = await page.eval(HASH);
    const slotFile = path.join(recDir(), docId, "autosave.pdf");
    const info = { docId, hash, onDisk: fs.existsSync(slotFile) ? sha(fs.readFileSync(slotFile)) : null, manifest: null };
    try {
      info.manifest = JSON.parse(fs.readFileSync(path.join(recDir(), docId, "manifest.json"), "utf8"));
    } catch (_) {}
    await app.crash();
    await app.close({ keepUserData: true });
    app = null;
    return info;
  };
  const modal = (page) => page.eval(`(() => { const m = document.getElementById("confirm-modal");
    const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden; };
    return { open: !m.hidden, msg: document.getElementById("confirm-msg").textContent,
             ok: document.getElementById("confirm-ok").textContent, cancel: document.getElementById("confirm-cancel").textContent,
             third: vis("confirm-third") ? document.getElementById("confirm-third").textContent : null }; })()`);
  const waitModal = (page) =>
    page.waitFor(`!document.getElementById("confirm-modal").hidden`, { timeout: 20000, what: "hộp mời khôi phục hiện ra" });

  try {
    // ---- R1: sập ⇒ khe đúng byte -------------------------------------------------------------------------
    console.log("R1  sập giữa phiên đã autosave ⇒ khe phục hồi trên đĩa đúng byte tài liệu lúc sập");
    const crash1 = await editAndCrash();
    expect(crash1.onDisk === crash1.hash, `autosave.pdf trên đĩa == tài liệu lúc sập (${(crash1.onDisk || "").slice(0, 8)} = ${crash1.hash.slice(0, 8)})`);
    expect(crash1.manifest && crash1.manifest.name === "phuc-hoi.pdf" && crash1.manifest.srcPath === null, `manifest: ${JSON.stringify(crash1.manifest && { name: crash1.manifest.name, srcPath: crash1.manifest.srcPath })}`);
    expect(slots().length === 1 && slots()[0] === crash1.docId, `đúng 1 khe sau sập: ${JSON.stringify(slots())}`);

    // ---- R2: mời, "Để sau" giữ khe -----------------------------------------------------------------------
    console.log("\nR2  mở lại ⇒ hộp mời hiện đủ 3 lựa chọn; 'Để sau' ⇒ khe VẪN CÒN");
    let page = await boot();
    await waitModal(page);
    let m = await modal(page);
    expect(/phuc-hoi\.pdf/.test(m.msg) && /Khôi phục\?/.test(m.msg), `hộp nêu tên tài liệu: ${JSON.stringify(m.msg.split("\n").slice(0, 2).join(" | "))}`);
    expect(m.ok === "Khôi phục" && m.cancel === "Để sau" && m.third === "Xoá, không hỏi lại", `3 nút: ${JSON.stringify([m.ok, m.cancel, m.third])}`);
    expect((await page.eval(`!!state.bytes`)) === false, "chưa tự mở tài liệu nào (phải chờ người dùng chọn)");
    await page.click("#confirm-cancel");
    await page.waitFor(`document.getElementById("confirm-modal").hidden`, { timeout: 10000, what: "hộp đóng sau 'Để sau'" });
    expect(slots().length === 1 && fs.existsSync(path.join(recDir(), crash1.docId, "autosave.pdf")), "'Để sau' KHÔNG xoá khe (còn đủ autosave.pdf)");
    expect((await page.eval(`!!state.bytes`)) === false, "'Để sau' không mở gì");
    await app.close({ keepUserData: true });
    app = null;

    // ---- R3: mời lại lần sau; "Xoá, không hỏi lại" xoá thật ----------------------------------------------
    console.log("\nR3  mở lại lần nữa ⇒ hộp lại hiện; 'Xoá, không hỏi lại' ⇒ khe bị xoá");
    page = await boot();
    await waitModal(page);
    expect(/phuc-hoi\.pdf/.test((await modal(page)).msg), "hộp lại mời đúng tài liệu đó (một lần mỗi lần chạy — BI-7)");
    await page.click("#confirm-third");
    await page.waitFor(`/Đã xoá bản khôi phục/.test(document.getElementById("toast").textContent)`, { timeout: 10000, what: "toast báo đã xoá" });
    expect(slots().length === 0, `khe đã bị xoá khỏi đĩa: ${JSON.stringify(slots())}`);
    await app.close({ keepUserData: true });
    app = null;

    // ---- R4: không còn gì để mời -------------------------------------------------------------------------
    console.log("\nR4  mở lại ⇒ KHÔNG còn hộp mời");
    page = await boot();
    await new Promise((r) => setTimeout(r, 4500)); // checkRecovery chạy sau ~1,2 s; chờ dư để chắc
    expect((await modal(page)).open === false, "không có hộp mời");
    expect((await page.eval(`!!state.bytes`)) === false, "cửa sổ vẫn trống");
    await app.close({ keepUserData: true });
    app = null;

    // ---- R5: sập lần nữa ⇒ "Khôi phục" ------------------------------------------------------------------
    console.log("\nR5  sập lần nữa ⇒ mở lại ⇒ 'Khôi phục': đúng byte, đúng tên, vẫn bẩn, khe được dùng xong thì xoá");
    const crash2 = await editAndCrash();
    expect(crash2.onDisk === crash2.hash, "khe mới đúng byte tài liệu lúc sập");
    page = await boot();
    await waitModal(page);
    await page.click("#confirm-ok");
    await page.waitFor(`!!state.bytes && state.name === "phuc-hoi.pdf"`, { timeout: 20000, what: "tài liệu được khôi phục vào cửa sổ" });
    const back = await page.eval(`(async () => { const d = await crypto.subtle.digest("SHA-256", state.bytes);
      return { hash: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""), name: state.name, path: state.path,
               dirty: state.dirty, contentRemoved: state.contentRemoved, title: document.title, toast: document.getElementById("toast").textContent }; })()`);
    expect(back.hash === crash2.hash, `tài liệu khôi phục == tài liệu lúc sập (${back.hash.slice(0, 8)} = ${crash2.hash.slice(0, 8)})`);
    expect(back.name === "phuc-hoi.pdf" && back.path === null, `đúng tên, không đường dẫn: ${JSON.stringify([back.name, back.path])}`);
    expect(back.dirty === true && back.title.startsWith("●"), `vẫn BẨN (còn chấm ●) — nội dung khác file trên đĩa: "${back.title}"`);
    expect(back.contentRemoved === true, "contentRemoved = true (BI-130: không đề nghị ghi nối vì không biết phiên đã xoá nội dung chưa)");
    expect(/Đã khôi phục/.test(back.toast), `toast: ${JSON.stringify(back.toast)}`);
    expect(!slots().includes(crash2.docId), `khe cũ đã được dùng xong và bị xoá: ${JSON.stringify(slots())}`);

    // Kết thúc sạch: đóng bằng nút X + "Không lưu" (không để lại khe — BI-142).
    app.dialogs.answer({ showMessageBox: [1] });
    app.requestClose();
    expect(await app.waitExit(25000), "đóng sạch bằng nút X + 'Không lưu'");
    expect(slots().length === 0, `không còn khe nào sau khi đóng sạch: ${JSON.stringify(slots())}`);
    expect(app.dialogs.unexpected().length === 0, `không hộp thoại native bất ngờ ở lần chạy cuối (${app.dialogs.unexpected().length})`);
    await app.close({ keepUserData: true });
    app = null;
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    if (app) console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    if (app) await app.close({ keepUserData: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
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
  console.log("Khôi phục sau sập đúng: khe đúng byte, mời 3 lựa chọn, 'Để sau' giữ, 'Xoá' xoá thật, 'Khôi phục' đưa về đúng tài liệu.");
})();
