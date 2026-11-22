// Probe MỘT LẦN (BI-122): chạy ĐÚNG `runCompress()` trên file thật trong app thật,
// rồi đọc câu toast hiện trên màn hình và file thật sự ghi ra đĩa.
//
//     cd desktop ; node scripts/probe-images-failed-toast.js
//
// KHÔNG thuộc `npm test`: dựng cả app Electron, cần corpus pdf.js đặt ngoài repo.
//
// Khác gì `probe-images-failed.js`: file kia dừng ở `res.headers.get(...)` — nó trả
// lời "header có tới renderer không". File này đi hết đường: gọi chính `runCompress`,
// qua cả nhánh `if (r.saved)`, và đọc `#toast`. Thứ duy nhất của BI-122 mà không
// lưới nào chạm tới được là CHUỖI CHỮ cuối cùng người dùng đọc.
//
// VÌ SAO PHẢI DEBUG CẢ TIẾN TRÌNH MAIN. `runCompress` kết thúc bằng hộp thoại Lưu
// NATIVE mà CDP không bấm được. Thay `window.desktop.savePdf` trong renderer thì
// KHÔNG được — contextBridge khoá object đã lộ ra, phép gán im lặng không ăn (đã thử:
// `window.desktop.savePdf = …` rồi so lại vẫn ra hàm cũ). Nên ta nối vào tiến trình
// MAIN bằng `--inspect` và thay đúng một hàm `dialog.showSaveDialog` bằng bản trả về
// một đường dẫn trong thư mục tạm. Mọi mã khác — IPC, `fs.writeFile`, renderer — là
// mã ship thật, và file ra đĩa được đọc lại để kiểm.
//
// Hai cái đã vấp (xem thêm probe-images-failed.js): `sidecar` là biến trần chứ không
// phải `window.sidecar`; và spawn bằng shell thì `kill()` không giết nổi Electron,
// nó giữ cổng debug làm lần chạy sau treo vô hạn.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DESKTOP = "D:\\GitHub\\ContractOCR\\desktop";
const CORPUS = "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
const PORT = 9334; // renderer
const INSPECT = 9335; // tiến trình main

// clippath.pdf (459 B) làm rewrite_images ném "Bad PatternType" => phải có câu về ảnh.
// tracemonkey.pdf (1 MB) lành => phải KHÔNG có câu đó. Hai chiều, để câu này không
// phải thứ lúc nào cũng hiện.
const CASES = [
  { file: "clippath.pdf", mongDoiCauAnh: true },
  { file: "tracemonkey.pdf", mongDoiCauAnh: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const p = path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(p)) return p;
  return require(path.join(DESKTOP, "node_modules", "electron"));
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
    includeCommandLineAPI: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

async function waitTarget(port, pick, giay) {
  for (let i = 0; i < giay; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find(pick);
      if (t) return t;
    } catch (_) {}
  }
  return null;
}

async function portBusy(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch (_) {
    return false;
  }
}

