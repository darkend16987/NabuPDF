"use strict";

// BI-146 — cảnh báo lúc BẮT ĐẦU sửa một file ĐÃ KÝ (trước đó chỉ hỏi lúc Lưu / Ký — BI-127, BI-130, BI-132).
//
// Hành vi: lần đầu tài liệu chuyển sạch → bẩn (`markDirty`), renderer hỏi main "file Ở ĐƯỜNG DẪN NÀY trên đĩa có mấy chữ ký?"
// (`signed:scan-path`, cùng nguồn sự thật với cổng BI-127). Có ⇒ hiện chip trong thanh trạng thái (`#sb-signed`, theo tiền lệ
// `#sb-vault`); lưu xong (sạch) hoặc mở tài liệu khác ⇒ tắt. KHÔNG chặn, KHÔNG đụng đường sửa nào (BI-3): `markDirty` chỉ bắn một lời
// gọi bất đồng bộ không bao giờ ném.
//
// Cách test: CẮT NGUYÊN VĂN (a) handler `signed:scan-path` ở main.js, chạy với file thật (ký giả dựng tay) trên đĩa thật;
// (b) khối BI-146 + `markDirty` + `markClean` ở renderer/app.js, chạy với đồ giả có điều khiển được thứ tự trả lời; rồi (c) ghim cấu trúc
// (preload, HTML, i18n, CSS, `loadBytes`, `updateStatusBar`) vì renderer không chạy được trong node.
//
// Run:  node desktop/test/signed-edit-warn.test.js      (or: npm run test:signededit)

const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../src/signed-scan");

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
const tick = () => new Promise((r) => setImmediate(r));
let unhandled = 0;
process.on("unhandledRejection", () => unhandled++);

const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const MAIN = R("src/main.js");
const APP = R("renderer/app.js");
const PRELOAD = R("src/preload.js");
const HTML = R("renderer/index.html");
const I18N = R("renderer/i18n.js");
const CSS = R("renderer/app.css");

const cut = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from + " … " + to);
  return src.slice(a, b);
};
// thân một hàm / handler theo cặp ngoặc nhọn, bắt đầu từ `from`
const bodyFrom = (src, from) => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("không thấy: " + from);
  const open = src.indexOf("{", a);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}" && --d === 0) return src.slice(a, i + 1);
  }
  throw new Error("ngoặc không cân: " + from);
};

