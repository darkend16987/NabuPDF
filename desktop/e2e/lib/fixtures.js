"use strict";

// BI-141 — PDF mẫu dựng bằng pdf-lib (có sẵn trong desktop/node_modules), để e2e không phụ thuộc corpus ngoài repo.

const { PDFDocument, StandardFonts, degrees } = require("pdf-lib");

// `n` trang chữ "Trang <i>"; `rotations[i]` (tuỳ chọn) xoay trang i.
async function makePdf(n = 3, { rotations = [], title = "e2e" } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Trang ${i + 1}`, { x: 50, y: 150, size: 24, font });
    if (rotations[i]) page.setRotation(degrees(rotations[i]));
  }
  return Buffer.from(await doc.save());
}

module.exports = { makePdf };
