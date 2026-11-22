"use strict";

// BI-141 — móc kiểm thử cho bộ khung e2e (desktop/e2e): trả lời HỘP THOẠI NATIVE từ một file kịch bản.
//
// VÌ SAO CÓ. Hộp thoại native (`dialog.showMessageBox` / `showSaveDialog` / `showOpenDialog`) là cửa sổ của hệ điều
// hành: CDP không bấm được. Trước đây mỗi probe nối `--inspect` vào tiến trình main rồi vá `dialog.*` bằng `eval` — mong
// manh (cổng thứ hai, `process.mainModule.require`, mỗi probe một bản vá riêng). Móc này thay thế đúng việc đó, MỘT lần.
//
// CÁCH DÙNG. Chỉ nạp khi biến môi trường `NABU_TEST_HOOKS` có giá trị = đường dẫn TUYỆT ĐỐI tới một thư mục đã tồn tại
// (main.js: `if (process.env.NABU_TEST_HOOKS) require("./test-hooks").install({ dialog })`). Trong thư mục đó:
//
//   answers.json   do BỘ KHUNG ghi (ghi nguyên tử: file tạm + đổi tên). Dạng:
//                  { "epoch": 3,
//                    "showMessageBox": [0, 3, { "response": 1, "checkboxChecked": true }],
//                    "showSaveDialog": ["C:/x/out.pdf", null],
//                    "showOpenDialog": [["C:/a.pdf", "C:/b.pdf"]] }
//                  Mỗi phương thức một HÀNG ĐỢI, lấy lần lượt. Đổi `epoch` ⇒ hàng đợi bắt đầu lại từ đầu (đó là cách bộ
//                  khung "đặt kịch bản mới" mà không cần main ghi ngược lại file — hai bên không bao giờ cùng ghi một file).
//   calls.jsonl    do MÓC ghi (nối thêm, mỗi hộp một dòng): { epoch, method, options, answer, unexpected, t }.
//
// LUẬT AN TOÀN (đừng nới mà chưa đọc BI-141):
//   1. ĐÁP ÁN LÀ DỮ LIỆU, KHÔNG BAO GIỜ LÀ MÃ: chỉ `JSON.parse`, không `eval`/`new Function`/`require` đường dẫn từ file.
//      Có ghim nguồn (`test-hooks.test.js`) bắt điều này.
//   2. HỘP KHÔNG CÓ ĐÁP ÁN ⇒ HUỶ, và ghi `unexpected: true`. Không bao giờ mặc định bấm nút "đồng ý/ghi đè": một kịch bản
//      thiếu đáp án phải làm app KHÔNG ghi gì, và bộ khung thấy `unexpected` mà làm test đỏ.
//   3. Fail-closed lúc khởi động: biến môi trường có mà thư mục không hợp lệ ⇒ NÉM LỖI (app không lên) thay vì chạy hờ
//      hợt với hộp thoại thật.
//   4. Luôn in một dòng cảnh báo ra stderr khi bật — để không ai chạy nhầm bản có móc mà không biết.
//   Bản đóng gói VẪN chứa file này (electron-builder `src/**/*`) nhưng nó nằm im nếu không có biến môi trường. Ai đặt
//   được biến môi trường của app thì vốn đã chạy được mã bằng quyền của người dùng — móc này không cho thêm quyền nào.

const fs = require("fs");
const path = require("path");

const METHODS = ["showMessageBox", "showSaveDialog", "showOpenDialog"];

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Hộp thoại được gọi (win, opts) hoặc (opts); lấy phần tuỳ chọn.
function pickOptions(args) {
  if (args.length >= 2 && isObj(args[1])) return args[1];
  if (isObj(args[0]) && !("webContents" in args[0]) && !("isDestroyed" in args[0])) return args[0];
  return {};
}

// Chỉ giữ phần JSON-hoá được của tuỳ chọn (không có cửa sổ cha, hàm, vòng tham chiếu).
function sanitizeOptions(method, o) {
  const keep =
    method === "showMessageBox"
      ? ["type", "title", "message", "detail", "buttons", "defaultId", "cancelId", "checkboxLabel", "noLink"]
      : ["title", "defaultPath", "filters", "properties", "buttonLabel", "message"];
  const out = {};
  for (const k of keep) {
    if (o[k] === undefined) continue;
    try {
      out[k] = JSON.parse(JSON.stringify(o[k]));
    } catch (_) {
      out[k] = String(o[k]);
    }
  }
  return out;
}

