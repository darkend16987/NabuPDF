"use strict";

/**
 * BI-133 — KÝ NỐI THÊM: thêm chữ ký thứ N vào một tài liệu đã có chữ ký mà KHÔNG làm mất N-1 chữ ký trước.
 *
 * Vì sao cần. Đường ký cũ (signing-worker.applySignature) mở file bằng pdf-lib rồi lưu lại TOÀN BỘ ⇒ chữ ký trước mất
 * (đã đo, BI-131). Ký nhiều bên đúng nghĩa = mỗi người NỐI một revision vào cuối file; byte cũ không đổi nên chữ ký cũ còn đúng
 * về mặt toán học (đã chứng minh bằng OpenSSL: file ra có CẢ HAI chữ ký hợp lệ).
 *
 * Cách làm — tái dùng thứ đã được kiểm chứng thay vì viết một bộ dựng PDF thứ hai:
 *   1. `prepare`: dựng "bản đã thêm chỗ giữ chữ ký" bằng ĐÚNG đường hiện tại (pdf-lib + pdflibAddPlaceholder). Hai chỉnh sửa:
 *        · ô /Contents là hex '0' THẬT (thư viện viết NUL — lõi PyMuPDF đọc ra chuỗi rỗng và làm mất chỗ);
 *        · tên trường duy nhất (thư viện cứng "Signature1" ⇒ trùng trường của chữ ký trước).
 *   2. `append`: đưa (file gốc, bản vừa dựng) qua lõi ghi nối BI-128/129 ⇒ file gốc + MỘT revision chứa trường/widget/chữ ký mới.
 *      Lõi tự kiểm (fail-closed, mở lại kết quả, so từng object) nên ta không viết lại chuyện đó ở đây.
 *   3. Ở đây: tìm chỗ giữ chữ ký trong revision mới, điền /ByteRange, băm vùng ngoài ô /Contents, ký, ghép chữ ký vào ô.
 *
 * FAIL-CLOSED. Mọi điều không rõ ⇒ trả {ok:false, reason} và KHÔNG tạo file; người gọi quay về hộp hỏi (Vẫn ký / Huỷ). Các
 * rào cản chính: tài liệu CHỨNG NHẬN không cho sửa (/DocMDP /P 1) ⇒ từ chối; kết quả của lõi không bắt đầu bằng ĐÚNG byte đầu vào ⇒
 * từ chối; không tìm thấy chỗ giữ chữ ký MỚI ở phần nối ⇒ từ chối; chữ ký không vừa ô ⇒ từ chối.
 *
 * Thuần: không require electron/pdf-lib; `prepare`, `append`, `signer` được tiêm nên test chạy được trong node.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const SignedScan = require("./signed-scan");
const SigText = require("./sig-text"); // BI-134

const PH = "/**********"; // 11 byte: thư viện @signpdf giữ chỗ ba số của /ByteRange bằng ba TÊN này
const PH_LEN = PH.length;
const NEEDLE = Buffer.from("/ByteRange");
const BR_PLACEHOLDER = /^\/ByteRange\s*\[\s*0\s*(\/\*{10})\s*(\/\*{10})\s*(\/\*{10})\s*\]/;
const CONTENTS_ZEROS = /\/Contents\s*<(0+)>/;
const PROBE = 200;

// Lý do (người gọi ánh xạ sang câu tiếng Việt). Của lõi ghi nối (REASONS ở incremental.py) đi qua nguyên vẹn dưới `reason`.
const REASONS = [
  "not_signed",
  "docmdp_locked",
  "prepare_failed",
  "prefix_changed",
  "placeholder_missing",
  "signature_too_large",
  "bad_signature",
  "sign_failed",
];

/**
 * Cấp độ DocMDP (chứng nhận tài liệu) của các byte: 0 = không có; 1 = KHÔNG cho sửa gì; 2 = cho điền form + ký;
 * 3 = thêm cả chú thích. Đọc dạng thô: /TransformMethod /DocMDP … /P n (chữ ký chứng nhận luôn là object cấp cao,
 * không nằm trong object stream). Thiếu /P ⇒ mặc định 2 (đặc tả PDF 32000 §12.8.2.2). Trả mức NGHIÊM nhất tìm thấy.
 */
