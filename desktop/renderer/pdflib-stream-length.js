"use strict";

// Vá pdf-lib: stream có `/Length` là THAM CHIẾU GIÁN TIẾP bị cắt cụt mất byte cuối.
//
// Triệu chứng (bắt được bằng `npm run sweep:corpus`, 10/1104 file của corpus pdf.js, trong đó
// có cả `tracemonkey.pdf` — bài báo 14 trang bình thường, file gốc SẠCH theo qpdf):
// mở ra rồi lưu lại, không sửa gì, thì qpdf kêu
//   "(offset …): input stream is complete but output may still be valid"
// và ảnh trong trang giải nén ra rác.
//
// Vì sao. `PDFObjectParser.parseDictOrStream` chỉ tin `/Length` khi nó là MỘT SỐ:
//
//     const Length = dict.get(PDFName.of('Length'));
//     if (Length instanceof PDFNumber) { ...dùng số đó... }
//     else { end = this.findEndOfStreamFallback(startPos); }   // ← `/Length 674 0 R` rơi vào đây
//
// Nhánh dự phòng dò tới từ khoá `endstream` và coi ký tự ngay trước nó là dấu xuống dòng ngăn
// cách — kể cả khi đó là **một byte dữ liệu**. `tracemonkey.pdf` có đúng ca đó: ảnh ở object
// 483 dài **1013** byte (object 674 ghi rõ 1013, qpdf đọc ra 1013), byte cuối cùng tình cờ là
// 0x0D, và nhà sản xuất file viết `endstream` ngay sau dữ liệu, KHÔNG chèn xuống dòng:
//
//     … 72 17 33 0d | 65 6e 64 73 74 72 65 61 6d       "…r\x173\r" + "endstream"
//                 ↑ byte dữ liệu thật, pdf-lib tưởng là dấu xuống dòng
//
// pdf-lib cắt còn 1012 byte ⇒ luồng deflate mất byte cuối ⇒ ảnh hỏng, và `/Length` ghi ra cũng
// là 1012. Mọi đường lưu của Nabu đều đi qua pdf-lib, nên đây là mất dữ liệu thật sự, im lặng.
//
// Bản vá. KHÔNG đụng vào nhánh dự phòng (sửa luật xuống dòng ở đó sẽ làm hỏng những file mà
// `\r` đúng là dấu ngăn cách). Thay vào đó:
//   1. khi phân tích thấy một stream có `/Length` gián tiếp → ghi nó vào danh sách chờ;
//   2. phân tích xong cả tài liệu (lúc đó object chứa độ dài CHẮC CHẮN đã có trong context,
//      kể cả khi nó nằm sau stream trong file — đây là lý do phải làm hai lượt) → với mỗi
//      stream trong danh sách, tra độ dài thật và cắt lại từ byte gốc.
//
// Mỗi lần cắt lại đều phải qua ba cửa, sai một cửa là bỏ qua, giữ nguyên hành vi cũ:
//   (a) độ dài tra được là số nguyên dương và KHÁC độ dài đang có;
//   (b) tìm lại được điểm bắt đầu của stream: byte ở đó phải khớp với phần đầu/cuối của nội
//       dung mà parser đã cắt;
//   (c) ngay sau `start + độ dài thật` phải là `endstream` (cho phép tối đa một dấu xuống dòng).
// Nghĩa là bản vá chỉ động vào đúng những file đang BỊ đọc sai, và không thể làm hỏng file
// đang đọc đúng.
//
// Dùng ở hai nơi — đây là bản duy nhất, đừng chép thêm:
//   • renderer: `<script src="pdflib-stream-length.js">` ngay sau `vendor/pdf-lib.min.js`
//     (file này tự vá global `PDFLib` khi được nạp);
//   • main: `require(...).applyStreamLengthFix(require("pdf-lib"))` — xem `src/signing-worker.js`.
// Lưới: `npm run test:streamlen` (dựng một PDF đúng ca trên, đỏ nếu gỡ bản vá) và
// `npm run sweep:corpus`.

