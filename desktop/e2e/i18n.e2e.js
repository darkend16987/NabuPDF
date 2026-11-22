"use strict";

// BI-141 / ma trận §5 hàng 31 (nửa BI-10) — ĐỔI NGÔN NGỮ VI ⇄ EN không mất chữ và không ghi đè giá trị đang chạy.
//
// NỬA CÒN LẠI của hàng đó — "BI-9: khoá bản quyền có ăn không" — KHÔNG tự động hoá được và KHÔNG nên: `license.js` có
// `const ENFORCE = false` ("OFF since v0.2.0: app hoàn toàn miễn phí, mã nguồn mở AGPL"). Hệ thống khoá đang TẮT HẲN, nên không có gì
// để kiểm trong sản phẩm đang ship; bật nó cho test nghĩa là đổi một hằng số trong mã sản phẩm. (Xem BI-141.)
//
// CƠ CHẾ (đã đọc `i18n.js`): sổ đăng ký chụp các NÚT VĂN BẢN có nội dung khớp từ điển lúc tải trang; `render()` ghi lại `e.vi` (bản
// gốc tĩnh) khi đổi ngôn ngữ. Blink tái dùng nút văn bản khi gán `textContent` cho phần tử chỉ có MỘT nút văn bản, nên một phần tử
// ĐỘNG mà không nằm trong `SKIP_IDS` sẽ bị đổi ngôn ngữ TRẢ VỀ CHỮ TĨNH CŨ — đúng hiện tượng BI-10 ("ghi đè giá trị đang chạy").
//
// PHÉP ĐO trên DOM thật, theo `id` (văn bản VÀ thuộc tính title/placeholder/aria-label):
//   1. VI → EN → VI KHÔNG đổi gì giữa hai lần ⇒ MỌI id trở về y nguyên (lossless; không id nào rỗng đi). ĐÂY là phần có giá trị đã được
//      CHỨNG MINH có thể đỏ (đột biến lên logic đăng ký/render của i18n — xem BI-141).
//   2. Sau khi sang EN, nhãn tĩnh THẬT SỰ đổi (không phải cả hai ngôn ngữ giống nhau) — phép đo ở trên không vô nghĩa.
//   3. Đổi GIÁ TRỊ SỐNG giữa hai lần chuyển (mở tài liệu khác, toast mới, dòng ước tính của hộp Nén, lớp phủ) rồi chuyển lại ⇒ các giá trị
//      sống phải CÒN NGUYÊN.
//
// ĐIỀU PHÉP ĐO 3 KHÔNG CHỨNG MINH (đo được, nói thẳng — đừng đọc nó là "đã bảo vệ BI-10"): mối nguy BI-10 dạng văn bản KHÔNG xảy ra với
// mã gán `textContent`: Blink TẠO NÚT MỚI (`el.firstChild` đổi sau `textContent = …`), nút đã đăng ký bị tách ra nên đổi ngôn ngữ không
// ghi đè được giá trị sống. Đã thử đối chứng DƯƠNG (cho `overlay-msg` chữ ban đầu "Hủy" khớp từ điển và bỏ nó khỏi `SKIP_IDS`): vẫn XANH,
// `liveAfterEN = "SONG-1"`. Và hiện không có phần tử tĩnh nào vừa được đăng ký vừa bị sửa tại chỗ (không có `nodeValue =` nào; các `title =`
// lúc chạy nằm trên phần tử tạo động hoặc phần tử không có `title` tĩnh). Mối nguy còn lại là gán `nodeValue` trực tiếp hoặc đổi
// thuộc tính của phần tử tĩnh đã đăng ký — chưa có chỗ nào trong mã làm vậy, nên phép đo 3 hiện không thể đỏ với mã thật.
//
// Chạy:  cd desktop ; node e2e/i18n.e2e.js     (hoặc: npm run e2e -- i18n)

const { launch } = require("./lib/app-driver");
const { makePdf } = require("./lib/fixtures");

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};

// textContent của MỌI phần tử có id (id duy nhất; bỏ qua <script>/<style>) VÀ các thuộc tính title / placeholder / aria-label của
// chúng (khoá `id@title`…): sổ đăng ký của i18n có HAI loại — nút văn bản và thuộc tính — nên vòng VI→EN→VI phải lossless cho cả hai.
const SNAP = `(() => { const out = {}; for (const el of document.querySelectorAll("[id]")) {
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue; out[el.id] = el.textContent;
  for (const a of ["title", "placeholder", "aria-label"]) if (el.hasAttribute(a)) out[el.id + "@" + a] = el.getAttribute(a); } return out; })()`;

const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