function docMdpLevel(data) {
  const buf = asBuffer(data);
  const key = Buffer.from("/DocMDP");
  let level = 0;
  for (let i = buf.indexOf(key); i !== -1; i = buf.indexOf(key, i + 1)) {
    const before = buf.toString("latin1", Math.max(0, i - 24), i);
    if (!/\/TransformMethod\s*$/.test(before)) continue; // `/Perms << /DocMDP 5 0 R >>` không phải chỗ khai mức
    const after = buf.toString("latin1", i + key.length, Math.min(buf.length, i + key.length + 400));
    const m = /\/P\s*([123])(?![0-9A-Za-z])/.exec(after);
    const p = m ? Number(m[1]) : 2;
    level = level === 0 ? p : Math.min(level, p);
  }
  return level;
}

function asBuffer(data) {
  return ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
}

/**
 * Tìm chỗ giữ chữ ký ĐÃ-GIỮ-CHỖ cuối cùng của `buf` (chữ ký mới nằm ở revision cuối). Trả
 * `{ brStart, brEnd, ltPos, gtEnd, capacityHex }` hoặc null:
 *   brStart..brEnd — đoạn /ByteRange mà ba số còn là ba TÊN giữ chỗ (mỗi tên = dấu "/" + 10 dấu sao; chữ ký cũ có số thật nên không khớp);
 *   ltPos, gtEnd   — vị trí '<' và vị trí NGAY SAU '>' của ô /Contents cùng object; capacityHex = số chữ số hex chứa được.
 * Tìm ngược từ cuối file: chữ ký mới nằm gần cuối, và file có thể vài trăm MB.
 */
function locatePlaceholder(buf) {
  for (let i = buf.lastIndexOf(NEEDLE); i !== -1; i = i === 0 ? -1 : buf.lastIndexOf(NEEDLE, i - 1)) {
    const probe = buf.toString("latin1", i, Math.min(buf.length, i + PROBE));
    const m = BR_PLACEHOLDER.exec(probe);
    if (!m) continue;
    const brEnd = i + m[0].length;
    const objStart = buf.lastIndexOf(" obj", i);
    const objEndAt = buf.indexOf("endobj", brEnd);
    if (objStart < 0 || objEndAt < 0) continue;
    const seg = buf.toString("latin1", objStart, objEndAt);
    const cm = CONTENTS_ZEROS.exec(seg);
    if (!cm) continue;
    const ltPos = objStart + cm.index + cm[0].indexOf("<");
    const gtEnd = objStart + cm.index + cm[0].length;
    return { brStart: i, brEnd, ltPos, gtEnd, capacityHex: cm[1].length };
  }
  return null;
}

/** Điền ba số thật vào /ByteRange (tại chỗ, KHÔNG đổi độ dài file). Trả { L1, C, L2 }. */
function fillByteRange(buf, loc) {
  const L1 = loc.ltPos;
  const C = loc.gtEnd;
  const L2 = buf.length - C;
  const fit = (v) => {
    const s = " " + String(v); // dấu cách đầu thay cho "/" làm dấu phân cách
    if (s.length > PH_LEN) throw new Error("ByteRange quá lớn: " + v);
    return s.padEnd(PH_LEN, " ");
  };
  const text = buf.toString("latin1", loc.brStart, loc.brEnd);
  const m = BR_PLACEHOLDER.exec(text);
  if (!m) throw new Error("mất chỗ giữ ByteRange");
  const out = text.replace(m[1], () => fit(L1)).replace(m[2], () => fit(C)).replace(m[3], () => fit(L2));
  if (out.length !== text.length) throw new Error("điền ByteRange làm đổi độ dài");
  buf.write(out, loc.brStart, "latin1");
  return { L1, C, L2 };
}

/** Các byte được KÝ: mọi thứ trừ ô /Contents. */
function dataToSign(buf, range) {
  return Buffer.concat([buf.subarray(0, range.L1), buf.subarray(range.C)]);
}

/** Ghép chữ ký (DER) vào ô /Contents, đệm '0' cho đủ độ dài. Trả false nếu không vừa. */
function spliceSignature(buf, loc, der) {
  const hex = Buffer.from(der).toString("hex");
  if (hex.length > loc.capacityHex) return false;
  buf.write(hex.padEnd(loc.capacityHex, "0"), loc.ltPos + 1, "latin1");
  return true;
}

