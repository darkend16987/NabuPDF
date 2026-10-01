"use strict";

// Ratchet on every place the renderer replaces the canonical document (`state.bytes = …`).
//
// WHY. `state.bytes` is the document. There is no single `commitBytes()`; each writer is
// expected to follow a convention that nothing enforces (REGRESSION-GUARD BI-3):
// `pushUndo()` goes in BEFORE the bytes move — it snapshots the old bytes, bumps the
// dirty flag (so the close guard asks to save) and schedules the crash-recovery
// snapshot. A writer that forgets it fails silently and late: Ctrl+Z does nothing, or
// the window closes with no "unsaved changes" prompt and the work is gone. No other
// suite can see this — none of them runs app.js.
//
// WHAT THIS PINS.
//   1. The set of writers is exactly WRITERS below (file:function → how many writes).
//      A NEW writer fails the test with the rule to follow; a REMOVED one fails too, so
//      the list cannot rot into folklore.
//   2. Every writer marked "undoable" calls pushUndo() earlier in the same function —
//      this part is a real check of BI-3, not a head count.
//   3. The few "exempt" writers each carry the reason they must NOT (or need not) push
//      an undo step.
//   4. The state object is not written by a side door (Object.assign / state["bytes"]).
//
// It does NOT migrate the existing writers to a helper — that is a behaviour change on
// the user's data path and gets its own commit + browser probe. This only stops the
// count from growing by accident.
//
// Static text scan; the enclosing function is "the nearest preceding `function` line",
// so a write inside a nested helper is attributed to that helper. Fine for today's
// sites; if a refactor moves one, the failure names it and the list is updated by hand.
//
// Run:  node desktop/test/state-bytes-writers.test.js      (or: npm test -- state-bytes)

const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");

// key: "<file>:<function>" → { n: how many writes, mode, why }
const WRITERS = {
  // ---- exempt: replace/restore the whole timeline, so no undo step by design ----------
  "app.js:restoreSnapshot": {
    n: 1,
    mode: "exempt",
    why: "this IS undo/redo: it puts a stored snapshot back. Pushing here would corrupt the stack.",
  },
  "app.js:loadBytes": {
    n: 2,
    mode: "exempt",
    why: "opens/replaces the whole document (and the decrypt path); history is reset, there is no 'before' to undo to.",
  },
  "app.js:hidePagesWithPassword": {
    n: 1,
    mode: "exempt",
    why: "SECURITY: pushUndo() would keep the plaintext of the page just hidden in memory and in the crash-recovery folder. History is dropped on purpose and the recovery slot rewritten (see the comment above the function).",
  },
  // ---- undoable: must pushUndo() before the bytes move (BI-3) -------------------------
  "app.js:reorderPage": { n: 1, mode: "undoable" },
  "app.js:rotateSelected": { n: 1, mode: "undoable" },
  "app.js:deletePages": { n: 1, mode: "undoable" },
  "app.js:unhidePagesWithPassword": { n: 1, mode: "undoable" },
  "app.js:mergeFiles": { n: 1, mode: "undoable" },
  "app.js:insertBuffersAt": { n: 1, mode: "undoable" },
  "app.js:replaceSelectedWith": { n: 1, mode: "undoable" },
  "app.js:addBlankPageAt": { n: 1, mode: "undoable" },
  "app.js:runPageNumbers": { n: 1, mode: "undoable" },
  "editor.js:bakePending": { n: 1, mode: "undoable" },
  "editor.js:applyForm": { n: 1, mode: "undoable" },
  "find-replace.js:applyEdits": { n: 1, mode: "undoable" },
  "text-edit.js:apply": { n: 1, mode: "undoable" },
};

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

// ---- scan --------------------------------------------------------------------

