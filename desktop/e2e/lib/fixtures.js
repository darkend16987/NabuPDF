"use strict";

// BI-141 — PDF mẫu dựng bằng pdf-lib (có sẵn trong desktop/node_modules), để e2e không phụ thuộc corpus ngoài repo.

const zlib = require("zlib");
const { PDFDocument, StandardFonts, degrees } = require("pdf-lib");

// `n` trang chữ "Trang <i>"; `rotations[i]` (tuỳ chọn) xoay trang i; `widths[i]` (tuỳ chọn) đặt bề rộng trang i — để nhận ra từng trang sau khi chuyển/ghép; `marks[i]` (tuỳ chọn) vẽ thêm một chuỗi ASCII lên trang i để dò xem nội dung còn nằm trong byte không (tìm bằng `containsText`, vì pdf-lib NÉN luồng nội dung).
async function makePdf(n = 3, { rotations = [], title = "e2e", widths = [], marks = {} } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([widths[i] || 400, 300]);
    page.drawText(`Trang ${i + 1}`, { x: 50, y: 150, size: 24, font });
    if (marks[i]) page.drawText(marks[i], { x: 50, y: 100, size: 14, font }); // chuỗi dò: tìm lại trong byte để biết nội dung còn/mất
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  }
  return Buffer.from(await doc.save());
}

// Chuỗi `needle` (ASCII) có nằm TRONG NỘI DUNG của PDF `buf` không — tìm cả trong byte thô lẫn trong MỌI luồng FlateDecode
// (nội dung trang, object stream) sau khi giải nén, ở cả dạng ASCII lẫn dạng thập lục phân. Dùng để chứng minh "bản rõ không còn" (BI-74/130): một PDF bị mã hoá AES
// hay đã bị xoá nội dung thì cả hai nơi đều không có chuỗi. Chỉ cần đúng cho PDF do pdf-lib/PyMuPDF ghi (luồng Flate, không
// lồng nhau); không phải trình phân tích PDF tổng quát.
function containsText(buf, needle) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = Buffer.from(needle, "latin1");
  // pdf-lib ghi chữ của phông chuẩn dạng THẬP LỤC PHÂN trong luồng nội dung (<4249…> Tj), nên tìm cả dạng đó.
  const hex = n.toString("hex").toUpperCase();
  const has = (x) => x.includes(n) || x.toString("latin1").toUpperCase().includes(hex);
  if (has(b)) return true;
  let from = 0;
  for (;;) {
    const s = b.indexOf("stream", from, "latin1");
    if (s < 0) return false;
    let start = s + 6;
    if (b[start] === 0x0d) start++;
    if (b[start] === 0x0a) start++;
    const e = b.indexOf("endstream", start, "latin1");
    if (e < 0) return false;
    try {
      if (has(zlib.inflateSync(b.subarray(start, e)))) return true;
    } catch (_) {
      /* không phải luồng Flate (ảnh, dữ liệu mã hoá…) */
    }
    from = e + 9;
  }
}

module.exports = { makePdf, containsText };
