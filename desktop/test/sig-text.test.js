"use strict";

// BI-134 — chữ có dấu trong từ điển chữ ký (src/sig-text.js + nối dây ở signing-worker.js / sign-append.js).
//
// LỖI GỐC (có từ trước): @signpdf/placeholder-pdf-lib ghi Reason/Name/Location/ContactInfo bằng PDFString.of(text), hàm CẮT ký tự
// Unicode về 1 byte ⇒ "Đồng ý" thành byte rác. Test này ghim cách sửa trên ba tầng:
//   1. encodeText / fixSignatureStrings trên pdf-lib THẬT (đọc lại bằng pdf-lib độc lập và bằng PyMuPDF — không dùng chính hàm sửa để chấm);
//   2. đường ký THẬT của worker, cả cổ điển (applySignature) lẫn ký nối thêm (applyAppendSignature), ký bằng OpenSSL, đọc lại chữ;
//   3. ghim cấu trúc: hai nơi gọi thư viện đều truyền chuỗi RỖNG rồi mới điền.
// Tầng 2 bỏ qua (có in) nếu máy thiếu openssl / .venv. Run:  node desktop/test/sig-text.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const SigText = require("../src/sig-text");

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

const nm = (p) => require(path.join(__dirname, "..", "node_modules", p));
const pdflib = nm("pdf-lib");
const { PDFDocument, PDFName, PDFDict, PDFHexString, PDFString, PDFInvalidObject, PDFArray } = pdflib;
const { pdflibAddPlaceholder } = nm("@signpdf/placeholder-pdf-lib");
const { SUBFILTER_ADOBE_PKCS7_DETACHED } = nm("@signpdf/utils");
const libs = { PDFHexString, PDFInvalidObject };

const TEXTS = {
  reason: "Đồng ý với điều khoản (phụ lục 2)",
  name: "Nguyễn Văn Ánh",
  location: "Hà Nội — Việt Nam",
  contactInfo: "ánh@công-ty.vn",
};

// đọc lại bằng pdf-lib ĐỘC LẬP với bản sửa: tìm từ điển /Type /Sig và giải mã bốn trường
function readSig(bytes) {
  return PDFDocument.load(bytes).then((doc) => {
    let found = null;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) && String(obj.get(PDFName.of("Type"))) === "/Sig") found = obj; // lấy cái cuối
    }
    if (!found) return null;
    const val = (k) => {
      const v = found.lookup(PDFName.of(k));
      return v && typeof v.decodeText === "function" ? v.decodeText() : v ? String(v) : null;
    };
    const appName = (() => {
      const pb = found.lookup(PDFName.of("Prop_Build"));
      const app = pb && pb.lookup(PDFName.of("App"));
      const n = app && app.lookup(PDFName.of("Name"));
      return n && typeof n.decodeText === "function" ? n.decodeText() : n ? String(n) : null;
    })();
    return { reason: val("Reason"), name: val("Name"), location: val("Location"), contactInfo: val("ContactInfo"), appName };
  });
}

async function withPlaceholder(fix) {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  pdflibAddPlaceholder({
    pdfDoc: doc, pdfPage: doc.getPage(0), reason: "", contactInfo: "", name: "", location: "",
    signatureLength: 256, subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED, widgetRect: [0, 0, 0, 0], appName: "Nabu PDF",
  });
  const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
  const widget = doc.context.lookup(fields.get(fields.size() - 1));
  const sigRef = widget.get(PDFName.of("V"));
  const result = fix ? fix(doc.context, sigRef) : null;
  return { bytes: await doc.save({ useObjectStreams: false }), result, doc, sigRef };
}

