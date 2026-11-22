"use strict";

// BI-137 — autosave / khôi phục sự cố ghi NGUYÊN TỬ (recovery:save/scan/read ở main.js).
//
// Trước: `autosave.pdf` bị `writeFile` cắt cụt rồi ghi lại tại chỗ ⇒ một cú sập GIỮA lúc autosave phá chính bản phục hồi cũ,
// đúng lúc cần nó; hai file (autosave.pdf, manifest.json) ghi riêng ⇒ có PDF mà thiếu manifest thì `recovery:scan` lặng lẽ bỏ qua.
//
// Cách test: CẮT NGUYÊN VĂN khối helper + bốn handler `recovery:*` ở main.js rồi chạy thật với thư mục thật. Lỗi được chèn qua một
// `AtomicWrite` bọc ngoài fs thật. "Khởi động lại sau sập" = dựng MỘT MÔI TRƯỜNG MỚI trên cùng thư mục userData (biến
// `recoveryScanDone` của main.js bắt đầu lại từ false, đúng như một lần chạy app mới).
//
// Run:  node desktop/test/recovery-atomic.test.js      (or: npm run test:recoveryatomic)

const fs = require("fs");
const os = require("os");
const path = require("path");
const RealAW = require("../src/atomic-write");
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
const within = (ms, p, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
const codeErr = (code) => Object.assign(new Error(code), { code });

const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const APP = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
const cut = (from, to) => {
  const a = MAIN.indexOf(from);
  const b = MAIN.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("không cắt được khối: " + from);
  return MAIN.slice(a, b);
};
const helperSrc = cut("const recoveryDir = ", "// ---- IPC: session restore setting");
const handlerSrc = cut('ipcMain.handle("recovery:save"', "// ---- shutdown");

// AtomicWrite thật nhưng fs bị bọc (chèn lỗi theo đường dẫn)
function awWith(over) {
  const fsx = { promises: new Proxy(fs.promises, { get: (t, k) => (over[k] ? over[k] : t[k]) }) };
  return {
    TMP_SUFFIX: RealAW.TMP_SUFFIX,
    writeFileAtomic: (fp, d, o) => RealAW.writeFileAtomic(fp, d, { fs: fsx, sleep: async () => {}, ...o }),
  };
}
function fhWrap(real, h) {
  return { writeFile: h.writeFile || ((d) => real.writeFile(d)), sync: () => real.sync(), close: () => real.close() };
}

function makeEnv(userData, AW = RealAW) {
  const handlers = {};
  const ipcMain = { handle: (n, f) => (handlers[n] = f) };
  const app = { getPath: () => userData, getVersion: () => "test" };
  const api = new Function(
    "ipcMain", "fs", "path", "app", "AtomicWrite", "asWritable",
    helperSrc + "\n" + handlerSrc + "\nreturn { hasRecoveryOrphans, recoveryDir };"
  )(ipcMain, fs, path, app, AW, asWritable);
  return { h: handlers, ...api };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nabu-recov-"));
  let n = 0;
  const fresh = () => {
    const ud = path.join(root, "ud" + ++n);
    fs.mkdirSync(ud, { recursive: true });
    return ud;
  };
  const u8 = (s) => new Uint8Array(Buffer.from(s, "latin1"));
  const slot = (ud, id) => path.join(ud, "recovery", id);
  const filesIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
  const tmpsIn = (d) => filesIn(d).filter((f) => f.endsWith(RealAW.TMP_SUFFIX));
  const SEALED = "%PDF-1.7 SEALED-NEW";
  const PLAIN = "%PDF-1.7 PLAINTEXT-SECRET-PAGE";
  const readBytes = async (env, id) => {
    const r = await env.h["recovery:read"](null, id);
    return r.ok ? { ...r, text: Buffer.from(r.bytes).toString("latin1") } : r;
  };

  // ---- 1. vòng đời cơ bản ----
  {
    const ud = fresh();
    const env = makeEnv(ud);
    let r = await env.h["recovery:save"](null, { docId: "d1", bytes: u8("%PDF-A"), name: "Hop dong.pdf", srcPath: "D:/x/hd.pdf" });
    check("1a save trả saved:true", r, { saved: true });
    r = await readBytes(env, "d1");
    check("1b read: bytes/name/srcPath đúng", [r.ok, r.text, r.name, r.srcPath], [true, "%PDF-A", "Hop dong.pdf", "D:/x/hd.pdf"]);
    const env2 = makeEnv(ud); // khởi động lại
    const list = await env2.h["recovery:scan"]();
    check("1c scan sau 'khởi động lại': đúng một bản, đủ nhãn", [list.length, list[0].docId, list[0].name, list[0].srcPath, list[0].savedAt > 0], [1, "d1", "Hop dong.pdf", "D:/x/hd.pdf", true]);
    check("1d không để rác .nabu-tmp", tmpsIn(slot(ud, "d1")), []);
    await env.h["recovery:save"](null, { docId: "d1", bytes: u8("%PDF-B-LONGER"), name: "Moi.pdf", srcPath: null });
    r = await readBytes(env, "d1");
    check("1e ghi lại: bản mới thay bản cũ, nhãn cũng mới", [r.text, r.name], ["%PDF-B-LONGER", "Moi.pdf"]);
    check("1f … và vẫn không rác", tmpsIn(slot(ud, "d1")), []);
    check("1g clear xoá cả thư mục", [await env.h["recovery:clear"](null, "d1"), fs.existsSync(slot(ud, "d1"))], [true, false]);
  }

  // ---- 2. LỖI GIỮA LÚC AUTOSAVE KHÔNG PHÁ BẢN PHỤC HỒI CŨ ----
  {
    const ud = fresh();
    const good = makeEnv(ud);
    await good.h["recovery:save"](null, { docId: "d2", bytes: u8("%PDF-OLD-GOOD"), name: "Cu.pdf" });
    const failing = makeEnv(
      ud,
      awWith({
        open: async (p, f) => {
          const fh = await fs.promises.open(p, f);
          if (!String(p).includes("autosave.pdf")) return fh;
          return fhWrap(fh, { writeFile: async (d) => { await fh.write(d, 0, d.length >> 1); throw codeErr("ENOSPC"); } });
        },
      })
    );
    const r = await failing.h["recovery:save"](null, { docId: "d2", bytes: u8("%PDF-NEW-BAD-WRITE"), name: "Moi.pdf" });
    ok("2a ghi hết ổ giữa chừng ⇒ saved:false kèm lỗi", r.saved === false && /ENOSPC/.test(String(r.error)), JSON.stringify(r));
    const rd = await readBytes(good, "d2");
    check("2b … bản phục hồi CŨ vẫn nguyên và đọc được", [rd.ok, rd.text, rd.name], [true, "%PDF-OLD-GOOD", "Cu.pdf"]);
    check("2c … không rác", tmpsIn(slot(ud, "d2")), []);
  }

  // ---- 3. TIẾN TRÌNH BỊ GIẾT giữa lúc autosave (ghi dở, không bao giờ xong) ⇒ khởi động lại vẫn khôi phục được bản CŨ ----
  {
    const ud = fresh();
    const good = makeEnv(ud);
    await good.h["recovery:save"](null, { docId: "d3", bytes: u8("%PDF-OLD-GOOD"), name: "Cu.pdf", srcPath: "D:/a.pdf" });
    let stalledFh = null;
    const stalling = makeEnv(
      ud,
      awWith({
        open: async (p, f) => {
          const fh = await fs.promises.open(p, f);
          if (!String(p).includes("autosave.pdf")) return fh;
          stalledFh = fh;
          return fhWrap(fh, { writeFile: async (d) => { await fh.write(d, 0, d.length >> 1); await new Promise(() => {}); } });
        },
      })
    );
    stalling.h["recovery:save"](null, { docId: "d3", bytes: u8("%PDF-NEW-HALF-WRITTEN-WHEN-KILLED"), name: "Moi.pdf" }); // không await: nó "chết" ở đó
    await new Promise((r) => setTimeout(r, 200));
    const restarted = makeEnv(ud); // lần chạy app kế tiếp
    const list = await restarted.h["recovery:scan"]();
    check("3a sau cú sập giữa lúc ghi: scan vẫn thấy bản", [list.length, list[0] && list[0].name, list[0] && list[0].srcPath], [1, "Cu.pdf", "D:/a.pdf"]);
    const rd = await readBytes(restarted, "d3");
    check("3b … và bản đọc ra là bản CŨ nguyên vẹn, không phải nửa bản mới", rd.text, "%PDF-OLD-GOOD");
    check("3c … file dở dang chỉ nằm ở *.nabu-tmp (không đụng bản thật)", tmpsIn(slot(ud, "d3")).length, 1);
    if (stalledFh) await stalledFh.close(); // trong sản phẩm tiến trình đã chết nên không có handle mở
    await restarted.h["recovery:clear"](null, "d3");
    check("3d dọn bản (người dùng chọn Xoá/đã khôi phục) xoá luôn cả file tạm", fs.existsSync(slot(ud, "d3")), false);
  }

  // ---- 4. HAI FILE (PDF + manifest) KHÔNG NGUYÊN TỬ VỚI NHAU — scan/read phải chịu được ----
  {
    const ud = fresh();
    const failManifest = awWith({ open: async (p, f) => { if (String(p).includes("manifest.json")) throw codeErr("EIO"); return fs.promises.open(p, f); } });
    const env = makeEnv(ud, failManifest);
    const r = await env.h["recovery:save"](null, { docId: "d4", bytes: u8("%PDF-FIRST"), name: "Ten.pdf" });
    check("4a lần lưu ĐẦU, manifest ghi lỗi ⇒ vẫn saved:true (PDF đã an toàn)", r, { saved: true });
    check("4b … thư mục có PDF, không có manifest", [filesIn(slot(ud, "d4")).includes("autosave.pdf"), filesIn(slot(ud, "d4")).includes("manifest.json")], [true, false]);
    const env2 = makeEnv(ud);
    ok("4c hasRecoveryOrphans nhất quán: có PDF ⇒ true", env2.hasRecoveryOrphans() === true);
    const list = await env2.h["recovery:scan"]();
    check("4d scan VẪN đề nghị bản này (trước BI-137 lặng lẽ bỏ qua): tên mặc định, không đường dẫn, có giờ", [list.length, list[0].name, list[0].srcPath, list[0].savedAt > 0], [1, "document.pdf", null, true]);
    const rd = await readBytes(env2, "d4");
    check("4e read đọc được bản không manifest", [rd.ok, rd.text, rd.name, rd.srcPath], [true, "%PDF-FIRST", "document.pdf", null]);
  }
  {
    // manifest hỏng / sai kiểu
    for (const [label, content] of [["JSON cụt", '{"name":"X'], ["null", "null"], ["số", "5"], ["rỗng", ""]]) {
      const ud = fresh();
      const env = makeEnv(ud);
      await env.h["recovery:save"](null, { docId: "d5", bytes: u8("%PDF-Z"), name: "Ten.pdf" });
      fs.writeFileSync(path.join(slot(ud, "d5"), "manifest.json"), content);
      const env2 = makeEnv(ud);
      const list = await env2.h["recovery:scan"]();
      const rd = await readBytes(env2, "d5");
      ok(`4f manifest ${label}: vẫn đề nghị & đọc được (nhãn mặc định)`, list.length === 1 && list[0].name === "document.pdf" && rd.ok && rd.text === "%PDF-Z", JSON.stringify(list));
    }
  }
  {
    // lần lưu SAU mà manifest lỗi: PDF mới, nhãn cũ
    const ud = fresh();
    const env = makeEnv(ud);
    await env.h["recovery:save"](null, { docId: "d6", bytes: u8("%PDF-1"), name: "Cu.pdf" });
    const env2 = makeEnv(ud, awWith({ open: async (p, f) => { if (String(p).includes("manifest.json")) throw codeErr("EIO"); return fs.promises.open(p, f); } }));
    const r = await env2.h["recovery:save"](null, { docId: "d6", bytes: u8("%PDF-2"), name: "Moi.pdf" });
    const rd = await readBytes(env, "d6");
    check("4g lần sau, manifest lỗi: saved:true, PDF là bản mới, nhãn cũ (vô hại)", [r.saved, rd.text, rd.name], [true, "%PDF-2", "Cu.pdf"]);
  }

  // ---- 5. BI-74: ẨN TRANG (scrub) — bản rõ trước khi ẩn phải biến mất, KỂ CẢ khi ghi lỗi ----
  {
    const ud = fresh();
    const env = makeEnv(ud);
    await env.h["recovery:save"](null, { docId: "d7", bytes: u8(PLAIN), name: "Hop dong.pdf", srcPath: "D:/hd.pdf" });
    // một file tạm bị sót từ một lần autosave bị giết, cũng chứa bản rõ
    fs.writeFileSync(path.join(slot(ud, "d7"), "autosave.pdf.deadbeef0000" + RealAW.TMP_SUFFIX), PLAIN + "-PARTIAL");
    const r = await env.h["recovery:save"](null, { docId: "d7", bytes: u8(SEALED), name: "Hop dong.pdf", srcPath: "D:/hd.pdf", scrub: true });
    check("5a scrub + ghi thành công ⇒ saved:true", r, { saved: true });
    const all = filesIn(slot(ud, "d7")).map((f) => fs.readFileSync(path.join(slot(ud, "d7"), f), "latin1")).join("|");
    ok("5b … KHÔNG còn byte bản rõ nào trong thư mục (kể cả file tạm sót)", !all.includes("PLAINTEXT-SECRET"), all.slice(0, 120));
    const rd = await readBytes(env, "d7");
    check("5c … bản phục hồi là bản đã niêm (SEALED), nhãn + đường dẫn còn", [rd.text, rd.name, rd.srcPath], [SEALED, "Hop dong.pdf", "D:/hd.pdf"]);
    check("5d … và không rác", tmpsIn(slot(ud, "d7")), []);
  }
  {
    const ud = fresh();
    const env = makeEnv(ud);
    await env.h["recovery:save"](null, { docId: "d8", bytes: u8(PLAIN), name: "Hop dong.pdf" });
    const failing = makeEnv(ud, awWith({ open: async () => { throw codeErr("ENOSPC"); } }));
    const r = await failing.h["recovery:save"](null, { docId: "d8", bytes: u8(SEALED), name: "Hop dong.pdf", scrub: true });
    const all = filesIn(slot(ud, "d8")).map((f) => fs.readFileSync(path.join(slot(ud, "d8"), f), "latin1")).join("|");
    ok("5e scrub mà GHI LỖI ⇒ saved:false NHƯNG bản rõ cũng đã bị xoá (khe trống, không phải khe còn bản rõ)", r.saved === false && !all.includes("PLAINTEXT-SECRET"), JSON.stringify(r) + all.slice(0, 80));
    check("5f … autosave.pdf không còn", filesIn(slot(ud, "d8")).includes("autosave.pdf"), false);
  }
  {
    // ĐỐI CHỨNG: autosave THƯỜNG (không scrub) mà ghi lỗi thì GIỮ bản cũ (đó là điểm của ghi nguyên tử)
    const ud = fresh();
    const env = makeEnv(ud);
    await env.h["recovery:save"](null, { docId: "d9", bytes: u8("%PDF-KEEP-ME"), name: "A.pdf" });
    const failing = makeEnv(ud, awWith({ open: async () => { throw codeErr("ENOSPC"); } }));
    await failing.h["recovery:save"](null, { docId: "d9", bytes: u8("%PDF-NEW"), name: "A.pdf" });
    const rd = await readBytes(env, "d9");
    check("5g đối chứng: không scrub + ghi lỗi ⇒ bản cũ còn nguyên", rd.text, "%PDF-KEEP-ME");
  }
  {
    // scrub khi chưa có thư mục / chưa có gì
    const ud = fresh();
    const env = makeEnv(ud);
    const r = await env.h["recovery:save"](null, { docId: "d10", bytes: u8(SEALED), name: "A.pdf", scrub: true });
    check("5h scrub lên khe CHƯA có: ghi bình thường", [r.saved, (await readBytes(env, "d10")).text], [true, SEALED]);
  }

  // ---- 6. dọn bản quá hạn & thư mục mồ côi ----
  {
    const ud = fresh();
    const env = makeEnv(ud);
    const DAY = 24 * 3600 * 1000;
    const mk = async (id, ageDays, withManifestTime = true) => {
      await env.h["recovery:save"](null, { docId: id, bytes: u8("%PDF-" + id), name: id + ".pdf" });
      const mf = path.join(slot(ud, id), "manifest.json");
      const j = JSON.parse(fs.readFileSync(mf, "utf8"));
      if (withManifestTime) j.savedAt = Date.now() - ageDays * DAY;
      else delete j.savedAt;
      fs.writeFileSync(mf, JSON.stringify(j));
      const t = new Date(Date.now() - ageDays * DAY);
      fs.utimesSync(path.join(slot(ud, id), "autosave.pdf"), t, t);
    };
    await mk("old", 15);
    await mk("recent", 13);
    await mk("old-nots", 15, false); // manifest không có savedAt: tuổi lấy từ mtime của PDF
    await mk("recent-nots", 1, false);
    // thư mục mồ côi: chỉ có file tạm (autosave đầu tiên bị giết) — mới & cũ
    for (const [id, age] of [["orph-new", 0], ["orph-old", 15]]) {
      const d = slot(ud, id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "autosave.pdf.cafe00000000" + RealAW.TMP_SUFFIX), "partial");
      const t = new Date(Date.now() - age * DAY);
      fs.utimesSync(d, t, t);
    }
    const env2 = makeEnv(ud);
    const list = await env2.h["recovery:scan"]();
    check("6a scan chỉ đề nghị bản còn hạn", list.map((x) => x.docId).sort(), ["recent", "recent-nots"]);
    check("6b bản quá hạn bị xoá (cả khi manifest thiếu savedAt)", [fs.existsSync(slot(ud, "old")), fs.existsSync(slot(ud, "old-nots"))], [false, false]);
    check("6c thư mục mồ côi: MỚI thì giữ (không đề nghị), CŨ thì xoá", [fs.existsSync(slot(ud, "orph-new")), fs.existsSync(slot(ud, "orph-old"))], [true, false]);
    check("6d BI-7: lần scan thứ hai trong cùng lần chạy trả rỗng", await env2.h["recovery:scan"](), []);
  }

  // ---- 7. docId độc hại không ra khỏi thư mục recovery ----
  {
    const ud = fresh();
    const env = makeEnv(ud);
    await env.h["recovery:save"](null, { docId: "../../evil", bytes: u8("%PDF-E"), name: "E.pdf" });
    check("7a docId '../../evil' chỉ tạo thư mục con của recovery", [filesIn(path.join(ud, "recovery")), fs.existsSync(path.join(ud, "..", "evil"))], [["evil"], false]);
    check("7b docId rỗng / thiếu bytes ⇒ saved:false", [await env.h["recovery:save"](null, { docId: "", bytes: u8("x") }), await env.h["recovery:save"](null, { docId: "ok" })], [{ saved: false }, { saved: false }]);
  }

  // ---- 8. GHIM CẤU TRÚC ----
  {
    const saveBlock = cut('ipcMain.handle("recovery:save"', 'ipcMain.handle("recovery:clear"');
    ok("8a recovery:save không còn writeFile thô", !/fs\.promises\.writeFile\(/.test(saveBlock));
    const pdfAt = saveBlock.indexOf('"autosave.pdf"), asWritable(bytes)');
    const mfAt = saveBlock.indexOf('"manifest.json"');
    ok("8b hai lần ghi đều qua AtomicWrite.writeFileAtomic, PDF TRƯỚC manifest", pdfAt > 0 && mfAt > pdfAt && (saveBlock.match(/AtomicWrite\.writeFileAtomic\(/g) || []).length === 2);
    const scrubAt = saveBlock.indexOf("if (scrub) await scrubRecoverySlot(dir);");
    ok("8c scrub chạy TRƯỚC lệnh ghi", scrubAt > 0 && scrubAt < pdfAt);
    ok("8d scrubRecoverySlot xoá autosave.pdf và *.nabu-tmp (không đụng manifest)", /f !== "autosave\.pdf" && !f\.endsWith\(AtomicWrite\.TMP_SUFFIX\)\) continue;/.test(helperSrc));
    const scrubFn = APP.slice(APP.indexOf("async function scrubRecoverySnapshot()"), APP.indexOf("// Bring hidden pages back."));
    ok("8e renderer: scrubRecoverySnapshot gửi scrub:true", /scrub: true/.test(scrubFn));
    ok("8f renderer: gửi srcPath (không phải path — main đọc srcPath)", /srcPath: state\.path/.test(scrubFn) && !/\n\s+path: state\.path/.test(scrubFn));
    ok("8g renderer: autosaveTick KHÔNG scrub (bản cũ phải được giữ nếu ghi lỗi)", !/scrub/.test(APP.slice(APP.indexOf("async function autosaveTick()"), APP.indexOf("if (window.desktop.recovery) setInterval(autosaveTick"))));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "OK" : "FAIL"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
