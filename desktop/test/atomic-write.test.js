"use strict";

// BI-136 — src/atomic-write.js: ghi file bằng "file tạm + fsync + đổi tên", không bao giờ cắt cụt file đích.
//
// BA TẦNG:
//   1. Hợp đồng + chèn lỗi ở TỪNG bước (mở tạm, ghi, sync, đóng, kiểm cỡ, đổi tên) bằng một `fs` bọc ngoài fs thật:
//      lỗi ở bất kỳ bước nào trước đổi tên ⇒ file đích còn NGUYÊN và không để rác.
//   2. Người đọc không bao giờ thấy file nửa chừng: dừng giữa lúc ghi, đọc file đích ⇒ vẫn là bản cũ.
//   3. GIẾT TIẾN TRÌNH THẬT giữa lúc ghi (TerminateProcess/SIGKILL, không có `finally` nào chạy) ⇒ file đích nguyên vẹn;
//      kèm ĐỐI CHỨNG: đúng kịch bản đó với cách ghi cũ (mở "w" rồi ghi) để lại file nửa chừng — chứng minh ca test đủ nhạy.
//
// Run:  node desktop/test/atomic-write.test.js      (or: npm run test:atomic)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const AW = require("../src/atomic-write");

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

const within = (ms, p, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
const HANG = { hang: true };
const errOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e || new Error("ném giá trị rỗng");
  }
};
const codeErr = (code, msg) => Object.assign(new Error(msg || code), { code });