(async () => {
  // ---- 1a. encodeText ----------------------------------------------------------------------------------------
  const utf16 = (hexLiteral) => {
    const m = /^<FEFF([0-9A-F]*)>$/.exec(hexLiteral);
    if (!m) return null;
    return Buffer.from(m[1], "hex").swap16().toString("utf16le");
  };
  check("1a rỗng ⇒ ()", [SigText.encodeText("", libs), SigText.encodeText(null, libs), SigText.encodeText(undefined, libs)], ["()", "()", "()"]);
  check("1a ASCII an toàn ⇒ chuỗi thường", SigText.encodeText("Dong y, Ha Noi 2026-11-22 a@b.vn", libs), "(Dong y, Ha Noi 2026-11-22 a@b.vn)");
  for (const t of ["Đồng ý", "Hà Nội", "ơ", "ý", "Ǆ", "日本語", "😀 emoji ngoài BMP", "tab\there", "dòng\nmới", "a(b", "a)b", "a\\b", "((", "(", ")", "\\", "<>", "%", "# tên"]) {
    const enc = SigText.encodeText(t, libs);
    check(`1a "${t.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}" ⇒ hex UTF-16BE có BOM, giải mã lại đúng`, utf16(enc), t);
  }
  ok("1a ngoặc/gạch chéo ngược KHÔNG bao giờ lọt vào chuỗi thường (sẽ làm hỏng cú pháp PDF)", !/^\(.*[()\\].*\)$/.test(SigText.encodeText("a(b", libs)) && SigText.encodeText("a(b", libs).startsWith("<FEFF"));

  // ---- 1b. trên pdf-lib thật, đọc lại độc lập ---------------------------------------------------------------
  {
    const { bytes, result } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, TEXTS, libs));
    check("1b trả true khi đã ghi", result, true);
    const r = await readSig(bytes);
    check("1b đọc lại bằng pdf-lib: cả bốn trường giữ nguyên tiếng Việt", [r.reason, r.name, r.location, r.contactInfo], [TEXTS.reason, TEXTS.name, TEXTS.location, TEXTS.contactInfo]);
    check("1b /Name của /Prop_Build (App) KHÔNG bị đụng", r.appName, "Nabu PDF");
    const txt = Buffer.from(bytes).toString("latin1");
    ok("1b /ByteRange và /Contents của chỗ giữ chữ ký còn nguyên (ký được)", /\/ByteRange\s*\[\s*0\s*\/\*{10}\s*\/\*{10}\s*\/\*{10}\s*\]/.test(txt) && /\/Contents\s*<\u0000+>|\/Contents\s*<0+>/.test(txt));
  }
  {
    // chỉ một vài trường, một trường ASCII
    const { bytes, result } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, { reason: "Dong y", location: "Hà Nội" }, libs));
    const r = await readSig(bytes);
    check("1c chỉ một số trường: phần còn lại rỗng, ASCII đúng, có dấu đúng", [result, r.reason, r.location, r.name, r.contactInfo], [true, "Dong y", "Hà Nội", "", ""]);
    const txt = Buffer.from(bytes).toString("latin1");
    ok("1c ASCII ghi dạng chuỗi thường (không phình hex vô ích)", /\/Reason\s*\(Dong y\)/.test(txt));
  }
  {
    const { result, bytes } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, {}, libs));
    check("1d không có chữ nào ⇒ false, object không đổi", result, false);
    const r = await readSig(bytes);
    check("1d … các trường vẫn rỗng", [r.reason, r.name, r.location, r.contactInfo], ["", "", "", ""]);
    const w2 = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, { reason: "", name: null, location: undefined }, libs));
    check("1d toàn giá trị rỗng/null/undefined ⇒ false", w2.result, false);
  }
  {
    // gọi lần hai (đã điền): không còn chỗ trống ⇒ false, giữ nguyên giá trị lần đầu
    const { doc, sigRef } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, { reason: "Lần một" }, libs));
    const again = SigText.fixSignatureStrings(doc.context, sigRef, { reason: "Lần hai" }, libs);
    const r = await readSig(await doc.save({ useObjectStreams: false }));
    check("1e gọi lần hai không ghi đè giá trị đã điền (dạng hex)", [again, r.reason], [false, "Lần một"]);
  }
  {
    // dạng CHUỖI THƯỜNG "(Lan mot)": mẫu tìm chỗ trống phải chỉ khớp "()" — nếu khớp cả "(…)" thì lần gọi thứ hai sẽ đè lên
    const { doc, sigRef } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, { reason: "Lan mot", location: "Ha Noi" }, libs));
    const again = SigText.fixSignatureStrings(doc.context, sigRef, { reason: "Lan hai", location: "Hue", name: "Tên mới" }, libs);
    const r = await readSig(await doc.save({ useObjectStreams: false }));
    check("1e giá trị ASCII đã điền không bị đè; chỗ còn TRỐNG (name) vẫn được điền", [again, r.reason, r.location, r.name], [true, "Lan mot", "Ha Noi", "Tên mới"]);
  }
  {
    // không ném lỗi với đầu vào xấu
    let threw = false;
    const outs = [];
    try {
      outs.push(SigText.fixSignatureStrings({ lookup: () => { throw new Error("x"); }, assign() {} }, {}, TEXTS, libs));
      outs.push(SigText.fixSignatureStrings({ lookup: () => null, assign() {} }, {}, TEXTS, libs));
      outs.push(SigText.fixSignatureStrings({ lookup: () => ({ data: "không phải Uint8Array" }), assign() {} }, {}, TEXTS, libs));
      outs.push(SigText.fixSignatureStrings({ lookup: () => ({ data: Buffer.from("<< /Reason () >>") }), assign() { throw new Error("assign hỏng"); } }, {}, TEXTS, libs));
      outs.push(SigText.fixSignatureStrings({ lookup: () => ({ data: Buffer.from("<< /Reason () >>") }), assign() {} }, {}, TEXTS, {})); // thiếu PDFHexString
    } catch (_) {
      threw = true;
    }
    check("1f đầu vào xấu: KHÔNG ném (metadata không bao giờ làm hỏng việc ký), trả false", [threw, outs], [false, [false, false, false, false, false]]);
  }
  {
    // chữ rất dài và nhiều dòng
    const long = "Đ".repeat(3000) + "\n" + "ý".repeat(500);
    const { bytes } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, { reason: long }, libs));
    check("1g chữ dài 3.500 ký tự có dấu + xuống dòng giữ nguyên", (await readSig(bytes)).reason, long);
  }

  // ---- 1h. PyMuPDF (độc lập thứ hai) --------------------------------------------------------------------------
  const ROOT = path.join(__dirname, "..", "..");
  const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
  const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: "ignore" }).status === 0; } catch (_) { return false; } };
  const havePy = fs.existsSync(PY);
  const W = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-sigtext-"));
  const fitzRead = (file) => {
    const code = "import fitz,sys,json\nd=fitz.open(sys.argv[1])\nout=None\nfor x in range(1,d.xref_length()):\n  try:\n    o=d.xref_object(x,compressed=False)\n  except Exception:\n    continue\n  if '/Type/Sig' in o.replace(' ','') and '/ByteRange' in o:\n    out={k:d.xref_get_key(x,k)[1] for k in ['Reason','Name','Location','ContactInfo']}\nprint(json.dumps(out,ensure_ascii=False))";
    const r = spawnSync(PY, ["-c", code, file], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    return JSON.parse(r.stdout.trim() || "null");
  };
  if (havePy) {
    const { bytes } = await withPlaceholder((ctx, ref) => SigText.fixSignatureStrings(ctx, ref, TEXTS, libs));
    const f = path.join(W, "x.pdf");
    fs.writeFileSync(f, bytes);
    const r = fitzRead(f);
    check("1h PyMuPDF (đọc độc lập) giải mã đúng cả bốn trường", [r.Reason, r.Name, r.Location, r.ContactInfo], [TEXTS.reason, TEXTS.name, TEXTS.location, TEXTS.contactInfo]);
  } else {
    console.log("(bỏ qua 1h: thiếu .venv)");
  }

  // ---- 2. đường ký THẬT -------------------------------------------------------------------------------------------
  if (!(havePy && has("openssl", ["version"]) && fs.existsSync(path.join(ROOT, "tools", "signed_fixture.js")))) {
    console.log("(bỏ qua tầng 2: thiếu .venv / openssl)");
  } else {
    process.parentPort = undefined;
    const worker = require("../src/signing-worker");
    const sh = (cmd, args, o) => { const r = spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 1 << 28, ...o }); if (r.status !== 0) throw new Error(cmd + " lỗi: " + String(r.stderr).slice(0, 300)); return r; };
    const key = path.join(W, "k.pem"), crt = path.join(W, "c.pem");
    sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", "/CN=SigText Signer"]);
    const { Signer } = nm("@signpdf/utils");
    class OsslSigner extends Signer {
      async sign(buf) { const inp = path.join(W, "in.bin"); fs.writeFileSync(inp, buf); return Buffer.from(sh("openssl", ["cms", "-sign", "-binary", "-in", inp, "-signer", crt, "-inkey", key, "-outform", "DER", "-md", "sha256"]).stdout); }
    }
    const verify = (file) => { const r = spawnSync(PY, [path.join(ROOT, "tools", "verify_pdf_signatures.py"), file], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); return { ok: (r.stdout.match(/HOP LE/g) || []).length, bad: (r.stdout.match(/HONG/g) || []).length }; };

    // 2a. đường cổ điển trên một tài liệu chưa ký
    const plain = await PDFDocument.create();
    plain.addPage([300, 300]).drawText("x");
    const r1 = await worker.applySignature({ bytes: new Uint8Array(await plain.save()), thumbprint: "T", meta: { ...TEXTS } }, { signer: new OsslSigner() });
    ok("2a đường cổ điển: ký được" + (r1.ok ? "" : " — " + r1.reason + " " + r1.error), r1.ok);
    if (r1.ok) {
      const f = path.join(W, "classic.pdf");
      fs.writeFileSync(f, r1.bytes);
      check("2a OpenSSL: chữ ký hợp lệ (chữ có dấu KHÔNG làm hỏng việc ký)", verify(f), { ok: 1, bad: 0 });
      const r = await readSig(r1.bytes);
      check("2a pdf-lib đọc lại: đủ bốn trường tiếng Việt", [r.reason, r.name, r.location, r.contactInfo], [TEXTS.reason, TEXTS.name, TEXTS.location, TEXTS.contactInfo]);
      const fr = fitzRead(f);
      check("2a PyMuPDF đọc lại: đủ bốn trường tiếng Việt", [fr.Reason, fr.Name, fr.Location, fr.ContactInfo], [TEXTS.reason, TEXTS.name, TEXTS.location, TEXTS.contactInfo]);
    }
    // 2b. đường KÝ NỐI THÊM trên tài liệu đã ký
    const fx = JSON.parse(sh("node", [path.join(ROOT, "tools", "signed_fixture.js"), path.join(W, "fx")], { encoding: "utf8" }).stdout.toString().trim().split(/\r?\n/).pop());
    const base = fs.readFileSync(fx.signed);
    const append = async (origPath, edited) => {
      const ed = path.join(W, "edited.pdf"), out = path.join(W, "merged.pdf");
      fs.writeFileSync(ed, edited);
      const r = spawnSync(PY, [path.join(ROOT, "sidecar.py"), "--incremental-worker", origPath, ed, out], { encoding: "utf8" });
      if (r.status !== 0) return { ok: false, reason: ((r.stderr || "").split("\t")[0] || "worker_failed").trim() };
      return { ok: true, bytes: fs.readFileSync(out) };
    };
    const r2 = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: { ...TEXTS } }, { signer: new OsslSigner(), append });
    ok("2b ký nối thêm: ký được" + (r2.ok ? "" : " — " + r2.reason + " " + r2.error), r2.ok);
    if (r2.ok) {
      const f = path.join(W, "append.pdf");
      fs.writeFileSync(f, r2.bytes);
      check("2b OpenSSL: 2 chữ ký hợp lệ", verify(f), { ok: 2, bad: 0 });
      const fr = fitzRead(f); // PyMuPDF: chữ ký CUỐI (cái in sau cùng) — chữ ký của revision mới
      check("2b PyMuPDF đọc lại chữ ký MỚI: đủ bốn trường tiếng Việt", [fr.Reason, fr.Name, fr.Location, fr.ContactInfo], [TEXTS.reason, TEXTS.name, TEXTS.location, TEXTS.contactInfo]);
      const r = await readSig(r2.bytes);
      check("2b pdf-lib đọc lại chữ ký mới: đủ bốn trường tiếng Việt", [r.reason, r.name, r.location, r.contactInfo], [TEXTS.reason, TEXTS.name, TEXTS.location, TEXTS.contactInfo]);
    }
    // 2c. không có chữ nào (người dùng để trống): vẫn ký được, trường rỗng
    const r3 = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: {} }, { signer: new OsslSigner(), append });
    ok("2c để trống lý do/nơi ký: vẫn ký nối thêm được", r3.ok);
  }
  fs.rmSync(W, { recursive: true, force: true });

  // ---- 3. ghim cấu trúc -------------------------------------------------------------------------------------------
  const rd = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8").replace(/\r\n/g, "\n");
  const WORKER = rd("src", "signing-worker.js");
  const SA = rd("src", "sign-append.js");
  const callBlock = (src, from) => { const a = src.indexOf(from); return src.slice(a, src.indexOf("});", a)); };
  const c1 = callBlock(WORKER, "  pdflibAddPlaceholder({\n    pdfDoc,");
  ok('3a đường cổ điển: gọi thư viện với chuỗi RỖNG (reason/contactInfo/name/location đều "")', /reason: "",\s*contactInfo: "",\s*name: "",\s*location: "",/.test(c1), c1.slice(0, 300));
  ok("3a … rồi điền chữ đúng bằng SigText.fixSignatureStrings", /SigText\.fixSignatureStrings\(\s*pdfDoc\.context,\s*sigWidget\.get\(PDFName\.of\("V"\)\)/.test(WORKER));
  const c2 = callBlock(SA, "    pdflibAddPlaceholder({\n      pdfDoc: doc,");
  ok('3b ký nối thêm: gọi thư viện với chuỗi RỖNG', /reason: "",\s*contactInfo: "",\s*name: "",\s*location: "",/.test(c2), c2.slice(0, 300));
  ok("3b … rồi điền chữ đúng TRƯỚC khi đổi NUL→'0' (đọc object sau khi đã thay)", SA.indexOf("SigText.fixSignatureStrings(doc.context, sigRef") > 0 && SA.indexOf("SigText.fixSignatureStrings(doc.context, sigRef") < SA.indexOf("const inv = doc.context.lookup(sigRef)"));
  ok("3c worker truyền PDFHexString cho cả hai đường", /PDFHexString/.test(WORKER.slice(0, 1200)) && /PDFString, PDFHexString, PDFInvalidObject, pdflibAddPlaceholder/.test(WORKER) && /\{ PDFHexString, PDFInvalidObject \}/.test(WORKER));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
