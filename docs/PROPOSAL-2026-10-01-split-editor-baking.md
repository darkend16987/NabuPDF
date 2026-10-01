# Đề xuất: tách khối "baking" ra khỏi `editor.js` (có số đo — CHƯA thi công)

Ngày đo: 2026-10-01, `editor.js` = 5 459 dòng. Số dòng dưới đây là **tại thời điểm đo** (dùng để định vị, không phải hợp đồng — file sẽ trôi). Nguồn: §6.3 của `docs/REVIEW-2026-10-01-perf-harness.md`; luật tách lấy từ `docs/REGRESSION-GUARD.md` §1 ("chỉ tách code đã ship và đã test tay; chứng minh byte-identical; không gộp với đổi hành vi").

## 0. Tóm tắt & khuyến nghị

**Khuyến nghị: làm, nhưng ở Đợt E (sau khi Đợt A–C ship và test tay xanh), theo phương án A bên dưới.**

Lý do ngắn: khối này là **1 087 dòng (20% file)** mà giao diện với phần còn lại **hẹp bất ngờ** — cần 10 tên từ ngoài + 11 thuộc tính của `ed` (trên tổng ~460 chỗ dùng `ed`), và chỉ **2 hàm** đi ra ngoài. Nó cũng là nơi lỗi "im lặng" nhất (chú thích đúng trên màn hình, sai trong file đã lưu) và **đã có lưới** (`test:rotate`, `test:managed`) cắt đúng các hàm này khỏi file đang ship. Đổi lại: không có lợi ích hiệu năng; lợi ích là **ranh giới tường minh** + agent/người đọc `editor.js` ít hơn 20%. Lợi ích vừa phải, rủi ro thấp-vừa nếu theo đúng quy trình — **không phải việc khẩn**.

## 1. Số đo

### 1.1 Ranh giới
Hai banner liền nhau: `// ---- PNG rasterisation for baking ----` (3066) và `// ---- baking ----` (3292), kết thúc trước `// ---- watermark dialog ----` (4153). **1 087 dòng**, 15 khai báo cấp IIFE, **0 biến `let` chia sẻ** (toàn `function` + một `const f` formatter dùng riêng trong khối — đã kiểm: 0 chỗ gọi `f(` ngoài khối).

| Khai báo | ≈ dòng | Dùng ngoài khối? |
|---|---:|---|
| `renderTextPng` / `renderArrowPng` / `renderWatermarkPng` / `rasterRedacted` | 85 / 69 / 26 / 36 | không |
| `deserializeManaged` | 132 | không (chỉ `importManaged` gọi) |
| `addManagedAnnot` | 221 | không |
| `importManaged` | 56 | **có** — `editor.js` gọi 1 chỗ ngoài khối (đường vào chế độ chỉnh sửa) |
| `drawAnnots` / `drawOneAnnot` / `drawWatermark` | 23 / **262** / 10 | không |
| `bakeInPlace` / `bakeWithRedaction` / `rememberSignatureWidths` | 15 / 42 / 10 | không |
| `bakePending` | 46 | **có** — `exit()` gọi + lộ ra `window.Editor.bakePending` (app.js gọi) |

⇒ **Chỉ 2 tên đi ra** (`bakePending`, `importManaged`).

### 1.2 Cái khối cần từ ngoài (OUT→IN)
17 tên IIFE-scope, thực chất **10 tên phải truyền vào** + 7 tự lấy được:

- **Trạng thái / thao tác trên `ed` (5):** `ed`, `annotsFor`, `hasAny`, `clearEdHistory`, `syncOverlays`.
- **Hàm/hằng thuần (5):** `hexRgb`, `hexToRgba`, `dataUrlToBytes`, `SYMBOL_KINDS`, `noteThreadText`.
- **Tự lấy được từ `window.PDFLib` (7):** `PDFLib, PDFDocument, PDFName, PDFRawStream, PDFHexString, PDFDict, rgb` — `managed-codec.js` đã làm đúng như vậy.

Thuộc tính `ed` mà khối đọc/ghi: **11** (`annots`, `watermark`, `seq`, `_managedPages`, `_taCommit`, `_importedManaged`, `highlightColor`, `sel`, `_dirty`, `active`, `_exiting`) — 34 chỗ. So với REGRESSION-GUARD (rào cản 3, "`ed` là điểm dính"): **rào cản đó không áp dụng cho khối này**.

