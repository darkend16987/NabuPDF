// Probe MỘT LẦN (BI-131, chốt 5): "Lưu nối thêm" trong APP ELECTRON THẬT, trên file ký THẬT, với trọng tài OpenSSL.
//
//     cd desktop ; node scripts/probe-signed-save.js
//
// KHÔNG thuộc `npm test`: dựng cả app Electron + sidecar Python (.venv), cần node + openssl + qpdf.
//
// CÁI GÌ ĐƯỢC CHẠY THẬT. Renderer thật (`rotateSelected` → `saveDoc` → preload → IPC) → main thật (`file:write-pdf`,
// cổng BI-127, `planSignedWrite`) → HTTP thật tới sidecar thật (route `/save-incremental-bin`, tiến trình con) → ghi
// ĐĨA thật → OpenSSL kiểm chữ ký trên file vừa ghi.
//
// CÁI GÌ KHÔNG. HỘP THOẠI NATIVE KHÔNG BẤM ĐƯỢC từ CDP (là cửa sổ của hệ điều hành). Ta nối vào MAIN qua inspector
// (`--inspect`) và thay `dialog.showMessageBox` / `showSaveDialog` bằng hàm ghi lại tuỳ chọn hộp (nhãn nút, defaultId,
// cancelId, nội dung) rồi trả một đáp án đặt trước — nên "bấm nút thứ N" được thử THẬT, còn chuyện hộp trông ra sao trên
// màn hình thì KHÔNG. Chưa có Acrobat/Foxit ở đây: "vùng ký còn nguyên và OpenSSL xác nhận" KHÔNG phải "Acrobat cho là hợp lệ".
//
// Dev: sidecar chạy bằng python của .venv (xem desktop/src/sidecar.js) nên đo đúng mã nguồn hiện tại.

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = "D:\\GitHub\\ContractOCR";
const DESKTOP = path.join(ROOT, "desktop");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");
const PORT = 9345; // renderer
const INSPECT = 9346; // main

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
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
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

function verify(file) {
  // 0 = mọi chữ ký hợp lệ; 1 = có chữ ký hỏng; 2 = không có chữ ký nào.
  try {
    const out = execSync(`"${PY}" "${path.join(ROOT, "tools", "verify_pdf_signatures.py")}" "${file}"`, { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "").trim() };
  }
}

