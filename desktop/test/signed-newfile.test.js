"use strict";

// BI-135 — cổng BI-127 cho `file:write-new-pdf` (ghi PDF vào một thư mục theo tên, dùng bởi "Tạo bản theo mẫu").
//
// Lỗ hổng cũ: với `overwrite:true` handler đè thẳng lên file CÓ SẴN. Renderer chỉ hỏi một câu chung "Ghi đè?"
// mà không biết file đích đã ký số ⇒ bấm "Ghi đè" là phá chữ ký, trong khi mọi đường ghi PDF khác của main đều
// phải qua SignedScan.guardWrite (BI-127).
//
// BA TẦNG:
//   1. CẮT NGUYÊN VĂN `askSignedOverwrite` + handler `file:write-new-pdf` ở main.js rồi chạy thật với cổng thật,
//      file thật trên đĩa và hộp thoại giả (main không chạy được trong node).
//   2. CẮT NGUYÊN VĂN `writeOne` ở renderer/batch-variants.js và chạy với `window.desktop` giả: "bỏ qua" từ main
//      phải thành "bỏ qua file này", không phải lỗi làm hỏng cả đợt.
//   3. GHIM CẤU TRÚC: cổng đứng trước lệnh ghi, chỉ khi overwrite, nhánh bỏ qua không ghi.
//
// Run:  node desktop/test/signed-newfile.test.js      (or: npm run test:signednew)

const fs = require("fs");
const os = require("os");
const path = require("path");
const SignedScan = require("../src/signed-scan");
const SignedSave = require("../src/signed-save");
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

const pad = (n) => String(n).padStart(10, "0");
// Một file "đã ký" tối thiểu nhưng ĐỦ để cổng BI-127 nhận ra: ByteRange hợp lệ, /Contents là hex, chữ ký phủ tới cuối file.
function buildSigned() {
  const pre =
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n" +
    "<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [ZZZZZZZZZZ AAAAAAAAAA CCCCCCCCCC LLLLLLLLLL] /Contents ";
  const hex = "0".repeat(64);
  const post = " /M (D:20260101000000Z) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  const l1 = pre.length;
  const c = pre.length + 64 + 2;
  const body = pre + "<" + hex + ">" + post;
  const l2 = body.length - c;
  const s = body
    .replace("ZZZZZZZZZZ", pad(0))
    .replace("AAAAAAAAAA", pad(l1))
    .replace("CCCCCCCCCC", pad(c))
    .replace("LLLLLLLLLL", pad(l2));
  return Buffer.from(s, "latin1");
}
const UNSIGNED = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
const NEWDATA = Buffer.from("%PDF-1.4\n%% bản MỚI do Tạo bản theo mẫu\n%%EOF\n", "utf8");