// Đáp án khi hàng đợi hết. Luật 2: HUỶ, không bao giờ "đồng ý".
// Cùng quy tắc của Electron cho nút Huỷ: `cancelId` nếu có, không thì nút đầu tiên tên "cancel"/"no", không thì 0.
function defaultAnswer(method, o) {
  if (method === "showMessageBox") {
    let r = 0;
    if (Number.isInteger(o.cancelId)) r = o.cancelId;
    else if (Array.isArray(o.buttons)) {
      const i = o.buttons.findIndex((b) => /^(cancel|no)$/i.test(String(b).trim()));
      if (i >= 0) r = i;
    }
    return { response: r, checkboxChecked: false };
  }
  if (method === "showSaveDialog") return { canceled: true, filePath: "" };
  return { canceled: true, filePaths: [] };
}

// Dạng gọn trong answers.json → giá trị Electron trả về.
function normalizeAnswer(method, raw) {
  if (method === "showMessageBox") {
    if (Number.isInteger(raw)) return { response: raw, checkboxChecked: false };
    if (isObj(raw)) return { checkboxChecked: false, ...raw };
    return null;
  }
  if (method === "showSaveDialog") {
    if (typeof raw === "string" && raw) return { canceled: false, filePath: raw };
    if (isObj(raw)) return raw;
    if (raw === null) return { canceled: true, filePath: "" };
    return null;
  }
  // showOpenDialog
  if (typeof raw === "string" && raw) return { canceled: false, filePaths: [raw] };
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    return raw.length ? { canceled: false, filePaths: raw } : { canceled: true, filePaths: [] };
  }
  if (isObj(raw)) return raw;
  if (raw === null) return { canceled: true, filePaths: [] };
  return null;
}

function install({ dialog, env = process.env, fsImpl = fs, now = () => Date.now() } = {}) {
  const dir = env.NABU_TEST_HOOKS;
  // Luật 3: fail-closed.
  if (!dir || !path.isAbsolute(dir)) {
    throw new Error("NABU_TEST_HOOKS phải là đường dẫn TUYỆT ĐỐI tới một thư mục đã có (nhận: " + JSON.stringify(dir) + ")");
  }
  let st;
  try {
    st = fsImpl.statSync(dir);
  } catch (e) {
    throw new Error("NABU_TEST_HOOKS không đọc được: " + e.message);
  }
  if (!st.isDirectory()) throw new Error("NABU_TEST_HOOKS không phải thư mục: " + dir);
  if (!dialog) throw new Error("test-hooks: thiếu đối tượng dialog");

  const answersPath = path.join(dir, "answers.json");
  const callsPath = path.join(dir, "calls.jsonl");
  const originals = {};
  let seenEpoch = null;
  const idx = { showMessageBox: 0, showSaveDialog: 0, showOpenDialog: 0 };

  // Đọc LẠI mỗi lần gọi (bộ khung có thể đổi kịch bản giữa hai hộp). Hỏng/thiếu ⇒ coi như rỗng: Luật 2 lo phần còn lại.
  function readAnswers() {
    try {
      const j = JSON.parse(fsImpl.readFileSync(answersPath, "utf8"));
      return isObj(j) ? j : {};
    } catch (_) {
      return {};
    }
  }

  function answerFor(method, opts) {
    const a = readAnswers();
    const epoch = a.epoch === undefined ? 0 : a.epoch;
    if (epoch !== seenEpoch) {
      seenEpoch = epoch;
      for (const m of METHODS) idx[m] = 0;
    }
    const queue = Array.isArray(a[method]) ? a[method] : [];
    let answer = null;
    let unexpected = false;
    if (idx[method] < queue.length) {
      answer = normalizeAnswer(method, queue[idx[method]]);
      idx[method]++;
      if (answer === null) unexpected = true; // mục không hiểu được: coi như hết đáp án
    } else {
      unexpected = true;
    }
    if (answer === null) answer = defaultAnswer(method, opts);
    try {
      fsImpl.appendFileSync(
        callsPath,
        JSON.stringify({ epoch, method, options: sanitizeOptions(method, opts), answer, unexpected, t: now() }) + "\n",
      );
    } catch (_) {
      /* không ghi được log không được làm hỏng app */
    }
    return answer;
  }

  for (const m of METHODS) {
    originals[m] = dialog[m];
    dialog[m] = async function (...args) {
      return answerFor(m, pickOptions(args));
    };
  }

  // Luật 4.
  console.error("[test-hooks] ACTIVE — hop thoai native duoc tra loi tu " + dir + " (chi dung de kiem thu)");

  return {
    dir,
    uninstall() {
      for (const m of METHODS) dialog[m] = originals[m];
    },
  };
}

module.exports = { install, defaultAnswer, normalizeAnswer, sanitizeOptions, METHODS };
