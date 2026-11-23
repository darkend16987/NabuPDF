"use strict";

// BI-141 — BỘ KHUNG e2e: dựng app Electron THẬT, điều khiển renderer qua CDP, trả lời hộp thoại native qua móc
// `src/test-hooks.js`. Thay cho phần chép lặp trong 6 probe cũ (`scripts/probe-*.js`, ~1.700 dòng).
//
//     const { launch } = require("./lib/app-driver");
//     const app = await launch();
//     await app.ready();                              // sidecar sẵn sàng
//     app.dialogs.answer({ showSaveDialog: [path] }); // kịch bản mới (epoch mới)
//     const page = await app.page();
//     await page.eval("(async () => { ... })()");
//     await app.close();
//
// KHÔNG thuộc `npm test` (cần giao diện, có thể cần corpus/OpenSSL ngoài repo). Chạy bằng `npm run e2e`.
//
// NHỮNG BẪY ĐÃ VẤP, nay nằm ở MỘT chỗ (đừng bỏ chúng đi, mỗi cái từng làm một probe treo hoặc báo sai):
//   · CỬA SỔ BỊ COI LÀ ẨN (`visibilityState === "hidden"`): lần probe đầu tiên bị kẹt ở "Đang tải tài liệu…" hơn 5 phút
//     với cửa sổ `hidden` (xem BI-140 — nhưng LƯU Ý `bomb_giant.pdf` vốn mất ~147 s để vẽ ngay cả khi cửa sổ `visible`, nên
//     chưa tách riêng được phần nào do "ẩn"). Ba cờ chống throttle + `Page.bringToFront`, và `ready()` KIỂM `visibilityState`
//     rồi ném lỗi nói rõ nếu vẫn ẩn (thay vì để test chờ vô ích).
//   · MỞ FILE BỆNH LÝ CÓ THỂ MẤT HÀNG PHÚT: `openPdf` chờ viewer vẽ. Đừng đọc "hết giờ" ở bước mở là "treo" trước khi đo —
//     tôi đã mất cả một buổi chia đôi driver/móc/cổng/môi trường vì giả định sai đó (thực tế: 147 s, hết giờ ở 25 s/120 s).
//   · MỌI LỆNH CDP CÓ HẠN GIỜ. Các probe cũ `await` không hạn — một renderer treo là cả probe treo.
//   · KHÔNG spawn qua shell: `kill()` chỉ giết cmd.exe, Electron còn sống giữ cổng debug và làm lần chạy sau treo. Spawn
//     thẳng electron.exe, dọn bằng `taskkill /T /F`; thêm bắt `process.on("exit")` để một test sập không để lại cây Electron.
//   · ĐẾM TIẾN TRÌNH PHẢI LỌC THEO TÊN trước, rồi mới theo dòng lệnh — nếu không câu lệnh PowerShell tự đếm chính nó.
//   · CỔNG: chọn cổng trống ngẫu nhiên (không cố định 9336…), và mỗi lần chạy một `--user-data-dir` + một thư mục móc riêng,
//     nên hai e2e chạy song song không giẫm nhau và khoá single-instance không chặn.

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const DESKTOP = path.join(__dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const p = path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(p)) return p;
  return require(path.join(DESKTOP, "node_modules", "electron"));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---- CDP -------------------------------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        m.error ? rej(new Error(`${m.error.message || JSON.stringify(m.error)}`)) : res(m.result);
      }
    });
    const dead = () => {
      this.closed = true;
      for (const { rej, timer } of this.pending.values()) {
        clearTimeout(timer);
        rej(new Error("CDP: kết nối đóng sớm"));
      }
      this.pending.clear();
    };
    ws.addEventListener("close", dead);
    ws.addEventListener("error", dead);
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error("CDP: không nối được " + wsUrl)));
    });
  }

  send(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP: kết nối đã đóng"));
    const n = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(n);
        rej(new Error(`CDP: ${method} quá ${timeoutMs} ms không trả lời (renderer treo?)`));
      }, timeoutMs);
      this.pending.set(n, { res, rej, timer });
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

// ---- một trang (renderer) ---------------------------------------------------------------------------------
class Page {
  constructor(cdp, target) {
    this.cdp = cdp;
    this.target = target;
  }

