"use strict";

// BI-141 / ma trận §5 — ZOOM + CUỘN + ẢO HOÁ BITMAP (BI-4 / BI-36 / BI-78) trong APP ELECTRON THẬT, bằng LĂN CHUỘT THẬT (Ctrl+lăn
// qua CDP `Input.dispatchMouseEvent` — khác kéo-thả, wheel không bị Chromium bỏ qua).
//
// Điều đáng canh nhất ở đây là lỗi IM LẶNG: quá ~268 MP thì canvas nhận kích thước, trả context, `page.render` xong trong vài ms và
// KHÔNG VẼ GÌ — một tờ A0 trắng, không lỗi nào trong console (BI-78). Test (không phải mã app, nên không vi phạm BI-4) đọc pixel canvas:
// trang bị trắng ⇒ alpha 0; trang vẽ rồi ⇒ alpha 255.
//
//   Z1  Ctrl+lăn nhanh liên tục: tỷ lệ đổi đúng 1.1/nấc; HÌNH HỌC đổi ngay (khung trang theo tỷ lệ); dừng lại ⇒ mọi trang đã vẽ đều
//       NÉT (`m.paintScale === state.scale`, BI-36); KHÔNG trang nào bị dựng lại (`.page-wrap` giữ nguyên nút, BI-36)
//   Z2  kẹp ZOOM_MIN/ZOOM_MAX; ＋ rồi － là hai phép nghịch đảo chính xác
//   Z3  tờ A0 ở 500%: bitmap bị chặn dưới hạn mức pixel VÀ trang KHÔNG trắng (BI-78)
//   Z4  tài liệu 40 trang: cuộn xuống cuối ⇒ trang đầu được GIẢI PHÓNG bitmap, trang cuối đã vẽ; cuộn lên lại ⇒ vẽ lại, không trắng
//
// KHÔNG tự động hoá: cảm giác "trang bám tay" khi lăn, bôi đen chữ sau zoom (cần chuột kéo), Ctrl+F highlight, lăn liên tục trên A0
// nhiều trang xem có treo (cần mắt/đồng hồ trên máy thật), zoom trên bản vẽ CAD thật.
//
// Cần phiên có giao diện. Không cần sidecar.
//
// Chạy:  cd desktop ; node e2e/zoom.e2e.js     (hoặc: npm run e2e -- zoom)

const { PDFDocument, rgb } = require("pdf-lib");
const { launch } = require("./lib/app-driver");
const { makePdf } = require("./lib/fixtures");

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

async function until(fn, ms = 20000, step = 150) {
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

// Một tờ lớn tô ĐEN toàn bộ: pixel đọc lại được là đen đặc nếu đã vẽ, alpha 0 nếu trang trắng-im-lặng.
async function bigBlackPdf(w, h) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([w, h]);
  p.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save());
}

// Pixel giữa canvas của trang i: [r,g,b,a]; null nếu canvas không đọc được.
const centerPixel = (i) => `(() => { const m = state.pageMetas[${i}]; const c = m && m.canvas; if (!c || !c.width || !c.height) return null;
  const d = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return [d[0], d[1], d[2], d[3]]; })()`;

