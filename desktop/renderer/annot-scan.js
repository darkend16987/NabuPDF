"use strict";

/*
 * Nabu PDF — read every annotation of a document for the left column's "Chú thích" list
 * (docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md, Đợt 2b). Nabu's own AND
 * those written by other software (Acrobat, PDF-XChange, Foxit…).
 *
 * WHY pdf-lib AND NOT pdf.js. pdf.js's getAnnotations() does not expose /NabuKind, /NabuData
 * or /NM, so to pdf.js a Nabu text box, image or shape is an anonymous /Stamp with no text —
 * it can neither label it nor tell it from a partner's stamp (and in edit mode the list must
 * leave out exactly the ones the overlay already owns). It also drops /IC, /BE, /DS, /RC —
 * which Đợt 3 (importing foreign annotations) needs anyway. So this reads the dicts itself.
 *
 * WHY A WORKER. Measured (2026-10-05): pdf-lib's PDFDocument.load is 18–54 ms on the
 * customer's 10-page drawing set but 2.5–2.9 s on a 400-page / 2 000-annotation file, and
 * pdf-lib runs on whatever thread calls it. On the renderer's thread that is a frozen window
 * every time the list refreshes. So the page starts `new Worker("annot-scan.js")` — THIS
 * file — and the scan runs there; the main-thread call below is only the fallback for a
 * worker that failed to start.
 *
 * ONE FILE, THREE CONTEXTS (and that is why it is one file — test:scope requires every
 * renderer/*.js to be loaded by a page, so a worker-only file would be an orphan):
 *   · a classic <script> in index.html → publishes `window.AnnotScan` (labels, the
 *     fallback scan) and NOTHING else into the shared scope (BI-14);
 *   · a Worker → importScripts pdf-lib, answer {id, bytes} with {id, ok, items};
 *   · node → `module.exports` for test/annot-scan.test.js.
 *
 * READ-ONLY. Nothing here writes to a document.
 */
