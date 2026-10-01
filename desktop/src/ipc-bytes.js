"use strict";

/**
 * What to hand `fs.promises.writeFile` for bytes that arrived over IPC.
 *
 * The renderer sends the document as a `Uint8Array` (structured clone keeps typed
 * arrays typed). `Buffer.from(uint8Array)` COPIES it, and the save handlers did exactly
 * that on every Lưu / Lưu thành / autosave — 192 ms and a second 400 MB allocation for a
 * 400 MB document (docs/REVIEW-2026-10-01 M4). `writeFile` accepts any ArrayBuffer view
 * directly, so a view is passed through untouched.
 *
 * Anything that is NOT a view (an ArrayBuffer, a plain number[], a string) still goes
 * through `Buffer.from`, i.e. exactly what every handler did before — `writeFile` itself
 * would throw on a bare ArrayBuffer, so the conversion must stay for those. There are ~20
 * renderer call sites and not all are guaranteed to send a typed array; this keeps the
 * change a pure fast path rather than a contract change. `undefined`/`null` still throw
 * the same TypeError from `Buffer.from`.
 *
 * Safe against aliasing: the bytes are a fresh structured clone owned by this call, and
 * nothing mutates them while the async write is in flight.
 */
function asWritable(data) {
  return ArrayBuffer.isView(data) ? data : Buffer.from(data);
}

module.exports = { asWritable };
