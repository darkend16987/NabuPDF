"use strict";

// BI-126 — nút Hủy cho lần nén đang chạy.
//
// VÌ SAO CÓ LƯỚI NÀY. Một nút Hủy sai còn tệ hơn không có nút, theo đúng ba kiểu, và
// cả ba đều im lặng:
//
//   1. Nút nói dối. Bấm xong lớp phủ tắt, người dùng tưởng đã dừng — nhưng sidecar
//      vẫn nén tiếp tới 30 phút, vẫn ăn RAM gấp 4 lần file. Đó là lý do renderer
//      KHÔNG abort fetch mà đi hỏi sidecar, và tại sao mã việc gửi đi ở /compress-bin
//      phải trùng đúng mã gửi ở /compress-cancel: lệch một chữ thì hủy nhầm hư không
//      và không có lỗi ở đâu cả.
//   2. Nút sống dai. #overlay dùng chung cho ~49 thao tác. Giữ lại handler của lần
//      trước thì thao tác sau mọc ra một nút Hủy bấm vào đi hủy việc đã xong — đúng
//      kiểu lỗi #confirm-modal từng vấp với nút thứ ba (xem confirm-dialog.test.js).
//   3. Hủy bị tính là lỗi. Người dùng tự bấm Hủy rồi nhận toast đỏ "Nén lỗi: …".
//
// ĐO Ở ĐÂU. `showOverlay`/`setOverlayMsg`/`hideOverlay` chỉ sờ DOM qua `$`, không cần
// document thật — nên chúng được CẮT RA KHỎI app.js đang ship rồi eval với `$` giả:
// đó là hành vi thật, không phải regex. Phần `runCompress` thì là DOM + fetch, node
// không chạy được, nên ghim nguồn — và ghim luôn SANG api.py, vì hai nửa của hợp đồng
// (tên tham số `job`, trường `cancelled`) nằm ở hai ngôn ngữ khác nhau.
//
// Chạy:  node desktop/test/compress-cancel.test.js

const fs = require("fs");
const path = require("path");

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

