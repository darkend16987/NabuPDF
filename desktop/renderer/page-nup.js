"use strict";

/**
 * Nabu PDF — "ghép nhiều trang vào một tờ" (N-up), v0.2.76. Pure, no DOM.
 *
 * Why its own file (same reasoning as page-range.js): the maths is where this goes
 * wrong silently — a /Rotate-90 page placed without compensation lands sideways, a
 * CropBox ignored shows margins the viewer never showed. Under plain node it can be
 * run against REAL pdf-lib documents — see desktop/test/page-nup.test.js — which the
 * rest of the renderer cannot.
 *
 * Loaded as a classic <script> AND requireable from node. Callers use
 * `window.PageNup.*`, never bare names (BI-14): nothing here enters the shared scope.
 *
 * WHAT pdf-lib's embedPage does and does NOT do (measured on 1.17.1, not assumed):
 *   · keeps the page as VECTORS (a Form XObject) — text stays sharp when zoomed/printed;
 *   · IGNORES the page's /Rotate (a 595x842 page with /Rotate 90 embeds as 595x842);
 *   · IGNORES the CropBox unless a boundingBox is passed;
 *   · carries NO annotations (links, form fields, comments, Nabu's own editable ones);
 *   · THROWS on a page without /Contents (what "Thêm trang trắng" creates).
 * Each of those has a handler below and a case in the test.
 *
 * Coordinates: PDF user space, origin bottom-left, y up. "rot" is the page's /Rotate
 * (clockwise when displayed), snapped to 0/90/180/270.
 */
