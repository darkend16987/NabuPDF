"use strict";

/**
 * BI-134 — chữ có dấu trong từ điển chữ ký (Reason / Name / Location / ContactInfo).
 *
 * LỖI CÓ TỪ TRƯỚC (cả đường ký cổ điển lẫn ký nối thêm). `@signpdf/placeholder-pdf-lib` ghi bốn trường này bằng
 * `PDFString.of(text)`, hàm CẮT mỗi ký tự Unicode về 1 byte (đã đo: "Đồng ý Hà Nội" → các byte 10 D3 6E 67 20 FD …). Kết quả: lý do/nơi
 * ký có dấu tiếng Việt hiện sai trong bảng chữ ký của trình đọc. (Hình hiển thị của chữ ký là PNG nên không ảnh hưởng.)
 *
 * Cách sửa: gọi thư viện với chuỗi RỖNG (ra `/Reason ()` …) rồi điền giá trị đúng vào chính các chỗ trống đó, trong các byte thô của
 * object chữ ký (thư viện đăng ký nó dưới dạng PDFInvalidObject để pdf-lib không gói vào object stream). Chữ chỉ gồm ký tự an toàn
 * ghi dạng chuỗi thường; mọi thứ khác ghi dạng chuỗi hex UTF-16BE có BOM (`<FEFF…>`, kiểu "text string" của PDF) — đúng với MỌI ký tự,
 * kể cả ngoặc, gạch chéo ngược, dấu tiếng Việt, và ký tự ngoài BMP.
 *
 * Thuần: pdf-lib được tiêm vào (`libs.PDFHexString`, `libs.PDFInvalidObject`), nên test chạy được trong node.
 */

const SAFE = /^[A-Za-z0-9 .,;:_\-\/@+]*$/; // không cần thoát ký tự nào trong chuỗi thường của PDF
const KEYS = ["Reason", "ContactInfo", "Name", "Location"];

/** Một giá trị chuỗi PDF cho `text`. Rỗng ⇒ "()". */
function encodeText(text, libs) {
  const t = String(text == null ? "" : text);
  if (SAFE.test(t)) return "(" + t + ")";
  return libs.PDFHexString.fromText(t).toString();
}

/**
 * Điền bốn trường vào object chữ ký `sigRef` (đã được thư viện dựng với chuỗi rỗng). `texts` = { reason, contactInfo, name, location }.
 * Trường nào rỗng thì giữ "()". Trả true nếu đã ghi lại object. KHÔNG ném lỗi: không đọc được object ⇒ trả false, chữ ký vẫn đúng
 * (chỉ thiếu chữ) — metadata không bao giờ được làm hỏng việc ký.
 */
function fixSignatureStrings(context, sigRef, texts, libs) {
  try {
    const inv = context.lookup(sigRef);
    const data = inv && inv.data;
    if (!(data instanceof Uint8Array)) return false;
    let s = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
    const want = { Reason: texts.reason, ContactInfo: texts.contactInfo, Name: texts.name, Location: texts.location };
    let changed = false;
    for (const key of KEYS) {
      const v = want[key];
      if (!v) continue;
      // CHỈ chỗ trống "/Key ()" ở mức cao nhất của từ điển. "/Name (Nabu PDF)" của /Prop_Build không rỗng nên không khớp,
      // còn "/Name /Adobe.PPKLite" là một TÊN (không phải chuỗi).
      const re = new RegExp("/" + key + "\\s*\\(\\)");
      if (!re.test(s)) continue;
      s = s.replace(re, () => "/" + key + " " + encodeText(v, libs));
      changed = true;
    }
    if (!changed) return false;
    context.assign(sigRef, libs.PDFInvalidObject.of(Buffer.from(s, "latin1")));
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { encodeText, fixSignatureStrings, SAFE };
