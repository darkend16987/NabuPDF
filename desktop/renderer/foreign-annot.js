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
 *      draw. Stamp (3b-2) → an `image` object showing a proxy picture of its own /AP
 *      (stampProxyPdf); a moved / resized stamp gets ONLY its /Rect rewritten (updateRect) —
 *      same object, same appearance, never rasterised (Q1). FreeText / Text / Highlight (group A,
 *      keep their own type — Đợt 3c) are NOT imported here: they stay on the page, painted by
 *      pdf.js, listed in the Chú thích tab, untouchable as before.
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

  const SUBTYPES = new Set(["Square", "Circle", "Line", "Polygon", "PolyLine", "Ink", "Stamp", "FreeText", "Text", "Highlight"]);
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

  // A FreeText's border, as its own appearance draws it: width from /BS /W (or /Border, default
  // 1), colour from the first stroke colour (`r g b RG`) of its /AP — Acrobat keeps the border
  // colour nowhere else. No stroked rectangle in the /AP (or an /AP we cannot decode) → none.
  function borderOf(PDFLib, doc, dict) {
    const { PDFName, PDFDict, PDFArray, PDFNumber } = PDFLib;
    const N = (s) => PDFName.of(s);
    const num = (v) => (v instanceof PDFNumber ? v.asNumber() : NaN);
    let width = NaN;
    const bs = dict.lookup(N("BS"));
    if (bs instanceof PDFDict) width = num(bs.lookup(N("W")));
    if (!Number.isFinite(width)) {
      const b = dict.lookup(N("Border"));
      width = b instanceof PDFArray && b.size() >= 3 ? num(doc.context.lookup(b.get(2))) : 1;
    }
    if (!(width > 0)) return null;
    const ap = dict.lookup(N("AP"));
    const form = ap instanceof PDFDict ? ap.lookup(N("N")) : null;
    if (!(form instanceof PDFLib.PDFRawStream)) return null;
    let ops;
    try {
      const bytes = PDFLib.decodePDFRawStream(form).decode();
      ops = "";
      for (let k = 0; k < bytes.length; k++) ops += String.fromCharCode(bytes[k]);
    } catch (_) {
      return null;
    }
    const rg = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+RG\b/.exec(ops);
    if (!rg || !/\bre\s+[BbSs]\b/.test(ops)) return null;
    const color = AS.colorOf([+rg[1], +rg[2], +rg[3]]);
    return color ? { width, color } : null;
  }

  // The fill alpha an appearance applies through its graphics states (`ca` < 1), 1 if none.
  // Nabu's own highlight writer keeps the wash's alpha THERE with /CA 1 (so the Multiply blend is
  // pinned), and a highlight Nabu rewrote must read back with the alpha it was given.
  function apAlpha(PDFLib, dict) {
    const { PDFName, PDFDict, PDFNumber } = PDFLib;
    const ap = dict.lookup(PDFName.of("AP"));
    const n = ap instanceof PDFDict ? ap.lookup(PDFName.of("N")) : null;
    const res = n && n.dict ? n.dict.lookup(PDFName.of("Resources")) : null;
    const gs = res instanceof PDFDict ? res.lookup(PDFName.of("ExtGState")) : null;
    if (!(gs instanceof PDFDict)) return 1;
    let alpha = 1;
    for (const [, v] of gs.entries()) {
      const g = dict.context.lookup(v);
      const ca = g instanceof PDFDict ? g.lookup(PDFName.of("ca")) : null;
      if (ca instanceof PDFNumber && ca.asNumber() < alpha) alpha = Math.max(0, ca.asNumber());
    }
    return alpha;
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
    // A sticky note's icon is NoZoom + NoRotate by convention (Acrobat writes /F 28): that is how a
    // Nabu note marker behaves too, so for /Text only, NoRotate is no reason to leave it alone.
    const mask = subtype === "Text" ? FLAG_SKIP & ~16 : FLAG_SKIP;
    if (Number.isFinite(flags) && flags & mask) return skip("flags");
    if (dict.get(N("OC"))) return skip("optional-content");
    if (dict.get(N("IRT"))) return skip("reply");
    if (targets && targets.has(raw.toString())) return skip("has-replies");
    const ca = num(look("CA"));
    const rect = normRect(nums(look("Rect")));
    if (!rect) return skip("rect");
    const keepOf = () => {
      const keep = {};
      for (const k of ["T", "Contents", "NM", "Subj", "CreationDate"]) {
        const v = textOf(look(k));
        if (v) keep[k] = v;
      }
      return keep;
    };
    if (subtype === "Stamp") {
      // A stamp is moved / resized / deleted through its /Rect ONLY — its appearance is never
      // re-drawn by Nabu (Q1), so opacity is no obstacle: it stays in the dict it came with.
      // Its own /Rotate (Acrobat's turned stamps) would need the proxy to turn as well — left
      // alone instead.
      const rot = num(look("Rotate"));
      if (Number.isFinite(rot) && rot % 360 !== 0) return skip("rotated-stamp");
      const ap = look("AP");
      if (!(ap instanceof PDFDict)) return skip("no-appearance");
      let n = ap.get(N("N"));
      let form = doc.context.lookup(n);
      if (form instanceof PDFDict && !(form instanceof PDFLib.PDFStream)) {
        // an appearance-state dict: the state /AS names is the one shown
        const as = nameOf(look("AS"));
        n = as ? form.get(N(as)) : undefined;
        form = n !== undefined ? doc.context.lookup(n) : null;
      }
      if (!(form instanceof PDFLib.PDFStream)) return skip("no-appearance");
      const bbox = normRect(nums(form.dict.lookup(N("BBox"))));
      if (!bbox) return skip("no-appearance");
      const m = nums(form.dict.lookup(N("Matrix")));
      return {
        subtype, it: nameOf(look("IT")), rect,
        num: raw.objectNumber, gen: raw.generationNumber, fileRef: raw.toString(),
        nm: textOf(look("NM")), keep: keepOf(),
        ap: n, bbox, matrix: m && m.length === 6 && m.every(Number.isFinite) ? m : [1, 0, 0, 1, 0, 0],
        ca: Number.isFinite(ca) ? Math.max(0, Math.min(1, ca)) : 1,
      };
    }
    if (subtype === "Highlight") {
      // Group A, Đợt 3c-3: an edited highlight stays THIS /Highlight (writeHighlight). Its words
      // are its /QuadPoints; a Nabu tô sáng theo chữ carries exactly that, plus its own alpha.
      const qp = nums(look("QuadPoints"));
      if (!qp || !qp.length || qp.length % 8 || !qp.every(Number.isFinite)) return skip("geometry");
      return {
        subtype, it: nameOf(look("IT")), rect,
        num: raw.objectNumber, gen: raw.generationNumber, fileRef: raw.toString(),
        nm: textOf(look("NM")), keep: keepOf(),
        quads: qp, color: AS.colorOf(nums(look("C"))) || "#ffff00",
        opacity: Math.max(0.05, Math.min(1, (Number.isFinite(ca) ? ca : 1) * apAlpha(PDFLib, dict))),
        text: textOf(look("Contents")) || "",
      };
    }
    if (Number.isFinite(ca) && ca < 0.999) return skip("opacity");

    if (subtype === "Text") {
      // A sticky note (group A, Đợt 3c-2): stays THIS /Text when edited (writeTextNote). One that
      // has replies was already left alone above (has-replies) — a thread is not a Nabu note's
      // reply list, and rewriting the parent would orphan it.
      return {
        subtype, it: nameOf(look("IT")), rect,
        num: raw.objectNumber, gen: raw.generationNumber, fileRef: raw.toString(),
        nm: textOf(look("NM")), keep: keepOf(),
        text: (textOf(look("Contents")) || "").replace(/\r\n?/g, "\n"),
        color: AS.colorOf(nums(look("C"))) || "#ffd54a",
      };
    }
    if (subtype === "FreeText") {
      // Group (A) of Q1: an edited text box stays THIS /FreeText (writeFreeText) so the partner
      // can keep editing it in Acrobat / Foxit. A callout's leader (/CL) would have to move with
      // the box — not this wave. A box turned by its own /Rotate is left alone too.
      const it = nameOf(look("IT"));
      if (it === "FreeTextCallout" || look("CL")) return skip("callout");
      const rot = num(look("Rotate"));
      if (Number.isFinite(rot) && rot % 360 !== 0) return skip("rotated");
      const ds = textOf(look("DS")) || "";
      const da = textOf(look("DA")) || "";
      const text = (textOf(look("Contents")) || AS.plainFromRich(textOf(look("RC")) || "")).replace(/\r\n?/g, "\n");
      if (!text.trim()) return skip("empty");
      const sizeM = /font-size\s*:\s*([\d.]+)\s*pt/i.exec(ds) || /\bfont\s*:[^;]*?([\d.]+)\s*pt/i.exec(ds) || /([\d.]+)\s+Tf\b/.exec(da);
      const size = sizeM && +sizeM[1] > 0 ? +sizeM[1] : 12;
      const q = num(look("Q"));
      const alignM = /text-align\s*:\s*(left|center|right|justify)/i.exec(ds);
      const align = q === 1 ? "center" : q === 2 ? "right" : alignM ? alignM[1].toLowerCase() : "left";
      const rd = nums(look("RD"));
      return {
        subtype, it, rect,
        num: raw.objectNumber, gen: raw.generationNumber, fileRef: raw.toString(),
        nm: textOf(look("NM")), keep: keepOf(),
        rd: rd && rd.length === 4 && rd.every((v) => Number.isFinite(v) && v >= 0) ? rd : null,
        text, size, align,
        color: AS.freeTextColor(ds, da) || "#000000",
        bold: /font-weight\s*:\s*bold/i.test(ds),
        italic: /font-style\s*:\s*italic/i.test(ds),
        fill: AS.colorOf(nums(look("C"))), // /C of a FreeText is its BACKGROUND
        fontRes: (/\/([^\s/()<>[\]{}%]+)\s+[\d.]+\s+Tf\b/.exec(da) || [])[1] || "Helv",
        border: borderOf(PDFLib, doc, dict),
      };
    }

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
      keep: keepOf(),
    };
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
  // `extra.dataUrl`: a Stamp's proxy picture (stampProxyPdf, rendered by the caller).
  function toObjects(rec, toView, extra) {
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
    if (s === "Highlight") {
      const quads = [];
      for (let k = 0; k + 7 < rec.quads.length; k += 8) {
        const ps = [0, 2, 4, 6].map((o) => pt(rec.quads[k + o], rec.quads[k + o + 1]));
        const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
        if (w > 0 && h > 0) quads.push({ x, y, w, h });
      }
      if (!quads.length) return { skip: "geometry" };
      return [{ kind: "texthl", quads, color: rec.color, opacity: rec.opacity, text: rec.text }];
    }
    if (s === "Text") {
      const p = pt(rec.rect[0], rec.rect[1]);
      const q = pt(rec.rect[2], rec.rect[3]);
      return [{ kind: "note", x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y),
                text: rec.text, color: rec.color, replies: [] }];
    }
    if (s === "FreeText") {
      // The text AREA: /Rect minus /RD when given (Acrobat writes half the border there),
      // else minus half the border width.
      const h = rec.border ? rec.border.width / 2 : 0;
      const rd = rec.rd || [h, h, h, h];
      const x1 = rec.rect[0] + rd[0], y1 = rec.rect[1] + rd[1], x2 = rec.rect[2] - rd[2], y2 = rec.rect[3] - rd[3];
      if (!(x2 > x1 && y2 > y1)) return { skip: "geometry" };
      const p = pt(x1, y1);
      const q = pt(x2, y2);
      const o = { kind: "text", x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y),
                  text: rec.text, font: "sans", fontSize: rec.size, color: rec.color,
                  bold: rec.bold, italic: rec.italic, underline: false, align: rec.align };
      if (rec.fill) {
        o.fill = rec.fill;
        o.fillOpacity = 1;
      }
      return [o];
    }
    if (s === "Stamp") {
      // Shown as an image object (move / resize / delete — exactly what a /Rect can say); the
      // picture is only a stand-in drawn from its /AP, never written back for the original.
      if (!extra || typeof extra.dataUrl !== "string") return { skip: "no-proxy" };
      const p = pt(rec.rect[0], rec.rect[1]);
      const q = pt(rec.rect[2], rec.rect[3]);
      return [{ kind: "image", x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y),
                dataUrl: extra.dataUrl, fmt: "png" }];
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
    // What each written copy carries over from its original (applyKeep). /NM is an
    // annotation's unique name, so of several copies of ONE original (a multi-stroke Ink, a
    // stray clone) only the first — lowest id, i.e. the one imported first — takes it.
    const keepFor = new Map();
    const giveKeep = (owners) => {
      owners.slice().sort((p, q) => p.a.id - q.a.id).forEach((o, k) => {
        const keep = Object.assign({}, o.a._foreign.keep || {});
        if (k > 0) delete keep.NM;
        keepFor.set(o.a.id, keep);
      });
    };
    // Stamps whose /Rect the bake rewrites in place (moved / resized; nothing else changes).
    const rects = [];
    const rectIds = new Set();
    // Group-A originals rewritten in place, keeping their own /Subtype (Đợt 3c).
    const inplace = [];
    const inplaceIds = new Set();
    for (const e of entries || []) {
      const owners = byKey.get(e.key) || [];
      if (e.stamp || e.inplace) {
        // ONE object stands for a stamp / a group-A annotation: the one imported (primaryId).
        // Anything else carrying the same original is a copy — written as a new Nabu object,
        // never with the original's /NM.
        const prim = owners.find((o) => o.a.id === e.primaryId);
        for (const o of owners) {
          if (o === prim) continue;
          const keep = Object.assign({}, o.a._foreign.keep || {});
          delete keep.NM;
          keepFor.set(o.a.id, keep);
        }
        if (!prim || prim.page !== e.page) {
          remove.push(e);
          if (prim) giveKeep([prim]); // on another page it can only be written as a picture
        } else if (sigOf(prim.a) === e.sigs[0]) {
          skipIds.add(prim.a.id);
          keepIds.add(e.hideId);
        } else if (e.stamp) {
          rects.push({ entry: e, a: prim.a });
          rectIds.add(prim.a.id);
          // Only drawn when its page is rebuilt from a picture (a redaction on that page): then
          // the Nabu image that stands in for it inherits everything, /NM included.
          giveKeep([prim]);
        } else {
          // Group A (Đợt 3c): rewritten IN PLACE — same object, same /Subtype (writeFreeText…).
          // keepFor is for the fallbacks that draw it as a Nabu object instead (a redacted page,
          // an original N2 no longer recognises).
          inplace.push({ entry: e, a: prim.a });
          inplaceIds.add(prim.a.id);
          giveKeep([prim]);
        }
        continue;
      }
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
        giveKeep(owners);
      }
    }
    return { remove, skipIds, keepIds, keepFor, rects, rectIds, inplace, inplaceIds };
  }

  // The imported original `e` ({ page, num, gen, subtype, rect, nm }) in `doc` — or null unless
  // the annotation at that object number on that page is the same /Subtype, /Rect and /NM we
  // imported (N2).
  function findOriginal(PDFLib, doc, e) {
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } = PDFLib;
    const N = (s) => PDFName.of(s);
    const page = doc.getPages()[e.page];
    const arr = page && page.node.Annots();
    if (!arr) return null;
    let at = -1;
    for (let k = 0; k < arr.size(); k++) {
      const r = arr.get(k);
      if (r instanceof PDFRef && r.objectNumber === e.num && r.generationNumber === e.gen) { at = k; break; }
    }
    if (at < 0) return null;
    const ref = arr.get(at);
    const d = doc.context.lookup(ref);
    if (!(d instanceof PDFDict)) return null;
    const st = d.lookup(N("Subtype"));
    if (!(st instanceof PDFName) || st.decodeText() !== e.subtype) return null;
    const r = d.lookup(N("Rect"));
    const rect = r instanceof PDFArray ? r.asArray().map((v) => { const n = doc.context.lookup(v); return n instanceof PDFNumber ? n.asNumber() : NaN; }) : null;
    if (!sameRect(rect, e.rect)) return null;
    const nm = d.lookup(N("NM"));
    const nmText = nm && typeof nm.decodeText === "function" ? nm.decodeText() : null;
    if ((e.nm || null) !== (nmText || null)) return null;
    return { arr, at, ref, dict: d };
  }

  // A moved / resized stamp: its /Rect — and nothing else — becomes `rect` (PDF user space). The
  // viewer fits the untouched /AP into the new box, so the stamp keeps its own pixels / vectors.
  // False (nothing changed) unless findOriginal recognises it (N2).
  function updateRect(PDFLib, doc, e, rect) {
    const r = normRect(rect);
    const found = r && findOriginal(PDFLib, doc, e);
    if (!found) return false;
    const f4 = (v) => Math.round(v * 10000) / 10000;
    found.dict.set(PDFLib.PDFName.of("Rect"), doc.context.obj(r.map(f4)));
    return true;
  }

  // The appearance streams an annotation's /AP points at (N / R / D, and the states inside a
  // state dict) — what removing or replacing that /AP may leave unreferenced.
  function apRefsOf(PDFLib, doc, dict) {
    const { PDFName, PDFDict, PDFRef } = PDFLib;
    const out = [];
    const ap = dict.lookup(PDFName.of("AP"));
    if (!(ap instanceof PDFDict)) return out;
    for (const k of ["N", "R", "D"]) {
      const v = ap.get(PDFName.of(k));
      if (v instanceof PDFRef) out.push(v);
      const vd = doc.context.lookup(v);
      if (vd instanceof PDFDict && !(vd instanceof PDFLib.PDFStream)) for (const [, x] of vd.entries()) if (x instanceof PDFRef) out.push(x);
    }
    return out;
  }
  // Free those of `refs` no annotation in the document still uses — some tools share one stream
  // between identical marks, and that one must stay.
  function freeUnusedAp(PDFLib, doc, refs) {
    if (!refs.length) return;
    const { PDFDict } = PDFLib;
    const used = new Set();
    for (const pg of doc.getPages()) {
      const a2 = pg.node.Annots();
      if (!a2) continue;
      for (let k = 0; k < a2.size(); k++) {
        const dd = doc.context.lookup(a2.get(k));
        if (dd instanceof PDFDict) for (const r of apRefsOf(PDFLib, doc, dd)) used.add(r.toString());
      }
    }
    for (const r of refs) if (!used.has(r.toString())) doc.context.delete(r);
  }

  // Remove the imported original `e` from `doc`, with its /Popup. Returns false — and changes
  // nothing — unless findOriginal recognises it (N2).
  function removeOriginal(PDFLib, doc, e) {
    const { PDFName, PDFDict, PDFRef } = PDFLib;
    const N = (s) => PDFName.of(s);
    const found = findOriginal(PDFLib, doc, e);
    if (!found) return false;
    const { arr, at, ref, dict: d } = found;

    const apRefs = apRefsOf(PDFLib, doc, d);
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
    freeUnusedAp(PDFLib, doc, apRefs);
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

  // A FreeText wraps its words inside its box; a Nabu text box breaks lines only at "\n". So the
  // imported text is wrapped here, greedily by words (a word wider than the box by characters),
  // with `measure(str)` = width in points as Nabu will draw it. Lines that already fit are left
  // exactly as they are (+1 pt of slack), so text Nabu itself sized is never re-wrapped.
  function wrapText(text, maxWidth, measure) {
    if (!(maxWidth > 0)) return text;
    const fits = (s) => measure(s) <= maxWidth + 1;
    const out = [];
    for (const para of String(text).split("\n")) {
      if (fits(para)) { out.push(para); continue; }
      let line = "";
      for (const word of para.split(/(?<= )/)) { // each word keeps its trailing space
        if (fits(line + word)) { line += word; continue; }
        if (line) { out.push(line.replace(/ +$/, "")); line = ""; }
        if (fits(word)) { line = word; continue; }
        for (const ch of word) {
          if (line && !fits(line + ch)) { out.push(line); line = ""; }
          line += ch;
        }
      }
      out.push(line.replace(/ +$/, ""));
    }
    return out.join("\n");
  }

  // PDF date string for /M ("D:YYYYMMDDHHmmSS+hh'mm'"), in the machine's local time.
  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const a = Math.abs(off);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
  }

  // An edited text box keeps being a /FreeText (Q1, group A): what the partner's Acrobat / Foxit
  // reads to show and to RE-EDIT it is set from the Nabu object — /Contents, /DA (their font
  // resource kept, size + colour ours), /DS, /Q, /C (background), /M. /RC (rich text) is dropped:
  // the box now has one style (the loss Q1 accepted), and a reader falls back to /Contents + /DS.
  // The appearance itself is drawn by the caller (it needs the text rasteriser).
  function freeTextFields(PDFLib, dict, a, ft, now) {
    const fontRes = ft && ft.fontRes;
    // Text the user did not retype goes back EXACTLY as the partner wrote it — without the line
    // breaks the import added to fit the box (wrapText).
    const text = ft && a.text === ft.wrapText ? ft.origText : a.text;
    const { PDFName, PDFHexString, PDFString } = PDFLib;
    const N = (k) => PDFName.of(k);
    const hex = (c) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(c || "");
      const v = m ? m[1] : "000000";
      return [0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16) / 255);
    };
    const f3 = (v) => (Math.round(v * 1000) / 1000).toString();
    const [r, g, b] = hex(a.color);
    const size = +a.fontSize || 12;
    const align = a.align === "center" ? "center" : a.align === "right" ? "right" : "left";
    dict.set(N("Contents"), PDFHexString.fromText(String(text || "").replace(/\n/g, "\r")));
    dict.set(N("DA"), PDFString.of(`/${fontRes || "Helv"} ${f3(size)} Tf ${f3(r)} ${f3(g)} ${f3(b)} rg`));
    const css = [`font: Helvetica ${f3(size)}pt`, `text-align:${align}`, `color:#${(/^#?([0-9a-f]{6})$/i.exec(a.color || "") || [0, "000000"])[1].toUpperCase()}`];
    if (a.bold) css.push("font-weight:bold");
    if (a.italic) css.push("font-style:italic");
    dict.set(N("DS"), PDFHexString.fromText(css.join("; ")));
    dict.set(N("Q"), dict.context.obj(align === "center" ? 1 : align === "right" ? 2 : 0));
    if (a.fill && a.fill !== "none") dict.set(N("C"), dict.context.obj(hex(a.fill)));
    else dict.delete(N("C"));
    dict.delete(N("RC"));
    dict.set(N("M"), PDFString.of(pdfDate(now || new Date())));
  }

  // An edited sticky note stays this /Text (Q1, group A): its words, colour and place (a reply
  // typed in Nabu becomes a separate /IRT reply — replyAnnot). The
  // icon appearance is the partner's: kept when the colour is unchanged (it fits the moved /Rect),
  // dropped when it is not, so Acrobat / Foxit draw their icon in the new colour (and Nabu's view
  // marks every /Text with its own marker anyway). The /Rect is set by the caller.
  function textNoteFields(PDFLib, dict, contents, color, colorChanged, now) {
    const { PDFName, PDFHexString, PDFString } = PDFLib;
    const N = (k) => PDFName.of(k);
    const m = /^#?([0-9a-f]{6})$/i.exec(color || "");
    const v = m ? m[1] : "ffd54a";
    dict.set(N("Contents"), PDFHexString.fromText(String(contents || "").replace(/\n/g, "\r")));
    dict.set(N("C"), dict.context.obj([0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16) / 255)));
    if (colorChanged) dict.delete(N("AP"));
    dict.set(N("M"), PDFString.of(pdfDate(now || new Date())));
  }