/**
 * Dựng hàm `prepare` bằng các thư viện được tiêm vào (worker truyền bản thật; test cũng vậy):
 *   libs = { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFInvalidObject, pdflibAddPlaceholder, subFilter }
 * `hooks.beforePlaceholder(doc, page)` — kiểm tra trước khi dựng (ném lỗi có `.reason` để từ chối);
 * `hooks.afterWidget(doc, widget, widgetRef)` — chỗ để worker gắn hình hiển thị (AP) cho chữ ký nhìn thấy.
 * Trả `async (bytes, meta) => Uint8Array` (bản đã thêm chỗ giữ chữ ký, lưu KHÔNG object stream).
 */
function makePrepare(libs, hooks = {}) {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFInvalidObject, pdflibAddPlaceholder, subFilter } = libs;
  // libs cũng phải có PDFHexString (BI-134: chữ có dấu trong từ điển chữ ký)
  return async function prepare(bytes, meta = {}) {
    const doc = await PDFDocument.load(bytes);
    // Tên trường đã dùng (chữ ký trước + form) để chọn tên duy nhất.
    const used = new Set();
    const acro0 = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    if (acro0) {
      const f0 = acro0.lookupMaybe(PDFName.of("Fields"), PDFArray);
      if (f0) {
        for (let i = 0; i < f0.size(); i++) {
          const fd = doc.context.lookup(f0.get(i));
          if (fd instanceof PDFDict) {
            const t = fd.lookup(PDFName.of("T"));
            if (t && typeof t.decodeText === "function") used.add(t.decodeText());
          }
        }
      }
    }
    const pages = doc.getPages();
    const pageIndex = Math.max(0, Math.min(pages.length - 1, (meta.pageIndex | 0) || 0));
    if (hooks.beforePlaceholder) await hooks.beforePlaceholder(doc, pages[pageIndex]);
    pdflibAddPlaceholder({
      pdfDoc: doc,
      pdfPage: pages[pageIndex],
      // BI-134: gọi thư viện với chuỗi RỖNG, điền giá trị đúng sau đó (PDFString.of của thư viện cắt Unicode về 1 byte).
      reason: "",
      contactInfo: "",
      name: "",
      location: "",
      signatureLength: meta.signatureLength || 16384,
      subFilter,
      widgetRect: meta.widgetRect || [0, 0, 0, 0],
      appName: meta.appName || "Nabu PDF",
    });
    const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    const fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
    const widgetRef = fields.get(fields.size() - 1);
    const widget = doc.context.lookup(widgetRef);
    let n = 1;
    while (used.has("Signature" + n)) n++;
    widget.set(PDFName.of("T"), PDFString.of("Signature" + n));
    // ô /Contents: NUL → '0' (thư viện registers PDFInvalidObject với các byte NUL; lõi PyMuPDF sẽ đọc thành chuỗi rỗng)
    const sigRef = widget.get(PDFName.of("V"));
    SigText.fixSignatureStrings(doc.context, sigRef, { reason: meta.reason, contactInfo: meta.contactInfo, name: meta.name, location: meta.location }, libs);
    const inv = doc.context.lookup(sigRef); // đọc SAU khi điền chữ: object đã được thay
    const fixed = Uint8Array.from(inv.data, (b) => (b === 0 ? 0x30 : b));
    doc.context.assign(sigRef, PDFInvalidObject.of(fixed));
    if (hooks.afterWidget) await hooks.afterWidget(doc, widget, widgetRef);
    return doc.save({ useObjectStreams: false });
  };
}

/**
 * Điều phối. Tham số:
 *   bytes   — tài liệu ĐANG ký (phải còn nguyên chữ ký trước: chính là các byte nguyên từ đĩa)
 *   meta    — truyền cho prepare (lý do/nơi ký, vị trí…)
 *   prepare — như trên            ·   append(originalPath, edited) ⇒ {ok, bytes} | {ok:false, reason, detail}
 *   signer  — { sign(buffer) ⇒ Promise<DER> } (token USB qua helper ở app; OpenSSL ở test)
 *   tmpDir  — thư mục tạm (mặc định os.tmpdir())
 * Trả { ok:true, bytes, appended:true, signatures } | { ok:false, reason, detail?, error? }.
 * `reason` của lỗi từ `signer.sign` (cancelled/no_cert/tsa/…) đi qua nguyên vẹn để renderer giải thích.
 */