### 1.3 Biến trần từ file khác (đã nạp trước `editor.js` — thứ tự không đổi)
`annot-text.js` (textFont, measureCtx, normTextStyle, layoutTextBox, rotatedBox) · `annot-geom.js` (arrowLabelPos, bumpOf, cloudPath, cloudPathPoly, symbolStrokes, isPtsKind, TEXTHL_OPACITY) · `managed-codec.js` (21 tên: `serializeManaged`, `pushPageAnnot`, `apMatrixFor`, `shapeAppearance`, `stripManagedFromPage`, …) · `app.js` (`state`, `pdfjsLib`, `toast`, `showOverlay/hideOverlay`, `rerenderChanged` — **chỉ dùng lúc gọi**, không lúc nạp). `window.*` lúc gọi: `desktop`, `DocHistory`, `repaintRenderedPages`.

### 1.4 DOM
Chỉ **4 dòng** (`document.createElement("canvas")`, trong 4 hàm `render*Png`/`rasterRedacted`). Phần còn lại thuần pdf-lib + dữ liệu.

### 1.5 Test đang canh khối này (và cái sẽ phải đổi)
| Bộ test | Cách đang nạp | Phải đổi khi tách |
|---|---|---|
| `annot-rotate.test.js` | `lift()` cắt `drawOneAnnot`, `addManagedAnnot`, `bake*`, `render*Png`… từ **`editor.js`** (+ `hexRgb`, `dataUrlToBytes` vốn ở lại) | đọc **cả hai file** khi cắt |
| `managed-image.test.js` | `lift()` cắt `deserializeManaged`, `addManagedAnnot`, `importManaged`… (+ `hexRgb`, `hexToRgba`, `edSnapshot` ở lại) | như trên |
| `annot-defaults.test.js` | `cutFunction(EDITOR_SRC, "deserializeManaged")` | đọc cả hai file |
| `state-bytes-writers.test.js` | khoá `"editor.js:bakePending"` | đổi khoá sang file mới |
| `global-scope.test.js` | luật thứ tự | **thêm** luật mới: file mới nạp sau `managed-codec.js` + `annot-*.js` + `app.js`, trước `editor.js` |
| `annot-geom` / `viewer-geom` / `raster-cap` | chỉ nhắc tên trong comment | không đổi |

Tất cả các `lift()` đều **ném lỗi "not found — renamed?"** khi không thấy hàm ⇒ nếu quên sửa loader, test **đỏ ngay**, không im lặng. Đó là chỗ an toàn của đề xuất này.

## 2. Phương án

**A (khuyến nghị) — file mới `renderer/editor-bake.js`, dạng nhà máy (factory), thân hàm byte-identical.**
- `editor-bake.js` là một IIFE, nhận phụ thuộc tường minh: `createBake({ ed, annotsFor, hasAny, clearEdHistory, syncOverlays, hexRgb, hexToRgba, dataUrlToBytes, SYMBOL_KINDS, noteThreadText })` và trả về `{ bakePending, importManaged }`; 13 hàm còn lại là nội bộ. Lấy `PDFLib` từ `window.PDFLib` như `managed-codec.js`.
- `editor.js` thay khối bằng một lời gọi nhà máy (~5 dòng) ngay sau khi `ed` và 5 hàm trên đã khai báo; `exit()` và `window.Editor` giữ nguyên chỗ gọi `bakePending`/`importManaged` (đổi từ hàm cục bộ sang destructure cục bộ của IIFE — **không phải** tên trần toàn cục, nên không dính BI-14).
- Thêm `module.exports` (kiểu `managed-codec.js`) ⇒ test có thể `require()` nhà máy và **bỏ hack cắt-lúc-chạy**, cấp `ed` giả như các lưới hiện nay. *Bước này tách riêng, làm SAU* (xem §3 bước 5): bước đầu giữ nguyên `lift()` để chỉ đổi một thứ mỗi lần.

**B — không tách; chỉ giữ mục lục** (`CLAUDE.md` đã có bản đồ banner). Rủi ro 0, lợi ích ≈ 0 cho ranh giới. Hợp lý nếu Đợt A–C làm bận hơn dự kiến.

**C — chỉ tách 4 hàm `render*Png`/`rasterRedacted` (226 dòng).** Nhỏ hơn, nhưng cắt ngang cặp đối xứng *render ↔ bake* (BI-40: hai đích dùng chung một bộ số học) mà không giải quyết được gì — **không khuyến nghị**.

## 3. Quy trình thi công (nếu GO) — mỗi bước một commit, lưới xanh trước & sau

