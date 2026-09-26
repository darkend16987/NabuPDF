"use strict";

/*
 * Grid for the saved-signature feature (v0.2.72):
 *   §1–§5  src/signatures.js — the encrypted store, run against an in-memory fs and a
 *          fake "DPAPI" whose blobs only the SAME fake account can open, so the rules
 *          that matter (refuse plaintext, never overwrite an unreadable store, validate
 *          everything on the way in) are EXECUTED, not grepped.
 *   §6     renderer/sig-image.js — white-background removal + transparent-border trim,
 *          on synthetic RGBA buffers.
 *   §7     wiring — main registers the IPC, preload exposes it, index.html loads the
 *          renderer modules in an order that works.
 *
 *   node test/signatures.test.js      (npm run test:sig)
 */

const fs = require("fs");
const path = require("path");
const Sig = require("../src/signatures.js");

let pass = 0;
let fail = 0;
function group(name) {
  console.log("\n— " + name);
}
function check(what, ok, extra) {
  if (ok) {
    pass++;
    console.log("  ok   " + what);
  } else {
    fail++;
    console.log("  FAIL " + what + (extra === undefined ? "" : "  → " + extra));
  }
}

// ---- fakes ---------------------------------------------------------------

function memFs() {
  const files = new Map();
  let failWrites = false;
  return {
    files,
    set failWrites(v) {
      failWrites = v;
    },
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT " + p);
      return files.get(p);
    },
    writeFileSync: (p, b) => {
      if (failWrites) throw new Error("EACCES");
      files.set(p, Buffer.from(b));
    },
    renameSync: (a, b) => {
      if (!files.has(a)) throw new Error("ENOENT " + a);
      files.set(b, files.get(a));
      files.delete(a);
    },
    mkdirSync: () => {},
  };
}