// Một ca bị treo phải là MỘT CA ĐỎ có tên, không phải cả bộ test đứng yên.
const within = (ms, p, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

(async () => {
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const BV = fs.readFileSync(path.join(__dirname, "..", "renderer", "batch-variants.js"), "utf8");
  const cut = (src, from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from);
    return src.slice(a, b);
  };
  const askSrc = cut(MAIN, "async function askSignedOverwrite(", 'ipcMain.handle("dialog:save-pdf"');
  const handlerSrc = cut(MAIN, 'ipcMain.handle("file:write-new-pdf"', "// Generic save for non-PDF exports");
  const badRe = MAIN.match(/const VARIANT_NAME_BAD = [^\n]*;/);
  if (!badRe) throw new Error("không thấy VARIANT_NAME_BAD");

  // ---- 1. handler thật, đĩa thật, hộp thoại giả ----
  const handlers = {};
  const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
  const asked = [];
  let answers = [];
  const dialog = {
    showMessageBox: async (win, o) => {
      asked.push(o);
      if (!answers.length) throw new Error("hộp hỏi nhiều hơn dự kiến");
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return { response: a };
    },
  };
  new Function(
    "ipcMain", "fs", "path", "SignedScan", "SignedSave", "asWritable", "senderWindow", "Tabs", "dialog", "menuLang",
    badRe[0] + "\n" + askSrc + "\n" + handlerSrc
  )(ipcMain, fs, path, SignedScan, SignedSave, asWritable, () => null, { findDoc: () => null }, dialog, "vi");
  const write = handlers["file:write-new-pdf"];
  ok("1 đã nạp được handler file:write-new-pdf", typeof write === "function");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-newfile-"));
  const fileAt = (n) => path.join(tmp, n);
  const same = (n, buf) => fs.existsSync(fileAt(n)) && Buffer.compare(fs.readFileSync(fileAt(n)), buf) === 0;
  const run = (args, ans = []) => {
    asked.length = 0;
    answers = ans.slice();
    return within(3000, write({ sender: null }, { dir: tmp, ...args }), { hang: true });
  };

  // 1a. không đè: file chưa có → ghi, không hỏi
  let r = await run({ name: "a.pdf", data: NEWDATA, overwrite: false });
  check("1a overwrite:false, chưa có file → saved", [r.saved, asked.length], [true, 0]);
  ok("1a … và đúng byte", same("a.pdf", NEWDATA));

  // 1b. không đè: file ĐÃ KÝ có sẵn → exists, không hỏi, KHÔNG đụng
  const SIGNED = buildSigned();
  fs.writeFileSync(fileAt("s.pdf"), SIGNED);
  r = await run({ name: "s.pdf", data: NEWDATA, overwrite: false });
  check("1b overwrite:false, file đã ký có sẵn → exists, không hỏi", [r.saved, r.exists, asked.length], [false, true, 0]);
  ok("1b … file đã ký còn NGUYÊN", same("s.pdf", SIGNED));

  // 1c. đè: file chưa có → ghi, không hỏi
  r = await run({ name: "n.pdf", data: NEWDATA, overwrite: true });
  check("1c overwrite:true, chưa có file → saved, không hỏi", [r.saved, asked.length], [true, 0]);

  // 1d. đè: file có sẵn nhưng KHÔNG ký → ghi, không hỏi (không làm phiền vô cớ)
  fs.writeFileSync(fileAt("u.pdf"), UNSIGNED);
  r = await run({ name: "u.pdf", data: NEWDATA, overwrite: true });
  check("1d overwrite:true, file không ký → saved, không hỏi", [r.saved, asked.length], [true, 0]);
  ok("1d … đã bị thay bằng bản mới", same("u.pdf", NEWDATA));

  // 1e. đè lên file ĐÃ KÝ: phải hỏi; từng nút
  {
    fs.writeFileSync(fileAt("s.pdf"), SIGNED);
    r = await run({ name: "s.pdf", data: NEWDATA, overwrite: true }, [0]);
    check("1e bấm nút 0 (Bỏ qua file này) → skipped, KHÔNG ghi", [r.saved, r.skipped, asked.length], [false, true, 1]);
    ok("1e … file đã ký còn NGUYÊN", same("s.pdf", SIGNED));
    const o = asked[0];
    check("1e hộp 3 nút: nút 0 là 'Bỏ qua file này', mặc định 0, Esc = Huỷ", [o.buttons, o.defaultId, o.cancelId], [["Bỏ qua file này", "Vẫn ghi đè", "Huỷ"], 0, 2]);
    ok("1e … nêu đúng đường dẫn và số chữ ký", o.detail.includes(fileAt("s.pdf")) && /1 chữ ký/.test(o.message));
    ok("1e … KHÔNG đề nghị 'Lưu nối thêm' (không có bản gốc để nối)", !/nối thêm/.test(o.detail) && o.buttons.length === 3);

    r = await run({ name: "s.pdf", data: NEWDATA, overwrite: true }, [2]);
    check("1e bấm Huỷ → skipped, KHÔNG ghi", [r.saved, r.skipped], [false, true]);
    ok("1e … file đã ký còn NGUYÊN", same("s.pdf", SIGNED));

    for (const [label, ans] of [["nút lạ (7)", 7], ["-1", -1], ["undefined", undefined], ["hộp ném lỗi", new Error("dialog hỏng")]]) {
      r = await run({ name: "s.pdf", data: NEWDATA, overwrite: true }, [ans]);
      check(`1e ${label} → không ghi`, [r.saved, same("s.pdf", SIGNED)], [false, true]);
    }

    r = await run({ name: "s.pdf", data: NEWDATA, overwrite: true }, [1]);
    check("1e bấm 'Vẫn ghi đè' → ghi (đã được hỏi rõ)", [r.saved, asked.length], [true, 1]);
    ok("1e … đã thay bằng bản mới", same("s.pdf", NEWDATA));
  }

  // 1f. đè lên file ký nhưng bản mới GIỮ NGUYÊN vùng ký (bắt đầu bằng đúng byte cũ) → không mất gì, không hỏi
  {
    fs.writeFileSync(fileAt("k.pdf"), SIGNED);
    const kept = Buffer.concat([SIGNED, Buffer.from("\n%% revision nối\n")]);
    r = await run({ name: "k.pdf", data: kept, overwrite: true });
    check("1f bản mới giữ nguyên vùng ký → ghi, không hỏi", [r.saved, asked.length], [true, 0]);
    ok("1f … đúng byte", same("k.pdf", kept));
  }

  // 1g. kiểm tra đầu vào cũ vẫn nguyên (không thụt lùi): thư mục/tên xấu → lỗi, không hỏi, không ghi
  {
    asked.length = 0;
    r = await within(3000, write({ sender: null }, { dir: "rel/dir", name: "x.pdf", data: NEWDATA, overwrite: true }), { hang: true });
    check("1g thư mục tương đối → từ chối", [r.saved, typeof r.error], [false, "string"]);
    for (const bad of ["../x.pdf", "x.txt", "a:b.pdf", ""]) {
      r = await within(3000, write({ sender: null }, { dir: tmp, name: bad, data: NEWDATA, overwrite: true }), { hang: true });
      check(`1g tên xấu ${JSON.stringify(bad)} → từ chối`, [r.saved, typeof r.error, asked.length], [false, "string", 0]);
    }
  }

  // 1h. bản tiếng Anh của nút bỏ qua
  {
    fs.writeFileSync(fileAt("s.pdf"), SIGNED);
    const hEn = {};
    new Function(
      "ipcMain", "fs", "path", "SignedScan", "SignedSave", "asWritable", "senderWindow", "Tabs", "dialog", "menuLang",
      badRe[0] + "\n" + askSrc + "\n" + handlerSrc
    )({ handle: (n, f) => (hEn[n] = f) }, fs, path, SignedScan, SignedSave, asWritable, () => null, { findDoc: () => null }, dialog, "en");
    asked.length = 0;
    answers = [2];
    await hEn["file:write-new-pdf"]({ sender: null }, { dir: tmp, name: "s.pdf", data: NEWDATA, overwrite: true });
    check("1h bản tiếng Anh: nhãn nút", asked[0] && asked[0].buttons, ["Skip this file", "Overwrite anyway", "Cancel"]);
  }

  // ---- 2. renderer: writeOne chạy thật với window.desktop giả ----
  const woSrc = cut(BV, "    async function writeOne(", "    async function run()");
  function makeWriteOne(desktop, confirmAnswer) {
    const calls = { confirm: 0 };
    const uiConfirm = async () => {
      calls.confirm++;
      return confirmAnswer;
    };
    const fn = new Function("bv", "uiConfirm", "tr", "window", woSrc + "; return writeOne;")(
      { dir: "/d" }, uiConfirm, (s) => s, { desktop }
    );
    return { fn, calls };
  }
  {
    // file đích đã ký: lần 1 exists, người dùng bấm Ghi đè ở renderer, main hỏi lại và người dùng bỏ qua
    const seq = [];
    const desktop = {
      writeNewPdf: async (dir, name, bytes, ow) => {
        seq.push(ow);
        return ow ? { saved: false, skipped: true, path: "/d/" + name } : { saved: false, exists: true, path: "/d/" + name };
      },
    };
    const { fn, calls } = makeWriteOne(desktop, true);
    const w = await within(3000, fn("s.pdf", new Uint8Array(3)), { hang: true });
    check("2a main báo skipped → writeOne trả skipped (không ném lỗi)", w, { skipped: true });
    check("2a … đúng thứ tự gọi: không đè rồi đè; renderer hỏi một lần", [seq, calls.confirm], [[false, true], 1]);

    const { fn: fn2 } = makeWriteOne({ writeNewPdf: async () => ({ saved: false, error: "boom" }) }, true);
    let err = null;
    try { await fn2("x.pdf", new Uint8Array(1)); } catch (e) { err = e.message; }
    check("2b lỗi thật vẫn ném lỗi", err, "boom");

    const { fn: fn3 } = makeWriteOne({ writeNewPdf: async (d, n, b, ow) => ({ saved: true, path: "/d/" + n }) }, true);
    check("2c ghi thường vẫn trả path", await fn3("y.pdf", new Uint8Array(1)), { path: "/d/y.pdf" });

    const { fn: fn4 } = makeWriteOne({ writeNewPdf: async () => ({ saved: false, exists: true }) }, false);
    check("2d người dùng không đồng ý ghi đè ở renderer → skipped", await fn4("y.pdf", new Uint8Array(1)), { skipped: true });
  }

  // ---- 3. ghim cấu trúc ----
  {
    const gateAt = handlerSrc.indexOf("SignedScan.guardWrite(");
    const writeAt = handlerSrc.indexOf("fs.promises.writeFile(");
    ok("3a handler gọi SignedScan.guardWrite", gateAt >= 0);
    ok("3b cổng đứng TRƯỚC lệnh ghi", gateAt >= 0 && writeAt > gateAt);
    const branchAt = handlerSrc.indexOf('gate.action === "cancel"');
    ok("3c nhánh bỏ qua nằm giữa cổng và lệnh ghi, trả skipped:true", branchAt > gateAt && branchAt < writeAt && /skipped: true/.test(handlerSrc));
    ok("3d cổng chỉ chạy khi overwrite (wx không đè được, khỏi hỏi)", /if \(overwrite\) \{[\s\S]*?guardWrite/.test(handlerSrc));
    ok("3e cả 'copy' lẫn 'cancel' đều không ghi", /gate\.action === "cancel" \|\| gate\.action === "copy"/.test(handlerSrc));
    ok("3f handler dùng tham số 'e' (không còn '_e' trong khối)", !/\b_e\b/.test(handlerSrc));
    ok("3g renderer: writeOne xử lý r.skipped sau lần ghi đè", /if \(r && r\.skipped\) return \{ skipped: true \}/.test(woSrc));
    // Ba handler ghi PDF vào đường dẫn người dùng (save-pdf, write-pdf, write-new-pdf) đều phải có cổng trong khối của mình.
    const blocks = [
      cut(MAIN, 'ipcMain.handle("dialog:save-pdf"', 'ipcMain.handle("file:write-pdf"'),
      cut(MAIN, 'ipcMain.handle("file:write-pdf"', "// ---- Tạo bản theo mẫu"),
      handlerSrc,
    ];
    ok("3h cả ba handler ghi PDF của main đều có cổng (guardWrite/planSignedWrite)", blocks.every((b) => /guardWrite\(|planSignedWrite\(/.test(b)));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "OK" : "FAIL"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
