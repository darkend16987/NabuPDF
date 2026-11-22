"use strict";

// BI-141 / ma trận §5 — CHUYỂN TRANG GIỮA 2 TÀI LIỆU (BI-52/55/56/57/58, docs/SPEC-page-drag.md) trong APP ELECTRON THẬT, đường
// MENU "Chuyển trang sang tài liệu khác…" (không cần kéo-thả — đường duy nhất tới được một tab KHÔNG đang xem).
//
// Đường đi thật: `PageMove.openSendMenu` → `pages:targets` (main hỏi từng tab) → bấm một mục menu → `pages:send-to` → `routePages`
// (hỏi đích `can-accept` → nguồn `export` → đích `receive`) → `insertBuffersAt` ở đích. Mỗi trang mẫu có BỀ RỘNG RIÊNG nên đọc lại
// `state.bytes` của hai bên là biết trang nào sang, ở vị trí nào.
//
//   V1  menu liệt kê đúng đích (không có chính nó); tab trống bị MỜ kèm lý do; bấm mục mờ không làm gì
//   V2  copy 1 trang sang tab KHÔNG đang xem: đích dài thêm, trang đúng, nối cuối, đích bẩn; NGUỒN không đổi một byte, không bẩn
//   V3  nút "Xoá khỏi bản gốc" trên toast: nguồn mất đúng trang đó; đích không đổi
//   V4  hoàn tác ở đích trả ĐÚNG byte cũ; hoàn tác ở nguồn trả ĐÚNG byte cũ
//   V5  tick 2 trang rồi chuyển ⇒ chuyển CẢ HAI, đúng thứ tự
//   V6  sửa nguồn rồi mới bấm "Xoá khỏi bản gốc" ⇒ TỪ CHỐI (chỉ số cũ sẽ trỏ nhầm trang), nguồn không mất trang nào
//
// KHÔNG tự động hoá: kéo-thả trang sang cửa sổ khác (cử chỉ kéo máy không bơm được — TABS-2B-DESIGN §2.2), Shift-kéo = chuyển,
// lò xo mở cột trang, đích đang chú thích dở (cần chuột).
//
// Cần phiên có giao diện. Không cần sidecar.
//
// Chạy:  cd desktop ; node e2e/page-transfer.e2e.js     (hoặc: npm run e2e -- page-transfer)

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

