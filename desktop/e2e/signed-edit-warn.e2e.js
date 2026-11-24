"use strict";

// BI-146 — cảnh báo lúc BẮT ĐẦU sửa file ĐÃ KÝ, trong APP ELECTRON THẬT, trên file ký THẬT (fixture OpenSSL của BI-131).
//
// Chạy thật: renderer thật (`rotateSelected` → `pushUndo` → `markDirty`) → preload thật (`signedScan`) → IPC → main thật
// (`signed:scan-path`, quét file TRÊN ĐĨA) → chip `#sb-signed` ở thanh trạng thái; rồi Ctrl+S thật (`saveDoc`) đi đường BI-130.
//
//   W1  mở file ký (có đường dẫn), CHƯA sửa ⇒ không chip (không cảnh báo khi chỉ xem).
//   W2  xoay một trang ⇒ chip hiện, nói đúng số chữ ký, có chú giải (cảnh báo là chip chứ không phải toast: toast chỉ sống 3,6 s).
//   W3  sửa tiếp ⇒ chip vẫn còn.
//   W4  Ctrl+S → "Lưu nối thêm" ⇒ tài liệu sạch, chip TẮT; file trên đĩa vẫn còn chữ ký (OpenSSL hợp lệ).
//   W5  sửa lại sau khi lưu ⇒ chip hiện LẠI (quét lại: đĩa có thể đã đổi).
//   W5b ẩn trang trên file ký (đường này đặt cờ bẩn THẲNG, không qua `markDirty`) ⇒ chip hiện.
//   W6  mở một file KHÔNG ký (có đường dẫn) rồi sửa ⇒ không chip (và không hộp thoại bất ngờ).
//   W7  tài liệu chưa có đường dẫn rồi sửa ⇒ không chip.
//
// Không phủ: chip nhìn có đủ nổi không (mắt người); ngôn ngữ EN (i18n.e2e.js phủ cơ chế chung); tab nền (pdf.js ngừng vẽ khi ẩn).
// Cần: .venv Python, node, openssl. Thiếu ⇒ thoát mã 2.
//
// Chạy:  cd desktop ; node e2e/signed-edit-warn.e2e.js     (hoặc: npm run e2e -- signed-edit)

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, DESKTOP } = require("./lib/app-driver");
const { makePdf } = require("./lib/fixtures");

const ROOT = path.join(DESKTOP, "..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");

function skip(why) {
  console.log("BỎ QUA: " + why);
  process.exit(2);
}
if (!fs.existsSync(PY)) skip(`không thấy ${PY}`);
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch (_) {
  skip("không có `openssl` trong PATH");
}

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};

function verify(file) {
  try {
    const out = execFileSync(PY, [path.join(ROOT, "tools", "verify_pdf_signatures.py"), file], {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "").trim() };
  }
}

