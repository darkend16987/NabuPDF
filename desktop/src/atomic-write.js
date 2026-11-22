"use strict";

// BI-136 — ghi file KHÔNG NGUYÊN TỬ là cách duy nhất để mất trọn một hợp đồng đã ký.
//
// `fs.promises.writeFile(fp, data)` MỞ file với cờ "w" — cắt nó về 0 byte NGAY — rồi mới ghi dữ liệu. Mất điện, treo
// máy, ổ đầy, tiến trình bị giết giữa chừng ⇒ file đích còn 0 byte hoặc nửa chừng, và bản cũ (cả chữ ký số) KHÔNG
// còn ở đâu. Với file hàng trăm MB, cửa sổ rủi ro dài tới hàng giây.
//
// Cách làm ở đây: ghi vào một file TẠM nằm CÙNG thư mục (cùng ổ ⇒ đổi tên là một thao tác nguyên tử), ép dữ liệu xuống
// đĩa (fsync), kiểm đủ số byte, rồi MỚI đổi tên đè lên file đích. Bất kỳ lỗi nào trước bước đổi tên ⇒ file đích còn
// NGUYÊN VẸN và file tạm bị xoá. (Giống prefs.js / session.js, nhưng có fsync và kiểm kích thước — thiếu fsync thì
// sau mất điện NTFS có thể giữ tên mới mà dữ liệu là 0 byte.)
//
// Thuần: không biết gì về Electron; `fs` và `sleep` tiêm được để test chèn lỗi (xem test/atomic-write.test.js).

const nodeFs = require("fs");
const nodePath = require("path");
const crypto = require("crypto");

// Hậu tố KHÔNG phải ".pdf": file tạm không bao giờ lọt vào hộp chọn PDF, verb Explorer hay quét thư mục.
const TMP_SUFFIX = ".nabu-tmp";
// Đổi tên đè lên file đích trên Windows hay lỗi TẠM THỜI khi diệt virus / OneDrive / Explorer đang chạm vào file.
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const DEFAULT_DELAYS_MS = [40, 80, 160, 320, 640, 1280];
// Không tạo được file tạm VÌ QUYỀN (thư mục chỉ-đọc nhưng chính file thì ghi được): chưa đụng gì ⇒ rơi về cách cũ.
const NO_TMP_CODES = new Set(["EACCES", "EPERM"]);

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (data) => (data && typeof data.byteLength === "number" ? data.byteLength : -1);

function tmpPathFor(target) {
  const rand = crypto.randomBytes(6).toString("hex");
  return `${target}.${rand}${TMP_SUFFIX}`;
}

function fail(message, code, cause) {
  const e = new Error(message + (code ? ` [${code}]` : ""));
  if (code) e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/**
 * Ghi `data` vào `fp` nguyên tử.
 * @param {string} fp
 * @param {ArrayBufferView|Buffer} data
 * @param {{ fs?: object, sleep?: (ms:number)=>Promise<void>, retryDelays?: number[] }} [opts]
 * @returns {Promise<{ atomic: boolean, path: string }>}  atomic=false chỉ khi không tạo nổi file tạm vì quyền
 *          (đã rơi về ghi thẳng như trước BI-136). Mọi lỗi khác ⇒ ném; file đích còn nguyên.
 */
async function writeFileAtomic(fp, data, opts = {}) {
  const fs = opts.fs || nodeFs;
  const sleep = opts.sleep || realSleep;
  const delays = opts.retryDelays || DEFAULT_DELAYS_MS;
  const want = bytesOf(data);
  if (want < 0) throw new TypeError("writeFileAtomic: dữ liệu phải là Buffer hoặc ArrayBufferView");

  // Liên kết tượng trưng: đặt file tạm cạnh file THẬT và đổi tên đè lên file thật, để cái liên kết còn nguyên
  // (đổi tên đè lên chính liên kết sẽ thay nó bằng file thường). Chỉ gọi realpath khi THẬT SỰ là liên kết:
  // realpath của libuv trên Windows biến ổ ánh xạ (Z:) thành đường UNC, không nên đụng tới đường dẫn thường.
  let target = fp;
  try {
    const st = await fs.promises.lstat(fp);
    if (st.isSymbolicLink()) target = await fs.promises.realpath(fp);
  } catch (_) {
    // chưa có file ⇒ tạo mới; lỗi khác sẽ lộ ra ở bước mở file tạm
  }

  // 1. mở file tạm (cờ "wx": không bao giờ đè lên thứ gì có sẵn; trùng tên ngẫu nhiên ⇒ thử tên khác)
  let tmp = null;
  let fh = null;
  for (let attempt = 0; attempt < 3 && !fh; attempt++) {
    const candidate = tmpPathFor(target);
    try {
      fh = await fs.promises.open(candidate, "wx");
      tmp = candidate;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      if (err && NO_TMP_CODES.has(err.code)) {
        // Chưa đụng tới gì. Thư mục không cho tạo file mới nhưng file đích có thể vẫn ghi được: giữ hành vi cũ.
        await fs.promises.writeFile(target, data);
        return { atomic: false, path: fp };
      }
      throw err;
    }
  }
  if (!fh) throw fail("Không tạo được file tạm để ghi an toàn", "EEXIST");

  const cleanup = async () => {
    try { await fh.close(); } catch (_) {}
    try { await fs.promises.unlink(tmp); } catch (_) {}
  };

  // 2. ghi, ép xuống đĩa, đóng, kiểm đủ byte
  try {
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = { close: async () => {} }; // đã đóng: cleanup không đóng lần hai
    const st = await fs.promises.stat(tmp);
    if (st.size !== want) {
      throw fail(`Ghi thiếu dữ liệu (${st.size}/${want} byte) — file gốc còn nguyên`, "EIO");
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  // 3. đổi tên đè lên file đích — bước DUY NHẤT chạm vào file thật
  let last = null;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.promises.rename(tmp, target);
      return { atomic: true, path: fp };
    } catch (err) {
      last = err;
      if (!(err && RETRY_CODES.has(err.code)) || i === delays.length) break;
      await sleep(delays[i]);
    }
  }
  try { await fs.promises.unlink(tmp); } catch (_) {}
  if (last && RETRY_CODES.has(last.code)) {
    throw fail("Không thay được file đích (đang mở ở chương trình khác?) — file gốc còn nguyên", last.code, last);
  }
  throw last;
}

module.exports = { writeFileAtomic, TMP_SUFFIX };
