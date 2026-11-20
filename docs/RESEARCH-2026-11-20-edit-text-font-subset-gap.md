# Sửa chữ / Tìm & Thay đổi font — file `0. TH.pdf` (2026-11-20)

> Trạng thái (cập nhật 2026-11-20): **ĐÃ LÀM bậc 2b (hướng A §6) — chưa commit, chưa build lại sidecar, chưa bấm tay trong app.**
> Kết quả: `api.py` +17 dòng, `src/pdf/fonts.py` +16 dòng (`_embedded_font_name`), `test_edit_text_font.py` 8 → 13 ca (đột biến 4/4).
> Probe `0. TH.pdf`: Tìm&Thay 22 chỗ → **22/22 Times New Roman Bold**, cỡ y hệt gốc; mực in vùng cố định "Tên dự án: " lệch 0.0 % (trước sửa +25 %).
> Sổ: BI-21 trong `REGRESSION-GUARD.md` đã thêm bậc 2b + dòng ma trận. Phần dưới là bản điều tra gốc (giữ nguyên).
> Số đo lấy bằng chính `api.edit_text` (đúng payload mà Tìm & Thay / Sửa nội dung gửi), PyMuPDF 1.27.2.
> Scratchpad (không thuộc repo): `repro.py`, `repro2.py`, `coverage.py`, `count_fonts.py`.

## 1. Kết luận một dòng

**Không phải hồi quy.** Với file này, câu thay "XÂY DỰNG PHÒNG TRUYỀN THỐNG BỘ XÂY DỰNG" ra
**DejaVu Sans Bold ở mọi phiên bản đã đo (v0.2.34 → v0.2.82)**. Đây là một **khoảng hở của thang 3 bậc
BI-21**: font gốc không tìm được theo *tên*, và font con (subset) nhúng sẵn thiếu glyph `Ề`, `Ố`.

## 2. Tái hiện

File: 58 trang, font `CIDFont+F1/F2/F3` (Identity-H, TrueType). Tên font trong `/BaseFont` **đã mất họ font**,
nhưng *bảng tên bên trong chương trình font* vẫn là `Times New Roman Bold` / `Times New Roman Regular`…

Tìm "Không gian trưng bày Bộ Xây Dựng" → 22 hit, thay bằng chuỗi chữ hoa:

| | Kết quả |
|---|---|
| Trang 0 | `DejaVu Sans Bold`, cỡ 10.35 (gốc: Times New Roman Bold 12.0) — **cả dòng** đổi, kể cả "Tên dự án: " không hề sửa |
| 22 span | **11 DejaVu Sans Bold + 11 Times New Roman Bold** — trộn lẫn tuỳ trang |

## 3. Nguyên nhân gốc (đã đo từng bậc, trang 0)

Thang BI-21 trong `/edit-text` (`api.py` khối "Font selection"):

1. **Bậc 1 — font hệ thống theo tên span.** Tên span = `CIDFont+F1` → `_resolve_local_font` trả `None`
   (không có họ nào tên "CIDFont"). **Hỏng ở đây.**
2. **Bậc 2 — font nhúng sẵn trong PDF.** `_page_font_buffers` lấy được chương trình font
   (`Times New Roman Bold`) nhưng là **subset**: thiếu `Ề`, `Ố` → `_font_covers` = False
   (cửa kiểm tra này đúng và phải giữ, nếu không sẽ ra ô vuông □ — BI-21/v0.2.34).
3. **Bậc 3 — DejaVu bó sẵn.** Rơi xuống đây. Vì `/edit-text` vẽ lại **nguyên span**, cả dòng đổi font.

Bậc 1 chỉ nhìn **tên span**; không ai dùng **tên thật nằm trong chính chương trình font**
(`fitz.Font(fontbuffer=…).name` = "Times New Roman Bold") để tìm font cài trên máy.

## 4. Hồi quy hay có sẵn? — chạy mã cũ trên cùng file (trang 0, 5 biến thể câu thay)

| Phiên bản | Câu chữ hoa của bạn (V1) | Câu thường/không thiếu glyph (V2–V5) |
|---|---|---|
| v0.2.34, v0.2.39 | DejaVu | **DejaVu cả khi không đổi chữ** (chưa có bậc 2) |
| v0.2.43, v0.2.55, v0.2.63, v0.2.73, v0.2.81, v0.2.82 (HEAD) | **DejaVu** | Times New Roman Bold (bậc 2 hoạt động) |

Từ v0.2.43 (BI-21 bậc 2) file này **tốt hơn**, chưa bao giờ xấu đi. Lưu ý: chạy mã cũ trên PyMuPDF hiện tại
(không phải PyMuPDF đương thời). Lỗi v0.2.43 từng sửa là *tên dính liền* ("TimesNewRomanBold"); đây là nguyên nhân khác, cùng triệu chứng.

