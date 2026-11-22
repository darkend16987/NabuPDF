"use strict";

// BI-141 — nút HỦY của ba thao tác chạy ở sidecar (Nén BI-126 · Tách BI-139 · Đánh số trang BI-140), bấm THẬT trong app
// Electron thật. Thay cho ba probe riêng (`scripts/probe-{compress,split,pagenum}-cancel.js`, ~850 dòng chép lặp) bằng một
// kịch bản dùng bộ khung, GIỮ NGUYÊN các phép đo cũ và thêm hai thứ mà các probe cũ không có:
//   · sau khi Hủy, MỘT THAO TÁC KẾ TIẾP trên file lành vẫn chạy được đến cùng (sidecar không bị hủy làm hỏng) — đi qua
//     móc hộp thoại cho bước Lưu;
//   · không có hộp thoại bất ngờ nào (`dialogs.unexpected()` rỗng).
//
// FILE TEST. Mỗi thao tác cần một file mà nó KHÔNG BAO GIỜ xong (nên probe dừng được trong vài giây thì chỉ có một cách giải
// thích — nút Hủy đã cắt ngang): `bomb_giant.pdf` treo ở nén và đánh số trang; `bug1978317.pdf` treo ở tách (BI-123/138/140).
// Cần corpus pdf.js ngoài repo (NABU_CORPUS) — thiếu ⇒ thoát mã 2 (BỎ QUA, chưa kiểm).
//
// BẰNG CHỨNG CỨNG. Ngoài câu toast, đếm tiến trình mang cờ worker trước/sau khi bấm (≥1 rồi 0) và hỏi /health (ta giết tiến
// trình con, không phải sidecar). Ở dev worker là một CẶP tiến trình (stub venv + python thật), ở bản đóng gói là MỘT — con
// số phải về 0 sau khi hủy, đừng ghim cứng "đúng 2".
//
// Chạy:  cd desktop ; node e2e/cancel.e2e.js     (hoặc: npm run e2e -- cancel)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch } = require("./lib/app-driver");
const { makePdf } = require("./lib/fixtures");