const WRITE = /\bstate\.bytes\s*=[^=]/;
const FN = /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every raw write, as `{ key, line, undoBefore }`. `files` = [{ name, src }]. */
function findWriters(files) {
  const out = [];
  for (const f of files) {
    const L = f.src.split("\n");
    L.forEach((line, i) => {
      if (isComment(line) || !WRITE.test(line)) return;
      let start = 0;
      let fn = "(top-level)";
      for (let k = i; k >= 0; k--) {
        const m = FN.exec(L[k]);
        if (m) {
          fn = m[1];
          start = k;
          break;
        }
      }
      const before = L.slice(start, i + 1).filter((x) => !isComment(x)).join("\n");
      out.push({ key: `${f.name}:${fn}`, line: i + 1, undoBefore: /\bpushUndo\s*\(/.test(before) });
    });
  }
  return out;
}

/** Violations of the whitelist for a set of writers, as readable strings. */
function violations(writers, table) {
  const v = [];
  const counts = {};
  for (const w of writers) counts[w.key] = (counts[w.key] || 0) + 1;

  for (const [key, n] of Object.entries(counts)) {
    const spec = table[key];
    if (!spec) {
      v.push(
        `NEW writer ${key} (${n}×). A write to state.bytes must call pushUndo() BEFORE it (BI-3). ` +
          `If it truly must not, add it to WRITERS as "exempt" with the reason.`
      );
    } else if (spec.n !== n) {
      v.push(`${key}: ${n} write(s), list says ${spec.n} — update WRITERS (and re-check the undo step for the new one)`);
    }
  }
  for (const key of Object.keys(table)) if (!counts[key]) v.push(`${key} no longer writes state.bytes — remove it from WRITERS`);

  for (const w of writers) {
    const spec = table[w.key];
    if (spec && spec.mode === "undoable" && !w.undoBefore) {
      v.push(`${w.key} (line ${w.line}) writes state.bytes with no pushUndo() before it in the function — BI-3`);
    }
  }
  for (const [key, spec] of Object.entries(table)) {
    if (spec.mode === "exempt" && !(spec.why && spec.why.length > 20)) v.push(`${key} is exempt but gives no reason`);
    if (spec.mode !== "exempt" && spec.mode !== "undoable") v.push(`${key} has unknown mode "${spec.mode}"`);
  }
  return v;
}

const SIDE_DOORS = [
  [/Object\.assign\(\s*state\b/, "Object.assign(state, …)"],
  [/\bstate\[\s*["']bytes["']\s*\]\s*=[^=]/, 'state["bytes"] = …'],
  [/\bstate\.bytes\s*(?:\+|-|\*|\/|\|\||&&|\?\?)=/, "compound assignment to state.bytes"],
];
function sideDoors(files) {
  const out = [];
  for (const f of files) {
    f.src.split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      for (const [re, what] of SIDE_DOORS) if (re.test(line)) out.push(`${f.name}:${i + 1} ${what}`);
    });
  }
  return out;
}

// ---- 1. the real renderer ------------------------------------------------------

const files = fs
  .readdirSync(RENDERER)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((name) => ({ name, src: fs.readFileSync(path.join(RENDERER, name), "utf8") }));

const real = findWriters(files);
check("found the writers (guards against a scan that silently matches nothing)", real.length >= 15, true);
check("state.bytes writers match the list; every undoable one pushes first", violations(real, WRITERS), []);
check("no side-door writes to the state object", sideDoors(files), []);

// ---- 2. negative controls: the checker must be able to fail ---------------------

const one = (src, name = "x.js") => findWriters([{ name, src }]);
const T = { "x.js:go": { n: 1, mode: "undoable" } };

check("control: pushUndo before the write is clean", violations(one("function go(){\n pushUndo();\n state.bytes = a;\n}"), T), []);
check(
  "control: missing pushUndo is caught",
  violations(one("function go(){\n state.bytes = a;\n}"), T),
  ["x.js:go (line 2) writes state.bytes with no pushUndo() before it in the function — BI-3"]
);
check(
  "control: pushUndo AFTER the write does not count (BI-3 is about order)",
  violations(one("function go(){\n state.bytes = a;\n pushUndo();\n}"), T),
  ["x.js:go (line 2) writes state.bytes with no pushUndo() before it in the function — BI-3"]
);
check(
  "control: window.DocHistory.pushUndo() counts (find-replace / text-edit style)",
  violations(one("async function go(){\n if (window.DocHistory) window.DocHistory.pushUndo();\n state.bytes = a;\n}"), T),
  []
);
check(
  "control: a pushUndo in ANOTHER function does not count",
  violations(one("function other(){ pushUndo(); }\nfunction go(){\n state.bytes = a;\n}"), T),
  ["x.js:go (line 3) writes state.bytes with no pushUndo() before it in the function — BI-3"]
);
check(
  "control: a new writer is caught with the rule to follow",
  violations(one("function sneaky(){\n state.bytes = a;\n}"), {}).map((s) => s.startsWith("NEW writer x.js:sneaky (1×). A write to state.bytes must call pushUndo() BEFORE it (BI-3)")),
  [true]
);
check("control: an extra write in a listed function is caught", violations(one("function go(){\n pushUndo();\n state.bytes = a;\n state.bytes = b;\n}"), T), ["x.js:go: 2 write(s), list says 1 — update WRITERS (and re-check the undo step for the new one)"]);
check("control: a removed writer is caught", violations(one("function other(){}"), T), ["x.js:go no longer writes state.bytes — remove it from WRITERS"]);
check("control: comments and comparisons are not writes", one("// state.bytes = a\n * state.bytes = a\nif (state.bytes == a) {}\nif (state.bytes === a) {}").length, 0);
check("control: exempt needs a reason", violations(one("function go(){\n state.bytes = a;\n}"), { "x.js:go": { n: 1, mode: "exempt" } }), ["x.js:go is exempt but gives no reason"]);
check("control: side doors are caught", sideDoors([{ name: "x.js", src: 'Object.assign(state, {bytes: a});\nstate["bytes"] = a;\nstate.bytes ||= a;' }]), ["x.js:1 Object.assign(state, …)", 'x.js:2 state["bytes"] = …', "x.js:3 compound assignment to state.bytes"]);

console.log(`\nstate-bytes-writers: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
