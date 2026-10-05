"use strict";

/*
 * Nabu PDF — which annotations a page is painted WITHOUT while the editor is open (BI-99).
 *
 * THE PROBLEM IT SOLVES. In edit mode the overlay draws our own round-trip annotations live
 * (importManaged lifts them out of the file), so their baked appearance must not also be painted
 * under them — every text box would show twice, and one the user deleted would linger as pixels.
 * renderPageCanvas used to get that by painting with AnnotationMode.DISABLE, which hides EVERY
 * annotation: a partner's red FreeText, their cloud marks, the values typed into a form all
 * vanished the moment "Chú thích" was pressed (measured on a customer file, docs/RESEARCH-
 * 2026-10-05 §3.4-1). The redaction raster had the same blanket switch (§3.4-3), and there it
 * was worse: the partner's annotations on that page were dropped from the saved file for good.
 *
 * THE MECHANISM. pdf.js 3.11 skips an annotation whose AnnotationStorage entry says
 * `{ noView: true }` (Annotation.mustBeViewed in pdf.worker), and only reads the storage when a
 * page is rendered with AnnotationMode.ENABLE_STORAGE. So we hide by NAME: the pdf.js id of each
 * annotation the overlay owns — "<num>R" / "<num>R<gen>", which is Ref.toString() of the
 * annotation's object reference, the same number pdf-lib sees.
 *
 * "NOT SURE → DO AS BEFORE". An id is only trusted when the page being painted really has that
 * annotation, with the same /Subtype and /Rect we read when we imported it. A list computed from
 * other bytes (a bake renumbers objects; a redaction bake rebuilds the document) fails that check,
 * and so does an annotation stored inline in /Annots (no object number, so pdf.js invents an id).
 * In every such case `plan` answers "all" and the caller paints with DISABLE — exactly the old
 * behaviour, which hides too much but never paints our object twice.
 *
 * The storage entries live only for the length of one synchronous page.render() call: pdf.js
 * snapshots the storage when render() is called (getRenderingIntent → serializable), so they are
 * set, the render is started, and they are removed again before anything else can run. Nothing is
 * left behind on the document for a later render, a print or a thumbnail to trip over.
 *
 * Pure apart from the page/storage objects it is handed; module.exports for the node tests,
 * window.AnnotHide in the renderer (called at run time only — no load-order dependency).
 */

(function () {
  // pdf.js's own spelling of an object reference (class Ref, toString, pdf.worker 3.11.174).
  function refId(num, gen) {
    return gen ? `${num}R${gen}` : `${num}R`;
  }

  function normRect(r) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isFinite(v))) return null;
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }

  function sameRect(a, b) {
    const p = normRect(a);
    const q = normRect(b);
    return !!(p && q) && p.every((v, k) => Math.abs(v - q[k]) < 1e-3);
  }

  // What we remember about one annotation the overlay took ownership of: the entry `plan`
  // checks against the page later. `ref` is the raw /Annots element (a PDFRef normally; an
  // inline PDFDict gets id null, which `plan` treats as "can't hide by name").
  function entryOf(PDFLib, ref, dict) {
    const { PDFRef, PDFName, PDFArray, PDFNumber } = PDFLib;
    const id = ref instanceof PDFRef ? refId(ref.objectNumber, ref.generationNumber) : null;
    const st = dict.get(PDFName.of("Subtype"));
    const subtype = st instanceof PDFName ? st.decodeText() : null;
    let rect = null;
    const arr = dict.lookup(PDFName.of("Rect"));
    if (arr instanceof PDFArray && arr.size() === 4) {
      const nums = arr.asArray().map((v) => {
        const n = dict.context.lookup(v);
        return n instanceof PDFNumber ? n.asNumber() : NaN;
      });
      rect = normRect(nums);
    }
    return { id, subtype, rect };
  }

  // How to paint `page` given the entries the overlay owns on it:
  //   null      nothing of ours here → ordinary ENABLE
  //   [ids…]    hide exactly these (every one verified on this very page)
  //   "all"     can't be sure → DISABLE, the old behaviour
  async function plan(entries, page) {
    if (!entries || !entries.length) return null;
    let shown;
    try {
      shown = await page.getAnnotations();
    } catch (_) {
      return "all";
    }
    const byId = new Map((shown || []).map((a) => [a.id, a]));
    // An inline entry (id null) is never found here either, so it lands on "all" too.
    for (const e of entries) {
      const a = byId.get(e.id);
      if (!a || a.subtype !== e.subtype || !sameRect(a.rect, e.rect)) return "all";
    }
    return [...new Set(entries.map((e) => e.id))];
  }

  // Start page.render with `params` under the plan. Returns pdf.js's RenderTask unchanged, so
  // the caller keeps its cancel/await handling. `storage` is the document's annotationStorage.
  function render(page, params, hide, AnnotationMode, storage) {
    if (!hide) return page.render(Object.assign({}, params, { annotationMode: AnnotationMode.ENABLE }));
    if (hide === "all" || !storage) return page.render(Object.assign({}, params, { annotationMode: AnnotationMode.DISABLE }));
    for (const id of hide) storage.setValue(id, { noView: true });
    try {
      return page.render(Object.assign({}, params, { annotationMode: AnnotationMode.ENABLE_STORAGE }));
    } finally {
      for (const id of hide) storage.remove(id);
    }
  }

  const api = { refId, normRect, sameRect, entryOf, plan, render };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.AnnotHide = api;
})();
