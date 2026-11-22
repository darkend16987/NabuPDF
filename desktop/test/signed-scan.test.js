"use strict";

// BI-127 — cổng "đừng lặng lẽ phá chữ ký số" (src/signed-scan.js + nối dây ở main.js).
//
// BA TẦNG, vì mỗi tầng bắt một loại lỗi khác:
//   1. FILE GIẢ tự dựng — đủ mọi biên mà file thật không cho ta chọn: hai quy ước dấu < >,
//      kim /ByteRange nằm vắt qua ranh giới hai khúc đọc, ô giữ chỗ, ruột không phải hex…
//   2. FILE KÝ THẬT từ corpus pdf.js (bỏ qua nếu máy không có corpus) — vì file giả do chính
//      ta viết nên chỉ chứng minh được ta nhất quán với chính mình. Chỗ này đã bắt một lỗi thật:
//      bản đầu chỉ nhận quy ước "< > nằm trong khoảng hở" và loại nhầm `signed_verified.pdf`.
//   3. GHIM CẤU TRÚC main.js / app.js — main không chạy được trong node, nên ghim bằng regex:
//      cả hai đường ghi tài liệu phải qua cổng, cổng phải đứng TRƯỚC lệnh ghi, và nút an toàn
//      phải là nút mặc định.
//
// Run:  node desktop/test/signed-scan.test.js      (or: npm run test:signedscan)

const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../src/signed-scan");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signed-"));
let seq = 0;
function tmpFile(buf) {
  const p = path.join(TMP, `f${seq++}.pdf`);
  fs.writeFileSync(p, buf);
  return p;
}

// ---- 1. dựng một file "đã ký" giả -----------------------------------------------------------
const pad = (n) => String(n).padStart(10, "0");
// Ba số trong /ByteRange được điền SAU, cùng độ rộng (10 chữ số) với ô giữ chỗ nên không làm xê dịch offset.
function buildSigned(o) {
  const { bracketsInside = true, hexLen = 64, lead = "", hexChar = "0", badStart = false } = o || {};
  const pre =
    lead +
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n" +
    "<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [ZZZZZZZZZZ AAAAAAAAAA CCCCCCCCCC LLLLLLLLLL] /Contents ";
  const hex = hexChar.repeat(hexLen);
  const post = " /M (D:20260101000000Z) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  const l1 = bracketsInside ? pre.length : pre.length + 1;
  const c = bracketsInside ? pre.length + hexLen + 2 : pre.length + 1 + hexLen;
  const body = pre + "<" + hex + ">" + post;
  const l2 = body.length - c;
  // [ZZZ… AAA… CCC… LLL…] = [0 L1 C L2]: Z là số ĐẦU (luôn 0 trừ ca cố tình sai), A là L1.
  const s = body
    .replace("ZZZZZZZZZZ", pad(badStart ? 5 : 0))
    .replace("AAAAAAAAAA", pad(l1))
    .replace("CCCCCCCCCC", pad(c))
    .replace("LLLLLLLLLL", pad(l2));
  return { buf: Buffer.from(s, "latin1"), l1, c, l2, size: body.length };
}