(async () => {
  for (const p of [PORT, INSPECT]) {
    if (await portBusy(p)) {
      console.log(`Cong ${p} dang co nguoi giu - don Electron cu truoc da.`);
      process.exit(2);
    }
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-toast-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-toast-out-"));
  const child = spawn(
    electronBin(),
    [`--inspect=${INSPECT}`, ".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { cwd: DESKTOP, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  let cdpR = null;
  let cdpM = null;
  const failures = [];
  try {
    // --- tien trinh MAIN: thay dialog.showSaveDialog ---
    const mt = await waitTarget(INSPECT, (t) => (t.type || "").includes("node") || !!t.webSocketDebuggerUrl, 60);
    if (!mt) throw new Error("khong noi duoc vao tien trinh main qua --inspect\n" + log.slice(-600));
    cdpM = await connect(mt.webSocketDebuggerUrl);
    await cdpM.send("Runtime.enable", {});
    const outPath = path.join(outDir, "probe-out.pdf").replace(/\\/g, "/");
    const stubbed = await evalIn(
      cdpM,
      `(() => {
         const { dialog } = require("electron");
         const real = dialog.showSaveDialog;
         globalThis.__probeDialogCalls = 0;
         dialog.showSaveDialog = async () => {
           globalThis.__probeDialogCalls++;
           return { canceled: false, filePath: ${JSON.stringify(outPath)} };
         };
         return dialog.showSaveDialog !== real;
       })()`,
    );
    if (stubbed !== true) throw new Error("khong thay duoc dialog.showSaveDialog");
    console.log("main   : da thay dialog.showSaveDialog -> " + outPath);

    // --- renderer ---
    const rt = await waitTarget(PORT, (t) => t.type === "page" && /index\.html/.test(t.url || ""), 60);
    if (!rt) throw new Error("khong thay renderer\n" + log.slice(-600));
    cdpR = await connect(rt.webSocketDebuggerUrl);
    await cdpR.send("Runtime.enable", {});

    let st = null;
    for (let i = 0; i < 90; i++) {
      st = await evalIn(cdpR, `(typeof sidecar === "undefined" ? {s:"chua-co"} : {s: sidecar.state, base: !!sidecar.base})`);
      if (st && st.s === "ready" && st.base) break;
      await sleep(1000);
    }
    if (!st || st.s !== "ready") throw new Error("engine khong san sang: " + JSON.stringify(st));
    console.log("sidecar: " + JSON.stringify(st) + "\n");

    for (const { file, mongDoiCauAnh } of CASES) {
      try { fs.rmSync(outPath, { force: true }); } catch (_) {}
      const b64 = fs.readFileSync(path.join(CORPUS, file)).toString("base64");
      const r = await evalIn(
        cdpR,
        `(async () => {
           const bin = atob(${JSON.stringify(b64)});
           const u8 = new Uint8Array(bin.length);
           for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
           await loadBytes(u8, ${JSON.stringify(file)});
           const el = document.getElementById("toast");
           el.textContent = "";
           el.className = "toast";
           await runCompress();
           return { toast: el.textContent, kind: el.className };
         })()`,
      );
      const raDia = fs.existsSync(outPath) ? fs.statSync(outPath).size : null;
      const dauFile = raDia ? fs.readFileSync(outPath).subarray(0, 4).toString("latin1") : "";
      const coCauAnh = /nh trong file n/i.test(r.toast || "");
      const mauDung = mongDoiCauAnh ? /\bwarn\b/.test(r.kind) : /\bgood\b/.test(r.kind);
      const ok = raDia > 0 && dauFile === "%PDF" && coCauAnh === mongDoiCauAnh && mauDung;
      if (!ok) failures.push(`${file}: toast=${JSON.stringify(r.toast)} kind=${r.kind} raDia=${raDia} dau=${dauFile}`);
      console.log(`  ${file}  ${ok ? "OK" : "<-- SAI"}`);
      console.log(`      toast  : ${JSON.stringify(r.toast)}`);
      console.log(`      class  : ${r.kind}  (mong doi ${mongDoiCauAnh ? "warn" : "good"})`);
      console.log(`      ra dia : ${raDia} B, bat dau bang ${JSON.stringify(dauFile)}`);
    }

    const calls = await evalIn(cdpM, `globalThis.__probeDialogCalls`);
    if (calls !== CASES.length) failures.push(`hop thoai Luu duoc goi ${calls} lan, mong doi ${CASES.length}`);
    console.log(`\n  hop thoai Luu duoc goi ${calls} lan (mong doi ${CASES.length})`);
  } catch (e) {
    failures.push("probe loi: " + e.message);
  } finally {
    try { cdpR && cdpR.close(); } catch (_) {}
    try { cdpM && cdpM.close(); } catch (_) {}
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
    await sleep(1500);
    for (const d of [userData, outDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log("");
  if (failures.length) {
    console.log("CO VAN DE:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Cau toast hien dung ca hai chieu, va file that su ra dia.");
})();
