"use strict";

/**
 * Chốt chặn "đừng lặng lẽ phá chữ ký số" (BI-127).
 *
 * VẤN ĐỀ. Mọi đường lưu của app dựng lại TOÀN BỘ file (pdf-lib `save()`), nên một hợp đồng
 * đã ký mà sửa rồi lưu đè là mất chữ ký — và trước BI-127 app không hề biết file mình sắp
 * ghi đè là file đã ký. Đo trên corpus pdf.js: 7/7 file ký thật mà pdf-lib mở được đều mất
 * vùng ký sau một lần "xoay trang rồi lưu".
 *
 * VÌ SAO KIỂM Ở MAIN, TRÊN FILE ĐANG NẰM TRÊN ĐĨA — không phải ở renderer lúc mở file:
 *   · có 13 chỗ renderer ghi PDF (12 × `savePdf` + `writePdf`); chặn ở renderer là sửa 13 chỗ
 *     và sót chỗ thứ 14;
 *   · lúc mở, byte có thể đã bị sửa rồi (khôi phục sau crash, tab tách ra) — renderer nhìn
 *     thấy "file không có chữ ký" trong khi file trên đĩa thì có;
 *   · "Lưu thành" chọn trúng đường dẫn của chính file đã ký cũng đi qua đây.
 * Nguồn sự thật duy nhất là: file ở đường dẫn sắp bị ghi đè, ngay trước khi byte chạm đĩa.
 *
 * "CHỮ KÝ CÒN NGUYÊN" ĐƯỢC ĐỊNH NGHĨA THẾ NÀO. Chữ ký PDF là chữ ký trên các byte nằm trong
 * `/ByteRange [0 L1 C L2]` (mọi thứ trừ ô `/Contents` chứa chính chữ ký). Nên: nếu dữ liệu mới
 * bắt đầu bằng ĐÚNG những byte cũ tới hết vùng ký (`C + L2`), thì mọi chữ ký trong đó còn đúng
 * về mặt toán học — đó chính là tính chất của "ghi nối" (lưu incremental), nên chốt sau này làm
 * ghi nối sẽ đi qua cổng này mà không cần sửa gì. Còn nếu byte đã bị dựng lại thì mất.
 * Ta KHÔNG xác minh mật mã (không có trọng tài độc lập ở đây): ta chỉ trả lời "byte được ký còn
 * nguyên hay không" — đủ để quyết định có phải hỏi người dùng.
 *
 * FAIL-OPEN CÓ CHỦ ĐÍCH. Mọi lỗi đọc file (không tồn tại, bị khoá, không đủ quyền) ⇒ coi như
 * không có thông tin ⇒ cho ghi như trước. Cái cổng này là lời nhắc, không được biến thành lý do
 * để "Lưu" không lưu nổi; chính lệnh ghi sẽ báo lỗi thật nếu có.
 *
 * ĐỌC THEO KHÚC, KHÔNG NẠP CẢ FILE: file đích có thể vài trăm MB (bài học large-pdf-decode-oom),
 * và nó nằm trong main process.
 */

const fs = require("fs");

const NEEDLE = Buffer.from("/ByteRange");
const BYTERANGE = /^\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/;
const DEFAULT_CHUNK = 4 * 1024 * 1024;
const PROBE = 160; // đủ cho "/ByteRange [ 0 123456789 123456789 123456789 ]" kể cả khoảng trắng thừa
const MIN_CHUNK = 32; // phải ≥ NEEDLE.length, nếu không chồng lấn giữa hai khúc không còn nghĩa
const MAX_GAP = 1 << 20; // 1 MiB: rộng gấp ~25 lần chữ ký có dấu thời gian + LTV lớn nhất đã đo
const HEX_ONLY = /^[0-9A-Fa-f\s]*$/;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/**
 * Tìm các chữ ký còn "nguyên vị trí" trong một file.
 * Trả `{ size, count, end }`: `end` = byte cuối cùng (không gồm) của vùng được ký xa nhất.
 *
 * Một `/ByteRange` chỉ được tính khi NHÌN ĐÚNG như của một chữ ký thật:
 *   · bốn số nguyên, bắt đầu từ 0 (đặc tả bắt buộc), không vượt quá cỡ file;
 *   · khoảng hở [L1, C) là ô `/Contents`: một chuỗi hex đóng trong `< >` (dấu ngoặc nằm trong
 *     hoặc ngoài khoảng hở tuỳ bộ ký — cả hai quy ước đều có thật). Sau khi file bị dựng lại, mọi
 *     offset dịch đi nên điều kiện này hỏng — và đó chính là cách ta nhận ra "ByteRange còn đó
 *     nhưng chữ ký đã mất" (đo: `issue6127`, `xfa_filled_imm1344e` trỏ vào chữ thường). Ô giữ
 *     chỗ `[0 ********** …]` của một file đang được ký dở cũng không qua vì không phải số.
 */
