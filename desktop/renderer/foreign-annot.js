"use strict";

/*
 * Nabu PDF — another program's annotations as editable overlay objects (Đợt 3b, BI-100).
 *
 * WHAT IS HERE. The pure half of importing a partner's shapes (Acrobat / Foxit / PDF-XChange):
 *   readForeign  pdf-lib dict → a plain record, or { skip: reason }
 *   toObjects    record + the page's PDF→view mapping → overlay objects (no ids), or { skip }
 *   planForeign  at bake time: which originals are untouched (leave them, write nothing) and
 *                which must be removed because their overlay copy changed or was deleted
 *   removeOriginal  take one original out of a document — only if it is EXACTLY the one we
 *                imported (N2), with its /Popup
 *   applyKeep    carry the author / comment / NM over onto the Nabu annotation that replaces it
 * editor-bake.js's importManaged / bakeInPlace / bakeWithRedaction call these through
 * window.ForeignAnnot; node tests require() it.
 *
 * THE RULES (docs/RESEARCH-2026-10-05 §4.1, decisions Q1):
 *   N1 "không chạm thì không ghi" — an imported annotation the user did not change leaves the
 *      file exactly as it was: the bake does not remove it and does not write a Nabu copy.
 *      "Did not change" is decided by VALUE, not by watching edits: each overlay object's
 *      serialised form is remembered at import (`sigs`) and compared at bake. Undoing a move
 *      therefore counts as untouched; a copy pasted elsewhere does not disturb the original.
 *   N2 "không chắc thì để yên" — the original is removed only when the document still has an
 *      annotation at that object number with the same /Subtype, /Rect and /NM. Otherwise it
 *      stays (two copies beat a lost comment) and the caller says so.
 *   N3 — only kinds with a faithful Nabu counterpart are imported. Group (B) of Q1: Square,
 *      Circle, Line, Polygon, PolyLine, Ink → box / ellipse / cloud / arrow / poly / cloudpen /
 *      draw. FreeText / Text / Highlight (group A, keep their own type — Đợt 3c) and Stamp
 *      (only /Rect may change, never rasterised) are NOT imported here: they stay on the page,
 *      painted by pdf.js, listed in the Chú thích tab, untouchable as before.
 *      Anything the Nabu object cannot say is a reason to leave the annotation alone rather than
 *      to import it lossily: transparency (/CA < 1), a zero-width or colourless border, hidden /
 *      locked / read-only / no-rotate flags, optional content, replies in either direction,
 *      dimension lines, captions, arrowheads at both ends or on a polyline.
 *
 * Coordinates: records stay in PDF user space; toObjects maps them with `toView(x, y)`, which is
 * the page's scale-1 pdf.js viewport (convertToViewportPoint) — the inverse of the map the bake
 * writes through, so rotated pages come out right for free (BI-45).
 */