(async () => {
  for (const p of [PORT, INSPECT]) {
    try {
      if ((await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1500) })).ok) {
        console.log(`Cong ${p} dang co nguoi giu - don Electron cu truoc da.`);
        process.exit(2);
      }
    } catch (_) {}
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-probe-signed-"));
  const fx = JSON.parse(execSync(`node "${path.join(ROOT, "tools", "signed_fixture.js")}" "${path.join(work, "fx")}"`, { encoding: "utf8" }).trim().split(/\r?\n/).pop());
  const ORIGINAL = fs.readFileSync(fx.signed);
  const DOC = path.join(work, "hop-dong.pdf"); // file người dùng "đang mở": app ghi vào ĐÂY
  const resetDisk = () => fs.writeFileSync(DOC, ORIGINAL);
  resetDisk();
  const base = verify(DOC);
  if (base.code !== 0) {
    console.log("File ky goc KHONG hop le theo OpenSSL - dung:", base.out);
    process.exit(2);
  }
  console.log(`file ky: ${ORIGINAL.length} B, OpenSSL: HOP LE\n`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-signed-ud-"));
  const child = spawn(electronBin(), [".", `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${userData}`], {
    cwd: DESKTOP,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  let cdp = null;
  let mainCdp = null;
  const failures = [];
  const expect = (cond, msg) => {
    console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
    if (!cond) failures.push(msg);
  };

  try {
    const rt = await waitTarget(PORT, (t) => t.type === "page" && /index\.html/.test(t.url || ""), 60);
    if (!rt) throw new Error("khong thay renderer\n" + log.slice(-600));
    cdp = await connect(rt.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable", {});
    const mt = await waitTarget(INSPECT, (t) => /node|electron|main/i.test(t.type + t.title + t.url) || true, 30);
    if (!mt) throw new Error("khong noi duoc inspector cua main\n" + log.slice(-600));
    mainCdp = await connect(mt.webSocketDebuggerUrl);
    await mainCdp.send("Runtime.enable", {});

    // Thay hộp thoại native ở MAIN. Đáp án không đặt trước ⇒ bấm "Huỷ"/đóng (không bao giờ ghi đè nhầm).
    await evalIn(
      mainCdp,
      `(() => {
         const req = (typeof process.mainModule !== "undefined" && process.mainModule) ? process.mainModule.require : null;
         if (!req) throw new Error("khong co process.mainModule.require");
         const { dialog } = req("electron");
         globalThis.__dlg = []; globalThis.__answers = []; globalThis.__saveAs = 0;
         dialog.showMessageBox = async (w, o) => {
           globalThis.__dlg.push({ buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId, message: o.message, detail: o.detail });
           const a = globalThis.__answers.shift();
           return { response: a === undefined ? o.cancelId : a };
         };
         dialog.showSaveDialog = async () => { globalThis.__saveAs++; return { canceled: true }; };
         return true;
       })()`,
    );
    const dlg = () => evalIn(mainCdp, `JSON.parse(JSON.stringify(globalThis.__dlg))`);
    const setAnswers = (a) => evalIn(mainCdp, `(globalThis.__dlg = [], globalThis.__answers = ${JSON.stringify(a)}, globalThis.__saveAs = 0, true)`);

    let st = null;
    for (let i = 0; i < 90; i++) {
      st = await evalIn(cdp, `(typeof sidecar === "undefined" ? {s:"chua-co"} : {s: sidecar.state, base: !!sidecar.base})`);
      if (st && st.s === "ready" && st.base) break;
      await sleep(1000);
    }
    if (!st || st.s !== "ready") throw new Error("engine khong san sang: " + JSON.stringify(st));
    console.log("sidecar: " + JSON.stringify(st) + "\n");

    const b64 = ORIGINAL.toString("base64");
    // Mở file KÈM đường dẫn (state.path) — đúng như mở từ đĩa — rồi xoay trang 1 bằng chính hàm của app.
    const openAndRotate = () =>
      evalIn(
        cdp,
        `(async () => {
           const bin = atob(${JSON.stringify(b64)});
           const u8 = new Uint8Array(bin.length);
           for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
           state.dirty = false; // kịch bản trước có thể để dở; đừng để hộp 'bỏ thay đổi?' chặn loadBytes
           const ok = await loadBytes(u8, "hop-dong.pdf", ${JSON.stringify(DOC)});
           if (ok === false) throw new Error('loadBytes bi tu choi');
           state.selected = new Set([0]);
           await rotateSelected(90);
           const el = document.getElementById("toast"); el.textContent = ""; el.className = "toast";
           return { dirty: state.dirty, contentRemoved: state.contentRemoved, path: state.path, pages: state.numPages };
         })()`,
      );
    const save = () =>
      evalIn(cdp, `(async () => { await saveDoc(); const el = document.getElementById("toast"); return { toast: el.textContent, dirty: state.dirty }; })()`);

    // ---- S1: ghi nối thành công --------------------------------------------------------------------
    console.log("S1  Ctrl+S lên file ký, chọn nút đầu (Lưu nối thêm)");
    resetDisk();
    console.log("    mở + xoay:", JSON.stringify(await openAndRotate()));
    await setAnswers([0]);
    let r = await save();
    let d = await dlg();
    const disk1 = fs.readFileSync(DOC);
    const v1 = verify(DOC);
    expect(d.length === 1, `hộp hiện đúng 1 lần (${d.length})`);
    expect(d[0] && d[0].buttons.length === 4, `hộp có 4 nút: ${JSON.stringify(d[0] && d[0].buttons)}`);
    expect(d[0] && /Lưu nối thêm/.test(d[0].buttons[0]) && d[0].defaultId === 0 && d[0].cancelId === 3, "nút đầu là 'Lưu nối thêm', mặc định = 0, Esc = Huỷ (3)");
    expect(d[0] && /KHÔNG HỢP LỆ/.test(d[0].detail || "") && /xem lại được/.test(d[0].detail || ""), "lời giải thích nói thật về cái giá (sửa trang ⇒ Foxit báo không hợp lệ)");
    expect(disk1.length > ORIGINAL.length && disk1.length - ORIGINAL.length < 4096, `đĩa chỉ PHÌNH THÊM ${disk1.length - ORIGINAL.length} B`);
    expect(disk1.subarray(0, ORIGINAL.length).equals(ORIGINAL), "đĩa bắt đầu bằng ĐÚNG từng byte của file ký gốc");
    expect(v1.code === 0, `OpenSSL: chữ ký còn HỢP LỆ trên file vừa lưu (${v1.out})`);
    expect(/^Đã lưu nối thêm/.test(r.toast), `toast: ${JSON.stringify(r.toast)}`);
    expect(r.dirty === false, "tài liệu hết 'chưa lưu'");

    // ---- S2: Ctrl+S lần nữa, không sửa gì ----------------------------------------------------------
    console.log("\nS2  Ctrl+S lần hai (không sửa gì thêm)");
    await setAnswers([0]);
    r = await save();
    d = await dlg();
    const disk2 = fs.readFileSync(DOC);
    expect(d.length === 1 && d[0].buttons.length === 4, "hộp lại hiện (đĩa là bản đã nối, renderer giữ bản pdf-lib) — đã biết, ghi ở BI-130");
    expect(disk2.subarray(0, disk1.length).equals(disk1), "lần hai giữ nguyên byte của lần một");
    expect(disk2.length - disk1.length <= 2048, `lần hai không phình vô ích (+${disk2.length - disk1.length} B)`);
    expect(verify(DOC).code === 0, "OpenSSL: vẫn hợp lệ");

    // ---- S3: phiên đã xoá nội dung thật ⇒ KHÔNG có nút nối ----------------------------------------
    console.log("\nS3  phiên đã xoá nội dung thật (state.contentRemoved = true) ⇒ không đề nghị nối");
    resetDisk();
    await openAndRotate();
    await evalIn(cdp, `(state.contentRemoved = true, true)`);
    await setAnswers([2]); // 3 nút: Huỷ
    r = await save();
    d = await dlg();
    expect(d.length === 1 && d[0].buttons.length === 3, `hộp chỉ 3 nút: ${JSON.stringify(d[0] && d[0].buttons)}`);
    expect(d[0] && !/nối thêm/i.test(d[0].buttons.join("|")), "không có nút 'Lưu nối thêm'");
    expect(fs.readFileSync(DOC).equals(ORIGINAL), "Huỷ ⇒ đĩa y nguyên từng byte");
    expect(!/^Đã lưu/.test(r.toast), `không có toast 'Đã lưu' (${JSON.stringify(r.toast)})`);

    // ---- S4: huỷ ở hộp 4 nút ----------------------------------------------------------------------
    console.log("\nS4  hộp 4 nút, bấm Huỷ");
    resetDisk();
    await openAndRotate();
    await setAnswers([3]);
    r = await save();
    d = await dlg();
    expect(d.length === 1 && d[0].buttons.length === 4, `hộp 4 nút, và không hiện hộp thứ hai (${d.length}) — Huỷ dừng hẳn`);
    expect(fs.readFileSync(DOC).equals(ORIGINAL), "đĩa y nguyên");
    expect((await evalIn(mainCdp, `globalThis.__saveAs`)) === 0, "không mở hộp Lưu thành");

    // ---- S5: chọn 'bản sao' ⇒ rơi sang hộp Lưu thành ----------------------------------------------
    console.log("\nS5  hộp 4 nút, bấm 'Lưu thành bản sao…' (nút 2)");
    await openAndRotate();
    await setAnswers([1]);
    r = await save();
    d = await dlg();
    expect(d.length === 1 && d[0].buttons.length === 4 && /bản sao/.test(d[0].buttons[1]), "hộp 4 nút, nút 1 là bản sao");
    console.log("    DBG S5 hộp:", JSON.stringify(d.map((x) => x.buttons)), "| toast:", JSON.stringify(r.toast), "| saveAs:", await evalIn(mainCdp, `globalThis.__saveAs`), "| đĩa:", fs.readFileSync(DOC).length, "vs gốc", ORIGINAL.length, "| state.path:", await evalIn(cdp, `state.path`), "| dirty:", await evalIn(cdp, `state.dirty`));
    expect((await evalIn(mainCdp, `globalThis.__saveAs`)) === 1, "mở hộp Lưu thành đúng 1 lần");
    expect(fs.readFileSync(DOC).equals(ORIGINAL), "file gốc không bị đụng");

    // ---- S6: bản nối bị từ chối (file gốc bị hỏng cấu trúc) ⇒ hỏi lại, không tự ghi đè -----------
    console.log("\nS6  sidecar từ chối (file đích không còn là PDF hợp lệ) ⇒ hộp hỏi LẠI 3 nút kèm lý do");
    resetDisk();
    await openAndRotate();
    // Sau khi mở, đặt lên đĩa: file ký + một revision cuối HỎNG (xref trỏ vào hư vô). Nó nằm SAU vùng ký nên chữ ký vẫn
    // nguyên và cổng BI-127 vẫn thấy; còn MuPDF phải sửa cấu trúc khi mở ⇒ lõi ghi nối từ chối. (Bài học: chữ ký phủ tới
    // HẾT file ký nên phá cái đuôi của chính nó là phá luôn chữ ký — lần đầu probe làm vậy và app đúng khi coi đó là file không ký.)
    const damaged = Buffer.concat([ORIGINAL, Buffer.from("\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev 999999 >>\nstartxref\n12\n%%EOF\n")]);
    fs.writeFileSync(DOC, damaged);
    await setAnswers([0, 2]); // nối → (hộp lại, 3 nút) Huỷ
    r = await save();
    d = await dlg();
    console.log("    DBG S6 toast:", JSON.stringify(r.toast), "| đĩa:", fs.readFileSync(DOC).length, "| state.path:", await evalIn(cdp, `state.path`), "| bytes:", await evalIn(cdp, `state.bytes.length`));
    console.log("    số hộp:", d.length, d[1] ? " hộp 2: " + JSON.stringify(d[1].buttons) + " | " + (d[1].detail || "").split("\n")[0] : "");
    expect(d.length === 2, `hộp hiện 2 lần (${d.length})`);
    expect(d[1] && d[1].buttons.length === 3 && /Không giữ được chữ ký bằng cách nối thêm/.test(d[1].detail || ""), "lần hai: 3 nút + lý do");
    expect(fs.readFileSync(DOC).equals(damaged), "Huỷ ⇒ đĩa không bị ghi gì");

    // ---- S7/S8 (BI-132): KÝ lên tài liệu đã có chữ ký ---------------------------------------------------
    // Gọi thẳng IPC `signing.apply` (đúng thứ doSign gọi) với một thumbprint GIẢ: hộp cảnh báo nằm TRƯỚC worker/hộp PIN,
    // nên ca "Huỷ" không bao giờ chạm tới token; ca không-ký thì lọt qua cổng và bị worker từ chối vì không có chứng thư.
    console.log("\nS7  ký lên tài liệu CÒN chữ ký (byte nguyên từ đĩa) ⇒ hộp 3 nút; Huỷ ⇒ không ký");
    resetDisk();
    await evalIn(
      cdp,
      `(async () => {
         const bin = atob(${JSON.stringify(b64)});
         const u8 = new Uint8Array(bin.length);
         for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
         state.dirty = false;
         const ok = await loadBytes(u8, "hop-dong.pdf", ${JSON.stringify(DOC)});
         if (ok === false) throw new Error("loadBytes bi tu choi");
         return true;
       })()`
    );
    await setAnswers([2]); // Huỷ (nút cuối)
    let sres = await evalIn(cdp, `window.desktop.signing.apply({ bytes: state.bytes, thumbprint: "FAKE", meta: {} })`);
    d = await dlg();
    expect(d.length === 1 && d[0].buttons.length === 3, `hộp 3 nút (sidecar sẵn sàng ⇒ có nút nối): ${JSON.stringify(d[0] && d[0].buttons)}`);
    expect(d[0] && /^Ký nối thêm/.test(d[0].buttons[0]) && /^Vẫn ký/.test(d[0].buttons[1]) && /^Huỷ$/.test(d[0].buttons[2]), "thứ tự: Ký nối thêm, Vẫn ký, Huỷ");
    expect(d[0] && d[0].defaultId === 0 && d[0].cancelId === 2, "mặc định = Ký nối thêm (không phá chữ ký), Esc = Huỷ (cuối)");
    expect(d[0] && /1 chữ ký/.test(d[0].message) && /chưa bị thay đổi kể từ khi ký/.test(d[0].detail), "nêu số chữ ký + nói thật về cách trình đọc hiển thị");
    expect(sres.ok === false && sres.reason === "declined", `Huỷ ⇒ {ok:false, reason:'declined'}: ${JSON.stringify(sres)}`);

    console.log("\nS7b  cùng tài liệu, chọn 'Vẫn ký' ⇒ lọt qua cổng (worker tự từ chối vì thumbprint giả)");
    await setAnswers([1]); // Vẫn ký
    sres = await Promise.race([
      evalIn(cdp, `window.desktop.signing.apply({ bytes: state.bytes, thumbprint: "FAKE", meta: {} })`),
      sleep(90000).then(() => ({ reason: "TREO>90s" })),
    ]);
    d = await dlg();
    expect(d.length === 1, "đã hỏi đúng 1 lần");
    expect(sres.reason !== "declined" && sres.reason !== "TREO>90s", `đã vượt cổng, worker trả: ${JSON.stringify(sres).slice(0, 120)}`);

    console.log("\nS7c  chọn 'Ký nối thêm' ⇒ pdf-lib dựng chỗ giữ chữ ký → sidecar THẬT (HTTP) ghi nối → dừng ở TOKEN (thumbprint giả)");
    await setAnswers([0]); // Ký nối thêm
    sres = await Promise.race([
      evalIn(cdp, `window.desktop.signing.apply({ bytes: state.bytes, thumbprint: "FAKE", meta: { name: "N", reason: "r" } })`),
      sleep(120000).then(() => ({ reason: "TREO>120s" })),
    ]);
    d = await dlg();
    expect(d.length === 1, `chỉ hỏi 1 lần (không hỏi lại) — nối đã thành công TRƯỚC token: ${d.length}`);
    expect(sres.reason === "no_cert", `kết quả dừng ở token (no_cert) tức là toàn bộ phần ghi nối đã chạy xong: ${JSON.stringify(sres).slice(0, 140)}`);

    console.log("\nS7d  nối bị từ chối TRƯỚC PIN (file đích có revision cuối hỏng) ⇒ hỏi LẠI bằng hộp 2 nút kèm lý do");
    const brokenTail = Buffer.concat([ORIGINAL, Buffer.from("\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev 999999 >>\nstartxref\n12\n%%EOF\n")]);
    await setAnswers([0, 1]); // Ký nối thêm → (bị từ chối, hộp lại 2 nút) Vẫn ký
    sres = await Promise.race([
      evalIn(cdp, `(async () => { const bin = atob(${JSON.stringify(brokenTail.toString("base64"))}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return await window.desktop.signing.apply({ bytes: u8, thumbprint: "FAKE", meta: {} }); })()`),
      sleep(120000).then(() => ({ reason: "TREO>120s" })),
    ]);
    d = await dlg();
    console.log("    hộp:", d.length, d[1] ? JSON.stringify(d[1].buttons) + " | " + (d[1].detail || "").split("\n")[0] : "");
    expect(d.length === 2, `hộp hiện 2 lần (${d.length})`);
    expect(d[1] && d[1].buttons.length === 2 && /Không ký nối thêm được/.test(d[1].detail || ""), "lần 2: 2 nút + lý do");
    expect(sres.reason === "no_cert", `chọn 'Vẫn ký' ở lần 2 ⇒ đường cổ điển, tới token: ${JSON.stringify(sres).slice(0, 120)}`);

    console.log("\nS8  tài liệu đã bị pdf-lib dựng lại (chữ ký cũ đã mất khi sửa) ⇒ KHÔNG hỏi");
    resetDisk();
    await openAndRotate();
    await setAnswers([0]);
    sres = await Promise.race([
      evalIn(cdp, `window.desktop.signing.apply({ bytes: state.bytes, thumbprint: "FAKE", meta: {} })`),
      sleep(90000).then(() => ({ reason: "TREO>90s" })),
    ]);
    d = await dlg();
    expect(d.length === 0, `không hộp nào (${d.length})`);
    expect(sres.reason !== "declined" && sres.reason !== "TREO>90s", `đi thẳng tới worker: ${JSON.stringify(sres).slice(0, 120)}`);

    // ---- S9 (BI-135): "Tạo bản theo mẫu" ghi vào một thư mục — file đích CÓ SẴN và đã ký ---------------------
    console.log("\nS9  writeNewPdf(overwrite:true) lên file ĐÃ KÝ ⇒ hộp hỏi; bỏ qua/huỷ ⇒ file nguyên; đồng ý ⇒ ghi");
    const target = path.join(work, "s9-da-ky.pdf");
    const writeNew = (ow) =>
      evalIn(cdp, `window.desktop.writeNewPdf(${JSON.stringify(work)}, "s9-da-ky.pdf", new Uint8Array([37, 80, 68, 70, 10, 37, 37, 69, 79, 70, 10]), ${ow})`);
    const intact = () => fs.existsSync(target) && Buffer.compare(fs.readFileSync(target), ORIGINAL) === 0;
    fs.writeFileSync(target, ORIGINAL);
    await setAnswers([]);
    let w = await writeNew(false);
    d = await dlg();
    expect(w && w.saved === false && w.exists === true && d.length === 0 && intact(), `overwrite:false ⇒ exists, không hỏi, file nguyên: ${JSON.stringify(w)}`);
    await setAnswers([0]);
    w = await writeNew(true);
    d = await dlg();
    expect(w && w.saved === false && w.skipped === true && intact(), `bấm "Bỏ qua file này" ⇒ skipped, file nguyên: ${JSON.stringify(w)}`);
    expect(d.length === 1 && d[0].buttons[0] === "Bỏ qua file này" && d[0].defaultId === 0 && d[0].cancelId === 2 && d[0].detail.includes("s9-da-ky.pdf"), `hộp: ${JSON.stringify(d[0] && d[0].buttons)}, mặc định ${d[0] && d[0].defaultId}`);
    await setAnswers([]);
    w = await writeNew(true);
    expect(w && w.saved === false && w.skipped === true && intact(), `đóng hộp (Esc) ⇒ không ghi: ${JSON.stringify(w)}`);
    await setAnswers([1]);
    w = await writeNew(true);
    expect(w && w.saved === true && !intact() && fs.readFileSync(target).length === 11, `bấm "Vẫn ghi đè" ⇒ ghi: ${JSON.stringify(w)}`);
    fs.rmSync(target, { force: true });
    await setAnswers([]);
    w = await writeNew(true);
    d = await dlg();
    expect(w && w.saved === true && d.length === 0, `file chưa có + overwrite:true ⇒ ghi thẳng, không hỏi: ${JSON.stringify(w)}`);
  } catch (e) {
    failures.push("probe loi: " + e.message);
  } finally {
    try { cdp && cdp.close(); } catch (_) {}
    try { mainCdp && mainCdp.close(); } catch (_) {}
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch (_) {}
    await sleep(1500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }

  console.log("");
  if (failures.length) {
    console.log("CO VAN DE:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Tat ca ca deu dat (hop thoai native chua bam tay; chua Acrobat/Foxit).");
})();
