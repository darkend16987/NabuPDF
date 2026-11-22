"use strict";

// BI-133 — ký NỐI THÊM (src/sign-append.js). Ba tầng:
//   1. hàm thuần (định vị chỗ giữ chữ ký, điền ByteRange, ghép chữ ký, đọc DocMDP) trên buffer tự dựng — mọi biên;
//   2. bộ điều phối `appendSign` với prepare/append/signer GIẢ — mỗi nhánh fail-closed, và NGUYÊN TẮC: chỉ trả ok khi kết quả
//      còn nguyên byte cũ VÀ nhận ra được chữ ký mới;
//   3. đường THẬT: pdf-lib + @signpdf (chính thư viện của app) + lõi ghi nối Python qua tiến trình con + OpenSSL làm trọng tài.
//      Bỏ qua (có in) nếu máy thiếu openssl / .venv / node_modules.
//
// Run:  node desktop/test/sign-append.test.js      (or: npm run test:signappend)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const SA = require("../src/sign-append");
const SignedScan = require("../src/signed-scan");

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

const pad = (n) => String(n).padStart(10, "0");
// File "đã ký" giả: [0 L1 C L2] đúng, ô /Contents hex.
function buildSigned(o) {
  const { hexLen = 64, extra = "" } = o || {};
  const pre =
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n" +
    "<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [ZZZZZZZZZZ AAAAAAAAAA CCCCCCCCCC LLLLLLLLLL] /Contents ";
  const post = " /M (D:20260101000000Z) >>\nendobj\n" + extra + "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  const l1 = pre.length;
  const c = pre.length + hexLen + 2;
  const body = pre + "<" + "a".repeat(hexLen) + ">" + post;
  const l2 = body.length - c;
  const s = body.replace("ZZZZZZZZZZ", pad(0)).replace("AAAAAAAAAA", pad(l1)).replace("CCCCCCCCCC", pad(c)).replace("LLLLLLLLLL", pad(l2));
  return Buffer.from(s, "latin1");
}
// Một revision nối có chỗ giữ chữ ký ĐÚNG dạng lõi PyMuPDF in ra (gọn, không khoảng trắng).
function revision(cap, extra) {
  return Buffer.from(
    `\n99 0 obj\n<</Type/Sig/Filter/Adobe.PPKLite/SubFilter/adbe.pkcs7.detached/ByteRange[0/**********/**********/**********]/Contents<${"0".repeat(cap)}>/M(D:2026)>>\nendobj\n${extra || ""}trailer\n<</Root 1 0 R/Prev 0>>\n%%EOF\n`,
    "latin1"
  );
}
const TMPS = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("nabu-signappend-")).length;

