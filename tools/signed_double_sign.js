// Đo (BI-131): ký LẦN HAI bằng đúng đường của app (signing-worker.applySignature) lên file ĐÃ KÝ — chữ ký thứ nhất còn không?
//   node tools/signed_double_sign.js <thư_mục_ra>      rồi:  python tools/verify_pdf_signatures.py <ra>/*.pdf
// Kết quả đã đo (2026-11-22): file sau KHÔNG bắt đầu bằng byte file đã ký, cả vùng đầu lẫn đuôi của chữ ký 1 đã đổi ⇒ chỉ còn MỘT chữ ký hợp lệ.
// lên một file ĐÃ KÝ — chữ ký thứ nhất còn hợp lệ theo OpenSSL không?
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const DESK = "D:\\GitHub\\ContractOCR\\desktop";
const nm = (p) => require(path.join(DESK, "node_modules", p));
const { PDFDocument } = nm("pdf-lib");
const { pdflibAddPlaceholder } = nm("@signpdf/placeholder-pdf-lib");
const signpdf = nm("@signpdf/signpdf").default;
const { Signer, SUBFILTER_ADOBE_PKCS7_DETACHED } = nm("@signpdf/utils");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-dbl-"));
function sh(a) {
  const r = spawnSync("openssl", a, { encoding: "buffer" });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r;
}
function cert(n) {
  const key = path.join(tmp, `k${n}.pem`), crt = path.join(tmp, `c${n}.pem`);
  sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", `/CN=Signer ${n}`]);
  return { key, crt };
}
class S extends Signer {
  constructor(c) { super(); this.c = c; }
  async sign(buf) {
    const inp = path.join(tmp, "in.bin");
    fs.writeFileSync(inp, buf);
    return Buffer.from(sh(["cms", "-sign", "-binary", "-in", inp, "-signer", this.c.crt, "-inkey", this.c.key, "-outform", "DER", "-md", "sha256"]).stdout);
  }
}
async function signOnce(bytes, c, opts = {}) {
  const doc = await PDFDocument.load(bytes);
  pdflibAddPlaceholder({
    pdfDoc: doc, pdfPage: doc.getPage(0), reason: "t", contactInfo: "", name: "n", location: "l",
    signatureLength: 16384, subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED, widgetRect: [0, 0, 0, 0], appName: "Nabu PDF",
  });
  const saved = await doc.save({ useObjectStreams: false });
  return Buffer.from(await signpdf.sign(Buffer.from(saved), new S(c)));
}
(async () => {
  const base = await PDFDocument.create();
  for (let i = 1; i <= 3; i++) base.addPage([595, 842]).drawText("trang " + i, { x: 60, y: 780 });
  const c1 = cert(1), c2 = cert(2);
  const s1 = await signOnce(Buffer.from(await base.save({ useObjectStreams: false })), c1);
  const s2 = await signOnce(s1, c2);
  const out = process.argv[2];
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "sig1.pdf"), s1);
  fs.writeFileSync(path.join(out, "sig1+sig2_F3.pdf"), s2);
  console.log("starts-with-original (sig2 file begins with sig1 file bytes):", s2.subarray(0, s1.length).equals(s1));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(2); });
