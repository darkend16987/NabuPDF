// Dựng bộ thử CHỐT 5 (BI-131) cho "Lưu nối thêm": một file ĐÃ KÝ THẬT + các bản "đã sửa" đúng như app tạo ra.
//
//   node tools/signed_fixture.js <thư_mục_ra>
//
// Ký bằng ĐÚNG đường mà app dùng (signing-worker.js): pdf-lib + @signpdf (`pdflibAddPlaceholder`, lưu KHÔNG object
// stream, `signpdf.sign`), chỉ khác Signer: thay vì token USB qua helper .NET, ta ký bằng OpenSSL với một chứng thư TỰ KÝ
// dùng-một-lần (PKCS#7 tách rời, SHA-256) — vì ta cần một chữ ký mà một trọng tài ĐỘC LẬP (OpenSSL, xem
// tools/verify_pdf_signatures.py) kiểm được bằng toán, không phụ thuộc vào mã của chính app.
//
// "Bản đã sửa" = đúng thứ renderer có trong state.bytes sau một thao tác: pdf-lib (BẢN VENDOR của renderer + bản vá BI-120)
// mở file đã ký → sửa → doc.save() (mặc định, có object stream). Ghi ra `edit_<tên>.pdf`.
//
// Thoát 0 = đã ghi; in danh sách tệp ra stdout (JSON).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DESK = path.join(ROOT, "desktop");
// Ký: thư viện trong node_modules (như signing-worker.js, chạy ở main). Sửa: bản vendor của renderer (như app.js).
const nm = (p) => require(path.join(DESK, "node_modules", p));
const { PDFDocument: SignDoc, StandardFonts: SignFonts, degrees: signDegrees } = nm("pdf-lib");
const { pdflibAddPlaceholder } = nm("@signpdf/placeholder-pdf-lib");
const signpdf = nm("@signpdf/signpdf").default;
const { Signer, SUBFILTER_ADOBE_PKCS7_DETACHED } = nm("@signpdf/utils");
const lib = require(path.join(DESK, "renderer", "vendor", "pdf-lib.min.js"));
require(path.join(DESK, "renderer", "pdflib-stream-length.js")).applyStreamLengthFix(lib);

const OPENSSL = process.env.OPENSSL || "openssl";
const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  console.error("Cách dùng: node tools/signed_fixture.js <thư_mục_ra>");
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

function sh(args, opt) {
  const r = spawnSync(OPENSSL, args, { encoding: "buffer", ...opt });
  if (r.status !== 0) throw new Error("openssl " + args.slice(0, 2).join(" ") + " lỗi: " + String(r.stderr || r.error));
  return r;
}

function makeCert(dir) {
  const key = path.join(dir, "key.pem");
  const crt = path.join(dir, "cert.pem");
  sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", "/CN=Nabu Test Signer/O=Nabu"]);
  return { key, crt };
}