async function appendSign({ bytes, meta, prepare, append, signer, tmpDir }) {
  const base = asBuffer(bytes);
  const before = SignedScan.findSignaturesInBuffer(base);
  if (!before.count) return { ok: false, reason: "not_signed" };
  const level = docMdpLevel(base);
  if (level === 1) {
    return { ok: false, reason: "docmdp_locked", detail: "Tài liệu được chứng nhận không cho phép thay đổi (DocMDP P=1)." };
  }

  let edited;
  try {
    edited = await prepare(base, meta);
  } catch (e) {
    // Một hook có thể gắn `reason` riêng (ví dụ "rotated": trang xoay chưa hỗ trợ chữ ký nhìn thấy); không thì prepare_failed.
    return { ok: false, reason: (e && typeof e.reason === "string" && e.reason) || "prepare_failed", detail: String((e && e.message) || e) };
  }

  // Lõi ghi nối chỉ ĐỌC file gốc từ đường dẫn: đưa các byte đang ký ra một file tạm (không phụ thuộc đĩa/đã sửa hay chưa).
  const dir = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), "nabu-signappend-"));
  let merged;
  try {
    const tmpPdf = path.join(dir, "base.pdf");
    fs.writeFileSync(tmpPdf, base);
    const r = await append(tmpPdf, edited);
    if (!r || !r.ok || !r.bytes) {
      return { ok: false, reason: (r && r.reason) || "worker_failed", detail: (r && r.detail) || "" };
    }
    merged = Buffer.from(r.bytes); // bản của riêng ta — sẽ bị sửa tại chỗ
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 1) kết quả phải bắt đầu bằng ĐÚNG các byte đầu vào: chữ ký trước còn nguyên
  if (merged.length <= base.length || Buffer.compare(merged.subarray(0, base.length), base) !== 0) {
    return { ok: false, reason: "prefix_changed" };
  }
  // 2) chỗ giữ chữ ký MỚI phải nằm ở phần nối (không phải ở đâu đó trong byte cũ)
  const loc = locatePlaceholder(merged);
  if (!loc || loc.brStart < base.length) return { ok: false, reason: "placeholder_missing" };

  let range;
  try {
    range = fillByteRange(merged, loc);
  } catch (e) {
    return { ok: false, reason: "placeholder_missing", detail: String((e && e.message) || e) };
  }
  let der;
  try {
    der = await signer.sign(dataToSign(merged, range));
  } catch (e) {
    return { ok: false, reason: (e && e.reason) || "sign_failed", error: String((e && e.message) || e) };
  }
  if (!der || !der.length) return { ok: false, reason: "bad_signature" };
  if (!spliceSignature(merged, loc, der)) return { ok: false, reason: "signature_too_large" };

  // 3) kiểm lại lần cuối, trên chính byte sẽ giao: còn nguyên byte cũ VÀ nhận ra được chữ ký mới
  const after = SignedScan.findSignaturesInBuffer(merged);
  if (Buffer.compare(merged.subarray(0, base.length), base) !== 0 || after.count !== before.count + 1) {
    return { ok: false, reason: "bad_signature", detail: `chữ ký ${before.count} → ${after.count}` };
  }
  return { ok: true, bytes: merged, appended: true, signatures: after.count };
}

// Lý do xảy ra Ở/SAU bước ký (hộp PIN đã hiện, hoặc kết quả đã qua tay token): KHÔNG phải lỗi ghi nối, nên người gọi báo thẳng
// cho người dùng thay vì lùi về hộp "Vẫn ký" (sẽ hỏi PIN lần nữa). Mọi lý do khác (của lõi ghi nối, của bước dựng) xảy ra TRƯỚC PIN.
const SIGN_STAGE_REASONS = ["cancelled", "no_cert", "tsa", "other", "sign_failed", "bad_signature", "signature_too_large", "declined"];

module.exports = {
  appendSign,
  SIGN_STAGE_REASONS,
  makePrepare,
  locatePlaceholder,
  fillByteRange,
  dataToSign,
  spliceSignature,
  docMdpLevel,
  REASONS,
};
