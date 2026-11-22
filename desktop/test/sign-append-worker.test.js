"use strict";

// BI-133 — `applyAppendSignature` của signing-worker.js (đường KÝ NỐI THÊM thật, trừ token và HTTP):
//   · nạp worker ngay trong node (process.parentPort vắng ⇒ vòng tin nhắn không đăng ký) rồi gọi hàm với
//     signer = OpenSSL (thay token USB) và append = lõi ghi nối Python qua tiến trình con (thay HTTP tới sidecar);
//   · trọng tài ĐỘC LẬP: tools/verify_pdf_signatures.py (OpenSSL) + PyMuPDF đọc lại trường chữ ký;
//   · ghim: mọi lỗi ghi nối xảy ra TRƯỚC khi signer (hộp PIN) bị gọi.
// Bỏ qua (có in) nếu máy thiếu openssl / .venv / node_modules. Run:  node desktop/test/sign-append-worker.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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

const ROOT = path.join(__dirname, "..", "..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: "ignore" }).status === 0; } catch (_) { return false; } };
if (!(fs.existsSync(PY) && has("openssl", ["version"]) && fs.existsSync(path.join(__dirname, "..", "node_modules", "pdf-lib")))) {
  console.log("(bỏ qua: thiếu .venv / openssl / node_modules)");
  process.exit(0);
}

process.parentPort = undefined; // ngoài utilityProcess: worker không đăng ký vòng tin nhắn
const worker = require("../src/signing-worker");

const W = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signworker-"));
const sh = (cmd, args, opt) => { const r = spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 1 << 28, ...opt }); if (r.status !== 0) throw new Error(cmd + " lỗi: " + String(r.stderr).slice(0, 300)); return r; };
let cn = 0;
const mkSigner = () => {
  const n = ++cn;
  const key = path.join(W, `k${n}.pem`), crt = path.join(W, `c${n}.pem`);
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", `/CN=Worker Signer ${n}`]);
  const s = { calls: 0, sign: async (buf) => { s.calls++; const inp = path.join(W, "in.bin"); fs.writeFileSync(inp, buf); return sh("openssl", ["cms", "-sign", "-binary", "-in", inp, "-signer", crt, "-inkey", key, "-outform", "DER", "-md", "sha256"]).stdout; } };
  return s;
};
const append = async (origPath, edited) => {
  const ed = path.join(W, "edited.pdf"), out = path.join(W, "merged.pdf");
  fs.writeFileSync(ed, edited);
  const r = spawnSync(PY, [path.join(ROOT, "sidecar.py"), "--incremental-worker", origPath, ed, out], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, reason: ((r.stderr || "").split("\t")[0] || "worker_failed").trim() };
  return { ok: true, bytes: fs.readFileSync(out) };
};
const verify = (file) => { const r = spawnSync(PY, [path.join(ROOT, "tools", "verify_pdf_signatures.py"), file], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); return { code: r.status, ok: (r.stdout.match(/HOP LE/g) || []).length, bad: (r.stdout.match(/HONG/g) || []).length }; };
const fixture = (dir, env) => JSON.parse(sh("node", [path.join(ROOT, "tools", "signed_fixture.js"), path.join(W, dir)], { encoding: "utf8", env: { ...process.env, ...(env || {}) } }).stdout.toString().trim().split(/\r?\n/).pop());
const sigWidgets = (file) => {
  const code = "import fitz,sys,json\nd=fitz.open(sys.argv[1])\nout=[]\nfor pg in d:\n  for w in (pg.widgets() or []):\n    if w.field_type_string=='Signature': out.append([pg.number,w.field_name,[round(v) for v in w.rect]])\nprint(json.dumps(out))";
  const r = spawnSync(PY, ["-c", code, file], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  return JSON.parse(r.stdout.trim());
};
// PNG 1×1 đỏ
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

(async () => {
  const fx = fixture("fx", {});
  const base = fs.readFileSync(fx.signed);
  check("0 file ký nền: OpenSSL hợp lệ", verify(fx.signed), { code: 0, ok: 1, bad: 0 });

  // 1. chữ ký vô hình
  {
    const sg = mkSigner();
    const r = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: { name: "Nguoi ky hai", reason: "Dong y", location: "Ha Noi" } }, { signer: sg, append });
    ok("1a ký nối thêm vô hình: ok + appended" + (r.ok ? "" : " — " + r.reason + " " + r.error), r.ok && r.appended === true);
    if (r.ok) {
      const f = path.join(W, "out1.pdf");
      fs.writeFileSync(f, r.bytes);
      check("1b OpenSSL: 2 chữ ký HỢP LỆ, 0 hỏng", verify(f), { code: 0, ok: 2, bad: 0 });
      ok("1c bắt đầu bằng đúng byte file ký", Buffer.from(r.bytes).subarray(0, base.length).equals(base));
      check("1d trường chữ ký: Signature1 + Signature2 (không trùng)", sigWidgets(f).map((w) => w[1]), ["Signature1", "Signature2"]);
      check("1e signer (token) được gọi đúng 1 lần", sg.calls, 1);
      const txt = Buffer.from(r.bytes).toString("latin1");
      // ASCII có chủ ý: pdf-lib PDFString.of CẮT ký tự Unicode về 1 byte (lỗi CÓ TỪ TRƯỚC, cả đường ký cổ điển) — xem BI-133.
      const rev = txt.slice(base.length);
      ok("1f lý do/nơi ký/tên của người ký MỚI nằm trong revision mới", /\/Reason\(Dong y\)/.test(rev) && /\/Location\(Ha Noi\)/.test(rev) && /\/Name\(Nguoi ky hai\)/.test(rev), rev.slice(rev.indexOf("/Type/Sig"), rev.indexOf("/Type/Sig") + 200).replace(/[^ -~]/g, "?"));
    }
  }

  // 2. chữ ký NHÌN THẤY (có hình): vị trí + AP
  {
    const sg = mkSigner();
    const rect = [60, 500, 260, 560];
    const r = await worker.applyAppendSignature(
      { bytes: new Uint8Array(base), thumbprint: "T", meta: { name: "N" }, appearance: { pageIndex: 1, rect, imagePng: PNG } },
      { signer: sg, append }
    );
    ok("2a chữ ký nhìn thấy: ok" + (r.ok ? "" : " — " + r.reason + " " + r.error), r.ok);
    if (r.ok) {
      const f = path.join(W, "out2.pdf");
      fs.writeFileSync(f, r.bytes);
      check("2b OpenSSL: 2 chữ ký hợp lệ", verify(f), { code: 0, ok: 2, bad: 0 });
      const w = sigWidgets(f).find((x) => x[1] === "Signature2");
      ok("2c widget Signature2 nằm ở TRANG 2 (chỉ số 1)", w && w[0] === 1, JSON.stringify(sigWidgets(f)));
      // PyMuPDF dùng toạ độ gốc trên-trái: x giữ nguyên, y = 842 - y_pdf
      check("2d … đúng khung đã vẽ (60,282)-(260,342)", w && w[2], [60, 282, 260, 342]);
      ok("2e có luồng hiển thị (AP) cho widget mới: có XObject ảnh trong revision mới", Buffer.from(r.bytes).subarray(base.length).includes("/NabuSig"));
    }
  }

  // 3. trang xoay + chữ ký nhìn thấy ⇒ từ chối TRƯỚC khi gọi token
  {
    const fr = fixture("fxrot", { NABU_FIXTURE_ROTATE_PAGE: "1" });
    const sg = mkSigner();
    const r = await worker.applyAppendSignature(
      { bytes: new Uint8Array(fs.readFileSync(fr.signed)), thumbprint: "T", meta: {}, appearance: { pageIndex: 1, rect: [10, 10, 100, 50], imagePng: PNG } },
      { signer: sg, append }
    );
    check("3a trang xoay + chữ ký nhìn thấy ⇒ reason 'rotated', token KHÔNG được gọi", [r.ok, r.reason, sg.calls], [false, "rotated", 0]);
    const r2 = await worker.applyAppendSignature({ bytes: new Uint8Array(fs.readFileSync(fr.signed)), thumbprint: "T", meta: {} }, { signer: mkSigner(), append });
    check("3b cùng tài liệu, chữ ký VÔ HÌNH ⇒ được (xoay chỉ cản chữ ký nhìn thấy, như đường cũ)", r2.ok, true);
  }

  // 4. mọi lỗi trước PIN: token không được gọi
  {
    const sg = mkSigner();
    const r = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: {} }, { signer: sg, append: async () => ({ ok: false, reason: "repaired", detail: "xref" }) });
    check("4a lõi từ chối ⇒ reason đi qua, token KHÔNG được gọi", [r.ok, r.reason, sg.calls], [false, "repaired", 0]);
    const r2 = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: {} }, { signer: sg });
    check("4b không có sidecar và không tiêm append ⇒ sidecar_unavailable, token không được gọi", [r2.ok, r2.reason, sg.calls], [false, "sidecar_unavailable", 0]);
    const r3 = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: {}, sidecar: { port: 1 } }, { signer: sg });
    ok("4c sidecar có cổng nhưng chết ⇒ ok:false, token không được gọi", !r3.ok && sg.calls === 0, JSON.stringify(r3));
    const r4 = await worker.applyAppendSignature({ thumbprint: "T" }, { signer: sg, append });
    check("4d thiếu bytes ⇒ other", [r4.ok, r4.reason], [false, "other"]);
    const r5 = await worker.applyAppendSignature({ bytes: new Uint8Array(base) }, { signer: sg, append });
    check("4e thiếu thumbprint ⇒ other", [r5.ok, r5.reason], [false, "other"]);
    const unsigned = fs.readFileSync(path.join(W, "fx", "edit_rotate.pdf")); // pdf-lib đã dựng lại: không còn chữ ký
    const r6 = await worker.applyAppendSignature({ bytes: new Uint8Array(unsigned), thumbprint: "T", meta: {} }, { signer: sg, append });
    check("4f tài liệu không còn chữ ký ⇒ not_signed", [r6.ok, r6.reason, sg.calls], [false, "not_signed", 0]);
  }

  // 5. lỗi từ token đi qua nguyên vẹn (renderer giải thích: cancelled / no_cert / tsa)
  for (const reason of ["cancelled", "no_cert", "tsa"]) {
    const e = new Error("helper: " + reason);
    e.reason = reason;
    const r = await worker.applyAppendSignature({ bytes: new Uint8Array(base), thumbprint: "T", meta: {} }, { signer: { sign: async () => { throw e; } }, append });
    check("5 token báo '" + reason + "' ⇒ reason đi qua, ok:false", [r.ok, r.reason], [false, reason]);
  }

  fs.rmSync(W, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
