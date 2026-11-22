"use strict";

// BI-132 — cảnh báo trước khi KÝ lên tài liệu đã có chữ ký (signing.js · declineIfSigned, signed-scan.js ·
// findSignaturesInBuffer, main.js · askSignOverSigned, renderer/sign.js · "declined").
//
// BỐN TẦNG:
//   1. findSignaturesInBuffer ≡ findIntactSignatures — hai bản (bộ nhớ / đĩa) phải cho CÙNG đáp án trên cùng một file, cả
//      trên file giả tự dựng (mọi biên) lẫn trên corpus pdf.js thật (nếu máy có). Hai bản dùng luật trùng nhau nên dễ trôi lệch.
//   2. declineIfSigned + handler `sign:apply` cắt NGUYÊN VĂN từ signing.js rồi chạy: chỉ "sign" mới đi tiếp, mọi giá trị khác
//      và mọi lỗi ⇒ KHÔNG ký, worker không bị gọi (⇒ hộp PIN của token không hiện).
//   3. askSignOverSigned cắt nguyên văn từ main.js: nút đầu và Esc đều là Huỷ; nút lạ ⇒ Huỷ.
//   4. Ghim cấu trúc: main tiêm cổng; cổng đứng TRƯỚC worker; renderer coi "declined" là huỷ chứ không phải lỗi.
//
// Run:  node desktop/test/signing-warn.test.js      (or: npm run test:signingwarn)

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
function ok(name, cond, extra) {
  check(name, !!cond, true);
  if (!cond && extra) console.error("  " + extra);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signwarn-"));
let seq = 0;
function tmpFile(buf) {
  const p = path.join(TMP, `f${seq++}.pdf`);
  fs.writeFileSync(p, buf);
  return p;
}

// Cùng cách dựng với signed-scan.test.js (mỗi test tự đứng một mình).
const pad = (n) => String(n).padStart(10, "0");
function buildSigned(o) {
  const { bracketsInside = true, hexLen = 64, lead = "", hexChar = "0", badStart = false, tail = "" } = o || {};
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
  const s = body
    .replace("ZZZZZZZZZZ", pad(badStart ? 5 : 0))
    .replace("AAAAAAAAAA", pad(l1))
    .replace("CCCCCCCCCC", pad(c))
    .replace("LLLLLLLLLL", pad(l2));
  return Buffer.from(s + tail, "latin1");
}

(async () => {
  // ---- 1. hai bản cho cùng đáp án ----------------------------------------------------------------
  const fixtures = [
    ["ký giả, dấu TRONG", buildSigned()],
    ["ký giả, dấu NGOÀI", buildSigned({ bracketsInside: false })],
    ["ký giả, ô /Contents hex chữ hoa/thường lẫn", buildSigned({ hexChar: "aB" })],
    ["ký giả có đệm đầu (dịch offset)", buildSigned({ lead: "%junk\n".repeat(30) })],
    ["ký giả có phần nối SAU vùng ký", buildSigned({ tail: "\n%% revision sau\n" })],
    ["ô giữ chỗ chưa ký (không phải số)", Buffer.from("%PDF-1.7\n<< /ByteRange [0 ********** ********** **********] /Contents <0000> >>\n%%EOF\n", "latin1")],
    ["ruột /Contents không phải hex", buildSigned({ hexChar: "z" })],
    ["ô /Contents rộng hơn 1 MiB (không phải chữ ký thật)", buildSigned({ hexLen: 1_100_000 })],
    ["ô /Contents vừa dưới 1 MiB (vẫn là chữ ký)", buildSigned({ hexLen: 1_000_000 })],
    ["số đầu ByteRange khác 0", buildSigned({ badStart: true })],
    ["không có chữ ký", Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n")],
    ["file rỗng", Buffer.alloc(0)],
    ["cụt giữa chữ /ByteRange", Buffer.from("%PDF-1.7\n/ByteRan")],
  ];
  // cắt cụt chính file ký ở nhiều chỗ (ByteRange còn nhưng c+l2 > size ⇒ không được tính)
  const full = buildSigned();
  for (const cut of [10, 100, 160, 200, full.length - 5]) fixtures.push([`file ký bị cắt cụt ở ${cut}`, full.subarray(0, cut)]);

  for (const [name, buf] of fixtures) {
    const a = await S.findIntactSignatures(tmpFile(buf));
    const b = S.findSignaturesInBuffer(buf);
    check(`1a ${name}: bản bộ nhớ ≡ bản đĩa (count, end, size)`, [b.count, b.end, b.size], [a.count, a.end, a.size]);
  }
  check("1a file ký giả: đếm được 1", S.findSignaturesInBuffer(buildSigned()).count, 1);
  check("1a ô rộng hơn 1 MiB: KHÔNG tính (cả hai bản đều 0)", [S.findSignaturesInBuffer(buildSigned({ hexLen: 1_100_000 })).count, (await S.findIntactSignatures(tmpFile(buildSigned({ hexLen: 1_100_000 })))).count], [0, 0]);
  check("1a ô vừa dưới 1 MiB: tính (cả hai bản đều 1)", [S.findSignaturesInBuffer(buildSigned({ hexLen: 1_000_000 })).count, (await S.findIntactSignatures(tmpFile(buildSigned({ hexLen: 1_000_000 })))).count], [1, 1]);
  check("1a không ký: 0", S.findSignaturesInBuffer(Buffer.from("%PDF-1.4\n%%EOF\n")).count, 0);

  // 1b. đầu vào lạ không ném
  for (const [name, v] of [["null", null], ["undefined", undefined], ["chuỗi", "abc"], ["số", 42], ["mảng số", [1, 2, 3]], ["object", {}]]) {
    let r;
    let threw = false;
    try { r = S.findSignaturesInBuffer(v); } catch (_) { threw = true; }
    check(`1b đầu vào ${name}: không ném, count 0 (trừ chuỗi/mảng đã chuyển được)`, [threw, r && r.count], [false, 0]);
  }
  {
    // Uint8Array là VIEW có byteOffset (đúng dạng IPC trả): chỉ nhìn đúng đoạn view
    const f = buildSigned();
    const big = Buffer.concat([Buffer.alloc(37, 0x20), f, Buffer.alloc(11, 0x20)]);
    const view = new Uint8Array(big.buffer, big.byteOffset + 37, f.length);
    check("1b view có byteOffset: đếm đúng", S.findSignaturesInBuffer(view).count, 1);
    check("1b … và size = độ dài view", S.findSignaturesInBuffer(view).size, f.length);
  }

  // 1c. corpus thật (bỏ qua nếu máy không có)
  const CORPUS = "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
  if (fs.existsSync(CORPUS)) {
    let n = 0;
    let diff = [];
    let withSig = 0;
    for (const f of fs.readdirSync(CORPUS)) {
      if (!f.toLowerCase().endsWith(".pdf")) continue;
      const p = path.join(CORPUS, f);
      let buf;
      try { buf = fs.readFileSync(p); } catch (_) { continue; }
      if (!buf.includes("/ByteRange")) continue;
      n++;
      const a = await S.findIntactSignatures(p);
      const b = S.findSignaturesInBuffer(buf);
      if (a.count) withSig++;
      if (a.count !== b.count || a.end !== b.end) diff.push([f, a.count, b.count, a.end, b.end]);
    }
    ok(`1c corpus: ${n} file có chữ /ByteRange, hai bản khớp trên cả ${n}`, n >= 5 && diff.length === 0, JSON.stringify(diff));
    ok(`1c corpus: có file được nhận là đã ký (${withSig})`, withSig >= 1);
  } else {
    console.log("(bỏ qua 1c: không có corpus pdf.js)");
  }

  // ---- 2. declineIfSigned + handler, cắt nguyên văn từ signing.js -----------------------------------
  const rd = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n"); // cây làm việc là CRLF
  const SIGNING = rd("src", "signing.js");
  const cut = (src, from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from);
    return src.slice(a, b);
  };
  const declineSrc = cut(SIGNING, "async function declineIfSigned(", "function initSigning(");
  const handlerSrc = cut(SIGNING, 'ipcMain.handle("sign:apply"', "\n}\n\nmodule.exports");

  const decline = new Function("SignedScan", declineSrc + "\nreturn declineIfSigned;")(S);
  const SIGNED = buildSigned();
  const UNSIGNED = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n");
  const DECLINED = { ok: false, reason: "declined", error: "Đã huỷ ký — tài liệu đã có chữ ký." };
  const mkDeps = (answer, calls) => ({
    confirmSignOverSigned: async (e, count) => {
      calls.push(count);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  {
    const calls = [];
    check("2a không có deps ⇒ đi tiếp (null)", await decline({}, { bytes: SIGNED }, undefined), null);
    check("2a deps không có hàm ⇒ đi tiếp", await decline({}, { bytes: SIGNED }, {}), null);
    check("2a deps.confirmSignOverSigned không phải hàm ⇒ đi tiếp", await decline({}, { bytes: SIGNED }, { confirmSignOverSigned: "sign" }), null);
    check("2a không chữ ký ⇒ đi tiếp, KHÔNG hỏi", [await decline({}, { bytes: UNSIGNED }, mkDeps("cancel", calls)), calls.length], [null, 0]);
    check("2a payload không có bytes ⇒ đi tiếp, không hỏi", [await decline({}, {}, mkDeps("cancel", calls)), calls.length], [null, 0]);
    check("2a payload null ⇒ đi tiếp, không hỏi", [await decline({}, null, mkDeps("cancel", calls)), calls.length], [null, 0]);
  }
  for (const [label, ans, expectGo] of [
    ['"sign"', "sign", true],
    ['"cancel"', "cancel", false],
    ["undefined", undefined, false],
    ["null", null, false],
    ['"SIGN" (hoa)', "SIGN", false],
    ['"overwrite"', "overwrite", false],
    ["true", true, false],
    ["1", 1, false],
    ["ném lỗi", new Error("hộp thoại hỏng"), false],
  ]) {
    const calls = [];
    const r = await decline({}, { bytes: SIGNED }, mkDeps(ans, calls));
    check(`2b file ký + trả lời ${label} ⇒ ${expectGo ? "đi tiếp" : "KHÔNG ký"}`, r, expectGo ? null : DECLINED);
    check(`2b … hỏi đúng 1 lần, kèm số chữ ký`, calls, [1]);
  }

  // handler đầu-cuối: worker chỉ được gọi khi cổng cho qua
  function mkHandler(deps) {
    const handlers = {};
    const worker = { calls: 0, last: null };
    const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
    const signInWorker = async (p) => {
      worker.calls++;
      worker.last = p;
      return { ok: true, bytes: Buffer.from("SIGNED") };
    };
    new Function("ipcMain", "SignedScan", "signInWorker", "deps", "declineIfSigned_unused", declineSrc + "\n" + handlerSrc)(ipcMain, S, signInWorker, deps, null);
    return { run: (payload) => handlers["sign:apply"]({ sender: null }, payload), worker };
  }
  {
    const h = mkHandler(mkDeps("cancel", []));
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2c file ký + Huỷ: trả declined, WORKER KHÔNG ĐƯỢC GỌI (hộp PIN không hiện)", [r, h.worker.calls], [DECLINED, 0]);
  }
  {
    const h = mkHandler(mkDeps("sign", []));
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2c file ký + 'Vẫn ký': worker được gọi với đúng payload", [r.ok, h.worker.calls, h.worker.last.thumbprint], [true, 1, "T"]);
  }
  {
    const calls = [];
    const h = mkHandler(mkDeps("cancel", calls));
    const r = await h.run({ bytes: UNSIGNED, thumbprint: "T" });
    check("2c file không ký: không hỏi, worker được gọi (hành vi cũ nguyên vẹn)", [r.ok, calls.length, h.worker.calls], [true, 0, 1]);
  }
  {
    const h = mkHandler(undefined);
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2c không tiêm deps (test/dev): đi tiếp như trước", [r.ok, h.worker.calls], [true, 1]);
  }
  {
    const h = mkHandler(mkDeps("cancel", []));
    const r = await h.run(undefined);
    check("2c payload undefined không làm handler ném (worker tự xử, như trước)", [r.ok, h.worker.calls], [true, 1]);
  }

  // ---- 3. askSignOverSigned, cắt nguyên văn từ main.js ------------------------------------------------
  const MAIN = rd("src", "main.js");
  const askSrc = cut(MAIN, "async function askSignOverSigned(", 'ipcMain.handle("dialog:save-pdf"');
  const boxes = [];
  const makeAsk = (lang, respond) =>
    new Function("dialog", "menuLang", askSrc + "; return askSignOverSigned;")(
      {
        showMessageBox: async (w, o) => {
          boxes.push(o);
          const v = respond(o);
          if (v instanceof Error) throw v;
          return { response: v };
        },
      },
      lang
    );
  {
    const ask = makeAsk("vi", () => 0);
    check("3a nút 0 ⇒ cancel", await ask(null, 2), "cancel");
    const o = boxes[boxes.length - 1];
    check("3a hai nút, đúng thứ tự: Huỷ trước, Vẫn ký sau", o.buttons, ["Huỷ", "Vẫn ký (mất chữ ký trước)"]);
    check("3a nút mặc định và nút Esc đều là Huỷ (0)", [o.defaultId, o.cancelId], [0, 0]);
    ok("3a nêu số chữ ký + nói thật hậu quả + chỉ lối ra (Acrobat/Foxit)", /2 chữ ký/.test(o.message) && /không còn xác minh được/.test(o.detail) && /Acrobat hoặc Foxit/.test(o.detail));
  }
  for (const [resp, expect] of [[0, "cancel"], [1, "sign"], [2, "cancel"], [-1, "cancel"], [undefined, "cancel"], [null, "cancel"]]) {
    check(`3b bấm ${resp} ⇒ ${expect}`, await makeAsk("vi", () => resp)(null, 1), expect);
  }
  check("3b hộp thoại ném lỗi ⇒ cancel (không bao giờ thành 'ký')", await makeAsk("vi", () => new Error("x"))(null, 1), "cancel");
  {
    await makeAsk("en", () => 0)(null, 3);
    const o = boxes[boxes.length - 1];
    check("3c bản tiếng Anh", [o.buttons[0], o.message], ["Cancel", "This document already has 3 digital signatures."]);
    await makeAsk("en", () => 0)(null, 1);
    check("3c số ít", boxes[boxes.length - 1].message, "This document already has 1 digital signature.");
  }

  // ---- 4. ghim cấu trúc --------------------------------------------------------------------------------
  const SIGN_JS = rd("renderer", "sign.js");
  ok("4a main tiêm cổng vào initSigning", /initSigning\(\{ confirmSignOverSigned: \(e, count\) => askSignOverSigned\(senderWindow\(e\), count\) \}\)/.test(MAIN));
  ok("4a initSigning nhận deps (mặc định {})", /function initSigning\(deps = \{\}\)/.test(SIGNING));
  const hAt = SIGNING.indexOf('ipcMain.handle("sign:apply"');
  const hBody = SIGNING.slice(hAt, SIGNING.indexOf("\n}\n\nmodule.exports", hAt));
  ok("4b handler: cổng đứng TRƯỚC signInWorker", hBody.indexOf("declineIfSigned(") > 0 && hBody.indexOf("signInWorker(") > hBody.indexOf("declineIfSigned("));
  ok("4b handler: cổng trả kết quả thì return ngay (không rơi xuống worker)", /if \(declined\) return declined;/.test(hBody));
  ok("4b chỉ đúng \"sign\" mới đi tiếp", /answer === "sign"/.test(SIGNING));
  ok("4b nhánh bắt lỗi của hộp thoại KHÔNG đặt answer = 'sign'", !/catch \(_\) \{ ?answer = "sign"/.test(SIGNING));
  ok("4c renderer: explainError có 'declined'", /case "declined"/.test(SIGN_JS));
  ok("4c renderer: declined là toast thường, không đỏ", /res\.reason === "declined" \? "" : "bad"/.test(SIGN_JS));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
