// Probe MỘT LẦN (BI-122): trong CHÍNH renderer của app thật, header X-Images-Failed
// có lọt qua CORS tới `res.headers.get(...)` không?
//
//     cd desktop ; node scripts/probe-images-failed.js
//
// KHÔNG thuộc `npm test`: nó dựng cả app Electron và cần corpus pdf.js đặt ngoài
// repo. Giữ lại trong repo vì nó là BẰNG CHỨNG của một mục trong BI-122, và vì hai
// cái bẫy ghi ở cuối khối này tốn khá nhiều thời gian để tìm ra.
//
// Vì sao cần nó: đường HTTP đã kiểm trực tiếp trên sidecar.exe (có header), nhưng
// đó là một client Python. Renderer chạy từ file:// nên mọi
// lệnh gọi sidecar là CROSS-ORIGIN — header chỉ hiện ra nếu nó nằm trong
// `expose_headers` của CORS middleware. Thiếu thì `.get()` trả về null MÀ KHÔNG BÁO
// LỖI Ở ĐÂU CẢ (chính câu cảnh báo có sẵn trên expose_headers trong api.py).
//
// Không bấm nút Nén thật, vì nút đó kết thúc bằng hộp thoại Lưu NATIVE mà CDP không
// bấm được. Ta gọi thẳng `sidecarFetch` — đúng hàm mà runCompress dùng, đúng origin,
// đúng token — rồi đọc header y như runCompress đọc.
//
// HAI CÁI ĐÃ VẤP, ghi lại để khỏi vấp lại:
//  1. `sidecar` là BIẾN TRẦN ở scope toàn cục của renderer, KHÔNG phải thuộc tính
//     của window (classic script, const/let) — xem CLAUDE.md "Kiến trúc". Hỏi
//     `window.sidecar` luôn ra undefined.
//  2. `spawn(..., {shell: true})` rồi `child.kill()` chỉ giết cmd.exe, Electron sống
//     tiếp và giữ cổng debug — lần chạy sau treo vô hạn vì nối vào một target đã
//     chết. Ở đây spawn thẳng electron.exe và giết cả cây bằng taskkill /T.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DESKTOP = "D:\\GitHub\\ContractOCR\\desktop";
const CORPUS = "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
const PORT = 9333;

const TRIGGER = "jpx_smaskindata.pdf"; // rewrite_images ném lỗi => worker thoát 4
const CLEAN = "tracemonkey.pdf"; // tài liệu lành => không được có header

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  // electron.cmd là shim của npm; ta cần CHÍNH exe để kill được cả cây.
  const p = path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(p)) return p;
  const viaPkg = require(path.join(DESKTOP, "node_modules", "electron"));
  return viaPkg;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const fail = (e) => reject(e instanceof Error ? e : new Error("ws loi"));
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const n = ++id;
          return new Promise((res, rej) => {
            pending.set(n, { res, rej });
            ws.send(JSON.stringify({ id: n, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("error", fail);
    ws.addEventListener("close", () => fail(new Error("ws dong som")));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  });
}

async function evalIn(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

async function portBusy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (_) {
    return false;
  }
}

(async () => {
  if (await portBusy()) {
    console.log(`Cong ${PORT} dang co nguoi giu — don truoc da (xem ghi chu #2 dau file).`);
    process.exit(2);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-probe-"));
  const child = spawn(electronBin(), [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: DESKTOP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  let cdp = null;
  const failures = [];
  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
        if (target) break;
      } catch (_) {}
    }
    if (!target) throw new Error("khong thay renderer sau 60 s\n" + log.slice(-800));
    console.log("renderer: " + target.url);

    cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable", {});

    let state = null;
    for (let i = 0; i < 90; i++) {
      state = await evalIn(
        cdp,
        `(typeof sidecar === "undefined" ? {s: "chua-co"} : {s: sidecar.state, base: !!sidecar.base})`,
      );
      if (state && state.s === "ready" && state.base) break;
      await sleep(1000);
    }
    console.log("sidecar: " + JSON.stringify(state));
    if (!state || state.s !== "ready") throw new Error("engine khong san sang: " + JSON.stringify(state));

    for (const [name, mongDoi] of [
      [TRIGGER, true],
      [CLEAN, false],
    ]) {
      const b64 = fs.readFileSync(path.join(CORPUS, name)).toString("base64");
      const expr = `(async () => {
        const bin = atob(${JSON.stringify(b64)});
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const res = await sidecarFetch("/compress-bin?preset=ebook", {
          method: "POST",
          headers: { "Content-Type": "application/pdf" },
          body: new Blob([u8], { type: "application/pdf" }),
        });
        const buf = await res.arrayBuffer();
        return {
          ok: res.ok,
          imagesFailed: res.headers.get("X-Images-Failed"),
          filename: !!res.headers.get("X-Filename"),
          hienRa: [...res.headers.keys()],
          bytes: buf.byteLength,
        };
      })()`;
      const r = await evalIn(cdp, expr);
      const got = r.imagesFailed === "1";
      const ok = r.ok && got === mongDoi;
      if (!ok) {
        failures.push(
          `${name}: imagesFailed=${JSON.stringify(r.imagesFailed)} (mong doi ${mongDoi}); ` +
            `header renderer doc duoc: ${JSON.stringify(r.hienRa)}`,
        );
      }
      console.log(
        `  ${name.padEnd(22)} X-Images-Failed=${String(r.imagesFailed).padEnd(6)} ` +
          `X-Filename=${r.filename ? "co" : "KHONG"}  ${r.bytes} B  ${ok ? "OK" : "<-- SAI"}`,
      );
      console.log(`      header renderer DOC DUOC: ${JSON.stringify(r.hienRa)}`);
    }
  } catch (e) {
    failures.push("probe loi: " + e.message);
  } finally {
    try {
      cdp && cdp.close();
    } catch (_) {}
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch (_) {}
    await sleep(1500);
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("");
  if (failures.length) {
    console.log("CO VAN DE:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Header di lot qua CORS toi renderer, dung ca hai chieu.");
})();
