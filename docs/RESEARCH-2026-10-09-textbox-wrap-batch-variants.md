# Nghiên cứu 2026-10-09 — (1) Hộp văn bản tự xuống dòng theo khung · (2) Tạo hàng loạt bản sao "đổi tên cấu kiện"

Trạng thái: **ĐÃ LÀM (2026-10-09)** — xem §3. Bản nghiên cứu gốc giữ nguyên bên dưới. Mọi số liệu dưới đây đo trên mã ở `44b2d89` (v0.2.77)
và trên file mẫu của khách `DAOL.I1.S-HS TKCS (PHAN THAP).pdf` (13 trang A1, `/Rotate 270`, PDFsharp 6.1.1).
Script đo nằm ở scratchpad của phiên, không đưa vào repo.

---

## 1. Hộp văn bản: khung có ảnh hưởng tới xuống dòng không?

### 1.1 Hiện trạng (đọc mã, có trích chỗ)

| Thứ người dùng thấy | Thực chất | Chỗ trong mã |
|---|---|---|
| Khung đang gõ kéo co được | `<textarea>` với `resize: both`; trình duyệt **tự gói chữ** khi gõ (wrap mặc định) | `app.css` `.annot-text-edit`; `editor.js` `openTextEditor` |
| Kích thước khung đó | **Không đi vào kết quả**. Comment gốc: "the size has no effect on the result, because layoutTextBox never re-wraps (it splits on \n and nothing else)" | `editor.js` ~2674 |
| Hộp sau khi xong | `w/h` = `measureText(text)` — co giãn theo **nội dung**, dòng chỉ ngắt ở Enter | `commit()` trong `openTextEditor` |
| Hiển thị hộp đã đặt | `.an-text { white-space: pre }` | `app.css:767` |
| Kéo co hộp đã đặt | **Không có tay nắm**: `text` không thuộc `RESIZABLE_KINDS` | `editor.js:77` |
| Bake ra PDF | `renderTextPng` → `layoutTextBox` (cùng engine với đo màn hình — BI-40) | `editor-bake.js` |

⇒ Đúng như người dùng mô tả: khung gõ **đánh lừa** — khi gõ thì chữ gói theo khung, bấm ra ngoài thì
thành một dòng dài. Đây là mô hình "point text" (chữ điểm) của Illustrator, không phải "area text".

### 1.2 Có nên đổi không? — Khuyến nghị: **thêm chế độ, không đổi mặc định**

Đổi thẳng hành vi cũ sẽ làm **mọi hộp đã lưu** trong file của khách (đọc lại qua `/NabuData`) bị gói
lại khác đi khi mở → vỡ BI-59 (byte y hệt) và làm sai bản vẽ đã giao. Nên làm như Illustrator / Foxit:

- **Bấm 1 cái** = chữ điểm (như hiện nay, không đổi gì).
- **Kéo 1 khung** = **hộp văn bản cố định bề rộng**: chữ tự xuống dòng theo bề rộng; chiều cao tự giãn
  (không có chữ bị cắt ẩn — kiểu "auto-fit height" của Word).
- Hộp cố định bề rộng có tay nắm **trái/phải** để đổi bề rộng → gói lại ngay (xem trước = kết quả).
- Một nút trong panel Định dạng: "Tự xuống dòng theo khung" bật/tắt cho hộp đang chọn.

### 1.3 Khả thi kỹ thuật — **cao**, rủi ro tập trung ở 1 chỗ

Điểm thuận: đã có sẵn `wrapText(text, maxWidth, measure)` (gói tham lam theo từ, từ quá dài thì cắt
theo ký tự) trong `foreign-annot.js`, đang dùng để nhập FreeText của Acrobat/Foxit, đo bằng chính
`layoutTextBox`.

Thiết kế (bất biến cần giữ: **màn hình và file đã lưu phải ngắt dòng y hệt** — BI-40):

