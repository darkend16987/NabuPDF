"use strict";

// BI-141 — "đừng phá chữ ký số" (BI-127…137) trong APP ELECTRON THẬT, trên file ký THẬT, với trọng tài OpenSSL. Chuyển từ
// `scripts/probe-signed-save.js` (BI-131) sang bộ khung e2e, GIỮ NGUYÊN các phép khẳng định S1–S10; thay phần nối `--inspect`
// vào main + `eval` vá `dialog.*` bằng móc hộp thoại (`src/test-hooks.js`).
//
// CÁI GÌ ĐƯỢC CHẠY THẬT. Renderer thật (`rotateSelected` → `saveDoc` → preload → IPC) → main thật (`file:write-pdf`, cổng BI-127,
// `planSignedWrite`) → HTTP thật tới sidecar thật (route `/save-incremental-bin`, tiến trình con) → ghi ĐĨA thật → OpenSSL kiểm
// chữ ký trên file vừa ghi.
//
// CÁI GÌ KHÔNG. Chuyện hộp thoại native TRÔNG ra sao trên màn hình (ta trả lời "bấm nút thứ N" và ghi lại nhãn nút, mặc định,
// Esc, nội dung hộp). Chưa có Acrobat/Foxit ở đây: "vùng ký còn nguyên và OpenSSL xác nhận" KHÔNG phải "Acrobat cho là hợp lệ".
//
// KHÁC probe cũ — ĐỀU CÓ CHỦ Ý:
//   · "Esc = đóng hộp" ở S9 nay là đáp án TƯỜNG MINH `cancelId` (2) thay vì để hết đáp án — cùng đường mã (response = cancelId),
//     nhưng nhờ vậy cuối kịch bản khẳng định được `dialogs.unexpected()` RỖNG: mọi hộp hiện ra đều có chủ đích.
//   · hộp Lưu thành (S5) được trả lời "huỷ" tường minh (`showSaveDialog: [null]`) và đếm theo log chứ không theo biến toàn cục.
//
// Cần: .venv Python, node, openssl (cho `tools/signed_fixture.js` + `tools/verify_pdf_signatures.py`). Thiếu ⇒ thoát mã 2.
//
// Chạy:  cd desktop ; node e2e/signed-save.e2e.js     (hoặc: npm run e2e -- signed)

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, DESKTOP } = require("./lib/app-driver");

const ROOT = path.join(DESKTOP, "..");
const PY = path.join(ROOT, ".venv", "Scripts", "python.exe");

function skip(why) {
  console.log("BỎ QUA: " + why);
  process.exit(2);
}
if (!fs.existsSync(PY)) skip(`không thấy ${PY}`);
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch (_) {
  skip("không có `openssl` trong PATH (cần cho fixture ký và trọng tài)");
}