(function () {
  // Short side first. Orientation is applied by sheetSize().
  const SHEETS = { a4: [595.276, 841.89], a3: [841.89, 1190.551], letter: [612, 792] };
  const MIN_CELL = 20; // pt — below this a "page" is a dot; margins are clamped to leave this

  const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function normOpts(o) {
    o = o || {};
    const per = Number(o.per) === 4 ? 4 : 2;
    const sheet = Object.prototype.hasOwnProperty.call(SHEETS, o.sheet) ? o.sheet : "a4";
    const orient = o.orient === "landscape" ? "landscape" : "portrait";
    return {
      per,
      sheet,
      orient,
      margin: clamp(num(o.margin, 24), 0, 100),
      gap: clamp(num(o.gap, 12), 0, 100),
      border: !!o.border,
    };
  }

  /** [width, height] of the output sheet. Portrait = short side first. */
  function sheetSize(key, orient) {
    const base = SHEETS[key] || SHEETS.a4;
    const s = Math.min(base[0], base[1]);
    const l = Math.max(base[0], base[1]);
    return orient === "landscape" ? [l, s] : [s, l];
  }

  /** 2-up: stacked on a portrait sheet, side by side on a landscape one. 4-up: 2x2. */
  function gridOf(per, sheetW, sheetH) {
    if (per === 4) return { cols: 2, rows: 2 };
    return sheetW >= sheetH ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
  }

  /**
   * Cell rectangles, reading order (row by row, top-left first), PDF coordinates.
   * Margin and gap are shrunk if they would leave a cell under MIN_CELL — a huge
   * margin must degrade to "small pages", never to a negative size.
   */
  function cellRects(sheetW, sheetH, per, margin, gap) {
    const { cols, rows } = gridOf(per, sheetW, sheetH);
    let m = Math.max(0, margin);
    let g = Math.max(0, gap);
    const fits = () =>
      (sheetW - 2 * m - (cols - 1) * g) / cols >= MIN_CELL && (sheetH - 2 * m - (rows - 1) * g) / rows >= MIN_CELL;
    for (let i = 0; i < 64 && !fits(); i++) {
      m *= 0.8;
      g *= 0.8;
    }
    const cw = (sheetW - 2 * m - (cols - 1) * g) / cols;
    const ch = (sheetH - 2 * m - (rows - 1) * g) / rows;
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({ x: m + c * (cw + g), y: sheetH - m - (r + 1) * ch - r * g, w: cw, h: ch });
      }
    }
    return out;
  }

  const snapRot = (deg) => ((Math.round((Number(deg) || 0) / 90) * 90) % 360 + 360) % 360;

  /** Size the page has ON SCREEN: /Rotate 90 or 270 swaps the stored width and height. */
  function displaySize(w, h, rot) {
    const r = snapRot(rot);
    return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
  }

  /**
   * Geometry of a pdf-lib page as the viewer shows it: the box that is VISIBLE (CropBox
   * clipped to MediaBox) and the /Rotate. `box` is what to pass to embedPage.
   */
  function pageGeom(page) {
    const mb = page.getMediaBox();
    let cb = mb;
    try {
      cb = page.getCropBox() || mb;
    } catch (_) {
      cb = mb;
    }
    const left = Math.max(mb.x, cb.x);
    const bottom = Math.max(mb.y, cb.y);
    const right = Math.min(mb.x + mb.width, cb.x + cb.width);
    const top = Math.min(mb.y + mb.height, cb.y + cb.height);
    const ok = right - left > 0 && top - bottom > 0; // a CropBox outside the MediaBox is junk
    const box = ok
      ? { left, bottom, right, top }
      : { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height };
    const rot = snapRot(page.getRotation().angle);
    const w = box.right - box.left;
    const h = box.top - box.bottom;
    return { box, w, h, rot, disp: displaySize(w, h, rot) };
  }

  /** Scale a display-size (dw x dh) page to fit `cell`, centred. Returns the bottom-left and scale. */
  function fitInCell(cell, dw, dh) {
    const s = Math.min(cell.w / dw, cell.h / dh);
    return { s, x: cell.x + (cell.w - dw * s) / 2, y: cell.y + (cell.h - dh * s) / 2, w: dw * s, h: dh * s };
  }

  /**
   * drawPage arguments that put an embedded page of STORED size (w x h), displayed with
   * /Rotate `rot`, at scale `s` with the bottom-left of its DISPLAYED rectangle at (X, Y).
   * pdf-lib applies translate -> rotate -> scale, so the rotation is about (x, y):
   * a clockwise display rotation is a negative angle, and the origin moves to the corner
   * that ends up bottom-left.
   */
  function placement(rot, X, Y, w, h, s) {
    switch (snapRot(rot)) {
      case 90: return { x: X, y: Y + w * s, angle: -90 };
      case 180: return { x: X + w * s, y: Y + h * s, angle: -180 };
      case 270: return { x: X + h * s, y: Y, angle: 90 };
      default: return { x: X, y: Y, angle: 0 };
    }
  }

  /**
   * Which pages become sheets and where the sheets go.
   * `chosen`: 0-based indices (any order, dupes/out-of-range dropped). They are consumed in
   * page order, `per` to a sheet; the sheets take the place of the FIRST chosen page and
   * every other page keeps its position. -> { items, sheets, chosen }
   * items: [{ page: i } | { sheet: [i, i, ...] }] in output order.
   */
  function plan(total, chosen, per) {
    const n = Math.max(0, Math.floor(total) || 0);
    const p = Number(per) === 4 ? 4 : 2;
    const ids = [...new Set((chosen || []).filter((i) => Number.isInteger(i) && i >= 0 && i < n))].sort((a, b) => a - b);
    const set = new Set(ids);
    const sheets = [];
    for (let k = 0; k < ids.length; k += p) sheets.push(ids.slice(k, k + p));
    const items = [];
    for (let i = 0; i < n; i++) {
      if (!set.has(i)) items.push({ page: i });
      else if (i === ids[0]) for (const sh of sheets) items.push({ sheet: sh });
    }
    return { items, sheets: sheets.length, chosen: ids };
  }

  /** How many annotation entries (links, form fields, comments…) sit on these pages — they will NOT survive. */
  function countAnnots(srcDoc, indices) {
    const pages = srcDoc.getPages();
    let n = 0;
    for (const i of indices) {
      const pg = pages[i];
      if (!pg) continue;
      const a = pg.node.Annots();
      if (a) n += a.size();
    }
    return n;
  }

  /**
   * Build the result into `out` (a fresh document) from `src`. `lib` = { degrees, rgb }
   * from pdf-lib. Pages outside the plan are copied untouched; each sheet is a new page.
   * Returns { sheets, blanks } — blanks = chosen pages without /Contents (drawn as empty cells).
   */
  async function build(src, out, items, opts, lib) {
    const o = normOpts(opts);
    const [W, H] = sheetSize(o.sheet, o.orient);
    const cells = cellRects(W, H, o.per, o.margin, o.gap);
    const srcPages = src.getPages();

    const keep = items.filter((it) => it.page !== undefined).map((it) => it.page);
    const copied = keep.length ? await out.copyPages(src, keep) : [];
    let ci = 0;
    let sheets = 0;
    let blanks = 0;
    for (const it of items) {
      if (it.page !== undefined) {
        out.addPage(copied[ci++]);
        continue;
      }
      const sheet = out.addPage([W, H]);
      sheets++;
      for (let k = 0; k < it.sheet.length; k++) {
        const g = pageGeom(srcPages[it.sheet[k]]);
        const fit = fitInCell(cells[k], g.disp.w, g.disp.h);
        // pdf-lib throws for a page without /Contents — NOT from embedPage but later, from
        // save(), so a try/catch here would catch nothing (measured). Look first. A blank
        // page keeps its cell (and border) and simply draws nothing.
        let emb = null;
        if (srcPages[it.sheet[k]].node.Contents()) emb = await out.embedPage(srcPages[it.sheet[k]], g.box);
        else blanks++;
        if (emb) {
          const pl = placement(g.rot, fit.x, fit.y, g.w, g.h, fit.s);
          sheet.drawPage(emb, { x: pl.x, y: pl.y, xScale: fit.s, yScale: fit.s, rotate: lib.degrees(pl.angle) });
        }
        if (o.border) {
          sheet.drawRectangle({
            x: fit.x, y: fit.y, width: fit.w, height: fit.h,
            borderColor: lib.rgb(0.6, 0.6, 0.6), borderWidth: 0.5,
          });
        }
      }
    }
    return { sheets, blanks };
  }

  const api = {
    SHEETS, normOpts, sheetSize, gridOf, cellRects, displaySize, pageGeom, fitInCell, placement,
    plan, countAnnots, build,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PageNup = api;
})();
