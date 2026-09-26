"use strict";

/**
 * Nabu PDF — signature image clean-up (pure, no DOM), v0.2.72.
 *
 * Two jobs, both on a raw RGBA buffer (ImageData.data in the app, a synthetic
 * Uint8ClampedArray in `npm run test:sig`):
 *
 *   removeWhiteBg  — a signature photographed or scanned on paper arrives as dark
 *                    ink on an OPAQUE white/greyish sheet. Stamped on a contract that
 *                    sheet becomes a white rectangle over the text. Near-white pixels
 *                    become transparent, with a SOFT band so the anti-aliased edge of
 *                    each stroke fades instead of turning into jaggies, and the colour
 *                    of those edge pixels is "un-mixed" from the white it was blended
 *                    with, so no pale halo is left around the ink.
 *   trimBounds     — the tight box around what is left, so the placed signature's
 *                    frame hugs the strokes and lines up where the user drops it.
 *
 * Kept DOM-free for the same reason as page-range.js: this runs on the user's
 * signature, a wrong threshold silently eats a thin stroke, and only a node grid can
 * pin that down. Loaded as a classic <script> (window.SigImage) AND require()-able.
 */
(function () {
  // "Whiteness" of a pixel = its DARKEST channel. Ink of any colour (blue, black, red)
  // is dark in at least one channel; paper is bright in all three. Using min() rather
  // than luminance keeps a saturated blue or red stroke opaque.
  //
  // level 0..100 = how aggressively greyish paper is removed. The band [lo, hi]:
  //   min ≥ hi → fully transparent (paper)      min ≤ lo → untouched (ink)
  //   in between → alpha scales linearly (the stroke's anti-aliased edge)
  function band(level) {
    const L = Math.max(0, Math.min(100, Number(level) || 0));
    const hi = 250 - L * 0.3; // 250 (only near-pure white) … 220 (grey scans)
    return { hi, lo: hi - 60 };
  }

  function removeWhiteBg(rgba, w, h, level = 50) {
    const { hi, lo } = band(level);
    const n = Math.min(rgba.length >> 2, (w | 0) * (h | 0));
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      const m = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (m <= lo) continue; // ink
      if (m >= hi) {
        rgba[o + 3] = 0; // paper
        continue;
      }
      const f = (hi - m) / (hi - lo); // 0 < f < 1
      // Un-mix from white: the scanner saw c = f·ink + (1−f)·255, so ink = (c − 255(1−f)) / f.
      const k = 255 * (1 - f);
      rgba[o] = Math.max(0, Math.min(255, Math.round((r - k) / f)));
      rgba[o + 1] = Math.max(0, Math.min(255, Math.round((g - k) / f)));
      rgba[o + 2] = Math.max(0, Math.min(255, Math.round((b - k) / f)));
      rgba[o + 3] = Math.round(rgba[o + 3] * f);
    }
    return rgba;
  }

  // Does the image already carry transparency? A PNG exported with a transparent
  // background should not have "Xoá nền trắng" pre-ticked — it has no paper to remove.
  function hasTransparency(rgba) {
    for (let o = 3; o < rgba.length; o += 4) if (rgba[o] < 250) return true;
    return false;
  }

  // Tight box around pixels with alpha > alphaMin, grown by `pad` px and clamped to the
  // image. null when nothing is visible (an image that was all paper).
  function trimBounds(rgba, w, h, pad = 2, alphaMin = 8) {
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (rgba[row + x * 4 + 3] > alphaMin) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad);
    y1 = Math.min(h - 1, y1 + pad);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // Scale factor that brings the long side down to `max` px (never up).
  function fitScale(w, h, max) {
    const long = Math.max(w, h);
    return long > max ? max / long : 1;
  }

  const api = { removeWhiteBg, hasTransparency, trimBounds, fitScale, band };
  if (typeof window !== "undefined") window.SigImage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