1. Mô hình: thêm trường tuỳ chọn `boxW` (pt) cho kind `text`. **Không có `boxW` = hành vi cũ, từng byte.**
2. Ngắt dòng làm **một lần, trong JS**, trước `layoutTextBox` (cùng một hàm cho `measureText`,
   `renderTextPng`, và chuỗi hiển thị trên overlay). Overlay vẫn `white-space: pre` nhưng nhận chuỗi
   **đã ngắt sẵn** → trình duyệt không tự gói theo kiểu riêng của nó. Không dùng `pre-wrap` của CSS:
   thuật toán gói của trình duyệt ≠ của canvas ⇒ đúng màn hình, sai file (đúng loại lỗi BI-40/45).
3. `text` lưu **nguyên văn** (không chèn `\n` mềm) ⇒ đổi bề rộng là gói lại được, sửa chữ không bị
   dính dấu xuống dòng cũ. Justify dùng `boxW` làm bề rộng khối thay vì dòng dài nhất.
4. Lưu/đọc: `serializeManaged` ghi `boxW` **chỉ khi có** (như `fill`); `deserializeManaged` đọc lại.
5. Lợi ích phụ: FreeText nhập từ Acrobat/Foxit có thể mang `boxW` = bề rộng hộp của họ thay vì chèn
   `\n` cứng ⇒ sửa lại vẫn tự gói như ở Foxit (Đợt riêng, sau).

Chỗ chạm (theo CLAUDE.md §Kiến trúc 4): `annot-text.js` (hàm gói + tham số bề rộng), `editor.js`
(tạo bằng kéo, tay nắm ngang, textarea rộng = `boxW`, panel Định dạng), `editor-bake.js`
(`renderTextPng`/`addManagedAnnot`/`deserializeManaged`), `managed-codec.js`, `annot-geom.js` (tay nắm
chỉ-ngang), `foreign-annot.js` (FreeText xuất `/Rect` theo `boxW`).

Test: lưới `annot-text.test.js` (gói theo từ / từ dài / tiếng Việt / justify / charScale /
letterSpacing / list marker), round-trip codec (có/không `boxW`, cũ ⇒ byte y hệt), `test:rotate`
(hộp gói + xoay trang), probe Electron: gõ → kéo bề rộng → lưu → mở lại → so ảnh overlay và bake.

---

## 2. Tạo hàng loạt bản sao chỉ đổi tên cấu kiện (I1 → I2, I3, I4…)

### 2.1 Nền móng hiện có

Tìm & Thay thế đã có (`find-replace.js` + `/text-find-bin` + `/edit-text`). Yêu cầu mới =
"nhân bản file + Thay tất cả" lặp N lần, mỗi lần ra một file. **Không cần endpoint ghi mới**: dùng lại
`/edit-text` (BI-21/23/25/66 thừa hưởng nguyên vẹn).

### 2.2 Đo trên file mẫu (luồng thật, đúng payload `find-replace.js` gửi)

| Đo | Kết quả |
|---|---|
| Tìm `I1` | 25 kết quả / 13 trang, 0 vị trí "không thay được", 0.27 s |
| Tìm `DAOL` | 12 (span `DAOL.`) |
| Tìm `DAOL.I1` hay `DAOL.I1_BD-S` | **0** — xem 2.3-A |
| Thay `I1`→`I2` toàn bộ | 25 chỗ, 13 trang, **3.9 s** (lần 2: 1.7 s), file 5.46 → 3.56 MB |
| Vùng pixel khác (50 dpi) | Trang 2–13: **chỉ khung tên** (x 0.89–0.99, y 0.86–0.97); trang 1: chỉ tiêu đề bìa |
| Chữ khác trên trang | Không đổi (so token từng trang) |

⇒ **Khả thi**: ~2–4 s / bản cho bộ 13 trang; 10 bản ≈ 20–40 s.

### 2.3 Ba vấn đề phải xử lý trước — phát hiện từ file mẫu

**A. Mã bản vẽ bị PDF chia làm hai khối chữ.** `DAOL.` (khối b211) và `I1_BD-S-5.001` (khối b213) là
hai text block riêng, cùng đường chân chữ, cách nhau ~3 pt. `/text-find` chỉ nối trong **một dòng** của
PyMuPDF ⇒ truy vấn người dùng định gõ (`DAOL.I1_BD-S`) ra 0. Hướng sửa (trong `_find_build_index` /
`_find_scan_index`): nối các dòng **cùng hướng, cùng baseline, liền kề** thành một dòng tìm kiếm; và
nới luật "thay được": tính **vùng thực sự đổi** (bỏ tiền tố/hậu tố chung của chuỗi tìm và chuỗi thay:
`DAOL.I1_BD-S`→`DAOL.I2_BD-S` chỉ đổi `1`→`2`) — chỉ cần vùng đó nằm gọn trong **một** span. Cách này
cũng giúp Tìm & Thay thế hiện tại (ca "Bên **A**").

