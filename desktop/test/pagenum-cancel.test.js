"use strict";

// BI-140 — nút Hủy cho lần ĐÁNH SỐ TRANG đang chạy (`runPageNumbers`), dùng chung sổ việc và route hủy với nén (BI-126)
// và tách (BI-139). Chị em của split-cancel.test.js.
//
// VÌ SAO CÓ LƯỚI NÀY. Ba kiểu nút Hủy sai, cả ba đều im lặng (xem compress-cancel.test.js), và ở đây có THÊM một kiểu
// nguy hiểm hơn vì thao tác này SỬA TÀI LIỆU ĐANG MỞ:
//   1. Hủy gửi MỘT MÃ khác mã đã đi kèm /add-page-numbers ⇒ sidecar không thấy việc nào, việc chạy tiếp.
//   2. Hủy bị tính là lỗi ⇒ toast đỏ "Đánh số lỗi: Đã hủy đánh số."
//   3. Hủy không tới được sidecar mà lớp phủ vẫn đóng ⇒ nói dối là đã dừng.
//   4. (RIÊNG Ở ĐÂY) Hủy xong mà `pushUndo()` / `state.bytes = …` vẫn chạy ⇒ tài liệu bị đổi dù người dùng bảo dừng,
//      hoặc mất một bước Ctrl+Z vô cớ. Hủy và lỗi phải return TRƯỚC hai dòng ấy.
//
// ĐO Ở ĐÂU. `runPageNumbers` được CẮT NGUYÊN VĂN khỏi app.js đang ship rồi CHẠY với đồ giả cho các tên trần nó dùng —
// hành vi thật, không phải regex. Đỏ ở bước cắt (mốc đầu/cuối) là tín hiệu để đọc, không phải để sửa cho xanh.
//
// Chạy:  node desktop/test/pagenum-cancel.test.js

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

const i = APP.indexOf("async function runPageNumbers()");
const j = APP.indexOf("// Toolbar dropdowns", i);
check("cắt được runPageNumbers ra khỏi app.js", i >= 0 && j > i, true);
const SRC = APP.slice(i, j);

function makeEnv() {
  const calls = [];
  const toasts = [];
  const els = {
    "pgnum-modal": { hidden: false },
    "pgnum-fmt": { value: "n_of_n" },
    "pgnum-pos": { value: "top-right" },
    "pgnum-start": { value: "3" },
    "pgnum-skip": { value: "1" },
    "pgnum-size": { value: "14" },
    "pgnum-color": { value: "#ff0000" },
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
    pushUndoCalls: 0,
    renderAllCalls: 0,
    pnResolve: null,
    cancelFails: false,
  };
  const ORIGINAL = new Uint8Array([1, 2, 3]);
  env.ORIGINAL = ORIGINAL;
  env.$ = (id) => els[id];
  env.state = { bytes: ORIGINAL, name: "a.pdf" };
  env.t = (s) => s;
  env.toast = (msg, kind) => toasts.push({ msg, kind: kind === undefined ? "" : kind });
  env.b64ToU8 = () => new Uint8Array([9, 9]);
  env.newJobId = () => "job-PN-777";
  env.pdfJsonBody = (bins, fields) => JSON.stringify(fields);
  env.pushUndo = () => env.pushUndoCalls++;
  env.renderAll = async () => env.renderAllCalls++;
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
    if (url === "/add-page-numbers") return new Promise((res) => (env.pnResolve = res));
    throw new Error("route lạ: " + url);
  };
  env.window = { Editor: null };
  return env;
}

const NAMES = ["$", "state", "t", "toast", "b64ToU8", "newJobId", "pdfJsonBody", "pushUndo", "renderAll", "showOverlay",
  "setOverlayMsg", "hideOverlay", "sidecarFetch", "window"];
function load(env) {
  return new Function(...NAMES, SRC + "\nreturn runPageNumbers;")(...NAMES.map((n) => env[n]));
}
const tick = () => new Promise((r) => setImmediate(r));
const jsonRes = (o) => ({ json: async () => o });

