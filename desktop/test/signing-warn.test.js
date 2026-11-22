"use strict";

// BI-132/133 — cảnh báo + định tuyến trước khi KÝ lên tài liệu đã có chữ ký (signing.js · routeSigning, signed-scan.js ·
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

  // ---- 2. routeSigning + handler, cắt nguyên văn từ signing.js ---------------------------------------------
  const rd = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n"); // cây làm việc là CRLF
  const SIGNING = rd("src", "signing.js");
  const cut = (src, from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from);
    return src.slice(a, b);
  };
  const routeSrc = cut(SIGNING, "const DECLINED = {", "function initSigning(");
  const handlerSrc = cut(SIGNING, 'ipcMain.handle("sign:apply"', "\n}\n\nmodule.exports");
  const SignAppend = require("../src/sign-append");

  const SIGNED = buildSigned();
  const UNSIGNED = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n");
  const DECLINED = { ok: false, reason: "declined", error: "Đã huỷ ký — tài liệu đã có chữ ký." };
  const READY = { state: "ready", port: 4321, token: "tok" };

  // Dựng routeSigning với signInWorker giả (ghi lại các lời gọi). workerResults là hàng đợi kết quả cho từng lời gọi.
  function mkRoute(workerResults) {
    const calls = [];
    const queue = [...(workerResults || [])];
    const signInWorker = async (p) => {
      calls.push(p);
      return queue.length ? queue.shift() : { ok: true, bytes: Buffer.from("SIGNED") };
    };
    const fn = new Function("SignedScan", "SignAppend", "signInWorker", routeSrc + "\nreturn routeSigning;")(S, SignAppend, signInWorker);
    return { fn, calls };
  }
  // Hộp thoại giả: trả lần lượt các đáp án; ghi lại (count, extra) của từng lần hỏi.
  function mkDeps(answers, sidecar) {
    const asks = [];
    const q = [...answers];
    return {
      asks,
      confirmSignOverSigned: async (e, count, extra) => {
        asks.push({ count, extra });
        const a = q.shift();
        if (a instanceof Error) throw a;
        return a;
      },
      getSidecar: () => sidecar,
    };
  }
  const route = async (payload, deps, results) => {
    const r = mkRoute(results);
    return { out: await r.fn({}, payload, deps), calls: r.calls };
  };

  // 2a. những ca KHÔNG hỏi: đường cổ điển, hành vi cũ nguyên vẹn
  {
    const d = mkDeps(["sign"], READY);
    check("2a không tiêm deps ⇒ classic", (await route({ bytes: SIGNED }, undefined)).out, { route: "classic" });
    check("2a deps không có hàm ⇒ classic", (await route({ bytes: SIGNED }, {})).out, { route: "classic" });
    check("2a confirmSignOverSigned không phải hàm ⇒ classic", (await route({ bytes: SIGNED }, { confirmSignOverSigned: "sign" })).out, { route: "classic" });
    check("2a không chữ ký ⇒ classic, KHÔNG hỏi", [(await route({ bytes: UNSIGNED }, d)).out, d.asks.length], [{ route: "classic" }, 0]);
    check("2a payload không có bytes ⇒ classic, không hỏi", [(await route({}, d)).out, d.asks.length], [{ route: "classic" }, 0]);
    check("2a payload null ⇒ classic, không hỏi", [(await route(null, d)).out, d.asks.length], [{ route: "classic" }, 0]);
  }

  // 2b. file ký + các đáp án KHÔNG phải append: chỉ "sign" đi tiếp (classic), mọi thứ khác ⇒ DECLINED, worker không được gọi
  for (const [label, ans, expect] of [
    ['"sign"', "sign", { route: "classic" }],
    ['"cancel"', "cancel", { done: DECLINED }],
    ["undefined", undefined, { done: DECLINED }],
    ["null", null, { done: DECLINED }],
    ['"SIGN" (hoa)', "SIGN", { done: DECLINED }],
    ['"overwrite"', "overwrite", { done: DECLINED }],
    ["true", true, { done: DECLINED }],
    ["1", 1, { done: DECLINED }],
    ["ném lỗi", new Error("hộp thoại hỏng"), { done: DECLINED }],
  ]) {
    const d = mkDeps([ans], READY);
    const r = await route({ bytes: SIGNED }, d);
    check("2b file ký + trả lời " + label + " ⇒ " + (expect.route ? "classic" : "DECLINED"), r.out, expect);
    check("2b … worker KHÔNG được gọi ở bước định tuyến, hỏi đúng 1 lần kèm số chữ ký + canAppend", [r.calls.length, d.asks], [0, [{ count: 1, extra: { canAppend: true, failed: null } }]]);
  }

  // 2c. "append": chỉ khi sidecar sẵn sàng; đường append gọi worker với mode + sidecar, và giữ nguyên payload
  {
    const d = mkDeps(["append"], READY);
    const payload = { bytes: SIGNED, thumbprint: "T", meta: { reason: "r" } };
    const r = await route(payload, d, [{ ok: true, bytes: Buffer.from("APPENDED"), appended: true }]);
    check("2c append thành công ⇒ done = kết quả của worker", [r.out.done.ok, r.out.done.appended], [true, true]);
    check("2c … worker được gọi 1 lần với mode 'append' + cổng/token sidecar + payload gốc", [r.calls.length, r.calls[0].mode, r.calls[0].sidecar, r.calls[0].thumbprint, r.calls[0].meta], [1, "append", { port: 4321, token: "tok" }, "T", { reason: "r" }]);
    check("2c … hỏi đúng 1 lần", d.asks.length, 1);
  }
  for (const [label, sc] of [
    ["sidecar chưa sẵn sàng (starting)", { state: "starting", port: null, token: "t" }],
    ["sidecar lỗi", { state: "error", port: null, token: "t" }],
    ["ready nhưng không có cổng", { state: "ready", port: null, token: "t" }],
    ["không có getSidecar", undefined],
  ]) {
    const d = mkDeps(["append"], sc);
    if (sc === undefined) delete d.getSidecar;
    const r = await route({ bytes: SIGNED }, d);
    check("2c " + label + ": hộp KHÔNG có nút nối (canAppend=false)", d.asks[0].extra.canAppend, false);
    check("2c … trả 'append' khi chưa được đề nghị ⇒ DECLINED, worker không được gọi", [r.out, r.calls.length], [{ done: DECLINED }, 0]);
  }

  // 2d. lỗi Ở/SAU bước ký: báo thẳng, KHÔNG hỏi lại (hỏi lại = hộp PIN lần nữa)
  for (const reason of ["cancelled", "no_cert", "tsa", "other", "sign_failed", "bad_signature", "signature_too_large"]) {
    const d = mkDeps(["append", "sign"], READY);
    const res = { ok: false, reason, error: "x" };
    const r = await route({ bytes: SIGNED }, d, [res]);
    check("2d lỗi giai đoạn ký '" + reason + "' ⇒ báo thẳng, không hỏi lại, không rơi xuống classic", [r.out, d.asks.length, r.calls.length], [{ done: res }, 1, 1]);
  }

  // 2e. lỗi TRƯỚC PIN (ghi nối bị từ chối): hỏi lại bằng hộp hai nút kèm lý do
  for (const [label, res, why] of [
    ["lõi từ chối 'repaired'", { ok: false, reason: "repaired", error: "x" }, "repaired"],
    ["tài liệu chứng nhận", { ok: false, reason: "docmdp_locked" }, "docmdp_locked"],
    ["trang xoay", { ok: false, reason: "rotated" }, "rotated"],
    ["worker trả null", null, "worker_failed"],
    ["worker trả object không reason", { ok: false }, "worker_failed"],
    ["lý do lạ", { ok: false, reason: "chưa-từng-thấy" }, "chưa-từng-thấy"],
  ]) {
    {
      const d = mkDeps(["append", "sign"], READY);
      const r = await route({ bytes: SIGNED, thumbprint: "T" }, d, [res]);
      check("2e " + label + " + 'Vẫn ký' ⇒ classic", r.out, { route: "classic" });
      check("2e … hỏi 2 lần; lần 2 canAppend=false + lý do", [d.asks.length, d.asks[1] && d.asks[1].extra], [2, { canAppend: false, failed: why }]);
      check("2e … worker append gọi đúng 1 lần (không thử lại)", r.calls.length, 1);
    }
    {
      const d = mkDeps(["append", "cancel"], READY);
      const r = await route({ bytes: SIGNED }, d, [res]);
      check("2e " + label + " + Huỷ ở lần 2 ⇒ DECLINED", r.out, { done: DECLINED });
    }
    {
      const d = mkDeps(["append", "append"], READY);
      const r = await route({ bytes: SIGNED }, d, [res]);
      check("2e " + label + " + nút hỏng trả 'append' lần 2 ⇒ DECLINED (không nối lần nữa)", [r.out, r.calls.length], [{ done: DECLINED }, 1]);
    }
  }
  {
    const d = mkDeps(["append", new Error("x")], READY);
    const r = await route({ bytes: SIGNED }, d, [{ ok: false, reason: "repaired" }]);
    check("2e hộp lần 2 ném lỗi ⇒ DECLINED", r.out, { done: DECLINED });
  }

  // 2f. handler đầu-cuối (cắt nguyên văn): worker cổ điển chỉ được gọi khi cổng cho phép
  function mkHandler(deps, results) {
    const handlers = {};
    const calls = [];
    const queue = [...(results || [])];
    const signInWorker = async (p) => {
      calls.push(p);
      return queue.length ? queue.shift() : { ok: true, bytes: Buffer.from("SIGNED") };
    };
    const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
    new Function("ipcMain", "SignedScan", "SignAppend", "signInWorker", "deps", routeSrc + "\n" + handlerSrc)(ipcMain, S, SignAppend, signInWorker, deps);
    return { run: (payload) => handlers["sign:apply"]({ sender: null }, payload), calls };
  }
  {
    const h = mkHandler(mkDeps(["cancel"], READY));
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2f file ký + Huỷ: trả declined, WORKER KHÔNG ĐƯỢC GỌI (hộp PIN không hiện)", [r, h.calls.length], [DECLINED, 0]);
  }
  {
    const h = mkHandler(mkDeps(["sign"], READY));
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2f 'Vẫn ký': worker cổ điển gọi 1 lần, KHÔNG có mode", [r.ok, h.calls.length, h.calls[0].mode], [true, 1, undefined]);
  }
  {
    const h = mkHandler(mkDeps(["append"], READY));
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2f 'Ký nối thêm' thành công: trả kết quả append, worker đúng 1 lần, mode 'append'", [r.ok, h.calls.length, h.calls[0].mode], [true, 1, "append"]);
  }
  {
    const h = mkHandler(mkDeps(["append", "sign"], READY), [{ ok: false, reason: "repaired" }, { ok: true, bytes: Buffer.from("CLASSIC") }]);
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2f nối bị từ chối rồi 'Vẫn ký': worker gọi 2 lần (append rồi cổ điển)", [r.ok, h.calls.map((c) => c.mode)], [true, ["append", undefined]]);
  }
  {
    const calls = [];
    const h = mkHandler(mkDeps(["cancel"], READY));
    const r = await h.run({ bytes: UNSIGNED, thumbprint: "T" });
    check("2f file không ký: không hỏi, worker cổ điển được gọi (hành vi cũ)", [r.ok, h.calls.length, h.calls[0].mode], [true, 1, undefined]);
  }
  {
    const h = mkHandler(undefined);
    const r = await h.run({ bytes: SIGNED, thumbprint: "T" });
    check("2f không tiêm deps (test/dev): đi tiếp như trước", [r.ok, h.calls.length], [true, 1]);
  }
  {
    const h = mkHandler(mkDeps(["cancel"], READY));
    const r = await h.run(undefined);
    check("2f payload undefined không làm handler ném (worker tự xử, như trước)", [r.ok, h.calls.length], [true, 1]);
  }

  // ---- 3. askSignOverSigned, cắt nguyên văn từ main.js ---------------------------------------------------------
  const MAIN = rd("src", "main.js");
  const askSrc = cut(MAIN, "async function askSignOverSigned(", 'ipcMain.handle("dialog:save-pdf"');
  const SignedSave = require("../src/signed-save");
  const boxes = [];
  const makeAsk = (lang, respond) =>
    new Function("dialog", "menuLang", "SignedSave", askSrc + "; return askSignOverSigned;")(
      {
        showMessageBox: async (w, o) => {
          boxes.push(o);
          const v = respond(o);
          if (v instanceof Error) throw v;
          return { response: v };
        },
      },
      lang,
      SignedSave
    );
  {
    const ask = makeAsk("vi", () => 0);
    check("3a hai nút (không nối): nút 0 ⇒ cancel", await ask(null, 2), "cancel");
    const o = boxes[boxes.length - 1];
    check("3a hai nút: Huỷ trước, Vẫn ký sau", o.buttons, ["Huỷ", "Vẫn ký (mất chữ ký trước)"]);
    check("3a hai nút: mặc định và Esc đều là Huỷ (0)", [o.defaultId, o.cancelId], [0, 0]);
    ok("3a hai nút: nêu số chữ ký + nói thật hậu quả + chỉ lối ra (Acrobat/Foxit)", /2 chữ ký/.test(o.message) && /không còn xác minh được/.test(o.detail) && /Acrobat hoặc Foxit/.test(o.detail));
    ok("3a hai nút: KHÔNG nhắc 'Ký nối thêm'", !/nối thêm/.test(o.detail) && !/nối thêm/.test(o.buttons.join("|")));
  }
  {
    const ask = makeAsk("vi", () => 0);
    check("3b ba nút (có nối): nút 0 ⇒ append", await ask(null, 2, { canAppend: true }), "append");
    const o = boxes[boxes.length - 1];
    check("3b ba nút: Ký nối thêm, Vẫn ký, Huỷ — theo thứ tự", o.buttons, ["Ký nối thêm (giữ chữ ký trước)", "Vẫn ký (mất chữ ký trước)", "Huỷ"]);
    check("3b ba nút: mặc định = nút đầu (không phá chữ ký), Esc = Huỷ (cuối)", [o.defaultId, o.cancelId], [0, 2]);
    ok("3b ba nút: lời giải thích nói thật (trình đọc vẫn có thể ghi chú 'có thay đổi sau khi ký')", /có thay đổi sau khi ký/.test(o.detail));
  }
  for (const [resp, expect] of [[0, "append"], [1, "sign"], [2, "cancel"], [3, "cancel"], [-1, "cancel"], [undefined, "cancel"], [null, "cancel"]]) {
    check("3c (3 nút) bấm " + resp + " ⇒ " + expect, await makeAsk("vi", () => resp)(null, 1, { canAppend: true }), expect);
  }
  for (const [resp, expect] of [[0, "cancel"], [1, "sign"], [2, "cancel"], [-1, "cancel"], [undefined, "cancel"]]) {
    check("3c (2 nút) bấm " + resp + " ⇒ " + expect, await makeAsk("vi", () => resp)(null, 1), expect);
  }
  check("3c hộp thoại ném lỗi ⇒ cancel (không bao giờ thành 'ký' hay 'ký nối thêm')", await makeAsk("vi", () => new Error("x"))(null, 1, { canAppend: true }), "cancel");
  {
    await makeAsk("vi", () => 1)(null, 1, { canAppend: false, failed: "repaired" });
    const o = boxes[boxes.length - 1];
    ok("3d nối vừa hỏng: hộp hai nút kèm lý do bằng tiếng Việt", o.buttons.length === 2 && /Không ký nối thêm được \(file gốc bị lỗi cấu trúc/.test(o.detail));
    await makeAsk("vi", () => 1)(null, 1, { canAppend: false, failed: "docmdp_locked" });
    ok("3d lý do DocMDP có câu riêng", /được chứng nhận \(DocMDP\)/.test(boxes[boxes.length - 1].detail));
    await makeAsk("vi", () => 1)(null, 1, { canAppend: false, failed: "<script>" });
    ok("3d lý do lạ không bị in thẳng", /lý do không rõ/.test(boxes[boxes.length - 1].detail) && !/<script>/.test(boxes[boxes.length - 1].detail));
    await makeAsk("en", () => 0)(null, 3, { canAppend: true });
    const o3 = boxes[boxes.length - 1];
    check("3e bản tiếng Anh (ba nút)", [o3.buttons, o3.message], [["Add signature (keep earlier ones)", "Sign anyway (drops earlier signatures)", "Cancel"], "This document already has 3 digital signatures."]);
    await makeAsk("en", () => 0)(null, 1);
    check("3e số ít", boxes[boxes.length - 1].message, "This document already has 1 digital signature.");
  }

  // ---- 4. ghim cấu trúc --------------------------------------------------------------------------------
  const SIGN_JS = rd("renderer", "sign.js");
  const WORKER = rd("src", "signing-worker.js");
  ok("4a main tiêm cổng + getSidecar vào initSigning", /initSigning\(\{\s*confirmSignOverSigned: \(e, count, extra\) => askSignOverSigned\(senderWindow\(e\), count, extra\),\s*getSidecar: \(\) => sidecarState,/.test(MAIN));
  ok("4a initSigning nhận deps (mặc định {})", /function initSigning\(deps = \{\}\)/.test(SIGNING));
  const hAt = SIGNING.indexOf('ipcMain.handle("sign:apply"');
  const hBody = SIGNING.slice(hAt, SIGNING.indexOf("\n}\n\nmodule.exports", hAt));
  ok("4b handler: định tuyến đứng TRƯỚC worker cổ điển", hBody.indexOf("routeSigning(") > 0 && hBody.indexOf("signInWorker(payload") > hBody.indexOf("routeSigning("));
  ok("4b handler: có kết quả (done) thì return ngay, không rơi xuống worker cổ điển", /if \(routed\.done\) return routed\.done;/.test(hBody));
  ok('4b "sign" mới được đi cổ điển; "append" chỉ khi canAppend', /answer === "sign"\) return \{ route: "classic" \}/.test(SIGNING) && /answer === "append" && canAppend/.test(SIGNING));
  ok("4b hộp thoại ném lỗi KHÔNG đặt answer = 'sign'/'append'", !/catch \(_\) \{ ?answer = "(sign|append)"/.test(SIGNING));
  ok("4b chỉ thử nối MỘT lần (vòng hỏi tối đa 2)", /for \(let round = 0; round < 2; round\+\+\)/.test(SIGNING) && /canAppend = false; \/\/ một lần thử thôi/.test(SIGNING));
  ok("4b lỗi giai đoạn ký lấy từ SignAppend.SIGN_STAGE_REASONS (một nguồn)", /SignAppend\.SIGN_STAGE_REASONS\.includes\(res\.reason\)/.test(SIGNING));
  ok("4c worker: chọn đường append theo payload.mode", /payload\.mode === "append" \? await applyAppendSignature\(payload\) : await applySignature\(payload\)/.test(WORKER));
  ok("4d renderer: explainError có 'declined'", /case "declined"/.test(SIGN_JS));
  ok("4d renderer: declined là toast thường, không đỏ", /res\.reason === "declined" \? "" : "bad"/.test(SIGN_JS));
  ok("4d renderer: toast riêng cho ký nối thêm", /res\.appended \? "Đã ký nối thêm/.test(SIGN_JS));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
