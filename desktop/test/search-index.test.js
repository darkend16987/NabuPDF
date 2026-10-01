"use strict";

// Regression net for the Ctrl+F index in app.js (`ensureSearchIndex`, `runSearch`,
// `closeFind`) — R6, docs/REVIEW-2026-10-01.
//
// Two defects lived here and neither shows up by clicking around:
//   1. Nothing remembered a build in flight. Every keystroke typed before the FIRST index
//      finished started its own full-document getTextContent pass; on a big drawing set that
//      is minutes of redundant work competing with rendering.
//   2. The finished index was stamped with `state.pdf` read AFTER the loop. Replace the
//      document mid-build (open another file, or any edit that reloads pdf.js) and the old
//      document's text was cached under the NEW document's token — every search on the new
//      document then ran against the wrong text until something else happened to reset it.
//   And a related one: `runSearch` had no sequence number, so a slow search that finished
//   after a newer one overwrote the newer result, and Escape (closeFind) did not stop a
//   search still waiting on the index from repopulating the highlights it had just cleared.
//
// Like viewer-geom.test.js this LIFTS the real functions out of the shipped app.js and runs
// them against a fake pdf.js document, so what is tested is what runs. A rename breaks this
// file loudly. The fake page's getTextContent is slow on purpose: concurrency and "document
// replaced mid-build" only exist while something is awaiting.
//
// Run:  node desktop/test/search-index.test.js      (or: npm test -- search-index)

const fs = require("fs");
const path = require("path");

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

// ---- lift real code out of app.js (same technique as viewer-geom.test.js) -------------
const APP = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
function lift(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error(`${name}() not found in app.js — renamed or removed?`);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  const open = APP.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < APP.length; i++) {
    if (APP[i] === "{") depth++;
    else if (APP[i] === "}" && --depth === 0) {
      // eslint-disable-next-line no-eval
      return eval("(" + APP.slice(at, i + 1) + ")"); // direct eval: closes over THIS file's `state`, `search`, `$`…
    }
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}
function liftSearchState() {
  const m = /^const search = (\{[\s\S]*?\n\});/m.exec(APP);
  if (!m) throw new Error("`const search = {…}` not found in app.js");
  // eslint-disable-next-line no-eval
  return eval("(" + m[1] + ")");
}

// ---- the environment those functions close over ----------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let state;
let search;
let log; // what the UI-facing collaborators were asked to do
let findInput;
const $ = (id) => (id === "find-input" ? findInput : null);
const document = { querySelectorAll: () => ({ forEach() {} }) };
function drawSearchLayer(i) { log.drawn.push(i); }
function updateFindCount() { log.counts.push(search.matches.length); }
async function gotoMatch(idx) { log.goto.push(idx); await sleep(5); }

const foldText = lift("foldText");
const ensureSearchIndex = lift("ensureSearchIndex");
const runSearch = lift("runSearch");
const closeFind = lift("closeFind");

/** A fake pdf.js document. `delay` makes getTextContent slow; `calls` counts passes. */
function fakePdf(pagesText, delay) {
  const calls = { textContent: 0, getPage: 0 };
  const pdf = {
    numPages: pagesText.length,
    calls,
    getPage: async (n) => {
      calls.getPage++;
      return {
        getTextContent: async () => {
          calls.textContent++;
          await sleep(delay);
          return { items: pagesText[n - 1].map((str) => ({ str, transform: [1, 0, 0, 1, 0, 0], width: str.length * 5 })) };
        },
      };
    },
  };
  return pdf;
}

function reset(pdf) {
  search = liftSearchState();
  state = { pdf, numPages: pdf ? pdf.numPages : 0, pageMetas: null };
  log = { drawn: [], counts: [], goto: [] };
  const cl = new Set();
  findInput = { value: "", blur() {}, classList: { remove: (c) => cl.delete(c), toggle: (c, on) => (on ? cl.add(c) : cl.delete(c)), has: (c) => cl.has(c) } };
}