  // Chạy biểu thức trong renderer, trả giá trị JSON-hoá được. Ném nếu biểu thức ném.
  async eval(expr, { timeout = 30000 } = {}) {
    const r = await this.cdp.send(
      "Runtime.evaluate",
      { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
      timeout,
    );
    if (r.exceptionDetails) {
      throw new Error("renderer: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || "lỗi không rõ"));
    }
    return r.result.value;
  }

  // Đợi tới khi biểu thức TRẢ GIÁ TRỊ TRUTHY; trả giá trị đó. Hết giờ ⇒ ném, kèm `what` để biết đang đợi gì.
  async waitFor(expr, { timeout = 15000, interval = 150, what = expr } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.eval(expr, { timeout: Math.min(10000, timeout) });
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(interval);
    }
    throw new Error(`hết ${timeout} ms đợi: ${what} (giá trị cuối: ${JSON.stringify(last)})`);
  }

  // Bấm bằng `.click()` thật trên phần tử thật (không gọi tắt hàm). Ném nếu không có phần tử / đang khoá.
  async click(selector) {
    const r = await this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return "no-element"; if (el.disabled) return "disabled"; if (el.hidden) return "hidden";
         el.click(); return "ok"; })()`,
    );
    if (r !== "ok") throw new Error(`click ${selector}: ${r}`);
  }

  // `state.bytes` của tài liệu đang mở, dưới dạng Buffer ở Node — để kiểm bằng công cụ độc lập với app (pdf-lib, zlib, `containsText`).
  async stateBytes() {
    const b64 = await this.eval(
      `(() => { let s = ""; const u = state.bytes; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); })()`,
    );
    return Buffer.from(b64, "base64");
  }

  async visible() {
    return this.eval("document.visibilityState");
  }

  // Gửi một phím tới RENDERER qua CDP (`Input.dispatchKeyEvent`): chạy được các handler `keydown` của trang (Ctrl+Z/Y, Delete…).
  // KHÔNG chạm được phím tắt của MENU NATIVE (Ctrl+S, Ctrl+O, Ctrl+Q — chúng là accelerator của hệ điều hành, CDP không tới) —
  // với những phím đó hãy gọi thẳng hàm (vd. `saveDoc()`), và đừng bao giờ thay bằng gửi phím thật cho cửa sổ nền trước: nó có
  // thể rơi vào một cửa sổ khác của người dùng. Trả về khi cả keyDown và keyUp đã gửi.
  async press(key, { ctrl = false, shift = false, alt = false } = {}) {
    await this.eval(`(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); return true; })()`);
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const named = { Delete: 46, Enter: 13, Escape: 27, Backspace: 8 };
    const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : named[key] || 0;
    const base = {
      key: shift && key.length === 1 ? key.toUpperCase() : key,
      code: key.length === 1 ? "Key" + key.toUpperCase() : key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    };
    // Có Ctrl thì dùng rawKeyDown (không sinh ký tự), như bàn phím thật.
    await this.cdp.send("Input.dispatchKeyEvent", { type: ctrl ? "rawKeyDown" : "keyDown", ...base });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // Lăn chuột THẬT tại (x, y) của cửa sổ (toạ độ client) qua `Input.dispatchMouseEvent` — chạy được handler `wheel` của trang (zoom bằng
  // Ctrl+lăn, cuộn). `deltaY` > 0 là lăn xuống / thu nhỏ (1 nấc Chromium ≈ 100). Khác với kéo-thả, lăn chuột KHÔNG bị Chromium bỏ qua.
  async wheel(x, y, deltaY, { ctrl = false } = {}) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0 });
  }

  async toast() {
    return this.eval(`(() => { const el = document.getElementById("toast");
      return { text: el ? el.textContent : "", kind: el ? el.className : "" }; })()`);
  }

  async clearToast() {
    await this.eval(`(() => { const el = document.getElementById("toast"); if (el) { el.textContent = ""; el.className = "toast"; } return true; })()`);
  }

  async screenshot(file) {
    const r = await this.cdp.send("Page.captureScreenshot", { format: "png" }, 30000);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  close() {
    this.cdp.close();
  }
}

// ---- hộp thoại (nửa phía bộ khung của test-hooks.js) -------------------------------------------------------
class Dialogs {
  constructor(dir) {
    this.dir = dir;
    this.epoch = 0;
    this._write({ epoch: 0 });
  }

  _write(obj) {
    // Ghi nguyên tử: móc đọc file này MỖI lần có hộp thoại, không bao giờ được thấy nửa chừng.
    const tmp = path.join(this.dir, "answers.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, path.join(this.dir, "answers.json"));
  }

  // Đặt kịch bản MỚI (epoch mới ⇒ hàng đợi của móc bắt đầu lại từ đầu). `map`: { showMessageBox: [...], ... }.
  answer(map = {}) {
    this.epoch++;
    this._write({ epoch: this.epoch, ...map });
    return this.epoch;
  }

  // Mọi hộp đã hiện từ trước tới giờ.
  all() {
    const p = path.join(this.dir, "calls.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  // Các hộp của kịch bản (epoch) hiện hành.
  calls() {
    return this.all().filter((c) => c.epoch === this.epoch);
  }

  // Hộp hiện ra mà KHÔNG có đáp án đặt trước — kịch bản thiếu hoặc app hỏi điều không ai ngờ. Test nên khẳng định rỗng.
  unexpected() {
    return this.all().filter((c) => c.unexpected);
  }
}

// ---- app -----------------------------------------------------------------------------------------------------
const live = new Set();
process.on("exit", () => {
  for (const app of live) app._killSync();
});

class AppDriver {
  constructor(o) {
    Object.assign(this, o);
    this._pages = new Map();
  }

  // Danh sách target renderer đang có. `kind`: "doc" (index.html, mỗi tab một cái) hoặc "shell" (thanh tab).
  async targets(kind = "doc") {
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const re = kind === "doc" ? /index\.html/ : /shell\.html/;
    return list.filter((t) => t.type === "page" && re.test(t.url || ""));
  }

  // Trang của tab thứ `i` (mặc định tab đầu). Có bộ nhớ đệm theo id target.
  async page(i = 0) {
    const t = (await this.targets("doc"))[i];
    if (!t) throw new Error(`không có tab #${i}`);
    if (this._pages.has(t.id) && !this._pages.get(t.id).cdp.closed) return this._pages.get(t.id);
    const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable", {});
    await cdp.send("Page.enable", {}).catch(() => {});
    await cdp.send("Page.bringToFront", {}).catch(() => {});
    const p = new Page(cdp, t);
    this._pages.set(t.id, p);
    return p;
  }

  // ---- tab (BI-141, đợt 2) ----------------------------------------------------------------------------------
  // THANH TAB là một renderer riêng (shell.html) — nơi người dùng bấm × / chọn tab. Trả Page của nó (có bộ nhớ đệm).
  async shell() {
    const t = (await this.targets("shell"))[0];
    if (!t) throw new Error("không có thanh tab (shell.html)");
    if (this._pages.has(t.id) && !this._pages.get(t.id).cdp.closed) return this._pages.get(t.id);
    const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable", {});
    const p = new Page(cdp, t);
    this._pages.set(t.id, p);
    return p;
  }

  // Các tab đang hiện trên thanh tab, đọc từ DOM của thanh: [{ id, title, active, dirty }] theo thứ tự trái → phải.
  async tabsList() {
    const sh = await this.shell();
    return sh.eval(`[...document.querySelectorAll("#tabs .tab")].map((el) => ({
      id: Number(el.dataset.id), title: el.title, active: el.classList.contains("active"), dirty: el.classList.contains("dirty") }))`);
  }

  // Chọn tab bằng ĐÚNG handler của thanh tab (mousedown nút trái trên phần tử tab).
  async activateTab(id) {
    const sh = await this.shell();
    const r = await sh.eval(`(() => { const el = document.querySelector('#tabs .tab[data-id="${Number(id)}"]');
      if (!el) return "no-tab"; el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true })); return "ok"; })()`);
    if (r !== "ok") throw new Error(`activateTab ${id}: ${r}`);
  }

  // Bấm × của tab (handler thật: shellBridge.close → tabs:close → guard đóng của CHÍNH tab đó). Trả ngay.
  async closeTabUI(id) {
    const sh = await this.shell();
    const r = await sh.eval(`(() => { const el = document.querySelector('#tabs .tab[data-id="${Number(id)}"] .close');
      if (!el) return "no-tab"; el.click(); return "ok"; })()`);
    if (r !== "ok") throw new Error(`closeTabUI ${id}: ${r}`);
  }

  // Page của tab có tài liệu tên `name` (theo `state.name`; đợi tới `timeout` vì tab mới mở nạp không đồng bộ, ném nếu không thấy). CHỈ tab đang ĐƯỢC CHỌN mới vẽ được (tab ẩn: pdf.js treo —
  // xem bẫy ở đầu file): muốn mở file vào tab nào thì `activateTab` nó trước.
  async pageByName(name, { timeout = 30000 } = {}) {
    const t0 = Date.now();
    do {
      for (const t of await this.targets("doc")) {
        try {
          let p;
          if (this._pages.has(t.id) && !this._pages.get(t.id).cdp.closed) p = this._pages.get(t.id);
          else {
            const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
            await cdp.send("Runtime.enable", {});
            p = new Page(cdp, t);
            this._pages.set(t.id, p);
          }
          if ((await p.eval(`typeof state !== "undefined" ? state.name : null`)) === name) return p;
        } catch (_) {
          /* target đang nạp / vừa chết — thử lại */
        }
      }
      await sleep(300);
    } while (Date.now() - t0 < timeout);
    throw new Error(`không thấy tab có tài liệu "${name}" sau ${timeout} ms`);
  }

  // Đợi renderer đầu tiên hiện ra và sidecar sẵn sàng. Ném nếu cửa sổ bị coi là ẩn (xem bẫy ở đầu file).
  async ready({ timeout = 90000, sidecar = true } = {}) {
    const t0 = Date.now();
    let page = null;
    while (!page && Date.now() - t0 < timeout) {
      try {
        page = await this.page(0);
      } catch (_) {
        await sleep(500);
      }
    }
    if (!page) throw new Error("không thấy renderer sau " + timeout + " ms\n" + this.log().slice(-800));
    // Có lần (1/5 lượt chạy vault) renderer vừa nối CDP chưa chạy xong `app.js` ⇒ `state is not defined` ở lệnh đầu tiên. Đợi nó.
    await page.waitFor(`typeof state !== "undefined" && !!state`, { timeout: Math.max(5000, timeout - (Date.now() - t0)), what: "app.js nạp xong (state)" });
    const vis = await page.visible();
    if (vis !== "visible") {
      throw new Error(
        `cửa sổ bị coi là "${vis}": pdf.js sẽ ngừng vẽ và loadBytes treo vô hạn. Đưa cửa sổ lên trước / tắt che khuất rồi chạy lại.`,
      );
    }
    if (sidecar) {
      await page.waitFor(`typeof sidecar !== "undefined" && sidecar.state === "ready" && !!sidecar.base`, {
        timeout: timeout - (Date.now() - t0),
        interval: 500,
        what: "sidecar sẵn sàng",
      });
    }
    return page;
  }

  // Mở một PDF vào tab hiện tại bằng chính `loadBytes` của app (như mở từ đĩa nếu có `srcPath`). Trả về thông tin cơ bản.
  // `loadBytes` chờ viewer vẽ xong: PDF thường mất < 1 s, nhưng file bệnh lý có thể mất hàng phút (`bomb_giant.pdf` ~147 s,
  // đo được) — tăng `timeout` nếu cố ý mở file như vậy, hoặc dùng `setBytesUnrendered` (xem bên dưới).
  async openPdf(source, name = "e2e.pdf", { srcPath = null, page = null, timeout = 120000 } = {}) {
    const bytes = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    const p = page || (await this.page(0));
    return p.eval(
      `(async () => {
         const bin = atob(${JSON.stringify(bytes.toString("base64"))});
         const u8 = new Uint8Array(bin.length);
         for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
         state.dirty = false; // kịch bản trước có thể để dở; đừng để hộp 'bỏ thay đổi?' chặn loadBytes
         const ok = await loadBytes(u8, ${JSON.stringify(name)}, ${JSON.stringify(srcPath)});
         if (ok === false) throw new Error("loadBytes bị từ chối");
         return { name: state.name, path: state.path, pages: state.numPages, dirty: state.dirty };
       })()`,
      { timeout },
    );
  }

  // THAY `state.bytes` mà KHÔNG vẽ lại viewer. Dành cho file BỆNH LÝ mà viewer mất rất lâu để vẽ: đo được
  // `bomb_giant.pdf` (123 KB, 1 trang) mất ~147 s trong pdf.js (loadBytes trả ok:true sau 147.257 ms) — đó là lý do mọi lần
  // tôi bỏ cuộc sớm hơn (25 s, 120 s) đều trông như "treo". Dùng khi cái cần kiểm là thao tác Ở SIDECAR (nén/tách/đánh số
  // đọc `state.bytes`), KHÔNG dùng để kiểm hành vi của viewer. Gọi SAU `openPdf` một tài liệu nhỏ lành để giao diện nhất
  // quán (đã có tài liệu, đã vẽ). Trả { bytes: số byte mới }.
  async setBytesUnrendered(source, { page = null } = {}) {
    const bytes = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    const p = page || (await this.page(0));
    return p.eval(
      `(() => {
         const bin = atob(${JSON.stringify(bytes.toString("base64"))});
         const u8 = new Uint8Array(bin.length);
         for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
         state.bytes = u8;
         return { bytes: u8.length };
       })()`,
    );
  }

  // Tiến trình tiến trình con của sidecar mang cờ `flag` (vd "--split-worker"). Trả [{pid, ppid}].
  workers(flag) {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='sidecar.exe'\" | " +
            `Where-Object { $_.CommandLine -like '*${flag}*' } | ` +
            'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [pid, ppid] = l.split(" ").map(Number);
          return { pid, ppid };
        });
    } catch (e) {
      throw new Error("không liệt kê được tiến trình: " + e.message);
    }
  }

  log() {
    return this._log;
  }

  _killSync() {
    if (this._dead) return;
    this._dead = true;
    try {
      execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch (_) {}
  }

  // Đóng hẳn (giết cây tiến trình) và dọn thư mục tạm. `keepUserData: true` GIỮ thư mục dữ liệu người dùng — để khởi chạy
  // lại app trên cùng dữ liệu (khôi phục sau sập, khôi phục phiên) bằng `launch({ userDataDir })`; khi đó người gọi tự xoá nó.
  async close({ keepUserData = false } = {}) {
    for (const p of this._pages.values()) p.close();
    this._pages.clear();
    this._killSync();
    live.delete(this);
    await sleep(1200); // cho Windows nhả tay nắm file trước khi xoá thư mục
    const dirs = keepUserData || this._userDataGiven ? [this.hooksDir] : [this.userDataDir, this.hooksDir];
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  // Mô phỏng SẬP: giết cứng cả cây tiến trình, KHÔNG để app kịp dọn gì (autosave, khe phục hồi, phiên). Giữ thư mục dữ liệu.
  async crash() {
    for (const p of this._pages.values()) p.close();
    this._pages.clear();
    this._killSync();
    await this.waitExit(15000);
  }

  // Đường NÚT X của cửa sổ: `taskkill /PID` KHÔNG kèm /F gửi WM_CLOSE tới cửa sổ của tiến trình — đúng thứ Windows gửi khi bấm ✕
  // hay Alt+F4 — nên chạy `TabbedWindow._onClose` → guard đóng. KHÔNG đi qua menu Thoát/Ctrl+Q (đó là `role:"quit"` của menu
  // native, CDP không bấm được; xem BI-141). Trả về ngay; dùng `waitExit` để biết app có thoát không.
  requestClose() {
    try {
      execFileSync("taskkill", ["/PID", String(this.child.pid)], { stdio: "ignore" });
      return true;
    } catch (_) {
      return false; // tiến trình đã thoát
    }
  }

  // Đợi tiến trình Electron chính thoát. Trả `true` nếu đã thoát, `false` nếu hết giờ mà còn sống.
  async waitExit(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this._hasExited) return true;
      await sleep(100);
    }
    return !!this._hasExited;
  }

  alive() {
    return !this._hasExited;
  }
}