// "DPAPI" for one account: XOR + an account tag. Another account's crypto (different
// tag) cannot decrypt, exactly the property the user asked for.
function fakeCrypto(account, available = true) {
  const key = Buffer.from(account);
  return {
    available: () => available,
    encrypt: (str) => {
      const b = Buffer.from(str, "utf8");
      const out = Buffer.alloc(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b[i] ^ key[i % key.length];
      return Buffer.concat([Buffer.from("ACCT:" + account + ":"), out]);
    },
    decrypt: (buf) => {
      const head = "ACCT:" + account + ":";
      if (buf.slice(0, head.length).toString() !== head) throw new Error("DPAPI: wrong account");
      const b = buf.slice(head.length);
      const out = Buffer.alloc(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b[i] ^ key[i % key.length];
      return out.toString("utf8");
    },
  };
}

// A real 1×1 PNG.
const PNG_1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DATA_URL = "data:image/png;base64," + PNG_1;
const FILE = "C:/u/AppData/Roaming/nabu/signatures.bin";

let idn = 0;
function mk(opts = {}) {
  const f = opts.fs || memFs();
  const store = Sig.createStore({
    file: FILE,
    fs: f,
    crypto: opts.crypto || fakeCrypto("alice"),
    checkPng: opts.checkPng || (() => ({ ok: true, w: 1, h: 1 })),
    now: () => 1000 + idn,
    newId: () => "id" + ++idn,
  });
  return { store, fs: f };
}

// ---- 1. round trip ---------------------------------------------------------

group("1. add → list → survives a restart, encrypted on disk");

let { store, fs: disk } = mk();
let r = store.add({ name: "  Nguyễn Văn A \n", dataUrl: DATA_URL, wPt: 150 });
check("add returns ok + id", r.ok === true && typeof r.id === "string", JSON.stringify(r));
let L = store.list();
check("list has it", L.items.length === 1 && L.items[0].name === "Nguyễn Văn A");
check("list returns a PNG data URL", L.items[0].dataUrl === DATA_URL);
check("list reports the width", L.items[0].wPt === 150);
check("encryption flag reported", L.encryption === true && L.unreadable === false);
const blob = disk.files.get(FILE);
check("file exists", !!blob);
check("file does NOT contain the PNG in the clear", !blob.toString("latin1").includes(PNG_1.slice(0, 20)));
check("file does NOT contain the name in the clear", !blob.toString("utf8").includes("Nguyễn"));
check("no .tmp left behind", ![...disk.files.keys()].some((k) => k.endsWith(".tmp")));

// "restart": a fresh store over the same disk
let s2 = Sig.createStore({ file: FILE, fs: disk, crypto: fakeCrypto("alice"), checkPng: () => ({ ok: true }) });
L = s2.list();
check("a restart reads it back", L.items.length === 1 && L.items[0].name === "Nguyễn Văn A" && L.items[0].wPt === 150);

// ---- 2. rule 1: no encryption → refuse, never plaintext ----------------------

group("2. encryption unavailable ⇒ refuse to save");

({ store, fs: disk } = mk({ crypto: fakeCrypto("alice", false) }));
r = store.add({ name: "X", dataUrl: DATA_URL });
check("add refused with no-encryption", r.ok === false && r.reason === "no-encryption", JSON.stringify(r));
check("nothing written", disk.files.size === 0);
check("memory not changed by the refused add", store.list().items.length === 0);
check("list still works and says encryption is off", store.list().ok === true && store.list().encryption === false);

// ---- 3. rule 2: unreadable store is never overwritten ------------------------

group("3. another account's file / garbage ⇒ unreadable, untouched, reset moves it aside");

({ store, fs: disk } = mk());
store.add({ name: "A", dataUrl: DATA_URL });
const aliceBlob = Buffer.from(disk.files.get(FILE));
// Bob opens Alice's file (copied to his profile)
let bob = Sig.createStore({ file: FILE, fs: disk, crypto: fakeCrypto("bob"), checkPng: () => ({ ok: true }) });
L = bob.list();
check("wrong account ⇒ unreadable, empty list", L.unreadable === true && L.items.length === 0);
r = bob.add({ name: "B", dataUrl: DATA_URL });
check("…and adding is refused", r.ok === false && r.reason === "unreadable");
check("…and the file is byte-identical", Buffer.compare(disk.files.get(FILE), aliceBlob) === 0);
check("remove/rename refused too", bob.remove("id1").ok === false && bob.rename("id1", "z").ok === false);
r = bob.reset();
check("reset ok", r.ok === true);
check("reset kept the old file ASIDE (not deleted)", [...disk.files.keys()].some((k) => k.startsWith(FILE + ".unreadable-")));
check("reset: Alice's bytes are intact in the aside copy", [...disk.files.entries()].some(([k, v]) => k.startsWith(FILE + ".unreadable-") && Buffer.compare(v, aliceBlob) === 0));
r = bob.add({ name: "B", dataUrl: DATA_URL });
check("after reset, adding works", r.ok === true && bob.list().items.length === 1);

({ store, fs: disk } = mk());
disk.files.set(FILE, Buffer.from("not a blob at all"));
check("garbage file ⇒ unreadable", store.list().unreadable === true);

// ---- 4. validation on the way in ---------------------------------------------

group("4. validation — IPC input and on-disk items");

({ store } = mk());
check("a JPEG data URL is refused", store.add({ name: "x", dataUrl: "data:image/jpeg;base64,/9j/4AAQ" }).reason === "not-png");
check("non-base64 junk is refused", store.add({ name: "x", dataUrl: "data:image/png;base64,<script>" }).reason === "not-png");
check("a non-string is refused", store.add({ name: "x", dataUrl: 42 }).reason === "not-png");
check("PNG magic but decoder says no ⇒ refused", mk({ checkPng: () => ({ ok: false }) }).store.add({ dataUrl: DATA_URL }).reason === "not-png");
const big = Buffer.concat([Buffer.from(PNG_1, "base64"), Buffer.alloc(Sig.MAX_PNG_BYTES)]);
check("over MAX_PNG_BYTES ⇒ too-big", store.add({ dataUrl: "data:image/png;base64," + big.toString("base64") }).reason === "too-big");
r = store.add({ name: "x".repeat(500) + "\u0007", dataUrl: DATA_URL });
check("long name is cut to MAX_NAME, control chars dropped", r.ok && store.list().items[0].name.length === Sig.MAX_NAME && !/\u0007/.test(store.list().items[0].name));
r = store.add({ name: "   ", dataUrl: DATA_URL });
check("blank name gets a default", r.ok && /^Chữ ký \d+$/.test(store.list().items[1].name), store.list().items[1] && store.list().items[1].name);
check("width is clamped", Sig.clampW(1) === Sig.W_MIN && Sig.clampW(99999) === Sig.W_MAX && Sig.clampW("abc") === Sig.DEFAULT_W);
check("missing width = default", store.list().items[1].wPt === Sig.DEFAULT_W);

({ store } = mk());
for (let k = 0; k < Sig.MAX_ITEMS; k++) store.add({ name: "s" + k, dataUrl: DATA_URL });
r = store.add({ name: "one too many", dataUrl: DATA_URL });
check("MAX_ITEMS is enforced", r.ok === false && r.reason === "full" && store.list().items.length === Sig.MAX_ITEMS);

// A hand-edited file with junk items: the good ones load, the bad ones are skipped.
({ store, fs: disk } = mk());
disk.files.set(
  FILE,
  fakeCrypto("alice").encrypt(
    JSON.stringify({
      v: 1,
      items: [
        { id: "ok1", name: "Good", png: PNG_1, wPt: 100 },
        { id: "bad id!", name: "x", png: PNG_1 },
        { id: "nopng", name: "x", png: "AAAA" },
        { id: "ok1", name: "dup", png: PNG_1 },
        null,
      ],
    })
  )
);
L = store.list();
check("hand-edited file: only the valid, unique item loads", L.items.length === 1 && L.items[0].id === "ok1" && L.unreadable === false);

// ---- 5. rename / remove / setWidth / failed writes ---------------------------

group("5. rename / remove / setWidth, and a failed write leaves memory = disk");

({ store, fs: disk } = mk());
const a = store.add({ name: "A", dataUrl: DATA_URL }).id;
const b = store.add({ name: "B", dataUrl: DATA_URL }).id;
check("rename", store.rename(a, "Giám đốc").ok && store.list().items[0].name === "Giám đốc");
check("rename to blank refused", store.rename(a, "  ").reason === "empty-name");
check("rename unknown id", store.rename("nope", "x").reason === "not-found");
check("setWidth persists", store.setWidth(b, 88).ok && store.list().items[1].wPt === 88);
const before = Buffer.from(disk.files.get(FILE));
check("setWidth to the same value does not rewrite", store.setWidth(b, 88).unchanged === true && Buffer.compare(before, disk.files.get(FILE)) === 0);
check("remove", store.remove(a).ok && store.list().items.length === 1 && store.list().items[0].id === b);
check("remove unknown", store.remove("nope").reason === "not-found");
disk.failWrites = true;
r = store.rename(b, "Changed");
check("a failed write reports write-failed", r.ok === false && r.reason === "write-failed");
check("…and memory was rolled back (still the old name)", store.list().items[0].name === "B");
disk.failWrites = false;

// ---- 6. sig-image.js -------------------------------------------------------

group("6. sig-image.js — white background removal + trim");

const SI = require("../renderer/sig-image.js");
function canvas(w, h, fill) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set(fill, i * 4);
  return d;
}
function px(d, w, x, y) {
  const i = (y * w + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}
// 20×10 white paper with a dark-blue ink stroke at x 5..9, y 3..5 and a grey anti-alias edge at x=10
let W = 20,
  H = 10;
let d = canvas(W, H, [255, 255, 255, 255]);
for (let y = 3; y <= 5; y++) {
  for (let x = 5; x <= 9; x++) d.set([20, 30, 120, 255], (y * W + x) * 4);
  d.set([200, 200, 205, 255], (y * W + 10) * 4);
}
check("hasTransparency: opaque scan = false", SI.hasTransparency(d) === false);
const out = SI.removeWhiteBg(new Uint8ClampedArray(d), W, H, 50);
check("paper becomes fully transparent", px(out, W, 0, 0)[3] === 0 && px(out, W, 19, 9)[3] === 0);
check("ink stays fully opaque, same colour", JSON.stringify(px(out, W, 7, 4)) === JSON.stringify([20, 30, 120, 255]));
const edge = px(out, W, 10, 4)[3];
check("anti-aliased edge becomes PARTLY transparent (no jaggies)", edge > 0 && edge < 255, edge);
check("hasTransparency after removal = true", SI.hasTransparency(out) === true);
const lo = SI.removeWhiteBg(new Uint8ClampedArray(d), W, H, 0);
const hi = SI.removeWhiteBg(new Uint8ClampedArray(d), W, H, 100);
check("higher level removes MORE of the grey edge", px(hi, W, 10, 4)[3] <= px(lo, W, 10, 4)[3], `${px(lo, W, 10, 4)[3]} → ${px(hi, W, 10, 4)[3]}`);
check("even the strongest level keeps real ink", px(hi, W, 7, 4)[3] === 255);
check("even the weakest level clears pure white", px(lo, W, 0, 0)[3] === 0);

const t = SI.trimBounds(out, W, H, 2);
check("trim hugs the ink (+2px pad)", t && t.x === 3 && t.y === 1 && t.w === 10 && t.h === 7, JSON.stringify(t));
check("trim of an all-transparent image = null", SI.trimBounds(canvas(4, 4, [0, 0, 0, 0]), 4, 4, 2) === null);
check("trim pad is clamped to the image", JSON.stringify(SI.trimBounds(canvas(3, 3, [0, 0, 0, 255]), 3, 3, 5)) === JSON.stringify({ x: 0, y: 0, w: 3, h: 3 }));
check("fitScale leaves small images alone", SI.fitScale(800, 300, 1600) === 1);
check("fitScale caps the long side", Math.abs(SI.fitScale(4000, 1000, 1600) - 0.4) < 1e-9);

// ---- 7. wiring --------------------------------------------------------------

group("7. wiring — main, preload, index.html");

const ROOT = path.join(__dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
for (const ch of ["sig:list", "sig:add", "sig:rename", "sig:remove", "sig:set-width", "sig:reset"]) {
  check(`main registers ${ch}`, MAIN.includes(`ipcMain.handle("${ch}"`));
}
check("main encrypts with safeStorage (DPAPI), not a home-made cipher", /safeStorage\.encryptString/.test(MAIN) && /safeStorage\.decryptString/.test(MAIN));
check("main validates PNGs with a real decode", /nativeImage\.createFromBuffer\(buf\)/.test(MAIN.slice(MAIN.indexOf("createStore("))));
check("main broadcasts sig:changed", /send\("sig:changed"/.test(MAIN));
check("preload exposes window.desktop.signatures", /signatures:\s*\{/.test(PRELOAD));
check("preload onChanged returns an unsubscribe", /removeListener\("sig:changed"/.test(PRELOAD));
const at = (f) => HTML.indexOf(`src="${f}"`);
check("index.html loads sig-image.js", at("sig-image.js") > 0);
check("index.html loads signatures.js", at("signatures.js") > 0);
check("signatures.js loads AFTER editor.js and capture.js (it calls into both)", at("signatures.js") > at("editor.js") && at("signatures.js") > at("capture.js"));
check("sig-image.js loads BEFORE signatures.js", at("sig-image.js") < at("signatures.js"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
