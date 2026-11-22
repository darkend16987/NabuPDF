"use strict";

/**
 * BI-130 — "Lưu nối thêm": giữ vùng ký của một file đã ký số khi người dùng bấm Lưu (chốt 4).
 *
 * Mảnh ghép ở MAIN, giữa hai thứ đã có:
 *   · cổng BI-127 (`signed-scan.js`): "bản mới có phá vùng ký không?";
 *   · route sidecar BI-129 (`POST /save-incremental-bin`): "nối một revision lên file gốc".
 *
 * Vì sao ở main chứ không ở renderer: byte tài liệu đã đi qua IPC tới main MỘT lần để ghi; gọi
 * sidecar từ đây không thêm lần chép nào, và hộp thoại (BI-127) cũng ở đây. Nó cũng giữ nguyên
 * tính chất "sidecar KHÔNG BAO GIỜ ghi file người dùng": sidecar chỉ trả byte, main kiểm lại bằng
 * chính cổng BI-127 (dữ liệu mới phải bắt đầu bằng đúng byte cũ tới hết vùng ký) rồi mới ghi.
 * Hai lớp độc lập: nếu lõi Python sai, cổng JS vẫn chặn.
 *
 * Fail-closed theo nghĩa của file này: bất kỳ điều gì không rõ (sidecar chưa sẵn sàng, từ chối,
 * hết giờ, kết quả không giữ được tiền tố, ném lỗi) ⇒ KHÔNG ghi bản nối; quay lại đúng hộp hỏi
 * BI-127 cũ (Lưu bản sao / Vẫn ghi đè / Huỷ) kèm lý do. Không bao giờ tự "ghi đè cho xong".
 *
 * Thuần: không require electron; `append`, `scan` và `ask` được tiêm vào nên test chạy được trong node.
 */

const http = require("http");

// Lý do (khớp `REASONS` + `WORKER_REASONS` ở src/pdf/incremental.py) → câu cho người dùng. Lý do lạ
// vẫn có câu: một chuỗi từ sidecar không bao giờ được in thẳng lên hộp thoại.
const REASON_VI = {
  not_pdf: "file gốc không mở được như một PDF",
  encrypted: "file có mật khẩu",
  repaired: "file gốc bị lỗi cấu trúc nên phải sửa khi mở",
  root_changed: "cấu trúc gốc của tài liệu đã bị dựng lại",
  container_collision: "các đối tượng bị đánh số trùng với bản gốc",
  signature_object_changed: "bản sửa động tới chính vùng chữ ký",
  unreadable_object: "file gốc có đối tượng đọc không được",
  apply_failed: "không áp được thay đổi",
  prefix_changed: "kết quả không giữ nguyên byte cũ",
  verify_failed: "kết quả không qua kiểm tra lại",
  timeout: "quá thời gian chờ",
  worker_unavailable: "không khởi động được tiến trình xử lý",
  worker_failed: "tiến trình xử lý bị lỗi",
  original_missing: "file gốc không còn ở chỗ cũ",
  sidecar_unavailable: "bộ xử lý nền chưa sẵn sàng",
  bad_response: "bộ xử lý nền trả về kết quả không hợp lệ",
  // BI-133 — ký nối thêm (sign-append.js)
  not_signed: "tài liệu không có chữ ký để nối tiếp",
  docmdp_locked: "tài liệu được chứng nhận (DocMDP) không cho thêm chữ ký",
  prepare_failed: "không dựng được chỗ giữ chữ ký mới",
  placeholder_missing: "không tìm thấy chỗ giữ chữ ký trong kết quả",
  rotated: "trang xoay chưa hỗ trợ chữ ký nhìn thấy",
};

function reasonText(reason) {
  return Object.prototype.hasOwnProperty.call(REASON_VI, reason) ? REASON_VI[reason] : "lý do không rõ";
}

// Sidecar tự hết giờ ở 120 s (INCREMENTAL_TIMEOUT_S) và TRẢ một JSON `timeout`; hạn phía này phải
// DÀI HƠN để lý do thật tới được tay ta, chỉ còn là lưới an toàn nếu sidecar treo hẳn.
const CLIENT_TIMEOUT_MS = 150_000;

/**
 * Gọi `/save-incremental-bin`. Trả `{ ok:true, bytes:Buffer, stats }` hoặc `{ ok:false, reason, detail }`.
 * KHÔNG ném: mọi lỗi mạng/định dạng thành `ok:false` (người gọi chỉ cần biết "lùi về hộp hỏi").
 * `request` tiêm được để test; mặc định là `http.request`.
 */
