"use strict";

// Lưới cho renderer/pdflib-stream-length.js — bản vá pdf-lib cắt cụt stream có `/Length` gián tiếp.
//
// Vì sao lưới này tồn tại: lỗi đó **im lặng**. File vẫn mở được, vẫn đủ trang, chỉ có một
// stream mất byte cuối ⇒ ảnh giải nén ra rác hoặc nội dung trang thiếu. Không có lưới thì chỉ
// `npm run sweep:corpus` (cần corpus 153 MB ngoài repo) mới thấy.
//
// Ca thật lấy từ `tracemonkey.pdf` của corpus pdf.js: byte cuối của dữ liệu là 0x0D và nhà sản
// xuất viết `endstream` NGAY SAU dữ liệu, không chèn xuống dòng — pdf-lib tưởng 0x0D là dấu
// ngăn cách và ăn mất nó.
//
// Thứ tự trong file này có chủ đích: đo hành vi pdf-lib **chưa vá** trước (đó là bằng chứng
// lưới này đỏ được), rồi mới vá rồi đo lại. Bản vá sửa prototype nên không gỡ ra được.
//
// Run:  node desktop/test/pdflib-stream-length.test.js      (hoặc: npm run test:streamlen)

const fs = require("fs");
const path = require("path");
const PDFLib = require("pdf-lib");
const { applyStreamLengthFix } = require("../renderer/pdflib-stream-length.js");

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${expected}\n  actual   ${actual}`);
  }
}

// --- dựng một PDF nhỏ, viết tay từng byte ---------------------------------------------------
//
// Phải viết tay: không thư viện nào chịu sinh ra `/Length` gián tiếp kèm `endstream` dính liền
// dữ liệu — mà đó chính là ca cần thử.

const CR = 0x0d;
const LF = 0x0a;

function bytes(n, seed = 7) {
  const u8 = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    u8[i] = (x >>> 24) || 1; // tránh 0 cho dễ nhìn khi debug
  }
  return u8;
}

/**
 * @param data      nội dung stream (byte thật)
 * @param tail      byte viết NGAY SAU dữ liệu, trước từ khoá `endstream`
 * @param declared  số mà object độ dài sẽ ghi (mặc định: độ dài thật)
 */
function streamObj(num, lenRef, data, tail, declared) {
  const head = `${num} 0 obj\n<< /Type /XObject /Subtype /Image /Width 4 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${lenRef} 0 R >>\nstream\n`;
  const foot = `endstream\nendobj\n`;
  return [Buffer.from(head, "latin1"), Buffer.from(data), Buffer.from(tail), Buffer.from(foot, "latin1")];
}

function buildPdf(parts) {
  const head = Buffer.from("%PDF-1.7\n", "latin1");
  const objs = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "latin1"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>\nendobj\n",
      "latin1"
    ),
  ];
  const tail = Buffer.from("trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n", "latin1");
  return new Uint8Array(Buffer.concat([head, ...objs, ...parts, tail]));
}

// Ba ca, trong một tài liệu:
//   4 0 R — ca hỏng: dữ liệu kết thúc bằng 0x0D, `endstream` dính liền (ca tracemonkey)
//   6 0 R — ca lành: có dấu xuống dòng thật ngăn cách ⇒ bản vá phải KHÔNG đụng vào
//   8 0 R — ca độ dài khai báo bậy (quá dài) ⇒ bản vá phải từ chối, giữ nguyên kết quả cũ
const BAD = Buffer.concat([Buffer.from(bytes(31)), Buffer.from([CR])]); // 32 byte, byte cuối là CR
const GOOD = Buffer.from(bytes(24, 3)); // 24 byte, không kết thúc bằng CR/LF
const BOGUS = Buffer.concat([Buffer.from(bytes(15, 9)), Buffer.from([LF])]); // 16 byte, cuối là LF

const parts = [
  ...streamObj(4, 5, BAD, ""), // không có byte ngăn cách
  Buffer.from(`5 0 obj\n${BAD.length}\nendobj\n`, "latin1"),
  ...streamObj(6, 7, GOOD, "\n"), // xuống dòng thật
  Buffer.from(`7 0 obj\n${GOOD.length}\nendobj\n`, "latin1"),
  ...streamObj(8, 9, BOGUS, ""),
  Buffer.from(`9 0 obj\n${BOGUS.length + 500}\nendobj\n`, "latin1"), // số vô lý
];
const PDF = buildPdf(parts);

async function lengthsOf() {
  const doc = await PDFLib.PDFDocument.load(PDF, { updateMetadata: false });
  const get = (n) => {
    const o = doc.context.lookup(PDFLib.PDFRef.of(n, 0));
    return o && o.contents ? o.contents : null;
  };
  return { bad: get(4), good: get(6), bogus: get(8) };
}

(async () => {
  // --- pdf-lib NGUYÊN BẢN: đây là lỗi, ghim lại để lưới này đỏ được nếu ai gỡ bản vá ---------
  const before = await lengthsOf();
  check("chưa vá: stream kết thúc bằng CR bị cắt mất 1 byte", before.bad.length, BAD.length - 1);
  check("chưa vá: stream có xuống dòng thật thì đúng", before.good.length, GOOD.length);
  check("chưa vá: stream kết thúc bằng LF bị cắt mất 1 byte", before.bogus.length, BOGUS.length - 1);

  // --- vá ---------------------------------------------------------------------------------
  check("vá được", applyStreamLengthFix(PDFLib), true);
  check("vá lần hai là không-op", applyStreamLengthFix(PDFLib), false);

  const after = await lengthsOf();

  // (1) ca hỏng được cắt lại đúng, từng byte
  check("đã vá: đủ độ dài thật", after.bad.length, BAD.length);
  check("đã vá: byte cuối là 0x0D", after.bad[after.bad.length - 1], CR);
  let same = after.bad.length === BAD.length;
  for (let i = 0; same && i < BAD.length; i++) if (after.bad[i] !== BAD[i]) same = false;
  check("đã vá: trùng khớp từng byte với dữ liệu gốc", same, true);

  // (2) không đụng vào stream vốn đã đúng
  check("đã vá: stream lành giữ nguyên", after.good.length, GOOD.length);

  // (3) độ dài khai báo bậy ⇒ từ chối, giữ nguyên hành vi cũ (KHÔNG cắt theo số bậy)
  check("đã vá: độ dài vô lý bị từ chối", after.bogus.length, before.bogus.length);

  // (4) tài liệu vẫn mở và lưu được sau khi vá
  const doc = await PDFLib.PDFDocument.load(PDF, { updateMetadata: false });
  const out = await doc.save({ updateFieldAppearances: false });
  check("đã vá: lưu ra được", out.length > 0, true);

  // --- ghim nguồn: MỌI nơi nạp pdf-lib đều phải nạp bản vá --------------------------------
  //
  // Vá sửa prototype, mà mỗi scope toàn cục có một bản pdf-lib riêng: `<script>` trong
  // index.html KHÔNG với tới Web Worker, và cũng không với tới tiến trình main. Quên một nơi
  // là nơi đó đọc tài liệu bằng parser chưa vá — im lặng, không lỗi. Hai ghim dưới đây đỏ
  // ngay khi ai đó thêm một chỗ nạp pdf-lib mới mà quên bản vá.
  const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  for (const f of fs.readdirSync(path.join(__dirname, "..", "renderer")).filter((f) => f.endsWith(".js"))) {
    const src = R(path.join("renderer", f));
    const i = src.indexOf('importScripts("vendor/pdf-lib.min.js")');
    if (i < 0) continue;
    const j = src.indexOf('importScripts("pdflib-stream-length.js")');
    check(`worker ${f}: importScripts bản vá`, j > i, true);
  }

  for (const f of fs.readdirSync(path.join(__dirname, "..", "src")).filter((f) => f.endsWith(".js"))) {
    const src = R(path.join("src", f));
    // `require("pdf-lib")` thật sự dùng thư viện; nhắc tên trong comment thì không tính.
    if (!/require\(\s*["']pdf-lib["']\s*\)/.test(src)) continue;
    check(`main ${f}: gọi applyStreamLengthFix`, /applyStreamLengthFix\s*\(/.test(src), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