// ---- file ký giả (cùng dạng với signed-scan.test.js) ----
const pad = (n) => String(n).padStart(10, "0");
function buildSigned() {
  const hexLen = 64;
  const pre =
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n" +
    "<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [ZZZZZZZZZZ AAAAAAAAAA CCCCCCCCCC LLLLLLLLLL] /Contents ";
  const post = " /M (D:20260101000000Z) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  const l1 = pre.length;
  const c = pre.length + hexLen + 2;
  const body = pre + "<" + "0".repeat(hexLen) + ">" + post;
  const l2 = body.length - c;
  const s = body.replace("ZZZZZZZZZZ", pad(0)).replace("AAAAAAAAAA", pad(l1)).replace("CCCCCCCCCC", pad(c)).replace("LLLLLLLLLL", pad(l2));
  return Buffer.from(s, "latin1");
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signededit-"));
  const file = (name, buf) => {
    const p = path.join(root, name);
    fs.writeFileSync(p, buf);
    return p;
  };

  // ======== A. handler `signed:scan-path` ở main.js (chạy thật trên file thật) ========
  {
    const src = bodyFrom(MAIN, 'ipcMain.handle("signed:scan-path"');
    const handlers = {};
    new Function("ipcMain", "SignedScan", src + ");")({ handle: (n, f) => (handlers[n] = f) }, S);
    const scan = handlers["signed:scan-path"];
    ok("A0 handler đã đăng ký", typeof scan === "function");
    const signed = file("ky.pdf", buildSigned());
    const plain = file("thuong.pdf", Buffer.from("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n"));
    check("A1 file ký: count = 1", await scan(null, signed), { count: 1 });
    check("A2 file thường: count = 0", await scan(null, plain), { count: 0 });
    check("A3 file không tồn tại ⇒ 0, không ném", await scan(null, path.join(root, "khong-co.pdf")), { count: 0 });
    check("A4 thư mục ⇒ 0, không ném", await scan(null, root), { count: 0 });
    for (const [label, v] of [["rỗng", ""], ["null", null], ["undefined", undefined], ["số", 42], ["đối tượng", { a: 1 }], ["mảng", ["x"]]]) {
      check(`A5 đầu vào ${label} ⇒ 0, không ném`, await scan(null, v), { count: 0 });
    }
    ok("A6 chỉ trả { count } — không lộ đường dẫn/kích thước/vị trí chữ ký", Object.keys(await scan(null, signed)).join() === "count");
    ok("A7 quét THEO KHÚC (findIntactSignatures), không nạp cả file vào RAM", /findIntactSignatures\(/.test(src) && !/readFile\(|readFileSync\(/.test(src));
    ok("A8 handler không ghi gì (chỉ đọc)", !/writeFile|unlink|rename|rm\(/.test(src));
  }

  // ======== B. logic renderer: khối BI-146 + markDirty + markClean ========
  const blockSrc = cut(APP, "// ---- BI-146", "function scheduleAutosave()");
  const tStub = (vi, p) => (p ? vi.replace(/\{(\w+)\}/g, (_, k) => p[k]) : vi);
  function makeR(o = {}) {
    const calls = { scan: [], status: 0, dirtyInd: 0, autosave: 0 };
    const state = { dirty: false, docId: "d1", path: "C:/x/hd.pdf", signedInfo: null, ...(o.state || {}) };
    const scanImpl = o.scan || (async () => ({ count: 0 }));
    const win = o.noDesktop
      ? {}
      : { desktop: { recovery: { clear() {} }, ...(o.noApi ? {} : { signedScan: (p) => (calls.scan.push(p), scanImpl(p)) }) } };
    const api = new Function(
      "state", "window", "updateStatusBar", "updateDirtyIndicator", "scheduleAutosave", "t",
      "let lastAutosaveLen = 0; let autosaveDebounceTimer = null;\n" + blockSrc +
        "\nreturn { markDirty, markClean, checkSignedOnEdit, signedChipFor };"
    )(state, win, () => calls.status++, () => calls.dirtyInd++, () => calls.autosave++, tStub);
    return { state, calls, ...api };
  }

  {
    const r = makeR({ scan: async () => ({ count: 2 }) });
    r.markDirty();
    await tick();
    check("B1 sạch→bẩn: hỏi main đúng 1 lần, bằng ĐƯỜNG DẪN (không gửi byte)", r.calls.scan, ["C:/x/hd.pdf"]);
    check("B1 … ghi nhận kết quả theo (docId, path, count)", r.state.signedInfo, { docId: "d1", path: "C:/x/hd.pdf", count: 2 });
    ok("B1 … và vẽ lại thanh trạng thái", r.calls.status >= 1);
    ok("B1 … markDirty vẫn làm việc cũ (cờ bẩn, chỉ báo, autosave)", r.state.dirty === true && r.calls.dirtyInd === 1 && r.calls.autosave === 1);
    const chip = r.signedChipFor(r.state);
    check("B1 chip hiện, nói số chữ ký", [chip.hidden, /2/.test(chip.text), /Ctrl\+Z|hoàn tác/i.test(chip.title) || chip.title.length > 20], [false, true, true]);

    r.markDirty();
    await tick();
    check("B2 đã bẩn rồi sửa tiếp: KHÔNG hỏi lại (chỉ chuyển tiếp sạch→bẩn mới hỏi)", r.calls.scan.length, 1);

    const before = r.calls.status;
    r.markClean();
    check("B3 lưu xong (sạch): xoá thông tin, chip tắt", [r.state.signedInfo, r.signedChipFor(r.state).hidden], [null, true]);
    ok("B3 … và vẽ lại thanh trạng thái ngay", r.calls.status > before);
    r.markDirty();
    await tick();
    check("B4 sửa lại sau khi lưu: hỏi LẠI (đĩa có thể đã đổi — vd. ghi đè làm mất chữ ký)", r.calls.scan.length, 2);
  }
  {
    const r = makeR({ scan: async () => ({ count: 0 }) });
    r.markDirty();
    await tick();
    check("B5 file không ký: không chip", [r.state.signedInfo, r.signedChipFor(r.state).hidden], [null, true]);
  }
  {
    const r = makeR({ state: { path: null } });
    r.markDirty();
    await tick();
    check("B6 tài liệu chưa có đường dẫn: không hỏi main (không có gì trên đĩa để bảo vệ)", [r.calls.scan.length, r.state.signedInfo], [0, null]);
  }
  {
    for (const [label, o] of [["không có API signedScan", { noApi: true }], ["không có window.desktop", { noDesktop: true }]]) {
      const r = makeR(o);
      let threw = false;
      try { r.markDirty(); } catch (_) { threw = true; }
      await tick();
      check(`B7 ${label}: markDirty không ném, không treo`, [threw, r.state.dirty], [false, true]);
    }
  }
  {
    let n = 0;
    const r = makeR({ scan: async () => { if (n++ === 0) throw new Error("IPC chết"); return { count: 1 }; } });
    const u0 = unhandled;
    r.markDirty();
    await tick();
    check("B8 IPC ném: nuốt lỗi, không rác trạng thái, không unhandledRejection", [r.state.signedInfo, unhandled - u0], [null, 0]);
    r.markClean();
    r.markDirty();
    await tick();
    check("B8 … lần chuyển sau thử lại được", r.state.signedInfo && r.state.signedInfo.count, 1);
  }
  {
    for (const [label, v] of [["null", null], ["undefined", undefined], ["{}", {}], ["count chuỗi", { count: "3" }], ["count âm", { count: -1 }], ["count NaN", { count: NaN }], ["count 1.5", { count: 1.5 }]]) {
      const r = makeR({ scan: async () => v });
      r.markDirty();
      await tick();
      check(`B9 kết quả lạ (${label}) ⇒ coi như không ký`, r.state.signedInfo, null);
    }
  }
  // ---- B10: kết quả đến MUỘN không được ghi đè lên thực tế ----
  {
    const gate = {};
    const pend = (key, val) => new Promise((res) => (gate[key] = () => res(val)));
    let k = 0;
    const r = makeR({ scan: () => pend("s" + ++k, { count: 4 }) });
    r.markDirty(); // quét 1
    await tick();
    r.markClean(); // người dùng lưu xong trong lúc chờ
    gate.s1();
    await tick();
    check("B10a lưu xong trong lúc chờ ⇒ bỏ kết quả (chip không bật lại trên tài liệu sạch)", r.state.signedInfo, null);
  }
  {
    const gate = {};
    const pend = (key, val) => new Promise((res) => (gate[key] = () => res(val)));
    let k = 0;
    const r = makeR({ scan: () => pend("s" + ++k, { count: 4 }) });
    r.markDirty();
    await tick();
    r.state.docId = "d2"; // mở tài liệu khác (loadBytes đổi docId)
    gate.s1();
    await tick();
    check("B10b đổi tài liệu trong lúc chờ ⇒ bỏ kết quả", r.state.signedInfo, null);
  }
  {
    const gate = {};
    const pend = (key, val) => new Promise((res) => (gate[key] = () => res(val)));
    let k = 0;
    const r = makeR({ scan: () => pend("s" + ++k, { count: 4 }) });
    r.markDirty();
    await tick();
    r.state.path = "C:/x/khac.pdf"; // Lưu thành sang đường dẫn khác
    gate.s1();
    await tick();
    check("B10c đổi đường dẫn trong lúc chờ ⇒ bỏ kết quả", r.state.signedInfo, null);
  }
  {
    const gate = {};
    const pend = (key, val) => new Promise((res) => (gate[key] = () => res(val)));
    let k = 0;
    const r = makeR({ scan: () => pend("s" + ++k, k === 1 ? { count: 5 } : { count: 1 }) });
    r.markDirty(); // quét 1 (chậm)
    await tick();
    r.markClean();
    r.markDirty(); // quét 2
    await tick();
    gate.s2();
    await tick();
    gate.s1(); // trả lời cũ đến sau
    await tick();
    check("B10d trả lời CŨ đến sau trả lời mới ⇒ giữ kết quả MỚI (count 1, không phải 5)", r.state.signedInfo && r.state.signedInfo.count, 1);
  }
  // ---- B11: chip là hàm thuần của trạng thái ----
  {
    const r = makeR();
    const base = { dirty: true, docId: "d1", path: "p", signedInfo: { docId: "d1", path: "p", count: 3 } };
    check("B11a đủ điều kiện ⇒ hiện", r.signedChipFor(base).hidden, false);
    check("B11b không bẩn ⇒ ẩn", r.signedChipFor({ ...base, dirty: false }).hidden, true);
    check("B11c docId lệch ⇒ ẩn", r.signedChipFor({ ...base, docId: "d9" }).hidden, true);
    check("B11d path lệch ⇒ ẩn", r.signedChipFor({ ...base, path: "q" }).hidden, true);
    check("B11e không có info ⇒ ẩn, chữ rỗng", [r.signedChipFor({ ...base, signedInfo: null }).hidden, r.signedChipFor({ ...base, signedInfo: null }).text], [true, ""]);
    check("B11f count 0 ⇒ ẩn", r.signedChipFor({ ...base, signedInfo: { docId: "d1", path: "p", count: 0 } }).hidden, true);
  }

  // ======== C. ghim cấu trúc ========
  {
    ok("C1 preload: signedScan gọi kênh signed:scan-path", /signedScan:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*"signed:scan-path"/.test(PRELOAD));
    ok("C2 HTML: có #sb-signed trong thanh trạng thái, mặc định ẩn", /<span id="sb-signed"[^>]*\bhidden\b/.test(HTML));
    const skip = cut(I18N, "const SKIP_IDS = new Set([", "]);");
    ok("C3 i18n SKIP_IDS có sb-signed (chữ động, BI-10)", /"sb-signed"/.test(skip));
    ok("C4 CSS có .sb-signed màu cảnh báo", /\.statusbar \.sb-signed\s*\{[^}]*var\(--warn\)/.test(CSS));
    ok("C5 i18n có bản tiếng Anh cho chữ chip + chú giải", /"⚠ Đang sửa file đã ký \(\{n\} chữ ký\)":/.test(I18N) && /"File trên đĩa đang có \{n\} chữ ký số\./.test(I18N));
    const lb = bodyFrom(APP, "async function loadBytes(");
    ok("C6 loadBytes xoá signedInfo của tài liệu cũ", /state\.signedInfo\s*=\s*null/.test(lb));
    const us = bodyFrom(APP, "function updateStatusBar(");
    ok("C7 updateStatusBar vẽ chip qua signedChipFor", /signedChipFor\(state\)/.test(us) && /\$\("sb-signed"\)/.test(us));
    ok("C8 state khởi tạo có signedInfo: null", /signedInfo:\s*null/.test(cut(APP, "const state = {", "const sidecar")));
    const calls = (APP.match(/\bcheckSignedOnEdit\(/g) || []).length;
    check("C9 checkSignedOnEdit: 1 định nghĩa + markDirty + đường ẩn trang (đặt cờ bẩn thẳng) — không chỗ nào khác", calls, 3);
    const hp = bodyFrom(APP, "async function hidePagesWithPassword(");
    ok("C9b đường ẩn trang (không qua markDirty) tự gọi quét ở lần chuyển sạch→bẩn", /const wasDirty\s*=\s*state\.dirty/.test(hp) && /if\s*\(\s*!wasDirty\s*\)\s*checkSignedOnEdit\(/.test(hp));
    const noComments = (x) => x.replace(/\/\/.*$/gm, "");
    const md = noComments(bodyFrom(APP, "function markDirty("));
    ok("C10 markDirty: chỉ hỏi ở lần chuyển sạch→bẩn, không await (không chặn pushUndo)", /const wasDirty\s*=\s*state\.dirty/.test(md) && /if\s*\(\s*!wasDirty\s*\)\s*checkSignedOnEdit\(/.test(md) && !/await\s/.test(md));
    const pu = noComments(bodyFrom(APP, "function pushUndo("));
    ok("C11 pushUndo vẫn đồng bộ (không await/async — BI-3)", !/await\s/.test(pu) && !/^async/.test(pu));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nsigned-edit-warn: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("LỖI KỊCH BẢN:", e && e.stack || e);
  process.exit(1);
});
