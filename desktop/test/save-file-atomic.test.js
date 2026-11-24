"use strict";

// BI-145 — `dialog:save-file` (xuất xlsx / csv / json / docx / zip ảnh) ghi NGUYÊN TỬ.
//
// Trước: `fs.promises.writeFile(res.filePath, ...)` mở file đích bằng cờ "w" — cắt về 0 byte NGAY — rồi mới ghi. Người dùng
// chọn ĐÈ lên bản xuất cũ (hộp thoại native đã hỏi "ghi đè?") rồi ổ đầy / mất điện / tiến trình bị giết giữa chừng ⇒ mất cả bản
// cũ lẫn bản mới. Cùng lỗi BI-136 đã sửa cho `dialog:save-pdf`; đây là đường cuối cùng còn `writeFile` thô (trừ nhánh `wx`).
//
// Cách test: CẮT NGUYÊN VĂN handler `dialog:save-file` ở main.js rồi chạy thật trên thư mục thật. Lỗi được chèn qua một `fs` bọc
// ngoài fs thật: file mở ra (cờ bất kỳ) sẽ ghi được NỬA dữ liệu rồi ném ENOSPC — cả `fs.promises.writeFile` (đường cũ) lẫn
// `AtomicWrite` (đường mới) đều đi qua cùng cú lỗi, nên test đỏ trên mã cũ và xanh trên mã mới.
//
// Run:  node desktop/test/save-file-atomic.test.js      (or: npm run test:savefile)

const fs = require("fs");
const os = require("os");
const path = require("path");
const RealAW = require("../src/atomic-write");
const { asWritable } = require("../src/ipc-bytes");

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
const codeErr = (code) => Object.assign(new Error(code), { code });

const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const cut = (from, to) => {
  const a = MAIN.indexOf(from);
  const b = MAIN.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from);
  return MAIN.slice(a, b);
};
const handlerSrc = cut('ipcMain.handle("dialog:save-file"', "// Reveal a path in the OS file manager");

// fs bọc: mọi file mở ghi (open / writeFile) chỉ ghi được NỬA rồi ném ENOSPC khi `fault.on`.
function faultyFs(fault) {
  const real = fs.promises;
  const wrapFh = (fh, label) => ({
    writeFile: async (d) => {
      if (fault.on === "write") {
        const half = Buffer.from(d).subarray(0, Math.floor(d.byteLength / 2));
        await fh.writeFile(half);
        throw codeErr("ENOSPC");
      }
      return fh.writeFile(d);
    },
    sync: () => fh.sync(),
    close: () => fh.close(),
  });
  const over = {
    open: async (p, f) => wrapFh(await real.open(p, f), String(p)),
    writeFile: async (p, d, o) => {
      const fh = await faultyOpen(p, (o && o.flag) || "w");
      try { await fh.writeFile(d); } finally { await fh.close(); }
    },
    rename: async (a, b) => {
      if (fault.on === "rename") throw codeErr(fault.code || "EIO");
      if (fault.renameFailsLeft > 0) {
        fault.renameFailsLeft--;
        throw codeErr("EBUSY");
      }
      return real.rename(a, b);
    },
  };
  const faultyOpen = over.open;
  return { promises: new Proxy(real, { get: (t, k) => (over[k] ? over[k] : t[k]) }) };
}

