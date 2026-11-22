"use strict";

// BI-141 / ma trận §5 — TẦNG TAB (docs/TABS-TEST-L1.md) trong APP ELECTRON THẬT, đường BẤM CHUỘT trên thanh tab.
//
// Tự động hoá các mục TABS-TEST-L1 làm được mà không cần kéo-thả:
//   #1–4  mở nhiều file thành nhiều tab (đường `tabs:open-paths` thật), tab trống bằng nút ＋, mỗi tab giữ đúng tài liệu
//   #5    sửa một tab ⇒ chỉ tab đó có chấm ●
//   #6    lưu ở tab đang sửa ⇒ chỉ tab đó sạch, file đúng
//   #7    ✕ tab SẠCH ⇒ đóng ngay, không hỏi, tab còn lại được chọn
//   #8–10 ✕ tab BẨN: Huỷ / Không lưu / Lưu — chỉ tab đó chịu ảnh hưởng, các tài liệu khác nguyên từng byte
//   #11   ✕ tab cuối cùng ⇒ cửa sổ (và app) đóng theo
//   #12   ✕ CỬA SỔ khi 2 tab, 1 tab bẩn ⇒ nhảy sang tab bẩn để hỏi; Huỷ ⇒ cửa sổ KHÔNG đóng
//
// KHÔNG tự động hoá (máy không làm được, đã đo — docs/TABS-2B-DESIGN.md §2.2): kéo tab, tách tab, thả tab sang cửa sổ khác;
// menu chuột phải native của tab; Ctrl+Tab/Ctrl+N (accelerator của menu native); in.
//
// Bấm ✕ đi qua handler thật của thanh tab (`close.click()` → shellBridge.close → `tabs:close` → `TabbedWindow.closeTab` →
// `window:before-close` → guard của CHÍNH tab đó), chọn tab đi qua `mousedown` của phần tử tab. Hộp "Lưu/Không lưu/Huỷ" là hộp
// NATIVE do móc hộp thoại trả lời. Không cần sidecar.
//
// Chạy:  cd desktop ; node e2e/tabs.e2e.js     (hoặc: npm run e2e -- tabs)

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

const HASH = `(async () => { const d = await crypto.subtle.digest("SHA-256", state.bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); })()`;

const slotDir = (app, docId) => path.join(app.userDataDir, "recovery", docId);
const confirmBoxes = (app) => app.dialogs.calls().filter((c) => c.method === "showMessageBox");
const rotationsOf = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPages().map((p) => p.getRotation().angle);