// Dựng app. `env`: biến môi trường thêm; `args`: đối số thêm cho Electron; `hooks: false` để KHÔNG bật móc hộp thoại.
// `userDataDir`: dùng lại một thư mục dữ liệu có sẵn (khởi chạy lại sau sập); khi đó `close()` KHÔNG xoá nó.
async function launch({ env = {}, args = [], hooks = true, userDataDir: given = null } = {}) {
  const port = await freePort();
  const userDataDir = given || fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-ud-"));
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-hk-"));
  const dialogs = new Dialogs(hooksDir);

  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // đặt biến này là Electron chạy như node thuần — không có cửa sổ nào
  if (hooks) childEnv.NABU_TEST_HOOKS = hooksDir;
  else delete childEnv.NABU_TEST_HOOKS;

  const child = spawn(
    electronBin(),
    [
      ".",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      // Bẫy "cửa sổ bị coi là ẩn" (xem đầu file).
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      ...args,
    ],
    { cwd: DESKTOP, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const app = new AppDriver({ port, userDataDir, hooksDir, child, dialogs, _log: "", _dead: false, _userDataGiven: !!given, _hasExited: false });
  child.stdout.on("data", (d) => (app._log += d));
  child.stderr.on("data", (d) => (app._log += d));
  child.on("exit", (code) => {
    app._exited = code;
    app._hasExited = true;
  });
  live.add(app);
  return app;
}

module.exports = { launch, Cdp, Page, Dialogs, freePort, DESKTOP };
