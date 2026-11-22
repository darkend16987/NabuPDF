// Đường lưu HIỆN TẠI của app, thu nhỏ: pdf-lib mở file → xoay trang 1 thêm 90° → lưu.
// Dùng làm "bản đã sửa" cho tools/corpus_sweep_incremental.py (BI-128): đó chính là thứ mà
// lõi ghi nối phải nhận được trong đời thật — một file pdf-lib vừa dựng lại.
//
//   node tools/pdflib_rotate.js <vào.pdf> <ra.pdf>
//
// Thoát 0 = đã ghi. Thoát 2 = pdf-lib không mở/lưu nổi (in "PDFLIB_FAIL <lý do>" ra stdout).
const fs = require("fs");
const path = require("path");
const lib = require(path.join(__dirname, "..", "desktop", "renderer", "vendor", "pdf-lib.min.js"));
// BẢN VÁ BI-120, giống hệt thứ app thật nạp ngay sau pdf-lib (index.html: pdflib-stream-length.js).
// Không có dòng này, cả họ `tracemonkey*.pdf` ra khỏi pdf-lib với `/Length` cụt một byte, và lưới này
// sẽ đổ cho lõi ghi nối một cảnh báo qpdf mà nó không gây ra — đã vấp đúng như vậy ở lần chạy đầu.
require(path.join(__dirname, "..", "desktop", "renderer", "pdflib-stream-length.js")).applyStreamLengthFix(lib);

(async () => {
  try {
    const doc = await lib.PDFDocument.load(fs.readFileSync(process.argv[2]), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
    const p = doc.getPages()[0];
    p.setRotation(lib.degrees((p.getRotation().angle + 90) % 360));
    fs.writeFileSync(process.argv[3], await doc.save());
  } catch (e) {
    console.log("PDFLIB_FAIL " + String((e && e.message) || e).slice(0, 100));
    process.exit(2);
  }
})();
