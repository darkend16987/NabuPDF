"use strict";

// ---------------------------------------------------------------------------
// Main-process user preferences (userData/prefs.json).
//
// WHY NOT localStorage: everything in here is a decision main has to make
// *before* it can ask a renderer — where to put a file handed over by Explorer
// ("Open with"), for instance, is decided while no document window may exist at
// all. Same reason session.js keeps its `restore` flag on disk.
//
// WHY NOT session.json: that file's value is its narrow scope — it records paths
// and nothing else, so a bug in it can never cost a document (see its header).
// A general settings bag does not belong in it.
//
// Shape:  { v: 1, openIn: "tab" | "window", lastDirs: { <bucket>: <abs dir> } }
//
// Every value is validated on the way IN (from disk, which a human may have
// edited, and from IPC, which is renderer-supplied) and falls back to the
// default rather than propagating junk into window routing.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const VERSION = 1;

// Where a file opened while a document window already exists should land.
//   "tab"    — a new tab in the window that asked (the behaviour before this
//              setting existed, and the default)
//   "window" — a new window, leaving the current one untouched
const OPEN_IN = ["tab", "window"];

// Where each file dialog last left the user. Electron 43 stopped letting the OS
// remember this (an omitted `defaultPath` now means "Downloads", every time), so
// the app has to hold it instead — see openDefault()/saveDefault() in main.js.
//
// One bucket per dialog, not one global: saving an export to Downloads must not
// move where "Mở PDF" starts next time. Unknown keys are refused rather than
// stored, so a hand-edited prefs.json cannot grow junk here.
const DIR_KEYS = ["open-pdf", "save-pdf", "open-files", "save-file"];

const DEFAULTS = Object.freeze({ openIn: "tab" });

let file = null;
let values = { ...DEFAULTS, lastDirs: {} };

function configure(d) {
  file = d && d.file;
  // lastDirs is spread in fresh each time: DEFAULTS is frozen but a nested
  // object inside it would not be, and sharing that reference would let a write
  // here leak into the defaults for the rest of the process.
  values = { ...DEFAULTS, lastDirs: {}, ...readFile() };
}

function readFile() {
  try {
    // Strip a UTF-8 BOM: JSON.parse rejects it, and anything that hand-edits this
    // file on Windows (PowerShell's Set-Content, Notepad) will leave one behind.
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (!raw || raw.v !== VERSION) return null;
    const out = {};
    if (OPEN_IN.includes(raw.openIn)) out.openIn = raw.openIn;
    if (raw.lastDirs && typeof raw.lastDirs === "object") {
      const dirs = {};
      for (const k of DIR_KEYS) {
        const v = raw.lastDirs[k];
        if (typeof v === "string" && v && path.isAbsolute(v)) dirs[k] = v;
      }
      out.lastDirs = dirs;
    }
    return out;
  } catch (_) {
    return null; // missing or corrupt — start from defaults, never throw at launch
  }
}

function write() {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    const out = { v: VERSION, ...values };
    // Don't write an empty lastDirs. On read it is indistinguishable from absent,
    // and leaving it out keeps prefs.json byte-identical for anyone who has never
    // used a file dialog — so upgrading the app doesn't rewrite their settings
    // file just to add `{}`.
    if (!out.lastDirs || !Object.keys(out.lastDirs).length) delete out.lastDirs;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, file); // atomic-ish: never leave a half-written file
    return true;
  } catch (_) {
    return false; // a preference that failed to persist is not worth crashing over
  }
}

function getOpenIn() {
  return values.openIn;
}

// Returns the value actually stored, so the caller (and the renderer's select)
// can settle on it rather than assuming the write took the requested value.
function setOpenIn(v) {
  values.openIn = OPEN_IN.includes(v) ? v : DEFAULTS.openIn;
  write();
  return values.openIn;
}

// The directory a given dialog last used, or null. Never throws on an unknown
// bucket — callers get "no memory" and the dialog falls back to the OS default.
function getLastDir(key) {
  if (!DIR_KEYS.includes(key)) return null;
  const v = values.lastDirs && values.lastDirs[key];
  return typeof v === "string" && v ? v : null;
}

// Remember an ABSOLUTE directory for a bucket. Relative paths and unknown
// buckets are dropped rather than stored: this value is fed straight back to a
// native dialog, so it must never carry anything the caller didn't validate.
function setLastDir(key, dir) {
  if (!DIR_KEYS.includes(key)) return null;
  if (typeof dir !== "string" || !dir || !path.isAbsolute(dir)) return getLastDir(key);
  if (values.lastDirs[key] === dir) return dir; // unchanged — don't rewrite the file
  values.lastDirs = { ...values.lastDirs, [key]: dir };
  write();
  return dir;
}

module.exports = { configure, getOpenIn, setOpenIn, getLastDir, setLastDir, OPEN_IN, DIR_KEYS, DEFAULTS };