const CORPUS = process.env.NABU_CORPUS || "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
const HUNG = { compress: "bomb_giant.pdf", split: "bug1978317.pdf", pagenum: "bomb_giant.pdf" };
for (const f of new Set(Object.values(HUNG))) {
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

// Mỗi thao tác: cách đặt ô nhập, hàm bấm, cờ worker, câu toast khi hủy, và bước "kế tiếp" trên file lành.
const OPS = [
  {
    key: "compress",
    title: "NÉN",
    flag: "--compress-worker",
    cancelToast: "Đã hủy nén.",
    setup: `document.getElementById("cmp-preset").value = "ebook";`,
    run: "runCompress()",
  },
  {
    key: "split",
    title: "TÁCH",
    flag: "--split-worker",
    cancelToast: "Đã hủy tách.",
    setup: `document.getElementById("split-mode").value = "every"; document.getElementById("split-size").value = "1";`,
    run: "runSplit()",
  },
  {
    key: "pagenum",
    title: "ĐÁNH SỐ TRANG",
    flag: "--pagenum-worker",
    cancelToast: "Đã hủy đánh số.",
    setup:
      `document.getElementById("pgnum-fmt").value = "n"; document.getElementById("pgnum-pos").value = "bottom-center";` +
      ` document.getElementById("pgnum-start").value = "1"; document.getElementById("pgnum-skip").value = "0";`,
    run: "runPageNumbers()",
  },
];

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-cancel-"));
  const app = await launch();
  try {
    const page = await app.ready();
    const small = await makePdf(2);

    for (const op of OPS) {
      console.log(`\n=== ${op.title} ===`);
      const name = HUNG[op.key];
      // Viewer vẽ `bomb_giant.pdf` mất ~147 s (đo được) — không phải thứ ta đang kiểm. Mở một tài liệu nhỏ lành bằng
      // `loadBytes` THẬT (giao diện nhất quán), rồi thay `state.bytes` bằng file không-bao-giờ-xong để thao tác Ở SIDECAR
      // đọc đúng byte đó. Ghi chú: các probe cũ chờ `loadBytes` 147 s không hạn giờ nên lặng lẽ mất ~2,5 phút mỗi lần mở.
      await app.openPdf(small, "nho.pdf");
      await app.setBytesUnrendered(path.join(CORPUS, name));
      await page.clearToast();
      app.dialogs.answer({}); // kịch bản rỗng: hủy thì KHÔNG được có hộp thoại nào hiện ra
      console.log(`  bấm ${op.title} trên ${name} (file này không bao giờ xong)`);
      await page.eval(
        `(() => { ${op.setup}
           globalThis.__xong = null; globalThis.__goc = state.bytes; globalThis.__t0 = Date.now();
           ${op.run}.then(() => { globalThis.__xong = Date.now() - globalThis.__t0; });
           return true; })()`,
      );

      const ui = await page.waitFor(
        `(() => { const ov = document.getElementById("overlay"); const b = document.getElementById("overlay-cancel");
           return (!ov.hidden && !b.hidden) ? { khoa: b.disabled, chu: b.textContent.trim() } : null; })()`,
        { timeout: 30000, what: "lớp phủ + nút Hủy hiện ra" },
      );
      expect(ui.khoa === false, `nút Hủy hiện ra và không khoá (chữ: "${ui.chu}")`);

      // Đợi worker ra đời thật (poll thay vì ngủ cứng 3 s như các probe cũ).
      let ds = [];
      for (let i = 0; i < 60 && ds.length < 1; i++) {
        ds = app.workers(op.flag);
        if (!ds.length) await new Promise((r) => setTimeout(r, 500));
      }
      console.log(`  worker sống ngay trước khi bấm Hủy: ${ds.length} (pid ppid: ${ds.map((d) => d.pid + " " + d.ppid).join(" | ")})`);
      expect(ds.length >= 1, "có ≥1 worker đang chạy (có gì để hủy)");

      const t0 = Date.now();
      await page.click("#overlay-cancel"); // .click() thật trên phần tử thật, không gọi tắt hàm hủy
      const xong = await page
        .waitFor(`globalThis.__xong !== null ? globalThis.__xong : false`, { timeout: 30000, interval: 100, what: `${op.run} kết thúc` })
        .catch(() => null);
      const dt = (Date.now() - t0) / 1000;
      const sau = await page.eval(
        `(() => { const ov = document.getElementById("overlay"); const el = document.getElementById("toast");
           return { phu: !ov.hidden, toast: el.textContent, kind: el.className, nguyen: state.bytes === globalThis.__goc }; })()`,
      );
      const con = app.workers(op.flag).length;
      console.log(`  ${op.run} kết thúc: ${xong === null ? "KHÔNG" : xong + " ms"}; bấm→xong ${dt.toFixed(2)} s; toast ${JSON.stringify(sau.toast)}; còn ${con} worker`);

      expect(xong !== null, `${op.run} kết thúc sau khi Hủy (không treo)`);
      expect(dt < 15, `bấm Hủy xong dừng trong ${dt.toFixed(1)} s (< 15 s)`);
      expect(sau.toast.trim() === op.cancelToast, `toast đúng: ${JSON.stringify(sau.toast)}`);
      expect(!/\bbad\b/.test(sau.kind), "Hủy KHÔNG bị báo như lỗi (toast không đỏ)");
      expect(sau.phu === false, "lớp phủ tắt");
      expect(con === 0, `0 worker còn sống (còn ${con})`);
      expect(sau.nguyen, "tài liệu đang mở còn NGUYÊN (cùng đối tượng state.bytes)");
      const health = await page.eval(`(async () => (await fetch(sidecar.base + "/health")).status)()`);
      expect(health === 200, `sidecar vẫn sống: /health = ${health}`);
      expect(app.dialogs.calls().length === 0, `hủy không làm hiện hộp thoại nào (${app.dialogs.calls().length})`);
    }

    // ---- MỚI: sau ba lần Hủy, thao tác kế tiếp trên file lành vẫn chạy đến cùng ------------------------------
    console.log("\n=== SAU KHI HỦY: thao tác kế tiếp trên file lành ===");
    const good = await makePdf(5);

    {
      const out = path.join(work, "nen.pdf");
      await app.openPdf(good, "lanh.pdf");
      await page.clearToast();
      app.dialogs.answer({ showSaveDialog: [out] });
      await page.eval(`(() => { document.getElementById("cmp-preset").value = "ebook"; return true; })()`);
      await page.eval(`runCompress()`, { timeout: 120000 });
      const t = await page.toast();
      expect(fs.existsSync(out) && fs.readFileSync(out).subarray(0, 5).toString() === "%PDF-", "NÉN file lành sau khi hủy: ra file PDF thật");
      expect(!/\bbad\b/.test(t.kind), `… toast không đỏ: ${JSON.stringify(t.text)}`);
    }
    {
      const out = path.join(work, "tach.zip");
      await app.openPdf(good, "lanh.pdf");
      await page.clearToast();
      app.dialogs.answer({ showSaveDialog: [out] });
      await page.eval(`(() => { document.getElementById("split-mode").value = "every"; document.getElementById("split-size").value = "2"; return true; })()`);
      await page.eval(`runSplit()`, { timeout: 120000 });
      const t = await page.toast();
      expect(fs.existsSync(out) && fs.readFileSync(out).subarray(0, 2).toString() === "PK", "TÁCH file lành sau khi hủy: ra file .zip thật");
      expect(/3 file/.test(t.text) && !/\bbad\b/.test(t.kind), `… 5 trang chia 2 ⇒ 3 file: ${JSON.stringify(t.text)}`);
    }
    {
      await app.openPdf(good, "lanh.pdf");
      await page.clearToast();
      app.dialogs.answer({});
      const before = await page.eval(`state.bytes.length`);
      await page.eval(
        `(() => { document.getElementById("pgnum-fmt").value = "n"; document.getElementById("pgnum-pos").value = "bottom-center";
           document.getElementById("pgnum-start").value = "1"; document.getElementById("pgnum-skip").value = "0"; return true; })()`,
      );
      await page.eval(`runPageNumbers()`, { timeout: 120000 });
      const t = await page.toast();
      const after = await page.eval(`({ len: state.bytes.length, pages: state.numPages, dirty: state.dirty })`);
      expect(after.len > before && after.pages === 5, `ĐÁNH SỐ file lành sau khi hủy: tài liệu đổi (${before} → ${after.len} B, ${after.pages} trang)`);
      expect(/Đã đánh số trang/.test(t.text) && !/\bbad\b/.test(t.kind), `… toast: ${JSON.stringify(t.text)}`);
    }

    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ nào suốt kịch bản (${app.dialogs.unexpected().length})`);
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
  console.log("Nút Hủy của Nén / Tách / Đánh số dùng được trên file không bao giờ xong, sidecar sống, và thao tác kế tiếp vẫn chạy.");
})();