(async () => {
  const PAGES = [["Điều khoản chung", "xin chào"], ["Điều 2: Giá trị hợp đồng"], ["không có gì"], ["điều khoản thanh toán"]];

  // ---- 1. concurrent callers share one build ---------------------------------------------
  {
    const pdf = fakePdf(PAGES, 15);
    reset(pdf);
    const [a, b, c] = await Promise.all([ensureSearchIndex(), ensureSearchIndex(), ensureSearchIndex()]);
    check("three concurrent callers get the SAME index object", a === b && b === c, true);
    check("…and the document was walked once: one getTextContent per page, not three", pdf.calls.textContent, PAGES.length);
    check("index shape: one entry per page", a.length, PAGES.length);
    check("index is folded (diacritic-insensitive): 'Điều khoản chung' → 'dieu khoan chung'", a[0][0].folded, "dieu khoan chung");
    const before = pdf.calls.textContent;
    const again = await ensureSearchIndex();
    check("a later call is served from the cache (no new pass)", [again === a, pdf.calls.textContent], [true, before]);
    check("indexJob is cleared once the build settles", search.indexJob, null);
    check("the index is stamped with the document it was built from", search.docToken === pdf, true);
  }

  // ---- 2. the document is replaced mid-build ----------------------------------------------
  {
    const A = fakePdf([["alpha one"], ["alpha two"], ["alpha three"]], 20);
    const B = fakePdf([["bravo only"]], 5);
    reset(A);
    const building = ensureSearchIndex(); // starts walking A
    await sleep(25); // page 1 done, page 2 in flight
    state.pdf = B; // user opens another document
    state.numPages = 1;
    const result = await building;
    check("the abandoned build resolves to null instead of publishing", result, null);
    check("…and does NOT leave A's text under B's token", [search.docItems, search.docToken === B], [null, false]);
    const forB = await ensureSearchIndex();
    check("the next call builds B's own index", forB.map((p) => p.map((i) => i.folded)), [["bravo only"]]);
    check("…cached under B", search.docToken === B, true);
    check("a stale job does not clear a newer job's slot", search.indexJob, null);
  }

  // ---- 3. a different document while a job is in flight must not join the old job ---------
  {
    const A = fakePdf([["aaa"], ["aaa"]], 20);
    const B = fakePdf([["bbb"]], 1);
    reset(A);
    const jobA = ensureSearchIndex();
    state.pdf = B;
    state.numPages = 1;
    const jobB = ensureSearchIndex();
    check("a call for another document starts its own build", jobA === jobB, false);
    const [ra, rb] = await Promise.all([jobA, jobB]);
    check("A abandoned, B complete", [ra, rb && rb[0][0].folded], [null, "bbb"]);
  }

  // ---- 4. nothing open ----------------------------------------------------------------------
  {
    reset(null);
    check("no document: resolves to [] without throwing and caches nothing", [await ensureSearchIndex(), search.docItems], [[], null]);
  }

  // ---- 5. runSearch: results, and the newest search wins ---------------------------------------
  {
    const pdf = fakePdf(PAGES, 3);
    reset(pdf);
    await runSearch("dieu khoan"); // typed WITHOUT diacritics, finds "Điều khoản"
    check("search finds diacritic text typed without dấu: pages 0 and 3", search.matches.map((m) => m.page), [0, 3]);
    check("match geometry is the fraction of the run (start/end)", [search.matches[0].fracStart, +search.matches[0].fracEnd.toFixed(4)], [0, +(10 / 16).toFixed(4)]);
    check("current points at the first hit and the box is not flagged no-hit", [search.current, findInput.classList.has("no-hit")], [0, false]);
    await runSearch("không tồn tại");
    check("no hits → empty list, current -1, input flagged no-hit", [search.matches.length, search.current, findInput.classList.has("no-hit")], [0, -1, true]);
    await runSearch("");
    check("empty query clears the hits and the flag", [search.matches.length, search.query, findInput.classList.has("no-hit")], [0, "", false]);
  }
  {
    // slow first search, fast second: the second one is the user's latest intent
    const pdf = fakePdf(PAGES, 25);
    reset(pdf);
    const slow = runSearch("dieu"); // waits for the index (~100 ms)
    await sleep(10);
    const fast = runSearch("gia tri"); // joins the same build
    await Promise.all([slow, fast]);
    check("two searches typed during the first build: the LAST one's results stand", [search.query, search.matches.map((m) => m.page)], ["gia tri", [1]]);
    check("…and the document was still walked only once", pdf.calls.textContent, PAGES.length);
    check("the superseded search drew no highlights of its own", log.goto.length, 1);
  }
  {
    const pdf = fakePdf(PAGES, 25);
    reset(pdf);
    const pending = runSearch("dieu");
    await sleep(10);
    closeFind(); // Escape while the index is still building
    await pending;
    check("Escape during a pending search: the highlights STAY cleared", [search.matches.length, search.current, search.query], [0, -1, ""]);
    check("…and nothing was navigated to", log.goto, []);
  }
  {
    // A finds hits and is mid-gotoMatch (awaiting a page render) when B, a miss, completes.
    // A then resumes and used to set the no-hit flag from ITS OWN (non-empty) result,
    // un-flagging the box B had just flagged.
    const pdf = fakePdf(PAGES, 3);
    reset(pdf);
    await ensureSearchIndex(); // warm, so B can finish while A is inside gotoMatch
    const a = runSearch("dieu");
    await sleep(1);
    const b = runSearch("zzzz");
    await Promise.all([a, b]);
    check("a slower, superseded search does not un-flag the newer search's no-hit", [search.query, search.matches.length, findInput.classList.has("no-hit")], ["zzzz", 0, true]);
  }
  {
    // the user types, the document is replaced before the index lands: no results, no throw
    const A = fakePdf([["alpha dieu"], ["alpha"]], 20);
    const B = fakePdf([["bravo"]], 1);
    reset(A);
    const s = runSearch("alpha");
    await sleep(15);
    state.pdf = B;
    state.numPages = 1;
    let threw = false;
    try {
      await s;
    } catch (_) {
      threw = true;
    }
    check("document replaced under a pending search: it ends quietly with no stale matches", [threw, search.matches.length], [false, 0]);
  }

  console.log(`\nsearch-index: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
