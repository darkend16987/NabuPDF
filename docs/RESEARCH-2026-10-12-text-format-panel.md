# Nghiên cứu 2026-10-12 — Bảng "Định dạng văn bản" (`#fmt-panel`): nên bổ sung gì

> Trạng thái (2026-10-12): **F1, F2, P1, P2 đã làm** — F1 = BI-106 (00e1267), F2 (bc0a03d), P1 + P2 = BI-107
> (5fd3a25); P3 + P4 = BI-108; P5 + P6 = BI-109. P7, P8 chưa làm.
> Phát hiện khi làm P6: hộp chữ XOAY lệch màn hình ↔ file (lỗi có từ v0.2.63) — xem BI-109. Mọi khẳng định có dẫn chứng; chỗ nào đã **đo** thì ghi rõ.

## 1. Hiện trạng (đã kiểm)

- `#fmt-panel` (`renderer/index.html`, `<aside class="fmt-panel">`; logic `renderer/editor.js` banner
  `// ---- text-box Format panel`; CSS `app.css` `.fmt-panel`).
- **Không có nút thu/mở.** `updateFmtPanel()` chỉ tự hiện khi đang Chú thích **và** (công cụ Chữ đang chọn **hoặc**
  đang chọn một hộp chữ), tự ẩn khi không. Không lưu trạng thái nào.
- Bảng **đè lên** khung xem: `position: absolute; right: 0; width: 236px; z-index: 21` ⇒ che 236 px mép phải trang
  trong lúc sửa chữ.
- Chỉ áp cho `kind === "text"`. Nội dung: căn lề (trái/giữa/phải/đều), thụt lề ±18 pt, danh sách •/1., "Tự xuống dòng
  theo khung" (`boxW`, BI-104), giãn dòng, khoảng đoạn, giãn chữ, giãn từ, co giãn ngang, độ mờ, gạch ngang, và
  nhóm "Sắp xếp theo trang" (căn giữa / sát mép).
- Font, cỡ, B/I/U, màu, nền, xoay nằm ở **thanh trên** (`#edit-bar`), **không** ở bảng.
- Mọi trường của `normTextStyle` (`annot-text.js`) đều có điều khiển, đều được ghi vào /NabuData (`managed-codec.js`)
  và đều được bake (`editor-bake.js` → `renderTextPng` → `layoutTextBox`).
- "Sửa nội dung" (`text-edit.js`) có thanh riêng `#tedit-bar` (font, cỡ, màu, nền, B/I/U); sidecar `/edit-text`
  (`api.py` model `TextEdit`) **không** có căn lề, gạch ngang, danh sách.

## 2. Lỗi phát hiện (nên sửa TRƯỚC khi thêm tính năng)

### F1 · Căn đều (justify): màn hình ≠ file đã lưu — **đã đo**
- Overlay `.an-text` là `white-space: pre`, chữ đã ngắt sẵn bằng `\n` (BI-104 cố ý: không để trình duyệt tự gói).
  Dòng nào trước một ngắt cứng thì CSS coi là "dòng cuối" ⇒ `text-align: justify` **không làm gì**.
- Đo trong Chromium của Electron (khung 400 px, "one two three four\nfive six"): mép phải dòng 1 = **129 px** với
  `left`, **129 px** với `justify`, **400 px** với `justify` + `text-align-last: justify`.
- Bake (`layoutTextBox`) thì căn đều mọi dòng trừ dòng cuối đoạn ⇒ người dùng thấy căn trái, lưu ra căn đều (loại
  BI-40). Sửa không phải một dòng CSS: `text-align-last: justify` sẽ căn đều cả dòng cuối đoạn (bake không làm) ⇒
  cần vẽ từng dòng thành phần tử riêng (dòng cuối đoạn: `left`), hoặc dùng chính số đo của `layoutTextBox`.

### F2 · Hướng dẫn mô tả sai bảng
- `help.js` (mục Hộp văn bản): "Bảng Định dạng văn bản hiện bên phải: font, cỡ, đậm / nghiêng / gạch chân, …" —
  font/cỡ/B/I/U ở thanh trên, không ở bảng.

