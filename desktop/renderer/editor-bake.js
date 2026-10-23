"use strict";

/*
 * Nabu PDF — the BAKING half of the overlay editor, lifted out of editor.js.
 *
 * WHAT IS HERE. Everything that turns the editor's live overlay objects into PDF content and
 * back: the PNG rasterisation of text/arrow/watermark/redaction (renderTextPng, renderArrowPng,
 * renderWatermarkPng, rasterRedacted), the managed-annotation round trip (deserializeManaged,
 * addManagedAnnot, importManaged), drawing annotations into pages (drawAnnots, drawOneAnnot,
 * drawWatermark), the two bake paths (bakeInPlace, bakeWithRedaction) and bakePending, which is
 * what Ctrl+S / "Xong" / every tool that needs the document runs first.
 *
 * WHY IT MOVED (docs/PROPOSAL-2026-10-01-split-editor-baking.md). It was 1 100 lines — a fifth
 * of editor.js — with a surprisingly narrow interface: TEN names from the rest of the editor and
 * ONE way out (bakePending, importManaged). It is also the code whose mistakes are silent
 * ("right on screen, wrong in the saved file", BI-40/45/59), so it deserves a file that can be
 * read, diffed and guarded on its own. No behaviour changed: the lines between the BEGIN and END
 * markers below are editor.js's lines, verbatim, INCLUDING their original indentation (that is
 * deliberate, so `git diff --color-moved` shows a pure move; do not "tidy" it in this file's first
 * life — a reformatting commit comes separately, if ever).
 * `node desktop/scripts/prove-bake-move.js --base <rev-before-the-move>` re-checks that claim
 * mechanically, and test/bake-split.test.js pins the interface below.
 *
 * THE INTERFACE — the whole of it:
 *   in   create({ ed, annotsFor, hasAny, clearEdHistory, syncOverlays,
 *                 hexRgb, hexToRgba, dataUrlToBytes, SYMBOL_KINDS, noteThreadText })
 *        `ed` is editor.js's state object. It is a `const` that is never reassigned
 *        (reset() mutates it in place), so holding the reference is exact.
 *   out  { bakePending, importManaged }
 *   plus window.PDFLib (as managed-codec.js takes it), and these classic-script globals, which
 *   must load BEFORE this file (index.html order; test:scope pins it):
 *     annot-text.js     normTextStyle layoutTextBox measureCtx rotatedBox textFont
 *     annot-geom.js     arrowLabelPos isPtsKind TEXTHL_OPACITY cloudPath bumpOf cloudPathPoly symbolStrokes
 *                       dashSpec dashSegments normDash DASH_KINDS   (nét đứt, BI-94)
 *     managed-codec.js  isVectorKind serializeManaged strToBytes pushPageAnnot apRotatable sniffImage
 *                       normAngle apMatrixFor apRectFor NABU_KIND NABU_DATA NABU_SRC shapeAppearance
 *                       managedSrcBytes managedSrcDataUrl makeMap isManagedKind pageRotate
 *                       stripManagedAnnots stripManagedFromPage freeManagedTrash
 *     app.js            state pdfjsLib toast showOverlay hideOverlay rerenderChanged   (used when CALLED, not at load)
 *   and window.desktop / window.DocHistory / window.repaintRenderedPages at call time,
 *   plus window.ManagedCodec.replacedOnBake and window.AnnotHide (annot-hide.js) — what the
 *   overlay owns in the file, hidden while editing (BI-99), and window.ForeignAnnot
 *   (foreign-annot.js) — another program's shapes imported / kept / replaced (BI-100).
 *
 * ORDER OF CONSTRUCTION. editor.js calls create() once, at the spot the block used to occupy.
 * Every name it passes is declared above that spot (function declarations are hoisted; the two
 * consts, SYMBOL_KINDS and ed, are near the top), so nothing is read before it exists.
 */