// Bề rộng từng trang của `state.bytes` (đọc lại bằng pdf-lib ở Node, độc lập với app).
async function widthsOf(page) {
  const b64 = await page.eval(`(() => { let s = ""; const u = state.bytes; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); })()`);
  const doc = await PDFDocument.load(Buffer.from(b64, "base64"));
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-pt-"));
  const S = path.join(work, "S.pdf");
  const D = path.join(work, "D.pdf");
  fs.writeFileSync(S, await makePdf(3, { widths: [710, 720, 730] }));
  fs.writeFileSync(D, await makePdf(2, { widths: [810, 820] }));
  let app = null;
  try {
    app = await launch();
    const p0 = await app.ready({ sidecar: false });
    await p0.eval(`window.desktop.openPaths(${J([S, D])}, true)`);
    await until(async () => (await app.tabsList()).length === 2);
    const idOf = async (title) => ((await app.tabsList()).find((t) => t.title === title) || {}).id;
    const goto = async (name) => {
      await app.activateTab(await idOf(name));
      const p = await app.pageByName(name);
      await p.waitFor(`document.visibilityState === "visible" && state.numPages > 0`, { timeout: 20000, what: `tab ${name} hiện + nạp xong` });
      return p;
    };
    const dirtyOf = async (title) => !!((await app.tabsList()).find((t) => t.title === title) || {}).dirty;
    // Mở menu "Chuyển trang…" của trang `idx` ở tab đang xem; trả { head, items: [{ text, disabled }] }.
    const openMenu = async (p, idx) => {
      await p.eval(`window.PageMove.openSendMenu(20, 20, ${idx})`);
      await p.waitFor(`!!document.querySelector(".ctx-menu")`, { timeout: 8000, what: "menu hiện" });
      return p.eval(`(() => { const m = document.querySelector(".ctx-menu");
        return { head: (m.querySelector(".ctx-menu-head") || {}).textContent || "",
          items: [...m.querySelectorAll(".ctx-menu-item")].map((e) => ({ text: e.textContent, disabled: e.classList.contains("disabled") })) }; })()`);
    };
    const clickMenu = (p, needle) =>
      p.eval(`(() => { const e = [...document.querySelectorAll(".ctx-menu-item")].find((x) => x.textContent.includes(${J(needle)}));
        if (!e) return "no-item"; e.click(); return "ok"; })()`);
    const clickToastAction = (p) =>
      p.eval(`(() => { const b = document.querySelector("#toast .toast-action"); if (!b) return "no-button"; b.click(); return "ok"; })()`);

    const closeMenu = (p) => p.press("Escape"); // Esc đóng menu ngữ cảnh (onCtxKey)
    // Đợi tới khi `title` được main báo là NHẬN ĐƯỢC (accepts) — menu hỏi từng tab với hạn 800 ms (PAGE_ASK_MS), nên mở menu khi đích
    // còn đang nạp/vẽ sẽ thấy nó mờ ("chưa mở file"/"đang bận"): đúng hành vi của app, nhưng test phải đợi chứ không đoán.
    const waitAccepts = (p, title) =>
      p.waitFor(`window.desktop.pages.targets().then((t) => t.some((x) => x.title === ${J(title)} && x.accepts))`, { timeout: 20000, what: `${title} nhận được trang` });
    // Chuyển trang `idx` (hoặc cả tập tick) từ tab `ps` sang `dest`, qua menu, rồi ĐƯA TAB ĐÍCH LÊN một lúc để nó vẽ xong và
    // phản hồi (xem QUAN SÁT ở V2: đích đang ẩn thì phản hồi bị giữ), rồi quay về nguồn. Trả sau khi nguồn đã hiện lại.
    const transfer = async (srcName, destName, idx) => {
      const src = await app.pageByName(srcName);
      const dst = await app.pageByName(destName);
      await waitAccepts(src, destName);
      await openMenu(src, idx);
      const r = await clickMenu(src, destName);
      if (r !== "ok") throw new Error("không có mục " + destName);
      return { src, dst };
    };
    const settleOn = async (name) => {
      const p = await goto(name);
      await p.waitFor(`document.getElementById("overlay").hidden`, { timeout: 30000, what: `${name} vẽ xong (hết lớp phủ)` });
      return p;
    };

    // tab trống để có một đích KHÔNG nhận được
    const sh = await app.shell();
    await sh.click("#add");
    await until(async () => (await app.tabsList()).length === 3);

    let ps = await goto("S.pdf");
    let pd = await app.pageByName("D.pdf");
    await pd.waitFor(`state.numPages > 0`, { timeout: 30000, what: "D nạp xong" });
    const hashS0 = await ps.eval(HASH);
    const hashD0 = await pd.eval(HASH);
    expect(J(await widthsOf(ps)) === J([710, 720, 730]) && J(await widthsOf(pd)) === J([810, 820]), "tiền điều kiện: S=[710,720,730], D=[810,820]");

    // ---- V1: menu ---------------------------------------------------------------------------------------------
    console.log("\nV1  menu liệt kê đúng các đích");
    await waitAccepts(ps, "D.pdf");
    let menu = await openMenu(ps, 1);
    expect(/Copy 1 trang tới/.test(menu.head), `đầu menu: ${J(menu.head)}`);
    expect(menu.items.length === 2, `đúng 2 đích (D và tab trống), không có chính S: ${J(menu.items)}`);
    const itemD = menu.items.find((i) => i.text.includes("D.pdf"));
    const itemBlank = menu.items.find((i) => !i.text.includes("D.pdf"));
    expect(itemD && !itemD.disabled, `D nhận được (mục sáng): ${J(itemD)}`);
    expect(itemBlank && itemBlank.disabled && /chưa mở file/.test(itemBlank.text), `tab trống bị mờ kèm lý do: ${J(itemBlank)}`);
    expect(!menu.items.some((i) => i.text.includes("S.pdf")), "S không tự liệt kê mình làm đích");
    await clickMenu(ps, "Nabu PDF"); // mục mờ: bấm không được làm gì
    await sleep(800);
    expect((await pd.eval(HASH)) === hashD0 && (await ps.eval(HASH)) === hashS0, "bấm mục mờ: cả S và D không đổi");
    await closeMenu(ps);

    // ---- V2: copy 1 trang sang tab KHÔNG đang xem ---------------------------------------------------------------
    console.log("\nV2  copy trang 2 của S sang D (D KHÔNG đang xem) ⇒ D dài thêm đúng trang đó ở cuối; S không đổi một byte");
    await ps.eval(`window.__tl = []; (() => { const t = document.getElementById("toast");
      new MutationObserver(() => window.__tl.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true }); return true; })()`);
    await transfer("S.pdf", "D.pdf", 1);
    expect(await until(async () => (await pd.eval(`state.numPages`)) === 3, 30000), "D nhận trang (3 trang) — kể cả khi D đang ẩn");
    expect(J(await widthsOf(pd)) === J([810, 820, 720]), `D = [810,820,720] (đúng trang, nối cuối): ${J(await widthsOf(pd))}`);
    expect((await ps.eval(HASH)) === hashS0, "S còn nguyên từng byte (copy, không phải chuyển)");
    // QUAN SÁT (không phải khẳng định): trong lúc D còn ẨN, lớp phủ "Đang tải tài liệu…" của D kẹt (pdf.js ngừng vẽ khi tab ẩn) và
    // `answerReceive` chỉ phản hồi SAU `await insertBuffersAt` ⇒ NGUỒN KHÔNG nhận được phản hồi cho tới khi D được chọn. Đo: toast
    // "Đã copy…" ở nguồn chỉ hiện đúng lúc D được chọn. Cố ý KHÔNG ghim: chủ dự án chưa quyết có sửa không (ghi ở BI-141).
    await sleep(6000);
    const earlyToast = (await ps.eval(`window.__tl`)).some((t) => /Đã copy/.test(t));
    console.log(`  QUAN SÁT: 6 s sau khi gửi, đích vẫn ẩn: nguồn ${earlyToast ? "ĐÃ" : "CHƯA"} nhận thông báo 'Đã copy' (đích đang kẹt lớp phủ: ${await pd.eval(`!document.getElementById("overlay").hidden`)})`);
    pd = await settleOn("D.pdf"); // đưa D lên: nó vẽ xong và phản hồi
    expect(await dirtyOf("D.pdf"), "D có chấm ●");
    ps = await goto("S.pdf"); // về nguồn ngay (toast sống 9 s)
    expect(await until(async () => /Đã copy 1 trang/.test(await ps.eval(`document.getElementById("toast").textContent`)), 10000), "toast ở NGUỒN báo đã copy 1 trang…");
    const t2 = await ps.eval(`document.getElementById("toast").textContent`);
    expect(/D\.pdf/.test(t2) && /Xoá khỏi bản gốc/.test(t2), `…nêu tên đích và có nút: ${J(t2)}`);
    expect(!(await dirtyOf("S.pdf")), "S không bẩn");
    const hashD1 = await pd.eval(HASH);

    // ---- V3: Xoá khỏi bản gốc ---------------------------------------------------------------------------------
    console.log("\nV3  nút 'Xoá khỏi bản gốc' ⇒ S mất đúng trang đó, D không đổi");
    expect((await clickToastAction(ps)) === "ok", "bấm nút trên toast");
    expect(await until(async () => (await ps.eval(`state.numPages`)) === 2), "S còn 2 trang");
    expect(J(await widthsOf(ps)) === J([710, 730]), `S = [710,730]: ${J(await widthsOf(ps))}`);
    expect(await dirtyOf("S.pdf"), "S có chấm ●");
    expect((await pd.eval(HASH)) === hashD1, "D không đổi");

    // ---- V4: hoàn tác -----------------------------------------------------------------------------------------
    console.log("\nV4  hoàn tác ở S rồi ở D ⇒ trả ĐÚNG byte cũ của từng bên");
    await ps.press("z", { ctrl: true });
    expect(await until(async () => (await ps.eval(HASH)) === hashS0), "Ctrl+Z ở S ⇒ S về đúng byte ban đầu");
    pd = await settleOn("D.pdf");
    await pd.press("z", { ctrl: true });
    expect(await until(async () => (await pd.eval(HASH)) === hashD0), "Ctrl+Z ở D ⇒ D về đúng byte ban đầu (undo của việc NHẬN trang)");
    expect(J(await widthsOf(pd)) === J([810, 820]), "D = [810,820]");
    await settleOn("D.pdf");

    // ---- V5: tick 2 trang --------------------------------------------------------------------------------------
    console.log("\nV5  tick trang 1 và 3 của S rồi chuyển ⇒ chuyển CẢ HAI, đúng thứ tự");
    ps = await settleOn("S.pdf");
    await ps.eval(`(state.selected = new Set([0, 2]), true)`);
    await waitAccepts(ps, "D.pdf");
    menu = await openMenu(ps, 0);
    expect(/Copy 2 trang tới/.test(menu.head), `đầu menu nói 2 trang: ${J(menu.head)}`);
    expect((await clickMenu(ps, "D.pdf")) === "ok", "bấm mục D.pdf");
    expect(await until(async () => (await pd.eval(`state.numPages`)) === 4, 30000), "D có 4 trang");
    expect(J(await widthsOf(pd)) === J([810, 820, 710, 730]), `D = [810,820,710,730]: ${J(await widthsOf(pd))}`);
    expect((await ps.eval(HASH)) === hashS0, "S vẫn nguyên");
    pd = await settleOn("D.pdf");
    ps = await settleOn("S.pdf");

    // ---- V6: nguồn đổi giữa chừng ---------------------------------------------------------------------------------
    console.log("\nV6  sửa S rồi mới bấm 'Xoá khỏi bản gốc' ⇒ TỪ CHỐI, S không mất trang nào");
    await ps.eval(`(state.selected = new Set([1]), true)`);
    await waitAccepts(ps, "D.pdf");
    await openMenu(ps, 1);
    await clickMenu(ps, "D.pdf");
    expect(await until(async () => (await pd.eval(`state.numPages`)) === 5, 30000), "D có 5 trang (đã nhận trang 2)");
    pd = await settleOn("D.pdf");
    ps = await goto("S.pdf");
    expect(await until(async () => /Xoá khỏi bản gốc/.test(await ps.eval(`document.getElementById("toast").textContent`)), 10000), "toast còn nút");
    await ps.eval(`(async () => { state.selected = new Set([0]); await rotateSelected(90); })()`); // S đổi sau lúc chuyển
    const hashS6 = await ps.eval(HASH);
    expect((await clickToastAction(ps)) === "ok", "bấm nút trên toast (cũ)");
    await sleep(1200);
    const t6 = await ps.eval(`document.getElementById("toast").textContent`);
    expect(/Tài liệu đã thay đổi/.test(t6), `toast từ chối: ${J(t6)}`);
    expect((await ps.eval(`state.numPages`)) === 3 && (await ps.eval(HASH)) === hashS6, "S còn 3 trang, không bị xoá nhầm");

    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ (${app.dialogs.unexpected().length})`);
    await ps.eval(`(state.dirty = false, true)`); // để đóng không bị hộp 'chưa lưu' (không phải thứ đang kiểm)
    await pd.eval(`(state.dirty = false, true)`);
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
  console.log("Chuyển trang giữa tài liệu đúng ở cả 6 ca (đường menu). Kéo-thả sang cửa sổ khác vẫn phải test tay.");
})();