// Đợi `fn()` trả truthy (async được); hết giờ ⇒ trả giá trị cuối (để `expect` báo SAI thay vì ném).
async function until(fn, ms = 15000, step = 200) {
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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-tabs-"));
  const file = (n) => path.join(work, n);
  const make = {};
  for (const [n, pages] of [["A.pdf", 2], ["B.pdf", 3], ["C.pdf", 4], ["D.pdf", 2]]) {
    make[n] = await makePdf(pages);
    fs.writeFileSync(file(n), make[n]);
  }
  let app = null;
  try {
    app = await launch();
    const p0 = await app.ready({ sidecar: false });
    const idOf = async (title) => ((await app.tabsList()).find((t) => t.title === title) || {}).id;
    // Chọn tab theo tên file và đợi nó thật sự HIỆN (tab ẩn: pdf.js ngừng vẽ).
    const goto = async (name) => {
      await app.activateTab(await idOf(name));
      const p = await app.pageByName(name);
      await p.waitFor(`document.visibilityState === "visible"`, { timeout: 15000, what: `tab ${name} hiện` });
      return p;
    };
    const rotate = (p, idx = 0) => p.eval(`(async () => { state.selected = new Set([${idx}]); await rotateSelected(90); })()`);

    // ---- #1–4: mở nhiều file thành nhiều tab ---------------------------------------------------------------
    console.log("U1  mở 3 file qua `tabs:open-paths` ⇒ 3 tab, mỗi tab đúng tài liệu của nó");
    expect((await app.tabsList()).length === 1, "lúc đầu: 1 tab trống");
    expect((await p0.eval(`window.desktop.openPaths(${JSON.stringify([file("A.pdf"), file("B.pdf"), file("C.pdf")])}, true)`)) === true, "openPaths trả true");
    const three = await until(async () => (await app.tabsList()).length === 3);
    expect(three, "thanh tab có đúng 3 tab");
    const titles = (await app.tabsList()).map((t) => t.title);
    expect(JSON.stringify(titles) === JSON.stringify(["A.pdf", "B.pdf", "C.pdf"]), `nhãn tab theo thứ tự mở: ${JSON.stringify(titles)}`);
    expect((await app.tabsList()).filter((t) => t.active).length === 1, "đúng 1 tab được chọn");
    const want = { "A.pdf": 2, "B.pdf": 3, "C.pdf": 4 };
    const ids = new Set();
    const hash0 = {};
    for (const n of Object.keys(want)) {
      const p = await app.pageByName(n);
      await p.waitFor(`state.numPages > 0`, { timeout: 30000, what: `${n} nạp xong` });
      const info = await p.eval(`({ name: state.name, pages: state.numPages, docId: state.docId, path: state.path, dirty: state.dirty })`);
      ids.add(info.docId);
      expect(info.pages === want[n] && info.path === file(n) && info.dirty === false, `${n}: ${info.pages} trang, đúng đường dẫn, sạch`);
      hash0[n] = await p.eval(HASH);
      expect(hash0[n] === require("crypto").createHash("sha256").update(make[n]).digest("hex"), `${n}: byte trong app == byte trên đĩa`);
    }
    expect(ids.size === 3, "3 tài liệu có 3 docId khác nhau");
    expect((await app.tabsList()).every((t) => !t.dirty), "chưa tab nào có chấm ●");

    // ---- #5 + #6: sửa một tab ⇒ chỉ tab đó bẩn; lưu ⇒ chỉ tab đó sạch ---------------------------------------
    console.log("\nU2  sửa tab A ⇒ chỉ A có chấm ●; lưu ⇒ A sạch, file đúng, B/C không bị đụng");
    let pa = await goto("A.pdf");
    await rotate(pa, 0);
    let st = await app.tabsList();
    expect(st.find((t) => t.title === "A.pdf").dirty && st.filter((t) => t.dirty).length === 1, `chỉ A bẩn: ${JSON.stringify(st.map((t) => [t.title, t.dirty]))}`);
    expect(
      (await (await app.pageByName("B.pdf")).eval(HASH)) === hash0["B.pdf"] && (await (await app.pageByName("C.pdf")).eval(HASH)) === hash0["C.pdf"],
      "B và C còn nguyên từng byte",
    );
    await pa.eval(`saveDoc()`);
    expect(await until(async () => !(await app.tabsList()).find((t) => t.title === "A.pdf").dirty), "sau lưu: A hết chấm ●");
    expect(JSON.stringify(await rotationsOf(file("A.pdf"))) === JSON.stringify([90, 0]), `file A mang thay đổi: ${JSON.stringify(await rotationsOf(file("A.pdf")))}`);
    expect(fs.readFileSync(file("B.pdf")).equals(make["B.pdf"]) && fs.readFileSync(file("C.pdf")).equals(make["C.pdf"]), "file B và C trên đĩa y nguyên");
    expect(app.dialogs.all().length === 0, "không hộp thoại nào (lưu có đường dẫn)");
    hash0["A.pdf"] = await pa.eval(HASH);

    // ---- #8: ✕ tab BẨN + Huỷ ----------------------------------------------------------------------------------
    console.log("\nU3  ✕ tab B (bẩn) + 'Huỷ' ⇒ B ở lại, nguyên vẹn, các tab khác không bị đụng");
    let pb = await goto("B.pdf");
    await rotate(pb, 0);
    const docIdB = await pb.eval(`state.docId`);
    await pb.eval(`autosaveTick()`);
    const hashB = await pb.eval(HASH);
    expect(fs.existsSync(path.join(slotDir(app, docIdB), "autosave.pdf")), "tiền điều kiện: B có khe phục hồi");
    await goto("A.pdf"); // đóng B khi KHÔNG phải tab đang xem: guard phải tự đưa B lên trước
    app.dialogs.answer({ showMessageBox: [2] });
    await app.closeTabUI(await idOf("B.pdf"));
    expect(await until(() => confirmBoxes(app).length === 1, 15000), `đúng 1 hộp hiện ra (${confirmBoxes(app).length})`);
    await sleep(1500);
    const o = (confirmBoxes(app)[0] || {}).options || {};
    expect(JSON.stringify(o.buttons) === JSON.stringify(["Lưu", "Không lưu", "Huỷ"]) && o.defaultId === 0 && o.cancelId === 2, `hộp đúng nhãn/mặc định: ${JSON.stringify([o.buttons, o.defaultId, o.cancelId])}`);
    st = await app.tabsList();
    expect(st.length === 3 && st.find((t) => t.title === "B.pdf").dirty, "B còn đó và còn bẩn");
    expect(st.find((t) => t.title === "B.pdf").active, "guard đã đưa B lên làm tab đang xem (tài liệu mà hộp hỏi về)");
    expect((await pb.eval(HASH)) === hashB, "B còn nguyên từng byte");
    expect(fs.existsSync(path.join(slotDir(app, docIdB), "autosave.pdf")), "'Huỷ' KHÔNG xoá khe phục hồi");
    expect(fs.readFileSync(file("B.pdf")).equals(make["B.pdf"]), "file B trên đĩa chưa bị đụng");

    // ---- #9: ✕ tab BẨN + Không lưu ----------------------------------------------------------------------------
    console.log("\nU4  ✕ tab B + 'Không lưu' ⇒ chỉ B đóng; khe phục hồi của B bị xoá; A, C nguyên từng byte");
    app.dialogs.answer({ showMessageBox: [1] });
    await app.closeTabUI(await idOf("B.pdf"));
    expect(await until(async () => (await app.tabsList()).length === 2), "còn 2 tab");
    st = await app.tabsList();
    expect(!st.some((t) => t.title === "B.pdf") && st.length === 2, `B đã biến mất: ${JSON.stringify(st.map((t) => t.title))}`);
    expect(confirmBoxes(app).length === 1, `đã hỏi đúng 1 lần (${confirmBoxes(app).length})`);
    expect(await until(() => !fs.existsSync(slotDir(app, docIdB)), 8000), "khe phục hồi của B đã bị xoá (BI-142)");
    expect(fs.readFileSync(file("B.pdf")).equals(make["B.pdf"]), "file B trên đĩa y nguyên (Không lưu ⇒ không ghi)");
    expect((await (await app.pageByName("A.pdf")).eval(HASH)) === hash0["A.pdf"], "A còn nguyên từng byte");
    expect((await (await app.pageByName("C.pdf")).eval(HASH)) === hash0["C.pdf"], "C còn nguyên từng byte");
    expect(app.alive(), "app vẫn sống");

    // ---- ＋ tab trống rồi ✕ tab SẠCH (#3, #7) ------------------------------------------------------------------
    console.log("\nU5  ＋ mở tab trống rồi ✕ tab sạch ⇒ đóng ngay, không hỏi; tab còn lại được chọn");
    const sh = await app.shell();
    await sh.click("#add");
    expect(await until(async () => (await app.tabsList()).length === 3), "＋ tạo tab mới (3 tab)");
    st = await app.tabsList();
    const blank = st[st.length - 1];
    expect(blank.active && !blank.dirty, "tab mới trống được chọn ngay, sạch");
    app.dialogs.answer({}); // mọi hộp thoại lúc này là bất ngờ
    await app.closeTabUI(blank.id);
    expect(await until(async () => (await app.tabsList()).length === 2), "tab trống đã đóng (2 tab)");
    expect(app.dialogs.calls().length === 0, `không hộp thoại nào khi đóng tab sạch (${app.dialogs.calls().length})`);
    st = await app.tabsList();
    expect(st.filter((t) => t.active).length === 1, "đúng 1 tab được chọn sau khi đóng");

    // ---- #10: ✕ tab BẨN + Lưu ---------------------------------------------------------------------------------
    console.log("\nU6  ✕ tab C (bẩn, có đường dẫn) + 'Lưu' ⇒ ghi đúng file C rồi tab mới đóng; A không bị đụng");
    let pc = await goto("C.pdf");
    await rotate(pc, 1);
    app.dialogs.answer({ showMessageBox: [0] });
    await app.closeTabUI(await idOf("C.pdf"));
    expect(await until(async () => (await app.tabsList()).length === 1), "C đã đóng (còn 1 tab)");
    expect(JSON.stringify(await rotationsOf(file("C.pdf"))) === JSON.stringify([0, 90, 0, 0]), `file C mang thay đổi (xoay trang 2): ${JSON.stringify(await rotationsOf(file("C.pdf")))}`);
    expect(app.dialogs.calls().filter((c) => c.method === "showSaveDialog").length === 0, "không hỏi Lưu thành (đã có đường dẫn)");
    expect(!fs.readdirSync(work).some((f) => f.endsWith(".nabu-tmp")), "không còn file .nabu-tmp");
    expect((await (await app.pageByName("A.pdf")).eval(HASH)) === hash0["A.pdf"], "A còn nguyên từng byte");

    // ---- #12: ✕ CỬA SỔ khi 2 tab, 1 tab bẩn --------------------------------------------------------------------
    console.log("\nU7  ✕ CỬA SỔ khi 2 tab (A sạch, D bẩn không đang xem) ⇒ nhảy sang D để hỏi; 'Huỷ' ⇒ cửa sổ KHÔNG đóng");
    await (await app.pageByName("A.pdf")).eval(`window.desktop.openPaths(${JSON.stringify([file("D.pdf")])}, false)`);
    expect(await until(async () => (await app.tabsList()).length === 2), "mở D thành tab thứ 2");
    const pd = await goto("D.pdf");
    await pd.waitFor(`state.numPages > 0`, { timeout: 30000, what: "D nạp xong" });
    await rotate(pd, 0);
    const hashD = await pd.eval(HASH);
    const docIdD = await pd.eval(`state.docId`);
    await pd.eval(`autosaveTick()`);
    await goto("A.pdf");
    expect(!(await app.tabsList()).find((t) => t.title === "D.pdf").active, "tiền điều kiện: D bẩn và KHÔNG phải tab đang xem");
    app.dialogs.answer({ showMessageBox: [2] });
    app.requestClose();
    expect(await until(() => confirmBoxes(app).length === 1, 15000), `đúng 1 hộp hiện ra (${confirmBoxes(app).length})`);
    await sleep(2500);
    st = await app.tabsList();
    expect(app.alive() && st.length >= 1, "cửa sổ KHÔNG đóng sau 'Huỷ'");
    const dTab = st.find((t) => t.title === "D.pdf");
    expect(dTab && dTab.active && dTab.dirty, "guard nhảy sang tab bẩn D để hỏi; D còn bẩn");
    expect((await pd.eval(HASH)) === hashD, "D còn nguyên từng byte (không mất việc chưa lưu)");
    expect(fs.existsSync(path.join(slotDir(app, docIdD), "autosave.pdf")), "'Huỷ' KHÔNG xoá khe phục hồi của D");
    expect(confirmBoxes(app).length === 1, "A (sạch) không bị hỏi: vẫn 1 hộp");
    // QUAN SÁT (không phải khẳng định): _guardAndClose duyệt tab theo thứ tự và ĐÓNG LUÔN các tab sạch đi trước tab bẩn; Huỷ ở tab
    // bẩn chỉ dừng vòng lặp, không dựng lại những tab sạch đã đóng. Không mất dữ liệu (tab sạch không có gì chưa lưu) nhưng người
    // dùng bấm Huỷ vẫn mất chỗ đang xem — ghi ở REGRESSION-GUARD (BI-141, mục "quan sát"). Cố ý KHÔNG ghim: chủ dự án chưa quyết.
    console.log(`  QUAN SÁT: sau 'Huỷ' còn ${st.length} tab (${JSON.stringify(st.map((t) => t.title))}) trên 2 tab ban đầu`);

    // ---- #11: ✕ tab CUỐI ⇒ cửa sổ/app đóng ---------------------------------------------------------------------
    console.log("\nU8  ✕ tab bẩn D + 'Không lưu' khi nó là tab cuối ⇒ cả cửa sổ và app đóng theo; khe của D bị xoá");
    app.dialogs.answer({ showMessageBox: [1] });
    await app.closeTabUI(await idOf("D.pdf"));
    expect(await app.waitExit(20000), "đóng tab cuối ⇒ app thoát");
    expect(confirmBoxes(app).length === 1, `đã hỏi đúng 1 lần (${confirmBoxes(app).length})`);
    expect(!fs.existsSync(slotDir(app, docIdD)), "khe phục hồi của D đã bị xoá");
    expect(fs.readFileSync(file("D.pdf")).equals(make["D.pdf"]), "file D y nguyên");
    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ (${app.dialogs.unexpected().length})`);
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
  console.log("Tầng tab đúng ở cả 8 ca (TABS-TEST-L1 #1–12). Kéo/tách/chuyển cửa sổ và menu chuột phải của tab vẫn phải test tay.");
})();
