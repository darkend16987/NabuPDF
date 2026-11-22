// Probe MỘT LẦN (BI-140): bấm nút Hủy thật, trong app thật, trên một lần ĐÁNH SỐ TRANG không bao giờ xong
// — rồi xem tiến trình đánh số có chết thật không VÀ tài liệu đang mở có còn nguyên không.
// Chị em của probe-split-cancel.js (BI-139) và probe-compress-cancel.js (BI-126).
//
//     cd desktop ; node scripts/probe-pagenum-cancel.js
//
// KHÔNG thuộc `npm test`: dựng cả app Electron, cần corpus pdf.js đặt ngoài repo.
//
// FILE TEST. `bomb_giant.pdf` (123 KB, 1 trang) treo ngay trong `insert_text` của trang đầu (đo > 60 s, BI-140).
// Nếu probe này xong trong vài giây thì chỉ có một cách giải thích: nút Hủy đã cắt ngang.
//
// BẰNG CHỨNG CỨNG. Đếm tiến trình có `--pagenum-worker` trước/sau khi bấm (≥1 rồi 0), hỏi /health (ta giết tiến trình
// con, không phải sidecar), và — RIÊNG Ở THAO TÁC NÀY vì nó sửa tài liệu đang mở — so `state.bytes` trước/sau: hủy
// không được đổi tài liệu, không được đẩy bước hoàn tác. Bẫy đã vấp ở probe nén: lọc tiến trình theo TÊN trước, spawn
// thẳng electron.exe, dọn bằng `taskkill /T /F`.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DESKTOP = "D:\\GitHub\\ContractOCR\\desktop";
const CORPUS = "D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs";
const PORT = 9338;
const FILE = "bomb_giant.pdf";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function electronBin() {
  const p = path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(p)) return p;
  return require(path.join(DESKTOP, "node_modules", "electron"));
}

// Đếm tiến trình nén đang sống.
//
// Lọc theo TÊN trước, rồi mới theo dòng lệnh — và cái `-Filter` ấy không phải để cho
// nhanh. Đã vấp: lọc mỗi `CommandLine -like '*--pagenum-worker*'` thì câu lệnh
// **tự đếm chính nó** (dòng lệnh của powershell.exe có chứa đúng chuỗi đang tìm), nên
// số đếm không bao giờ về 0 và probe báo sai là "tiến trình không chết". `-Filter`
// theo tên loại powershell.exe/bash.exe ra ngoài trước khi so chuỗi.
//
// Hai tên vì hai chế độ: ở dev worker là python.exe của .venv, ở bản đóng gói là
// sidecar.exe (xem `_compress_worker_cmd`) — cờ thì giống nhau.
//
// VÌ SAO IN CẢ PID + PID CHA chứ không chỉ đếm. Đo được: ở **dev** worker là một CẶP
// tiến trình (python.exe của venv là một stub, nó sinh python thật làm con), ở **bản
// đóng gói** chỉ có **một**. `proc.kill()` trên Windows không giết con cháu theo
// nghĩa thông thường — nhưng đo cả hai chế độ (`kill` rồi đếm lại sau 2 s) đều ra
// **0 mồ côi**: stub của venv dựng con trong một Job Object kill-on-close, còn bản
// đóng gói thì vốn chỉ có một tiến trình. Nên con số "còn sống" mới là thứ phải về 0;
// con số "đang chạy" thì 1 hay 2 tuỳ chế độ, đừng ghim cứng.
function lietKeWorker() {
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process " +
        "-Filter \\\"Name='python.exe' OR Name='sidecar.exe'\\\" | " +
        "Where-Object { $_.CommandLine -like '*--pagenum-worker*' } | " +
        "ForEach-Object { \\\"$($_.ProcessId) $($_.ParentProcessId)\\\" }\"",
      { encoding: "utf8", timeout: 30000 },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (_) {
    return ["<khong doc duoc>"];
  }
}

