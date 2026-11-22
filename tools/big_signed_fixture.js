// Dựng file ký NẶNG (mặc định ~150 MB, nhiều ảnh xám không nén ~8 MB/cái, mỗi ảnh một trang) + bản pdf-lib đã sửa (xoay trang 1).
//   node --max-old-space-size=6144 tools/big_signed_fixture.js <thư_mục_ra> [MB]
// Dùng với tools/big_route_probe.py. Nhớ XOÁ thư mục ra sau khi đo (hơn 300 MB).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const DESK = "D:\\GitHub\\ContractOCR\\desktop";
const nm = (p) => require(path.join(DESK, "node_modules", p));
const { PDFDocument, PDFName } = nm("pdf-lib");
const { pdflibAddPlaceholder } = nm("@signpdf/placeholder-pdf-lib");
const signpdf = nm("@signpdf/signpdf").default;
const { Signer, SUBFILTER_ADOBE_PKCS7_DETACHED } = nm("@signpdf/utils");
const lib = require(path.join(DESK, "renderer", "vendor", "pdf-lib.min.js"));
require(path.join(DESK, "renderer", "pdflib-stream-length.js")).applyStreamLengthFix(lib);

const out = process.argv[2];
const MB = Number(process.argv[3] || 150);
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-big-"));
function sh(a) {
  const r = spawnSync("openssl", a, { encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r;
}
const key = path.join(tmp, "k.pem"), crt = path.join(tmp, "c.pem");
sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", "/CN=Big"]);
class S extends Signer {
  async sign(buf) {
    const inp = path.join(tmp, "in.bin");
    fs.writeFileSync(inp, buf);
    return Buffer.from(sh(["cms", "-sign", "-binary", "-in", inp, "-signer", crt, "-inkey", key, "-outform", "DER", "-md", "sha256"]).stdout);
  }
}
(async () => {
  const t0 = Date.now();
  const doc = await PDFDocument.create();
  // Nhiều ảnh xám 8-bit KHÔNG nén ~ 8 MB mỗi cái: nhiều object lớn (đúng dạng bản vẽ/scan), vài chục trang.
  const per = 8 * 1024 * 1024;
  const n = Math.ceil((MB * 1024 * 1024) / per);
  for (let i = 0; i < n; i++) {
    const bytes = Buffer.alloc(per);
    for (let j = 0; j < per; j += 4096) bytes.writeUInt32LE((i * 2654435761 + j) >>> 0, j); // không nén được đều, nhưng rẻ để sinh
    const img = doc.context.register(
      doc.context.stream(bytes, { Type: "XObject", Subtype: "Image", Width: 2896, Height: 2896, ColorSpace: "DeviceGray", BitsPerComponent: 8 })
    );
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of("Resources"), doc.context.obj({ XObject: { Im0: img } }));
    page.drawText("trang " + (i + 1), { x: 60, y: 780 });
  }
  pdflibAddPlaceholder({
    pdfDoc: doc, pdfPage: doc.getPage(0), reason: "t", contactInfo: "", name: "n", location: "l",
    signatureLength: 16384, subFilter: SUBFILTER_ADOBE_PKCS7_DETACHED, widgetRect: [0, 0, 0, 0], appName: "Nabu PDF",
  });
  const saved = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signed = Buffer.from(await signpdf.sign(saved, new S()));
  fs.writeFileSync(path.join(out, "big_signed.pdf"), signed);
  console.log(`dựng+ký: ${(signed.length / 1048576).toFixed(1)} MB, ${n} trang, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const t1 = Date.now();
  const ed = await lib.PDFDocument.load(signed, { ignoreEncryption: true, throwOnInvalidObject: false });
  ed.getPage(0).setRotation(lib.degrees(90));
  const edited = await ed.save();
  fs.writeFileSync(path.join(out, "big_edited.pdf"), edited);
  console.log(`pdf-lib mở+xoay+lưu: ${(edited.length / 1048576).toFixed(1)} MB, ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(2); });