**B. Chữ thay vào thấp hơn ~10.5 % và bè hơn chữ gốc** (thấy rõ cạnh `DAOL.`). Bước bù chiều cao
BI-25 lấy `bbox_h / orig_size` = 1.000 chia cho `ascender−descender` của Arial Bold = 1.117 ⇒ thu cỡ
chữ 17.71 → 15.84.
*Đính chính (đợt A1):* nhận định ban đầu "tắt bù chiều cao là khớp bản gốc" là **sai** — so bằng mắt
ở 150 dpi; đo mực in thì bản tắt vẫn thấp ~10 %. Nguyên nhân thật (đo bằng fixture có kiểm soát):
PDFsharp ghi descriptor Ascent/Descent 728/−210 (< 1 em) ⇒ PyMuPDF trả bbox dày đúng `size` =
√(Sv·Sh), mất thông tin chiều dọc. Chữ gốc là Arial Bold Sv 19.8, width factor **0.8**. **Đã sửa ở A1**
(xem BI-25 trong REGRESSION-GUARD): cao 18.25→18.25, bìa 45.75→45.88.

**C. Lớp chữ sau khi thay sai mã ký tự.** Đọc lại file đã thay: `-` thành U+00AD (soft hyphen),
dấu cách thành U+00A0. Nhìn đúng, nhưng: tìm `I2_BD-S` trong file mới ra 0, copy-paste mang ký tự ẩn.
Arial dùng chung glyph cho U+002D/U+00AD (glyph 16) và U+0020/U+00A0 (glyph 3) — suy luận: ToUnicode
do PyMuPDF dựng chọn nhầm chiều ngược. Lỗi này **có sẵn ở Tìm & Thay thế / Sửa nội dung hiện tại**.
Với tính năng mới: luôn sinh từ **file gốc I1** thì không bị ảnh hưởng; nhưng sinh tiếp từ file đã sinh,
hoặc tìm trong file đã sinh, thì bị.

**D. Rủi ro khớp nhầm.** `I1` cũng khớp trong `I10`, `I11`… (dự án có thể có tháp I10+). "Đúng nguyên
từ" hiện coi `_` là chữ ⇒ `I1` trong `I1_BD` không phải nguyên từ. Cần: nhiều cặp quy tắc chính xác
(`THÁP I1`→`THÁP I{n}`, `I1_BD`→`I{n}_BD`) + bảng xem trước từng trang trước khi sinh.

### 2.4 Thiết kế đề xuất — "Tạo bản theo mẫu"

1. Panel: **Quy tắc** (1..n cặp Tìm → Thay, thay có biến `{v}`), **Danh sách giá trị** (`I2, I3, I4` hoặc
   khoảng), **Tên file** (mặc định: áp cùng quy tắc lên tên file: `DAOL.I1.S-…` → `DAOL.I2.S-…`),
   **Thư mục ra**.
2. **Xem trước** (một lần quét): bảng số chỗ khớp theo trang, cờ trang có số lượng bất thường
   (ví dụ bìa 1, trang khác 2), vị trí không thay được ⇒ người dùng xác nhận.
3. **Sinh**: với mỗi giá trị, `/edit-text` trên **bytes gốc** (không đụng `state.bytes` của tài liệu đang mở
   ⇒ không đụng BI-3/`pushUndo`), kiểm tra lại (quét file vừa sinh: 0 chỗ cũ, đủ chỗ mới), ghi file.
   Không ghi đè file có sẵn nếu chưa hỏi.
4. IPC: hiện có `file:write-pdf` (ghi đường dẫn bất kỳ) nhưng **chưa có hộp chọn thư mục** ⇒ thêm kênh
   `dialog:choose-dir` (+ kiểm tra trùng tên ở main); `test:ipc` phải xanh.
