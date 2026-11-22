"use strict";

// BI-141 / ma trận §5 — GHÉP NHIỀU TRANG VÀO MỘT TỜ (N-up: renderer/page-nup.js, openNup/askNup/runNup, #nup-modal) trong APP
// ELECTRON THẬT, qua đúng hộp thoại của app. Mỗi trang mẫu có BỀ RỘNG RIÊNG nên đọc lại `state.bytes` bằng pdf-lib ở Node là biết
// trang nào còn nguyên, trang nào đã thành tờ (A4 dọc ≈ 595 pt).
//
//   N1  tất cả trang, 2 trang/tờ: 7 trang → 4 tờ, đủ khổ A4; hộp nêu đúng "ghép 7 trang thành 4 tờ"; MỘT bước hoàn tác (commitBytes,
//       BI-3); hoàn tác & làm lại trả ĐÚNG byte
//   N2  chọn khoảng "2-5", 4 trang/tờ: trang 1, [một tờ], trang 6, 7 — trang ngoài khoảng ĐỨNG NGUYÊN chỗ và nguyên khổ
//   N3  Huỷ hộp / để trống khoảng trang ⇒ không đổi gì, không bước hoàn tác, nút OK tắt
//   N4  trang có liên kết/chú thích: hỏi trước ("sẽ KHÔNG được giữ"); Huỷ ⇒ không đổi; "Vẫn ghép" ⇒ ghép
//   N5  đang có trang ẩn có khoá ⇒ bị chặn kèm lời nhắc, KHÔNG mở hộp (ghép sẽ phá bản mã)
//
// KHÔNG tự động hoá: nhìn xem bố cục trên tờ có ĐẸP/đúng ô (cần mắt hoặc so ảnh), viền mảnh, in ra. Phần hình học ô đã có
// `npm run test:nup` (page-nup.test.js).
//
// Cần phiên có giao diện. Không cần sidecar.
//
// Chạy:  cd desktop ; node e2e/nup.e2e.js     (hoặc: npm run e2e -- nup)