async function findIntactSignatures(fp, opts) {
  const chunk = Math.max(MIN_CHUNK, (opts && opts.chunk) || DEFAULT_CHUNK);
  const fh = await fs.promises.open(fp, "r");
  try {
    const { size } = await fh.stat();
    let count = 0;
    let end = 0;
    // Bước nhảy = chunk − (độ dài kim − 1): hai khúc chồng nhau đúng 9 byte, nên một kim nằm
    // vắt qua ranh giới vẫn lọt trọn vào MỘT khúc nào đó — và không khúc nào thấy cùng một
    // kim hai lần (kim bắt đầu trong vùng chồng không vừa trong khúc trước).
    const step = chunk - (NEEDLE.length - 1);
    for (let pos = 0; pos < size; pos += step) {
      const buf = await readAt(fh, pos, Math.min(chunk, size - pos));
      for (let i = buf.indexOf(NEEDLE); i !== -1; i = buf.indexOf(NEEDLE, i + 1)) {
        const abs = pos + i;
        const probe = await readAt(fh, abs, Math.min(PROBE, size - abs));
        const m = BYTERANGE.exec(probe.toString("latin1"));
        if (!m) continue;
        const [a, l1, c, l2] = m.slice(1).map(Number);
        if (![a, l1, c, l2].every(Number.isSafeInteger)) continue;
        if (a !== 0 || l1 <= 0 || c - l1 < 4 || c + l2 > size || c >= size) continue;
        if (c - l1 > MAX_GAP) continue; // chữ ký thật không to cỡ đó; đừng đọc cả MB vì một con số lạ
        // Khoảng hở [l1, c) PHẢI là chuỗi hex của /Contents. Có HAI quy ước thật trong thực tế
        // (đo trên corpus): Acrobat/Foxit để cả hai dấu < > TRONG khoảng hở; một số bộ ký khác
        // để chúng NGOÀI (khoảng hở chỉ gồm chữ số hex — `signed_verified.pdf`). Nhận cả hai,
        // và kiểm thêm ruột là hex: chặt hơn hẳn việc chỉ nhìn hai dấu ngoặc.
        const gap = await readAt(fh, l1 - 1, c - l1 + 2); // byte l1-1 … byte c, gồm cả hai đầu
        if (gap.length !== c - l1 + 2) continue;
        const inner =
          gap[1] === 0x3c && gap[gap.length - 2] === 0x3e // < … > nằm TRONG khoảng hở
            ? gap.subarray(2, gap.length - 2)
            : gap[0] === 0x3c && gap[gap.length - 1] === 0x3e // < … > nằm NGOÀI
              ? gap.subarray(1, gap.length - 1)
              : null;
        if (!inner || !HEX_ONLY.test(inner.toString("latin1"))) continue;
        count++;
        if (c + l2 > end) end = c + l2;
      }
      if (pos + chunk >= size) break;
    }
    return { size, count, end };
  } finally {
    await fh.close();
  }
}

// `data` đến từ IPC thường là Uint8Array; bọc thành Buffer KHÔNG sao chép (cùng lý do với
// ipc-bytes.js: tránh cấp phát thêm một bản 400 MB).
function asBuffer(data) {
  return ArrayBuffer.isView(data)
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(data);
}

/** `data` có bắt đầu bằng đúng `end` byte đầu của file `fp` không? So theo khúc. */
async function startsWithFilePrefix(fp, data, end, opts) {
  const chunk = Math.max(MIN_CHUNK, (opts && opts.chunk) || DEFAULT_CHUNK);
  const buf = asBuffer(data);
  if (buf.length < end) return false;
  const fh = await fs.promises.open(fp, "r");
  try {
    for (let off = 0; off < end; off += chunk) {
      const n = Math.min(chunk, end - off);
      const old = await readAt(fh, off, n);
      if (old.length !== n) return false;
      if (Buffer.compare(old, buf.subarray(off, off + n)) !== 0) return false;
    }
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * Ghi `data` đè lên `fp` có làm mất chữ ký nào của file hiện có không?
 *   { signed:false, loss:false }          — file chưa có / không ký / không đọc được
 *   { signed:true,  loss:false, count }   — có chữ ký và dữ liệu mới giữ nguyên vùng ký
 *   { signed:true,  loss:true,  count }   — có chữ ký và ghi đè sẽ phá chúng
 */
async function checkOverwrite(fp, data, opts) {
  try {
    const sig = await findIntactSignatures(fp, opts);
    if (sig.count === 0) return { signed: false, loss: false };
    const kept = await startsWithFilePrefix(fp, data, sig.end, opts);
    return { signed: true, loss: !kept, count: sig.count };
  } catch (_) {
    return { signed: false, loss: false }; // fail-open: xem đầu file
  }
}

/**
 * Cổng dùng chung cho mọi đường ghi PDF ở main. `ask(count)` là câu hỏi (hộp thoại thật ở
 * main.js; giả trong test) và trả một trong "overwrite" | "copy" | "cancel".
 * Kết quả: { action: "write" | "copy" | "cancel" }.
 *   write  — cứ ghi (file không ký, hoặc vùng ký còn nguyên, hoặc người dùng chọn ghi đè)
 *   copy   — người dùng muốn một nơi khác: đừng ghi gì cả
 *   cancel — bỏ hẳn
 * Bất kỳ giá trị lạ nào từ `ask` đều bị coi là "cancel": nút bấm hỏng không được biến thành ghi đè.
 */
async function guardWrite(fp, data, ask, opts) {
  const g = await checkOverwrite(fp, data, opts);
  if (!g.loss) return { action: "write", guard: g };
  const choice = await ask(g.count);
  if (choice === "overwrite") return { action: "write", guard: g, confirmed: true };
  if (choice === "copy") return { action: "copy", guard: g };
  return { action: "cancel", guard: g };
}

module.exports = { findIntactSignatures, checkOverwrite, guardWrite, startsWithFilePrefix };
