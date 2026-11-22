// Chốt cho "ký nối thêm" (BI-133): chuỗi NHIỀU NGƯỜI KÝ liên tiếp qua đường THẬT trừ token USB.
//
//   node tools/sign_append_e2e.js [--exe D:\...\sidecar.exe] [--signers 4] [--keep <thư_mục>]
//
// Đi đúng đường của app: signing-worker.applyAppendSignature (pdf-lib dựng chỗ giữ chữ ký) → HTTP tới sidecar THẬT
// (`/save-incremental-bin`, tiến trình con, hạn giờ) → điền ByteRange → ký. Chỉ khác app ở Signer: OpenSSL + chứng thư
// tự ký thay cho token USB (helper .NET cần chứng thư trong Windows cert store). Trọng tài ĐỘC LẬP: OpenSSL
// (tools/verify_pdf_signatures.py) + qpdf + PyMuPDF — không dùng mã nào của app để chấm.
//
// Kỳ vọng: sau người ký thứ k có ĐÚNG k chữ ký, TẤT CẢ hợp lệ; file bắt đầu bằng đúng byte của lần trước; qpdf mã 0;
// tên trường duy nhất. `--exe` PHẢI là đường tuyệt đối. Thoát 0 nếu mọi ca đạt.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const QPDF = process.env.QPDF || "D:\\GitHub\\_refs\\tools\\qpdf\\qpdf-12.4.2-msvc64\\bin\\qpdf.exe";
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const EXE = opt("--exe", "");
const N = Number(opt("--signers", 4));
const KEEP = opt("--keep", "");
if (EXE && !path.isAbsolute(EXE)) { console.error("--exe phải là đường dẫn TUYỆT ĐỐI"); process.exit(2); }

process.parentPort = undefined;
const worker = require(path.join(ROOT, "desktop", "src", "signing-worker.js"));
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

const W = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signappend-e2e-"));
const sh = (cmd, a, o) => { const r = spawnSync(cmd, a, { encoding: "buffer", maxBuffer: 1 << 28, ...o }); if (r.status !== 0) throw new Error(cmd + " lỗi: " + String(r.stderr).slice(0, 300)); return r; };
let cn = 0;
function mkSigner() {
  const n = ++cn;
  const key = path.join(W, `k${n}.pem`), crt = path.join(W, `c${n}.pem`);
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", `/CN=E2E Signer ${n}`]);
  return { sign: async (buf) => { const inp = path.join(W, "in.bin"); fs.writeFileSync(inp, buf); return sh("openssl", ["cms", "-sign", "-binary", "-in", inp, "-signer", crt, "-inkey", key, "-outform", "DER", "-md", "sha256"]).stdout; } };
}
const verify = (f) => { const r = spawnSync(PY, [path.join(ROOT, "tools", "verify_pdf_signatures.py"), f], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); return { ok: (r.stdout.match(/HOP LE/g) || []).length, bad: (r.stdout.match(/HONG/g) || []).length }; };
const fieldNames = (f) => {
  const code = "import fitz,sys,json\nd=fitz.open(sys.argv[1])\nprint(json.dumps(sorted(w.field_name for p in d for w in (p.widgets() or []) if w.field_type_string=='Signature')))";
  return JSON.parse(spawnSync(PY, ["-c", code, f], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }).stdout.trim());
};
const get = (port, p) => new Promise((res) => http.get({ host: "127.0.0.1", port, path: p, timeout: 2000 }, (r) => { r.resume(); res(r.statusCode); }).on("error", () => res(0)).on("timeout", function () { this.destroy(); res(0); }));

(async () => {
  const port = 8800 + Math.floor(Math.random() * 100);
  const env = { ...process.env }; delete env.SIDECAR_TOKEN;
  const cmd = EXE ? [EXE, "--port", String(port)] : [PY, path.join(ROOT, "sidecar.py"), "--port", String(port)];
  const sc = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: "ignore" });
  let bad = 0;
  const rows = [];
  const row = (name, okk, note) => { rows.push([name, okk ? "ĐẠT" : "SAI", note || ""]); if (!okk) bad++; };
  try {
    for (let i = 0; i < 240 && (await get(port, "/health")) !== 200; i++) await new Promise((r) => setTimeout(r, 1000));
    if ((await get(port, "/health")) !== 200) throw new Error("sidecar không lên");
    console.log(`sidecar: ${EXE || "sidecar.py (dev)"} @${port}`);

    const fx = JSON.parse(sh("node", [path.join(ROOT, "tools", "signed_fixture.js"), path.join(W, "fx")], { encoding: "utf8" }).stdout.toString().trim().split(/\r?\n/).pop());
    let cur = fs.readFileSync(fx.signed);
    console.log(`file ký nền: ${cur.length} B; OpenSSL ${JSON.stringify(verify(fx.signed))}\n`);

    for (let k = 2; k <= N + 1; k++) {
      const visible = k === 3; // một người ký có HÌNH hiển thị
      const t0 = Date.now();
      const r = await worker.applyAppendSignature(
        {
          bytes: new Uint8Array(cur),
          thumbprint: "T",
          meta: { name: "Signer " + k, reason: "ky lan " + k, location: "VN" },
          sidecar: { port, token: undefined },
          ...(visible ? { appearance: { pageIndex: 1, rect: [60, 500, 260, 560], imagePng: PNG } } : {}),
        },
        { signer: mkSigner() }
      );
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (!r.ok) { row(`người ký ${k}${visible ? " (nhìn thấy)" : ""}`, false, `${r.reason}: ${r.error}`); break; }
      const out = Buffer.from(r.bytes);
      const f = path.join(W, `s${k}.pdf`);
      fs.writeFileSync(f, out);
      const v = verify(f);
      const q = spawnSync(QPDF, ["--check", f], { encoding: "utf8" });
      const names = fieldNames(f);
      const checks = [];
      if (v.ok !== k || v.bad !== 0) checks.push(`OpenSSL ${v.ok} hợp lệ/${v.bad} hỏng (cần ${k}/0)`);
      if (!out.subarray(0, cur.length).equals(cur)) checks.push("không bắt đầu bằng byte lần trước");
      if (q.status !== 0) checks.push("qpdf mã " + q.status);
      if (new Set(names).size !== names.length || names.length !== k) checks.push("trường: " + names.join(","));
      row(`người ký ${k}${visible ? " (nhìn thấy)" : ""}`, checks.length === 0, checks.length ? checks.join("; ") : `${k} chữ ký hợp lệ · +${out.length - cur.length} B · ${dt} s · trường ${names.join(",")}`);
      cur = out;
    }
    // Chỉ lưu file KẾT QUẢ (không ghi đè file nền: người dùng có thể đang mở nó trong Foxit/Acrobat ⇒ EBUSY).
    if (KEEP) {
      fs.mkdirSync(KEEP, { recursive: true });
      fs.copyFileSync(path.join(W, `s${N + 1}.pdf`), path.join(KEEP, `9-KY-NOI-THEM-${N + 1}-nguoi-ky.pdf`));
    }
  } finally {
    try { execSync(`taskkill /PID ${sc.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
    fs.rmSync(W, { recursive: true, force: true });
  }
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [n, s, note] of rows) console.log(`  ${n.padEnd(w)}  ${s.padEnd(4)}  ${note}`);
  console.log(`\n${rows.filter((r) => r[1] === "ĐẠT").length} đạt · ${bad} SAI`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("LỖI", e); try { execSync("taskkill /IM sidecar.exe /F", { stdio: "ignore" }); } catch (_) {} process.exit(2); });
