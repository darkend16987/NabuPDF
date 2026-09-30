"use strict";

/**
 * Guard for the CROSS-TAB object clipboard (copy an annotation in one document,
 * paste it into another — v0.2.67).
 *
 * Three failure modes, all silent, none visible to any other test:
 *
 *  1. BI-77 — the paste path must stay SYNCHRONOUS. editor.js decides whether it
 *     owns Ctrl+V by calling preventDefault() during the `paste` event, off the
 *     module-level `clip`. The moment somebody "tidies" that into
 *     `await window.desktop.readAnnotClip()`, the decision arrives after the event
 *     has already bubbled to capture.js's image-paste listener: Ctrl+V then either
 *     pastes twice or not at all, depending on timing. Nothing throws. §3 of the
 *     structural group below is the only thing standing in front of that edit.
 *
 *  2. `page: -1` on an adopted clip. pasteClip nudges a paste by PASTE_STEP when it
 *     lands on the SOURCE page, so a copy is not hidden under its original. A clip
 *     from another DOCUMENT has no original here, so page 0 of document B must not
 *     be mistaken for page 0 of document A — keeping srcPage would shift every
 *     cross-document paste 12pt off the spot it was copied from. Off-by-12pt in a
 *     saved file is exactly the class of bug REGRESSION-GUARD §1 warns about.
 *
 *  3. The share filter. Since v0.2.72 images cross — but main BROADCASTS a light
 *     clip (pixels left out) and hands the pixels only to the tab that pastes
 *     (annots:clip-fetch → hydrateClip). Break that and every Ctrl+C on a photo
 *     pushes megabytes to every open tab (§5 runs main's handler for real); break
 *     hydrateClip and an image arrives with no pixels (§2b runs it for real).
 *
 *  4. "The latest copy wins" (v0.2.72). A copied object writes NABU_CLIP_MIME to
 *     the OS clipboard, and the paste listener treats that marker as its own —
 *     otherwise a screenshot still sitting on the OS clipboard hijacks Ctrl+V.
 *
 * Runs the SHIPPING source, not a copy: functions and consts are cut out of
 * renderer/editor.js at run time (the `test:defaults` / `test:geom` pattern), so
 * renaming one of them fails this test loudly rather than testing nothing.
 *
 *   node test/annot-clip.test.js      (npm run test:clip)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, "renderer", "editor.js"), "utf8");
const CODEC_SRC = fs.readFileSync(path.join(ROOT, "renderer", "managed-codec.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");

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

// ---- source extraction (same helpers as test:defaults) ---------------------

function cutFunction(src, name, where) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`function ${name}() not found in ${where} — renamed?`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces while cutting ${name}()`);
}

function cutConst(src, name, where) {
  const re = new RegExp("^\\s*const " + name + " = ", "m");
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found in ${where} — renamed?`);
  const start = m.index + m[0].length;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i);
  }
  throw new Error(`no terminating ; for const ${name}`);
}

function evalExpr(src) {
  // eslint-disable-next-line no-eval
  return eval("(" + src + ")");
}

// ---- 1. the share filter ---------------------------------------------------

group("1. share filter — what may cross a tab boundary");

// isShareableKind closes over MANAGED_KINDS (via isManagedKind, from managed-codec.js)
// and SHARE_EXCLUDED. Both are injected from their SHIPPING sources so this test moves
// automatically when either set is edited — which is the point: a new managed kind
// should have to be considered here, not silently inherited.
const MANAGED_KINDS = evalExpr(cutConst(CODEC_SRC, "MANAGED_KINDS", "managed-codec.js"));
const SHARE_EXCLUDED = evalExpr(cutConst(EDITOR_SRC, "SHARE_EXCLUDED", "editor.js"));
const SHARE_EXTRA = evalExpr(cutConst(EDITOR_SRC, "SHARE_EXTRA", "editor.js"));
const isShareableKind = evalExpr(
  "(function(){ const MANAGED_KINDS = arguments[0], SHARE_EXCLUDED = arguments[1], SHARE_EXTRA = arguments[2];" +
    " const isManagedKind = (k) => MANAGED_KINDS.has(k);" +
    " return " +
    cutConst(EDITOR_SRC, "isShareableKind", "editor.js") +
    "; })"
)(MANAGED_KINDS, SHARE_EXCLUDED, SHARE_EXTRA);

for (const k of ["text", "note", "arrow", "box", "ellipse", "cloud", "cloudpen", "draw"]) {
  check(`${k} crosses tabs`, isShareableKind(k) === true);
}
// Images cross since v0.2.72 ("ảnh … copy sang 1 file khác thì không vào được"). The
// payload objection is answered in main (light broadcast, §5), not by holding them back.
check("image crosses tabs (v0.2.72)", isShareableKind("image") === true);
check("SHARE_EXCLUDED is empty — nothing is held back by kind", SHARE_EXCLUDED.size === 0, [
  ...SHARE_EXCLUDED,
].join(","));

// The size ceiling on ONE copy. Cut from the shipping source with the shipping cap.
const SHARE_IMAGE_CAP = evalExpr(cutConst(EDITOR_SRC, "SHARE_IMAGE_CAP", "editor.js"));
check(
  "SHARE_IMAGE_CAP is tens of MB (a real signature/photo is never capped)",
  SHARE_IMAGE_CAP >= 16 * 1024 * 1024 && SHARE_IMAGE_CAP <= 128 * 1024 * 1024,
  SHARE_IMAGE_CAP
);
const shareableItems = evalExpr(
  "(function(){ const isShareableKind = arguments[0], SHARE_IMAGE_CAP = arguments[1]; return " +
    cutFunction(EDITOR_SRC, "shareableItems", "editor.js") +
    "; })"
)(isShareableKind, SHARE_IMAGE_CAP);
const img = (n) => ({ kind: "image", dataUrl: "data:image/png;base64," + "A".repeat(n) });
let si = shareableItems([img(1000), { kind: "text" }, { kind: "highlight" }]);
check("a normal image + text cross, highlight stays", si.length === 2 && si[0].kind === "image" && si[1].kind === "text");
si = shareableItems([img(SHARE_IMAGE_CAP), img(10), { kind: "box" }]);
check("over the cap: ALL images stay (never an arbitrary subset), the box crosses", si.length === 1 && si[0].kind === "box");

// ✓ and ✗ cross from v0.2.69 (asked for by name: "copy dấu tích V hoặc x … file
// này sang file khác"). They are NOT managed, and that is the point of the test:
// "may this cross a tab boundary" and "does this survive a save" are two different
// questions, and the ✓ is the kind where the answers differ. A pasted ✓ is exactly
// the annotation the ✓ tool would have produced in the destination — nothing about
// the bake changes, so BI-42 is untouched.
for (const k of ["check", "cross"]) {
  check(`${k} crosses tabs (v0.2.69)`, isShareableKind(k) === true);
  // v0.2.73: they now round-trip, so they cross BECAUSE they are managed — the reason
  // SHARE_EXTRA existed is gone, and the set is empty (asserted below).
  check(`${k} is a managed kind since v0.2.73 (copyable after Áp dụng too)`, MANAGED_KINDS.has(k) === true);
}
check("SHARE_EXTRA is empty since v0.2.73 (✓/✗ cross as managed kinds)", SHARE_EXTRA.size === 0, [
  ...SHARE_EXTRA,
].join(","));

// The rest of the flatten-on-bake family did NOT get an opt-in. Highlight/underline/
// strike are anchored to text runs the destination document does not have, and a
// redaction is a promise about THIS file's content — none of them mean anything
// pasted into another document, so a blanket "everything crosses" would be wrong.
for (const k of ["highlight", "under", "strike", "dim", "redact"]) {
  check(`${k} does not cross`, isShareableKind(k) === false);
}

// ---- 2. adopting a clip from another tab -----------------------------------

group("2. adoptSharedClip — page:-1 is load-bearing");

// Every name adoptSharedClip reads is injected, so the body under test is the
// byte-for-byte shipping one (see test:defaults for why this shape).
function makeAdopter() {
  return evalExpr(
    "(function(){" +
      " let clip = null; const ed = { tool: 'select' }; let syncCalls = 0;" +
      " function syncCtlVisibility(){ syncCalls++; }" +
      cutFunction(EDITOR_SRC, "adoptSharedClip", "editor.js") +
      " return { adopt: adoptSharedClip, clip: () => clip, syncCalls: () => syncCalls };" +
      "})"
  )();
}

let A = makeAdopter();
A.adopt({ items: [{ kind: "text", x: 10, y: 20 }], srcPage: 0 });
check("adopts a non-empty payload", A.clip() !== null);
check(
  "adopted clip carries page -1, NOT srcPage",
  A.clip().page === -1,
  "got " + (A.clip() && A.clip().page)
);
check("adopted clip starts with an empty cascade counter", A.clip() && !Object.keys(A.clip().dropped).length);
check("adopting repaints the palette so Dán lights up", A.syncCalls() === 1);

// The whole reason -1 was chosen: pasteClip's "don't hide under the original" branch
// is `i === clip.page`, and that must be dead for a clip that came from ANOTHER
// document — otherwise page 0 of doc B is treated as the source page of doc A.
const PAGE_RULE = "i === clip.page";
check(
  "pasteClip still keys the cascade off `" + PAGE_RULE + "`",
  EDITOR_SRC.includes(PAGE_RULE),
  "expression renamed — re-check the -1 reasoning"
);
let sameAsSource = false;
for (let i = 0; i < 5000; i++) if (i === A.clip().page) sameAsSource = true;
check("no valid page index equals -1 (cross-doc paste keeps its coordinates)", sameAsSource === false);

A = makeAdopter();
A.adopt({ items: [{ kind: "text" }], srcPage: 3 });
A.adopt(null);
check("a null broadcast clears the clip", A.clip() === null);
A.adopt({ items: [], srcPage: 0 });
check("an empty item list clears the clip (nothing shareable)", A.clip() === null);
A = makeAdopter();
A.adopt({ id: 7, items: [{ kind: "image", _pending: true }], srcPage: 0, heavy: true });
check("a light clip keeps its id and heavy flag", A.clip() && A.clip().id === 7 && A.clip().heavy === true);
A.adopt({ id: 8, items: [{ kind: "text" }], srcPage: 0, heavy: false });
check("a clip without images is not heavy", A.clip() && A.clip().heavy === false);

// ---- 3. BI-77 — the paste decision must stay synchronous -------------------

group("3. BI-77 structural guard — no await on the paste decision");

// The `paste` listener, located by regex so the match survives CRLF/LF and
// reformatting. An empty body here would make every check below pass VACUOUSLY,
// so the locator is asserted first and the body length is asserted with it.
const pasteRe = /document\.addEventListener\(\s*(?:async\s+)?"paste"/;
const pasteM = pasteRe.exec(EDITOR_SRC);
check("the `paste` listener is still where this test expects it", !!pasteM);
const pasteBody = pasteM ? EDITOR_SRC.slice(pasteM.index, pasteM.index + 2000) : "";
check("the located paste body is non-empty (guards against vacuous passes below)", pasteBody.length > 200);

check(
  "the paste listener is NOT async",
  !!pasteM && !/"paste",\s*async/.test(pasteBody),
  "an async listener cannot preventDefault() in time"
);
const beforePrevent = pasteBody.slice(0, pasteBody.indexOf("e.preventDefault()"));
check("nothing is awaited before preventDefault()", !/\bawait\b/.test(beforePrevent));
check(
  "the paste decision reads the local `clip`, not IPC",
  /if\s*\(!clip\)\s*return;/.test(pasteBody) && !/readAnnotClip|fetchAnnotClip|hydrateClip/.test(beforePrevent)
);
check(
  "our OS-clipboard marker overrides the image hand-off (latest copy wins)",
  /NABU_CLIP_MIME/.test(beforePrevent) && /if \(!ours\) for \(const it of items\)/.test(beforePrevent)
);

// readAnnotClip is a startup-only pull. It must never appear inside pasteClip or
// requestPaste — that would reintroduce the await this whole design avoids.
for (const fn of ["pasteClip", "requestPaste"]) {
  const body = cutFunction(EDITOR_SRC, fn, "editor.js");
  check(`${fn}() never calls readAnnotClip`, !body.includes("readAnnotClip"));
}
// requestPaste is the ONE place allowed to await, and only for the WORK (entering
// Chỉnh sửa), never for the decision.
const reqBody = cutFunction(EDITOR_SRC, "requestPaste", "editor.js");
check("requestPaste re-checks ed.active after awaiting enter()", /await enter\(\)/.test(reqBody) && reqBody.lastIndexOf("!ed.active") > reqBody.indexOf("await enter()"));
check(
  "requestPaste hydrates a heavy clip, then re-checks before pasting",
  /clip\.heavy && !\(await hydrateClip\(\)\)/.test(reqBody) &&
    reqBody.lastIndexOf("!ed.active") > reqBody.indexOf("hydrateClip()") &&
    reqBody.lastIndexOf("pasteClip(") > reqBody.indexOf("hydrateClip()")
);
const pasteClipBody = cutFunction(EDITOR_SRC, "pasteClip", "editor.js");
check("pasteClip refuses a clip whose pixels are not in yet", /clip\.heavy\) return false/.test(pasteClipBody));
check("pasteClip never fetches (the backstop does not become a second await path)", !/fetchAnnotClip|await/.test(pasteClipBody));

// The `copy` side of "latest copy wins": the marker is written, and every copy route
// (button, right-click) raises the same event instead of calling copySelected() raw.
const copyRe = /document\.addEventListener\(\s*"copy"/;
const copyM = copyRe.exec(EDITOR_SRC);
const copyListener = copyM ? EDITOR_SRC.slice(copyM.index, copyM.index + 1400) : "";
check("the copy listener is where this test expects it", copyListener.length > 200);
check("the copy listener writes the NABU_CLIP_MIME marker", /setData\(NABU_CLIP_MIME/.test(copyListener));
check("the copy listener still only claims when copySelected() succeeded", /if \(copySelected\(\)\) \{\s*e\.preventDefault\(\)/.test(copyListener));
check("the Sao chép button goes through copyGesture", /\$\("ed-copy"\)\.onclick = \(\) => \{\s*if \(!copyGesture\(\)\)/.test(EDITOR_SRC));
check("the right-click Sao chép goes through copyGesture", /onClick: copyGesture,/.test(EDITOR_SRC));
check("the keydown Ctrl+C fallback goes through copyGesture", /if \(!\(sel && String\(sel\)\.length\)\) copyGesture\(\);/.test(EDITOR_SRC));
const gestureBody = cutFunction(EDITOR_SRC, "copyGesture", "editor.js");
check("copyGesture falls back to a direct copy when the event did not land", /copyEventHandled \|\| copySelected\(\)/.test(gestureBody));

// shareClip must not be awaited by its caller for the same reason (copySelected
// calls preventDefault() synchronously in the `copy` listener).
const copyBody = cutFunction(EDITOR_SRC, "copySelected", "editor.js");
check("copySelected does not await the mirror", copyBody.includes("shareClip(") && !/await\s+shareClip/.test(copyBody));

// ---- 4. the main-process mirror -------------------------------------------

group("4. main.js mirror + preload bridge");

check("main registers annots:clip-write", MAIN_SRC.includes('ipcMain.handle("annots:clip-write"'));
check("main registers annots:clip-read", MAIN_SRC.includes('ipcMain.handle("annots:clip-read"'));
check("main registers annots:clip-fetch", MAIN_SRC.includes('ipcMain.handle("annots:clip-fetch"'));
check(
  "the broadcast skips the sender (it already set its clip synchronously)",
  /if \(wc === e\.sender\) continue;/.test(MAIN_SRC)
);
check(
  "an empty item list CLEARS objClip rather than leaving a stale one",
  /items && items\.length \? \{ id: \+\+objClipSeq, items, srcPage: payload\.srcPage \| 0 \} : null/.test(MAIN_SRC)
);
check("the broadcast is the LIGHT clip", /wc\.send\("annots:clip-changed", out\)/.test(MAIN_SRC) && /const out = lightClip\(objClip\)/.test(MAIN_SRC));
check("the startup read is the LIGHT clip too", /ipcMain\.handle\("annots:clip-read", \(\) => lightClip\(objClip\)\)/.test(MAIN_SRC));
for (const api of ["writeAnnotClip", "readAnnotClip", "fetchAnnotClip", "onAnnotClipChanged"]) {
  check(`preload exposes ${api}`, PRELOAD_SRC.includes(api + ":"));
}
check(
  "onAnnotClipChanged returns an unsubscribe (removeListener), like the other on* bridges",
  /onAnnotClipChanged:[\s\S]{0,320}removeListener\("annots:clip-changed"/.test(PRELOAD_SRC)
);

// ---- 5. the main-process handler, actually RUN ----------------------------

group("5. annots:clip-write executed against stubs (not just grepped)");

// Cut the handler callback out of main.js and run it. The checks above only prove
// the source LOOKS right; these prove it behaves right, which is what a reader of
// §4 would otherwise have to take on trust.
function cutHandler(src, channel) {
  const at = src.indexOf(`ipcMain.handle("${channel}"`);
  if (at < 0) throw new Error(`ipcMain.handle("${channel}") not found in main.js`);
  const open = src.indexOf("(", at + `ipcMain.handle`.length - 1);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error("unbalanced parens in ipcMain.handle(" + channel + ")");
  const args = src.slice(open + 1, close);
  const comma = args.indexOf(",", args.indexOf('"', args.indexOf('"') + 1));
  return args.slice(comma + 1).trim(); // the callback expression
}

function makeMain() {
  return evalExpr(
    "(function(){" +
      " let objClip = null; let objClipSeq = 0; const wcs = []; const sent = [];" +
      cutFunction(MAIN_SRC, "lightClip", "main.js") +
      " const Tabs = { allDocContents: () => wcs };" +
      " const mkWc = (name) => { const wc = { name, send: (ch, p) => sent.push({ to: name, ch, p }) }; wcs.push(wc); return wc; };" +
      " const handler = " +
      cutHandler(MAIN_SRC, "annots:clip-write") +
      ";" +
      " const read = " + cutHandler(MAIN_SRC, "annots:clip-read") + ";" +
      " const fetch = " + cutHandler(MAIN_SRC, "annots:clip-fetch") + ";" +
      " return { handler, read, fetch, mkWc, sent, clip: () => objClip };" +
      "})"
  )();
}

let M = makeMain();
const wcA = M.mkWc("A");
M.mkWc("B");
M.mkWc("C");
let res = M.handler({ sender: wcA }, { items: [{ kind: "text", x: 5 }], srcPage: 2 });
check("write returns ok", res && res.ok === true, JSON.stringify(res));
check("objClip holds the items", !!M.clip() && M.clip().items.length === 1);
check("objClip records srcPage", M.clip() && M.clip().srcPage === 2);
check("broadcast reached exactly the two NON-sender tabs", M.sent.length === 2, JSON.stringify(M.sent.map((s) => s.to)));
check("the sender was skipped", !M.sent.some((s) => s.to === "A"));
check("broadcast channel is annots:clip-changed", M.sent.every((s) => s.ch === "annots:clip-changed"));

// Images: stored FULL in main, broadcast LIGHT, fetched by id.
M = makeMain();
const wA2 = M.mkWc("A");
M.mkWc("B");
const PX = "data:image/png;base64," + "Q".repeat(5000);
M.handler({ sender: wA2 }, { items: [{ kind: "image", x: 1, w: 50, dataUrl: PX }, { kind: "text", x: 2 }], srcPage: 1 });
const out = M.sent[0] && M.sent[0].p;
check("main keeps the pixels", M.clip().items[0].dataUrl === PX);
check("the broadcast carries NO pixels", !!out && !JSON.stringify(out).includes("QQQQ"), out && JSON.stringify(out).length);
check("the broadcast is marked heavy with the clip id", !!out && out.heavy === true && out.id === M.clip().id);
check("the broadcast image keeps its geometry and is marked _pending", !!out && out.items[0].w === 50 && out.items[0]._pending === true);
check("non-image items are broadcast unchanged", !!out && out.items[1].kind === "text" && out.items[1]._pending === undefined);
check("lightClip does not mutate the stored clip", M.clip().items[0]._pending === undefined);
check("startup read is light as well", !JSON.stringify(M.read()).includes("QQQQ") && M.read().heavy === true);
check("fetch by the current id returns the full items", (M.fetch({}, M.clip().id) || [{}])[0].dataUrl === PX);
const oldId = M.clip().id;
M.handler({ sender: wA2 }, { items: [{ kind: "box" }], srcPage: 0 });
check("fetch by a superseded id returns null", M.fetch({}, oldId) === null);
check("a text-only clip is not heavy", M.read().heavy === false);
check("ids increase per copy", M.clip().id === oldId + 1);
M.sent.length = 0;

// An empty list (nothing shareable) must CLEAR, not be ignored.
M.sent.length = 0;
res = M.handler({ sender: wcA }, { items: [], srcPage: 0 });
check("an empty list clears objClip", M.clip() === null);
check("the clear is broadcast as null so other tabs grey out Dán", M.sent.length === 2 && M.sent.every((s) => s.p === null));

// A malformed payload must not throw across the IPC boundary.
M = makeMain();
M.mkWc("A");
for (const bad of [null, undefined, {}, { items: "nope" }, { items: null }]) {
  let threw = false;
  try {
    M.handler({ sender: {} }, bad);
  } catch (_) {
    threw = true;
  }
  check("malformed payload " + JSON.stringify(bad) + " does not throw", !threw);
}
check("objClip stays null after malformed payloads", M.clip() === null);

// ---- 2b. hydrateClip — the pixels, fetched by the pasting tab only ---------
//
// Last because it is async; the summary runs when it settles.

group("2b. hydrateClip executed against a stubbed main (not just grepped)");

function makeHydrator(fetchImpl) {
  return evalExpr(
    "(function(fetchImpl){" +
      " let clip = null; const ed = { tool: 'select' }; const toasts = []; let fetches = 0;" +
      " function syncCtlVisibility(){}" +
      " function toast(m){ toasts.push(m); }" +
      " const window = { desktop: { fetchAnnotClip: (id) => { fetches++; return fetchImpl(id, (c) => { clip = c; }); } } };" +
      " async " + cutFunction(EDITOR_SRC, "hydrateClip", "editor.js") +
      " return { hydrate: hydrateClip, set: (c) => { clip = c; }, clip: () => clip, toasts, fetches: () => fetches };" +
      "})"
  )(fetchImpl);
}

(async () => {
  const FULL = [{ kind: "image", x: 1, dataUrl: "data:image/png;base64,AAAA" }];
  let H = makeHydrator(async (id) => (id === 3 ? FULL : null));
  H.set({ items: [{ kind: "image", x: 1, _pending: true }], page: -1, dropped: {}, id: 3, heavy: true });
  check("hydrate: resolves true for a live clip", (await H.hydrate()) === true);
  check("hydrate: the pixels are in", H.clip().items[0].dataUrl === FULL[0].dataUrl);
  check("hydrate: no longer heavy", H.clip().heavy === false);
  await H.hydrate();
  check("hydrate: a second paste does not fetch again", H.fetches() === 1);

  H = makeHydrator(async () => null);
  H.set({ items: [{ kind: "image", _pending: true }], page: -1, dropped: {}, id: 4, heavy: true });
  check("hydrate: main says gone → false", (await H.hydrate()) === false);
  check("hydrate: …clears the clip (never pastes an image without pixels)", H.clip() === null);
  check("hydrate: …and tells the user", H.toasts.length === 1);

  H = makeHydrator(async () => [FULL[0], FULL[0]]);
  H.set({ items: [{ kind: "image", _pending: true }], page: -1, dropped: {}, id: 5, heavy: true });
  check("hydrate: a length mismatch (different clip) is refused", (await H.hydrate()) === false && H.clip() === null);

  // A newer copy lands while the fetch is in flight → the NEWER clip is what gets pasted.
  const NEWER = { items: [{ kind: "text", x: 9 }], page: 2, dropped: {} };
  H = makeHydrator(async (id, setClip) => {
    setClip(NEWER);
    return FULL;
  });
  H.set({ items: [{ kind: "image", _pending: true }], page: -1, dropped: {}, id: 6, heavy: true });
  check("hydrate: superseded mid-fetch → resolves for the newer clip", (await H.hydrate()) === true && H.clip() === NEWER);
  check("hydrate: …and the newer clip was not overwritten by the stale pixels", H.clip().items[0].kind === "text");

  H = makeHydrator(async () => {
    throw new Error("should not be called");
  });
  H.set({ items: [{ kind: "box" }], page: 0, dropped: {} });
  check("hydrate: a light (local) clip never touches main", (await H.hydrate()) === true && H.fetches() === 0);

  H = makeHydrator(async () => {
    throw new Error("ipc down");
  });
  H.set({ items: [{ kind: "image", _pending: true }], page: -1, dropped: {}, id: 9, heavy: true });
  check("hydrate: an IPC failure is a clean false, not a throw", (await H.hydrate()) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
