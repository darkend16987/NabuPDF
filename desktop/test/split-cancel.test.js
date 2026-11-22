"use strict";

// BI-139 — nút Hủy cho lần TÁCH đang chạy (`runSplit`), dùng chung sổ việc và route hủy với nén (BI-126).
//
// VÌ SAO CÓ LƯỚI NÀY. Ba kiểu nút Hủy sai, và cả ba đều im lặng (xem compress-cancel.test.js):
//   1. Hủy gửi MỘT MÃ khác mã đã đi kèm /split ⇒ sidecar không thấy việc nào, tách chạy tiếp, không lỗi ở đâu.
//   2. Hủy bị tính là lỗi ⇒ toast đỏ "Tách PDF lỗi: Đã hủy tách."
//   3. Hủy không tới được sidecar mà lớp phủ vẫn đóng ⇒ nói dối là đã dừng.
//
// ĐO Ở ĐÂU. Khác compress-cancel (chỉ ghim nguồn runCompress), ở đây `runSplit` được CẮT NGUYÊN VĂN khỏi
// app.js đang ship rồi CHẠY với đồ giả cho các tên trần mà nó dùng — nên ba kiểu trên được đo bằng hành vi
// thật, không phải regex. Đỏ ở bước cắt (mốc đầu/cuối) là tín hiệu để đọc, không phải để sửa cho xanh.
//
// Chạy:  node desktop/test/split-cancel.test.js

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

const R = path.join(__dirname, "..", "renderer");
const APP = fs.readFileSync(path.join(R, "app.js"), "utf8");
const I18N = fs.readFileSync(path.join(R, "i18n.js"), "utf8");
const API = fs.readFileSync(path.join(__dirname, "..", "..", "api.py"), "utf8");

const i = APP.indexOf("async function runSplit()");
const j = APP.indexOf("// --- images → PDF ---", i);
check("cắt được runSplit ra khỏi app.js", i >= 0 && j > i, true);
const SRC = APP.slice(i, j);

// ---- 1. dựng môi trường giả và chạy runSplit THẬT ---------------------------------------------------
function makeEnv() {
  const calls = []; // mọi lần gọi sidecarFetch: { url, opts }
  const toasts = [];
  const els = {
    "split-mode": { value: "every" },
    "split-size": { value: "2" },
    "split-ranges": { value: "" },
    "split-modal": { hidden: false },
    "overlay": { hidden: true },
    "overlay-msg": { textContent: "" },
    "overlay-cancel": { hidden: true, disabled: false, onclick: null },
  };
  const env = {
    calls,
    toasts,
    els,
    onCancel: null,
    overlayShown: 0,
    overlayHidden: 0,
    overlayMsgs: [],
    splitResolve: null, // điều khiển khi nào /split trả lời
    cancelFails: false,
  };
  env.$ = (id) => els[id];
  env.state = { bytes: new Uint8Array([1, 2, 3]), name: "a.pdf" };
  env.t = (s) => s;
  env.toast = (msg, kind) => toasts.push({ msg, kind: kind === undefined ? "" : kind });
  env.baseName = (n) => n.replace(/\.pdf$/i, "");
  env.b64ToU8 = () => new Uint8Array([9]);
  env.newJobId = () => "job-XYZ-123";
  env.pdfJsonBody = (bins, fields) => JSON.stringify(fields); // đủ để đọc `job` trong thân
  env.showOverlay = (msg, onCancel) => {
    env.overlayShown++;
    env.overlayMsgs.push(msg);
    env.onCancel = onCancel;
  };
  env.setOverlayMsg = (m) => env.overlayMsgs.push(m);
  env.hideOverlay = () => env.overlayHidden++;
  env.sidecarFetch = (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith("/compress-cancel")) {
      if (env.cancelFails) return Promise.reject(new Error("mạng đứt"));
      return Promise.resolve({ ok: true });
    }
    if (url === "/split") return new Promise((res) => (env.splitResolve = res));
    throw new Error("route lạ: " + url);
  };
  env.window = { Editor: null, desktop: { saveFile: async () => ({ saved: true, path: "x.zip" }) } };
  return env;
}

const NAMES = ["$", "state", "t", "toast", "baseName", "b64ToU8", "newJobId", "pdfJsonBody", "showOverlay",
  "setOverlayMsg", "hideOverlay", "sidecarFetch", "window"];
function load(env) {
  return new Function(...NAMES, SRC + "\nreturn runSplit;")(...NAMES.map((n) => env[n]));
}
const tick = () => new Promise((r) => setImmediate(r));
const jsonRes = (o) => ({ json: async () => o });