(function () {
  const PDFLib = window.PDFLib;
  const { PDFDocument, rgb, PDFName, PDFHexString, PDFRawStream, PDFDict, degrees } = PDFLib;

  function create(deps) {
  const { ed, annotsFor, hasAny, clearEdHistory, syncOverlays, hexRgb, hexToRgba, dataUrlToBytes, SYMBOL_KINDS, noteThreadText } = deps;

// ======== BEGIN verbatim block: editor.js "PNG rasterisation for baking" + "baking" ========
  // ---- PNG rasterisation for baking ---------------------------------------

  // ROTATION IS BAKED INTO THE RASTER, not into the annotation's placement — and
  // that choice is the whole reason text rotation could ship without touching the
  // /AP matrix work BI-59 and test:rotate exist to protect. A text box's appearance
  // is ALREADY a PNG (Vietnamese glyphs, no embedded font — see the file header), so
  // turning the glyphs on the canvas costs nothing extra and leaves the annotation
  // itself an ordinary axis-aligned stamp. apMatrixFor / apRectFor keep meaning only
  // "the page is rotated", which is the one thing they were measured for.
  //
  // The watermark rasteriser next door has done exactly this since v0.1 — same
  // |w·cos|+|h·sin| growth, same anti-clockwise sign. This is that, generalised.
  //
  // `ox` / `oy` are how much the rotated raster's top-left sits ABOVE and LEFT of
  // where the unrotated one would have been (both ≤ 0, since the box only grows).
  // Callers add them to the anchor they already computed, so at rot 0 they are 0 and
  // every existing call site is byte-for-byte unchanged.
  function renderTextPng(text, fontSizePt, colorHex, opts) {
    const RS = window.AnnotText.TEXT_RS; // supersample for crisp text (3)
    const s = normTextStyle(opts);
    const fpx = fontSizePt * RS;
    // Same layout the on-screen box was measured with (fpx=sizePt*RS, upp=RS).
    const lay = layoutTextBox(text, s, measureCtx(), fpx, RS);
    // The raster's rectangle — the very arithmetic the overlay's border reads back
    // (annot-text.js textRasterBoxPt), so the two cannot drift (BI-40).
    const { pad, cw, chh } = window.AnnotText.textRasterGeom(lay.width, lay.height, fpx);
    // The canvas is the TURNED box; the glyphs are laid out in the untouched one and
    // the context is rotated about the shared centre. Ceil, so a half-pixel of the
    // turned box is never clipped away.
    const rb = rotatedBox(cw, chh, s.rot);
    const bw = s.rot ? Math.ceil(rb.w) : cw;
    const bh = s.rot ? Math.ceil(rb.h) : chh;
    const c = document.createElement("canvas");
    c.width = bw;
    c.height = bh;
    const cx = c.getContext("2d");
    if (s.rot) {
      // Canvas rotate() is clockwise for a positive angle and our convention is
      // anti-clockwise (annot-text.js normRot), hence the minus — the same line the
      // watermark rasteriser uses.
      cx.translate(bw / 2, bh / 2);
      cx.rotate((-s.rot * Math.PI) / 180);
      cx.translate(-cw / 2, -chh / 2);
    }
    // Background wash, before any glyph and INSIDE the rotated frame so it turns with the
    // text. `cw x chh` is the whole unrotated canvas — padding included on all four sides
    // — which is exactly the rectangle the overlay's underlay draws (see renderAnnot).
    //
    // Read off `opts` (the annot) rather than `s`: normTextStyle builds a fresh object
    // from a fixed field list and drops fill/fillOpacity by design, which is also what
    // keeps a background from ever reaching layoutTextBox and moving a glyph.
    //
    // globalAlpha carries s.opacity and the rectangle's own alpha rides in the rgba()
    // colour, so the two multiply. That is not a flourish: on screen the element's
    // `opacity` (applyTextCss) dims background and glyphs together, so a raster that
    // painted the wash at full strength would look right on screen and wrong in the
    // saved file — BI-40. save/restore keeps the rotation for the glyph loop below.
    const bgFill = opts && opts.fill && opts.fill !== "none" ? opts.fill : null;
    if (bgFill) {
      cx.save();
      cx.globalAlpha = s.opacity;
      cx.fillStyle = hexToRgba(bgFill, opts.fillOpacity != null ? opts.fillOpacity : 1);
      cx.fillRect(0, 0, cw, chh);
      cx.restore();
    }
    // Viền khung: on the SAME rectangle as the wash, stroked INSIDE it (half the pen in
    // from each edge) so the raster never has to grow — an unbordered box keeps exactly
    // the canvas it always had. After the wash, before any glyph; in the rotated frame;
    // dimmed by the text opacity like everything else on this canvas. The dash pattern is
    // annot-geom.js dashSpec — the one the overlay's <svg> border reads too.
    const bd = window.AnnotText.normTextBorder(opts);
    if (bd) {
      const lw = bd.width * RS;
      cx.save();
      cx.globalAlpha = s.opacity;
      cx.strokeStyle = bd.color;
      cx.lineWidth = lw;
      const ds = dashSpec(bd.dash, bd.width);
      if (ds) {
        cx.setLineDash(ds.array.map((v) => v * RS));
        cx.lineCap = ds.cap;
      }
      cx.strokeRect(lw / 2, lw / 2, Math.max(0.01, cw - lw), Math.max(0.01, chh - lw));
      cx.restore();
    }
    cx.font = textFont(fpx, s);
    cx.fillStyle = colorHex;
    cx.strokeStyle = colorHex;
    cx.textBaseline = "top";
    cx.globalAlpha = s.opacity;
    // Draw every glyph at its laid-out position; horizontal char-scale is applied
    // per glyph (translate → scaleX → fillText) so advances and drawing agree.
    for (const op of lay.ops) {
      cx.save();
      cx.translate(pad + op.x, pad + op.y);
      if (s.charScale !== 1) cx.scale(s.charScale, 1);
      cx.fillText(op.ch, 0, 0);
      cx.restore();
    }
    // Underline / strikethrough — canvas has neither; draw them from the engine's
    // decoration spans (already in scaled units).
    if (lay.decos.length) {
      cx.lineWidth = Math.max(1, fpx * 0.06);
      for (const d of lay.decos) {
        cx.beginPath();
        cx.moveTo(pad + d.x0, pad + d.y);
        cx.lineTo(pad + d.x1, pad + d.y);
        cx.stroke();
      }
    }
    return {
      bytes: dataUrlToBytes(c.toDataURL("image/png")),
      wPt: bw / RS, hPt: bh / RS,
      ox: (cw - bw) / 2 / RS, oy: (chh - bh) / 2 / RS,
    };
  }

  // Rasterise a whole arrow (line + filled head + optional label) to a PNG, for a
  // managed /Stamp appearance. Mirrors the on-screen SVG geometry so the appearance
  // matches the overlay. Returns the PNG bytes, its size in points, and the
  // overlay-space (y-down, scale-1) coordinate of its top-left corner (`ox,oy`) so
  // the caller can map it to the page exactly like the text Stamp does.
  function renderArrowPng(a) {
    const RS = 3; // supersample for crisp lines/text
    const w = a.width || 2;
    const hl = Math.max(8, w * 4); // head length
    const ha = Math.PI / 7; // head half-angle
    const fs = a.labelSize || 14;
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    // Filled-head tips (overlay points), same as the on-screen SVG.
    const p1 = { x: a.x2 - hl * Math.cos(ang - ha), y: a.y2 - hl * Math.sin(ang - ha) };
    const p2 = { x: a.x2 - hl * Math.cos(ang + ha), y: a.y2 - hl * Math.sin(ang + ha) };
    const pts = [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, p1, p2];

    // Label block (measured with the same default font renderTextPng/measureText use).
    const lines = a.label ? String(a.label).split("\n") : [];
    let lblW = 0, lp = null;
    if (lines.length) {
      const mctx = measureCtx();
      mctx.font = textFont(fs);
      for (const ln of lines) lblW = Math.max(lblW, mctx.measureText(ln || " ").width);
      const lblH = fs * 1.3 * lines.length;
      lp = arrowLabelPos(a, a.x1, a.y1, a.x2, a.y2, ang, hl, fs);
      pts.push({ x: lp.x - lblW / 2, y: lp.y - lblH / 2 });
      pts.push({ x: lp.x + lblW / 2, y: lp.y + lblH / 2 });
    }

    const pad = w + 2;
    const minX = Math.min(...pts.map((q) => q.x)) - pad;
    const minY = Math.min(...pts.map((q) => q.y)) - pad;
    const maxX = Math.max(...pts.map((q) => q.x)) + pad;
    const maxY = Math.max(...pts.map((q) => q.y)) + pad;
    const wPt = Math.max(1, maxX - minX);
    const hPt = Math.max(1, maxY - minY);

    const c = document.createElement("canvas");
    c.width = Math.ceil(wPt * RS);
    c.height = Math.ceil(hPt * RS);
    const cx = c.getContext("2d");
    const X = (x) => (x - minX) * RS;
    const Y = (y) => (y - minY) * RS;
    // Shaft.
    cx.strokeStyle = a.color;
    cx.lineWidth = w * RS;
    cx.lineCap = "round";
    cx.lineJoin = "round";
    // Nét đứt: the shaft only, scaled with the supersample like every other length here.
    // Cleared straight after the stroke so nothing later inherits the pattern.
    const dsAr = dashSpec(a.dash, a.width);
    if (dsAr) { cx.setLineDash(dsAr.array.map((v) => v * RS)); cx.lineCap = dsAr.cap; }
    cx.beginPath();
    cx.moveTo(X(a.x1), Y(a.y1));
    cx.lineTo(X(a.x2), Y(a.y2));
    cx.stroke();
    if (dsAr) cx.setLineDash([]);
    // Filled arrowhead.
    cx.fillStyle = a.color;
    cx.beginPath();
    cx.moveTo(X(a.x2), Y(a.y2));
    cx.lineTo(X(p1.x), Y(p1.y));
    cx.lineTo(X(p2.x), Y(p2.y));
    cx.closePath();
    cx.fill();
    // Label text, centred on lp (matches the SVG's middle/central anchoring).
    if (lines.length) {
      cx.font = textFont(fs * RS);
      cx.fillStyle = a.color;
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      const lhpx = fs * 1.3 * RS;
      const top = Y(lp.y) - (lhpx * lines.length) / 2 + lhpx / 2;
      lines.forEach((ln, k) => cx.fillText(ln, X(lp.x), top + k * lhpx));
    }
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt, hPt, ox: minX, oy: minY };
  }

  function renderWatermarkPng(wm) {
    const RS = 2;
    const ctx = measureCtx();
    const fpx = wm.size * RS;
    ctx.font = textFont(fpx);
    const tw = Math.max(1, ctx.measureText(wm.text || " ").width);
    const th = fpx * 1.25;
    const ang = (-wm.angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(ang));
    const sin = Math.abs(Math.sin(ang));
    const bw = Math.ceil(tw * cos + th * sin) + 4;
    const bh = Math.ceil(tw * sin + th * cos) + 4;
    const c = document.createElement("canvas");
    c.width = bw;
    c.height = bh;
    const cx = c.getContext("2d");
    cx.translate(bw / 2, bh / 2);
    cx.rotate(ang);
    cx.font = textFont(fpx);
    cx.fillStyle = wm.color;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(wm.text, 0, 0);
    return { bytes: dataUrlToBytes(c.toDataURL("image/png")), wPt: bw / RS, hPt: bh / RS };
  }

  async function rasterRedacted(i, redacts, vp1, keepIds) {
    const page = await state.pdf.getPage(i + 1);
    const RS = 2; // ~144 dpi
    const vp = page.getViewport({ scale: RS });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const cx = c.getContext("2d");
    // A page that carries round-trip annots of ours must be rasterised WITHOUT
    // them. importManaged lifted them into ed.annots and this bake writes them
    // back as stamps, so burning their old appearance in as well would show every
    // text box / image on the page TWICE — and a round-trip object the user had just
    // deleted would come back as un-removable pixels.
    //
    // Without THEM — not without every annotation (BI-99). This used to be DISABLE for
    // the whole page whenever it held one of ours, and the page is rebuilt from this
    // picture alone: a partner's FreeText / cloud / form value on the same page was not
    // burned in and was not copied either — gone from the saved file (RESEARCH-2026-10-05
    // §3.4-3). Now every other annotation becomes pixels, exactly as on a page with none
    // of ours. ed._owned is the same list edit mode hides on screen; one that no longer
    // matches this page plans "all" → DISABLE, the old behaviour.
    // `keepIds`: imported partner annotations the user left alone (BI-100) — they stay in the
    // picture like any other partner annotation; only edited / deleted ones are left out.
    const owned = (ed._owned.get(i) || []).filter((e) => !(keepIds && keepIds.has(e.id)));
    const hide = await window.AnnotHide.plan(owned, page);
    await window.AnnotHide.render(page, { canvasContext: cx, viewport: vp }, hide,
      pdfjsLib.AnnotationMode, state.pdf.annotationStorage).promise;
    // Burn each box in *its own* colour so the original pixels are gone for good.
    for (const r of redacts) {
      cx.fillStyle = r.color || "#000";
      cx.fillRect(r.x * RS, r.y * RS, r.w * RS, r.h * RS);
    }
    return dataUrlToBytes(c.toDataURL("image/png"));
  }

  // ---- baking --------------------------------------------------------------

  // Editable payload stored in /NabuData so a re-opened file reconstructs the
  // overlay object. Geometry travels here too (not just the /Rect) so retyping /
  // restyling is lossless.
  // `src` is only used by the image kind: the data URL rebuilt from /NabuSrc (see
  // managedSrcBytes). Every other kind is fully described by `data` alone.
  function deserializeManaged(data, src) {
    if (!data || !data.k) return null;
    if (data.k === "text") {
      if (!data.text) return null;
      // normTextStyle fills defaults for any field an older file didn't store.
      const s = normTextStyle(data);
      const a = { id: ed.seq++, kind: "text", x: +data.x || 0, y: +data.y || 0,
               w: +data.w || 1, h: +data.h || 1, text: String(data.text),
               font: data.font || "sans", fontSize: +data.fontSize || 16,
               color: data.color || "#000000", bold: !!data.bold,
               italic: !!data.italic, underline: !!data.underline,
               strike: s.strike, align: s.align, lineHeight: s.lineHeight,
               paraSpacing: s.paraSpacing, letterSpacing: s.letterSpacing,
               wordSpacing: s.wordSpacing, charScale: s.charScale,
               indent: s.indent, listType: s.listType, opacity: s.opacity,
               // normTextStyle already normalised it into (-180, 180]; a payload
               // written before rotation existed has no `rot` and reads 0.
               rot: s.rot,
               _managed: true };
      // Background. Left OFF the object entirely when the payload has no `fill`, rather
      // than set to "none" — renderAnnot and renderTextPng both test
      // `a.fill && a.fill !== "none"`, and an absent key is the shape a box written
      // before backgrounds existed has. Same arm the vector branch below uses.
      if (data.fill && data.fill !== "none") {
        a.fill = data.fill;
        a.fillOpacity = data.fillOpacity != null ? +data.fillOpacity : 1;
      }
      // Fixed-width box: left off a point box, the same arm as the background above.
      if (s.boxW > 0) a.boxW = s.boxW;
      // Viền khung: same arm again — keys only for a box that has one.
      const bd = window.AnnotText.normTextBorder(data);
      if (bd) {
        a.borderColor = bd.color;
        a.borderWidth = bd.width;
        if (bd.dash !== "solid") a.borderDash = bd.dash;
      }
      return a;
    }
    if (data.k === "arrow") {
      const arrow = { id: ed.seq++, kind: "arrow",
               x1: +data.x1 || 0, y1: +data.y1 || 0, x2: +data.x2 || 0, y2: +data.y2 || 0,
               color: data.color || "#ffd54a", width: +data.width || 2,
               label: data.label ? String(data.label) : undefined,
               labelEnd: data.labelEnd === "tail" ? "tail" : "head",
               labelSize: +data.labelSize || 14, _managed: true };
      // Left OFF the object when absent/unknown (= solid), like `fill` below: an absent key
      // is the shape a file written before line styles existed reads as.
      if (normDash(data.dash) !== "solid") arrow.dash = normDash(data.dash);
      return arrow;
    }
    if (isVectorKind(data.k)) {
      // No `fill` key at all ⇒ stroke-only, which is also how a file written before
      // shapes round-tripped reads. `fill` is left OFF the object rather than set to
      // "none": renderAnnot and drawOneAnnot both test `a.fill && a.fill !== "none"`,
      // and an absent key is the shape a freshly-drawn stroke-only box has.
      const a = { id: ed.seq++, kind: data.k,
                  // A LITERAL, and never the remembered default colour — test:defaults
                  // enforces that (by substring, comments included) and it is right to:
                  // the remembered one is a live preference, so reading it here would
                  // silently re-colour every shape in an old file the day the user changes
                  // it. Black matches the text branch's fallback, and the branch is
                  // unreachable in practice anyway (serializeManaged always writes `color`);
                  // it exists so a hand-edited /NabuData still draws something visible.
                  color: data.color || "#000000", width: +data.width || 2,
                  _managed: true };
      if (isPtsKind(data.k)) {
        // Junk points are dropped rather than tolerated: a NaN reaches cloudPathPoly's
        // Math.hypot, poisons the whole perimeter length and the cloud renders nowhere.
        const pts = (Array.isArray(data.pts) ? data.pts : [])
          .filter((p) => p && isFinite(+p.x) && isFinite(+p.y))
          .map((p) => ({ x: +p.x, y: +p.y }));
        // Below the minimum its own path builder needs, the object is an invisible,
        // unselectable ghost in ed.annots that a re-bake would silently drop. Refuse
        // the import instead. A cloud needs 3 (cloudPathPoly closes a loop); an open
        // stroke needs 2 (strokePath).
        // A `poly` needs 2 like a stroke: "để hở" is one of the two shapes it draws, and
        // an open one is a polyline.
        if (pts.length < (data.k === "cloudpen" ? 3 : 2)) return null;
        a.pts = pts;
        // Always true for a cloudpen: the only one a writer can put in a file is a
        // CLOSED scallop loop (cloudPathPoly emits `Z` unconditionally), and renderAnnot
        // draws the open, still-being-clicked polygon down a different path entirely.
        // A `draw` is never closed — leave the flag off.
        // A `poly` remembers which it was; a payload from a writer that omitted the key
        // reads as OPEN, which is the shape that draws something either way.
        if (data.k === "cloudpen") a.closed = true;
        else if (data.k === "poly") a.closed = !!data.closed;
      } else {
        a.x = +data.x || 0; a.y = +data.y || 0;
        a.w = +data.w || 1; a.h = +data.h || 1;
      }
      // Absent ⇒ leave `bump` off so bumpOf() falls back to the historical default,
      // which is exactly how a cloud drawn before the size control behaves.
      if (+data.bump) a.bump = +data.bump;
      if (data.fill && data.fill !== "none") {
        a.fill = data.fill;
        a.fillOpacity = data.fillOpacity != null ? +data.fillOpacity : 1;
      }
      // Only the kinds that can carry a pattern; a cloud with a stray `dash` key stays solid.
      if (DASH_KINDS.has(data.k) && normDash(data.dash) !== "solid") a.dash = normDash(data.dash);
      return a;
    }
    if (data.k === "texthl") {
      // Junk quads are dropped rather than tolerated — a NaN here would put a line of
      // the wash somewhere impossible and drag the whole mark's bound with it. An empty
      // list means there is nothing to show OR select, so the import is refused and the
      // /Highlight in the file is left alone (the same contract as an image with no
      // recoverable bytes).
      const quads = (Array.isArray(data.quads) ? data.quads : [])
        .filter((q) => q && isFinite(+q.x) && isFinite(+q.y) && +q.w > 0 && +q.h > 0)
        .map((q) => ({ x: +q.x, y: +q.y, w: +q.w, h: +q.h }));
      if (!quads.length) return null;
      return { id: ed.seq++, kind: "texthl", quads,
               // A literal fallback, never ed.highlightColor — same rule as the vector
               // branch above, and test:defaults enforces it.
               color: data.color || "#ffd54a",
               opacity: data.opacity != null ? +data.opacity : 0.4,
               text: String(data.text || ""), _managed: true };
    }
    if (data.k === "note") {
      return { id: ed.seq++, kind: "note", x: +data.x || 0, y: +data.y || 0,
               w: +data.w || 18, h: +data.h || 18, text: String(data.text || ""),
               color: data.color || "#ffd54a",
               replies: Array.isArray(data.replies) ? data.replies : [], _managed: true };
    }
    if (data.k === "image") {
      // No usable source bytes → refuse the import. stripManagedFromPage makes the
      // same call and refuses to remove it, so the image survives as a plain stamp
      // instead of being silently deleted on the next bake.
      if (!src) return null;
      const img = { id: ed.seq++, kind: "image", x: +data.x || 0, y: +data.y || 0,
               w: +data.w || 1, h: +data.h || 1,
               dataUrl: src, fmt: data.fmt === "jpg" ? "jpg" : "png", _managed: true };
      // Xoay / lật (BI-116): keys left OFF an untouched image, the same arm as `fill` / `dash`
      // above — an absent key is the shape a picture written before this existed reads as.
      // Through window.AnnotGeom, not a new bare name (BI-14) — the same door normTextBorder uses.
      const irot = window.AnnotGeom.normImgRot(data.rot);
      if (irot) img.rot = irot;
      if (data.flipH === true) img.flipH = true;
      if (data.flipV === true) img.flipV = true;
      return img;
    }
    return null;
  }

  // Attach `ref` to the page's /Annots array, creating it if absent.
  // Write one managed annotation (text Stamp with image /AP, or note Text annot)
  // into `page`, tagged with /NabuData. Returns true if it was written as a real
  // annotation; false means the caller should fall back to flattening (only text /
  // arrow / image on a rotated page).
  //
  // `share` is a per-bake Map (dataUrl → {imgRef, srcRef}) so the same picture
  // placed on many pages by "Áp ảnh/chữ ký cho nhiều trang" is embedded ONCE. That
  // is safe to share only because every managed annot is stripped in the same pass
  // before a re-bake — see stripManagedAnnots' deferred delete.
  async function addManagedAnnot(doc, page, a, map, share) {
    const ctx = doc.context;
    const dataHex = PDFHexString.fromText(JSON.stringify(serializeManaged(a)));
    // A page carrying /Rotate needs the appearance placed through /Matrix + a
    // re-derived /Rect (managed-codec.js apMatrixFor/apRectFor). Anything that is not
    // a clean quarter turn still falls through to flattening. BI-59.
    const angle = page.getRotation().angle;
    // Tô sáng theo chữ — the only managed kind that is NOT a /Stamp.
    //
    // It goes in as a real /Highlight with /QuadPoints, so every other PDF reader treats
    // it as the highlight it is: Acrobat and Foxit list it in the comment pane with the
    // marked words (/Contents), and a reader that wants to re-derive an appearance has
    // the quads to do it from. We still write our OWN /AP, because that is the only way
    // to pin the BLEND: a synthesised highlight may paint opaque over the glyphs, and
    // the whole point of multiply is that the text underneath stays black (see the
    // measurement in docs/RESEARCH-2026-09-20c §3.4).
    //
    // EVERY QUAD IS MAPPED BY ITS OWN TWO CORNERS. That is what makes this correct on a
    // rotated page for free — BI-45's rule, the same one the flattened rectangle path
    // relies on — and it is why the /AP is a form whose BBox is the union box in USER
    // space rather than a local coordinate system needing a /Matrix.
    if (a.kind === "texthl") {
      const qs = (a.quads || []).filter((q) => q && q.w > 0 && q.h > 0);
      if (!qs.length) return true; // nothing to draw, and nothing to flatten either
      const mapped = qs.map((q) => {
        const [x1, y1] = map(q.x, q.y);
        const [x2, y2] = map(q.x + q.w, q.y + q.h);
        return { x0: Math.min(x1, x2), y0: Math.min(y1, y2),
                 x1: Math.max(x1, x2), y1b: Math.max(y1, y2) };
      });
      const bx0 = Math.min(...mapped.map((m) => m.x0));
      const by0 = Math.min(...mapped.map((m) => m.y0));
      const bx1 = Math.max(...mapped.map((m) => m.x1));
      const by1 = Math.max(...mapped.map((m) => m.y1b));
      const col = hexRgb(a.color);
      const alpha = a.opacity != null ? a.opacity : TEXTHL_OPACITY;
      // The form's own space is the union box translated to 0,0 — a pure translation, so
      // no /Matrix is involved and a rotated page needs no special case.
      const ops = ["q", "/NabuHL gs",
        `${col.red.toFixed(4)} ${col.green.toFixed(4)} ${col.blue.toFixed(4)} rg`]
        .concat(mapped.map((m) =>
          `${(m.x0 - bx0).toFixed(2)} ${(m.y0 - by0).toFixed(2)} ` +
          `${(m.x1 - m.x0).toFixed(2)} ${(m.y1b - m.y0).toFixed(2)} re f`))
        .concat(["Q"]).join("\n");
      const apDict = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, bx1 - bx0, by1 - by0],
        Resources: {
          ExtGState: { NabuHL: { Type: "ExtGState", BM: PDFName.of("Multiply"), ca: alpha } },
        },
      };
      const apStream = PDFRawStream.of(ctx.obj(apDict), strToBytes(ops));
      // PDF quad order is TL, TR, BL, BR — what Acrobat writes, which is not the order
      // the spec's prose implies. Readers follow Acrobat.
      const quadPoints = [];
      for (const m of mapped) quadPoints.push(m.x0, m.y1b, m.x1, m.y1b, m.x0, m.y0, m.x1, m.y0);
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Highlight", F: 4,
        Rect: [bx0, by0, bx1, by1],
        QuadPoints: quadPoints,
        C: [col.red, col.green, col.blue],
        CA: 1, // the wash's alpha lives in the ExtGState, not here — see the note above
        Contents: PDFHexString.fromText(a.text || ""),
        AP: { N: ctx.register(apStream) },
      });
      annot.set(PDFName.of("NabuKind"), PDFName.of(a.kind));
      annot.set(PDFName.of("NabuData"), dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (a.kind === "image") {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      const bytes = dataUrlToBytes(a.dataUrl);
      const fmt = a.fmt || sniffImage(bytes);
      if (!fmt) return false; // unknown format — flatten (drawOneAnnot sniffs again)
      const cached = share && share.get(a.dataUrl);
      let imgRef;
      let srcRef;
      if (cached) {
        imgRef = cached.imgRef;
        srcRef = cached.srcRef;
      } else {
        const img = fmt === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        imgRef = img.ref;
        // The ORIGINAL file bytes, verbatim, in a private FILTERLESS stream. They
        // cannot be recovered from the /AP image (pdf-lib re-encodes a PNG into raw
        // samples + an /SMask, throwing the container away), and neither string
        // carrier pdf-lib offers works here — measured on the shipped 1.17.1:
        //   · a /NabuData-style hex string costs ~1.46x the image and takes >1s to
        //     write for 1 MB, a literal string ~1.02x;
        //   · and BOTH PDFHexString.decodeText and PDFString.decodeText throw
        //     RangeError above ~150 KB (they spread the whole buffer through
        //     String.fromCharCode), so a signature PNG would be unreadable anyway.
        // A raw stream is 1.00x, ~5 ms for 2 MB, and reads back as bytes already.
        srcRef = ctx.register(PDFRawStream.of(ctx.obj({ NabuFmt: fmt }), bytes));
        if (share) share.set(a.dataUrl, { imgRef: imgRef, srcRef: srcRef });
      }
      const [bx, by] = map(a.x, a.y + a.h); // lower-left, the same anchor the flattened path uses
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, a.w, a.h],
        Resources: { XObject: { NabuImg: imgRef } },
      };
      // No /Matrix at all on an unrotated page: identical bytes to before BI-59.
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(`q ${f(a.w)} 0 0 ${f(a.h)} 0 0 cm /NabuImg Do Q`));
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, a.w, a.h, bx, by),
        AP: { N: ctx.register(apStream) },
      });
      annot.set(NABU_KIND, PDFName.of("image"));
      annot.set(NABU_DATA, dataHex);
      annot.set(NABU_SRC, srcRef);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (a.kind === "text") {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      // Pass the whole annot as the style so alignment / spacing / lists / scale /
      // opacity all bake in (normTextStyle picks the fields it needs).
      const { bytes, wPt, hPt, ox, oy } = renderTextPng(a.text, a.fontSize, a.color, a);
      const img = await doc.embedPng(bytes);
      const padPt = a.fontSize * 0.15;
      // Lower-left, matching the flattened path line for line — including `ox`/`oy`,
      // which are the margin a rotated raster grew by (0 when upright). The /AP itself
      // stays axis-aligned: the glyphs are already turned inside the PNG, so `/Matrix`
      // keeps meaning ONLY the page rotation. See renderTextPng.
      const [bx, by] = map(a.x - padPt + ox, a.y - padPt + oy + hPt);
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, wPt, hPt],
        Resources: { XObject: { NabuImg: img.ref } },
      };
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(`q ${f(wPt)} 0 0 ${f(hPt)} 0 0 cm /NabuImg Do Q`));
      const apRef = ctx.register(apStream);
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, wPt, hPt, bx, by),
        AP: { N: apRef },
      });
      annot.set(NABU_KIND, PDFName.of("text"));
      annot.set(NABU_DATA, dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (a.kind === "arrow") {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      const { bytes, wPt, hPt, ox, oy } = renderArrowPng(a);
      const img = await doc.embedPng(bytes);
      const [bx, by] = map(ox, oy + hPt); // overlay top-left → PDF lower-left, like text
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, wPt, hPt],
        Resources: { XObject: { NabuImg: img.ref } },
      };
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(`q ${f(wPt)} 0 0 ${f(hPt)} 0 0 cm /NabuImg Do Q`));
      const apRef = ctx.register(apStream);
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, wPt, hPt, bx, by),
        AP: { N: apRef },
      });
      annot.set(NABU_KIND, PDFName.of("arrow"));
      annot.set(NABU_DATA, dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    if (isVectorKind(a.kind)) {
      if (!apRotatable(angle)) return false; // /Rotate 45 & friends keep flattening
      const shape = shapeAppearance(
        a,
        hexRgb(a.color),
        a.fill && a.fill !== "none" ? hexRgb(a.fill) : null,
        a.fillOpacity != null ? a.fillOpacity : 1
      );
      // A freehand cloud with fewer than 3 distinct points has no path at all. Falling
      // through to drawOneAnnot is the honest answer: it asks cloudPathPoly the same
      // question, gets the same null, and draws nothing — so the two writers agree.
      if (!shape) return false;
      // ONE anchor line for all four kinds: shapeAppearance already resolved the form's
      // overlay bottom-left, padding rule and all. Re-deriving it per kind here is four
      // chances to be off by one stroke width — invisible on screen, wrong in the file.
      const [bx, by] = map(shape.ox, shape.oy);
      const ap = {
        Type: "XObject", Subtype: "Form", FormType: 1,
        BBox: [0, 0, shape.wPt, shape.hPt],
      };
      // Stroke-only shapes get NO /Resources key at all — the common case writes the
      // smaller, simpler dict, and a form with nothing to resolve should not claim one.
      if (shape.resources) ap.Resources = shape.resources;
      if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
      const apStream = PDFRawStream.of(ctx.obj(ap), strToBytes(shape.ops));
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Stamp", F: 4,
        Rect: apRectFor(angle, shape.wPt, shape.hPt, bx, by),
        AP: { N: ctx.register(apStream) },
      });
      annot.set(NABU_KIND, PDFName.of(a.kind));
      annot.set(NABU_DATA, dataHex);
      pushPageAnnot(doc, page, ctx.register(annot));
      return true;
    }
    // note — real Text annotation carrying the thread; marker drawn by the viewer.
    const c = hexRgb(a.color);
    const [rx1, ry1] = map(a.x, a.y + a.h);
    const [rx2, ry2] = map(a.x + a.w, a.y);
    const annot = ctx.obj({
      Type: "Annot", Subtype: "Text", Name: "Comment", Open: false, F: 4,
      Rect: [Math.min(rx1, rx2), Math.min(ry1, ry2), Math.max(rx1, rx2), Math.max(ry1, ry2)],
      Contents: PDFHexString.fromText(noteThreadText(a)),
      C: [c.red, c.green, c.blue],
    });
    annot.set(NABU_KIND, PDFName.of("note"));
    annot.set(NABU_DATA, dataHex);
    pushPageAnnot(doc, page, ctx.register(annot));
    return true;
  }

  const f = (n) => (+n).toFixed(2);
  // The original image bytes behind a managed image annot, or null when they can't
  // be trusted. `null` deliberately means "leave this annot alone": it is neither
  // imported as an editable object nor stripped on the next bake, so a file that has
  // been through another PDF editor loses nothing — the image simply stays a plain
  // stamp. We write the stream with NO /Filter, so any filter at all means someone
  // else re-encoded it and `contents` is no longer the image file.
  // Image bytes → the data URL the overlay <img> and the next bake both need.
  // Uses wire.js's pushB64Chunks, the one tested chunked encoder in the renderer:
  // btoa(String.fromCharCode(...wholeBuffer)) blows the stack on a real photo, and
  // BI-24 is explicit that no new general-purpose byte→base64 helper gets written.
  // One image needing one data: URL is the narrow case that legitimately needs the
  // string at all — do NOT generalise this to documents.
  // Every object a managed annot privately owns, collected for deletion: its /AP
  // form, that form's /NabuImg image (+ the /SMask a transparent PNG brings) and its
  // /NabuSrc stream, then the annot dict itself. Anything that doesn't look exactly
  // like our own output is skipped — worst case we keep the old growth, never a
  // dangling reference.
  // Actually free the collected objects. Deferred to the END of a whole-document
  // strip on purpose: an image source is SHARED by every page "Áp ảnh/chữ ký cho
  // nhiều trang" put it on, so deleting page 1's copy mid-loop would make page 2's
  // managedSrcBytes come back null and its annot would be kept AND re-written —
  // two stamps for one image. Duplicate refs are de-duped here, so sharing is free.
  // Unlink every previously-written managed annotation on `page`, so a re-bake
  // replaces rather than duplicates them, pushing what they own onto `trash` for
  // freeManagedTrash. Returns the count unlinked.
  //
  // Unlinking alone is NOT enough, and that was a real (if quiet) bug: pdf-lib keeps
  // every parsed object and writes them all back, so the appearance PNG of each
  // replaced stamp stayed in the file forever — a text box re-baked ten times
  // shipped ten copies of its PNG. With images (megabytes) that growth is impossible
  // to ignore, hence the chain delete. It is provably safe: pdf-lib's embedPng /
  // embedJpg hand out a FRESH ref per call (they never dedupe by content), and
  // /NabuImg is a resource name nothing else writes, so once the annot is gone
  // nothing can still point at its appearance.
  // Parse managed annotations out of the current document into live overlay
  // objects (per page) so they can be edited again. Read-only w.r.t. the PDF.
  async function importManaged() {
    // What the overlay owns is re-learnt from the bytes read here, never carried over: a
    // bake renumbers objects, so yesterday's ids would hide the wrong thing (BI-99).
    ed._owned = new Map();
    ed._foreignImported = []; // same reason: the bake must match these against THIS file (BI-100)
    if (!state.bytes) return 0;
    let doc;
    try { doc = await PDFDocument.load(state.bytes); } catch (_) { return 0; }
    const pages = doc.getPages();
    let count = 0;
    const fctx = { pageCount: pages.length, targets: null, vps: new Map() };
    for (let i = 0; i < pages.length; i++) {
      const arr = pages[i].node.Annots();
      if (!arr) continue;
      for (let j = 0; j < arr.size(); j++) {
        const dict = doc.context.lookup(arr.get(j));
        if (!(dict instanceof PDFDict)) continue;
        if (!dict.get(NABU_KIND)) {
          // Another program's annotation: lifted into the overlay when it has a faithful Nabu
          // counterpart (BI-100). Counted with ours, so "delete them all" still owes a bake (BI-60).
          if (await importForeignAnnot(doc, i, arr.get(j), dict, fctx)) count++;
          continue;
        }
        // Owned = what the next bake replaces (the same rule stripManagedFromPage uses), so
        // edit mode hides exactly the baked copies the overlay stands in for.
        if (window.ManagedCodec.replacedOnBake(doc, dict)) {
          if (!ed._owned.has(i)) ed._owned.set(i, []);
          ed._owned.get(i).push(window.AnnotHide.entryOf(PDFLib, arr.get(j), dict));
        }
        const dataObj = dict.get(NABU_DATA);
        if (!dataObj || typeof dataObj.decodeText !== "function") continue;
        let parsed;
        try { parsed = JSON.parse(dataObj.decodeText()); } catch (_) { continue; }
        let src = null;
        if (parsed && parsed.k === "image") {
          const raw = managedSrcBytes(doc, dict);
          if (raw) src = managedSrcDataUrl(raw);
        }
        const a = deserializeManaged(parsed, src);
        if (a) { annotsFor(i).push(a); ed._managedPages.add(i); count++; }
      }
    }
    return count;
  }

  // One foreign annotation → overlay objects (foreign-annot.js has the rules). What the bake
  // needs later is recorded in ed._foreignImported: where the original is, how to recognise it
  // (N2), and the serialised form of each copy as imported — the bake compares against that to
  // know the user left it alone (N1). Its pdf.js id goes into ed._owned, so edit mode paints
  // the overlay copy instead of the original (BI-99). Never throws: one odd annotation must not
  // stop the editor from opening.
  async function importForeignAnnot(doc, i, raw, dict, fctx) {
    try {
      const F = window.ForeignAnnot;
      if (!fctx.targets) fctx.targets = F.replyTargets(PDFLib, doc);
      const rec = F.readForeign(PDFLib, doc, raw, dict, fctx.targets);
      if (rec.skip) return false;
      // The mapping is the page's pdf.js viewport — the same one the bake writes through. A
      // document whose page count pdf.js disagrees with is not one we can map safely.
      if (!state.pdf || state.pdf.numPages !== fctx.pageCount) return false;
      let vp = fctx.vps.get(i);
      if (!vp) {
        vp = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
        fctx.vps.set(i, vp);
      }
      // A stamp is shown through a picture of its own /AP (3b-2). Capped: each one costs a
      // small pdf.js render, and a file with thousands of stamps must still open the editor fast.
      let extra = null;
      if (rec.subtype === "Stamp") {
        fctx.stamps = (fctx.stamps || 0) + 1;
        if (fctx.stamps > STAMP_IMPORT_CAP) return false;
        const bytes = await F.stampProxyPdf(PDFLib, doc, rec, vp.rotation);
        if (!bytes) return false;
        extra = { dataUrl: await stampProxyUrl(bytes) };
      }
      let objs = F.toObjects(rec, (x, y) => vp.convertToViewportPoint(x, y), extra);
      if (!Array.isArray(objs) || !objs.length) return false;
      // A text box goes through deserializeManaged, so it carries every field a Nabu text box
      // has (normTextStyle defaults) — the same object a re-opened Nabu box would be.
      objs = objs.map((o) => {
        if (o.kind !== "text") return o;
        const n = deserializeManaged(Object.assign({ k: "text" }, o));
        if (!n) return null;
        // the partner's words wrapped into the partner's box, measured the way Nabu draws them
        const mctx = measureCtx();
        n.text = F.wrapText(n.text, n.w, (str) => layoutTextBox(str, n, mctx, n.fontSize, 1).width);
        delete n.id;
        delete n._managed;
        return n;
      });
      if (objs.some((o) => !o)) return false;
      const sigs = [];
      for (const o of objs) {
        o.id = ed.seq++;
        o._foreign = { fileRef: rec.fileRef, subtype: rec.subtype, keep: rec.keep };
        if (rec.subtype === "FreeText") o._foreign.ft = { fontRes: rec.fontRes, border: rec.border, origText: rec.text, wrapText: o.text };
        if (rec.subtype === "Text") o._foreign.note = { color: rec.color };
        if (rec.subtype === "Highlight") o._foreign.hl = { text: rec.text };
        sigs.push(JSON.stringify(serializeManaged(o)));
      }
      const hide = window.AnnotHide.entryOf(PDFLib, raw, dict);
      for (const o of objs) annotsFor(i).push(o);
      ed._foreignImported.push({ key: rec.fileRef, hideId: hide.id, page: i, num: rec.num, gen: rec.gen,
                                 subtype: rec.subtype, rect: rec.rect, nm: rec.nm, sigs,
                                 stamp: rec.subtype === "Stamp", inplace: rec.subtype === "FreeText" || rec.subtype === "Text" || rec.subtype === "Highlight", primaryId: objs[0].id });
      if (!ed._owned.has(i)) ed._owned.set(i, []);
      ed._owned.get(i).push(hide);
      ed._managedPages.add(i);
      return true;
    } catch (err) {
      console.warn("foreign annotation left as it is:", err);
      return false;
    }
  }

  // Đợt 3c, group A of Q1: an edited partner text box is rewritten IN PLACE — the same
  // /FreeText object, so Acrobat / Foxit can keep editing it. Its fields come from
  // ForeignAnnot.freeTextFields; its appearance is drawn here, with the same text rasteriser a
  // Nabu text box bakes with (Vietnamese needs no embedded font) and placed like one, over the
  // partner's background (/C) and border. Form space is the box's display orientation; a
  // turned page is handled by /Matrix + apRectFor exactly like the image branch (BI-59). /RD
  // records where the box sits inside /Rect, so the next import reads the same box back.
  // False → nothing changed (N2 did not recognise the original, or a page turned by a
  // non-quarter angle); the caller then writes a Nabu text box instead.
  async function writeFreeText(doc, page, entry, a, vp1) {
    const F = window.ForeignAnnot;
    const found = F.findOriginal(PDFLib, doc, entry);
    if (!found) return false;
    const angle = page.getRotation().angle;
    if (!apRotatable(angle)) return false;
    const ctx = doc.context;
    const map = makeMap(vp1, "orig");
    const style = Object.assign({}, a);
    delete style.fill; // the background covers the whole BOX, drawn below — not just the glyphs
    delete style.borderColor; // a partner's box keeps ITS border (drawn below), never a Nabu one
    const { bytes, wPt, hPt, ox, oy } = renderTextPng(a.text, a.fontSize, a.color, style);
    const img = await doc.embedPng(bytes);
    const padPt = a.fontSize * 0.15;
    const border = a._foreign && a._foreign.ft ? a._foreign.ft.border : null;
    const bw = border ? border.width : 0;
    const px0 = a.x - padPt + ox, py0 = a.y - padPt + oy; // the picture's top-left (display)
    const ux0 = Math.min(a.x - bw / 2, px0), uy0 = Math.min(a.y - bw / 2, py0);
    const ux1 = Math.max(a.x + a.w + bw / 2, px0 + wPt), uy1 = Math.max(a.y + a.h + bw / 2, py0 + hPt);
    const UW = ux1 - ux0, UH = uy1 - uy0;
    const bx = a.x - ux0, by = uy1 - (a.y + a.h); // the box's lower-left in form space (y up)
    const res = { XObject: { NabuImg: img.ref } };
    const ops = [];
    if (a.fill && a.fill !== "none") {
      const c = hexRgb(a.fill);
      const op = a.fillOpacity != null ? +a.fillOpacity : 1;
      if (op < 1) res.ExtGState = { NabuBg: { Type: "ExtGState", ca: op } };
      ops.push(`q ${op < 1 ? "/NabuBg gs " : ""}${c.red.toFixed(4)} ${c.green.toFixed(4)} ${c.blue.toFixed(4)} rg ${f(bx)} ${f(by)} ${f(a.w)} ${f(a.h)} re f Q`);
    }
    ops.push(`q ${f(wPt)} 0 0 ${f(hPt)} ${f(px0 - ux0)} ${f(uy1 - (py0 + hPt))} cm /NabuImg Do Q`);
    if (border) {
      const c = hexRgb(border.color);
      ops.push(`q ${f(bw)} w ${c.red.toFixed(4)} ${c.green.toFixed(4)} ${c.blue.toFixed(4)} RG ${f(bx)} ${f(by)} ${f(a.w)} ${f(a.h)} re S Q`);
    }
    const ap = { Type: "XObject", Subtype: "Form", FormType: 1, BBox: [0, 0, UW, UH], Resources: res };
    if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);
    const apRef = ctx.register(PDFRawStream.of(ctx.obj(ap), strToBytes(ops.join("\n"))));
    const [rx, ry] = map(ux0, uy1); // the union's lower-left, display → user
    const R = apRectFor(angle, UW, UH, rx, ry);
    const [b1x, b1y] = map(a.x, a.y);
    const [b2x, b2y] = map(a.x + a.w, a.y + a.h);
    const B = [Math.min(b1x, b2x), Math.min(b1y, b2y), Math.max(b1x, b2x), Math.max(b1y, b2y)];
    const r4 = (v) => Math.max(0, Math.round(v * 10000) / 10000);
    const d = found.dict;
    const oldAp = F.apRefsOf(PDFLib, doc, d);
    d.set(PDFName.of("Rect"), ctx.obj(R.map((v) => Math.round(v * 10000) / 10000)));
    d.set(PDFName.of("RD"), ctx.obj([r4(B[0] - R[0]), r4(B[1] - R[1]), r4(R[2] - B[2]), r4(R[3] - B[3])]));
    d.set(PDFName.of("AP"), ctx.obj({ N: apRef }));
    F.freeUnusedAp(PDFLib, doc, oldAp);
    F.freeTextFields(PDFLib, d, a, a._foreign.ft, new Date());
    return true;
  }
  // Đợt 3c-2: an edited partner sticky note stays the same /Text. Its icon keeps its size; the
  // /Rect follows the note's box through the page's map (corners mapped one by one, so a turned
  // page is right for free — BI-45). A reply typed in Nabu is written as a real /IRT reply
  // beside it (ForeignAnnot.replyAnnot) — the partner's /Contents keep the partner's words.
  async function writeTextNote(doc, page, entry, a, vp1) {
    const F = window.ForeignAnnot;
    const found = F.findOriginal(PDFLib, doc, entry);
    if (!found) return false;
    const map = makeMap(vp1, "orig");
    const [x1, y1] = map(a.x, a.y);
    const [x2, y2] = map(a.x + a.w, a.y + a.h);
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const d = found.dict;
    const was = a._foreign && a._foreign.note ? a._foreign.note.color : null;
    const colorChanged = String(a.color || "").toLowerCase() !== String(was || "").toLowerCase();
    const oldAp = colorChanged ? F.apRefsOf(PDFLib, doc, d) : [];
    d.set(PDFName.of("Rect"), doc.context.obj([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(r4)));
    F.textNoteFields(PDFLib, d, a.text, a.color, colorChanged, new Date());
    F.freeUnusedAp(PDFLib, doc, oldAp);
    const rect = d.lookup(PDFName.of("Rect"));
    for (const r of a.replies || []) pushPageAnnot(doc, page, F.replyAnnot(PDFLib, doc, found.ref, rect, r, a.color));
    return true;
  }
  // Đợt 3c-3: an edited partner highlight stays the same /Highlight. Nabu's own tô-sáng writer
  // (addManagedAnnot "texthl") already writes a real /Highlight — /QuadPoints per quad mapped by
  // its own corners (rotated pages for free), /C, and an /AP that pins the Multiply blend at the
  // object's alpha. It is asked for one into the page, its geometry + appearance are moved onto
  // the ORIGINAL dict, and the temporary annotation is dropped. /Contents (the marked words) is
  // only rewritten when it was changed; author, /NM, popup stay the partner's.
  async function writeHighlight(doc, page, entry, a, vp1) {
    const F = window.ForeignAnnot;
    const found = F.findOriginal(PDFLib, doc, entry);
    if (!found) return false;
    const arr = page.node.Annots();
    const before = arr ? arr.size() : 0;
    const done = await addManagedAnnot(doc, page, a, makeMap(vp1, "orig"), null);
    const after = page.node.Annots();
    if (!done || !after || after.size() !== before + 1) return false;
    const tmpRef = after.get(after.size() - 1);
    const tmp = doc.context.lookup(tmpRef);
    after.remove(after.size() - 1);
    const d = found.dict;
    const oldAp = F.apRefsOf(PDFLib, doc, d);
    for (const k of ["Rect", "QuadPoints", "C", "CA", "AP"]) {
      const v = tmp.get(PDFName.of(k));
      if (v !== undefined) d.set(PDFName.of(k), v);
    }
    if (a.text !== (a._foreign && a._foreign.hl ? a._foreign.hl.text : a.text)) d.set(PDFName.of("Contents"), PDFHexString.fromText(a.text || ""));
    d.set(PDFName.of("M"), PDFLib.PDFString.of(F.pdfDate(new Date())));
    doc.context.delete(tmpRef);
    F.freeUnusedAp(PDFLib, doc, oldAp);
    return true;
  }
  // Rewrite every planned group-A original in `doc`; returns the ids that could NOT be (they
  // are then drawn as Nabu objects beside the untouched original — two copies beat a lost edit —
  // and must not take its /NM).
  async function applyInPlace(doc, list) {
    const failed = new Set();
    const pages = doc.getPages();
    for (const { entry, a } of list) {
      const vp1 = (await state.pdf.getPage(entry.page + 1)).getViewport({ scale: 1 });
      let ok = false;
      try {
        if (entry.subtype === "FreeText") ok = await writeFreeText(doc, pages[entry.page], entry, a, vp1);
        else if (entry.subtype === "Text") ok = await writeTextNote(doc, pages[entry.page], entry, a, vp1);
        else if (entry.subtype === "Highlight") ok = await writeHighlight(doc, pages[entry.page], entry, a, vp1);
      } catch (err) {
        console.error("in-place rewrite failed:", entry.subtype, err);
      }
      if (!ok) {
        failed.add(a.id);
        const keep = bakeKeep && bakeKeep.get(a.id);
        if (keep) delete keep.NM;
      }
    }
    if (failed.size) toast(`${failed.size} chú thích của phần mềm khác không sửa được tại chỗ (file đã đổi?) — đã ghi bản sửa bên cạnh bản gốc.`, "warn");
    return failed;
  }

  const STAMP_IMPORT_CAP = 200;
  // The overlay's stand-in picture for a partner stamp: the one-page PDF stampProxyPdf built,
  // rendered on a TRANSPARENT background (a stamp is not a white card) at up to 3× its size.
  async function stampProxyUrl(bytes) {
    const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
      const pg = await pdf.getPage(1);
      const v1 = pg.getViewport({ scale: 1 });
      const S = Math.max(1, Math.min(3, 2048 / Math.max(v1.width, v1.height, 1)));
      const vp = pg.getViewport({ scale: S });
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(vp.width));
      c.height = Math.max(1, Math.ceil(vp.height));
      await pg.render({ canvasContext: c.getContext("2d"), viewport: vp, background: "rgba(0,0,0,0)" }).promise;
      return c.toDataURL("image/png");
    } finally {
      pdf.destroy();
    }
  }
  // A moved / resized partner stamp keeps its own appearance: only its /Rect is rewritten, from
  // the overlay box through the same scale-1 viewport the import mapped it with.
  async function applyStampRects(doc, list) {
    let kept = 0;
    for (const { entry, a } of list) {
      const vp = (await state.pdf.getPage(entry.page + 1)).getViewport({ scale: 1 });
      const p = vp.convertToPdfPoint(a.x, a.y);
      const q = vp.convertToPdfPoint(a.x + a.w, a.y + a.h);
      if (!window.ForeignAnnot.updateRect(PDFLib, doc, entry, [p[0], p[1], q[0], q[1]])) kept++;
    }
    if (kept) toast(`${kept} con dấu của phần mềm khác không cập nhật được vị trí (file đã đổi?) — giữ nguyên chỗ cũ.`, "warn");
    return kept;
  }

  // At bake time (BI-100): which imported originals stay exactly as they are (their overlay
  // copies are skipped) and which are removed (their copies — if any are left — get written as
  // Nabu annotations). See ForeignAnnot.planForeign.
  // The plan also decides what each written copy inherits (planForeign keepFor — one /NM per
  // original); drawAnnots reads it from `bakeKeep`, which every bake sets here first.
  let bakeKeep = null;
  function foreignPlan() {
    const live = [];
    for (const k of Object.keys(ed.annots)) for (const a of ed.annots[k]) if (a._foreign) live.push({ page: +k, a });
    const plan = window.ForeignAnnot.planForeign(ed._foreignImported || [], live, (a) => JSON.stringify(serializeManaged(a)));
    bakeKeep = plan.keepFor;
    return plan;
  }
  // Remove the originals the plan gave up on. One that is no longer exactly what we imported is
  // left alone (N2) — the file then holds both it and the Nabu copy, and the user is told.
  function removeForeign(doc, list) {
    let kept = 0;
    for (const e of list) if (!window.ForeignAnnot.removeOriginal(PDFLib, doc, e)) kept++;
    if (kept) toast(`${kept} chú thích của phần mềm khác không gỡ được bản gốc (file đã đổi?) — bản gốc được giữ lại bên cạnh bản đã sửa.`, "warn");
    return kept;
  }

  // Pages with a /Rotate entry (common in scans) display rotated, but pdf-lib
  // draws in *unrotated* user space. Without compensating, baked PNGs (text
  // comment, image, watermark) come out rotated 90/180/270°. We pin the image's
  // visual lower-left to the already-mapped anchor and spin the glyphs back by
  // the page rotation so they read upright after the viewer applies it.
  //
  // WHICH PRIMITIVES NEED THAT, and why the answer is not "the images" (v0.2.52).
  // `map` = vp1.convertToPdfPoint, and the pdf.js scale-1 viewport already carries
  // the rotation — so anything whose geometry is built from INDEPENDENTLY MAPPED
  // POINTS is correct for free: drawLine per segment (draw / arrow line + head /
  // dim line + ticks / ✓✗ strokes), drawRectangle from min/max of two mapped
  // corners (box / highlight), drawEllipse from a mapped centre + mapped extents
  // (its semi-axes swap with the page, which is exactly right).
  // Anything that instead hands pdf-lib a LOCAL coordinate system and lets it
  // place that system needs `rotate:` explicitly, because the local axes are in
  // DISPLAY space while pdf-lib reads them as user space. Today that is
  // `drawImage` (text / image / watermark / the arrow + dim label PNGs) AND
  // `drawSvgPath` (cloud / cloudpen) — the second one was missed when revision
  // clouds landed after the v0.2.11 image fix, so khoanh mây baked spun on every
  // rotated page until v0.2.52. Measured on the shipped pdf.js 3.11.174 +
  // pdf-lib 1.17.1: drawSvgPath applies translate(x,y)·R(rotate)·scale(1,-1), and
  // R(pageAngle)·scale(1,-1) IS the display→user linear map convertToPdfPoint
  // implies, at all four angles; at 0° it is the identity, so unrotated documents
  // are bit-for-bit unchanged. `npm run test:rotate` pins all of the above per
  // kind and carries a guard case that fails if the option is removed. BI-45.
  //
  // `share` is the per-bake embed cache threaded down to addManagedAnnot; a bake
  // that doesn't pass one simply embeds every image separately (still correct).
  async function drawAnnots(doc, page, anns, vp1, mode, share) {
    const map = makeMap(vp1, mode);
    let failed = 0;
    for (const a of anns) {
      try {
        // Text boxes, notes, arrows and images go in as real, re-editable
        // annotations; only the rotated-page fallback (addManagedAnnot → false)
        // drops through to flatten.
        if (isManagedKind(a.kind)) {
          const done = await addManagedAnnot(doc, page, a, map, share);
          // An edited partner annotation keeps its author / comment / NM (BI-100).
          const keep = bakeKeep && bakeKeep.get(a.id);
          if (done && keep) window.ForeignAnnot.applyKeep(PDFLib, doc, page, keep);
          if (done) continue;
        }
        await drawOneAnnot(doc, page, a, map);
      } catch (err) {
        // Isolate failures: one bad annotation (e.g. a corrupt image) must not
        // wipe out every other pending edit in the same bake.
        failed++;
        console.error("drawAnnot failed:", a.kind, err);
      }
    }
    if (failed) toast(`Bỏ qua ${failed} mục lỗi khi áp dụng (ảnh hỏng?).`, "warn");
  }

  async function drawOneAnnot(doc, page, a, map) {
    // Nét đứt (annot-geom.js dashSpec): the cap is part of the style — butt for "dash", round
    // for "dot". Only the five DASH_KINDS ever get a non-null spec; solid lines never reach
    // for it, so their operators are the ones they always were.
    const capOf = (ds) => (ds.cap === "round" ? PDFLib.LineCapStyle.Round : PDFLib.LineCapStyle.Butt);
    if (a.kind === "highlight" || a.kind === "texthl") {
        // MULTIPLY, not a plain 35% wash — and this is a FIX, not a style change.
        // On screen a highlight has always been `mix-blend-mode: multiply` (app.css), so
        // the glyphs under it stay black. The bake used `opacity: 0.35` in Normal mode,
        // which paints the yellow ON TOP of the text: measured side by side in the app,
        // the words under a baked highlight came out visibly GREY while the same words
        // outside it stayed black (docs/RESEARCH-2026-09-20c §3.4, hl-zoom.png). Multiply
        // at the overlay's own alpha makes the two writers agree — BI-40's rule applied
        // to a blend mode instead of to geometry.
        //
        // `BlendMode.Multiply` is supported by the vendored pdf-lib 1.17.1 (checked: it
        // emits /BM /Multiply in an ExtGState). Note for anyone verifying by hand: the
        // default save uses object streams, so grepping the file for /Multiply finds
        // nothing — save with {useObjectStreams:false} to read it.
        //
        // Both highlighters land here: one box, or one box per line of selected text.
        // A `texthl` normally goes in as a real /Highlight annotation and never reaches
        // this branch; it is here so that the flattening path cannot silently draw a
        // different mark from the round-tripping one.
        const boxes = a.kind === "texthl"
          ? (a.quads || []).filter((q) => q && q.w > 0 && q.h > 0)
          : [{ x: a.x, y: a.y, w: a.w, h: a.h }];
        const alpha = a.kind === "texthl" && a.opacity != null ? a.opacity : TEXTHL_OPACITY;
        for (const q of boxes) {
          const [x1, y1] = map(q.x, q.y);
          const [x2, y2] = map(q.x + q.w, q.y + q.h);
          page.drawRectangle({
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            color: hexRgb(a.color),
            opacity: alpha,
            blendMode: PDFLib.BlendMode.Multiply,
          });
        }
      } else if (a.kind === "poly") {
        // Only reachable on a page whose /Rotate is not a quarter turn (addManagedAnnot
        // hands those back); the normal path is the vector /AP. Per-segment drawLine for
        // exactly the reason the `draw` branch below gives — independently mapped
        // endpoints are correct at any angle, a local coordinate system is not.
        //
        // The INTERIOR is dropped in this fallback, and that is deliberate rather than
        // an oversight: filling would mean handing pdf-lib one path in a local space,
        // i.e. the very thing this branch exists to avoid. An exotic page rotation costs
        // the wash and keeps the outline, which is the shape the reviewer drew.
        const pts = a.pts || [];
        const chain = a.closed && pts.length > 2 ? pts.concat([pts[0]]) : pts;
        // A dash pattern restarts at every drawLine, so on a polyline of short segments it
        // would read as solid: walk the whole path once instead (dashSegments).
        const dsP = dashSpec(a.dash, a.width);
        const segsP = dsP ? dashSegments(chain, dsP.array) : chain.slice(1).map((q, k) => [chain[k], q]);
        for (const [s0, s1] of segsP) {
          const [px, py] = map(s0.x, s0.y);
          const [qx, qy] = map(s1.x, s1.y);
          page.drawLine({
            start: { x: px, y: py }, end: { x: qx, y: qy },
            thickness: Math.max(0.1, a.width || 2),
            color: hexRgb(a.color),
            lineCap: dsP ? capOf(dsP) : PDFLib.LineCapStyle.Round,
          });
        }
      } else if (a.kind === "draw") {
        // Still per-segment `drawLine` and NOT one drawSvgPath, deliberately: every
        // endpoint is mapped independently, which is what keeps a stroke correct on a
        // /Rotate page for free (see the note above drawAnnots — handing pdf-lib a
        // local coordinate system is what needed the explicit `rotate:` that BI-45 was
        // about). Round caps join the segments seamlessly, which is both what the
        // overlay <svg> shows (stroke-linecap: round) and what makes this identical to
        // the round-capped, round-joined polyline in the managed /AP.
        const c = hexRgb(a.color);
        // Dashed: walk the path once (see the poly branch) instead of one pattern per segment.
        const dsD = dashSpec(a.dash, a.width);
        const segsD = dsD ? dashSegments(a.pts, dsD.array) : a.pts.slice(1).map((q, k) => [a.pts[k], q]);
        for (const [s0, s1] of segsD) {
          const [sx, sy] = map(s0.x, s0.y);
          const [ex, ey] = map(s1.x, s1.y);
          page.drawLine({
            start: { x: sx, y: sy }, end: { x: ex, y: ey },
            thickness: a.width, color: c, lineCap: dsD ? capOf(dsD) : PDFLib.LineCapStyle.Round,
          });
        }
      } else if (a.kind === "text") {
        const { bytes, wPt, hPt, ox, oy } = renderTextPng(a.text, a.fontSize, a.color, a);
        const img = await doc.embedPng(bytes);
        // The PNG carries ~0.15em padding; offset so the glyphs line up with
        // where the overlay (zero-padding) showed them. `ox`/`oy` add the extra
        // margin a TURNED raster grew by — both 0 for an upright box, so this is
        // the same arithmetic that shipped before rotation existed.
        const padPt = a.fontSize * 0.15;
        const [bx, by] = map(a.x - padPt + ox, a.y - padPt + oy + hPt);
        page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
      } else if (a.kind === "box") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        const opts = {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        const dsB = dashSpec(a.dash, a.width);
        if (dsB) { opts.borderDashArray = dsB.array; if (dsB.cap === "round") opts.borderLineCap = capOf(dsB); }
        page.drawRectangle(opts);
      } else if (a.kind === "ellipse") {
        const [x1, y1] = map(a.x, a.y);
        const [x2, y2] = map(a.x + a.w, a.y + a.h);
        const opts = {
          x: (x1 + x2) / 2,
          y: (y1 + y2) / 2,
          xScale: Math.abs(x2 - x1) / 2,
          yScale: Math.abs(y2 - y1) / 2,
          borderColor: hexRgb(a.color),
          borderWidth: a.width || 2,
        };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        const dsE = dashSpec(a.dash, a.width);
        if (dsE) { opts.borderDashArray = dsE.array; if (dsE.cap === "round") opts.borderLineCap = capOf(dsE); }
        page.drawEllipse(opts);
      } else if (a.kind === "cloud") {
        // Scallop outline mapped like the freehand path: (0,0) of the SVG sits at
        // the padded top-left; drawSvgPath draws downward from there (it flips y),
        // so at rotation 0 the bake matches the overlay pixel-for-pixel.
        const { d, pad } = cloudPath(a.w, a.h, bumpOf(a));
        const [bx, by] = map(a.x - pad, a.y - pad);
        const opts = { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: a.width || 2, rotate: pageRotate(page) };
        if (a.fill && a.fill !== "none") {
          opts.color = hexRgb(a.fill);
          opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
        }
        page.drawSvgPath(d, opts);
      } else if (a.kind === "cloudpen") {
        const cp = cloudPathPoly(a.pts, bumpOf(a));
        if (cp) {
          const [bx, by] = map(cp.minX - cp.pad, cp.minY - cp.pad);
          const opts = { x: bx, y: by, borderColor: hexRgb(a.color), borderWidth: a.width || 2, rotate: pageRotate(page) };
          if (a.fill && a.fill !== "none") {
            opts.color = hexRgb(a.fill);
            opts.opacity = a.fillOpacity != null ? a.fillOpacity : 1;
          }
          page.drawSvgPath(cp.d, opts);
        }
      } else if (SYMBOL_KINDS.has(a.kind)) {
        // Same strokes the overlay drew, endpoint-mapped one at a time — so page
        // rotation and the redaction "image" mode are handled by `map`, exactly
        // like arrow/dim. Round caps to match the SVG's stroke-linecap.
        const c = hexRgb(a.color);
        const w = Math.max(1, a.width || 2);
        for (const line of symbolStrokes(a.kind, a.x, a.y, a.w, a.h)) {
          for (let k = 1; k < line.length; k++) {
            const [sx, sy] = map(line[k - 1].x, line[k - 1].y);
            const [ex, ey] = map(line[k].x, line[k].y);
            page.drawLine({
              start: { x: sx, y: sy }, end: { x: ex, y: ey },
              thickness: w, color: c, lineCap: PDFLib.LineCapStyle.Round,
            });
          }
        }
      } else if (a.kind === "arrow") {
        const c = hexRgb(a.color);
        const w = a.width || 2;
        const [sx, sy] = map(a.x1, a.y1);
        const [ex, ey] = map(a.x2, a.y2);
        // Shaft only: the head strokes below stay solid whatever the style (a dashed arrowhead
        // is not an arrowhead), same as the SVG and the canvas PNG.
        const dsA = dashSpec(a.dash, a.width);
        page.drawLine(dsA
          ? { start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c, dashArray: dsA.array, lineCap: capOf(dsA) }
          : { start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c });
        // arrowhead: two short strokes back from the tip
        const ang = Math.atan2(ey - sy, ex - sx);
        const hl = Math.max(8, w * 4);
        const ha = Math.PI / 7;
        page.drawLine({
          start: { x: ex, y: ey },
          end: { x: ex - hl * Math.cos(ang - ha), y: ey - hl * Math.sin(ang - ha) },
          thickness: w,
          color: c,
        });
        page.drawLine({
          start: { x: ex, y: ey },
          end: { x: ex - hl * Math.cos(ang + ha), y: ey - hl * Math.sin(ang + ha) },
          thickness: w,
          color: c,
        });
        // Label — rendered to PNG (same path as text annots, so Vietnamese
        // diacritics embed reliably), centred just beyond the head or tail per
        // a.labelEnd.
        if (a.label) {
          const fs = a.labelSize || 14;
          const { bytes, wPt, hPt } = renderTextPng(a.label, fs, a.color, {});
          // Anchor in overlay coords (y-down), matching the on-screen placement.
          const angO = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
          const lp = arrowLabelPos(a, a.x1, a.y1, a.x2, a.y2, angO, hl, fs);
          const img = await doc.embedPng(bytes);
          const [bx, by] = map(lp.x - wPt / 2, lp.y + hPt / 2);
          page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
        }
      } else if (a.kind === "dim") {
        const c = hexRgb(a.color);
        const w = a.width || 2;
        const [sx, sy] = map(a.x1, a.y1);
        const [ex, ey] = map(a.x2, a.y2);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: w, color: c });
        // End ticks: perpendicular in overlay (y-down) space, endpoints mapped.
        const angO = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const nxO = -Math.sin(angO);
        const nyO = Math.cos(angO);
        const tick = Math.max(5, w * 3);
        for (const pt of [[a.x1, a.y1], [a.x2, a.y2]]) {
          const [t1x, t1y] = map(pt[0] - nxO * tick, pt[1] - nyO * tick);
          const [t2x, t2y] = map(pt[0] + nxO * tick, pt[1] + nyO * tick);
          page.drawLine({ start: { x: t1x, y: t1y }, end: { x: t2x, y: t2y }, thickness: w, color: c });
        }
        // Measured value — PNG (same Vietnamese-safe path as text/arrow labels).
        if (a.text) {
          const fs = a.labelSize || 14;
          const { bytes, wPt, hPt } = renderTextPng(a.text, fs, a.color, {});
          const img = await doc.embedPng(bytes);
          const mxO = (a.x1 + a.x2) / 2 + nxO * (tick + fs * 0.7);
          const myO = (a.y1 + a.y2) / 2 + nyO * (tick + fs * 0.7);
          const [bx, by] = map(mxO - wPt / 2, myO + hPt / 2);
          page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, rotate: pageRotate(page) });
        }
      } else if (a.kind === "note") {
        // 1. Visible marker square so the note shows in any viewer (incl. ours).
        const c = hexRgb(a.color);
        const [mx, my] = map(a.x, a.y + a.h);
        page.drawRectangle({
          x: mx,
          y: my,
          width: a.w,
          height: a.h,
          color: c,
          borderColor: rgb(0.2, 0.2, 0.2),
          borderWidth: 0.5,
        });
        // 2. Real PDF Text annotation (sticky note) carrying the comment text.
        const [rx1, ry1] = map(a.x, a.y + a.h);
        const [rx2, ry2] = map(a.x + a.w, a.y);
        const ctx = doc.context;
        const ann = ctx.obj({
          Type: "Annot",
          Subtype: "Text",
          Name: "Comment",
          Rect: [Math.min(rx1, rx2), Math.min(ry1, ry2), Math.max(rx1, rx2), Math.max(ry1, ry2)],
          Contents: PDFHexString.fromText(noteThreadText(a)),
          Open: false,
          C: [c.red, c.green, c.blue],
        });
        const ref = ctx.register(ann);
        let arr = page.node.Annots();
        if (!arr) {
          arr = ctx.obj([]);
          page.node.set(PDFName.of("Annots"), arr);
        }
        arr.push(ref);
      } else if (a.kind === "image") {
        const bytes = dataUrlToBytes(a.dataUrl);
        // fmt was sniffed from magic bytes at selection time; fall back to a byte
        // sniff for any older in-memory annotation that predates this field.
        const fmt = a.fmt || sniffImage(bytes);
        const img = fmt === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const [bx, by] = map(a.x, a.y + a.h);
        page.drawImage(img, { x: bx, y: by, width: a.w, height: a.h, rotate: pageRotate(page) });
      }
  }

  async function drawWatermark(doc, page, vp1, mode) {
    const { bytes, wPt, hPt } = renderWatermarkPng(ed.watermark);
    const img = await doc.embedPng(bytes);
    const map = makeMap(vp1, mode);
    const cx = (vp1.width - wPt) / 2;
    const cy = (vp1.height - hPt) / 2;
    const [bx, by] = map(cx, cy + hPt);
    page.drawImage(img, { x: bx, y: by, width: wPt, height: hPt, opacity: ed.watermark.opacity, rotate: pageRotate(page) });
  }

  async function bakeInPlace() {
    const doc = await PDFDocument.load(state.bytes);
    const fp = foreignPlan(); // BI-100: untouched partner annotations are not written at all
    stripManagedAnnots(doc); // drop the previous round-trip copies; re-added from ed.annots below
    removeForeign(doc, fp.remove);
    await applyStampRects(doc, fp.rects); // moved partner stamps: /Rect only (3b-2)
    const failedInPlace = await applyInPlace(doc, fp.inplace); // edited partner text boxes, same /FreeText (3c)
    const share = new Map(); // one embed per distinct image across the whole bake
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const anns = annotsFor(i).filter((a) => !fp.skipIds.has(a.id) && !fp.rectIds.has(a.id) &&
        (!fp.inplaceIds.has(a.id) || failedInPlace.has(a.id)));
      if (!anns.length && !ed.watermark) continue;
      const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
      await drawAnnots(doc, pages[i], anns, vp1, "orig", share);
      if (ed.watermark) await drawWatermark(doc, pages[i], vp1, "orig");
    }
    return await doc.save();
  }

  async function bakeWithRedaction() {
    const src = await PDFDocument.load(state.bytes);
    // BI-100: edited / deleted partner originals leave `src` BEFORE pages are copied out of it;
    // untouched ones are copied (or, on a redacted page, burned in) exactly as they are.
    const fp = foreignPlan();
    removeForeign(src, fp.remove);
    await applyStampRects(src, fp.rects);
    // In place only where the page is COPIED; a redacted page is rebuilt from a picture, so an
    // edited partner text box there is drawn as a Nabu box instead (its original goes with the page).
    const redactedPages = new Set();
    for (let i = 0; i < state.numPages; i++) if (annotsFor(i).some((a) => a.kind === "redact")) redactedPages.add(i);
    const failedInPlace = await applyInPlace(src, fp.inplace.filter((it) => !redactedPages.has(it.entry.page)));
    const out = await PDFDocument.create();
    const share = new Map(); // see bakeInPlace
    // Copied pages carry the old round-trip annots. They are unlinked page by page
    // but freed only after the loop, because a shared image source must stay
    // readable while later pages are still being checked (see freeManagedTrash).
    const trash = [];
    const n = state.numPages;
    for (let i = 0; i < n; i++) {
      const all = annotsFor(i).filter((a) => !fp.skipIds.has(a.id));
      const redacts = all.filter((a) => a.kind === "redact");
      // A moved partner stamp normally just has its /Rect rewritten in `src` (above). On a page
      // rebuilt from a picture its original is gone with the page, so its stand-in is drawn instead.
      const anns = redacts.length ? all
        : all.filter((a) => !fp.rectIds.has(a.id) && (!fp.inplaceIds.has(a.id) || failedInPlace.has(a.id)));
      const others = anns.filter((a) => a.kind !== "redact");
      const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });
      let page;
      let mode;
      if (redacts.length) {
        const png = await rasterRedacted(i, redacts, vp1, fp.keepIds);
        const img = await out.embedPng(png);
        page = out.addPage([vp1.width, vp1.height]);
        page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        mode = "image";
      } else {
        const [cp] = await out.copyPages(src, [i]);
        out.addPage(cp);
        page = cp;
        mode = "orig";
        stripManagedFromPage(out, page, trash); // copied page carried the old round-trip copies
      }
      if (others.length) await drawAnnots(out, page, others, vp1, mode, share);
      if (ed.watermark) await drawWatermark(out, page, vp1, mode);
    }
    freeManagedTrash(out, trash);
    return await out.save();
  }

  // Bake all pending overlay edits into state.bytes and re-render. Returns
  // whether anything was applied. Called by Save and on exit.
  // Chữ ký lưu sẵn: the width each saved signature ENDED UP at (after the user's
  // resize) becomes its default next time. Last one on the pages wins — "the size I
  // used most recently". Fire-and-forget: a store that cannot be written (encryption
  // off, unreadable) must never hold up or fail the bake.
  function rememberSignatureWidths() {
    const api = window.desktop && window.desktop.signatures;
    if (!api || !api.setWidth) return;
    const last = new Map();
    for (const list of Object.values(ed.annots)) {
      for (const a of list) if (a.kind === "image" && a.sigId && a.w > 0) last.set(a.sigId, a.w);
    }
    for (const [id, w] of last) api.setWidth(id, w).catch(() => {});
  }

  async function bakePending() {
    if (ed._taCommit) ed._taCommit(); // an open editor's text must make the bake
    // `!hasAny()` alone was the bug: with every round-trip annot deleted there is
    // nothing to ADD but plenty to REMOVE, and returning early left them in the PDF —
    // so Ctrl+S and "Xong" both looked like they worked and changed nothing. BI-60.
    if (!hasAny() && !ed._importedManaged) return false;
    rememberSignatureWidths();
    showOverlay("Đang áp dụng chỉnh sửa…");
    try {
      const anyRedact = Object.values(ed.annots).some((a) => a.some((x) => x.kind === "redact"));
      const bytes = anyRedact ? await bakeWithRedaction() : await bakeInPlace();
      // Only the annotated pages change pixels (watermark hits every page) — so we
      // can repaint just those instead of reloading the whole document.
      let changed = null;
      if (!ed.watermark) {
        changed = new Set();
        for (const k of Object.keys(ed.annots)) if (ed.annots[k].length) changed.add(+k);
        // Pages whose managed appearance changed (incl. a text/note just deleted,
        // so it's no longer in ed.annots) must repaint too.
        for (const k of ed._managedPages) changed.add(k);
      }
      if (window.DocHistory) window.DocHistory.pushUndo(); // one doc-level undo step per bake
      state.bytes = bytes;
      ed.annots = {};
      ed.watermark = null;
      ed.sel = null;
      ed._dirty = false;
      clearEdHistory(); // baked annotations can't be un-done at annotation level anymore
      // Mid-session save (still editing): pull the managed annots back in so text
      // boxes / notes stay editable and their baked copies stay hidden.
      //
      // BEFORE rerenderChanged, not after (BI-99). renderPageCanvas hides, while editing,
      // exactly the annotations importManaged recorded as owned (ed._owned) — and the bake
      // just wrote new ones under new object numbers. Re-read afterwards, the repaint below
      // would use the list from BEFORE the bake: empty for a session that began with no Nabu
      // annotation, so the box just baked was painted by pdf.js under its own overlay copy
      // (MEASURED in Electron: drawn twice); stale numbers otherwise, which match nothing and
      // hide every annotation on the page. importManaged only READS state.bytes, which is
      // already the new file here.
      const midSession = ed.active && !ed._exiting;
      if (midSession) ed._importedManaged = await importManaged(); // re-read: the count must track the FILE
      await rerenderChanged(changed);
      if (midSession) {
        // No repaintRenderedPages() here (R8, docs/REVIEW-2026-10-01). It used to follow, and
        // re-rasterised every page on screen a SECOND time - the changed ones had just been
        // repainted by rerenderChanged, the unchanged ones were already right. The reason it
        // existed (hide the baked copy of the annots the overlay now owns again) is met by
        // rerenderChanged itself: renderPageCanvas hides the owned annots whenever
        // Editor.active, Editor.active is still true here, and ed._owned already describes
        // the new bytes (re-read above).
        syncOverlays();
      }
      toast("Đã áp dụng chỉnh sửa.", "good");
      return true;
    } catch (err) {
      toast("Lỗi áp dụng: " + (err.message || err), "bad");
      throw err;
    } finally {
      hideOverlay();
    }
  }

// ======== END verbatim block ========

  return { bakePending, importManaged };
  }

  window.EditorBake = { create };
})();