(async () => {
  let app = null;
  try {
    app = await launch();
    const page = await app.ready({ sidecar: false });
    const viewerCenter = () => page.eval(`(() => { const r = document.getElementById("viewer").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const settle = () =>
      page.waitFor(
        `(() => { const ms = state.pageMetas || []; return ms.length > 0 && ms.every((m) => !m.wrap || m.wrap.dataset.rendered !== "1" || (!m.rendering && m.paintScale === state.scale)); })()`,
        { timeout: 30000, what: "mọi trang đã vẽ đều nét" },
      );

    // ---- Z1 -----------------------------------------------------------------------------------------------------
    console.log("Z1  Ctrl+lăn nhanh liên tục: tỷ lệ đúng, hình học đổi ngay, dừng lại thì NÉT, không dựng lại trang");
    await app.openPdf(await makePdf(6), "sau-trang.pdf");
    await settle();
    await page.eval(`(() => { document.querySelectorAll(".page-wrap").forEach((w, i) => { w.__e2e = "w" + i; }); return true; })()`);
    const s0 = await page.eval(`state.scale`);
    const c = await viewerCenter();
    for (let k = 0; k < 12; k++) {
      await page.wheel(c.x, c.y, -100, { ctrl: true });
      await sleep(25);
    }
    const s1 = await page.eval(`state.scale`);
    const ratio = s1 / s0;
    const lo = Math.pow(1.1, 11.5);
    const hi = Math.pow(1.1, 12.5);
    expect(s1 <= 5 && ratio >= lo && ratio <= hi, `12 nấc Ctrl+lăn lên: ${s0} → ${s1} (×${ratio.toFixed(3)}, kỳ vọng ≈ ×${Math.pow(1.1, 12).toFixed(3)})`);
    const geo = await page.eval(`(() => { const m = state.pageMetas[0]; return { css: parseFloat(m.canvas.style.width), cw: m.cw, want: 400 * state.scale }; })()`);
    expect(Math.abs(geo.css - geo.want) < 2 && Math.abs(geo.cw - geo.want) < 2, `hình học theo tỷ lệ NGAY: khung trang ${geo.css}px ≈ ${geo.want.toFixed(1)}px`);
    await settle();
    const crisp = await page.eval(`state.pageMetas.filter((m) => m.wrap && m.wrap.dataset.rendered === "1").map((m) => m.paintScale === state.scale)`);
    expect(crisp.length > 0 && crisp.every(Boolean), `dừng lại: ${crisp.length} trang đã vẽ đều nét (paintScale === scale)`);
    const kept = await page.eval(`[...document.querySelectorAll(".page-wrap")].map((w, i) => w.__e2e === "w" + i)`);
    expect(kept.length === 6 && kept.every(Boolean), "KHÔNG trang nào bị dựng lại (.page-wrap giữ nguyên nút, BI-36)");
    const px1 = await page.eval(centerPixel(0));
    expect(px1 && px1[3] === 255, `trang đang xem đã vẽ (alpha ${px1 && px1[3]})`);

    // ---- Z2 -----------------------------------------------------------------------------------------------------
    console.log("\nZ2  kẹp giới hạn zoom; ＋ rồi － là nghịch đảo chính xác");
    await page.eval(`zoomTo(100)`);
    expect((await page.eval(`state.scale`)) === 5, `zoomTo(100) kẹp ở ZOOM_MAX: ${await page.eval(`state.scale`)}`);
    await page.eval(`zoomTo(0.0001)`);
    expect((await page.eval(`state.scale`)) === 0.2, `zoomTo(0.0001) kẹp ở ZOOM_MIN: ${await page.eval(`state.scale`)}`);
    await page.eval(`zoomReset()`);
    expect((await page.eval(`state.scale`)) === 1, "zoomReset ⇒ 100%");
    await page.eval(`zoomStep(1)`);
    const up = await page.eval(`state.scale`);
    await page.eval(`zoomStep(-1)`);
    expect(up === 1.25 && (await page.eval(`state.scale`)) === 1, `＋ ⇒ ${up}, － ⇒ ${await page.eval(`state.scale`)} (về đúng 1)`);
    await settle();

    // ---- Z3 -----------------------------------------------------------------------------------------------------
    console.log("\nZ3  tờ A0 ở 500%: bitmap bị chặn dưới hạn mức VÀ trang không trắng (BI-78)");
    await app.openPdf(await bigBlackPdf(3370, 2384), "a0.pdf");
    await settle();
    const px0 = await page.eval(centerPixel(0));
    expect(px0 && px0[3] === 255 && px0[0] < 40, `A0 ở tỷ lệ mặc định vẽ đen đặc: ${J(px0)}`);
    await page.eval(`zoomTo(5)`);
    await settle();
    const big = await page.eval(`(() => { const m = state.pageMetas[0]; const c = m.canvas;
      return { bw: c.width, bh: c.height, cssw: parseFloat(c.style.width), cssh: parseFloat(c.style.height), dpr: window.devicePixelRatio, scale: state.scale, paint: m.paintScale }; })()`);
    const mp = (big.bw * big.bh) / 1e6;
    expect(big.scale === 5 && big.cssw > 15000, `khung CSS vẫn đúng 500% (${big.cssw}×${big.cssh}px), hình học không bị bóp`);
    expect(mp > 0 && mp <= 40, `bitmap bị chặn dưới hạn mức: ${big.bw}×${big.bh} = ${mp.toFixed(1)} MP (≤ ~32 MP; không chặn sẽ là ${((big.cssw * big.cssh * big.dpr * big.dpr) / 1e6).toFixed(0)} MP)`);
    const pxBig = await page.eval(centerPixel(0));
    expect(pxBig && pxBig[3] === 255 && pxBig[0] < 40, `A0 ở 500% KHÔNG trắng: pixel giữa ${J(pxBig)} (trắng-im-lặng sẽ là alpha 0)`);
    expect((await page.eval(`state.pageMetas[0].paintScale`)) === 5, "paintScale được gán sau khi vẽ (BI-36)");

    // ---- Z4 -----------------------------------------------------------------------------------------------------
    console.log("\nZ4  40 trang: cuộn xuống cuối ⇒ trang đầu bị giải phóng bitmap, trang cuối đã vẽ; cuộn lên ⇒ vẽ lại");
    await app.openPdf(await makePdf(40), "bon-muoi-trang.pdf");
    await page.eval(`zoomReset()`);
    await settle();
    const rendered = () => page.eval(`state.pageMetas.map((m, i) => (m.wrap && m.wrap.dataset.rendered === "1" ? i : -1)).filter((i) => i >= 0)`);
    await page.eval(`(() => { document.getElementById("viewer").scrollTop = 0; return true; })()`); // tài liệu mới có thể giữ vị trí cuộn của tài liệu trước
    await until(async () => (await rendered()).includes(0), 20000);
    await settle();
    const r0 = await rendered();
    expect(r0.length > 0 && r0.length < 40 && r0.includes(0), `mới mở: chỉ một cửa sổ trang có bitmap (${r0.length}/40: ${J(r0)})`);
    await page.eval(`(() => { const v = document.getElementById("viewer"); v.scrollTop = v.scrollHeight; return true; })()`);
    const lastPainted = await until(async () => {
      const px = await page.eval(centerPixel(39));
      return px && px[3] === 255;
    }, 20000);
    expect(lastPainted, "cuộn xuống cuối: trang 40 đã vẽ (alpha 255)");
    const freed = await until(async () => !(await rendered()).includes(0), 20000);
    const r1 = await rendered();
    expect(freed, `trang 1 đã bị GIẢI PHÓNG bitmap (còn bitmap: ${J(r1)})`);
    expect(r1.length < 40, `số trang giữ bitmap bị chặn: ${r1.length}/40`);
    // cuộn lên-xuống nhanh bằng lăn chuột thật rồi dừng ở đầu
    const cc = await viewerCenter();
    for (let k = 0; k < 6; k++) {
      await page.wheel(cc.x, cc.y, 4000, { ctrl: false });
      await page.wheel(cc.x, cc.y, -6000, { ctrl: false });
    }
    await page.eval(`(() => { document.getElementById("viewer").scrollTop = 0; return true; })()`);
    const firstBack = await until(async () => {
      const px = await page.eval(centerPixel(0));
      return px && px[3] === 255;
    }, 20000);
    expect(firstBack, "cuộn lên đầu sau khi lăn nhanh: trang 1 vẽ lại, không trắng");
    const stuck = await page.eval(`state.pageMetas.filter((m) => m.rendering).length`);
    expect(stuck === 0, `không trang nào kẹt ở trạng thái 'đang vẽ' (${stuck})`);

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
  console.log("Zoom / cuộn / ảo hoá bitmap đúng ở cả 4 nhóm ca. Cảm giác lăn, bôi đen sau zoom, CAD thật vẫn phải test tay.");
})();
