"use strict";

// BI-130 — "Lưu nối thêm" cho file đã ký (src/signed-save.js + nối dây ở main.js / preload.js / app.js).
//
// BỐN TẦNG, mỗi tầng bắt một loại lỗi khác:
//   1. planSignedWrite với đồ giả — mọi nhánh quyết định (nối được / nối hỏng / kết quả không giữ tiền tố /
//      nút bấm lạ), và NGUYÊN TẮC: một lần nối hỏng không bao giờ thành "ghi đè cho xong".
//   2. appendViaSidecar với một máy chủ HTTP thật chạy tại chỗ — hợp đồng dây với route BI-129 (thành công =
//      application/pdf + header; mọi thất bại = JSON; 400/401/rác; hết giờ; cổng đóng; thân là view có offset).
//   3. CẮT NGUYÊN VĂN hai khối ở main.js (`askSignedOverwrite`, handler `file:write-pdf`) rồi chạy thật với
//      cổng BI-127 thật + file thật trên đĩa + sidecar giả — vì main không chạy được trong node, đây là cách
//      duy nhất để bắt lỗi nối dây (ánh xạ nút, cổng đứng trước lệnh ghi, ghi đúng `plan.data`).
//   4. GHIM CẤU TRÚC renderer/preload: cờ `contentRemoved` đi đủ ba chặng, và mặc định là ĐÓNG.
//
// Run:  node desktop/test/signed-save.test.js      (or: npm run test:signedsave)

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const SS = require("../src/signed-save");
const SignedScan = require("../src/signed-scan");
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signedsave-"));
let seq = 0;
function tmpFile(buf) {
  const p = path.join(TMP, `f${seq++}.pdf`);
  fs.writeFileSync(p, buf);
  return p;
}

// Một file "đã ký" giả (cùng cách dựng với signed-scan.test.js): [0 L1 C L2], ô /Contents hex.
const pad = (n) => String(n).padStart(10, "0");
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