(async () => {
  // (a) mã việc đi kèm /split VÀ đúng mã ấy đi tới /compress-cancel
  {
    const env = makeEnv();
    const p = load(env)();
    await tick();
    const split = env.calls.find((c) => c.url === "/split");
    check("runSplit gọi /split", !!split, true);
    const body = JSON.parse(split.opts.body);
    check("thân /split mang mã việc", body.job, "job-XYZ-123");
    check("… và vẫn mang các trường cũ", [body.mode, body.size], ["every", 2]);
    check("lớp phủ có hàm hủy (nút Hủy hiện)", typeof env.onCancel, "function");
    check("lớp phủ mở TRƯỚC khi fetch được gọi", env.overlayShown, 1);

    await env.onCancel();
    const huy = env.calls.find((c) => c.url.startsWith("/compress-cancel"));
    check("bấm Hủy gọi /compress-cancel", !!huy, true);
    check("… với ĐÚNG mã đã đi kèm /split", huy.url, "/compress-cancel?job=job-XYZ-123");
    check("… bằng POST", huy.opts.method, "POST");
    check("đang hủy thì đổi dòng chữ", env.overlayMsgs.includes("Đang hủy…"), true);
    check("KHÔNG đóng lớp phủ trước khi sidecar trả lời /split", env.overlayHidden, 0);

    // bấm lần hai: không gửi hủy thêm
    await env.onCancel();
    check("bấm lần hai không gửi hủy thêm lần nữa", env.calls.filter((c) => c.url.startsWith("/compress-cancel")).length, 1);

    // sidecar trả lời "đã hủy"
    env.splitResolve(jsonRes({ success: false, cancelled: true, error: "Đã hủy tách." }));
    await p;
    check("hủy ⇒ toast thường 'Đã hủy tách.'", env.toasts, [{ msg: "Đã hủy tách.", kind: "" }]);
    check("… KHÔNG có toast đỏ", env.toasts.some((x) => x.kind === "bad"), false);
    check("… và lớp phủ đóng (finally)", env.overlayHidden, 1);
  }

  // (b) lỗi thật vẫn là toast đỏ
  {
    const env = makeEnv();
    const p = load(env)();
    await tick();
    env.splitResolve(jsonRes({ success: false, error: "PDF này hỏng" }));
    await p;
    check("lỗi thật ⇒ toast đỏ có tiền tố cũ", env.toasts, [{ msg: "Tách PDF lỗi: PDF này hỏng", kind: "bad" }]);
    check("… lớp phủ vẫn đóng", env.overlayHidden, 1);
  }

  // (c) thành công không đổi
  {
    const env = makeEnv();
    const p = load(env)();
    await tick();
    env.splitResolve(jsonRes({ success: true, data_b64: "AA==", count: 3 }));
    await p;
    check("thành công ⇒ toast good", env.toasts.map((x) => x.kind), ["good"]);
    check("… nội dung nói số file", /3 file/.test(env.toasts[0].msg), true);
  }

  // (d) hủy KHÔNG tới được sidecar ⇒ việc VẪN chạy ⇒ mở lại nút, nói thật, không đóng lớp phủ
  {
    const env = makeEnv();
    env.cancelFails = true;
    const p = load(env)();
    await tick();
    env.els["overlay-cancel"].disabled = true; // showOverlay thật đã khoá nút ngay khi bấm
    await env.onCancel();
    check("hủy lỗi ⇒ nút được mở lại", env.els["overlay-cancel"].disabled, false);
    check("… và nói ra bằng toast đỏ", env.toasts.some((x) => x.kind === "bad" && /Không gửi được lệnh hủy/.test(x.msg)), true);
    check("… lớp phủ KHÔNG bị đóng giả vờ là xong", env.overlayHidden, 0);
    check("… dòng chữ về lại 'Đang tách PDF…'", env.overlayMsgs[env.overlayMsgs.length - 1], "Đang tách PDF…");
    // và bấm lại được
    env.cancelFails = false;
    await env.onCancel();
    check("bấm lại sau khi lỗi thì gửi được", env.calls.filter((c) => c.url.startsWith("/compress-cancel")).length, 2);
    env.splitResolve(jsonRes({ success: false, cancelled: true }));
    await p;
  }

  // (e) chế độ khoảng trang vẫn mang mã việc
  {
    const env = makeEnv();
    env.els["split-mode"].value = "ranges";
    env.els["split-ranges"].value = "1-2,4";
    const p = load(env)();
    await tick();
    const body = JSON.parse(env.calls.find((c) => c.url === "/split").opts.body);
    check("chế độ ranges cũng mang mã việc", [body.mode, body.ranges, body.job], ["ranges", "1-2,4", "job-XYZ-123"]);
    env.splitResolve(jsonRes({ success: false, cancelled: true }));
    await p;
  }

  // ---- 2. ghim nguồn ------------------------------------------------------------------------------
  check("không abort fetch phía renderer (nút phải nói thật)", /AbortController|\.abort\(\)/.test(SRC), false);
  check("mã việc sinh TRƯỚC khi mở lớp phủ",
    SRC.indexOf("newJobId()") >= 0 && SRC.indexOf("newJobId()") < SRC.indexOf("showOverlay("), true);
  check("câu 'Đã hủy tách.' có bản tiếng Anh", /"Đã hủy tách\.":\s*"Split cancelled\."/.test(I18N), true);

  // ---- 3. hợp đồng bắc qua hai ngôn ngữ ------------------------------------------------------------
  check("SplitRequest nhận `job` (mặc định rỗng)", /class SplitRequest[\s\S]*?job: str = ""/.test(API), true);
  check("ZipResponse có `cancelled` (mặc định False)", /class ZipResponse[\s\S]*?cancelled: bool = False/.test(API), true);
  check("/split trả cờ cancelled khi bị hủy", /ZipResponse\(success=False, cancelled=True/.test(API), true);

  console.log(`\nsplit-cancel: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
