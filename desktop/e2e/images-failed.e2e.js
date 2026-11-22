"use strict";

// BI-141 — "nén xong nhưng không nén lại được ảnh" (BI-122) trong APP ELECTRON THẬT. Gộp hai probe cũ
// (`scripts/probe-images-failed.js` và `probe-images-failed-toast.js`) vào bộ khung e2e, GIỮ NGUYÊN các phép khẳng định.
//
//   A. header `X-Images-Failed` có TỚI ĐƯỢC `res.headers.get(...)` trong renderer không (đúng cả hai chiều)?
//      ĐÍNH CHÍNH sau khi đột biến chính e2e này (mutant E2): api.py cảnh báo rằng header chỉ hiện ra nếu nằm trong
//      `expose_headers` của CORS middleware (renderer chạy từ file:// nên "mọi lệnh gọi sidecar là cross-origin"). ĐO ĐƯỢC không
//      đúng trong Electron lúc này: `res.type === "basic"` (không phải "cors") và renderer đọc được `x-images-failed` KỂ CẢ khi
//      sidecar KHÔNG liệt kê nó trong `expose_headers` — mutant bỏ dòng đó vẫn xanh. Vậy phần A chứng minh header ĐẾN ĐƯỢC
//      renderer, KHÔNG chứng minh dòng `expose_headers`; và tôi KHÔNG biết vì sao Electron không lọc (không thấy `webSecurity:false`
//      nào trong src/). Dòng `expose_headers` có thể vẫn cần cho client khác hoặc nếu Electron đổi hành vi — nên `res.type` được
//      ghi ra bên dưới: nếu một ngày nó thành "cors", phần A mới thật sự bắt được việc thiếu `expose_headers`.
//   B. đi hết đường `runCompress()`: câu toast cuối cùng người dùng đọc + file thật ra đĩa. Thứ duy nhất của BI-122 mà không
//      lưới nào chạm tới là CHUỖI CHỮ ấy. `runCompress` kết thúc bằng hộp Lưu native — trước đây phải nối `--inspect` vào main để
//      thay `dialog.showSaveDialog`; nay móc hộp thoại trả lời đường dẫn trong thư mục tạm, còn IPC/`fs`/renderer là mã ship thật.
//
// Hai chiều ở cả hai phần (file gây lỗi ảnh ⇒ có; file lành ⇒ KHÔNG), để câu/ header không phải thứ lúc nào cũng hiện.
// Cần corpus pdf.js ngoài repo (NABU_CORPUS) — thiếu ⇒ thoát mã 2.
//
// Chạy:  cd desktop ; node e2e/images-failed.e2e.js     (hoặc: npm run e2e -- images)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch } = require("./lib/app-driver");

const CORPUS = process.env.NABU_CORPUS || "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
const HEADER_CASES = [
  { file: "jpx_smaskindata.pdf", mongDoi: true }, // rewrite_images ném lỗi ⇒ worker thoát 4 ⇒ có header
  { file: "tracemonkey.pdf", mongDoi: false }, // tài liệu lành ⇒ không được có header
];
const TOAST_CASES = [
  { file: "clippath.pdf", mongDoiCauAnh: true }, // 459 B, rewrite_images ném "Bad PatternType" ⇒ phải có câu về ảnh
  { file: "tracemonkey.pdf", mongDoiCauAnh: false }, // 1 MB, lành ⇒ KHÔNG có câu đó
];
for (const f of new Set([...HEADER_CASES, ...TOAST_CASES].map((c) => c.file))) {
  if (!fs.existsSync(path.join(CORPUS, f))) {
    console.log(`BỎ QUA: không thấy ${f} trong ${CORPUS} (cần corpus pdf.js, xem docs/CORPUS-SWEEP.md)`);
    process.exit(2);
  }
}

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-imgfail-"));
  const app = await launch();
  try {
    const page = await app.ready();

    // ---- A. header qua CORS --------------------------------------------------------------------------
    console.log("A  header X-Images-Failed qua CORS tới renderer");
    for (const { file, mongDoi } of HEADER_CASES) {
      const b64 = fs.readFileSync(path.join(CORPUS, file)).toString("base64");
      const r = await page.eval(
        `(async () => {
           const bin = atob(${JSON.stringify(b64)});
           const u8 = new Uint8Array(bin.length);
           for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
           const res = await sidecarFetch("/compress-bin?preset=ebook", {
             method: "POST",
             headers: { "Content-Type": "application/pdf" },
             body: new Blob([u8], { type: "application/pdf" }),
           });
           const buf = await res.arrayBuffer();
           return { ok: res.ok, type: res.type, imagesFailed: res.headers.get("X-Images-Failed"), filename: !!res.headers.get("X-Filename"),
                    hienRa: [...res.headers.keys()], bytes: buf.byteLength };
         })()`,
        { timeout: 180000 },
      );
      const got = r.imagesFailed === "1";
      expect(
        r.ok && got === mongDoi,
        `${file}: X-Images-Failed=${JSON.stringify(r.imagesFailed)} (mong đợi ${mongDoi ? "có" : "không"}); X-Filename=${r.filename ? "có" : "KHÔNG"}; res.type=${r.type}; ${r.bytes} B; header renderer ĐỌC ĐƯỢC: ${JSON.stringify(r.hienRa)}`,
      );
    }

    // ---- B. toast + file ra đĩa -----------------------------------------------------------------------
    console.log("\nB  chạy đúng runCompress(): câu toast + file thật ra đĩa");
    const outPath = path.join(outDir, "probe-out.pdf");
    for (const { file, mongDoiCauAnh } of TOAST_CASES) {
      try {
        fs.rmSync(outPath, { force: true });
      } catch (_) {}
      app.dialogs.answer({ showSaveDialog: [outPath] });
      await app.openPdf(path.join(CORPUS, file), file);
      await page.clearToast();
      await page.eval(`runCompress()`, { timeout: 180000 });
      const t = await page.toast();
      const raDia = fs.existsSync(outPath) ? fs.statSync(outPath).size : null;
      const dauFile = raDia ? fs.readFileSync(outPath).subarray(0, 4).toString("latin1") : "";
      const coCauAnh = /nh trong file n/i.test(t.text || "");
      const mauDung = mongDoiCauAnh ? /\bwarn\b/.test(t.kind) : /\bgood\b/.test(t.kind);
      expect(
        raDia > 0 && dauFile === "%PDF" && coCauAnh === mongDoiCauAnh && mauDung,
        `${file}: toast=${JSON.stringify(t.text)} class="${t.kind}" (mong đợi ${mongDoiCauAnh ? "warn + có câu về ảnh" : "good + không có câu đó"}); ra đĩa ${raDia} B, bắt đầu bằng ${JSON.stringify(dauFile)}`,
      );
      const hop = app.dialogs.calls().filter((c) => c.method === "showSaveDialog");
      expect(hop.length === 1, `${file}: hộp Lưu hiện đúng 1 lần (${hop.length})`);
    }
    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ (${app.dialogs.unexpected().length})`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    await app.close();
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("");
  if (failures.length) {
    console.log("CÓ VẤN ĐỀ:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Header tới được renderer đúng cả hai chiều (chưa chứng minh dòng expose_headers — xem đầu file), câu toast hiện đúng cả hai chiều, và file thật sự ra đĩa.");
})();