(async () => {
  // ---- 1. hàm thuần ------------------------------------------------------------------------------------
  // 1a. docMdpLevel
  const L = (s) => SA.docMdpLevel(Buffer.from(s, "latin1"));
  check("1a không DocMDP ⇒ 0", L("%PDF-1.7\n<< /Type /Catalog >>\n%%EOF"), 0);
  check("1a chỉ /Perms (không khai mức) ⇒ 0", L("<< /Perms << /DocMDP 5 0 R >> >>"), 0);
  check("1a P=1 (không cho sửa) dạng gọn", L("/Reference[<</TransformMethod/DocMDP/TransformParams<</P 1/V/1.2/Type/TransformParams>>/Type/SigRef>>]"), 1);
  check("1a P=2 dạng có khoảng trắng", L("/TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P 2 /V /1.2 >>"), 2);
  check("1a P=3", L("/TransformMethod/DocMDP/TransformParams<</P 3>>"), 3);
  check("1a thiếu /P ⇒ mặc định 2", L("/TransformMethod/DocMDP/TransformParams<</V/1.2>>"), 2);
  check("1a '/Pages 1' không bị nhầm là /P 1", L("/TransformMethod/DocMDP/TransformParams<</Pages 1>>"), 2);
  check("1a '/P 10' không bị đọc là 1", L("/TransformMethod/DocMDP/TransformParams<</P 10>>"), 2);
  check("1a hai chữ ký chứng nhận: lấy mức NGHIÊM nhất", L("/TransformMethod/DocMDP/TransformParams<</P 3>> .... /TransformMethod/DocMDP/TransformParams<</P 1>>"), 1);
  check("1a nhận cả khi tách dòng", L("/TransformMethod\n/DocMDP\n/TransformParams <<\n/P 1\n>>"), 1);
  check("1a Uint8Array/Buffer đều được", SA.docMdpLevel(new Uint8Array(Buffer.from("/TransformMethod/DocMDP/TransformParams<</P 1>>"))), 1);

  // 1b. locatePlaceholder
  {
    const base = buildSigned();
    const rev = revision(64);
    const buf = Buffer.concat([base, rev]);
    const loc = SA.locatePlaceholder(buf);
    ok("1b tìm thấy chỗ giữ chữ ký ở phần nối", loc && loc.brStart >= base.length);
    check("1b ltPos trỏ đúng '<', gtEnd ngay SAU '>'", [String.fromCharCode(buf[loc.ltPos]), String.fromCharCode(buf[loc.gtEnd - 1]), String.fromCharCode(buf[loc.ltPos + 1])], ["<", ">", "0"]);
    check("1b dung lượng hex = số '0' trong ô", loc.capacityHex, 64);
    ok("1b brStart..brEnd là đúng đoạn ByteRange", buf.toString("latin1", loc.brStart, loc.brEnd) === "/ByteRange[0/**********/**********/**********]");
    check("1b file không có chỗ giữ chữ ký (chỉ chữ ký thật) ⇒ null", SA.locatePlaceholder(base), null);
    check("1b rỗng ⇒ null", SA.locatePlaceholder(Buffer.alloc(0)), null);
    // hai chỗ giữ chỗ: lấy cái CUỐI
    const two = Buffer.concat([base, revision(32), revision(48)]);
    const l2 = SA.locatePlaceholder(two);
    check("1b hai chỗ giữ chỗ ⇒ lấy cái cuối (dung lượng 48)", l2.capacityHex, 48);
    // Có chữ /ByteRange KHÁC (số thật, hay chỉ là chữ trong một chú thích) nằm SAU chỗ giữ chữ ký ⇒ vẫn phải tìm ra nó: vòng tìm ngược phải đi tiếp qua các /ByteRange không phải chỗ giữ chỗ.
    {
      const after = Buffer.concat([base, revision(64), Buffer.from("\n%% ghi chú có /ByteRange [0 5 6 7] và /ByteRange nữa\n/ByteRange\n", "latin1")]);
      const la = SA.locatePlaceholder(after);
      check("1b có /ByteRange thường nằm SAU chỗ giữ chữ ký ⇒ vẫn tìm ra (dung lượng 64)", la && la.capacityHex, 64);
    }
    // ByteRange giữ chỗ nhưng Contents không phải toàn '0' ⇒ KHÔNG nhận (có thể đã ký rồi)
    const used = Buffer.concat([base, Buffer.from(revision(16).toString("latin1").replace("<0000000000000000>", "<00000000000000a0>"), "latin1")]);
    check("1b Contents đã có byte khác 0 ⇒ null", SA.locatePlaceholder(used), null);
    // dạng có khoảng trắng (thư viện khác)
    const spaced = Buffer.concat([base, Buffer.from(revision(16).toString("latin1").replace("[0/**********/**********/**********]", "[ 0 /********** /********** /********** ]"), "latin1")]);
    ok("1b chấp nhận dạng có khoảng trắng", SA.locatePlaceholder(spaced) !== null);
  }

  // 1c. fillByteRange + dataToSign + spliceSignature
  {
    const base = buildSigned();
    const buf = Buffer.concat([base, revision(64)]);
    const loc = SA.locatePlaceholder(buf);
    const len0 = buf.length;
    const range = SA.fillByteRange(buf, loc);
    check("1c độ dài file KHÔNG đổi", buf.length, len0);
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(buf.toString("latin1", loc.brStart, loc.brEnd));
    check("1c ByteRange = [0 L1 C L2] đúng", m && m.slice(1).map(Number), [0, range.L1, range.C, range.L2]);
    check("1c L1 = vị trí '<', C = ngay sau '>', L1+gap+L2 = cả file", [range.L1, range.C, range.L1 + (range.C - range.L1) + range.L2], [loc.ltPos, loc.gtEnd, buf.length]);
    const data = SA.dataToSign(buf, range);
    check("1c dữ liệu ký = file trừ ô /Contents", data.length, buf.length - (range.C - range.L1));
    ok("1c … và khớp từng byte hai đoạn", data.subarray(0, range.L1).equals(buf.subarray(0, range.L1)) && data.subarray(range.L1).equals(buf.subarray(range.C)));
    check("1c ghép chữ ký vừa ô", SA.spliceSignature(buf, loc, Buffer.from("deadbeef", "hex")), true);
    check("1c ô được đệm '0' đến đủ dung lượng", buf.toString("latin1", loc.ltPos, loc.gtEnd), "<deadbeef" + "0".repeat(64 - 8) + ">");
    check("1c ghép đúng bằng dung lượng", SA.spliceSignature(buf, loc, Buffer.alloc(32, 0x11)), true);
    check("1c ghép vượt dung lượng ⇒ false (không ghi gì)", SA.spliceSignature(buf, loc, Buffer.alloc(33, 0x22)), false);
    ok("1c … và ô không bị hỏng sau lần thất bại", /^<1{64}>$/.test(buf.toString("latin1", loc.ltPos, loc.gtEnd)));
    // số lớn
    const big = Buffer.concat([Buffer.alloc(0), buildSigned(), revision(8)]);
    const lb = SA.locatePlaceholder(big);
    ok("1c ByteRange với số 10 chữ số vẫn vừa (không ném)", (() => { try { SA.fillByteRange(big, lb); return true; } catch (_) { return false; } })());
  }

  // ---- 2. bộ điều phối với đồ giả ------------------------------------------------------------------------
  const BASE = buildSigned();
  const CAP = 128; // hex
  const MERGED = () => Buffer.concat([BASE, revision(CAP)]);
  const mkOpts = (over) => {
    const calls = { prepare: 0, append: 0, sign: 0, signed: null, appendPath: null };
    const o = {
      bytes: BASE,
      meta: { name: "x" },
      prepare: async () => (calls.prepare++, Buffer.from("EDITED")),
      append: async (p, edited) => {
        calls.append++;
        calls.appendPath = p;
        calls.appendExisted = fs.existsSync(p) && fs.readFileSync(p).equals(BASE);
        return { ok: true, bytes: MERGED() };
      },
      signer: { sign: async (buf) => (calls.sign++, (calls.signed = buf), Buffer.alloc(40, 0xab)) },
      ...over,
    };
    return { o, calls };
  };
  const tmpBefore = TMPS();
  {
    const { o, calls } = mkOpts({});
    const r = await SA.appendSign(o);
    check("2a thành công: ok, appended, 2 chữ ký", [r.ok, r.appended, r.signatures], [true, true, 2]);
    ok("2a … bắt đầu bằng ĐÚNG byte đầu vào", r.bytes.subarray(0, BASE.length).equals(BASE));
    ok("2a … nhận ra chữ ký mới bằng cổng BI-127", SignedScan.findSignaturesInBuffer(r.bytes).count === 2);
    const loc = SA.locatePlaceholder(Buffer.concat([BASE, revision(CAP)]));
    ok("2a ô /Contents chứa đúng chữ ký, đệm '0'", r.bytes.toString("latin1", loc.ltPos, loc.gtEnd) === "<" + "ab".repeat(40) + "0".repeat(CAP - 80) + ">");
    // dữ liệu mà signer nhận = file đã điền ByteRange, TRỪ ô /Contents
    const m = /\/ByteRange\s*\[\s*0\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(r.bytes.toString("latin1", loc.brStart, loc.brEnd + 40));
    const [L1, C, L2] = [Number(m[1]), Number(m[2]), Number(m[3])];
    ok("2a signer được đưa ĐÚNG [0:L1] + [C:C+L2]", calls.signed.equals(Buffer.concat([r.bytes.subarray(0, L1), r.bytes.subarray(C, C + L2)])));
    check("2a prepare/append/sign mỗi cái 1 lần", [calls.prepare, calls.append, calls.sign], [1, 1, 1]);
    ok("2a file gốc được đưa cho lõi ghi nối là FILE TẠM chứa đúng byte đầu vào", calls.appendExisted && /base\.pdf$/.test(calls.appendPath));
    ok("2a thư mục tạm bị dọn", !fs.existsSync(path.dirname(calls.appendPath)));
  }
  {
    const { o, calls } = mkOpts({ bytes: Buffer.from("%PDF-1.4\n%%EOF\n") });
    const r = await SA.appendSign(o);
    check("2b không có chữ ký ⇒ not_signed, không gọi gì", [r.ok, r.reason, calls.prepare + calls.append + calls.sign], [false, "not_signed", 0]);
  }
  {
    const locked = buildSigned({ extra: "5 0 obj\n<</Reference[<</TransformMethod/DocMDP/TransformParams<</P 1/V/1.2>>>>]>>\nendobj\n" });
    const { o, calls } = mkOpts({ bytes: locked });
    const r = await SA.appendSign(o);
    check("2c tài liệu chứng nhận P=1 ⇒ docmdp_locked, KHÔNG gọi gì (kể cả PIN)", [r.ok, r.reason, calls.prepare + calls.append + calls.sign], [false, "docmdp_locked", 0]);
    const p2 = buildSigned({ extra: "5 0 obj\n<</Reference[<</TransformMethod/DocMDP/TransformParams<</P 2/V/1.2>>>>]>>\nendobj\n" });
    const m = mkOpts({ bytes: p2, append: async () => ({ ok: true, bytes: Buffer.concat([p2, revision(CAP)]) }) });
    const r2 = await SA.appendSign(m.o);
    check("2c P=2 (cho điền form + ký) ⇒ được", r2.ok, true);
  }
  {
    const { o, calls } = mkOpts({ prepare: async () => { throw new Error("pdf-lib chết"); } });
    const r = await SA.appendSign(o);
    check("2d prepare ném ⇒ prepare_failed, không gọi append/sign", [r.ok, r.reason, r.detail, calls.append + calls.sign], [false, "prepare_failed", "pdf-lib chết", 0]);
  }
  for (const [label, resp] of [
    ["lõi từ chối có lý do", { ok: false, reason: "repaired", detail: "xref" }],
    ["lõi không lý do", { ok: false }],
    ["lõi trả null", null],
    ["ok nhưng không có byte", { ok: true }],
  ]) {
    const { o, calls } = mkOpts({ append: async () => resp });
    const r = await SA.appendSign(o);
    check(`2e ${label}: ok:false, KHÔNG ký`, [r.ok, calls.sign], [false, 0]);
    if (label === "lõi từ chối có lý do") check("2e … lý do của lõi đi qua nguyên vẹn", [r.reason, r.detail], ["repaired", "xref"]);
  }
  {
    // lõi trả file KHÔNG bắt đầu bằng byte đầu vào (chữ ký trước sẽ mất) ⇒ từ chối trước khi ký
    const altered = Buffer.from(MERGED());
    altered[10] ^= 1;
    const a = mkOpts({ append: async () => ({ ok: true, bytes: altered }) });
    const r = await SA.appendSign(a.o);
    check("2f lệch MỘT byte trong phần cũ ⇒ prefix_changed, KHÔNG ký", [r.ok, r.reason, a.calls.sign], [false, "prefix_changed", 0]);
    const b = mkOpts({ append: async () => ({ ok: true, bytes: BASE }) });
    check("2f lõi trả y nguyên đầu vào (không có revision) ⇒ prefix_changed", (await SA.appendSign(b.o)).reason, "prefix_changed");
    const c = mkOpts({ append: async () => ({ ok: true, bytes: BASE.subarray(0, BASE.length - 5) }) });
    check("2f lõi trả file NGẮN hơn ⇒ prefix_changed", (await SA.appendSign(c.o)).reason, "prefix_changed");
  }
  {
    const none = mkOpts({ append: async () => ({ ok: true, bytes: Buffer.concat([BASE, Buffer.from("\n%% revision không có chữ ký\n")]) }) });
    const r = await SA.appendSign(none.o);
    check("2g revision không có chỗ giữ chữ ký ⇒ placeholder_missing, KHÔNG ký", [r.ok, r.reason, none.calls.sign], [false, "placeholder_missing", 0]);
    // chỗ giữ chữ ký nằm TRONG byte cũ (không phải ở phần nối) cũng không được chấp nhận
    const baseWithPh = Buffer.concat([buildSigned(), revision(CAP)]); // đầu vào đã chứa một chỗ giữ chỗ chưa ký
    const x = mkOpts({ bytes: baseWithPh, append: async () => ({ ok: true, bytes: Buffer.concat([baseWithPh, Buffer.from("\n%%rev\n")]) }) });
    const r2 = await SA.appendSign(x.o);
    check("2g chỗ giữ chữ ký chỉ có trong phần CŨ ⇒ placeholder_missing", [r2.ok, r2.reason, x.calls.sign], [false, "placeholder_missing", 0]);
  }
  {
    const e1 = new Error("Người dùng nhập sai PIN");
    e1.reason = "cancelled";
    const a = mkOpts({ signer: { sign: async () => { throw e1; } } });
    const r = await SA.appendSign(a.o);
    check("2h signer ném {reason:'cancelled'} ⇒ đi qua nguyên vẹn để renderer giải thích", [r.ok, r.reason, r.error], [false, "cancelled", "Người dùng nhập sai PIN"]);
    const b = mkOpts({ signer: { sign: async () => { throw new Error("lạ"); } } });
    check("2h signer ném lỗi không có reason ⇒ sign_failed", (await SA.appendSign(b.o)).reason, "sign_failed");
    const c = mkOpts({ signer: { sign: async () => Buffer.alloc(0) } });
    check("2h signer trả rỗng ⇒ bad_signature", (await SA.appendSign(c.o)).reason, "bad_signature");
    const d = mkOpts({ signer: { sign: async () => Buffer.alloc(CAP / 2 + 1, 1) } });
    check("2h chữ ký vượt ô ⇒ signature_too_large", (await SA.appendSign(d.o)).reason, "signature_too_large");
    const e = mkOpts({ signer: { sign: async () => Buffer.alloc(CAP / 2, 1) } });
    check("2h chữ ký ĐÚNG bằng ô ⇒ ok", (await SA.appendSign(e.o)).ok, true);
  }
  {
    // Ô chữ ký rộng hơn 1 MiB: mọi bước trước đều qua (chữ ký VỪA ô), nhưng cổng BI-127 không nhận một chữ ký có ô to cỡ đó ⇒
    // lớp kiểm CUỐI ("đếm lại được N+1 chữ ký") phải từ chối thay vì giao một file mà chính ta không thừa nhận là đã ký.
    const hugeCap = 1_100_000;
    const { o, calls } = mkOpts({ append: async () => ({ ok: true, bytes: Buffer.concat([BASE, revision(hugeCap)]) }) });
    const r = await SA.appendSign(o);
    check("2j chữ ký không được cổng BI-127 nhận ra ⇒ bad_signature (kiểm lần cuối), dù đã ký xong", [r.ok, r.reason, calls.sign], [false, "bad_signature", 1]);
  }
  check("2i không rò thư mục tạm sau mọi ca", TMPS(), tmpBefore);

  // ---- 3. đường thật --------------------------------------------------------------------------------------
  const ROOT = path.join(__dirname, "..", "..");
  const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
  const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: "ignore" }).status === 0; } catch (_) { return false; } };
  const canReal = fs.existsSync(PY) && has("openssl", ["version"]) && fs.existsSync(path.join(__dirname, "..", "node_modules", "pdf-lib")) && fs.existsSync(path.join(ROOT, "tools", "signed_fixture.js"));
  if (!canReal) {
    console.log("(bỏ qua tầng 3: thiếu .venv / openssl / node_modules)");
  } else {
    const nm = (p) => require(path.join(__dirname, "..", "node_modules", p));
    const { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFInvalidObject } = nm("pdf-lib");
    const { pdflibAddPlaceholder } = nm("@signpdf/placeholder-pdf-lib");
    const { SUBFILTER_ADOBE_PKCS7_DETACHED } = nm("@signpdf/utils");
    const W = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signappend-real-"));
    const sh = (cmd, args, opt) => { const r = spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 1 << 28, ...opt }); if (r.status !== 0) throw new Error(cmd + " lỗi: " + String(r.stderr).slice(0, 300)); return r; };
    const mkCert = (n) => { const key = path.join(W, `k${n}.pem`), crt = path.join(W, `c${n}.pem`); sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", `/CN=Signer ${n}`]); return { key, crt }; };
    const opensslSigner = (cert) => ({ sign: async (buf) => { const inp = path.join(W, "in.bin"); fs.writeFileSync(inp, buf); return sh("openssl", ["cms", "-sign", "-binary", "-in", inp, "-signer", cert.crt, "-inkey", cert.key, "-outform", "DER", "-md", "sha256"]).stdout; } });
    const prepare = SA.makePrepare({ PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFInvalidObject, pdflibAddPlaceholder, subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED });
    // append THẬT: lõi Python qua tiến trình con, cùng hợp đồng với route (đọc gốc từ đường dẫn)
    const append = async (origPath, edited) => {
      const ed = path.join(W, "edited.pdf"), out = path.join(W, "merged.pdf");
      fs.writeFileSync(ed, edited);
      const r = spawnSync(PY, [path.join(ROOT, "sidecar.py"), "--incremental-worker", origPath, ed, out], { encoding: "utf8" });
      if (r.status !== 0) return { ok: false, reason: ((r.stderr || "").split("\t")[0] || "worker_failed").trim() };
      return { ok: true, bytes: fs.readFileSync(out) };
    };
    const verify = (file) => { const r = spawnSync(PY, [path.join(ROOT, "tools", "verify_pdf_signatures.py"), file], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); return { code: r.status, out: r.stdout }; };

    const fx = JSON.parse(sh("node", [path.join(ROOT, "tools", "signed_fixture.js"), path.join(W, "fx")], { encoding: "utf8" }).stdout.toString().trim().split(/\r?\n/).pop());
    let cur = fs.readFileSync(fx.signed);
    check("3a file ký nền: OpenSSL hợp lệ", verify(fx.signed).code, 0);

    for (let n = 2; n <= 4; n++) {
      const r = await SA.appendSign({ bytes: cur, meta: { name: "Signer " + n, reason: "lần " + n }, prepare, append, signer: opensslSigner(mkCert(n)) });
      ok(`3b người ký thứ ${n}: ok (${r.ok ? "" : r.reason + " " + (r.detail || r.error || "")})`, r.ok);
      if (!r.ok) break;
      check(`3b người ký thứ ${n}: đếm được ${n} chữ ký`, r.signatures, n);
      ok(`3b người ký thứ ${n}: bắt đầu bằng đúng byte của lần trước`, r.bytes.subarray(0, cur.length).equals(cur));
      cur = Buffer.from(r.bytes);
      const f = path.join(W, `chain${n}.pdf`);
      fs.writeFileSync(f, cur);
      const v = verify(f);
      const nOk = (v.out.match(/HOP LE/g) || []).length;
      const nBad = (v.out.match(/HONG/g) || []).length;
      check(`3b OpenSSL sau người ký thứ ${n}: ${n} chữ ký HỢP LỆ, 0 hỏng`, [nOk, nBad, v.code], [n, 0, 0]);
      const q = spawnSync("D:\\GitHub\\_refs\\tools\\qpdf\\qpdf-12.4.2-msvc64\\bin\\qpdf.exe", ["--check", f], { encoding: "utf8" });
      if (!q.error) check(`3b qpdf --check sau người ký thứ ${n}: mã 0`, q.status, 0);
    }
    // tên trường duy nhất
    {
      const names = [...cur.toString("latin1").matchAll(/\/T\s*\(\s*(Signature\d+)\s*\)/g)].map((m) => m[1]);
      check("3c tên trường chữ ký không trùng nhau", [new Set(names).size === names.length, names.sort()], [true, ["Signature1", "Signature2", "Signature3", "Signature4"]]);
    }
    // đối chứng: lật MỘT byte trong phần cũ ⇒ trọng tài phải báo hỏng (không phải phép thử vô giá trị)
    {
      const t = Buffer.from(cur);
      t[100] ^= 1;
      const f = path.join(W, "tamper.pdf");
      fs.writeFileSync(f, t);
      check("3d đối chứng: lật 1 byte trong vùng ký ⇒ trọng tài báo HỎNG", verify(f).code, 1);
    }
    // tài liệu chưa ký ⇒ not_signed (đường cũ lo)
    {
      const unsigned = Buffer.from(await (await PDFDocument.create()).save());
      const r = await SA.appendSign({ bytes: unsigned, meta: {}, prepare, append, signer: opensslSigner(mkCert(9)) });
      check("3e tài liệu chưa ký ⇒ not_signed", r.reason, "not_signed");
    }
    // file gốc hỏng cấu trúc phía sau vùng ký ⇒ lõi từ chối, KHÔNG ký (PIN không bị hỏi)
    {
      const damaged = Buffer.concat([cur, Buffer.from("\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev 999999 >>\nstartxref\n12\n%%EOF\n")]);
      let signCalls = 0;
      const r = await SA.appendSign({ bytes: damaged, meta: {}, prepare: async (b) => prepare(b, {}), append, signer: { sign: async () => (signCalls++, Buffer.alloc(8)) } });
      ok(`3f file gốc có revision cuối hỏng ⇒ từ chối trước khi ký (${r.reason})`, !r.ok && signCalls === 0);
    }
    fs.rmSync(W, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