(function (globalObj) {
  var ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"
  var CR = 0x0d;
  var LF = 0x0a;

  function applyStreamLengthFix(PDFLib) {
    if (!PDFLib) return false;
    var PDFObjectParser = PDFLib.PDFObjectParser;
    var PDFParser = PDFLib.PDFParser;
    var PDFRawStream = PDFLib.PDFRawStream;
    var PDFNumber = PDFLib.PDFNumber;
    var PDFRef = PDFLib.PDFRef;
    var PDFName = PDFLib.PDFName;
    if (!PDFObjectParser || !PDFParser || !PDFRawStream || !PDFNumber || !PDFRef || !PDFName) return false;
    if (PDFObjectParser.prototype.__nabuStreamLengthFix) return false; // vá hai lần là thừa

    var LENGTH = PDFName.of("Length");

    // --- lượt 1: ghi lại stream nào có /Length gián tiếp -------------------------------------
    var origDictOrStream = PDFObjectParser.prototype.parseDictOrStream;
    PDFObjectParser.prototype.parseDictOrStream = function () {
      var obj = origDictOrStream.call(this);
      try {
        if (obj instanceof PDFRawStream && obj.dict.get(LENGTH) instanceof PDFRef) {
          // `this.bytes.offset()` lúc này trỏ ngay SAU từ khoá `endstream` mà parser vừa khớp
          // (cả hai nhánh của parseDictOrStream đều kết thúc như vậy) — đó là mỏ neo để tìm
          // lại điểm bắt đầu ở lượt 2.
          var list = this.__nabuPendingStreams || (this.__nabuPendingStreams = []);
          list.push({ stream: obj, afterEndstream: this.bytes.offset() });
        }
      } catch (_) {
        /* không bao giờ để việc ghi chú làm hỏng việc phân tích */
      }
      return obj;
    };

    // --- lượt 2: cắt lại, sau khi cả tài liệu đã phân tích xong -------------------------------
    var origParseDocument = PDFParser.prototype.parseDocument;
    PDFParser.prototype.parseDocument = function () {
      var self = this;
      return origParseDocument.call(this).then(function (context) {
        try {
          repair(self, context);
        } catch (_) {
          /* file lạ thì thôi, giữ nguyên kết quả phân tích cũ */
        }
        return context;
      });
    };

    function repair(parser, context) {
      var pending = parser.__nabuPendingStreams;
      if (!pending || !pending.length) return 0;
      var bytes = parser.bytes;
      var fixed = 0;
      for (var i = 0; i < pending.length; i++) {
        var stream = pending[i].stream;
        var contents = stream.contents;
        if (!contents) continue;

        // (a) độ dài thật
        var lenObj = context.lookup(stream.dict.get(LENGTH));
        if (!(lenObj instanceof PDFNumber)) continue;
        var want = lenObj.asNumber();
        if (!isFinite(want) || Math.floor(want) !== want || want <= 0) continue;
        if (want === contents.length) continue;

        // (b) điểm bắt đầu
        var start = findStart(bytes, pending[i].afterEndstream, contents);
        if (start < 0) continue;
        if (start + want > byteLength(bytes)) continue;

        // (c) đúng chỗ đó phải là `endstream`
        if (!endstreamFollows(bytes, start + want)) continue;

        stream.contents = bytes.slice(start, start + want);
        fixed++;
      }
      parser.__nabuPendingStreams = null;
      return fixed;
    }

    // Mỏ neo: `after` trỏ ngay sau "endstream", nên từ khoá bắt đầu ở `after - 9`. Giữa dữ liệu
    // và từ khoá có 0, 1 hoặc 2 byte xuống dòng, nên điểm bắt đầu là một trong ba khả năng —
    // chọn khả năng mà byte ở đó khớp với nội dung parser đã cắt.
    function findStart(bytes, after, contents) {
      var kw = after - ENDSTREAM.length;
      for (var d = 0; d <= 2; d++) {
        var s = kw - d - contents.length;
        if (s < 0) continue;
        if (looksLike(bytes, s, contents)) return s;
      }
      return -1;
    }

    // So mẫu đầu và cuối là đủ: ba ứng viên chỉ lệch nhau 1–2 byte, nên phần cuối phân biệt
    // được ngay. So toàn bộ sẽ tốn O(kích thước stream) cho mọi stream — không đáng.
    function looksLike(bytes, start, contents) {
      var n = contents.length;
      var probe = Math.min(8, n);
      for (var i = 0; i < probe; i++) if (bytes.peekAt(start + i) !== contents[i]) return false;
      for (var j = 1; j <= probe; j++) if (bytes.peekAt(start + n - j) !== contents[n - j]) return false;
      return true;
    }

    function endstreamFollows(bytes, pos) {
      var p = pos;
      if (bytes.peekAt(p) === CR) p++;
      if (bytes.peekAt(p) === LF) p++;
      for (var i = 0; i < ENDSTREAM.length; i++) if (bytes.peekAt(p + i) !== ENDSTREAM[i]) return false;
      return true;
    }

    function byteLength(bytes) {
      // ByteStream không lộ độ dài; `done()` chỉ đúng ở vị trí hiện tại. Dò bằng peekAt là đủ
      // vì ta chỉ cần biết "có vượt cuối file không".
      return bytes.length != null ? bytes.length : Infinity;
    }

    PDFObjectParser.prototype.__nabuStreamLengthFix = true;
    return true;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { applyStreamLengthFix: applyStreamLengthFix };
  } else if (globalObj) {
    globalObj.PdfLibStreamLengthFix = { applyStreamLengthFix: applyStreamLengthFix };
    // Renderer: vá ngay khi nạp, trước khi bất kỳ file nào gọi PDFDocument.load.
    if (globalObj.PDFLib) applyStreamLengthFix(globalObj.PDFLib);
  }
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