const failures = [];
const expect = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "SAI "} ${msg}`);
  if (!cond) failures.push(msg);
};

// 0 = mọi chữ ký hợp lệ; 1 = có chữ ký hỏng; 2 = không có chữ ký nào.
function verify(file) {
  try {
    const out = execFileSync(PY, [path.join(ROOT, "tools", "verify_pdf_signatures.py"), file], {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "").trim() };
  }
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-e2e-signed-"));
  let fx;
  try {
    fx = JSON.parse(
      execFileSync(process.execPath, [path.join(ROOT, "tools", "signed_fixture.js"), path.join(work, "fx")], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
        .pop(),
    );
  } catch (e) {
    skip("không dựng được fixture ký: " + String(e.message).split("\n")[0]);
  }
  const ORIGINAL = fs.readFileSync(fx.signed);
  const DOC = path.join(work, "hop-dong.pdf"); // file người dùng "đang mở": app ghi vào ĐÂY
  const resetDisk = () => fs.writeFileSync(DOC, ORIGINAL);
  resetDisk();
  const base = verify(DOC);
  if (base.code !== 0) skip("file ký gốc KHÔNG hợp lệ theo OpenSSL: " + base.out);
  console.log(`file ký: ${ORIGINAL.length} B, OpenSSL: HỢP LỆ\n`);

  const app = await launch();
  const userData = app.userDataDir;
  try {
    const page = await app.ready();

    // Đặt kịch bản mới: đáp án của hộp message box (theo thứ tự); hộp Lưu thành luôn "huỷ" tường minh.
    const setAnswers = (boxes) => app.dialogs.answer({ showMessageBox: boxes, showSaveDialog: [null, null, null] });
    const boxes = () => app.dialogs.calls().filter((c) => c.method === "showMessageBox").map((c) => c.options);
    const saveAsCount = () => app.dialogs.calls().filter((c) => c.method === "showSaveDialog").length;

    // Mở file KÈM đường dẫn (state.path) — đúng như mở từ đĩa — rồi xoay trang 1 bằng chính hàm của app.
    const openAndRotate = async () => {
      await app.openPdf(ORIGINAL, "hop-dong.pdf", { srcPath: DOC });
      return page.eval(
        `(async () => {
           state.selected = new Set([0]);
           await rotateSelected(90);
           const el = document.getElementById("toast"); el.textContent = ""; el.className = "toast";
           return { dirty: state.dirty, contentRemoved: state.contentRemoved, path: state.path, pages: state.numPages };
         })()`,
      );
    };
    const save = () => page.eval(`(async () => { await saveDoc(); const el = document.getElementById("toast"); return { toast: el.textContent, dirty: state.dirty }; })()`);
    const signApply = (extra, timeout = 120000) =>
      page.eval(`window.desktop.signing.apply({ bytes: state.bytes, thumbprint: "FAKE", meta: ${extra || "{}"} })`, { timeout });

    // ---- S1: ghi nối thành công ---------------------------------------------------------------------
    console.log("S1  Ctrl+S lên file ký, chọn nút đầu (Lưu nối thêm)");
    resetDisk();
    console.log("    mở + xoay:", JSON.stringify(await openAndRotate()));
    setAnswers([0]);
    let r = await save();
    let d = boxes();
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

    // ---- S2: Ctrl+S lần nữa, không sửa gì -----------------------------------------------------------
    console.log("\nS2  Ctrl+S lần hai (không sửa gì thêm)");
    setAnswers([0]);
    r = await save();
    d = boxes();
    const disk2 = fs.readFileSync(DOC);
    expect(d.length === 1 && d[0].buttons.length === 4, "hộp lại hiện (đĩa là bản đã nối, renderer giữ bản pdf-lib) — đã biết, ghi ở BI-130");
    expect(disk2.subarray(0, disk1.length).equals(disk1), "lần hai giữ nguyên byte của lần một");
    expect(disk2.length - disk1.length <= 2048, `lần hai không phình vô ích (+${disk2.length - disk1.length} B)`);
    expect(verify(DOC).code === 0, "OpenSSL: vẫn hợp lệ");

    // ---- S3: phiên đã xoá nội dung thật ⇒ KHÔNG có nút nối ------------------------------------------
    console.log("\nS3  phiên đã xoá nội dung thật (state.contentRemoved = true) ⇒ không đề nghị nối");
    resetDisk();
    await openAndRotate();
    await page.eval(`(state.contentRemoved = true, true)`);
    setAnswers([2]); // 3 nút: Huỷ
    r = await save();
    d = boxes();
    expect(d.length === 1 && d[0].buttons.length === 3, `hộp chỉ 3 nút: ${JSON.stringify(d[0] && d[0].buttons)}`);
    expect(d[0] && !/nối thêm/i.test(d[0].buttons.join("|")), "không có nút 'Lưu nối thêm'");
    expect(fs.readFileSync(DOC).equals(ORIGINAL), "Huỷ ⇒ đĩa y nguyên từng byte");
    expect(!/^Đã lưu/.test(r.toast), `không có toast 'Đã lưu' (${JSON.stringify(r.toast)})`);

    // ---- S4: huỷ ở hộp 4 nút ------------------------------------------------------------------------
    console.log("\nS4  hộp 4 nút, bấm Huỷ");
    resetDisk();
    await openAndRotate();
    setAnswers([3]);
    r = await save();
    d = boxes();
    expect(d.length === 1 && d[0].buttons.length === 4, `hộp 4 nút, và không hiện hộp thứ hai (${d.length}) — Huỷ dừng hẳn`);
    expect(fs.readFileSync(DOC).equals(ORIGINAL), "đĩa y nguyên");
    expect(saveAsCount() === 0, "không mở hộp Lưu thành");

    // ---- S5: chọn 'bản sao' ⇒ rơi sang hộp Lưu thành ------------------------------------------------
    console.log("\nS5  hộp 4 nút, bấm 'Lưu thành bản sao…' (nút 2)");
    await openAndRotate();
    setAnswers([1]);
    r = await save();
    d = boxes();
    expect(d.length === 1 && d[0].buttons.length === 4 && /bản sao/.test(d[0].buttons[1]), "hộp 4 nút, nút 1 là bản sao");
    expect(saveAsCount() === 1, "mở hộp Lưu thành đúng 1 lần");
    expect(fs.readFileSync(DOC).equals(ORIGINAL), "file gốc không bị đụng");

    // ---- S6: bản nối bị từ chối (file gốc bị hỏng cấu trúc) ⇒ hỏi lại, không tự ghi đè --------------
    console.log("\nS6  sidecar từ chối (file đích không còn là PDF hợp lệ) ⇒ hộp hỏi LẠI 3 nút kèm lý do");
    resetDisk();
    await openAndRotate();
    // Sau khi mở, đặt lên đĩa: file ký + một revision cuối HỎNG (xref trỏ vào hư vô). Nó nằm SAU vùng ký nên chữ ký vẫn nguyên
    // và cổng BI-127 vẫn thấy; còn MuPDF phải sửa cấu trúc khi mở ⇒ lõi ghi nối từ chối. (Bài học: chữ ký phủ tới HẾT file ký nên
    // phá cái đuôi của chính nó là phá luôn chữ ký — lần đầu probe làm vậy và app đúng khi coi đó là file không ký.)
    const BROKEN_TAIL = "\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev 999999 >>\nstartxref\n12\n%%EOF\n";
    const damaged = Buffer.concat([ORIGINAL, Buffer.from(BROKEN_TAIL)]);
    fs.writeFileSync(DOC, damaged);
    setAnswers([0, 2]); // nối → (hộp lại, 3 nút) Huỷ
    r = await save();
    d = boxes();
    expect(d.length === 2, `hộp hiện 2 lần (${d.length})`);
    expect(d[1] && d[1].buttons.length === 3 && /Không giữ được chữ ký bằng cách nối thêm/.test(d[1].detail || ""), "lần hai: 3 nút + lý do");
    expect(fs.readFileSync(DOC).equals(damaged), "Huỷ ⇒ đĩa không bị ghi gì");

    // ---- S7/S8 (BI-132): KÝ lên tài liệu đã có chữ ký -----------------------------------------------
    // Gọi thẳng IPC `signing.apply` (đúng thứ doSign gọi) với một thumbprint GIẢ: hộp cảnh báo nằm TRƯỚC worker/hộp PIN, nên ca
    // "Huỷ" không bao giờ chạm tới token; ca không-ký thì lọt qua cổng và bị worker từ chối vì không có chứng thư.
    console.log("\nS7  ký lên tài liệu CÒN chữ ký (byte nguyên từ đĩa) ⇒ hộp 3 nút; Huỷ ⇒ không ký");
    resetDisk();
    await app.openPdf(ORIGINAL, "hop-dong.pdf", { srcPath: DOC });
    setAnswers([2]); // Huỷ (nút cuối)
    let sres = await signApply();
    d = boxes();
    expect(d.length === 1 && d[0].buttons.length === 3, `hộp 3 nút (sidecar sẵn sàng ⇒ có nút nối): ${JSON.stringify(d[0] && d[0].buttons)}`);
    expect(d[0] && /^Ký nối thêm/.test(d[0].buttons[0]) && /^Vẫn ký/.test(d[0].buttons[1]) && /^Huỷ$/.test(d[0].buttons[2]), "thứ tự: Ký nối thêm, Vẫn ký, Huỷ");
    expect(d[0] && d[0].defaultId === 0 && d[0].cancelId === 2, "mặc định = Ký nối thêm (không phá chữ ký), Esc = Huỷ (cuối)");
    expect(d[0] && /1 chữ ký/.test(d[0].message) && /chưa bị thay đổi kể từ khi ký/.test(d[0].detail), "nêu số chữ ký + nói thật về cách trình đọc hiển thị");
    expect(sres.ok === false && sres.reason === "declined", `Huỷ ⇒ {ok:false, reason:'declined'}: ${JSON.stringify(sres)}`);

    console.log("\nS7b  cùng tài liệu, chọn 'Vẫn ký' ⇒ lọt qua cổng (worker tự từ chối vì thumbprint giả)");
    setAnswers([1]); // Vẫn ký
    sres = await signApply("{}", 90000).catch((e) => ({ reason: "TREO: " + e.message }));
    d = boxes();
    expect(d.length === 1, "đã hỏi đúng 1 lần");
    expect(sres.reason !== "declined" && !/^TREO/.test(sres.reason || ""), `đã vượt cổng, worker trả: ${JSON.stringify(sres).slice(0, 120)}`);

    console.log("\nS7c  chọn 'Ký nối thêm' ⇒ pdf-lib dựng chỗ giữ chữ ký → sidecar THẬT (HTTP) ghi nối → dừng ở TOKEN (thumbprint giả)");
    setAnswers([0]); // Ký nối thêm
    sres = await signApply(`{ name: "N", reason: "r" }`).catch((e) => ({ reason: "TREO: " + e.message }));
    d = boxes();
    expect(d.length === 1, `chỉ hỏi 1 lần (không hỏi lại) — nối đã thành công TRƯỚC token: ${d.length}`);
    expect(sres.reason === "no_cert", `kết quả dừng ở token (no_cert) tức là toàn bộ phần ghi nối đã chạy xong: ${JSON.stringify(sres).slice(0, 140)}`);

    console.log("\nS7d  nối bị từ chối TRƯỚC PIN (file đích có revision cuối hỏng) ⇒ hỏi LẠI bằng hộp 2 nút kèm lý do");
    const brokenTail = Buffer.concat([ORIGINAL, Buffer.from(BROKEN_TAIL)]);
    setAnswers([0, 1]); // Ký nối thêm → (bị từ chối, hộp lại 2 nút) Vẫn ký
    sres = await page
      .eval(
        `(async () => { const bin = atob(${JSON.stringify(brokenTail.toString("base64"))}); const u8 = new Uint8Array(bin.length);
           for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
           return await window.desktop.signing.apply({ bytes: u8, thumbprint: "FAKE", meta: {} }); })()`,
        { timeout: 120000 },
      )
      .catch((e) => ({ reason: "TREO: " + e.message }));
    d = boxes();
    expect(d.length === 2, `hộp hiện 2 lần (${d.length})`);
    expect(d[1] && d[1].buttons.length === 2 && /Không ký nối thêm được/.test(d[1].detail || ""), "lần 2: 2 nút + lý do");
    expect(sres.reason === "no_cert", `chọn 'Vẫn ký' ở lần 2 ⇒ đường cổ điển, tới token: ${JSON.stringify(sres).slice(0, 120)}`);

    console.log("\nS8  tài liệu đã bị pdf-lib dựng lại (chữ ký cũ đã mất khi sửa) ⇒ KHÔNG hỏi");
    resetDisk();
    await openAndRotate();
    setAnswers([0]);
    sres = await signApply("{}", 90000).catch((e) => ({ reason: "TREO: " + e.message }));
    d = boxes();
    expect(d.length === 0, `không hộp nào (${d.length})`);
    expect(sres.reason !== "declined" && !/^TREO/.test(sres.reason || ""), `đi thẳng tới worker: ${JSON.stringify(sres).slice(0, 120)}`);

    // ---- S9 (BI-135): "Tạo bản theo mẫu" ghi vào một thư mục — file đích CÓ SẴN và đã ký -------------
    console.log("\nS9  writeNewPdf(overwrite:true) lên file ĐÃ KÝ ⇒ hộp hỏi; bỏ qua/huỷ ⇒ file nguyên; đồng ý ⇒ ghi");
    const target = path.join(work, "s9-da-ky.pdf");
    const writeNew = (ow) =>
      page.eval(`window.desktop.writeNewPdf(${JSON.stringify(work)}, "s9-da-ky.pdf", new Uint8Array([37, 80, 68, 70, 10, 37, 37, 69, 79, 70, 10]), ${ow})`);
    const intact = () => fs.existsSync(target) && Buffer.compare(fs.readFileSync(target), ORIGINAL) === 0;
    fs.writeFileSync(target, ORIGINAL);
    setAnswers([]);
    let w = await writeNew(false);
    d = boxes();
    expect(w && w.saved === false && w.exists === true && d.length === 0 && intact(), `overwrite:false ⇒ exists, không hỏi, file nguyên: ${JSON.stringify(w)}`);
    setAnswers([0]);
    w = await writeNew(true);
    d = boxes();
    expect(w && w.saved === false && w.skipped === true && intact(), `bấm "Bỏ qua file này" ⇒ skipped, file nguyên: ${JSON.stringify(w)}`);
    expect(d.length === 1 && d[0].buttons[0] === "Bỏ qua file này" && d[0].defaultId === 0 && d[0].cancelId === 2 && d[0].detail.includes("s9-da-ky.pdf"), `hộp: ${JSON.stringify(d[0] && d[0].buttons)}, mặc định ${d[0] && d[0].defaultId}`);
    setAnswers([2]); // Esc = đóng hộp = cancelId (tường minh, xem ghi chú đầu file)
    w = await writeNew(true);
    expect(w && w.saved === false && w.skipped === true && intact(), `đóng hộp (Esc) ⇒ không ghi: ${JSON.stringify(w)}`);
    setAnswers([1]);
    w = await writeNew(true);
    expect(w && w.saved === true && !intact() && fs.readFileSync(target).length === 11, `bấm "Vẫn ghi đè" ⇒ ghi: ${JSON.stringify(w)}`);
    fs.rmSync(target, { force: true });
    setAnswers([]);
    w = await writeNew(true);
    d = boxes();
    expect(w && w.saved === true && d.length === 0, `file chưa có + overwrite:true ⇒ ghi thẳng, không hỏi: ${JSON.stringify(w)}`);

    // ---- S10 (BI-137/BI-74): ẨN TRANG ⇒ scrubRecoverySnapshot của renderer ⇒ recovery:save{scrub:true} ở main ⇒ đĩa --
    console.log("\nS10 scrubRecoverySnapshot (đường ẩn trang): bản rõ cũ + file tạm sót biến mất, manifest giữ srcPath");
    const slotDir = path.join(userData, "recovery", "probe-scrub");
    await page.eval(
      `(async () => {
         state.docId = "probe-scrub";
         const enc = (s) => new TextEncoder().encode(s);
         await window.desktop.recovery.save({ docId: "probe-scrub", bytes: enc("%PDF-1.7 PLAINTEXT-SECRET-PAGE"), name: "hd.pdf", srcPath: "C:/x/hd.pdf" });
         return true;
       })()`,
    );
    fs.writeFileSync(path.join(slotDir, "autosave.pdf.cafe00000000.nabu-tmp"), "PLAINTEXT-SECRET-PARTIAL");
    expect(fs.readFileSync(path.join(slotDir, "autosave.pdf"), "latin1").includes("PLAINTEXT-SECRET"), "tiền điều kiện: autosave.pdf đang chứa bản rõ");
    await page.eval(
      `(async () => {
         state.bytes = new TextEncoder().encode("%PDF-1.7 SEALED-NEW");
         state.name = "hd.pdf"; state.path = "C:/x/hd.pdf";
         await scrubRecoverySnapshot();
         return true;
       })()`,
    );
    const slotFiles = fs.readdirSync(slotDir);
    const slotText = slotFiles.map((f) => fs.readFileSync(path.join(slotDir, f), "latin1")).join("|");
    expect(!slotText.includes("PLAINTEXT-SECRET"), `không còn byte bản rõ nào trong khe phục hồi: ${JSON.stringify(slotFiles)}`);
    expect(fs.readFileSync(path.join(slotDir, "autosave.pdf"), "latin1") === "%PDF-1.7 SEALED-NEW", "autosave.pdf là bản đã niêm");
    const mfx = JSON.parse(fs.readFileSync(path.join(slotDir, "manifest.json"), "utf8"));
    expect(mfx.srcPath === "C:/x/hd.pdf" && mfx.name === "hd.pdf", `manifest giữ đường dẫn gốc (lỗi cũ: gửi path thay srcPath): ${JSON.stringify(mfx)}`);
    expect(!slotFiles.some((f) => f.endsWith(".nabu-tmp")), "không còn .nabu-tmp trong khe");
    await page.eval(`window.desktop.recovery.clear("probe-scrub")`);
    expect(!fs.existsSync(slotDir), "clear xoá cả khe");

    // BI-136: mọi đường ghi PDF ở trên (Ctrl+S nối, Lưu thành, Tạo bản theo mẫu) ghi qua file tạm + đổi tên; sau cả chuỗi
    // kịch bản không được còn file .nabu-tmp nào trong thư mục (thành công hay bị từ chối đều phải dọn).
    const leftovers = fs.readdirSync(work).filter((f) => f.endsWith(".nabu-tmp"));
    expect(leftovers.length === 0, `không còn file .nabu-tmp sau S1–S9: ${JSON.stringify(leftovers)}`);

    // MỚI so với probe cũ: mọi hộp hiện ra trong cả kịch bản đều có đáp án đặt trước (không có hộp bất ngờ).
    const un = app.dialogs.unexpected();
    expect(un.length === 0, `không có hộp thoại bất ngờ nào suốt S1–S10 (${un.length}): ${JSON.stringify(un.slice(0, 2).map((c) => c.options.buttons || c.options.title))}`);
  } catch (e) {
    failures.push("kịch bản lỗi: " + e.message);
    console.log("LỖI:", e.message);
    console.log("--- log app (cuối) ---\n" + app.log().slice(-1200));
  } finally {
    await app.close();
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log("");
  if (failures.length) {
    console.log("CÓ VẤN ĐỀ:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("Tất cả ca đều đạt (hộp thoại native chưa bấm tay; chưa Acrobat/Foxit).");
})();