(async () => {
  // (a) mã việc đi kèm /add-page-numbers VÀ đúng mã ấy đi tới /compress-cancel; hủy KHÔNG chạm tài liệu
  {
    const env = makeEnv();
    const p = load(env)();
    await tick();
    const call = env.calls.find((c) => c.url === "/add-page-numbers");
    check("runPageNumbers gọi /add-page-numbers", !!call, true);
    const body = JSON.parse(call.opts.body);
    check("thân mang mã việc", body.job, "job-PN-777");
    check("… và vẫn mang đủ các trường cũ", [body.fmt, body.position, body.start_at, body.skip_first, body.font_size, body.color],
      ["n_of_n", "top-right", 3, 1, 14, "#ff0000"]);
    check("lớp phủ có hàm hủy (nút Hủy hiện)", typeof env.onCancel, "function");
    check("lớp phủ mở TRƯỚC khi fetch được gọi", env.overlayShown, 1);

    await env.onCancel();
    const huy = env.calls.find((c) => c.url.startsWith("/compress-cancel"));
    check("bấm Hủy gọi /compress-cancel", !!huy, true);
    check("… với ĐÚNG mã đã đi kèm /add-page-numbers", huy.url, "/compress-cancel?job=job-PN-777");
    check("… bằng POST", huy.opts.method, "POST");
    check("đang hủy thì đổi dòng chữ", env.overlayMsgs.includes("Đang hủy…"), true);
    check("KHÔNG đóng lớp phủ trước khi sidecar trả lời", env.overlayHidden, 0);

    await env.onCancel();
    check("bấm lần hai không gửi hủy thêm", env.calls.filter((c) => c.url.startsWith("/compress-cancel")).length, 1);

    env.pnResolve(jsonRes({ success: false, cancelled: true, error: "Đã hủy đánh số." }));
    await p;
    check("hủy ⇒ toast thường 'Đã hủy đánh số.'", env.toasts, [{ msg: "Đã hủy đánh số.", kind: "" }]);
    check("… KHÔNG có toast đỏ", env.toasts.some((x) => x.kind === "bad"), false);
    check("… lớp phủ đóng (finally)", env.overlayHidden, 1);
    // QUAN TRỌNG: thao tác này sửa tài liệu đang mở — hủy không được đụng tới nó.
    check("hủy KHÔNG gọi pushUndo (không mất bước Ctrl+Z)", env.pushUndoCalls, 0);
    check("hủy KHÔNG thay state.bytes", env.state.bytes === env.ORIGINAL, true);
    check("hủy KHÔNG vẽ lại", env.renderAllCalls, 0);
  }

  // (b) lỗi thật: toast đỏ, và cũng KHÔNG chạm tài liệu
  {
    const env = makeEnv();
    const p = load(env)();
    await tick();
    env.pnResolve(jsonRes({ success: false, error: "PDF này hỏng" }));
    await p;
    check("lỗi thật ⇒ toast đỏ có tiền tố cũ", env.toasts, [{ msg: "Đánh số lỗi: PDF này hỏng", kind: "bad" }]);
    check("… không pushUndo, không đổi bytes", [env.pushUndoCalls, env.state.bytes === env.ORIGINAL], [0, true]);
    check("… lớp phủ vẫn đóng", env.overlayHidden, 1);
  }

  // (c) thành công không đổi: pushUndo TRƯỚC khi đổi bytes (BI-3), rồi vẽ lại
  {
    const env = makeEnv();
    let bytesWhenUndo = null;
    env.pushUndo = () => {
      env.pushUndoCalls++;
      bytesWhenUndo = env.state.bytes;
    };
    const p = load(env)();
    await tick();
    env.pnResolve(jsonRes({ success: true, data_b64: "AA==", pages: 3 }));
    await p;
    check("thành công ⇒ pushUndo đúng một lần", env.pushUndoCalls, 1);
    check("… pushUndo chạy TRƯỚC khi đổi bytes (BI-3)", bytesWhenUndo === env.ORIGINAL, true);
    check("… bytes được thay bằng kết quả", Array.from(env.state.bytes), [9, 9]);
    check("… vẽ lại một lần", env.renderAllCalls, 1);
    check("… toast good", env.toasts.map((x) => x.kind), ["good"]);
  }

  // (d) hủy KHÔNG tới được sidecar ⇒ mở lại nút, nói thật, không đóng lớp phủ
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
    check("… dòng chữ về lại 'Đang đánh số trang…'", env.overlayMsgs[env.overlayMsgs.length - 1], "Đang đánh số trang…");
    env.cancelFails = false;
    await env.onCancel();
    check("bấm lại sau khi lỗi thì gửi được", env.calls.filter((c) => c.url.startsWith("/compress-cancel")).length, 2);
    env.pnResolve(jsonRes({ success: false, cancelled: true }));
    await p;
  }

  // ---- ghim nguồn ------------------------------------------------------------------------------
  check("không abort fetch phía renderer (nút phải nói thật)", /AbortController|\.abort\(\)/.test(SRC), false);
  check("mã việc sinh TRƯỚC khi mở lớp phủ",
    SRC.indexOf("newJobId()") >= 0 && SRC.indexOf("newJobId()") < SRC.indexOf("showOverlay("), true);
  // Mốc là DÒNG GỌI thật (`\n    pushUndo();`), không phải chữ `pushUndo()` đầu tiên — comment cũng nhắc tên nó.
  check("nhánh hủy/lỗi nằm TRƯỚC lời gọi pushUndo()",
    SRC.indexOf("data.cancelled") >= 0 && SRC.indexOf("data.cancelled") < SRC.indexOf("\n    pushUndo();"), true);
  check("câu 'Đã hủy đánh số.' có bản tiếng Anh", /"Đã hủy đánh số\.":\s*"Page numbering cancelled\."/.test(I18N), true);

  // ---- hợp đồng bắc qua hai ngôn ngữ -------------------------------------------------------------
  check("PageNumberRequest nhận `job` (mặc định rỗng)", /class PageNumberRequest[\s\S]*?job: str = ""/.test(API), true);
  check("PdfBytesResponse có `cancelled` (mặc định False)", /class PdfBytesResponse[\s\S]*?cancelled: bool = False/.test(API), true);
  check("/add-page-numbers trả cờ cancelled khi bị hủy", /PdfBytesResponse\(success=False, cancelled=True/.test(API), true);

  console.log(`\npagenum-cancel: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