function demWorker() {
  return lietKeWorker().length;
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

(async () => {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok) {
      console.log(`Cong ${PORT} dang co nguoi giu - don Electron cu truoc da.`);
      process.exit(2);
    }
  } catch (_) {}

  if (!fs.existsSync(path.join(CORPUS, FILE))) {
    console.log(`Khong thay ${FILE} - can corpus pdf.js, xem docs/CORPUS-SWEEP.md`);
    process.exit(2);
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-pncancel-"));
  // BẪY ĐÃ VẤP (BI-140): cửa sổ của probe bị hệ điều hành coi là BỊ CHE (`visibilityState === "hidden"`), và khi đó
  // pdf.js ngừng vẽ (rAF dừng) ⇒ `loadBytes` không bao giờ xong, lớp phủ kẹt ở "Đang tải tài liệu…", probe treo vô hạn
  // mà không báo lỗi gì (xem memory cad-render-perf-facts). Ba cờ dưới + `Page.bringToFront` ở bên dưới chặn điều đó;
  // `visibilityState` còn được in ra để lần sau nhìn thấy ngay thay vì đoán.
  const child = spawn(electronBin(), [".", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"], {
    cwd: DESKTOP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  let cdp = null;
  const failures = [];
  try {
    const rt = await waitTarget(PORT, (t) => t.type === "page" && /index\.html/.test(t.url || ""), 60);
    if (!rt) throw new Error("khong thay renderer\n" + log.slice(-600));
    cdp = await connect(rt.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable", {});
    await cdp.send("Page.bringToFront", {}).catch(() => {});
    console.log("visibilityState: " + (await evalIn(cdp, `document.visibilityState`)));

    let st = null;
    for (let i = 0; i < 90; i++) {
      st = await evalIn(cdp, `(typeof sidecar === "undefined" ? {s:"chua-co"} : {s: sidecar.state, base: !!sidecar.base})`);
      if (st && st.s === "ready" && st.base) break;
      await sleep(1000);
    }
    if (!st || st.s !== "ready") throw new Error("engine khong san sang: " + JSON.stringify(st));
    console.log("sidecar: " + JSON.stringify(st));
    console.log(`worker song truoc khi bat dau: ${demWorker()}\n`);

    // Mở file rồi CHẠY runPageNumbers mà KHÔNG await — ta cần nó còn đang chạy để bấm.
    const b64 = fs.readFileSync(path.join(CORPUS, FILE)).toString("base64");
    await evalIn(
      cdp,
      `(async () => {
         const bin = atob(${JSON.stringify(b64)});
         const u8 = new Uint8Array(bin.length);
         for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
         await loadBytes(u8, ${JSON.stringify(FILE)});
         const el = document.getElementById("toast");
         el.textContent = "";
         el.className = "toast";
         document.getElementById("pgnum-fmt").value = "n";
         document.getElementById("pgnum-pos").value = "bottom-center";
         document.getElementById("pgnum-start").value = "1";
         document.getElementById("pgnum-skip").value = "0";
         // Tài liệu đang mở TRƯỚC khi đánh số: hủy xong nó phải còn nguyên (cùng đối tượng bytes).
         globalThis.__goc = state.bytes;
         globalThis.__xong = null;
         globalThis.__t0 = Date.now();
         runPageNumbers().then(() => { globalThis.__xong = Date.now() - globalThis.__t0; });
         return true;
       })()`,
    );
    console.log(`da bam Danh so tren ${FILE} (file nay khong bao gio danh so xong)`);

    // Chờ lớp phủ + nút Hủy hiện ra thật.
    let ui = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      ui = await evalIn(
        cdp,
        `(() => {
           const ov = document.getElementById("overlay");
           const b = document.getElementById("overlay-cancel");
           return { phu: !ov.hidden, nut: !b.hidden, khoa: b.disabled,
                    chu: b.textContent.trim(), msg: document.getElementById("overlay-msg").textContent };
         })()`,
      );
      if (ui.phu && ui.nut) break;
    }
    console.log(`lop phu: ${JSON.stringify(ui)}`);
    if (!ui.phu) failures.push("lop phu khong hien");
    if (!ui.nut) failures.push("NUT HUY KHONG HIEN - khong co gi de bam");
    if (ui.khoa) failures.push("nut Huy hien ra o trang thai khoa san");

    // Để nó đánh số một lúc cho chắc là worker đã ra đời, rồi đếm.
    await sleep(3000);
    const ds = lietKeWorker();
    console.log(`worker song ngay truoc khi bam Huy: ${ds.length}  (pid ppid: ${ds.join(" | ")})`);
    if (ds.length < 1) failures.push("khong co worker nao dang chay - khong co gi de huy");

    // BẤM. Bằng .click() thật trên phần tử thật, không gọi tắt hàm hủy.
    const t0 = Date.now();
    await evalIn(cdp, `(document.getElementById("overlay-cancel").click(), true)`);
    console.log("da bam Huy\n");

    // Chờ runCompress kết thúc.
    let xong = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      xong = await evalIn(cdp, `globalThis.__xong`);
      if (xong !== null) break;
    }
    const dt = (Date.now() - t0) / 1000;
    const sau = await evalIn(
      cdp,
      `(() => {
         const ov = document.getElementById("overlay");
         const el = document.getElementById("toast");
         return { phu: !ov.hidden, toast: el.textContent, kind: el.className };
       })()`,
    );
    const conSong = demWorker();

    console.log(`runPageNumbers ket thuc: ${xong === null ? "KHONG (van treo)" : xong + " ms"}`);
    console.log(`tu luc bam toi luc xong: ${dt.toFixed(2)} s`);
    console.log(`toast                 : ${JSON.stringify(sau.toast)}`);
    console.log(`class                 : ${sau.kind}`);
    console.log(`lop phu con hien       : ${sau.phu}`);
    console.log(`worker con song        : ${conSong}`);
    const nguyen = await evalIn(cdp, `state.bytes === globalThis.__goc`);
    console.log(`tai lieu dang mo con nguyen (cung doi tuong bytes): ${nguyen}`);
    if (!nguyen) failures.push("HUY XONG MA TAI LIEU DANG MO BI DOI (state.bytes khac truoc)");

    if (xong === null) failures.push("runPageNumbers khong bao gio ket thuc - Huy khong an");
    if (dt > 15) failures.push(`bam Huy xong doi ${dt.toFixed(1)}s moi dung`);
    if (!/^Đã hủy đánh số\.$/.test((sau.toast || "").trim())) {
      failures.push(`toast sai: ${JSON.stringify(sau.toast)}`);
    }
    if (/\bbad\b/.test(sau.kind)) failures.push("huy bi bao nhu mot loi (toast do)");
    if (sau.phu) failures.push("lop phu khong tat sau khi huy");
    if (conSong !== 0) failures.push(`con ${conSong} worker song sau khi huy - tien trinh khong chet`);

    // Sidecar phải SỐNG SÓT qua chuyện này: giết tiến trình con, không phải giết nó.
    const health = await evalIn(cdp, `(async () => (await fetch(sidecar.base + "/health")).status)()`);
    console.log(`sidecar /health sau khi huy: ${health}`);
    if (health !== 200) failures.push("sidecar khong con song sau khi huy");
  } catch (e) {
    failures.push("probe loi: " + e.message);
  } finally {
    try { cdp && cdp.close(); } catch (_) {}
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
    await sleep(1500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  }

  console.log("");
  if (failures.length) {
    console.log("CO VAN DE:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Bam Huy that su dung duoc mot lan danh so khong bao gio xong, va sidecar van song.");
})();