0. **Điều kiện vào:** Đợt A–C đã ship, `/deploy` xong, test tay xanh trên bản đã phát hành (luật REGRESSION-GUARD: code mới chưa ship thì kiểm chứng trước, refactor sau). Lưu **sha256 + bản sao** `editor.js` của bản đã ship làm mốc so byte.
1. **Script chứng minh byte-identical** (`desktop/scripts/prove-bake-move.js`, dùng một lần, có thể commit): (a) cắt khối `[banner rasterisation, banner watermark)` từ `editor.js` mốc; (b) khẳng định nội dung đó xuất hiện **nguyên văn** trong `editor-bake.js` (trừ đúng phần bọc nhà máy đã khai báo trước, so từng dòng, in diff nếu lệch); (c) khẳng định `editor.js` mới = `editor.js` mốc − khối + phần thay thế khai báo trước; (d) **in danh sách tên tham chiếu bằng phép quét** (như `bake-deps.js` đã làm) và đối chiếu với đúng 10 tên ở §1.2 — một tên thừa/thiếu = dừng.
2. **Di chuyển** khối vào `editor-bake.js` + bọc nhà máy + `<script>` mới trong `index.html` (ngay trước `editor.js`) + luật thứ tự trong `test:scope`. `electron-builder.yml` đã gom `renderer/**/*` — không cần đổi.
3. **Sửa loader 3 bộ test** (§1.5) và khoá `state-bytes-writers`; chạy `npm test` + `run_tests.py`. Bất kỳ lưới nào đỏ vì lý do ngoài "không tìm thấy hàm" = **dừng, không sửa test cho xanh**.
4. **Probe Electron thật** (CDP, không dùng preview IDE): với mỗi `kind` (hộp chữ, mũi tên, mây, mây tự do, chữ nhật, elip, ảnh, ghi chú, ✓/✗, tô sáng theo chữ, vẽ tay, đo, redact, watermark) → Áp dụng → Lưu → mở lại → chỉnh sửa lại → **so từng byte PDF đầu ra** của bản mốc và bản mới trên cùng một kịch bản (ca "trang 0° ra byte y hệt", BI-59, là ca quan trọng nhất). Thêm các hàng liên quan ở `REGRESSION-GUARD.md` §5: *editor.js bake*, *Cổng bake*, *Đặt `/AP` trên trang xoay*, *Hướng trang trong bake*, *Nền hộp văn bản*.
5. *(tuỳ chọn, commit riêng, sau khi ship bước 1–4)* `module.exports` + chuyển các `lift()` sang `require()`.
6. **Tài liệu:** cập nhật tên file ở `REGRESSION-GUARD.md` (các hàng "`editor.js` — khối bake", BI-45/59/64/70…), `CLAUDE.md` (bản đồ), `help`/README nếu nhắc. Không dùng số dòng.

**Rollback:** một `git revert` của commit di chuyển; vì thân hàm không đổi nên không có dữ liệu người dùng nào bị ảnh hưởng ở mức định dạng file.

## 4. Rủi ro còn lại & điều chưa biết

- **Chưa chứng minh được bằng đo đạc tĩnh:** thứ tự khởi tạo — nhà máy phải được dựng **trước** mọi sự kiện có thể gọi `bakePending`; hôm nay hoisting của IIFE che mất chuyện này. Probe bước 4 phải bao gồm: mở app → vào Chú thích ngay → Xong ngay.
- ✔︎ **Đã kiểm — `ed` không bị gán lại:** là `const`, chỉ có đúng 1 lần khai báo (quét `ed =` bằng lookbehind, 1 kết quả = dòng khai báo). Nhà máy giữ tham chiếu `ed` lúc tạo là an toàn; **không cần** `getEd()`.
- ✔︎ **Đã kiểm — `reset()` sửa thuộc tính tại chỗ** (`ed.watermark = null`, `ed._managedPages = new Set()`, `ed._importedManaged = 0`…) chứ không thay object; `edSnapshot` sao chép `watermark` và đặt `_dirty`. Điều **vẫn cần xác nhận ở bước 4:** khối không giữ một bản sao `ed._managedPages` qua một `await` (nếu `reset()` thay Set giữa chừng thì bản sao cũ). Đây là hành vi **hiện hữu** và việc tách không làm nó tệ hơn, nhưng probe phải gồm "Xong → Huỷ ngay giữa lúc bake" để chắc.
- Phép đo phụ thuộc vào bộ quét tự viết (bỏ sót method trong object literal, không phân tích phạm vi biến cục bộ che tên): danh sách "tên đi vào" có thể **thiếu** nếu có tên bị che. Bước 1(d) là phép kiểm lại độc lập, đừng bỏ.
- Không có lợi ích hiệu năng; có thể có chút lợi ích cho agent (ít token khi đọc `editor.js`) — **ước tính, chưa đo**.

## 5. Cần bạn quyết khi tới lúc
1. GO / không GO cho phương án A ở Đợt E (hay giữ B).
2. Có làm bước 5 (`require()` thay `lift()`) không — nó đổi cách test hoạt động, đáng cân nhắc riêng.