// fs "bọc": giữ fs thật, ghi đè từng hàm của fs.promises theo `over`.
function wrapFs(over) {
  return { promises: new Proxy(fs.promises, { get: (t, k) => (over[k] ? over[k] : t[k]) }) };
}
// một file handle bọc: ghi đè writeFile/sync/close theo `h`.
function wrapFh(real, h) {
  return {
    writeFile: h.writeFile || ((d) => real.writeFile(d)),
    sync: h.sync || (() => real.sync()),
    close: h.close || (() => real.close()),
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-atomic-"));
  const target = path.join(dir, "t.pdf");
  const ORIG = Buffer.alloc(1000, 0x41);
  const NEW = Buffer.alloc(5000, 0x42);
  const reset = () => {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
    fs.writeFileSync(target, ORIG);
  };
  const tmps = () => fs.readdirSync(dir).filter((f) => f.endsWith(AW.TMP_SUFFIX));
  const content = () => (fs.existsSync(target) ? fs.readFileSync(target) : null);
  const isOrig = () => content() && Buffer.compare(content(), ORIG) === 0;
  const isNew = () => content() && Buffer.compare(content(), NEW) === 0;

  // ---- 1a. hợp đồng cơ bản ----
  reset();
  let r = await within(5000, AW.writeFileAtomic(target, NEW), HANG);
  check("1a đè file có sẵn: atomic:true, path đúng", [r.atomic, r.path], [true, target]);
  ok("1a … nội dung đúng, không rác", isNew() && tmps().length === 0);

  reset();
  fs.rmSync(target);
  r = await AW.writeFileAtomic(target, NEW);
  ok("1b file chưa có: tạo mới được", r.atomic === true && isNew() && tmps().length === 0);

  reset();
  {
    const big = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) big[i] = i;
    const view = new Uint8Array(big.buffer, big.byteOffset + 10, 20);
    await AW.writeFileAtomic(target, view);
    check("1c view có offset (đúng như dữ liệu qua IPC): ghi đúng 20 byte, không phải cả buffer", [...content()], [...big.subarray(10, 30)]);
  }
  reset();
  await AW.writeFileAtomic(target, Buffer.alloc(0));
  check("1d dữ liệu rỗng: ghi được file 0 byte", [content().length, tmps().length], [0, 0]);
  reset();
  for (const bad of ["abc", [1, 2, 3], null, undefined, 5]) {
    const e = await errOf(AW.writeFileAtomic(target, bad));
    ok(`1e dữ liệu sai kiểu ${JSON.stringify(bad)} ⇒ TypeError, file nguyên, không rác`, e instanceof TypeError && isOrig() && tmps().length === 0);
  }

  // ---- 1f. file tạm: cùng thư mục, hậu tố riêng (không phải .pdf), cờ wx ----
  reset();
  {
    const opened = [];
    const fsx = wrapFs({ open: async (p, f) => (opened.push([p, f]), fs.promises.open(p, f)) });
    await AW.writeFileAtomic(target, NEW, { fs: fsx });
    check("1f mở đúng MỘT file tạm", opened.length, 1);
    const [p, flag] = opened[0];
    ok("1f … cùng thư mục với file đích (đổi tên mới nguyên tử)", path.dirname(p) === dir);
    ok("1f … hậu tố .nabu-tmp, KHÔNG phải .pdf (không lọt vào hộp chọn PDF)", p.endsWith(".nabu-tmp") && !/\.pdf$/i.test(p));
    check("1f … cờ 'wx' (không bao giờ đè lên thứ gì có sẵn)", flag, "wx");
  }

  // ---- 1g. thứ tự thao tác: ghi → sync → đóng → kiểm cỡ → đổi tên (rename CUỐI CÙNG) ----
  reset();
  {
    const log = [];
    const fsx = wrapFs({
      open: async (p, f) => {
        log.push("open");
        const fh = await fs.promises.open(p, f);
        return wrapFh(fh, {
          writeFile: async (d) => (log.push("write"), fh.writeFile(d)),
          sync: async () => (log.push("sync"), fh.sync()),
          close: async () => (log.push("close"), fh.close()),
        });
      },
      stat: async (p) => (log.push("stat"), fs.promises.stat(p)),
      rename: async (a, b) => (log.push("rename"), fs.promises.rename(a, b)),
      unlink: async (p) => (log.push("unlink"), fs.promises.unlink(p)),
    });
    await AW.writeFileAtomic(target, NEW, { fs: fsx });
    check("1g thứ tự: open, write, sync, close, stat, rename (không unlink)", log, ["open", "write", "sync", "close", "stat", "rename"]);
  }

  // ---- 1h. lỗi ở từng bước TRƯỚC đổi tên ⇒ file đích NGUYÊN, không rác ----
  const mkFault = (h) =>
    wrapFs({
      open: async (p, f) => {
        const fh = await fs.promises.open(p, f);
        return wrapFh(fh, h(fh));
      },
    });
  for (const [label, h, expectCode] of [
    ["ghi giữa chừng hết ổ (ENOSPC sau nửa dữ liệu)", (fh) => ({ writeFile: async (d) => { await fh.write(d, 0, d.length >> 1); throw codeErr("ENOSPC"); } }), "ENOSPC"],
    ["fsync lỗi (EIO)", () => ({ sync: async () => { throw codeErr("EIO"); } }), "EIO"],
    ["đóng lỗi", (fh) => ({ close: async () => { await fh.close(); throw codeErr("EIO"); } }), "EIO"],
  ]) {
    reset();
    const e = await errOf(within(5000, AW.writeFileAtomic(target, NEW, { fs: mkFault(h) }), HANG));
    ok(`1h ${label}: ném lỗi, file đích NGUYÊN, không rác`, e && e.code === expectCode && isOrig() && tmps().length === 0, e && String(e.stack).slice(0, 200));
  }
  reset();
  {
    // ghi thiếu mà KHÔNG báo lỗi — chỉ kiểm cỡ mới bắt được
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: mkFault((fh) => ({ writeFile: async (d) => { await fh.write(d, 0, d.length >> 1); } })) }));
    ok("1i ghi thiếu mà không lỗi ⇒ kiểm cỡ bắt được: ném, file đích NGUYÊN, không rác", e && /Ghi thiếu dữ liệu/.test(e.message) && isOrig() && tmps().length === 0, e && e.message);
    check("1i … và nói rõ số byte", e && /2500\/5000/.test(e.message), true);
  }
  reset();
  {
    // lỗi gốc không bị che bởi lỗi dọn rác
    const fsx = wrapFs({
      open: async (p, f) => {
        const fh = await fs.promises.open(p, f);
        return wrapFh(fh, { writeFile: async () => { throw codeErr("ENOSPC"); } });
      },
      unlink: async () => { throw codeErr("EPERM", "không xoá được tạm"); },
    });
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: fsx }));
    ok("1j lỗi dọn tạm KHÔNG che lỗi gốc (vẫn ENOSPC)", e && e.code === "ENOSPC" && isOrig());
    for (const f of tmps()) fs.rmSync(path.join(dir, f), { force: true });
  }

  // ---- 1k. mở file tạm thất bại ----
  reset();
  {
    const fsx = wrapFs({ open: async () => { throw codeErr("EACCES"); } });
    const r2 = await AW.writeFileAtomic(target, NEW, { fs: fsx });
    ok("1k không tạo được tạm VÌ QUYỀN ⇒ rơi về ghi thẳng (như trước BI-136), atomic:false", r2.atomic === false && isNew() && tmps().length === 0);
  }
  reset();
  for (const code of ["ENOSPC", "EMFILE", "EIO", "ENOENT"]) {
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: wrapFs({ open: async () => { throw codeErr(code); } }) }));
    ok(`1k mở tạm lỗi ${code} ⇒ KHÔNG rơi về ghi thẳng (sẽ cắt cụt file khi ổ đầy): ném, file nguyên`, e && e.code === code && isOrig());
  }
  reset();
  {
    let n = 0;
    const fsx = wrapFs({
      open: async (p, f) => {
        n++;
        if (n === 1) throw codeErr("EEXIST");
        return fs.promises.open(p, f);
      },
    });
    const r3 = await AW.writeFileAtomic(target, NEW, { fs: fsx });
    ok("1l trùng tên tạm (EEXIST) lần đầu ⇒ thử tên khác, ghi được", n === 2 && r3.atomic && isNew());
    n = 0;
    reset();
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: wrapFs({ open: async () => (n++, Promise.reject(codeErr("EEXIST"))) }) }));
    ok("1l EEXIST mãi ⇒ dừng sau 3 lần, ném, file nguyên", n === 3 && e && /file tạm/.test(e.message) && isOrig());
  }
  reset();
  {
    // nếu fallback ghi thẳng cũng lỗi thì phải ném (không nuốt)
    const fsx = wrapFs({ open: async () => { throw codeErr("EPERM"); }, writeFile: async () => { throw codeErr("EBUSY"); } });
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: fsx }));
    ok("1m rơi về ghi thẳng mà cũng lỗi ⇒ ném lỗi đó", e && e.code === "EBUSY");
  }

  // ---- 1n. đổi tên: thử lại lỗi TẠM THỜI của Windows, bỏ cuộc thì file nguyên ----
  reset();
  {
    let n = 0;
    const sleeps = [];
    const fsx = wrapFs({ rename: async (a, b) => (++n <= 3 ? Promise.reject(codeErr(n === 2 ? "EBUSY" : "EPERM")) : fs.promises.rename(a, b)) });
    const r4 = await AW.writeFileAtomic(target, NEW, { fs: fsx, sleep: async (ms) => sleeps.push(ms) });
    ok("1n đổi tên lỗi tạm thời 3 lần rồi được ⇒ thành công", r4.atomic && isNew() && tmps().length === 0);
    check("1n … chờ tăng dần giữa các lần", sleeps, [40, 80, 160]);
  }
  reset();
  {
    const sleeps = [];
    let n = 0;
    const fsx = wrapFs({ rename: async () => (n++, Promise.reject(codeErr("EPERM"))) });
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: fsx, sleep: async (ms) => sleeps.push(ms) }));
    ok("1o đổi tên lỗi mãi ⇒ ném, file đích NGUYÊN, tạm bị xoá", e && e.code === "EPERM" && isOrig() && tmps().length === 0);
    ok("1o … thông báo nói rõ 'file gốc còn nguyên' (người dùng yên tâm)", e && /file gốc còn nguyên/.test(e.message) && /EPERM/.test(e.message));
    check("1o … thử 7 lần (1 + 6 lần chờ)", [n, sleeps.length], [7, 6]);
  }
  reset();
  {
    const sleeps = [];
    let n = 0;
    const fsx = wrapFs({ rename: async () => (n++, Promise.reject(codeErr("ENOENT"))) });
    const e = await errOf(AW.writeFileAtomic(target, NEW, { fs: fsx, sleep: async (ms) => sleeps.push(ms) }));
    ok("1p lỗi đổi tên KHÔNG tạm thời (ENOENT) ⇒ ném ngay, không chờ", e && e.code === "ENOENT" && n === 1 && sleeps.length === 0 && isOrig() && tmps().length === 0);
  }

  // ---- 2. người đọc không bao giờ thấy file nửa chừng ----
  reset();
  {
    let release;
    const gate = new Promise((res) => (release = res));
    let reached;
    const atStall = new Promise((res) => (reached = res));
    const fsx = mkFault((fh) => ({
      writeFile: async (d) => {
        await fh.write(d, 0, d.length >> 1);
        reached();
        await gate;
        await fh.write(d, d.length >> 1, d.length - (d.length >> 1));
      },
    }));
    const p = AW.writeFileAtomic(target, NEW, { fs: fsx });
    await within(3000, atStall, null);
    ok("2a giữa lúc ghi nửa chừng: file đích vẫn là BẢN CŨ nguyên vẹn", isOrig());
    check("2a … và đang có đúng một file tạm", tmps().length, 1);
    release();
    await within(5000, p, HANG);
    ok("2a … ghi xong thì là bản mới trọn vẹn", isNew() && tmps().length === 0);
  }

  // ---- 2b. hai lần ghi song song vào cùng file: kết quả là MỘT trong hai, không bao giờ lẫn ----
  reset();
  {
    const A = Buffer.alloc(300000, 0x61);
    const B = Buffer.alloc(300000, 0x62);
    const rs = await within(15000, Promise.allSettled([AW.writeFileAtomic(target, A), AW.writeFileAtomic(target, B)]), HANG);
    const c = content();
    const pureA = c.equals(A);
    const pureB = c.equals(B);
    ok("2b ghi song song: nội dung cuối là A hoặc B nguyên vẹn (không lẫn)", pureA || pureB, "kích thước " + c.length);
    ok("2b … ít nhất một lần thành công, không rác", rs.some((x) => x.status === "fulfilled") && tmps().length === 0);
  }

  // ---- 2c. liên kết tượng trưng được giữ ----
  reset();
  {
    const link = path.join(dir, "link.pdf");
    let can = true;
    try {
      fs.symlinkSync(target, link, "file");
    } catch (_) {
      can = false;
    }
    if (can) {
      await AW.writeFileAtomic(link, NEW);
      ok("2c ghi qua liên kết: liên kết VẪN là liên kết, file thật có nội dung mới", fs.lstatSync(link).isSymbolicLink() && isNew() && tmps().length === 0);
    } else {
      console.log("  (bỏ qua 2c: không tạo được symlink trên máy này)");
    }
  }

  // ---- 2d. nhánh liên kết tượng trưng bằng đồ giả (máy không có quyền tạo symlink vẫn kiểm được) ----
  reset();
  {
    const fake = path.join(dir, "fake-link.pdf");
    const opened = [];
    const renamed = [];
    const fsx = wrapFs({
      lstat: async (p) => (p === fake ? { isSymbolicLink: () => true } : fs.promises.lstat(p)),
      realpath: async (p) => (p === fake ? target : fs.promises.realpath(p)),
      open: async (p, f) => (opened.push(p), fs.promises.open(p, f)),
      rename: async (a, b) => (renamed.push(b), fs.promises.rename(a, b)),
    });
    await AW.writeFileAtomic(fake, NEW, { fs: fsx });
    ok("2d liên kết: tạm đặt cạnh file THẬT, đổi tên đè lên file thật (không thay mất liên kết)", path.dirname(opened[0]) === dir && opened[0].startsWith(target + ".") && renamed[0] === target && isNew());
    // file thường thì KHÔNG gọi realpath (realpath của libuv trên Windows đổi ổ ánh xạ thành UNC)
    let realpathCalls = 0;
    reset();
    await AW.writeFileAtomic(target, NEW, { fs: wrapFs({ realpath: async (p) => (realpathCalls++, fs.promises.realpath(p)) }) });
    check("2d file thường: không gọi realpath", realpathCalls, 0);
  }

  // ---- 3. GIẾT TIẾN TRÌNH THẬT giữa lúc ghi ----
  const childSrc = `
const fs = require("fs");
const { writeFileAtomic } = require(process.argv[1]);
const target = process.argv[2];
const mode = process.argv[3];
const data = Buffer.alloc(8 * 1024 * 1024, 0x42);
const half = data.length >> 1;
const stall = () => new Promise(() => {});
if (mode === "atomic") {
  const open = async (p, f) => {
    const fh = await fs.promises.open(p, f);
    return {
      writeFile: async (d) => { await fh.write(d, 0, half); console.log("HALF"); await stall(); },
      sync: () => fh.sync(),
      close: () => fh.close(),
    };
  };
  const fsx = { promises: new Proxy(fs.promises, { get: (t, k) => (k === "open" ? open : t[k]) }) };
  writeFileAtomic(target, data, { fs: fsx });
} else {
  // mô hình của fs.promises.writeFile(fp, data) cũ: mở "w" = CẮT CỤT NGAY, rồi ghi
  (async () => {
    const fh = await fs.promises.open(target, "w");
    await fh.write(data, 0, half);
    console.log("HALF");
    await stall();
  })();
}
`;
  async function killMidWrite(mode) {
    reset();
    const bigOrig = Buffer.alloc(3 * 1024 * 1024, 0x41);
    fs.writeFileSync(target, bigOrig);
    const child = spawn(process.execPath, ["-e", childSrc, path.join(__dirname, "..", "src", "atomic-write.js"), target, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const reached = await within(15000, new Promise((res) => {
      const t = setInterval(() => { if (out.includes("HALF")) { clearInterval(t); res(true); } }, 20);
    }), false);
    const exited = new Promise((res) => child.on("exit", () => res(true)));
    child.kill("SIGKILL"); // Windows: TerminateProcess — không có finally/cleanup nào chạy
    await within(10000, exited, false);
    return { reached, err, bigOrig, now: fs.readFileSync(target) };
  }
  {
    const k = await killMidWrite("atomic");
    ok("3a [ghi nguyên tử] tiến trình con đã tới giữa lúc ghi rồi bị giết", k.reached, k.err);
    ok("3a … file đích NGUYÊN VẸN từng byte sau khi bị giết", k.now.equals(k.bigOrig), `còn ${k.now.length} byte`);
    const left = tmps();
    ok("3a … chỉ để lại MỘT file tạm .nabu-tmp (rác đã biết, xoá được, không đụng file thật)", left.length === 1 && fs.statSync(path.join(dir, left[0])).size === (8 * 1024 * 1024) >> 1);
  }
  {
    const k = await killMidWrite("direct");
    ok("3b [ĐỐI CHỨNG: cách ghi cũ] cùng kịch bản đó làm file đích mất bản cũ", k.reached && !k.now.equals(k.bigOrig), `còn ${k.now.length} byte`);
    check("3b … cụ thể: bị cắt về nửa dữ liệu mới (bản cũ biến mất)", k.now.length, (8 * 1024 * 1024) >> 1);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "OK" : "FAIL"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