## 5. "Chữ thường → chữ hoa" có phải nguyên nhân?

**Không phải bản thân chữ hoa.** Là *glyph có nằm trong subset của trang đó hay không*:

| Trang | Câu hoa (V1) thiếu | Câu thường (V2) thiếu |
|---|---|---|
| 0 | `Ề Ố` → DejaVu | không thiếu → giữ Times |
| 5 | không thiếu → giữ Times | `p y â ò ề ố ộ ự` → **DejaVu** |

Chiều đảo ngược giữa hai trang. Subset điển hình thiếu ~40–80 % chữ Việt có dấu, nên bất kỳ sửa chữ nào đưa vào một
dấu hiếm (Ề, Ố, ộ…) đều có nguy cơ — chữ hoa chỉ *hay* vấp hơn vì tài liệu ít dùng chúng.

## 6. Hướng sửa

**A (khuyến nghị) — thêm "bậc 2b" giữa bậc 2 và bậc 3.** Khi bậc 2 không phủ được: lấy tên thật từ chương trình
font đã trích (`_font_object(fontbuffer=buf).name`), gọi `embed_local(tên_thật, bold, italic)` (cùng hàm, cùng cache,
`_family_candidates` đã bóc "Bold/Regular"), rồi vẫn qua `_font_covers`. Chỉ chạm các ca **hiện đang rơi xuống DejaVu**
⇒ mọi ca bậc 1/bậc 2 đang chạy giữ **byte y hệt** (chuẩn BI-59). ~10 dòng.

*Nguyên mẫu ngoài repo (gửi `font="Times New Roman Bold"` thay `CIDFont+F1`):* **22/22 span** ra Times New Roman Bold,
cỡ y hệt gốc (12.0, 9.72… thay vì 10.35, 9.0 của DejaVu), nhìn bằng mắt khớp bản gốc.

Loại: **B** nhúng sẵn một Times New Roman đầy đủ vào bộ cài — to, vướng bản quyền font, và A đã đủ trên Windows.
**C** chỉ vẽ lại phần chữ đổi — đổi mô hình "vẽ lại cả span" (BI-23/25), rủi ro lớn, ngoài phạm vi.

Giới hạn của A: máy **không cài** họ font đó (Mac/Linux, font CAD riêng) vẫn rơi DejaVu như cũ — đúng chủ ý BI-21.

## 7. Kế hoạch (nếu duyệt) — mức L (chạm BI-21, sidecar phát hành)

1. Chạy baseline: `.venv\Scripts\python run_tests.py` (26/26 trước đó) + `cd desktop && npm test`.
2. Test mới trước (phải ĐỎ trên mã hiện tại): trong `test_edit_text_font.py`, PDF tổng hợp — nhúng DejaVu Serif,
   đổi `/BaseFont` thành `CIDFont+F1`, cắt subset còn vài ký tự (đã có `_subset_font`, `retag` trong `test_edit_text_rounds.py`),
   sửa chữ cần glyph thiếu → mong đợi font vẽ ra là **DejaVu Serif** (không phải Sans), `_notdef == 0`.
   Dùng font đi kèm matplotlib ⇒ không phụ thuộc `C:\Windows\Fonts`.
3. Sửa `api.py` (bậc 2b). → verify: test mới xanh; **đột biến** bỏ bậc 2b ⇒ test đỏ.
4. Ca chống hồi quy: tên đã tìm được (bậc 1), subset đủ glyph (bậc 2), font không cài (bậc 3) — kết quả **byte y hệt** bản trước.
5. Probe thật `0. TH.pdf`: 22/22 Times New Roman Bold; đo mực in bằng vùng cắt CỐ ĐỊNH (không dùng bbox của chính đầu ra).
6. Sửa `*.py` ⇒ **build lại sidecar** (check-sidecar-fresh chặn). Chưa bấm tay trong app ⇒ phải nói rõ khi báo xong.
7. Ghi sổ: BI-21 thêm bậc 2b + dòng ma trận §5; memory.

## 8. Chưa kiểm / ngoài phạm vi

- Chưa chạy trong Electron/app đóng gói; chưa thử máy không có Times New Roman.
- `/translate-pdf` dùng cùng cách chọn font (`api.py` ~3500) — **chưa đo**, tách đợt riêng nếu cần.
- Không rõ công cụ nào tạo tên `CIDFont+Fn` (đã đo: `subset_fonts()` của Nabu **giữ** tên font, chỉ thêm tiền tố subset ⇒ không phải do Nabu).
- Giả định: "Không gian trưng bày Bộ Xây Dựng" là chuỗi bị thay (theo mô tả); nếu bạn thay cả phần "Tên dự án: …" kết quả không đổi vì cả span được vẽ lại.