const { PDFDocument, PDFName } = require("pdf-lib");
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
  const WIDTHS = [410, 420, 430, 440, 450, 460, 470];
  const plain = await makePdf(7, { widths: WIDTHS });
  // cùng tài liệu nhưng trang 3 có một liên kết (annotation)
  const withLink = await (async () => {
    const doc = await PDFDocument.load(plain);
    const ctx = doc.context;
    const ref = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 80, 40], Border: [0, 0, 0] }));
    doc.getPages()[2].node.set(PDFName.of("Annots"), ctx.obj([ref]));
    return Buffer.from(await doc.save());
  })();
  let app = null;
  try {
    app = await launch();
    const page = await app.ready({ sidecar: false });
    const widths = async () => (await PDFDocument.load(await page.stateBytes())).getPages().map((p) => Math.round(p.getWidth()));
    const st = () => page.eval(`({ n: state.numPages, dirty: state.dirty, nUndo: history.undo.length })`);
    const toastText = () => page.eval(`document.getElementById("toast").textContent`);
    const open = async (bytes, name) => {
      await app.openPdf(bytes, name);
      await page.clearToast();
    };
    const modalVisible = (id, want = true) => page.waitFor(`document.getElementById(${J(id)}).hidden === ${!want}`, { timeout: 10000, what: `hộp ${id} ${want ? "hiện" : "đóng"}` });
    // Mở hộp N-up bằng `openNup()` thật (không đợi — nó đợi hộp). `cfg`: { per, spec } — spec null = "tất cả".
    const fillNup = async ({ per = 2, spec = null } = {}) => {
      await page.eval(`window.__op = openNup(); true`);
      await modalVisible("nup-modal");
      await page.eval(`(() => {
        const per = document.getElementById("nup-per"); per.value = ${J(String(per))}; per.dispatchEvent(new Event("change", { bubbles: true }));
        ${
          spec == null
            ? `document.getElementById("nup-all").checked = true; document.getElementById("nup-all").dispatchEvent(new Event("change", { bubbles: true }));`
            : `const i = document.getElementById("nup-spec"); i.value = ${J(spec)}; i.dispatchEvent(new Event("input", { bubbles: true }));`
        }
        return true; })()`);
      return page.eval(`({ hint: document.getElementById("nup-hint").textContent, okOff: document.getElementById("nup-ok").disabled })`);
    };
    const confirmNup = async () => {
      await page.click("#nup-ok");
    };

    // ---- N1 -----------------------------------------------------------------------------------------------------
    console.log("N1  tất cả 7 trang, 2 trang/tờ ⇒ 4 tờ A4; một bước hoàn tác; hoàn tác/làm lại đúng byte");
    await open(plain, "bay-trang.pdf");
    const h0 = await page.eval(HASH);
    expect(J(await widths()) === J(WIDTHS), "tiền điều kiện: 7 trang đúng khổ");
    let f = await fillNup({ per: 2 });
    expect(/ghép 7 trang thành 4 tờ/.test(f.hint) && !f.okOff, `hộp nêu: ${J(f.hint)}`);
    await confirmNup();
    await page.eval(`window.__op`);
    await until(async () => (await st()).n === 4);
    const w1 = await widths();
    expect(w1.length === 4 && w1.every((w) => w === 595), `4 tờ, đều khổ A4 dọc: ${J(w1)}`);
    let s = await st();
    expect(s.dirty && s.nUndo === 1, `bẩn, đúng 1 bước hoàn tác: ${J(s)}`);
    expect(/Đã ghép 7 trang thành 4 tờ/.test(await toastText()), `toast: ${J(await toastText())}`);
    const hSheets = await page.eval(HASH);
    await page.eval(`undo()`);
    expect(await until(async () => (await page.eval(HASH)) === h0), "hoàn tác ⇒ ĐÚNG byte ban đầu");
    expect(J(await widths()) === J(WIDTHS), "7 trang nguyên khổ trở lại");
    await page.eval(`redo()`);
    expect(await until(async () => (await page.eval(HASH)) === hSheets), "làm lại ⇒ ĐÚNG byte đã ghép");

    // ---- N2 -----------------------------------------------------------------------------------------------------
    console.log("\nN2  chọn '2-5', 4 trang/tờ ⇒ trang 1, [một tờ], trang 6, 7");
    await open(plain, "bay-trang.pdf");
    f = await fillNup({ per: 4, spec: "2-5" });
    expect(/ghép 4 trang thành 1 tờ/.test(f.hint) && /còn 4 trang/.test(f.hint), `hộp nêu: ${J(f.hint)}`);
    await confirmNup();
    await page.eval(`window.__op`);
    await until(async () => (await st()).n === 4);
    expect(J(await widths()) === J([410, 595, 460, 470]), `trang ngoài khoảng đứng nguyên chỗ và khổ: ${J(await widths())}`);
    await page.eval(`undo()`);
    expect(await until(async () => (await page.eval(HASH)) === h0), "hoàn tác ⇒ ĐÚNG byte ban đầu");

    // ---- N2b: chọn RỜI RẠC: tờ đứng ở vị trí của trang được chọn ĐẦU TIÊN ----
    console.log("\nN2b  chọn rời rạc '2,4' (2 trang/tờ) ⇒ tờ đứng ở chỗ trang 2; trang 3 và 5–7 vẫn nguyên");
    await open(plain, "bay-trang.pdf");
    f = await fillNup({ per: 2, spec: "2,4" });
    await confirmNup();
    await page.eval(`window.__op`);
    await until(async () => (await st()).n === 6);
    expect(J(await widths()) === J([410, 595, 430, 450, 460, 470]), `tờ ở vị trí trang chọn đầu tiên: ${J(await widths())}`);
    // ---- N3 -----------------------------------------------------------------------------------------------------
    console.log("\nN3  Huỷ hộp / để trống khoảng trang ⇒ không đổi gì");
    await open(plain, "bay-trang.pdf");
    f = await fillNup({ per: 2, spec: "" });
    expect(f.okOff, `để trống khoảng trang: nút OK tắt (${J(f.hint)})`);
    await page.click("#nup-cancel");
    await page.eval(`window.__op`);
    s = await st();
    expect((await page.eval(HASH)) === h0 && !s.dirty && s.nUndo === 0, `Huỷ: tài liệu y nguyên, không bẩn, không bước hoàn tác: ${J(s)}`);

    // ---- N4 -----------------------------------------------------------------------------------------------------
    console.log("\nN4  trang có liên kết: hỏi trước; Huỷ ⇒ không đổi; 'Vẫn ghép' ⇒ ghép");
    await open(withLink, "co-lien-ket.pdf");
    const hL = await page.eval(HASH);
    await fillNup({ per: 2 });
    await confirmNup();
    await modalVisible("confirm-modal");
    const msg = await page.eval(`document.getElementById("confirm-msg").textContent`);
    expect(/1 chú thích \/ liên kết \/ ô biểu mẫu/.test(msg) && /KHÔNG được giữ/.test(msg), `hộp cảnh báo: ${J(msg)}`);
    await page.click("#confirm-cancel");
    await page.eval(`window.__op`);
    s = await st();
    expect((await page.eval(HASH)) === hL && s.n === 7 && s.nUndo === 0 && !s.dirty, `Huỷ cảnh báo: không đổi gì: ${J(s)}`);
    await fillNup({ per: 2 });
    await confirmNup();
    await modalVisible("confirm-modal");
    await page.click("#confirm-ok");
    await page.eval(`window.__op`);
    await until(async () => (await st()).n === 4);
    s = await st();
    expect(s.n === 4 && s.nUndo === 1, `'Vẫn ghép' ⇒ ghép (4 tờ, 1 bước hoàn tác): ${J(s)}`);

    // ---- N5 -----------------------------------------------------------------------------------------------------
    console.log("\nN5  đang có trang ẩn ⇒ bị chặn, không mở hộp");
    await open(plain, "bay-trang.pdf");
    await page.eval(`window.__h = hidePagesWithPassword([1]); true`);
    await modalVisible("vault-modal");
    await page.eval(`(() => { for (const id of ["vault-pw", "vault-pw2"]) { const e = document.getElementById(id); e.value = "mk-1"; e.dispatchEvent(new Event("input", { bubbles: true })); } return true; })()`);
    await page.click("#vault-ok");
    await page.eval(`window.__h`);
    const hHidden = await page.eval(HASH);
    await page.clearToast();
    await page.eval(`openNup()`);
    await sleep(500);
    expect(/Tài liệu đang có trang ẩn/.test(await toastText()), `có lời nhắc: ${J(await toastText())}`);
    expect(await page.eval(`document.getElementById("nup-modal").hidden`), "hộp N-up không mở");
    expect((await page.eval(HASH)) === hHidden, "tài liệu y nguyên");

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
  }

  console.log("");
  if (failures.length) {
    console.log("CÓ VẤN ĐỀ:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("N-up đúng ở cả 5 nhóm ca. Bố cục thấy được trên tờ (ô, viền) vẫn phải nhìn bằng mắt.");
})();