const CHIP = `(() => { const e = document.getElementById("sb-signed");
  return e ? { hidden: e.hidden, text: e.textContent, title: e.title } : null; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-signededit-"));
  let fx;
  try {
    fx = JSON.parse(
      execFileSync(process.execPath, [path.join(ROOT, "tools", "signed_fixture.js"), path.join(work, "fx")], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
        .pop(),
    );
  } catch (e) {
    skip("không dựng được fixture ký: " + String(e.message).split("\n")[0]);
  }
  const ORIGINAL = fs.readFileSync(fx.signed);
  const DOC = path.join(work, "hop-dong.pdf");
  fs.writeFileSync(DOC, ORIGINAL);
  const base = verify(DOC);
  if (base.code !== 0) skip("file ký gốc KHÔNG hợp lệ theo OpenSSL: " + base.out);
  console.log(`file ký: ${ORIGINAL.length} B, OpenSSL: HỢP LỆ\n`);

  const app = await launch();
  try {
    const page = await app.ready();
    const chip = () => page.eval(CHIP);
    const waitChip = (shown, what) =>
      page.waitFor(`(() => { const e = document.getElementById("sb-signed"); return !!e && (${shown ? "!e.hidden" : "e.hidden"}); })()`, { timeout: 15000, what });
    // Xoay trang 1 bằng chính hàm của app (đi qua pushUndo → markDirty), không đụng toast trước đó.
    const rotate = () =>
      page.eval(`(async () => { state.selected = new Set([0]); await rotateSelected(90); return { dirty: state.dirty, path: state.path }; })()`);
    const toastText = () => page.eval(`document.getElementById("toast").textContent`);

    // ---- W1 ----
    console.log("W1  mở file ký, chưa sửa");
    await app.openPdf(ORIGINAL, "hop-dong.pdf", { srcPath: DOC });
    await sleep(1200); // đủ để một lần quét (nếu có) đã xong
    let c = await chip();
    expect(c && c.hidden === true, `không chip khi chỉ xem (${JSON.stringify(c)})`);

    // ---- W2 ----
    console.log("\nW2  xoay một trang ⇒ chip");
    await app.dialogs.answer({});
    const r2 = await rotate();
    expect(r2.dirty === true && r2.path === DOC, `đã sửa, có đường dẫn (${JSON.stringify(r2)})`);
    await waitChip(true, "chip hiện sau lần sửa đầu");
    c = await chip();
    expect(c.hidden === false && /⚠/.test(c.text) && /\d+ chữ ký/.test(c.text), `chip nói số chữ ký: ${JSON.stringify(c.text)}`);
    const n = Number((c.text.match(/(\d+) chữ ký/) || [])[1]);
    expect(n >= 1, `số chữ ký đọc được = ${n}`);
    expect(/chữ ký/.test(c.title) && /Lưu nối thêm/.test(c.title) && /Ctrl\+Z/.test(c.title), "chú giải nói cách xử lý khi lưu và còn hoàn tác được");
    console.log(`    (toast lúc này: ${JSON.stringify(await toastText())} — xoay trang không tự toast; chèn trang thì có)`);
    expect(!/chữ ký/.test(await toastText()), "cảnh báo KHÔNG đi qua toast (chip bền, toast chỉ sống 3,6 s và bị thao tác khác đè)");

    // ---- W3 ----
    console.log("\nW3  sửa tiếp");
    await rotate();
    await sleep(500);
    c = await chip();
    expect(c.hidden === false, "chip vẫn còn");

    // ---- W4 ----
    console.log("\nW4  Ctrl+S → Lưu nối thêm");
    app.dialogs.answer({ showMessageBox: [0] });
    const s4 = await page.eval(`(async () => { await saveDoc(); return { dirty: state.dirty }; })()`, { timeout: 120000 });
    await waitChip(false, "chip tắt sau khi lưu");
    expect(s4.dirty === false, "tài liệu sạch sau khi lưu");
    const disk = fs.readFileSync(DOC);
    expect(disk.length > ORIGINAL.length && disk.subarray(0, ORIGINAL.length).equals(ORIGINAL), "đĩa = bản gốc + phần nối thêm");
    expect(verify(DOC).code === 0, "OpenSSL: chữ ký còn hợp lệ trên file vừa lưu");

    // ---- W5 ----
    console.log("\nW5  sửa lại sau khi lưu ⇒ quét lại");
    await rotate();
    await waitChip(true, "chip hiện lại sau lần sửa đầu của vòng mới");
    c = await chip();
    expect(c.hidden === false && /\d+ chữ ký/.test(c.text), `chip hiện lại: ${JSON.stringify(c.text)}`);
    app.dialogs.answer({ showMessageBox: [0] });
    await page.eval(`(async () => { await saveDoc(); })()`, { timeout: 120000 });
    await waitChip(false, "chip tắt sau lần lưu thứ hai");

    // ---- W5b ----
    console.log("\nW5b ẩn trang trên file ký (đường đặt cờ bẩn thẳng, KHÔNG qua markDirty) ⇒ chip");
    c = await chip();
    expect(c.hidden === true, "tiền điều kiện: đang sạch, chip tắt");
    const setVal = (id, v) =>
      page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await page.eval(`window.__hide = hidePagesWithPassword([1]); true`);
    await page.waitFor(`!document.getElementById("vault-modal").hidden`, { timeout: 10000, what: "hộp mật khẩu ẩn trang hiện" });
    await setVal("vault-pw", "mat-khau-e2e");
    await setVal("vault-pw2", "mat-khau-e2e");
    await page.click("#vault-ok");
    expect((await page.eval(`window.__hide`)) === true, "ẩn trang thành công");
    await waitChip(true, "chip hiện sau khi ẩn trang");
    c = await chip();
    expect(c.hidden === false && /\d+ chữ ký/.test(c.text), `chip hiện sau ẩn trang: ${JSON.stringify(c.text)}`);
    expect((await page.eval(`state.contentRemoved`)) === true, "đã đánh dấu contentRemoved (Lưu sẽ KHÔNG đề nghị nối — BI-130)");

    // ---- W6 ----
    console.log("\nW6  file KHÔNG ký (có đường dẫn) rồi sửa");
    const plainBytes = await makePdf(3);
    const PLAIN = path.join(work, "thuong.pdf");
    fs.writeFileSync(PLAIN, plainBytes);
    app.dialogs.answer({});
    await app.openPdf(plainBytes, "thuong.pdf", { srcPath: PLAIN });
    await rotate();
    await sleep(1500);
    c = await chip();
    expect(c.hidden === true, `không chip với file không ký (${JSON.stringify(c)})`);

    // ---- W7 ----
    console.log("\nW7  tài liệu chưa có đường dẫn rồi sửa");
    // (`app.openPdf` tự đặt dirty=false trước khi nạp nên không có hộp "Bỏ thay đổi?" chặn.)
    await app.openPdf(await makePdf(2), "moi.pdf"); // không `srcPath` ⇒ state.path = null
    c = await chip();
    expect(c.hidden === true, `mở tài liệu mới xoá chip của tài liệu cũ (${JSON.stringify(c)})`);
    const r7 = await rotate();
    await sleep(1500);
    c = await chip();
    expect(r7.dirty === true && !r7.path, `đã sửa, không đường dẫn (${JSON.stringify(r7)})`);
    expect(c.hidden === true, `không chip khi chưa có đường dẫn (${JSON.stringify(c)})`);

    expect(app.dialogs.unexpected().length === 0, `không hộp thoại native bất ngờ (${app.dialogs.unexpected().length})`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    await app.close().catch(() => {});
    await sleep(800);
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
  console.log("Cảnh báo file đã ký đúng trong app thật: hiện ở lần sửa đầu, tắt khi lưu, quét lại, im với file không ký / chưa có đường dẫn.");
})();
