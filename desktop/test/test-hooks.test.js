"use strict";

// BI-141 — móc hộp thoại native cho bộ khung e2e (`src/test-hooks.js`).
//
// VÌ SAO CẦN LƯỚI RIÊNG. Móc này chạy trong BẢN ĐÓNG GÓI (electron-builder `src/**/*`), nên hai kiểu lỗi đều tệ:
//   1. Móc tự bật khi không ai bảo ⇒ app tự bấm "Huỷ" mọi hộp thoại của người dùng.
//   2. Móc trả "đồng ý/ghi đè" khi không có đáp án ⇒ một kịch bản thiếu đáp án GHI ĐÈ file thật.
// Cả hai im lặng. Nên lưới này đo hành vi thật của `install()` với đối tượng `dialog` giả và thư mục tạm thật, rồi ghim
// nguồn cho các luật không đo được bằng hành vi (chỉ nạp khi có biến môi trường; đáp án là dữ liệu, không bao giờ là mã).
//
// Chạy:  node desktop/test/test-hooks.test.js      (hoặc: npm test -- test-hooks)

const fs = require("fs");
const os = require("os");
const path = require("path");

const Hooks = require("../src/test-hooks");

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

function fakeDialog() {
  const orig = async () => "ORIGINAL";
  return { showMessageBox: orig, showSaveDialog: orig, showOpenDialog: orig, showErrorBox: orig, orig };
}
function mkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nabu-hooks-test-"));
}
function setAnswers(dir, obj) {
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(obj));
}
function calls(dir) {
  const p = path.join(dir, "calls.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function setup(answers) {
  const dir = mkdir();
  if (answers) setAnswers(dir, answers);
  const dialog = fakeDialog();
  const h = Hooks.install({ dialog, env: { NABU_TEST_HOOKS: dir } });
  return { dir, dialog, h };
}

// silence the intentional stderr banner while the suite runs
const realErr = console.error;
let banner = 0;
console.error = (...a) => {
  if (String(a[0]).startsWith("[test-hooks]")) banner++;
  else realErr(...a);
};

(async () => {
  // ---- 1. fail-closed lúc khởi động (Luật 3) ----------------------------------------------------------------
  for (const [label, env] of [
    ["thiếu biến", {}],
    ["rỗng", { NABU_TEST_HOOKS: "" }],
    ["đường dẫn tương đối", { NABU_TEST_HOOKS: "relative/dir" }],
    ["thư mục không tồn tại", { NABU_TEST_HOOKS: path.join(os.tmpdir(), "nabu-hooks-khong-co-" + Date.now()) }],
  ]) {
    let threw = false;
    try {
      Hooks.install({ dialog: fakeDialog(), env });
    } catch (_) {
      threw = true;
    }
    check(`install ném lỗi khi ${label}`, threw, true);
  }
  {
    // Đường dẫn tương đối CÓ TỒN TẠI (so với thư mục làm việc) vẫn phải bị từ chối: ca "không tồn tại" ở trên tự
    // nó đã ném, nên không chứng minh được rằng chính phép kiểm "tuyệt đối" hoạt động (đột biến H7 từng lọt).
    const parent = mkdir();
    fs.mkdirSync(path.join(parent, "ton-tai"));
    const cwd = process.cwd();
    process.chdir(parent);
    let threw = false;
    try {
      Hooks.install({ dialog: fakeDialog(), env: { NABU_TEST_HOOKS: "ton-tai" } });
    } catch (_) {
      threw = true;
    } finally {
      process.chdir(cwd);
    }
    check("install ném lỗi cả khi đường dẫn tương đối CÓ tồn tại (phải tuyệt đối)", threw, true);
  }
  {
    const f = path.join(mkdir(), "la-mot-file");
    fs.writeFileSync(f, "x");
    let threw = false;
    try {
      Hooks.install({ dialog: fakeDialog(), env: { NABU_TEST_HOOKS: f } });
    } catch (_) {
      threw = true;
    }
    check("install ném lỗi khi trỏ vào một FILE chứ không phải thư mục", threw, true);
  }

  // ---- 2. vá đúng ba phương thức, và in cảnh báo (Luật 4) ---------------------------------------------------
  {
    banner = 0;
    const { dialog, h } = setup({ epoch: 1 });
    check("in đúng một dòng cảnh báo khi bật", banner, 1);
    check("showMessageBox bị vá", dialog.showMessageBox !== dialog.orig, true);
    check("showSaveDialog bị vá", dialog.showSaveDialog !== dialog.orig, true);
    check("showOpenDialog bị vá", dialog.showOpenDialog !== dialog.orig, true);
    check("phương thức khác (showErrorBox) KHÔNG bị đụng", dialog.showErrorBox === dialog.orig, true);
    h.uninstall();
    check("uninstall trả lại hàm gốc", [dialog.showMessageBox, dialog.showSaveDialog, dialog.showOpenDialog].every((f) => f === dialog.orig), true);
  }

  // ---- 3. hàng đợi theo thứ tự, theo từng phương thức -------------------------------------------------------
  {
    const { dir, dialog } = setup({
      epoch: 1,
      showMessageBox: [0, 3, { response: 1, checkboxChecked: true }],
      showSaveDialog: ["C:/x/out.pdf", null],
      showOpenDialog: [["C:/a.pdf", "C:/b.pdf"], "C:/c.pdf", []],
    });
    const opts = { buttons: ["A", "B", "C", "Huỷ"], cancelId: 3 };
    check("messageBox #1 = số nguyên → response", await dialog.showMessageBox(opts), { response: 0, checkboxChecked: false });
    check("messageBox #2", (await dialog.showMessageBox(opts)).response, 3);
    const r3 = await dialog.showMessageBox(opts);
    check("messageBox #3 = object giữ cả checkboxChecked", [r3.response, r3.checkboxChecked], [1, true]);
    check("save #1 = chuỗi → filePath", await dialog.showSaveDialog({}), { canceled: false, filePath: "C:/x/out.pdf" });
    check("save #2 = null → huỷ", await dialog.showSaveDialog({}), { canceled: true, filePath: "" });
    check("open #1 = mảng → filePaths", await dialog.showOpenDialog({}), { canceled: false, filePaths: ["C:/a.pdf", "C:/b.pdf"] });
    check("open #2 = chuỗi → một đường dẫn", await dialog.showOpenDialog({}), { canceled: false, filePaths: ["C:/c.pdf"] });
    check("open #3 = mảng rỗng → huỷ", await dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
    check("không hộp nào trong số đó bị coi là bất ngờ", calls(dir).some((c) => c.unexpected), false);
    check("log ghi đủ 8 lần gọi", calls(dir).length, 8);
  }

  // ---- 4. hết đáp án ⇒ HUỶ + unexpected (Luật 2) -----------------------------------------------------------
  {
    const { dir, dialog } = setup({ epoch: 1, showMessageBox: [0] });
    await dialog.showMessageBox({ buttons: ["Ghi đè", "Huỷ"], cancelId: 1 }); // dùng hết đáp án
    const r = await dialog.showMessageBox({ buttons: ["Ghi đè", "Huỷ"], cancelId: 1 });
    check("hết đáp án + có cancelId ⇒ response = cancelId (KHÔNG phải 0 = Ghi đè)", r.response, 1);
    check("hết đáp án + không cancelId nhưng có nút 'Cancel' ⇒ nút đó", (await dialog.showMessageBox({ buttons: ["Overwrite", "Cancel"] })).response, 1);
    check("… nhận cả 'No'", (await dialog.showMessageBox({ buttons: ["Yes", "no"] })).response, 1);
    check("… không có gì để nhận ra ⇒ 0 (quy tắc của Electron)", (await dialog.showMessageBox({ buttons: ["X", "Y"] })).response, 0);
    check("Save hết đáp án ⇒ huỷ", await dialog.showSaveDialog({}), { canceled: true, filePath: "" });
    check("Open hết đáp án ⇒ huỷ", await dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
    const cs = calls(dir);
    check("lần dùng đáp án có sẵn KHÔNG unexpected", cs[0].unexpected, false);
    check("mọi lần hết đáp án đều bị đánh dấu unexpected", cs.slice(1).every((c) => c.unexpected === true), true);
  }

  // ---- 5. thiếu / hỏng answers.json ⇒ không sập, mọi hộp là unexpected + huỷ -------------------------------
  {
    const { dir, dialog } = setup(null);
    const r = await dialog.showMessageBox({ buttons: ["Ghi đè", "Huỷ"], cancelId: 1 });
    check("thiếu answers.json ⇒ vẫn trả lời (huỷ)", r.response, 1);
    fs.writeFileSync(path.join(dir, "answers.json"), "{ không phải json");
    const r2 = await dialog.showMessageBox({ buttons: ["Ghi đè", "Huỷ"], cancelId: 1 });
    check("answers.json hỏng ⇒ vẫn trả lời (huỷ), không sập", r2.response, 1);
    fs.writeFileSync(path.join(dir, "answers.json"), "[1,2,3]");
    check("answers.json là mảng thay vì object ⇒ huỷ", (await dialog.showMessageBox({ cancelId: 0, buttons: ["a"] })).response, 0);
    check("tất cả đều unexpected", calls(dir).every((c) => c.unexpected), true);
  }
  {
    const { dir, dialog } = setup({ epoch: 1, showMessageBox: ["không phải số", 2.5, [1]], showSaveDialog: [42, undefined], showOpenDialog: [7] });
    for (let i = 0; i < 3; i++) await dialog.showMessageBox({ buttons: ["A", "Huỷ"], cancelId: 1 });
    await dialog.showSaveDialog({});
    await dialog.showOpenDialog({});
    check("mục đáp án không hiểu được ⇒ unexpected + huỷ (không đoán)", calls(dir).every((c) => c.unexpected), true);
    check("… và message box vẫn trả nút Huỷ", calls(dir).filter((c) => c.method === "showMessageBox").every((c) => c.answer.response === 1), true);
  }

  // ---- 6. epoch: đổi kịch bản giữa chừng, hàng đợi bắt đầu lại ----------------------------------------------
  {
    const { dir, dialog } = setup({ epoch: 1, showMessageBox: [0, 1] });
    const o = { buttons: ["A", "B", "Huỷ"], cancelId: 2 };
    check("epoch 1 #1", (await dialog.showMessageBox(o)).response, 0);
    setAnswers(dir, { epoch: 2, showMessageBox: [1, 0] });
    check("epoch đổi ⇒ hàng đợi bắt đầu lại từ đầu (#1 của epoch 2)", (await dialog.showMessageBox(o)).response, 1);
    check("… rồi tiếp #2", (await dialog.showMessageBox(o)).response, 0);
    check("… hết thì huỷ", (await dialog.showMessageBox(o)).response, 2);
    setAnswers(dir, { epoch: 2, showMessageBox: [1, 0, 1] });
    check("ghi lại CÙNG epoch KHÔNG đặt lại con trỏ (không phát lại đáp án đã dùng)", (await dialog.showMessageBox(o)).response, 1);
    check("log gắn đúng epoch cho từng lần gọi", calls(dir).map((c) => c.epoch), [1, 2, 2, 2, 2]);
  }

  // ---- 7. hai kiểu gọi (win, opts) và (opts); log không mang cửa sổ cha / vòng tham chiếu --------------------
  {
    const { dir, dialog } = setup({ epoch: 1, showMessageBox: [0, 0, 0, 0] });
    const circular = { isDestroyed() { return false; }, id: 7 };
    circular.self = circular;
    const opts = { type: "warning", title: "T", message: "M", detail: "D", buttons: ["Một", "Hai"], defaultId: 0, cancelId: 1, parent: circular };
    await dialog.showMessageBox(circular, opts);
    await dialog.showMessageBox(opts);
    await dialog.showMessageBox(undefined, opts);
    await dialog.showMessageBox(circular); // chỉ có cửa sổ, không tuỳ chọn
    const cs = calls(dir);
    check("(win, opts) ghi được tuỳ chọn", cs[0].options, { type: "warning", title: "T", message: "M", detail: "D", buttons: ["Một", "Hai"], defaultId: 0, cancelId: 1 });
    check("(opts) ghi được tuỳ chọn như nhau", cs[1].options, cs[0].options);
    check("(undefined, opts) cũng vậy", cs[2].options, cs[0].options);
    check("chỉ truyền cửa sổ ⇒ tuỳ chọn rỗng, không sập", cs[3].options, {});
    check("log KHÔNG chứa trường `parent`", cs.some((c) => "parent" in c.options), false);
  }
  {
    const { dir, dialog } = setup({ epoch: 1, showSaveDialog: [null], showOpenDialog: [null] });
    await dialog.showSaveDialog({ title: "Lưu", defaultPath: "D:/a.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }], properties: ["showOverwriteConfirmation"] });
    await dialog.showOpenDialog({ title: "Mở", properties: ["openFile", "multiSelections"] });
    const cs = calls(dir);
    check("save: ghi title/defaultPath/filters", [cs[0].options.title, cs[0].options.defaultPath, cs[0].options.filters], ["Lưu", "D:/a.pdf", [{ name: "PDF", extensions: ["pdf"] }]]);
    check("open: ghi properties", cs[1].options.properties, ["openFile", "multiSelections"]);
  }

  // ---- 8. ghim nguồn: các luật không đo được bằng hành vi ---------------------------------------------------
  const HOOKS_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "test-hooks.js"), "utf8");
  const MAIN_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  // Bỏ comment trước khi quét: chính file này giải thích luật "không eval" bằng chữ `eval`.
  const code = HOOKS_SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  check("Luật 1: không có eval()", /\beval\s*\(/.test(code), false);
  check("… không có new Function", /new\s+Function\b/.test(code), false);
  check("… không có vm.", /require\(\s*["']vm["']\s*\)/.test(code), false);
  check("… require() chỉ nhận chuỗi cố định (không bao giờ đường dẫn lấy từ file)",
    [...code.matchAll(/require\(([^)]*)\)/g)].every((m) => /^["'](fs|path)["']$/.test(m[1].trim())), true);
  check("… đáp án chỉ đi qua JSON.parse", /JSON\.parse\(fsImpl\.readFileSync\(answersPath/.test(code), true);

  const reqs = [...MAIN_SRC.matchAll(/require\(\s*["']\.\/test-hooks["']\s*\)/g)];
  check("main.js nạp test-hooks đúng MỘT chỗ", reqs.length, 1);
  const line = MAIN_SRC.split("\n").find((l) => /require\(\s*["']\.\/test-hooks["']\s*\)/.test(l)) || "";
  check("… và chỉ khi có biến môi trường (cùng một dòng, sau `if`)", /^\s*if\s*\(\s*process\.env\.NABU_TEST_HOOKS\s*\)\s*require\(/.test(line), true);
  check("… vá đối tượng `dialog` dùng chung (phủ cả updater.js)", /install\(\s*\{\s*dialog\s*\}\s*\)/.test(line), true);
  const ci = MAIN_SRC.indexOf("require(\"./test-hooks\")");
  const firstDialogUse = MAIN_SRC.indexOf("dialog.show");
  check("… TRƯỚC mọi lần dùng dialog.* trong main.js", ci > 0 && ci < firstDialogUse, true);

  console.error = realErr;
  console.log(`\ntest-hooks: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error = realErr;
  console.error("CRASH", e);
  process.exit(1);
});