## 3. Đề xuất bổ sung (xếp theo giá trị / rủi ro)

| # | Đề xuất | Vì sao (gắn với cập nhật mới) | Đụng tới | Rủi ro |
|---|---|---|---|---|
| P1 | **Nút thu gọn / mở rộng bảng** (thu thành dải hẹp ở mép phải; nhớ lựa chọn cho từng máy) | Bảng đè 236 px lên trang; với hộp tự xuống dòng (BI-104) người dùng phải kéo tay nắm ngay mép phải — đúng chỗ bị che | index.html, app.css, editor.js (`updateFmtPanel`), localStorage có try/catch | Thấp — không chạm model/bake |
| P2 | **Ô số "Bề rộng khung (pt)"** cạnh "Tự xuống dòng theo khung" | BI-104: tay nắm **chỉ hiện khi hộp không xoay** (`isFixedTextBox` đòi `!rot`) ⇒ hộp đã xoay chỉ còn đường kéo giãn ô gõ lúc đang gõ (ResizeObserver → `setBox`, không kiểm `rot` — **chưa probe** với hộp xoay); ô số cũng cho bề rộng chính xác, đồng đều giữa các nhãn | editor.js (`applyTextFmt` cho `boxW`) | Thấp — `boxW` đã có trong model, codec, bake |
| P3 | **Chèn ký tự kỹ thuật** (², ³, ±, ⌀, °, ×, ≤, ≥, ‰, µ) | Bản vẽ xây dựng / CAD (khoanh mây, đo kích thước) cần m², ⌀; chèn ký tự Unicode thay vì làm chỉ số trên/dưới (model mỗi hộp chỉ một kiểu) | editor.js (chèn vào ô gõ) | Thấp — cần kiểm font nhúng có glyph (BI-102 cho thấy glyph thiếu là lỗi thật) |
| P4 | **"Đặt làm mặc định"** + **"Xoá định dạng"** | Hiện chỉ màu và nét bút được nhớ qua phiên; đánh dấu cả bộ bản vẽ phải chỉnh lại kiểu mỗi lần mở app | editor.js (localStorage như màu mặc định) | Thấp–vừa — đừng làm đổi byte hộp cũ (BI-59) |
| P5 | **Sao chép định dạng** (chổi định dạng) giữa các hộp chữ | Bộ bản vẽ I1 → I2… (BI-103) cần nhãn đồng nhất | editor.js (copy `normTextStyle` + fontSize/color/fill) | Vừa — đi cùng undo của editor |
| P6 | **Viền khung hộp chữ** (màu, độ dày, nét đứt dùng lại `ed-dash`) | Nhãn/callout trên bản vẽ; memory dự án ghi "còn callout" | model + codec + bake + render (~6 nơi, mục "Thêm một kind/trường") | Vừa–cao — lệch render/bake (BI-40/45), cần `test:rotate` |
| P7 | **Cỡ chữ cho nhãn mũi tên / nhãn đo** | Trường `labelSize` **đã có** (đọc ở editor.js, editor-bake.js, deserialize) nhưng không có điều khiển; luôn 14 | editor.js (đưa `labelSize` vào bảng/thanh cho arrow, measure) | Vừa — 3 đường vẽ (overlay, bake, managed) |
| P8 | Căn lề / gạch ngang cho **"Sửa nội dung"** | Không có trong `/edit-text` | api.py + build lại sidecar | Cao — vừa phát hành BI-102; để sau |

Không đề xuất: chữ nhiều kiểu trong một hộp (rich text) — đổi model một-kiểu-một-hộp, đụng mọi đường bake.
"Khoảng đoạn" hiện chỉ cộng ở **dòng trống**; đổi sang "sau mỗi Enter" sẽ làm hộp cũ đổi bố cục ⇒ nếu muốn thì
phải là trường **mới**, không đổi nghĩa trường cũ.

## 4. Thứ tự gợi ý

1. F1 + F2 (sửa lỗi, một đợt riêng).
2. P1 + P2 (rẻ, giá trị rõ, không đụng model).
3. P3, P4, P5 theo nhu cầu; P6/P7 là một đợt "thêm trường" có đủ lưới `test:rotate`/codec.