(async () => {
  const app = await launch();
  try {
    const page = await app.ready({ sidecar: false });
    // Chờ giao diện LẮNG XUỐNG trước khi chụp: `#viewer` đổi theo thời gian (trang vẽ muộn: 296 → 310 ký tự, đo được, không liên
    // quan ngôn ngữ). Lần đầu tôi chụp ngay và báo nhầm `viewer` là 'mất chữ khi đổi ngôn ngữ'.
    const settle = async () => {
      let last = null, stable = 0;
      for (let i = 0; i < 60 && stable < 6; i++) {
        const cur = await page.eval(`document.getElementById("viewer").textContent + "|" + document.getElementById("thumbs").textContent`);
        stable = cur === last ? stable + 1 : 0;
        last = cur;
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const snap = async () => { await settle(); return page.eval(SNAP); };
    const setLang = (l) => page.eval(`(I18N.setLang(${JSON.stringify(l)}), true)`);
    const live = (tag, pages) =>
      page.eval(`(async () => { toast("live-${tag}", "");  setOverlayMsg("overlay-${tag}"); updateCompressEta(); return true; })()`);

    // ---- chuẩn bị: VI, có tài liệu + giá trị sống A -----------------------------------------------------
    expect((await page.eval(`I18N.getLang()`)) === "vi", "bắt đầu ở tiếng Việt");
    const S0 = await snap(); // TRƯỚC khi có tài liệu: trạng thái tĩnh của giao diện
    await app.openPdf(await makePdf(3), "A.pdf");
    await live("A");
    const S1 = await snap();
    const dyn = diff(S0, S1); // id có giá trị đổi lúc chạy
    console.log(`  (${Object.keys(S0).length} phần tử có id; ${dyn.length} cái đổi giá trị lúc chạy: ${dyn.slice(0, 12).join(", ")}${dyn.length > 12 ? "…" : ""})`);
    expect(dyn.includes("toast") && dyn.includes("overlay-msg"), "tiền điều kiện: toast và overlay-msg đã mang giá trị sống");

    // ---- 1. VI → EN → VI không đổi gì giữa hai lần ⇒ lossless -----------------------------------------------
    console.log("\n=== 1. VI → EN → VI (không đổi gì giữa chừng) ⇒ mọi id trở về y nguyên ===");
    await setLang("en");
    const S2 = await snap();
    const changedToEn = diff(S1, S2);
    expect(changedToEn.length > 10, `sang EN thì nhãn tĩnh THẬT SỰ đổi (${changedToEn.length} phần tử đổi) — phép đo không vô nghĩa`);
    expect((await page.eval(`document.documentElement.lang`)) === "en", "thuộc tính lang của trang là en");
    await setLang("vi");
    const S3 = await snap();
    const lost = diff(S1, S3);
    expect(lost.length === 0, `VI→EN→VI trả MỌI phần tử về y nguyên (lệch: ${JSON.stringify(lost.slice(0, 8))})`);
    const emptied = Object.keys(S1).filter((k) => S1[k].trim() !== "" && S3[k].trim() === "");
    expect(emptied.length === 0, `không phần tử nào bị rỗng đi (${JSON.stringify(emptied.slice(0, 8))})`);

    // ---- 2. đổi GIÁ TRỊ SỐNG giữa hai lần chuyển ----------------------------------------------------------
    console.log("\n=== 2. đổi giá trị sống giữa hai lần chuyển ⇒ giá trị sống còn nguyên (BI-10) ===");
    await setLang("en");
    await app.openPdf(await makePdf(5), "B-moi.pdf"); // tài liệu KHÁC trong lúc đang EN
    await live("B");
    const S4 = await snap(); // EN, giá trị sống B
    const liveIds = diff(S2, S4); // id có giá trị đổi do kích hoạt B
    console.log(`  (${liveIds.length} phần tử đổi do giá trị sống mới: ${liveIds.slice(0, 12).join(", ")}${liveIds.length > 12 ? "…" : ""})`);
    expect(liveIds.includes("toast") && liveIds.includes("overlay-msg"), "tiền điều kiện: toast và overlay-msg mang giá trị sống B");
    await setLang("vi");
    const S5 = await snap();
    const reverted = liveIds.filter((id) => S5[id] === S1[id] || S5[id] === S0[id]); // trả về chữ cũ/tĩnh
    const blanked = liveIds.filter((id) => S4[id].trim() !== "" && S5[id].trim() === "");
    expect(reverted.length === 0, `không giá trị sống nào bị trả về chữ tĩnh/chữ cũ khi đổi ngôn ngữ (BI-10): ${JSON.stringify(reverted.slice(0, 8))}`);
    expect(blanked.length === 0, `không giá trị sống nào bị xoá rỗng: ${JSON.stringify(blanked.slice(0, 8))}`);
    const survived = liveIds.filter((id) => S5[id] === S4[id]);
    expect(survived.length >= Math.ceil(liveIds.length * 0.5), `đa số giá trị sống còn Y NGUYÊN sau khi đổi ngôn ngữ (${survived.length}/${liveIds.length})`);
    expect(S5["toast"].includes("live-B") && S5["overlay-msg"].includes("overlay-B"), `toast và overlay-msg vẫn là giá trị sống B: ${JSON.stringify([S5["toast"], S5["overlay-msg"]])}`);
    expect((await page.eval(`state.name`)) === "B-moi.pdf" && (await page.eval(`state.numPages`)) === 5, "tài liệu đang mở không bị đổi ngôn ngữ làm hỏng");

    expect(app.dialogs.unexpected().length === 0, `không có hộp thoại bất ngờ (${app.dialogs.unexpected().length})`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    await app.close();
  }

  console.log("");
  if (failures.length) {
    console.log("CÓ VẤN ĐỀ:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Đổi VI ⇄ EN không mất chữ và không ghi đè giá trị đang chạy (với các phần tử động mà kịch bản kích hoạt).");
})();
