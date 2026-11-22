"use strict";

// BI-142 — đóng cửa sổ phải XOÁ XONG khe phục hồi rồi mới báo main cho đóng.
//
// LỖI ĐÃ BẮT ĐƯỢC (bởi e2e `close-guard`, ma trận §5 hàng 28). `finishClose()` từng gửi `recovery.clear(...)` rồi gọi NGAY
// `forceCloseWindow()` mà không chờ. Cửa sổ cuối đóng ⇒ app thoát trước khi `fs.promises.rm` ở main kịp chạy ⇒ khe phục hồi CÒN
// trên đĩa (đo 18/18 lần: "Không lưu" không đường dẫn, "Không lưu" có đường dẫn, và cả "Lưu") ⇒ lần mở sau app đề nghị "khôi phục"
// một tài liệu đã bỏ hoặc đã lưu. Lưới này giữ thứ tự đó trong `npm test` (không cần giao diện): nó CẮT nguyên văn `finishClose`
// khỏi app.js đang ship rồi chạy với đồ giả có độ trễ — hành vi thật, không phải regex.
//
// Chạy:  node desktop/test/close-clears-recovery.test.js

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

const APP = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const i = APP.search(/(async\s+)?function finishClose\(\)/);
const j = APP.indexOf("if (window.desktop.onCloseRequest)", i);
check("cắt được finishClose ra khỏi app.js", i >= 0 && j > i, true);
const SRC = APP.slice(i, j);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(env) {
  return new Function("state", "window", SRC + "\nreturn finishClose;")(env.state, env.window);
}

(async () => {
  // (a) lệnh xoá CHẬM (như fs.promises.rm thật): forceCloseWindow chỉ được gọi SAU khi xoá xong.
  {
    const log = [];
    const env = {
      state: { docId: "doc-1" },
      window: {
        desktop: {
          recovery: {
            clear: async (id) => {
              log.push("clear:start:" + id);
              await sleep(80); // việc xoá thật mất thời gian
              log.push("clear:done");
              return true;
            },
          },
          forceCloseWindow: () => {
            log.push("forceClose");
            return Promise.resolve(true);
          },
        },
      },
    };
    await load(env)();
    check("xoá khe TRƯỚC khi đóng: clear bắt đầu → xong → rồi mới forceClose", log, ["clear:start:doc-1", "clear:done", "forceClose"]);
  }

  // (b) xoá LỖI vẫn không chặn việc đóng (thà để lại một khe còn hơn kẹt người dùng).
  {
    const log = [];
    const env = {
      state: { docId: "doc-2" },
      window: {
        desktop: {
          recovery: { clear: async () => { throw new Error("EBUSY"); } },
          forceCloseWindow: () => { log.push("forceClose"); return Promise.resolve(true); },
        },
      },
    };
    let threw = false;
    try {
      await load(env)();
    } catch (_) {
      threw = true;
    }
    check("xoá ném lỗi ⇒ finishClose KHÔNG ném", threw, false);
    check("… và vẫn gọi forceClose", log, ["forceClose"]);
  }

  // (c) không có docId / không có recovery: vẫn đóng, không gọi clear.
  {
    const log = [];
    const env = {
      state: { docId: null },
      window: { desktop: { recovery: { clear: async () => { log.push("clear"); } }, forceCloseWindow: () => { log.push("forceClose"); } } },
    };
    await load(env)();
    check("không có docId ⇒ không gọi clear, vẫn đóng", log, ["forceClose"]);

    const log2 = [];
    const env2 = { state: { docId: "x" }, window: { desktop: { forceCloseWindow: () => { log2.push("forceClose"); } } } };
    await load(env2)();
    check("không có recovery API ⇒ vẫn đóng", log2, ["forceClose"]);
  }

  // (d) cả hai chỗ gọi trong handler đều `await` finishClose (để bất kỳ việc gì chạy sau đó cũng thấy khe đã xoá).
  const handler = APP.slice(APP.indexOf("window.desktop.onCloseRequest(async"), APP.indexOf("setTimeout(checkRecovery", i));
  const calls = [...handler.matchAll(/finishClose\(\)/g)];
  check("handler gọi finishClose đúng 2 chỗ (sạch / đã quyết định)", calls.length, 2);
  check("… cả hai đều có `await`", [...handler.matchAll(/await\s+finishClose\(\)/g)].length, 2);

  console.log(`\nclose-clears-recovery: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