5. Bản quyền: nút vào `GATED_BTNS` (BI-9), cổng ở tầng hàm (BI-26); chữ động vào `SKIP_IDS` (BI-10).
6. Giới hạn: tài liệu > ~200 MB không thay được qua `/edit-text` base64 (đã có ở F&R) ⇒ báo rõ.

### 2.5 Thứ tự làm (mỗi đợt một commit, lưới xanh trước & sau)

| Đợt | Nội dung | Test |
|---|---|---|
| A1 | `/edit-text`: BI-25 bù chiều cao bắn nhầm trên chữ CAD/PDFsharp | `test_edit_text_*.py` + mẫu hoá đơn cũ + mẫu này, đo tỉ lệ cao/rộng |
| A2 | Lớp chữ sau thay: `-`/dấu cách đọc ra đúng | test Python: thay → `get_text` → so mã ký tự |
| B | `/text-find`: nối khối cùng baseline + luật "vùng đổi nằm trong 1 span" | test Python trên PDF dựng sẵn hai khối; `find-replace.test.js` |
| C | UI "Tạo bản theo mẫu" + IPC chọn thư mục | `test:ipc`, `test:scope`, test thuần (đặt tên file, quy tắc) + probe Electron |

Chưa làm A1/A2 mà ra C thì bộ bản vẽ sinh ra sẽ có số hiệu **khác cỡ chữ** so với phần còn lại của
khung tên — không chấp nhận được cho hồ sơ giao.

---

## 3. Kết quả triển khai (2026-10-09)

| Commit | Đợt | Nội dung | Kiểm chứng |
|---|---|---|---|
| `acbb57a` | A1 | BI-25: ca descriptor < 1 em (PDFsharp) — Sv từ advance trong chính font nhúng | cao chữ khung tên 18.25→18.25, bìa 45.75→45.88 |
| `ef4bd51` | A2 | BI-102: ToUnicode gộp theo xref — hết U+00AD/U+00A0 | tìm lại "I2_BD-S" 0→12 |
| `4508eeb` | B | `code_boundary` ("Khớp nguyên mã") cho /text-find | I1: 25 chỗ, không khớp I10/I11 |
| `2464703` | C | BI-103: "Tạo bản theo mẫu" | E2E: 2/2 file I2/I3 đúng, file mở không đổi |
| `0865050` | 1a | lõi `boxW` trong annot-text (ngắt dòng ở pt) | 153 ca annot-text |
| `7338cf3` | 1b | BI-104: UI hộp chữ cố định bề rộng | E2E 8/8, PNG bake 7 dòng = màn hình |

Quyết định đã chốt với người dùng: hộp cố định bề rộng **tự giãn chiều cao**; có thể có tháp I10+ ⇒ "Khớp
nguyên mã" bật mặc định + danh sách ngữ cảnh có ô tích.

### Để lại có chủ đích (việc sau, mỗi việc một đợt)
1. **Nối mảnh chữ cùng hàng** (`DAOL.` + `I1_BD-S-…` là hai khối) để tìm được nguyên mã `DAOL.I1_BD-S`. Không làm
   ở đợt này: đổi kết quả Ctrl+H hiện có (biên "Đúng nguyên từ" ở chỗ nối). Tính năng sinh bản không cần nó.
2. `_page_font_buffers` gộp ArialMT với Arial-BoldMT vào khoá họ `arial` (bản thường thắng) — đường "dùng lại
   font nhúng" có thể vẽ chữ đậm bằng font thường. A1 đã tránh bằng `_page_font_programs_exact`; chưa sửa gốc.
3. `/translate` (api.py `translate_pdf`) nhúng font hệ thống cùng kiểu ⇒ có thể mang cùng lỗi lớp chữ BI-102.
   Chưa đo.
4. FreeText nhập từ Acrobat/Foxit vẫn chèn `
` cứng (`wrapText`); có thể chuyển sang `boxW` để sửa lại vẫn
   tự gói như ở Foxit.
5. Sửa `*.py` ⇒ **phải build lại sidecar** trước khi đóng gói (`check-sidecar-fresh.js` sẽ chặn). Chưa build,
   chưa phát hành.
