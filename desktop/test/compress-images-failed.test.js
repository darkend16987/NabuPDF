"use strict";
/**
 * Nabu PDF — lưới cho tín hiệu "ảnh không nén lại được" (BI-122).
 *
 * VIỆC NÀY CANH CÁI GÌ. Lưới quét corpus bắt được 6 file thật làm `rewrite_images()`
 * của MuPDF ném lỗi ("Bad PatternType", "pixmap may not have alpha to save as JPEG").
 * Sidecar giờ không bỏ cuộc nữa: nó bỏ bước ảnh, lưu bằng deflate + gom rác, và nói
 * ra bằng header `X-Images-Failed: 1`. Nếu renderer không đọc header đó thì người
 * dùng chọn "ebook" cho một file đầy ảnh, thấy nó nhỏ đi 1% và không có cách nào
 * biết vì sao — một lỗi IM LẶNG, không stack trace, không nút nào hỏng.
 *
 * VÌ SAO GHIM NGUỒN, KHÔNG CHẠY HÀM. `runCompress` nằm trong `app.js` và sống bằng
 * DOM (`$`, `toast`, `state`, `window.desktop`), nên bộ test node không gọi được nó —
 * đây là luật chung của repo, xem CLAUDE.md "Bộ test JS không chạy được app.js".
 *
 * VÀ ĐÂY LÀ GHIM BẮC CẦU HAI NGÔN NGỮ: tên header được đọc từ CHÍNH `api.py` chứ
 * không gõ lại ở đây. Đổi tên ở một bên là đỏ, chứ không phải là một header mà không
 * ai đọc. Cùng lý do, nó kiểm luôn tên đó có trong `expose_headers` của CORS — thiếu
 * dòng đó thì `res.headers.get(...)` trả về null mà không báo lỗi ở đâu cả (đã vấp:
 * xem ghi chú ngay trên expose_headers trong api.py).
 *
 * Chạy:  cd desktop ; npm run test:imgfail
 */

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const apiPy = fs.readFileSync(path.join(REPO, "api.py"), "utf8");
const appJs = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failed++;
    console.log("FAIL " + name + "\n     " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Tên header lấy từ api.py, không gõ lại.
const m = apiPy.match(/"(X-Images-[A-Za-z-]+)":\s*"1"/);

check("api.py vẫn gửi một header báo ảnh gãy", () => {
  assert(m, 'không thấy chỗ nào trong api.py đặt "X-Images-...": "1"');
});

const header = m ? m[1] : "X-Images-Failed";

check("header đó nằm trong expose_headers của CORS", () => {
  const block = apiPy.slice(apiPy.indexOf("expose_headers"), apiPy.indexOf("expose_headers") + 400);
  assert(
    block.includes('"' + header + '"'),
    header + " thiếu trong expose_headers => renderer đọc ra null, im lặng",
  );
});

check("renderer đọc đúng header đó", () => {
  assert(
    appJs.includes('headers.get("' + header + '")'),
    'app.js không gọi headers.get("' + header + '") — tín hiệu gửi đi mà không ai đọc',
  );
});

check("renderer nói lại cho người dùng khi ảnh gãy", () => {
  // Biến phải được DÙNG, không chỉ được gán: một `const imagesFailed = ...` không ai
  // đọc là đúng cái lỗi im lặng mà file này canh.
  const uses = appJs.match(/imagesFailed/g) || [];
  assert(uses.length >= 2, "imagesFailed chỉ xuất hiện " + uses.length + " lần — gán rồi bỏ quên?");
  // Và phải đổi đúng LỜI VĂN, không chỉ đổi màu cái toast: ít nhất một nhánh
  // `imagesFailed ? "..."` phải là một câu có nhắc đến ảnh. Đây là chỗ mà lần đầu
  // lưới này còn hở — nó xanh cả khi câu thông báo đã bị xoá, vì `imagesFailed ?
  // "warn" : "good"` cũng khớp.
  const branches = [...appJs.matchAll(/imagesFailed\s*\?\s*"([^"]*)"/g)].map((x) => x[1]);
  assert(branches.length > 0, "không thấy chỗ nào đổi lời thông báo theo imagesFailed");
  assert(
    branches.some((text) => text.toLowerCase().includes("ảnh")),
    "không nhánh nào nói với người dùng rằng ẢNH là thứ không nén lại được: " +
      JSON.stringify(branches),
  );
});

check("chỉ là ghi chú, KHÔNG phải lỗi", () => {
  // File vẫn được lưu bình thường: nhánh này nằm TRONG `if (r.saved)`, sau savePdf.
  const i = appJs.indexOf("const imagesFailed");
  const saveIdx = appJs.indexOf("window.desktop.savePdf", i);
  assert(i > 0 && saveIdx > i, "imagesFailed phải được đọc TRƯỚC khi lưu, và lưu vẫn phải chạy");
  const after = appJs.slice(i, saveIdx);
  assert(
    !/return;/.test(after),
    "có `return` giữa chừng — ảnh gãy không được phép huỷ việc lưu file",
  );
});

console.log(failed ? `\n${failed} test failed.` : "\nAll compress-images-failed tests passed.");
process.exit(failed ? 1 : 0);