// A reply typed in Nabu under a partner's note becomes a REAL reply: its own /Text with /IRT
  // pointing at the note — how Acrobat / Foxit store a thread, so the partner sees it as one —
  // not words folded into their note's /Contents. Fresh /NM; no /T (Nabu has no author name).
  function newNM() {
    const c = typeof globalThis !== "undefined" && globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    return `${h()}${h()}-${h()}-4${h().slice(1)}-${h()}-${h()}${h()}${h()}`;
  }
  function replyAnnot(PDFLib, doc, parentRef, rect, reply, color) {
    const { PDFName, PDFHexString, PDFString } = PDFLib;
    const m = /^#?([0-9a-f]{6})$/i.exec(color || "");
    const v = m ? m[1] : "ffd54a";
    const when = PDFString.of(pdfDate(reply && reply.ts ? new Date(reply.ts) : new Date()));
    return doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Text", Rect: rect, F: 28, Name: PDFName.of("Comment"), Open: false,
      IRT: parentRef, C: [0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16) / 255),
      Contents: PDFHexString.fromText(String((reply && reply.text) || "").replace(/\n/g, "\r")),
      NM: PDFHexString.fromText(newNM()), M: when, CreationDate: when,
    }));
  }

  // A one-page PDF that shows exactly what the viewer shows for a stamp record: its appearance
  // form fitted into /Rect the way the spec says (the form's /BBox through its /Matrix, mapped
  // onto /Rect), with /CA as a graphics state, turned by the page's /Rotate. The caller renders
  // it to a picture for the overlay. Read-only towards `doc`: the form is COPIED (with its
  // resources) into a new document. Resolves to the bytes, or null when the geometry is empty.
  async function stampProxyPdf(PDFLib, doc, rec, rotate) {
    const { PDFDocument, PDFName, PDFRef, PDFObjectCopier } = PDFLib;
    const W = rec.rect[2] - rec.rect[0];
    const H = rec.rect[3] - rec.rect[1];
    if (!(W > 0 && H > 0)) return null;
    const [a, b, c, d, e, f] = rec.matrix;
    const [x0, y0, x1, y1] = rec.bbox;
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const bx0 = Math.min(...xs), by0 = Math.min(...ys);
    const bw = Math.max(...xs) - bx0, bh = Math.max(...ys) - by0;
    if (!(bw > 0 && bh > 0)) return null;
    const sx = W / bw, sy = H / bh;
    const out = await PDFDocument.create();
    const page = out.addPage([W, H]);
    if (rotate) page.setRotation(PDFLib.degrees(((rotate % 360) + 360) % 360));
    const copied = PDFObjectCopier.for(doc.context, out.context).copy(rec.ap);
    page.node.setXObject(PDFName.of("X0"), copied instanceof PDFRef ? copied : out.context.register(copied));
    let gs = "";
    if (rec.ca < 0.999) {
      page.node.setExtGState(PDFName.of("G0"), out.context.obj({ CA: rec.ca, ca: rec.ca }));
      gs = "/G0 gs ";
    }
    const n = (v) => (Math.round(v * 1e6) / 1e6).toFixed(6);
    const ops = `q ${gs}${n(sx)} 0 0 ${n(sy)} ${n(-bx0 * sx)} ${n(-by0 * sy)} cm /X0 Do Q`;
    page.node.set(PDFName.of("Contents"), out.context.register(out.context.stream(ops)));
    return out.save({ useObjectStreams: false });
  }

  const api = { SUBTYPES, FLAG_SKIP, normRect, sameRect, replyTargets, readForeign, toObjects, planForeign,
                findOriginal, updateRect, removeOriginal, applyKeep, stampProxyPdf, apRefsOf, freeUnusedAp, freeTextFields, textNoteFields, replyAnnot, newNM, pdfDate, wrapText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ForeignAnnot = api;
})();
