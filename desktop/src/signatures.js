"use strict";

// ---------------------------------------------------------------------------
// Chữ ký lưu sẵn — the saved-signature store (main process, v0.2.72).
//
// WHAT IT HOLDS. A handful of PNG signatures (and stamps) the user set up once,
// so placing one on a contract is "right-click → Chèn chữ ký: <tên>" instead of
// hunting for the file every time. Each item: { id, name, png, wPt, at } where
// `png` is base64 (no `data:` prefix) and `wPt` is the width it was last placed
// at, so it comes out the size the user is used to.
//
// ENCRYPTED AT REST, BY THE USER'S CHOICE. The whole store is ONE file,
// `userData/signatures.bin`, holding `safeStorage.encryptString(JSON)` — on
// Windows that is DPAPI, bound to the Windows account: the file copied to
// another machine or another account does not open. One file rather than a
// folder of PNGs so there is exactly one unit to keep consistent (no orphan
// images, no index that disagrees with the files), written tmp + rename.
//
// THE THREE RULES THIS FILE IS BUILT AROUND
//  1. Encryption unavailable ⇒ REFUSE to save. The user asked for encrypted
//     storage; silently writing plaintext instead would be the one outcome
//     they explicitly ruled out.
//  2. A store we cannot read is never overwritten (page-vault.js §4: "couldn't
//     read it, so removed it" must not happen). Writes are refused until the
//     user chooses `reset()`, which moves the unreadable file ASIDE, never
//     deletes it.
//  3. Everything is validated on the way IN — from disk (a human or another
//     tool may have touched it) and from IPC (renderer-supplied): real PNG
//     bytes, bounded size, bounded count, bounded name.
//
// WHY A FACTORY WITH INJECTED fs / crypto / png check: same reason as
// shell-combine.js — no Electron in here, so `npm run test:sig` can require()
// it and run the rules above for real, including the unreadable-file path.
// ---------------------------------------------------------------------------

const VERSION = 1;
const MAX_ITEMS = 24;
const MAX_PNG_BYTES = 4 * 1024 * 1024; // after the renderer's trim/downscale a signature is ~20–400 KB
const MAX_NAME = 60;
const W_MIN = 12; // pt — below this nobody can see it
const W_MAX = 1200; // pt — wider than an A1 sheet's short side is not a signature
const DEFAULT_W = 140; // pt (~4.9 cm): a handwritten signature on an A4 contract

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf) {
  if (!buf || buf.length < 8) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_MAGIC[i]) return false;
  return true;
}

function cleanName(v) {
  const s = String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, MAX_NAME);
}

function clampW(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_W;
  return Math.max(W_MIN, Math.min(W_MAX, Math.round(n * 10) / 10));
}

// base64 of a data URL or of raw base64 → Buffer, or null.
function pngBytesFrom(input) {
  if (typeof input !== "string" || !input) return null;
  const m = /^data:image\/png;base64,/i.exec(input);
  const b64 = m ? input.slice(m[0].length) : input;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  try {
    return Buffer.from(b64, "base64");
  } catch (_) {
    return null;
  }
}

/**
 * createStore({ file, fs, crypto, checkPng, now, newId })
 *   file      absolute path of signatures.bin
 *   fs        { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync }
 *   crypto    { available(): bool, encrypt(str): Buffer, decrypt(Buffer): str }
 *   checkPng  (Buffer) → { ok, w, h } — the real decode (nativeImage in main)
 *   now       () → ms timestamp          newId  () → unique string id
 */