(async () => {
  // ---- 1a. nhận ra chữ ký, CẢ HAI quy ước ----------------------------------------------------
  for (const inside of [true, false]) {
    const f = buildSigned({ bracketsInside: inside });
    const r = await S.findIntactSignatures(tmpFile(f.buf));
    check(`ký giả, dấu ${inside ? "TRONG" : "NGOÀI"} khoảng hở: đếm được 1`, r.count, 1);
    check(`… và vùng ký kết thúc ở C+L2 = hết file`, r.end, f.size);
  }

  // ---- 1b. kim /ByteRange vắt qua ranh giới hai khúc đọc -------------------------------------
  // Quét mọi cỡ khúc nhỏ: mỗi cỡ đặt ranh giới ở một chỗ khác nhau của file, nên tổng cộng có
  // khúc cắt đôi chữ "/ByteRange". Đếm phải LUÔN là 1 — không sót (kim bị cắt), không đúp (đếm hai lần).
  {
    const f = buildSigned();
    const p = tmpFile(f.buf);
    const bad = [];
    for (let chunk = 32; chunk <= 200; chunk++) {
      const r = await S.findIntactSignatures(p, { chunk });
      if (r.count !== 1 || r.end !== f.size) bad.push(`${chunk}→${r.count}/${r.end}`);
    }
    check("mọi cỡ khúc 32..200: đúng 1 chữ ký, không sót không đúp", bad, []);
  }

  // ---- 1c. KHÔNG phải chữ ký: không được đếm --------------------------------------------------
  {
    const ph = Buffer.from("%PDF-1.7\n<< /ByteRange [0 ********** ********** **********] /Contents <0000> >>\n%%EOF\n", "latin1");
    check("ô giữ chỗ [0 ****…] của file đang ký dở: 0", (await S.findIntactSignatures(tmpFile(ph))).count, 0);

    const notHex = buildSigned({ hexChar: "Z" });
    check("ruột khoảng hở không phải hex: 0", (await S.findIntactSignatures(tmpFile(notHex.buf))).count, 0);

    const startsAt5 = buildSigned({ badStart: true });
    check("/ByteRange không bắt đầu từ 0: 0", (await S.findIntactSignatures(tmpFile(startsAt5.buf))).count, 0);

    const tooShort = buildSigned({ bracketsInside: false, hexLen: 2 });
    check("khoảng hở quá ngắn (<4): 0", (await S.findIntactSignatures(tmpFile(tooShort.buf))).count, 0);

    const f = buildSigned();
    const truncated = f.buf.subarray(0, f.c + 3); // vùng ký vượt quá cỡ file
    check("file bị cắt cụt (vùng ký vượt cỡ file): 0", (await S.findIntactSignatures(tmpFile(truncated))).count, 0);

    check("file không có /ByteRange: 0",
      (await S.findIntactSignatures(tmpFile(Buffer.from("%PDF-1.4\n%%EOF\n")))).count, 0);
    check("file rỗng: 0", (await S.findIntactSignatures(tmpFile(Buffer.alloc(0)))).count, 0);
  }

  // ---- 1d. checkOverwrite: bốn kết cục -------------------------------------------------------
  {
    const orig = buildSigned();
    const p = tmpFile(orig.buf);
    const rewritten = buildSigned({ lead: "%rewritten by another tool\n" }).buf; // mọi offset dịch đi
    const appended = Buffer.concat([orig.buf, Buffer.from("\n1 0 obj\n<< /Type /Catalog /Extra true >>\nendobj\n%%EOF\n")]);
    const gone = Buffer.from("%PDF-1.7\n%%EOF\n");

    check("ghi lại Y HỆT → không mất", await S.checkOverwrite(p, orig.buf), { signed: true, loss: false, count: 1 });
    check("NỐI THÊM một revision sau vùng ký → không mất (đây là tính chất mà lưu incremental sẽ tạo ra)",
      await S.checkOverwrite(p, appended), { signed: true, loss: false, count: 1 });
    check("dựng lại file (offset dịch) → MẤT", await S.checkOverwrite(p, rewritten), { signed: true, loss: true, count: 1 });
    check("bản mới ngắn hơn vùng ký → MẤT", await S.checkOverwrite(p, gone), { signed: true, loss: true, count: 1 });

    // Lệch ĐÚNG MỘT byte, và là byte CUỐI CÙNG của vùng ký — bắt lỗi so sánh thiếu một byte
    // (so `end-1` thay vì `end` vẫn qua mọi phép thử "đổi nhiều" mà chỉ hỏng ở đúng chỗ này).
    // Và ở byte ĐẦU TIÊN, để bắt lỗi so lệch về phía kia.
    for (const idx of [orig.size - 1, 0]) {
      const oneByte = Buffer.from(orig.buf);
      oneByte[idx] ^= 0x01;
      check(`lệch một byte ở vị trí ${idx === 0 ? "ĐẦU" : "CUỐI"} vùng ký → MẤT`, (await S.checkOverwrite(p, oneByte)).loss, true);
    }

    // `data` đến qua IPC là một VIEW có byteOffset ≠ 0 — không được đọc nhầm từ đầu ArrayBuffer.
    const backing = Buffer.concat([Buffer.from("RÁC-ĐỆM"), orig.buf]);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + Buffer.byteLength("RÁC-ĐỆM"), orig.buf.length);
    check("view có byteOffset ≠ 0 vẫn so đúng", (await S.checkOverwrite(p, view)).loss, false);

    // Fail-open: đường dẫn không tồn tại / là thư mục → coi như không có thông tin, KHÔNG ném.
    check("file đích chưa tồn tại → cho ghi", await S.checkOverwrite(path.join(TMP, "khong-co.pdf"), orig.buf),
      { signed: false, loss: false });
    check("đích là một thư mục → cho ghi (lệnh ghi sẽ tự báo lỗi thật)", (await S.checkOverwrite(TMP, orig.buf)).loss, false);
  }

  // ---- 1e. guardWrite: câu hỏi chỉ hiện khi CẦN, và mọi đáp án đều an toàn ---------------------
  {
    const orig = buildSigned();
    const p = tmpFile(orig.buf);
    const rewritten = buildSigned({ lead: "%x\n" }).buf;
    let asked = 0;
    const ask = (answer) => async (n) => { asked++; check("câu hỏi nhận đúng số chữ ký", n, 1); return answer; };

    const w1 = await S.guardWrite(p, orig.buf, ask("cancel"));
    check("vùng ký còn nguyên → ghi, KHÔNG hỏi", [w1.action, asked], ["write", 0]);

    const w2 = await S.guardWrite(tmpFile(Buffer.from("%PDF-1.4\n%%EOF\n")), rewritten, ask("cancel"));
    check("file đích không ký → ghi, KHÔNG hỏi", [w2.action, asked], ["write", 0]);

    check("mất chữ ký + 'overwrite' → ghi", (await S.guardWrite(p, rewritten, ask("overwrite"))).action, "write");
    check("mất chữ ký + 'copy' → không ghi, đi chỗ khác", (await S.guardWrite(p, rewritten, ask("copy"))).action, "copy");
    check("mất chữ ký + 'cancel' → huỷ", (await S.guardWrite(p, rewritten, ask("cancel"))).action, "cancel");
    check("đã hỏi đúng 3 lần", asked, 3);
    // Câu trả lời lạ (nút hỏng, undefined, null, chuỗi bậy) KHÔNG ĐƯỢC thành ghi đè.
    for (const weird of [undefined, null, "", "yes", "OVERWRITE", 0, 1, {}]) {
      const r = await S.guardWrite(p, rewritten, async () => weird);
      check(`đáp án lạ ${JSON.stringify(weird)} → huỷ, không ghi đè`, r.action, "cancel");
    }
    // `ask` ném lỗi ⇒ lỗi nổi lên cho main.js bắt (askSignedOverwrite có try/catch riêng → "cancel").
    let threw = false;
    try { await S.guardWrite(p, rewritten, async () => { throw new Error("x"); }); } catch (_) { threw = true; }
    check("ask ném lỗi → nổi lên chứ không ngầm ghi", threw, true);
  }

  // ---- 2. FILE KÝ THẬT từ corpus pdf.js ------------------------------------------------------
  const CORPUS = "D:/GitHub/_refs/pdfjs-corpus/test/pdfs";
  const lib = require("../renderer/vendor/pdf-lib.min.js");
  if (!fs.existsSync(CORPUS)) {
    console.log("(bỏ qua tầng 2: không có corpus ở " + CORPUS + ")");
  } else {
    // 9 file chứa chữ /ByteRange; 6 là chữ ký còn nguyên, 3 đã vỡ sẵn (đã soi từng cái: offset trỏ
    // vào giữa chuỗi hex / vào chữ thường vì file bị công cụ khác dựng lại hoặc bị fuzz).
    const REAL = ["160F-2019", "bug854315", "issue16553", "issue17069", "prefilled_f1040", "signed_verified"];
    const BROKEN = ["issue6127", "xfa_filled_imm1344e", "poppler-395-0-fuzzed"];
    for (const n of REAL) {
      const r = await S.findIntactSignatures(path.join(CORPUS, n + ".pdf"));
      check(`corpus ${n}: là chữ ký THẬT, đếm được ≥ 1`, r.count >= 1, true);
    }
    for (const n of BROKEN) {
      const r = await S.findIntactSignatures(path.join(CORPUS, n + ".pdf"));
      check(`corpus ${n}: chữ ký đã vỡ sẵn, KHÔNG được đếm`, r.count, 0);
    }

    // Kịch bản thật của người dùng: mở file đã ký → xoay trang 1 → Ctrl+S. pdf-lib dựng lại file.
    // (signed_verified: file nhỏ, mở được, dùng quy ước "ngoài".)
    const target = path.join(CORPUS, "signed_verified.pdf");
    const orig = fs.readFileSync(target);
    const doc = await lib.PDFDocument.load(orig);
    const p0 = doc.getPages()[0];
    p0.setRotation(lib.degrees((p0.getRotation().angle + 90) % 360));
    const rewritten = await doc.save();
    check("corpus signed_verified + pdf-lib xoay trang + lưu → MẤT chữ ký",
      (await S.checkOverwrite(target, rewritten)).loss, true);
    check("corpus signed_verified + bản y hệt → không mất", (await S.checkOverwrite(target, orig)).loss, false);
    check("corpus signed_verified + nối thêm revision → không mất",
      (await S.checkOverwrite(target, Buffer.concat([orig, Buffer.from("\n%%EOF\n")]))).loss, false);
  }

  // ---- 3. GHIM CẤU TRÚC main.js / app.js -----------------------------------------------------
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const APP = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  const block = (src, marker) => {
    const at = src.indexOf(marker);
    if (at < 0) return "";
    const next = src.indexOf("\nipcMain.handle(", at + marker.length);
    return src.slice(at, next < 0 ? undefined : next);
  };
  const SAVE = block(MAIN, 'ipcMain.handle("dialog:save-pdf"');
  const WRITE = block(MAIN, 'ipcMain.handle("file:write-pdf"');
  check("main.js còn handler dialog:save-pdf", SAVE.length > 0, true);
  check("main.js còn handler file:write-pdf", WRITE.length > 0, true);
  for (const [tag, src] of [["dialog:save-pdf", SAVE], ["file:write-pdf", WRITE]]) {
    // BI-130: file:write-pdf đi qua SignedSave.planSignedWrite (gói cùng cổng BI-127 + đường nối); phần chạy
    // thật của nó được test ở signed-save.test.js. dialog:save-pdf vẫn gọi thẳng guardWrite.
    const gateCall = tag === "file:write-pdf" ? "SignedSave.planSignedWrite(" : "SignedScan.guardWrite(";
    const gateAt = src.indexOf(gateCall);
    const writeAt = src.indexOf("fs.promises.writeFile(");
    check(`${tag}: có gọi cổng (${gateCall})`, gateAt >= 0, true);
    check(`${tag}: cổng đứng TRƯỚC lệnh ghi`, gateAt >= 0 && writeAt > gateAt, true);
    check(`${tag}: có nhánh "cancel" không ghi`, /action === "cancel"/.test(src), true);
    // Chỉ "gọi cổng trước lệnh ghi" là CHƯA ĐỦ: đột biến thử (ghi rồi mới xét câu trả lời) vẫn qua
    // phép kiểm đó trong khi người dùng bấm Huỷ mà file vẫn bị ghi đè. Lệnh ghi phải nằm SAU CẢ HAI
    // nhánh rẽ — tức là chỉ chạy được khi cả "cancel" lẫn "copy" đã bị loại.
    const lastBranch = Math.max(src.indexOf('action === "cancel"'), src.indexOf('action === "copy"'));
    check(`${tag}: lệnh ghi nằm SAU cả hai nhánh cancel/copy`, lastBranch > 0 && writeAt > lastBranch, true);
  }
  check("dialog:save-pdf: 'copy' quay lại hộp Lưu thành (continue)", /action === "copy"\) continue/.test(SAVE), true);
  check("file:write-pdf: 'cancel' trả canceled:true", /canceled: true/.test(WRITE), true);

  // Nút an toàn là mặc định, và thứ tự nút khớp bảng ánh xạ — đổi một trong hai mà không đổi cái
  // kia là biến "Enter" hoặc "Esc" thành ghi đè.
  const ASK = block(MAIN, "async function askSignedOverwrite");
  check("hộp hỏi: defaultId = 0 (nút an toàn)", /defaultId: 0/.test(ASK), true);
  // BI-130: nút có thể là 3 hoặc 4 (thêm "Lưu nối thêm"), nên ánh xạ chỉ số → hành động đi qua MỘT mảng khoá
  // `keys` dùng cho CẢ buttons LẪN kết quả; Huỷ luôn là phần tử CUỐI. Chạy thật từng nút: signed-save.test.js §3a.
  check("hộp hỏi: cancelId = nút CUỐI (Huỷ)", /cancelId: keys\.length - 1/.test(ASK), true);
  check("hộp hỏi: hai bảng khoá, Huỷ cuối, KHÔNG có nút nối thì nút đầu là 'copy' (không phải 'ghi đè')",
    /canAppend \? \["append", "copy", "overwrite", "cancel"\] : \["copy", "overwrite", "cancel"\]/.test(ASK), true);
  check("hộp hỏi: kết quả = keys[res.response] || 'cancel' (nút lạ ⇒ huỷ)", /keys\[res\.response\] \|\| "cancel"/.test(ASK), true);
  check("hộp hỏi: buttons sinh từ CÙNG mảng keys", /buttons: keys\.map\(/.test(ASK), true);
  check("hộp hỏi: nhãn 'ghi đè' đúng chỗ của nó", /overwrite: en \? "Overwrite anyway" : "Vẫn ghi đè"/.test(ASK), true);
  check("hộp hỏi: lỗi hộp thoại ⇒ cancel", /catch \(_\) \{\s*return "cancel";/.test(ASK), true);

  // Renderer: Huỷ phải dừng hẳn, không rơi sang hộp Lưu thành.
  const saveDocAt = APP.indexOf("async function saveDoc");
  const saveDocBody = APP.slice(saveDocAt, APP.indexOf("async function saveAsDoc"));
  check("renderer còn saveDoc", saveDocAt >= 0, true);
  check("saveDoc: res.canceled dừng hẳn, trước khi rơi xuống saveAsDoc",
    saveDocBody.indexOf("if (res.canceled) return;") > 0 &&
      saveDocBody.indexOf("if (res.canceled) return;") < saveDocBody.indexOf("await saveAsDoc()"), true);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(2);
});