const R = path.join(__dirname, "..", "renderer");
const APP = fs.readFileSync(path.join(R, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(R, "index.html"), "utf8");
const API = fs.readFileSync(path.join(__dirname, "..", "..", "api.py"), "utf8");

// ---- 1. markup -------------------------------------------------------------
const ovAt = HTML.indexOf('<div class="overlay" id="overlay"');
check("index.html vẫn có #overlay", ovAt >= 0, true);
// Tới hết DÒNG, không tới `</div>` đầu tiên: lớp phủ có một <div class="spinner">
// lồng bên trong, nên `</div>` đầu tiên là của cái spinner ấy.
const ovBlock = HTML.slice(ovAt, HTML.indexOf("\n", ovAt));
const btnTag = /<button id="overlay-cancel"[^>]*>/.exec(ovBlock);
check("nút Hủy nằm BÊN TRONG lớp phủ", !!btnTag, true);
// Mặc định ẩn: showOverlay() không có hàm hủy là trường hợp của 48/49 chỗ gọi, và
// chúng không được thừa hưởng một nút bấm vào không làm gì.
check("… và mặc định ẩn", /\bhidden\b/.test(btnTag ? btnTag[0] : ""), true);
check("… là <button type=\"button\"> (không submit form nào)",
  /type="button"/.test(btnTag ? btnTag[0] : ""), true);

// ---- 2. hành vi thật của showOverlay / hideOverlay --------------------------
// Cắt đúng ba hàm ra khỏi file đang ship. Mốc cuối là comment ngay sau hideOverlay;
// nó đỏ nếu ai đó chèn hàm vào giữa, và đỏ như thế là tín hiệu để đọc, không phải
// để sửa cho xanh.
const i = APP.indexOf("function showOverlay(");
const j = APP.indexOf("// Non-blocking confirm dialog", i);
check("cắt được khối overlay ra khỏi app.js", i >= 0 && j > i, true);

const els = {
  "overlay": { hidden: true },
  "overlay-msg": { textContent: "" },
  "overlay-cancel": { hidden: true, disabled: false, onclick: null },
};
const fn = new Function("$", APP.slice(i, j) + "\nreturn { showOverlay, setOverlayMsg, hideOverlay };")(
  (id) => els[id],
);

// (a) không có hàm hủy => không có nút, không có handler.
fn.showOverlay("Đang xử lý…");
check("không đưa hàm hủy ⇒ nút ẩn", els["overlay-cancel"].hidden, true);
check("… và không có handler nào treo lại", els["overlay-cancel"].onclick, null);
check("… lớp phủ vẫn hiện", els["overlay"].hidden, false);

// (b) có hàm hủy => nút hiện, bấm một cái gọi đúng một lần và tự khoá.
let goi = 0;
fn.showOverlay("Đang nén…", () => goi++);
check("đưa hàm hủy ⇒ nút hiện", els["overlay-cancel"].hidden, false);
check("… nút chưa bị khoá", els["overlay-cancel"].disabled, false);
els["overlay-cancel"].onclick();
check("bấm ⇒ gọi hàm hủy", goi, 1);
check("… và nút tự khoá ngay", els["overlay-cancel"].disabled, true);
// Bấm thêm: hàm hủy của runCompress tự chặn lần hai, nhưng nút phải NHÌN THẤY là
// đã khoá — người dùng bấm lại khi màn hình không phản hồi gì là chuyện thường.
check("nút vẫn ở trạng thái khoá", els["overlay-cancel"].disabled, true);

// (c) setOverlayMsg đổi chữ mà KHÔNG mở khoá nút.
fn.setOverlayMsg("Đang hủy…");
check("setOverlayMsg đổi dòng chữ", els["overlay-msg"].textContent, "Đang hủy…");
check("… và không đụng vào nút", els["overlay-cancel"].disabled, true);
check("… cũng không bật lại nó", els["overlay-cancel"].hidden, false);

// (d) THAO TÁC KẾ TIẾP không được thừa hưởng nút của thao tác trước.
fn.showOverlay("Đang tách PDF…");
check("thao tác sau không hủy được ⇒ nút ẩn lại", els["overlay-cancel"].hidden, true);
check("… handler cũ bị gỡ hẳn", els["overlay-cancel"].onclick, null);

// (e) hideOverlay dọn sạch.
fn.showOverlay("Đang nén…", () => goi++);
fn.hideOverlay();
check("hideOverlay ẩn lớp phủ", els["overlay"].hidden, true);
check("… ẩn luôn nút", els["overlay-cancel"].hidden, true);
check("… và gỡ handler", els["overlay-cancel"].onclick, null);
check("hàm hủy cũ không bị gọi thêm lần nào", goi, 1);

// ---- 3. runCompress: cùng một mã việc đi tới cả hai route -------------------
const rc = APP.slice(APP.indexOf("async function runCompress()"),
                     APP.indexOf("// ---- P7: convert tools"));
check("cắt được runCompress", rc.length > 500, true);

check("sinh mã việc trước khi mở lớp phủ",
  rc.indexOf("const job = newJobId()") >= 0 &&
  rc.indexOf("const job = newJobId()") < rc.indexOf("showOverlay("), true);
check("lớp phủ của Nén có hàm hủy", /showOverlay\(\s*\n?\s*t\("Đang nén PDF[\s\S]{0,200}?async \(\) => \{/.test(rc), true);
// Hai nửa của cùng một mã. Lệch nhau thì Hủy gửi đi một mã sidecar chưa từng thấy,
// /compress-cancel trả "không tìm thấy", và lần nén chạy tiếp — im lặng hoàn toàn.
check("mã việc đi kèm /compress-bin",
  /\/compress-bin\?preset=[\s\S]{0,120}?&job=" \+ encodeURIComponent\(job\)/.test(rc), true);
check("… đúng mã ấy đi tới /compress-cancel",
  /"\/compress-cancel\?job=" \+ encodeURIComponent\(job\)/.test(rc), true);
// Không abort fetch: sidecar mới là bên biết lần nén đã dừng hẳn chưa.
check("không abort fetch phía renderer (nút phải nói thật)",
  /AbortController|\.abort\(\)/.test(rc), false);
// Hủy gửi không tới ⇒ việc VẪN chạy ⇒ phải mở lại nút, không được đóng lớp phủ.
check("gửi hủy lỗi thì mở lại nút", /btn\.disabled = false;/.test(rc), true);
check("… và nói ra bằng toast", /Không gửi được lệnh hủy/.test(rc), true);

// ---- 4. hủy KHÔNG phải lỗi --------------------------------------------------
check("renderer đọc cờ cancelled", /cancelled = data\.cancelled === true;/.test(rc), true);
check("… và đổi hẳn câu toast, không phải \"Nén lỗi\"",
  /cancelled \? t\("Đã hủy nén\."\) : "Nén lỗi: " \+ msg, cancelled \? "" : "bad"/.test(rc), true);

// ---- 5. hợp đồng bắc qua hai ngôn ngữ --------------------------------------
check("api.py có route /compress-cancel", /@app\.post\("\/compress-cancel"\)/.test(API), true);
check("… nhận tham số tên đúng là `job`", /async def compress_cancel\(job: str = ""\)/.test(API), true);
check("/compress-bin cũng nhận `job`",
  /async def compress_bin\(request: Request, preset: str = "ebook", job: str = ""\)/.test(API), true);
check("… và trả cờ `cancelled` khi bị hủy", /"cancelled": True/.test(API), true);
// Hủy nằm cùng rổ với hết giờ ở nhánh thử lại — nếu không, bấm Hủy xong máy nén thêm
// một lần `lossless` nữa (BI-122). Lưới Python đo hành vi này; ở đây chỉ ghim để
// người đọc JS thấy luôn vì sao.
check("CompressCancelled không rơi vào nhánh thử lại",
  /except \(_compress_core\.CompressTimeout, _compress_core\.CompressCancelled\):/.test(API), true);

console.log(`\ncompress-cancel: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