function createStore(d) {
  const { file, fs, crypto, checkPng } = d;
  const now = d.now || (() => Date.now());
  const newId = d.newId || (() => now().toString(36) + Math.random().toString(36).slice(2, 8));
  const pathMod = require("path");

  let items = [];
  let unreadable = false; // rule 2
  let loaded = false;

  function validItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : null;
    const buf = pngBytesFrom(raw.png);
    if (!id || !buf || !isPng(buf) || buf.length > MAX_PNG_BYTES) return null;
    return {
      id,
      name: cleanName(raw.name) || "Chữ ký",
      png: buf.toString("base64"),
      wPt: clampW(raw.wPt),
      at: Number.isFinite(raw.at) ? raw.at : 0,
    };
  }

  function load() {
    if (loaded) return;
    loaded = true;
    items = [];
    unreadable = false;
    if (!fs.existsSync(file)) return; // first run — an empty, READABLE store
    try {
      const json = crypto.decrypt(fs.readFileSync(file));
      const raw = JSON.parse(json);
      if (!raw || raw.v !== VERSION || !Array.isArray(raw.items)) throw new Error("shape");
      const seen = new Set();
      for (const r of raw.items) {
        const it = validItem(r);
        if (it && !seen.has(it.id) && items.length < MAX_ITEMS) {
          seen.add(it.id);
          items.push(it);
        }
      }
    } catch (_) {
      // Another account's DPAPI blob, a truncated write, a hand-edited file… Keep it
      // on disk untouched and refuse writes until the user resets (rule 2).
      items = [];
      unreadable = true;
    }
  }

  function persist() {
    if (!crypto.available()) return { ok: false, reason: "no-encryption" }; // rule 1
    if (unreadable) return { ok: false, reason: "unreadable" }; // rule 2
    try {
      fs.mkdirSync(pathMod.dirname(file), { recursive: true });
      const blob = crypto.encrypt(JSON.stringify({ v: VERSION, items }));
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, blob);
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "write-failed", detail: String((err && err.message) || err) };
    }
  }

  // Run a mutation against a COPY and keep it only if the write succeeded — so a
  // refused or failed write never leaves memory disagreeing with the disk.
  function mutate(fn) {
    load();
    const before = items;
    items = items.map((x) => ({ ...x }));
    const res = fn();
    if (res && res.ok === false) {
      items = before;
      return res;
    }
    const w = persist();
    if (!w.ok) {
      items = before;
      return w;
    }
    return res || { ok: true };
  }

  function list() {
    load();
    return {
      ok: true,
      unreadable,
      encryption: !!crypto.available(),
      max: MAX_ITEMS,
      items: items.map((x) => ({ id: x.id, name: x.name, dataUrl: "data:image/png;base64," + x.png, wPt: x.wPt })),
    };
  }

  function add(payload) {
    const p = payload || {};
    const buf = pngBytesFrom(p.dataUrl);
    if (!buf || !isPng(buf)) return { ok: false, reason: "not-png" };
    if (buf.length > MAX_PNG_BYTES) return { ok: false, reason: "too-big" };
    const chk = checkPng ? checkPng(buf) : { ok: true };
    if (!chk || !chk.ok) return { ok: false, reason: "not-png" };
    return mutate(() => {
      if (items.length >= MAX_ITEMS) return { ok: false, reason: "full" };
      const id = newId();
      items.push({
        id,
        name: cleanName(p.name) || "Chữ ký " + (items.length + 1),
        png: buf.toString("base64"),
        wPt: clampW(p.wPt),
        at: now(),
      });
      return { ok: true, id };
    });
  }

  function rename(id, name) {
    const n = cleanName(name);
    if (!n) return { ok: false, reason: "empty-name" };
    return mutate(() => {
      const it = items.find((x) => x.id === id);
      if (!it) return { ok: false, reason: "not-found" };
      it.name = n;
      return { ok: true };
    });
  }

  function remove(id) {
    return mutate(() => {
      const k = items.findIndex((x) => x.id === id);
      if (k < 0) return { ok: false, reason: "not-found" };
      items.splice(k, 1);
      return { ok: true };
    });
  }

  function setWidth(id, wPt) {
    load();
    const it = items.find((x) => x.id === id);
    if (!it) return { ok: false, reason: "not-found" };
    if (Math.abs(it.wPt - clampW(wPt)) < 0.05) return { ok: true, unchanged: true }; // don't rewrite for nothing
    return mutate(() => {
      items.find((x) => x.id === id).wPt = clampW(wPt);
      return { ok: true };
    });
  }

  // Rule 2's way out: move the unreadable file ASIDE (never delete) and start empty.
  function reset() {
    load();
    if (!unreadable) return { ok: true, unchanged: true };
    try {
      if (fs.existsSync(file)) fs.renameSync(file, file + ".unreadable-" + now());
    } catch (err) {
      return { ok: false, reason: "write-failed", detail: String((err && err.message) || err) };
    }
    items = [];
    unreadable = false;
    return { ok: true };
  }

  return { list, add, rename, remove, setWidth, reset };
}

module.exports = {
  createStore,
  isPng,
  cleanName,
  clampW,
  pngBytesFrom,
  VERSION,
  MAX_ITEMS,
  MAX_PNG_BYTES,
  MAX_NAME,
  DEFAULT_W,
  W_MIN,
  W_MAX,
};
