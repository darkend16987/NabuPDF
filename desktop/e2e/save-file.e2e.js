"use strict";

// BI-145 — `dialog:save-file` (xuất xlsx/csv/json/docx/zip) trong APP ELECTRON THẬT: preload → IPC → handler → đĩa.
//
// Hộp "Lưu file" native được thay bằng móc `test-hooks.js` (đáp án đặt trước); mọi thứ còn lại là thật: `window.desktop.saveFile`
// của preload, IPC thật, `AtomicWrite` thật, đĩa thật. Không cần sidecar (bắt đầu từ lúc có bytes trong tay).
//
//   F1  file mới: byte lên đĩa khớp từng byte (SHA-256), không để rác `.nabu-tmp`, hộp nhận đúng tên mặc định + bộ lọc.
//   F2  ĐÈ lên bản xuất cũ DÀI HƠN: bản mới thay hẳn, không còn đuôi bản cũ, không rác.
//   F3  Huỷ hộp thoại: `saved:false`, file cũ còn nguyên.
//   F4  8 MB qua IPC: nội dung khớp SHA-256 (đường dữ liệu lớn không bị cắt/đổi bởi đường nguyên tử).
//   F5  đích KHÔNG ghi được (thư mục không tồn tại): lỗi báo về renderer (không nuốt), không tạo thứ gì, app vẫn sống và lưu tiếp được.
//
// Không phủ (đã có ở nơi khác): sập GIỮA lúc ghi — `test:atomic` (giết tiến trình thật), `test:savefile` (chèn ENOSPC / đổi tên hỏng).
//
// Chạy:  cd desktop ; node e2e/save-file.e2e.js     (hoặc: npm run e2e -- save-file)

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch } = require("./lib/app-driver");

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-savefile-"));
  const out = path.join(work, "out");
  fs.mkdirSync(out);
  const rest = () => fs.readdirSync(out);
  const tmps = () => rest().filter((f) => f.endsWith(".nabu-tmp"));
  const app = await launch();
  try {
    const page = await app.ready({ sidecar: false });

    // Gọi preload thật với một Uint8Array dựng trong renderer (nội dung xác định theo `seed`). Trả { saved, path, error }.
    const saveFile = (len, seed, name, filtersJson = "[]") =>
      page.eval(
        `(async () => {
           const b = new Uint8Array(${len});
           for (let i = 0; i < b.length; i++) b[i] = (i * 31 + ${seed}) & 255;
           try { const r = await window.desktop.saveFile(b, ${JSON.stringify(name)}, ${filtersJson}); return { saved: !!r.saved, path: r.path || null }; }
           catch (e) { return { saved: false, error: String(e && e.message || e) }; }
         })()`,
        { timeout: 60000 },
      );
    const expected = (len, seed) => {
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i++) b[i] = (i * 31 + seed) & 255;
      return b;
    };

    // ---- F1 ----
    console.log("F1  file mới");
    const f1 = path.join(out, "bang-tinh.xlsx");
    app.dialogs.answer({ showSaveDialog: [f1] });
    let r = await saveFile(4096, 7, "bang-tinh.xlsx", `[{ name: "XLSX", extensions: ["xlsx"] }]`);
    expect(r.saved === true && r.path === f1, `saved:true + đúng đường dẫn (${JSON.stringify(r)})`);
    expect(fs.existsSync(f1) && sha(fs.readFileSync(f1)) === sha(expected(4096, 7)), "byte trên đĩa khớp SHA-256");
    expect(tmps().length === 0, `không rác .nabu-tmp (${JSON.stringify(tmps())})`);
    const dlg = app.dialogs.calls().filter((c) => c.method === "showSaveDialog");
    expect(dlg.length === 1, `hộp Lưu hiện đúng 1 lần (${dlg.length})`);
    const opt = (dlg[0] && dlg[0].options) || {};
    expect(/bang-tinh\.xlsx$/.test(String(opt.defaultPath || "")), `tên mặc định đúng (${opt.defaultPath})`);
    expect(JSON.stringify(opt.filters) === JSON.stringify([{ name: "XLSX", extensions: ["xlsx"] }]), "bộ lọc truyền đúng");

    // ---- F2 ----
    console.log("\nF2  đè lên bản xuất cũ dài hơn");
    const f2 = path.join(out, "cu.csv");
    fs.writeFileSync(f2, Buffer.alloc(50000, 0x41));
    app.dialogs.answer({ showSaveDialog: [f2] });
    r = await saveFile(1000, 3, "cu.csv");
    expect(r.saved === true, "saved:true");
    const got2 = fs.readFileSync(f2);
    expect(got2.length === 1000 && sha(got2) === sha(expected(1000, 3)), `bản mới thay hẳn (${got2.length} B, không còn đuôi 'A' của bản cũ)`);
    expect(tmps().length === 0, "không rác");

    // ---- F3 ----
    console.log("\nF3  huỷ hộp thoại");
    const f3 = path.join(out, "giu.json");
    fs.writeFileSync(f3, "GIU-NGUYEN");
    app.dialogs.answer({ showSaveDialog: [null] });
    r = await saveFile(10, 1, "giu.json");
    expect(r.saved === false && !r.error, `saved:false, không lỗi (${JSON.stringify(r)})`);
    expect(fs.readFileSync(f3, "utf8") === "GIU-NGUYEN", "file cũ còn nguyên");

    // ---- F4 ----
    console.log("\nF4  8 MB qua IPC");
    const f4 = path.join(out, "lon.zip");
    app.dialogs.answer({ showSaveDialog: [f4] });
    const N = 8 * 1024 * 1024;
    r = await saveFile(N, 11, "lon.zip", `[{ name: "ZIP", extensions: ["zip"] }]`);
    expect(r.saved === true, "saved:true");
    expect(fs.existsSync(f4) && fs.statSync(f4).size === N && sha(fs.readFileSync(f4)) === sha(expected(N, 11)), "đủ 8 MB, SHA-256 khớp");
    expect(tmps().length === 0, "không rác");

    // ---- F5 ----
    console.log("\nF5  đích không ghi được (thư mục không tồn tại)");
    const before = rest().slice().sort();
    const bad = path.join(out, "khong-co-thu-muc", "x.xlsx");
    app.dialogs.answer({ showSaveDialog: [bad] });
    r = await saveFile(100, 5, "x.xlsx");
    expect(r.saved === false && !!r.error, `lỗi báo về renderer, không nuốt (${JSON.stringify(r)})`);
    expect(!fs.existsSync(path.dirname(bad)), "không tự tạo thư mục / file nào ở đích");
    expect(JSON.stringify(rest().slice().sort()) === JSON.stringify(before), "thư mục xuất không có thêm gì");
    const f5 = path.join(out, "sau-loi.xlsx");
    app.dialogs.answer({ showSaveDialog: [f5] });
    r = await saveFile(100, 5, "sau-loi.xlsx");
    expect(r.saved === true && sha(fs.readFileSync(f5)) === sha(expected(100, 5)), "app vẫn sống, lưu tiếp được sau lỗi");

    expect(app.dialogs.unexpected().length === 0, `không hộp thoại native bất ngờ (${app.dialogs.unexpected().length})`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    await app.close().catch(() => {});
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
  console.log("dialog:save-file đúng trong app thật: file mới, đè bản cũ, huỷ, 8 MB, đích hỏng — và không để rác.");
})();