function appendViaSidecar({ port, token, originalPath, data, timeoutMs = CLIENT_TIMEOUT_MS, request = http.request }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    if (!port || !originalPath) return finish({ ok: false, reason: "sidecar_unavailable", detail: "" });
    const body = ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) // view, không chép
      : Buffer.from(data);
    let req;
    try {
      req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/save-incremental-bin?original_path=" + encodeURIComponent(originalPath),
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": body.length,
            ...(token ? { "X-Sidecar-Token": token } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", (e) => finish({ ok: false, reason: "bad_response", detail: String(e && e.message) }));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const ct = String(res.headers["content-type"] || "");
            if (res.statusCode === 200 && ct.includes("application/pdf")) {
              const h = res.headers;
              return finish({
                ok: true,
                bytes: buf,
                stats: {
                  changed: Number(h["x-changed"]) || 0,
                  added: Number(h["x-added"]) || 0,
                  reused: Number(h["x-reused"]) || 0,
                  unchanged: h["x-unchanged"] === "1",
                },
              });
            }
            // Mọi thứ khác là thất bại: JSON refused (HTTP 200), 400/401/500…
            let j = null;
            try {
              j = JSON.parse(buf.toString("utf8"));
            } catch (_) {}
            const reason = j && typeof j.reason === "string" ? j.reason : "bad_response";
            const detail = String((j && (j.detail || j.error)) || "").slice(0, 300);
            finish({ ok: false, reason, detail });
          });
        }
      );
    } catch (e) {
      return finish({ ok: false, reason: "sidecar_unavailable", detail: String(e && e.message) });
    }
    req.setTimeout(timeoutMs, () => {
      finish({ ok: false, reason: "timeout", detail: "" });
      req.destroy();
    });
    req.on("error", (e) => finish({ ok: false, reason: "sidecar_unavailable", detail: String(e && e.message) }));
    req.end(body);
  });
}

/**
 * Quyết định một lần ghi vào file đích `fp`, gộp cổng BI-127 + đường nối.
 *
 *   scan   — `{checkOverwrite(fp,data)}` (signed-scan.js)
 *   ask    — `ask({count, canAppend, failed})` ⇒ "append" | "overwrite" | "copy" | "cancel";
 *            `failed` là mã lý do khi lần nối vừa thất bại (hộp hỏi hiện lại không có nút nối)
 *   append — `append(fp, data)` ⇒ như `appendViaSidecar`; `null` = không có đường nối (sidecar chưa
 *            sẵn sàng, hoặc phiên đã xoá nội dung — xem `contentRemoved` ở main)
 *
 * Trả `{action:"write", data, incremental?, stats?, confirmed?}` | `{action:"copy"}` | `{action:"cancel"}`.
 * Giá trị lạ từ `ask` ⇒ "cancel" (nút hỏng không được thành ghi đè).
 */
async function planSignedWrite({ fp, data, scan, ask, append }) {
  const g = await scan.checkOverwrite(fp, data);
  if (!g.loss) return { action: "write", data };

  let canAppend = typeof append === "function";
  let failed = null;
  for (;;) {
    const choice = await ask({ count: g.count, canAppend, failed });
    if (choice === "overwrite") return { action: "write", data, confirmed: true };
    if (choice === "copy") return { action: "copy" };
    if (choice !== "append" || !canAppend) return { action: "cancel" };

    let r;
    try {
      r = await append(fp, data);
    } catch (e) {
      r = { ok: false, reason: "worker_failed", detail: String(e && e.message) };
    }
    if (r && r.ok && r.bytes) {
      // Lớp kiểm thứ hai, ĐỘC LẬP với lõi Python: kết quả phải còn nguyên vùng ký của file trên đĩa.
      const g2 = await scan.checkOverwrite(fp, r.bytes);
      if (g2.signed && !g2.loss) return { action: "write", data: r.bytes, incremental: true, stats: r.stats };
      r = { ok: false, reason: "prefix_changed" };
    }
    canAppend = false; // một lần thử thôi — hỏi lại với ba nút cũ, kèm lý do
    failed = (r && r.reason) || "worker_failed";
  }
}

module.exports = { appendViaSidecar, planSignedWrite, reasonText, REASON_VI, CLIENT_TIMEOUT_MS };