(function () {
  // Markup annotations a reader would call "a comment". Not listed: Popup (the bubble of a
  // note — it belongs to its parent), Link, Widget (form fields), and the print/3D/media
  // kinds nobody draws by hand.
  const LISTED = new Set([
    "Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Ink",
    "Highlight", "Underline", "StrikeOut", "Squiggly", "Stamp", "Caret",
    "FileAttachment", "Sound", "Redact",
  ]);

  // Labels are Vietnamese SOURCE strings; side-panels.js passes them through tr() at render
  // time, and test/annot-scan.test.js checks every one has an i18n entry.
  // Nabu's own kinds — one per overlay `kind` (editor.js) — whether live or read from a file.
  const KIND_LABEL = {
    text: "Hộp văn bản", note: "Ghi chú", image: "Ảnh / chữ ký", arrow: "Mũi tên",
    box: "Hình chữ nhật", ellipse: "Hình elip", cloud: "Khoanh mây", cloudpen: "Khoanh mây tự do",
    draw: "Nét vẽ tay", poly: "Hình tự do", texthl: "Tô sáng chữ", check: "Dấu ✓", cross: "Dấu ✗",
    highlight: "Tô sáng vùng", redact: "Vùng bôi đen", dim: "Đo kích thước",
  };
  // Other software's annotations, by /Subtype — refined by labelOf() where one subtype means
  // two things to a reader (a /Line with an arrowhead IS an arrow; a /Square with a cloudy
  // border IS a revision cloud — the customer's drawing set has three of those).
  const SUBTYPE_LABEL = {
    Text: "Ghi chú", FreeText: "Hộp văn bản", Line: "Đường kẻ", Square: "Hình chữ nhật",
    Circle: "Hình elip", Polygon: "Đa giác", PolyLine: "Đường gấp khúc", Ink: "Nét vẽ tay",
    Highlight: "Tô sáng", Underline: "Gạch chân", StrikeOut: "Gạch ngang", Squiggly: "Gạch lượn sóng",
    Stamp: "Con dấu / ảnh", Caret: "Dấu chèn", FileAttachment: "Tệp đính kèm", Sound: "Âm thanh",
    Redact: "Vùng chờ bôi đen",
  };
  const EXTRA_LABEL = { callout: "Hộp văn bản có mũi tên", arrow: "Mũi tên", cloud: "Khoanh mây" };

  function labelOf(item) {
    if (item.kind) return KIND_LABEL[item.kind] || item.kind;
    if (item.subtype === "FreeText" && item.it === "FreeTextCallout") return EXTRA_LABEL.callout;
    if ((item.subtype === "Line" || item.subtype === "PolyLine") && item.arrow) return EXTRA_LABEL.arrow;
    if ((item.subtype === "Square" || item.subtype === "Circle" || item.subtype === "Polygon") && item.cloudy) return EXTRA_LABEL.cloud;
    return SUBTYPE_LABEL[item.subtype] || item.subtype || "?";
  }

  // ---- small readers (each tolerant: a malformed value reads as "absent") ----------------

  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  // /C-style colour array (0..1): 1 = gray, 3 = RGB, 4 = CMYK (naive conversion — it is a dot
  // in a list, not a proof). Anything else → null.
  function colorOf(nums) {
    if (!nums || !nums.length || nums.some((n) => typeof n !== "number" || !isFinite(n))) return null;
    if (nums.length === 1) return "#" + hex2(nums[0]).repeat(3);
    if (nums.length === 3) return "#" + nums.map(hex2).join("");
    if (nums.length === 4) {
      const [c, m, y, k] = nums;
      return "#" + [c, m, y].map((v) => hex2((1 - v) * (1 - k))).join("");
    }
    return null;
  }
  // FreeText text colour: /DS "color:#FF0000" (what Acrobat writes — measured on the
  // customer's file, where /DA said "1 1 1 rg" and the text was red), then /DA's "r g b rg".
  function freeTextColor(ds, da) {
    const m = /color\s*:\s*#([0-9a-f]{6})\b/i.exec(ds || "");
    if (m) return "#" + m[1].toLowerCase();
    const r = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg\b/.exec(da || "");
    if (r) return colorOf([+r[1], +r[2], +r[3]]);
    const g = /(-?[\d.]+)\s+g\b/.exec(da || "");
    if (g) return colorOf([+g[1]]);
    return null;
  }
  // "D:20260617114210+07'00'" → "2026-06-17" (the date as written — no timezone maths for a label)
  function dateOf(s) {
    const m = /^D?:?(\d{4})(\d{2})?(\d{2})?/.exec(String(s || "").trim());
    if (!m) return null;
    return `${m[1]}-${m[2] || "01"}-${m[3] || "01"}`;
  }
  // Rich text (/RC, XHTML) → plain text, for a FreeText whose /Contents is empty.
  function plainFromRich(rc) {
    return String(rc || "")
      .replace(/<\?xml[^>]*\?>/g, "")
      .replace(/<(br|\/p|\/div)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
      .trim();
  }
  const clip = (s) => {
    const t = String(s || "").replace(/\r\n?/g, "\n").trim();
    return t.length > 400 ? t.slice(0, 400) + "…" : t;
  };

  /**
   * Every listed annotation of a pdf-lib document → [{ page, ref, subtype, it, kind, text,
   * author, color, rect, date, replies, arrow, cloudy }] in page order, then /Annots order.
   *   kind   — /NabuKind ("text", "note", …) for Nabu's own, else null (= other software)
   *   ref    — "12 0 R", the identity Đợt 3 will use to find the dict again
   *   rect   — normalised [x1, y1, x2, y2] in PDF user space
   * Replies (/IRT, except /RT /Group) are counted onto their parent, not listed; a reply
   * whose parent is not on any page is listed on its own rather than lost. Hidden annots
   * (/F bit 2) are left out — the list shows what the page shows.
   */
  function scanDoc(PDFLib, doc) {
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRef } = PDFLib;
    const N = (s) => PDFName.of(s);
    const nameOf = (v) => (v instanceof PDFName ? v.decodeText() : null);
    const textOf = (v) => (v && typeof v.decodeText === "function" ? v.decodeText() : "");
    const numsOf = (v) => (v instanceof PDFArray ? v.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN)) : null);
    const items = [];
    const byRef = new Map();
    const replies = [];
    doc.getPages().forEach((page, pi) => {
      let arr;
      try {
        arr = page.node.Annots();
      } catch (_) {
        return;
      }
      if (!arr) return;
      for (let j = 0; j < arr.size(); j++) {
        try {
          const raw = arr.get(j);
          const d = doc.context.lookup(raw);
          if (!(d instanceof PDFDict)) continue;
          const subtype = nameOf(d.lookup(N("Subtype")));
          if (!LISTED.has(subtype)) continue;
          const f = d.lookup(N("F"));
          if (f instanceof PDFNumber && f.asNumber() & 2) continue; // Hidden
          const kind = nameOf(d.lookup(N("NabuKind")));
          let data = null;
          if (kind) {
            try {
              data = JSON.parse(textOf(d.lookup(N("NabuData"))));
            } catch (_) {
              data = null; // still listed, labelled by its kind, just without text
            }
          }
          const contents = textOf(d.lookup(N("Contents")));
          let text = contents;
          if (data) text = data.text || data.label || contents;
          else if (!text && subtype === "FreeText") text = plainFromRich(textOf(d.lookup(N("RC"))));

          let color = data && typeof data.color === "string" ? data.color : null;
          if (!color && subtype === "FreeText" && !kind) {
            color = freeTextColor(textOf(d.lookup(N("DS"))), textOf(d.lookup(N("DA"))));
          }
          if (!color) color = colorOf(numsOf(d.lookup(N("C"))));

          const r = numsOf(d.lookup(N("Rect"))) || [0, 0, 0, 0];
          const rect = r.length === 4 && r.every(isFinite)
            ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
            : [0, 0, 0, 0];
          const le = d.lookup(N("LE"));
          const leNames = le instanceof PDFArray ? le.asArray().map(nameOf) : [nameOf(le)];
          const be = d.lookup(N("BE"));
          const item = {
            page: pi,
            ref: raw instanceof PDFRef ? raw.toString() : null,
            subtype,
            it: nameOf(d.lookup(N("IT"))),
            kind,
            text: clip(text),
            author: clip(textOf(d.lookup(N("T")))),
            color,
            rect,
            date: dateOf(textOf(d.lookup(N("M"))) || textOf(d.lookup(N("CreationDate")))),
            replies: 0,
            arrow: leNames.some((n) => /Arrow$/.test(n || "")),
            cloudy: be instanceof PDFDict && nameOf(be.lookup(N("S"))) === "C",
          };
          const irt = d.get(N("IRT"));
          if (irt instanceof PDFRef && nameOf(d.lookup(N("RT"))) !== "Group") {
            replies.push([irt.toString(), item]);
            continue;
          }
          items.push(item);
          if (item.ref) byRef.set(item.ref, item);
        } catch (_) {
          // one malformed annotation must not hide every other one on the page
        }
      }
    });
    for (const [parent, item] of replies) {
      const p = byRef.get(parent);
      if (p) p.replies++;
      else items.push(item);
    }
    return items;
  }

  async function scanAnnots(PDFLib, bytes) {
    const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    return scanDoc(PDFLib, doc);
  }

  const api = { LISTED, KIND_LABEL, SUBTYPE_LABEL, EXTRA_LABEL, labelOf, colorOf, freeTextColor, dateOf, plainFromRich, scanDoc, scanAnnots };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof window !== "undefined") {
    window.AnnotScan = api;
  } else if (typeof importScripts === "function") {
    // Worker. Paths resolve against THIS file's URL (renderer/), like pdf.js's own worker.
    importScripts("vendor/pdf-lib.min.js");
    self.onmessage = async (e) => {
      const { id, bytes } = e.data || {};
      try {
        const items = await scanAnnots(self.PDFLib, new Uint8Array(bytes));
        self.postMessage({ id, ok: true, items, worker: true });
      } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    };
  }
})();