function makeEnv(dialogResult, fault = {}) {
  const handlers = {};
  const ipcMain = { handle: (n, f) => (handlers[n] = f) };
  const calls = { dialog: [], remembered: [] };
  const dialog = {
    showSaveDialog: async (win, opts) => {
      calls.dialog.push(opts);
      return dialogResult;
    },
  };
  const fsx = faultyFs(fault);
  const AW = {
    TMP_SUFFIX: RealAW.TMP_SUFFIX,
    writeFileAtomic: (fp, d, o) => RealAW.writeFileAtomic(fp, d, { fs: fsx, sleep: async () => {}, ...o }),
  };
  new Function(
    "ipcMain", "dialog", "senderWindow", "saveDefault", "rememberDir", "fs", "asWritable", "AtomicWrite",
    handlerSrc
  )(ipcMain, dialog, () => null, async (_k, name) => name, (k, p) => calls.remembered.push([k, p]), fsx, asWritable, AW);
  return { save: handlers["dialog:save-file"], calls };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-savefile-"));
  let n = 0;
  const dest = (name) => path.join(root, `d${++n}`, name);
  const mk = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });
  const filesIn = (p) => fs.readdirSync(path.dirname(p));
  const tmpsIn = (p) => filesIn(p).filter((f) => f.endsWith(RealAW.TMP_SUFFIX));
  const u8 = (s) => new Uint8Array(Buffer.from(s, "latin1"));
  const text = (p) => fs.readFileSync(p, "latin1");

  // ---- 1. đường vui: file mới ----
  {
    const fp = dest("a.xlsx");
    mk(fp);
    const env = makeEnv({ canceled: false, filePath: fp });
    const r = await env.save(null, { data: u8("XLSX-BYTES"), defaultName: "a.xlsx", filters: [{ name: "XLSX", extensions: ["xlsx"] }] });
    check("1a trả saved:true + path", r, { saved: true, path: fp });
    check("1b nội dung đúng", text(fp), "XLSX-BYTES");
    check("1c không rác .nabu-tmp", tmpsIn(fp), []);
    check("1d hộp thoại nhận bộ lọc + tên mặc định", [env.calls.dialog[0].filters, env.calls.dialog[0].defaultPath], [[{ name: "XLSX", extensions: ["xlsx"] }], "a.xlsx"]);
    check("1e nhớ thư mục lần sau", env.calls.remembered, [["save-file", fp]]);
  }

  // ---- 2. dữ liệu không phải Uint8Array vẫn ghi đúng (asWritable đổi sang Buffer) ----
  {
    for (const [label, data, want] of [
      ["chuỗi", "a,b\n1,2\n", "a,b\n1,2\n"],
      ["mảng số", [67, 83, 86], "CSV"],
      ["ArrayBuffer", new Uint8Array([74, 83, 79, 78]).buffer, "JSON"],
    ]) {
      const fp = dest("x.csv");
      mk(fp);
      const env = makeEnv({ canceled: false, filePath: fp });
      const r = await env.save(null, { data, defaultName: "x.csv" });
      check(`2 ${label}: saved`, r.saved, true);
      check(`2 ${label}: nội dung`, text(fp), want);
    }
  }

  // ---- 3. đè lên file cũ ----
  {
    const fp = dest("o.json");
    mk(fp);
    fs.writeFileSync(fp, "BAN-CU-DAI-HON-BAN-MOI");
    const env = makeEnv({ canceled: false, filePath: fp });
    await env.save(null, { data: u8("MOI"), defaultName: "o.json" });
    check("3a đè: bản mới thay hẳn (không còn đuôi bản cũ)", text(fp), "MOI");
    check("3b không rác", tmpsIn(fp), []);
  }

  // ---- 4. huỷ hộp thoại ----
  {
    for (const [label, res] of [["canceled", { canceled: true }], ["filePath rỗng", { canceled: false, filePath: "" }]]) {
      const fp = dest("c.xlsx");
      mk(fp);
      fs.writeFileSync(fp, "GIU-NGUYEN");
      const env = makeEnv(res);
      const r = await env.save(null, { data: u8("KHONG-GHI"), defaultName: "c.xlsx" });
      check(`4 ${label}: saved:false`, r, { saved: false });
      check(`4 ${label}: file cũ còn nguyên`, text(fp), "GIU-NGUYEN");
      check(`4 ${label}: không nhớ thư mục`, env.calls.remembered, []);
    }
  }

  // ---- 5. LỖI GIỮA LÚC GHI KHÔNG PHÁ BẢN XUẤT CŨ (đỏ trên mã cũ) ----
  {
    const fp = dest("w.xlsx");
    mk(fp);
    fs.writeFileSync(fp, "BAN-XUAT-CU-QUAN-TRONG");
    const fault = { on: "write" };
    const env = makeEnv({ canceled: false, filePath: fp }, fault);
    let err = null;
    try { await env.save(null, { data: u8("BAN-MOI-DAI-HON-NHIEU-NHIEU"), defaultName: "w.xlsx" }); } catch (e) { err = e; }
    ok("5a lỗi ghi được báo lên (không nuốt, không saved:true)", err && err.code === "ENOSPC", String(err));
    check("5b file đích còn NGUYÊN bản cũ", text(fp), "BAN-XUAT-CU-QUAN-TRONG");
    check("5c file tạm bị dọn", tmpsIn(fp), []);
  }

  // ---- 6. đổi tên thất bại thì file cũ nguyên; lỗi tạm thời thì thử lại và thành công ----
  {
    const fp = dest("r.docx");
    mk(fp);
    fs.writeFileSync(fp, "CU");
    const env = makeEnv({ canceled: false, filePath: fp }, { on: "rename", code: "EIO" });
    let err = null;
    try { await env.save(null, { data: u8("MOI"), defaultName: "r.docx" }); } catch (e) { err = e; }
    ok("6a đổi tên hỏng ⇒ ném", err && err.code === "EIO", String(err));
    check("6b file cũ nguyên", text(fp), "CU");
    check("6c tạm bị dọn", tmpsIn(fp), []);

    const fp2 = dest("t.docx");
    mk(fp2);
    fs.writeFileSync(fp2, "CU");
    const env2 = makeEnv({ canceled: false, filePath: fp2 }, { renameFailsLeft: 2 });
    const r = await env2.save(null, { data: u8("MOI-SAU-RETRY"), defaultName: "t.docx" });
    check("6d EBUSY tạm thời: thử lại rồi lưu được", [r.saved, text(fp2)], [true, "MOI-SAU-RETRY"]);
  }

  // ---- 7. file rỗng + tên có dấu cách / tiếng Việt ----
  {
    const fp = dest("Hợp đồng — xuất.xlsx");
    mk(fp);
    const env = makeEnv({ canceled: false, filePath: fp });
    const r = await env.save(null, { data: new Uint8Array(0), defaultName: "x" });
    check("7a 0 byte vẫn lưu", [r.saved, fs.statSync(fp).size], [true, 0]);
    const fp2 = dest("Báo cáo (1).csv");
    mk(fp2);
    const env2 = makeEnv({ canceled: false, filePath: fp2 });
    await env2.save(null, { data: u8("ok"), defaultName: "x" });
    check("7b tên có dấu + ngoặc", text(fp2), "ok");
  }

  // ---- 8. ghim nguồn: không còn writeFile thô trong handler ----
  {
    ok("8a handler không gọi fs.promises.writeFile thô", !/fs\.promises\.writeFile\(/.test(handlerSrc));
    ok("8b handler đi qua AtomicWrite.writeFileAtomic", /AtomicWrite\.writeFileAtomic\(/.test(handlerSrc));
    ok("8c vẫn dùng asWritable (không Buffer.from thêm bản sao)", /asWritable\(/.test(handlerSrc) && !/Buffer\.from\(/.test(handlerSrc));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nsave-file-atomic: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