class OpenSslSigner extends Signer {
  constructor(c) {
    super();
    this.c = c;
  }
  async sign(pdfBuffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-sign-"));
    try {
      const inp = path.join(dir, "in.bin");
      fs.writeFileSync(inp, pdfBuffer);
      // Mặc định của `cms -sign` là TÁCH RỜI (nội dung không nằm trong PKCS#7) — đúng thứ /adbe.pkcs7.detached cần.
      const r = sh(["cms", "-sign", "-binary", "-in", inp, "-signer", this.c.crt, "-inkey", this.c.key, "-outform", "DER", "-md", "sha256"]);
      return Buffer.from(r.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// Tài liệu gốc: 4 trang có chữ, một ô nhập + một ô tick (để thử điền form), một ảnh nhỏ.
async function baseDoc() {
  const doc = await SignDoc.create();
  const font = await doc.embedFont(SignFonts.Helvetica);
  for (let i = 1; i <= 4; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Hop dong - trang ${i}`, { x: 60, y: 780, size: 20, font });
    p.drawText("Noi dung mat: SECRET-" + i, { x: 60, y: 740, size: 12, font });
  }
  // Tuỳ chọn cho test chữ ký NHÌN THẤY (BI-133): NABU_FIXTURE_ROTATE_PAGE=<chỉ số> xoay trang đó 90° TRƯỚC khi ký.
  if (process.env.NABU_FIXTURE_ROTATE_PAGE) doc.getPage(Number(process.env.NABU_FIXTURE_ROTATE_PAGE)).setRotation(signDegrees(90));
  const form = doc.getForm();
  const tf = form.createTextField("ho_ten");
  tf.addToPage(doc.getPage(0), { x: 60, y: 650, width: 220, height: 22 });
  const cb = form.createCheckBox("dong_y");
  cb.addToPage(doc.getPage(0), { x: 60, y: 610, width: 18, height: 18 });
  return doc;
}

async function signedFile(cert) {
  const doc = await baseDoc();
  pdflibAddPlaceholder({
    pdfDoc: doc,
    pdfPage: doc.getPage(0),
    reason: "Thu nghiem",
    contactInfo: "",
    name: "Nabu Test",
    location: "VN",
    signatureLength: 16384,
    subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
    widgetRect: [0, 0, 0, 0], // chữ ký vô hình, như bản không có hình ảnh của app
    appName: "Nabu PDF",
  });
  const withPlaceholder = await doc.save({ useObjectStreams: false });
  return Buffer.from(await signpdf.sign(Buffer.from(withPlaceholder), new OpenSslSigner(cert)));
}

// Một "thao tác của người dùng" = hàm (doc) => void, chạy trên pdf-lib của renderer.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const EDITS = {
  rotate: async (d) => d.getPage(0).setRotation(lib.degrees(90)),
  text: async (d) => {
    const f = await d.embedFont(lib.StandardFonts.HelveticaBold);
    d.getPage(1).drawText("GHI CHU THEM", { x: 80, y: 500, size: 18, font: f, color: lib.rgb(1, 0, 0) });
  },
  rect: async (d) => d.getPage(2).drawRectangle({ x: 100, y: 300, width: 200, height: 60, color: lib.rgb(0, 0, 0) }),
  image: async (d) => {
    const img = await d.embedPng(PNG_1PX);
    d.getPage(0).drawImage(img, { x: 300, y: 500, width: 80, height: 80 });
  },
  meta: async (d) => {
    d.setTitle("Tieu de moi");
    d.setAuthor("Nguoi sua");
  },
  addpage: async (d) => d.addPage([300, 300]),
  delpage: async (d) => d.removePage(3),
  form: async (d) => {
    const f = d.getForm();
    f.getTextField("ho_ten").setText("Nguyen Van A");
    f.getCheckBox("dong_y").check();
  },
  multi: async (d) => {
    d.getPage(0).setRotation(lib.degrees(180));
    const f = await d.embedFont(lib.StandardFonts.Courier);
    d.getPage(1).drawText("nhieu thao tac", { x: 60, y: 400, size: 14, font: f });
    d.removePage(3);
    d.setTitle("Nhieu thao tac");
  },
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-cert-"));
  try {
    const cert = makeCert(tmp);
    const signed = await signedFile(cert);
    const signedPath = path.join(out, "signed.pdf");
    fs.writeFileSync(signedPath, signed);
    const files = { signed: signedPath, edits: {} };
    for (const [name, fn] of Object.entries(EDITS)) {
      const doc = await lib.PDFDocument.load(signed, { ignoreEncryption: true, throwOnInvalidObject: false });
      await fn(doc);
      const p = path.join(out, `edit_${name}.pdf`);
      fs.writeFileSync(p, await doc.save());
      files.edits[name] = p;
    }
    console.log(JSON.stringify(files));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error("FIXTURE_FAIL", e && e.stack ? e.stack : e);
  process.exit(2);
});