(function () {
  const AS = typeof module !== "undefined" && module.exports ? require("./annot-scan.js") : window.AnnotScan;

  const SUBTYPES = new Set(["Square", "Circle", "Line", "Polygon", "PolyLine", "Ink"]);
  // /F bits we refuse: Hidden 2, NoRotate 16, NoView 32, ReadOnly 64, Locked 128.
  const FLAG_SKIP = 2 | 16 | 32 | 64 | 128;
  const ARROW_ENDS = new Set(["OpenArrow", "ClosedArrow"]);

  function normRect(r) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isFinite(v))) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }
  function sameRect(a, b) {
    const p = normRect(a);
    const q = normRect(b);
    return !!(p && q) && p.every((v, k) => Math.abs(v - q[k]) < 1e-3);
  }

  // Every object a /IRT points at, as "num gen R" strings: an annotation with replies is not
  // imported (removing it would orphan the thread).
  function replyTargets(PDFLib, doc) {
    const { PDFName, PDFDict, PDFRef } = PDFLib;
    const out = new Set();
    for (const page of doc.getPages()) {
      let arr;
      try { arr = page.node.Annots(); } catch (_) { continue; }
      if (!arr) continue;
      for (let j = 0; j < arr.size(); j++) {
        const d = doc.context.lookup(arr.get(j));
        if (!(d instanceof PDFDict)) continue;
        const irt = d.get(PDFName.of("IRT"));
        if (irt instanceof PDFRef) out.add(irt.toString());
      }
    }
    return out;
  }

  function readForeign(PDFLib, doc, raw, dict, targets) {
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, PDFBool } = PDFLib;
    const N = (s) => PDFName.of(s);
    const look = (k) => dict.lookup(N(k));
    const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : null);
    const textOf = (v) => (v && typeof v.decodeText === "function" ? v.decodeText() : null);
    const num = (v) => (v instanceof PDFNumber ? v.asNumber() : NaN);
    const nums = (v) => (v instanceof PDFArray ? v.asArray().map((x) => num(doc.context.lookup(x))) : null);
    const skip = (reason) => ({ skip: reason });

    const subtype = nameOf(look("Subtype"));
    if (!SUBTYPES.has(subtype)) return skip("subtype");
    if (dict.get(N("NabuKind"))) return skip("nabu");
    // Found again at bake time by object number — an inline dict has none (N2).
    if (!(raw instanceof PDFRef)) return skip("inline");
    const flags = num(look("F"));
    if (Number.isFinite(flags) && flags & FLAG_SKIP) return skip("flags");
    if (dict.get(N("OC"))) return skip("optional-content");
    if (dict.get(N("IRT"))) return skip("reply");
    if (targets && targets.has(raw.toString())) return skip("has-replies");
    const ca = num(look("CA"));
    if (Number.isFinite(ca) && ca < 0.999) return skip("opacity");
    const rect = normRect(nums(look("Rect")));
    if (!rect) return skip("rect");

    const color = AS.colorOf(nums(look("C")));
    if (!color) return skip("no-color");
    const bs = look("BS");
    let width = NaN;
    let dashed = false;
    if (bs instanceof PDFDict) {
      width = num(bs.lookup(N("W")));
      dashed = nameOf(bs.lookup(N("S"))) === "D";
    }
    if (!Number.isFinite(width)) {
      const border = nums(look("Border"));
      width = border && border.length >= 3 && Number.isFinite(border[2]) ? border[2] : 1;
    }
    if (!(width > 0)) return skip("no-border");
    const be = look("BE");
    const cloudy = be instanceof PDFDict && nameOf(be.lookup(N("S"))) === "C";
    const fill = AS.colorOf(nums(look("IC")));
    const it = nameOf(look("IT"));

    const rec = {
      subtype, it, rect, color, width, dashed, cloudy, fill,
      num: raw.objectNumber, gen: raw.generationNumber, fileRef: raw.toString(),
      nm: textOf(look("NM")),
      keep: {},
    };
    for (const k of ["T", "Contents", "NM", "Subj", "CreationDate"]) {
      const v = textOf(look(k));
      if (v) rec.keep[k] = v;
    }
    if (subtype === "Square" || subtype === "Circle") {
      if (subtype === "Circle" && cloudy) return skip("cloudy-circle");
      const rd = nums(look("RD"));
      rec.rd = rd && rd.length === 4 && rd.every((v) => Number.isFinite(v) && v >= 0) ? rd : null;
    } else if (subtype === "Line") {
      if (/Dimension$/.test(it || "")) return skip("dimension");
      const ll = num(look("LL"));
      if (Number.isFinite(ll) && ll !== 0) return skip("leader-line");
      const cap = look("Cap");
      if (cap instanceof PDFBool && cap.asBoolean()) return skip("caption");
      const L = nums(look("L"));
      if (!L || L.length !== 4 || !L.every(Number.isFinite)) return skip("geometry");
      rec.L = L;
      const le = look("LE");
      const ends = le instanceof PDFArray ? le.asArray().map((v) => nameOf(doc.context.lookup(v)) || "None") : ["None", "None"];
      rec.ends = [ends[0] || "None", ends[1] || "None"];
    } else if (subtype === "Polygon" || subtype === "PolyLine") {
      if (/Dimension$/.test(it || "")) return skip("dimension");
      const le = look("LE");
      if (le instanceof PDFArray && le.asArray().some((v) => (nameOf(doc.context.lookup(v)) || "None") !== "None")) return skip("line-ends");
      const v = nums(look("Vertices"));
      if (!v || v.length < 4 || v.length % 2 || !v.every(Number.isFinite)) return skip("geometry");
      rec.vertices = v;
      if (it === "PolygonCloud") rec.cloudy = true;
    } else if (subtype === "Ink") {
      const list = look("InkList");
      if (!(list instanceof PDFArray) || !list.size()) return skip("geometry");
      const strokes = list.asArray().map((s) => nums(doc.context.lookup(s)));
      if (strokes.some((s) => !s || s.length < 4 || s.length % 2 || !s.every(Number.isFinite))) return skip("geometry");
      rec.ink = strokes;
    }
    return rec;
  }

  // record → overlay objects in view space (scale-1 viewport units, top-left origin).
  function toObjects(rec, toView) {
    const pt = (x, y) => {
      const [vx, vy] = toView(x, y);
      return { x: vx, y: vy };
    };
    const pairs = (flat) => {
      const out = [];
      for (let k = 0; k + 1 < flat.length; k += 2) out.push(pt(flat[k], flat[k + 1]));
      return out;
    };
    const style = (o) => {
      o.color = rec.color;
      o.width = rec.width;
      return o;
    };
    const withFill = (o) => {
      if (rec.fill) {
        o.fill = rec.fill;
        o.fillOpacity = 1;
      }
      return o;
    };
    const withDash = (o) => {
      if (rec.dashed) o.dash = "dash";
      return o;
    };
    const s = rec.subtype;
    if (s === "Square" || s === "Circle") {
      // The path sits inside /Rect by /RD when given, else by half the border width (the
      // stroke straddles the path; Nabu's box strokes centred on x/y/w/h the same way).
      const h = rec.width / 2;
      const rd = rec.rd || [h, h, h, h];
      const x1 = rec.rect[0] + rd[0], y1 = rec.rect[1] + rd[1], x2 = rec.rect[2] - rd[2], y2 = rec.rect[3] - rd[3];
      if (!(x2 > x1 && y2 > y1)) return { skip: "geometry" };
      const p = pt(x1, y1);
      const q = pt(x2, y2);
      const box = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
      const kind = s === "Circle" ? "ellipse" : rec.cloudy ? "cloud" : "box";
      const o = withFill(style(Object.assign({ kind }, box)));
      return [kind === "cloud" ? o : withDash(o)];
    }
    if (s === "Line") {
      const [a, b] = rec.ends;
      const p = pt(rec.L[0], rec.L[1]);
      const q = pt(rec.L[2], rec.L[3]);
      const headAtEnd = ARROW_ENDS.has(b) && a === "None";
      const headAtStart = ARROW_ENDS.has(a) && b === "None";
      if (headAtEnd || headAtStart) {
        const [t, h] = headAtEnd ? [p, q] : [q, p]; // a Nabu arrow's head is at (x2, y2)
        return [withDash(style({ kind: "arrow", x1: t.x, y1: t.y, x2: h.x, y2: h.y, labelEnd: "head" }))];
      }
      if (a === "None" && b === "None") return [withDash(style({ kind: "poly", pts: [p, q], closed: false }))];
      return { skip: "line-ends" };
    }
    if (s === "Polygon" || s === "PolyLine") {
      const pts = pairs(rec.vertices);
      if (s === "Polygon" && rec.cloudy) {
        if (pts.length < 3) return { skip: "geometry" };
        return [withFill(style({ kind: "cloudpen", pts, closed: true }))];
      }
      // /IC on a PolyLine colours its line endings, not an interior — only a Polygon is filled.
      const o = withDash(style({ kind: "poly", pts, closed: s === "Polygon" }));
      return [s === "Polygon" ? withFill(o) : o];
    }
    if (s === "Ink") {
      // Nabu draws one stroke per object: a multi-stroke Ink becomes several, which planForeign
      // treats as ONE original (all untouched → keep; any change → replace all of them).
      return rec.ink.map((flat) => withDash(style({ kind: "draw", pts: pairs(flat) })));
    }
    return { skip: "subtype" };
  }

  // entries: what importManaged recorded — { key, page, sigs: [serialised overlay copies] }.
  // live:    every live object that carries `_foreign` — { page, a }.
  // An original is untouched iff exactly its copies are still there, on its own page, each with
  // an unchanged serialisation (order-free). Untouched copies are skipped by the bake; every
  // other original is removed and whatever copies remain are written as Nabu annotations.
  function planForeign(entries, live, sigOf) {
    const byKey = new Map();
    for (const l of live) {
      const key = l.a && l.a._foreign && l.a._foreign.fileRef;
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(l);
    }
    const remove = [];
    const skipIds = new Set();
    const keepIds = new Set(); // the pdf.js ids ("12R") of originals left in place
    for (const e of entries || []) {
      const owners = byKey.get(e.key) || [];
      let untouched = owners.length === e.sigs.length && owners.every((o) => o.page === e.page);
      if (untouched) {
        const want = e.sigs.slice().sort();
        const got = owners.map((o) => sigOf(o.a)).sort();
        untouched = want.every((v, k) => v === got[k]);
      }
      if (untouched) {
        for (const o of owners) skipIds.add(o.a.id);
        keepIds.add(e.hideId);
      } else {
        remove.push(e);
      }
    }
    return { remove, skipIds, keepIds };
  }

  // Remove the imported original `e` ({ page, num, gen, subtype, rect, nm }) from `doc`, with its
  // /Popup. Returns false — and changes nothing — unless the annotation found at that object
  // number on that page is the same /Subtype, /Rect and /NM we imported (N2).
  function removeOriginal(PDFLib, doc, e) {
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } = PDFLib;
    const N = (s) => PDFName.of(s);
    const page = doc.getPages()[e.page];
    const arr = page && page.node.Annots();
    if (!arr) return false;
    let at = -1;
    for (let k = 0; k < arr.size(); k++) {
      const r = arr.get(k);
      if (r instanceof PDFRef && r.objectNumber === e.num && r.generationNumber === e.gen) { at = k; break; }
    }
    if (at < 0) return false;
    const ref = arr.get(at);
    const d = doc.context.lookup(ref);
    if (!(d instanceof PDFDict)) return false;
    const st = d.lookup(N("Subtype"));
    if (!(st instanceof PDFName) || st.decodeText() !== e.subtype) return false;
    const r = d.lookup(N("Rect"));
    const rect = r instanceof PDFArray ? r.asArray().map((v) => { const n = doc.context.lookup(v); return n instanceof PDFNumber ? n.asNumber() : NaN; }) : null;
    if (!sameRect(rect, e.rect)) return false;
    const nm = d.lookup(N("NM"));
    const nmText = nm && typeof nm.decodeText === "function" ? nm.decodeText() : null;
    if ((e.nm || null) !== (nmText || null)) return false;

    // Appearance streams are freed only when no other annotation in the document uses them —
    // some tools share one stream between identical marks.
    const apRefs = [];
    const ap = d.lookup(N("AP"));
    if (ap instanceof PDFDict) {
      for (const k of ["N", "R", "D"]) {
        const v = ap.get(N(k));
        if (v instanceof PDFRef) apRefs.push(v);
        const vd = doc.context.lookup(v);
        if (vd instanceof PDFDict && !(v instanceof PDFRef)) for (const [, s] of vd.entries()) if (s instanceof PDFRef) apRefs.push(s);
      }
    }
    const popup = d.get(N("Popup"));
    arr.remove(at);
    if (popup instanceof PDFRef) {
      for (let k = arr.size() - 1; k >= 0; k--) {
        const p = arr.get(k);
        if (p instanceof PDFRef && p.objectNumber === popup.objectNumber && p.generationNumber === popup.generationNumber) arr.remove(k);
      }
      doc.context.delete(popup);
    }
    doc.context.delete(ref);
    if (apRefs.length) {
      const used = new Set();
      for (const pg of doc.getPages()) {
        const a2 = pg.node.Annots();
        if (!a2) continue;
        for (let k = 0; k < a2.size(); k++) {
          const dd = doc.context.lookup(a2.get(k));
          const ap2 = dd instanceof PDFDict ? dd.lookup(N("AP")) : null;
          if (!(ap2 instanceof PDFDict)) continue;
          for (const [, v] of ap2.entries()) {
            if (v instanceof PDFRef) used.add(v.toString());
            const vd = doc.context.lookup(v);
            if (vd instanceof PDFDict) for (const [, s] of vd.entries()) if (s instanceof PDFRef) used.add(s.toString());
          }
        }
      }
      for (const a of apRefs) if (!used.has(a.toString())) doc.context.delete(a);
    }
    return true;
  }

  // The Nabu annotation that replaces an edited original keeps who wrote it and what they said:
  // set on the LAST entry of the page's /Annots (addManagedAnnot just appended it), never over a
  // key Nabu itself wrote.
  function applyKeep(PDFLib, doc, page, keep) {
    const { PDFName, PDFDict, PDFHexString } = PDFLib;
    const arr = page.node.Annots();
    if (!arr || !arr.size() || !keep) return false;
    const d = doc.context.lookup(arr.get(arr.size() - 1));
    if (!(d instanceof PDFDict) || !d.get(PDFName.of("NabuKind"))) return false;
    for (const k of Object.keys(keep)) {
      if (d.get(PDFName.of(k)) === undefined) d.set(PDFName.of(k), PDFHexString.fromText(String(keep[k])));
    }
    return true;
  }

  const api = { SUBTYPES, FLAG_SKIP, normRect, sameRect, replyTargets, readForeign, toObjects, planForeign, removeOriginal, applyKeep };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ForeignAnnot = api;
})();