// Một lệnh gọi bị treo (vòng lặp vô hạn, socket không bao giờ đóng) phải là MỘT CA ĐỎ có tên, không phải cả bộ test đứng yên.
// Chú ý: vòng lặp `await` vô hạn chỉ chạy bằng microtask nên timer cũng không cứu được — vì thế các `ask` giả bên dưới
// tự đếm số lần bị gọi và tự huỷ sau vài lần.
const within = (ms, p, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

const EDITED = Buffer.from("%PDF-1.7\n% bản đã sửa bằng pdf-lib — KHÔNG bắt đầu bằng byte cũ\n%%EOF\n", "utf8");

// ---- 1. planSignedWrite với đồ giả ----------------------------------------------------------
function fakeScan(table) {
  // table: hàm (fp, data) => {signed, loss, count}. Ghi lại lời gọi.
  const calls = [];
  return {
    calls,
    checkOverwrite: async (fp, data) => {
      calls.push({ fp, data });
      return table(fp, data);
    },
  };
}
const LOSS = { signed: true, loss: true, count: 2 };
const KEPT = { signed: true, loss: false, count: 2 };

(async () => {
  // 1a. không mất gì ⇒ ghi thẳng, không hỏi, không gọi nối
  {
    let asked = 0;
    let appended = 0;
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan(() => ({ signed: false, loss: false })),
      ask: async () => (asked++, "overwrite"),
      append: async () => (appended++, { ok: true, bytes: Buffer.alloc(1) }),
    });
    check("1a không mất gì: ghi thẳng bản người dùng", [r.action, r.data === EDITED], ["write", true]);
    check("1a … không hỏi, không nối", [asked, appended], [0, 0]);
  }

  // 1b. các câu trả lời không phải "nối"
  for (const [ans, expect] of [
    ["overwrite", "write"],
    ["copy", "copy"],
    ["cancel", "cancel"],
    ["", "cancel"],
    [undefined, "cancel"],
    ["Append", "cancel"], // viết hoa: lạ ⇒ huỷ
    [2, "cancel"],
  ]) {
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan(() => LOSS),
      ask: async () => ans,
      append: async () => ({ ok: true, bytes: Buffer.alloc(1) }),
    });
    check(`1b trả lời ${JSON.stringify(ans)} ⇒ ${expect}`, r.action, expect);
    if (ans === "overwrite") check("1b … ghi đè ghi ĐÚNG bản người dùng, đánh dấu confirmed", [r.data === EDITED, r.confirmed], [true, true]);
  }

  // 1c. nối thành công: ghi bản nối, không phải bản của người dùng; kiểm lại bằng cổng
  {
    const merged = Buffer.from("MERGED");
    const scan = fakeScan((fp, d) => (d === merged ? KEPT : LOSS));
    const asks = [];
    const r = await SS.planSignedWrite({
      fp: "d:/a.pdf",
      data: EDITED,
      scan,
      ask: async (q) => (asks.push(q), "append"),
      append: async (fp, d) => ({ ok: true, bytes: merged, stats: { changed: 3, added: 1, reused: 0, unchanged: false } }),
    });
    check("1c nối được: ghi bản nối", [r.action, r.data === merged, r.incremental], ["write", true, true]);
    check("1c … mang số liệu", r.stats, { changed: 3, added: 1, reused: 0, unchanged: false });
    check("1c … hỏi đúng MỘT lần, có nút nối, kèm số chữ ký", asks, [{ count: 2, canAppend: true, failed: null }]);
    check("1c … kiểm lại bản nối bằng cổng, trên ĐÚNG đường dẫn", scan.calls.map((c) => [c.fp, c.data === merged]), [["d:/a.pdf", false], ["d:/a.pdf", true]]);
  }

  // 1d. nối thất bại ⇒ hỏi LẠI không có nút nối, kèm lý do; không bao giờ tự ghi đè
  for (const [label, appendFn, why] of [
    ["từ chối có lý do", async () => ({ ok: false, reason: "repaired", detail: "x" }), "repaired"],
    ["từ chối không lý do", async () => ({ ok: false }), "worker_failed"],
    ["trả null", async () => null, "worker_failed"],
    ["ném lỗi", async () => { throw new Error("boom"); }, "worker_failed"],
    ["ok nhưng không có byte", async () => ({ ok: true }), "worker_failed"],
  ]) {
    const asks = [];
    let n = 0;
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan(() => LOSS),
      ask: async (q) => (asks.push(q), ++n === 1 ? "append" : "cancel"),
      append: appendFn,
    });
    check(`1d ${label}: hỏi hai lần`, asks.length, 2);
    check(`1d ${label}: lần hai KHÔNG có nút nối, có lý do`, [asks[1] && asks[1].canAppend, asks[1] && asks[1].failed], [false, why]);
    check(`1d ${label}: huỷ ở lần hai ⇒ không ghi gì`, r.action, "cancel");
  }

  // 1e. nối hỏng rồi người dùng chọn "ghi đè": ghi bản NGƯỜI DÙNG (không phải thứ sidecar trả)
  {
    const bad = Buffer.from("SIDECAR-GARBAGE");
    let n = 0;
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan(() => LOSS), // bản nối cũng "mất chữ ký" ⇒ bị chặn
      ask: async () => (++n === 1 ? "append" : "overwrite"),
      append: async () => ({ ok: true, bytes: bad }),
    });
    check("1e bản nối KHÔNG giữ tiền tố bị bỏ", [r.action, r.data === EDITED, r.data === bad, r.confirmed], ["write", true, false, true]);
  }

  // 1f. bản nối "không còn ký" (g2.signed=false) cũng bị bỏ — không đủ chỉ là !loss
  {
    const m = Buffer.from("M");
    let n = 0;
    const asks = [];
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan((fp, d) => (d === m ? { signed: false, loss: false } : LOSS)),
      ask: async (q) => (asks.push(q), ++n === 1 ? "append" : "cancel"),
      append: async () => ({ ok: true, bytes: m }),
    });
    check("1f bản nối không còn chữ ký nào ⇒ bị bỏ", [r.action, asks[1] && asks[1].failed], ["cancel", "prefix_changed"]);
  }

  // 1g. không có đường nối (append = null): hộp không có nút nối; "append" bị coi là huỷ
  {
    const asks = [];
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan(() => LOSS),
      ask: async (q) => (asks.push(q), asks.length > 5 ? "cancel" : "append"),
      append: null,
    });
    check("1g không có đường nối: hỏi MỘT lần, canAppend=false", asks, [{ count: 2, canAppend: false, failed: null }]);
    check("1g … trả lời 'append' khi chưa được đề nghị ⇒ huỷ", r.action, "cancel");
  }

  // 1h. lần hai mà nút hỏng vẫn trả "append": huỷ, không nối lần nữa
  {
    let calls = 0;
    let asks = 0;
    const r = await SS.planSignedWrite({
      fp: "x.pdf",
      data: EDITED,
      scan: fakeScan(() => LOSS),
      ask: async () => (++asks > 5 ? "cancel" : "append"), // tự huỷ: nếu code lặp mãi, test vẫn kết thúc và ĐỎ
      append: async () => (calls++, { ok: false, reason: "timeout" }),
    });
    check("1h chỉ thử nối MỘT lần, hỏi hai lần rồi huỷ", [calls, asks, r.action], [1, 2, "cancel"]);
  }

  // 1i. bảng lý do: mọi lý do của lõi Python đều có câu, lý do lạ không bị in thẳng
  {
    const py = fs.readFileSync(path.join(__dirname, "..", "..", "src", "pdf", "incremental.py"), "utf8");
    // Lấy nội dung giữa `NAME = (` và dòng bắt đầu bằng `)`, bỏ chú thích `# ...` rồi gom các chuỗi trong "".
    const tuple = (name) => {
      const m = new RegExp("^" + name + "\\s*=\\s*\\(\\r?\\n([\\s\\S]*?)\\r?\\n\\)", "m").exec(py);
      const body = (m ? m[1] : "").split(/\r?\n/).map((l) => l.replace(/#.*$/, "")).join("\n");
      return (body.match(/"([a-z_]+)"/g) || []).map((x) => x.slice(1, -1));
    };
    const reasons = tuple("REASONS");
    const wr = tuple("WORKER_REASONS");
    ok("1i đọc được danh sách lý do từ incremental.py", reasons.length >= 10 && wr.length === 4, JSON.stringify({ reasons, wr }));
    for (const r of [...reasons, ...wr]) ok(`1i lý do "${r}" có câu tiếng Việt`, SS.reasonText(r) !== "lý do không rõ");
    check("1i lý do lạ ⇒ câu chung", SS.reasonText("<script>alert(1)</script>"), "lý do không rõ");
    check("1i 'constructor' không lọt qua nguyên mẫu", SS.reasonText("constructor"), "lý do không rõ");
  }

  // ---- 2. appendViaSidecar với máy chủ HTTP thật ------------------------------------------------
  const seen = [];
  let mode = "ok";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, token: req.headers["x-sidecar-token"], ct: req.headers["content-type"], body: Buffer.concat(chunks) });
      if (mode === "ok") {
        res.writeHead(200, { "Content-Type": "application/pdf", "X-Changed": "4", "X-Added": "2", "X-Reused": "1" });
        return res.end(Buffer.from("%PDF-merged"));
      }
      if (mode === "unchanged") {
        res.writeHead(200, { "Content-Type": "application/pdf", "X-Unchanged": "1" });
        return res.end(Buffer.from("%PDF-same"));
      }
      if (mode === "refused") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, refused: true, reason: "encrypted", detail: "file có mật khẩu" }));
      }
      if (mode === "400") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ detail: "PDF quá lớn" }));
      }
      if (mode === "401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ detail: "bad token" }));
      }
      if (mode === "garbage") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<html>không phải JSON</html>");
      }
      if (mode === "json-as-pdf-status-500") {
        res.writeHead(500, { "Content-Type": "application/pdf" }); // trạng thái xấu nhưng đúng kiểu ⇒ KHÔNG được coi là thành công
        return res.end(Buffer.from("%PDF-oops"));
      }
      if (mode === "hang") return; // không bao giờ trả lời
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const call = (extra) => SS.appendViaSidecar({ port, token: "tok123", originalPath: "D:\\Hợp đồng\\a b&c.pdf", data: EDITED, ...extra });

  {
    mode = "ok";
    const r = await call();
    check("2a thành công: ok + byte + số liệu", [r.ok, r.bytes.toString(), r.stats], [true, "%PDF-merged", { changed: 4, added: 2, reused: 1, unchanged: false }]);
    const s = seen[seen.length - 1];
    check("2a thân gửi đi = bản người dùng nguyên văn", Buffer.compare(s.body, EDITED), 0);
    check("2a token đi kèm header", s.token, "tok123");
    check("2a Content-Type", s.ct, "application/pdf");
    const q = new URL("http://x" + s.url);
    check("2a đường dẫn có dấu cách/&/tiếng Việt đi nguyên vẹn qua query", [q.pathname, q.searchParams.get("original_path")], ["/save-incremental-bin", "D:\\Hợp đồng\\a b&c.pdf"]);
  }
  {
    mode = "unchanged";
    const r = await call();
    check("2b X-Unchanged: 1 ⇒ stats.unchanged", [r.ok, r.stats.unchanged], [true, true]);
  }
  {
    mode = "refused";
    const r = await call();
    check("2c JSON từ chối ⇒ ok:false kèm lý do của sidecar", [r.ok, r.reason, r.detail], [false, "encrypted", "file có mật khẩu"]);
  }
  for (const m of ["400", "401", "garbage", "json-as-pdf-status-500"]) {
    mode = m;
    const r = await call();
    check(`2d ${m}: là thất bại`, r.ok, false);
    ok(`2d ${m}: có lý do dạng chuỗi`, typeof r.reason === "string" && r.reason.length > 0);
  }
  {
    mode = "hang";
    const t0 = Date.now();
    const r = (await within(5000, call({ timeoutMs: 300 }), { ok: "TREO >5s", reason: "TREO" }));
    check("2e sidecar treo ⇒ timeout, không treo theo", [r.ok, r.reason], [false, "timeout"]);
    ok("2e … và trả về nhanh", Date.now() - t0 < 5000);
  }
  {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const p = dead.address().port;
    await new Promise((r) => dead.close(r));
    const r = await SS.appendViaSidecar({ port: p, token: "t", originalPath: "D:\\a.pdf", data: EDITED });
    check("2f cổng đóng ⇒ sidecar_unavailable, không ném", [r.ok, r.reason], [false, "sidecar_unavailable"]);
    const r2 = await within(5000, SS.appendViaSidecar({ port: null, token: "t", originalPath: "D:\\a.pdf", data: EDITED }), { ok: "TREO", reason: "TREO" });
    check("2f không có cổng ⇒ sidecar_unavailable", [r2.ok, r2.reason], [false, "sidecar_unavailable"]);
    const r3 = await within(5000, SS.appendViaSidecar({ port, token: "t", originalPath: "", data: EDITED }), { ok: "TREO", reason: "TREO" });
    check("2f không có đường dẫn ⇒ sidecar_unavailable", [r3.ok, r3.reason], [false, "sidecar_unavailable"]);
  }
  {
    // Thân là một VIEW có byteOffset (đúng dạng structured-clone của IPC có thể trả): chỉ gửi đúng đoạn view.
    mode = "ok";
    const big = Buffer.alloc(100, 0x41);
    const view = new Uint8Array(big.buffer, big.byteOffset + 10, 20);
    await SS.appendViaSidecar({ port, token: "t", originalPath: "D:\\a.pdf", data: view });
    const s = seen[seen.length - 1];
    check("2g view có offset: gửi đúng 20 byte, không phải cả buffer", [s.body.length, s.body.every((b) => b === 0x41)], [20, true]);
    await SS.appendViaSidecar({ port, token: "t", originalPath: "D:\\a.pdf", data: [37, 80, 68, 70] });
    check("2g mảng số thường vẫn gửi được", seen[seen.length - 1].body.toString(), "%PDF");
  }

  // ---- 3. cắt nguyên văn hai khối ở main.js và chạy thật ----------------------------------------
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const cut = (from, to) => {
    const a = MAIN.indexOf(from);
    const b = MAIN.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from);
    return MAIN.slice(a, b);
  };
  const askSrc = cut("async function askSignedOverwrite(", 'ipcMain.handle("dialog:save-pdf"');
  const handlerSrc = cut('ipcMain.handle("file:write-pdf"', "// ---- Tạo bản theo mẫu");

  // 3a. askSignedOverwrite: ánh xạ nút → hành động
  const boxes = [];
  function makeAsk({ lang = "vi", respond }) {
    const dialog = {
      showMessageBox: async (win, o) => {
        boxes.push(o);
        const v = respond(o);
        if (v instanceof Error) throw v;
        return { response: v };
      },
    };
    return new Function("dialog", "menuLang", "SignedSave", askSrc + "; return askSignedOverwrite;")(dialog, lang, SS);
  }
  {
    const ask = makeAsk({ respond: () => 0 });
    check("3a có nút nối: nút 0 = append", await ask(null, "D:/a.pdf", 1, "Bản sao", "Copy", { canAppend: true }), "append");
    const o = boxes[boxes.length - 1];
    check("3a có nút nối: 4 nút, đúng thứ tự", o.buttons, ["Lưu nối thêm (giữ chữ ký)", "Bản sao", "Vẫn ghi đè", "Huỷ"]);
    check("3a … nút mặc định là 0 (nút không phá chữ ký), nút Esc là Huỷ", [o.defaultId, o.cancelId], [0, 3]);
    ok("3a … lời giải thích nói thật: trình đọc vẫn có thể báo đã sửa; nội dung đã xoá còn trong lịch sử", /báo file đã sửa/.test(o.detail) && /vẫn còn trong lịch sử/.test(o.detail));
  }
  for (const [resp, expect] of [[0, "append"], [1, "copy"], [2, "overwrite"], [3, "cancel"], [4, "cancel"], [-1, "cancel"], [undefined, "cancel"]]) {
    const ask = makeAsk({ respond: () => resp });
    check(`3a (4 nút) bấm ${resp} ⇒ ${expect}`, await ask(null, "D:/a.pdf", 1, "Bản sao", "Copy", { canAppend: true }), expect);
  }
  for (const [resp, expect] of [[0, "copy"], [1, "overwrite"], [2, "cancel"], [3, "cancel"], [undefined, "cancel"]]) {
    const ask = makeAsk({ respond: () => resp });
    check(`3a (3 nút) bấm ${resp} ⇒ ${expect}`, await ask(null, "D:/a.pdf", 1, "Bản sao", "Copy"), expect);
  }
  {
    const ask = makeAsk({ respond: () => 0 });
    await ask(null, "D:/a.pdf", 2, "Bản sao", "Copy");
    const o = boxes[boxes.length - 1];
    check("3a không có nút nối: 3 nút như BI-127, nút 0 = copy, Esc = Huỷ", [o.buttons, o.defaultId, o.cancelId], [["Bản sao", "Vẫn ghi đè", "Huỷ"], 0, 2]);
    ok("3a … và KHÔNG nhắc tới 'Lưu nối thêm'", !/nối thêm/.test(o.detail));
    await ask(null, "D:/a.pdf", 2, "Bản sao", "Copy", { canAppend: false, failed: "repaired" });
    const o2 = boxes[boxes.length - 1];
    ok("3a nối hỏng: hộp ba nút kèm lý do bằng tiếng Việt", /Không giữ được chữ ký bằng cách nối thêm \(file gốc bị lỗi cấu trúc/.test(o2.detail) && o2.buttons.length === 3);
    const askEn = makeAsk({ lang: "en", respond: () => 0 });
    await askEn(null, "D:/a.pdf", 2, "Bản sao", "Copy", { canAppend: true });
    const o3 = boxes[boxes.length - 1];
    check("3a bản tiếng Anh", [o3.buttons[0], o3.buttons[1], o3.buttons[3]], ["Save as appended revision (keep signature)", "Copy", "Cancel"]);
  }
  {
    const ask = makeAsk({ respond: () => new Error("dialog hỏng") });
    check("3a hộp thoại ném lỗi ⇒ huỷ (không bao giờ thành ghi đè)", await ask(null, "D:/a.pdf", 1, "a", "b", { canAppend: true }), "cancel");
  }

  // 3b. handler file:write-pdf, đầu-cuối: cổng thật + file thật + sidecar giả
  let sidecarState = { state: "ready", port, token: "tok-main" };
  let answers = [];
  const asked = [];
  const handlers = {};
  const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
  const dialog = {
    showMessageBox: async (win, o) => {
      asked.push(o);
      const a = answers.shift();
      if (a === undefined) throw new Error("hộp hỏi nhiều hơn dự kiến");
      return { response: a };
    },
  };
  new Function(
    "ipcMain", "fs", "SignedScan", "SignedSave", "asWritable", "senderWindow", "Tabs", "dialog", "menuLang", "getSidecar",
    askSrc + "\n" + handlerSrc.replace(/sidecarState/g, "getSidecar()")
  )(ipcMain, fs, SignedScan, SS, asWritable, () => null, { findDoc: () => null }, dialog, "vi", () => sidecarState);
  const write = handlers["file:write-pdf"];
  ok("3b đã nạp được handler file:write-pdf", typeof write === "function");
  const reset = () => {
    seen.length = 0;
    asked.length = 0;
  };

  const ORIGINAL = buildSigned();
  const APPENDED = Buffer.concat([ORIGINAL, Buffer.from("\n%% revision nối\n")]);
  // sidecar giả trả APPENDED khi mode 'merged'

  server.removeAllListeners("request");
  let smode = "merged";
  server.on("request", (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, token: req.headers["x-sidecar-token"], body: Buffer.concat(chunks) });
      if (smode === "merged") {
        res.writeHead(200, { "Content-Type": "application/pdf", "X-Changed": "1" });
        return res.end(APPENDED);
      }
      if (smode === "garbage-pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        return res.end(Buffer.from("%PDF-1.4\nkhông liên quan\n%%EOF\n"));
      }
      if (smode === "refused-repaired") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: false, refused: true, reason: "repaired", detail: "" }));
      }
    });
  });

  {
    // E1: ký + nối thành công
    reset();
    const fp = tmpFile(ORIGINAL);
    answers = [0]; // Lưu nối thêm
    smode = "merged";
    const r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
    check("E1 trả saved + incremental", [r.saved, r.incremental, r.path === fp], [true, true, true]);
    check("E1 đĩa = bản nối (bắt đầu bằng ĐÚNG byte cũ)", Buffer.compare(fs.readFileSync(fp), APPENDED), 0);
    check("E1 hỏi một lần, hộp có nút nối", [asked.length, asked[0].buttons.length], [1, 4]);
    check("E1 sidecar nhận: bản người dùng, token của main, đường dẫn file", [Buffer.compare(seen[0].body, EDITED), seen[0].token, new URL("http://x" + seen[0].url).searchParams.get("original_path") === fp], [0, "tok-main", true]);
  }
  for (const [label, cr] of [["true", true], ["undefined", undefined], ["null", null], ["1", 1], ["'false' (chuỗi)", "false"]]) {
    // E2: renderer báo đã xoá nội dung / thiếu thông tin ⇒ KHÔNG đề nghị nối; sidecar không bị gọi
    reset();
    const fp = tmpFile(ORIGINAL);
    answers = [2]; // (ba nút) Huỷ
    const r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: cr });
    check(`E2 contentRemoved=${label}: hộp KHÔNG có nút nối`, asked.map((a) => a.buttons.length), [3]);
    check(`E2 contentRemoved=${label}: huỷ ⇒ không ghi, không gọi sidecar`, [r.saved, r.canceled, seen.length, Buffer.compare(fs.readFileSync(fp), ORIGINAL)], [false, true, 0, 0]);
  }
  {
    // E3: sidecar chưa sẵn sàng
    for (const st of [{ state: "starting", port: null, token: "t" }, { state: "error", port: null, token: "t" }, { state: "ready", port: null, token: "t" }]) {
      reset();
      sidecarState = st;
      const fp = tmpFile(ORIGINAL);
      answers = [2];
      await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
      check(`E3 sidecar ${st.state}/${st.port}: hộp ba nút`, asked.map((a) => a.buttons.length), [3]);
    }
    sidecarState = { state: "ready", port, token: "tok-main" };
  }
  {
    // E4: sidecar trả byte KHÔNG giữ tiền tố ⇒ bỏ; hộp hai lần; chọn ghi đè ⇒ ghi bản NGƯỜI DÙNG
    reset();
    const fp = tmpFile(ORIGINAL);
    answers = [0, 2]; // nối, rồi (ba nút) Huỷ
    smode = "garbage-pdf";
    let r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
    check("E4 bản nối rác bị chặn bởi cổng JS: đĩa còn nguyên, hộp hai lần", [r.saved, r.canceled, Buffer.compare(fs.readFileSync(fp), ORIGINAL), asked.length], [false, true, 0, 2]);
    ok("E4 hộp thứ hai ghi lý do 'kết quả không giữ nguyên byte cũ'", /kết quả không giữ nguyên byte cũ/.test(asked[1].detail) && asked[1].buttons.length === 3);
    reset();
    answers = [0, 1]; // nối (hỏng), rồi Vẫn ghi đè
    r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
    check("E4 người dùng chọn ghi đè sau khi nối hỏng: đĩa = bản NGƯỜI DÙNG, không phải rác của sidecar", [r.saved, r.incremental, Buffer.compare(fs.readFileSync(fp), EDITED)], [true, undefined, 0]);
  }
  {
    // E5: sidecar từ chối; chọn "bản sao" ⇒ signedFile (renderer sẽ mở Lưu thành)
    reset();
    smode = "refused-repaired";
    const fp = tmpFile(ORIGINAL);
    answers = [0, 0]; // nối (bị từ chối), rồi (ba nút) Bản sao
    const r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
    check("E5 bị từ chối rồi chọn bản sao ⇒ signedFile, không ghi", [r.saved, r.signedFile, Buffer.compare(fs.readFileSync(fp), ORIGINAL)], [false, true, 0]);
    ok("E5 hộp thứ hai nêu lý do 'lỗi cấu trúc'", /lỗi cấu trúc/.test(asked[1].detail));
  }
  {
    // E6: sidecar chết (cổng đóng)
    reset();
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const p = dead.address().port;
    await new Promise((r) => dead.close(r));
    sidecarState = { state: "ready", port: p, token: "t" };
    const fp = tmpFile(ORIGINAL);
    answers = [0, 2];
    const r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
    check("E6 sidecar không trả lời ⇒ hỏi lại ba nút, không ghi", [r.saved, asked.length, asked[1] && asked[1].buttons.length, Buffer.compare(fs.readFileSync(fp), ORIGINAL)], [false, 2, 3, 0]);
    sidecarState = { state: "ready", port, token: "tok-main" };
  }
  {
    // E7: file KHÔNG ký ⇒ ghi thẳng, không hộp, không gọi sidecar (không đổi hành vi cũ)
    reset();
    const fp = tmpFile(Buffer.from("%PDF-1.4\nunsigned\n%%EOF\n"));
    answers = [];
    const r = await write({ sender: null }, { path: fp, data: EDITED, contentRemoved: false });
    check("E7 file không ký: ghi thẳng bản người dùng", [r.saved, r.incremental, asked.length, seen.length, Buffer.compare(fs.readFileSync(fp), EDITED)], [true, undefined, 0, 0, 0]);
    // file chưa tồn tại (lần Lưu đầu)
    const fresh = path.join(TMP, "fresh.pdf");
    const r2 = await write({ sender: null }, { path: fresh, data: EDITED, contentRemoved: false });
    check("E7 file chưa có: tạo mới", [r2.saved, Buffer.compare(fs.readFileSync(fresh), EDITED)], [true, 0]);
  }
  {
    // E8: bản mới ĐÃ giữ nguyên vùng ký (ví dụ lần Lưu sau một lần nối) ⇒ ghi thẳng, không hỏi
    reset();
    const fp = tmpFile(ORIGINAL);
    answers = [];
    const r = await write({ sender: null }, { path: fp, data: APPENDED, contentRemoved: false });
    check("E8 bản mới đã giữ tiền tố: không hộp, không sidecar", [r.saved, r.incremental, asked.length, seen.length], [true, undefined, 0, 0]);
  }
  {
    // E9: lỗi ghi đĩa vẫn trả error (không ném), như trước
    reset();
    answers = [];
    const r = await write({ sender: null }, { path: path.join(TMP, "không-có-thư-mục", "x.pdf"), data: EDITED, contentRemoved: false });
    ok("E9 ghi vào thư mục không tồn tại ⇒ {saved:false, error}", r.saved === false && typeof r.error === "string");
    check("E9 không đường dẫn ⇒ saved:false", (await write({ sender: null }, { path: "", data: EDITED, contentRemoved: false })).saved, false);
  }

  // ---- 4. ghim cấu trúc ---------------------------------------------------------------------------
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
  const preload = read("src", "preload.js");
  const app = read("renderer", "app.js");
  const bake = read("renderer", "editor-bake.js");

  ok("4a preload: cờ chỉ MỞ khi opts.contentRemoved === false (mặc định đóng)", /contentRemoved:\s*!\(opts && opts\.contentRemoved === false\)/.test(preload));
  ok("4a preload: writePdf nhận tham số thứ ba", /writePdf:\s*\(path, data, opts\)/.test(preload));
  ok("4b main: chỉ nối khi contentRemoved === false VÀ sidecar ready VÀ có cổng", /contentRemoved === false &&\s*sidecarState\.state === "ready" && !!sidecarState\.port/.test(MAIN));
  ok("4b main: ghi plan.data (không phải data thô)", /writeFile\(fp, asWritable\(plan\.data\)\)/.test(MAIN));
  ok("4b main: dialog:save-pdf KHÔNG đề nghị nối (không có dữ liệu gốc để so)", !/dialog:save-pdf[\s\S]{0,900}canAppend/.test(MAIN.slice(MAIN.indexOf('ipcMain.handle("dialog:save-pdf"'), MAIN.indexOf('ipcMain.handle("file:write-pdf"'))));
  ok("4c app: saveDoc báo cờ + trang ẩn", /writePdf\(state\.path, state\.bytes, \{\s*contentRemoved: !!\(state\.contentRemoved \|\| state\.vaultPages\.size\),?\s*\}\)/.test(app));
  ok("4c app: cờ khai trong state, mặc định false", /contentRemoved: false,\s*\n\};/.test(app));
  ok("4c app: loadBytes đặt lại về false", /state\.path = fullPath \|\| null;\s*\n\s*state\.contentRemoved = false;/.test(app));
  ok("4c app: ẩn trang đặt cờ true", /state\.bytes = await doc\.save\(\);\s*\n\s*state\.contentRemoved = true;/.test(app));
  ok("4c app: bản khôi phục coi như đã xoá nội dung (sau loadBytes)", /await loadBytes\(toU8\(rec\.bytes\)[^\n]*\n[\s\S]{0,260}state\.contentRemoved = true;/.test(app));
  ok("4c app: toast riêng cho lưu nối", /res\.incremental \? "Đã lưu nối thêm/.test(app));
  ok("4d bake: nướng redaction đặt cờ", /anyRedact = [^\n]*\n[\s\S]{0,400}if \(anyRedact\) state\.contentRemoved = true;/.test(bake));
  // cờ không bao giờ bị hạ ngoài loadBytes
  const lowers = (app.match(/state\.contentRemoved = false/g) || []).length + (bake.match(/state\.contentRemoved = false/g) || []).length;
  check("4e chỉ MỘT chỗ hạ cờ (loadBytes)", lowers, 1);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
