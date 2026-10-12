# Review 2026-10-12 — Thanh menu gốc (native menu bar) sau loạt v0.2.5x → v0.2.78

> Trạng thái: **Đợt 1 (M1, M2) ĐÃ LÀM — BI-105**; Đợt 2, 3 chưa làm. Mọi phát hiện dưới đây có
> dẫn chứng dòng mã; phần nào mới suy ra từ đọc mã (chưa probe runtime) được ghi rõ là **cần probe**.
>
> **Kết quả Đợt 1 (2026-10-12):** cổng `menuBlockReason()` ở dispatcher menu + `mergeFiles`/`insertFile`
> từ chối trước hộp chọn file khi chưa mở tài liệu + `rotateSelected` báo khi chưa chọn trang.
> M1 **đã được xác nhận bằng đo** trên mã HEAD cũ (app thật, bấm `MenuItem` thật): đang Chú thích,
> menu Xoay rồi Xoá ⇒ 3 → 2 trang, +2 bước hoàn tác, trình chú thích vẫn mở. Bản sửa: probe E2E
> 28/28 (có tài liệu, gồm cả Sửa nội dung) + 7/7 (không tài liệu); `test:menu` 151 ý, 9 đột biến đều đỏ.

## 1. Phạm vi & phương pháp

- "Menu bar" = menu ứng dụng Electron: `desktop/src/main.js` `buildMenu()` (template + `MENU_STR`
  vi/en), đi qua kênh `menu:cmd` (`preload.js` `onMenuCommand`) tới bảng `actions` ở
  `desktop/renderer/app.js` (`window.desktop.onMenuCommand`, gần cuối file).
- Đối chiếu với: thanh công cụ `renderer/index.html` (hai hàng + các dropdown `Trang ▾`,
  `Công cụ ▾`, `Xuất ▾`), `updateToolbar()` (luật bật/tắt), `GATED_BTNS` + `gateProFeature()`
  (BI-9/BI-26), `renderer/help.js` (trang Hướng dẫn), lịch sử git.
- Kiểm bằng script: `MENU_STR.vi` và `.en` cùng 45 khoá, không lệch.

## 2. Hiện trạng

| Menu | Mục |
|---|---|
| Tập tin | Tab mới · Cửa sổ mới · Mở… · In… · Lưu · Lưu thành… · Đóng tab · Đóng cửa sổ · Thoát |
| Chỉnh sửa | Hoàn tác · Làm lại · Cắt · Sao chép · Dán · Chọn tất cả |
| Trang | Xoay trái/phải · Xóa trang đang chọn · Ghép PDF… · Chèn trang… · Thay trang… · Tách trang… |
| Chuyển đổi | Khoá file… · Xuất ảnh trong PDF… · Trang PDF → ảnh… · Ảnh → PDF… |
| Hiển thị | Phóng to · Thu nhỏ · 100% · Toàn màn hình · Chia đôi · Thêm/Đóng khung xem |
| Trợ giúp | Hướng dẫn sử dụng (F1) · Cài đặt… |

Menu gần như **đứng yên từ khoảng v0.2.53** trong khi toolbar đã thêm rất nhiều tính năng.

## 3. Phát hiện (xếp theo mức độ)

### M1 · CAO — Lệnh Trang trên menu bỏ qua "đóng băng cấu trúc trang" khi đang chỉnh sửa

- Bất biến đã ghi trong mã: khi đang Chú thích (`Editor.active`) hoặc Sửa nội dung
  (`TextEdit.active`), mọi thao tác đổi cấu trúc trang bị khoá **để chỉ số trang không xê dịch
  dưới lớp phủ đang sống** (`updateToolbar()`; `openThumbMenu()`; `openNup()`).
- `replaceSelectedFromFile()` có guard và comment nói thẳng: *"The native menu is the one route
  that can still get here."* — nhưng guard đó **chỉ được thêm cho Thay trang**.
- Menu → `rotateSelected`, `deleteSelected`→`deletePages`, `mergeFiles`, `insertFile`→
  `insertBuffersAt` **không** kiểm `Editor.active`/`TextEdit.active`.
- Hậu quả dự kiến (**cần probe**): đang vẽ chú thích ở trang 5 → menu Trang → Xóa trang 2 →
  chú thích chưa ghi bị bake lên trang sai; Xoay khi đang vẽ → hình học lệch (BI-45).
  `extractSelected` qua menu khi đang chỉnh sửa đọc `state.bytes` chưa `bakePending()` → file
  tách ra thiếu chú thích chưa ghi (các lệnh Chuyển đổi đều đã gọi `bakePending()`).

### M2 · TRUNG BÌNH — Menu luôn "bật", không phản ánh trạng thái

- Template không có `enabled:` nào; toolbar thì tắt nút theo `has`/`editing`/`ready`.
- `mergeFiles()` **không** kiểm `state.bytes`: chưa mở file → menu Trang → Ghép PDF… → chọn
  file, chọn vị trí → `PDFDocument.load(null)` ném lỗi trong một handler không có `catch`
  (lỗi Promise không xử lý, người dùng không thấy toast). `insertFile()` cũng cho chọn file xong
  mới im lặng thoát.
- `rotateSelected()` khi chưa tick trang: thoát im lặng (Xóa thì có toast).
- Đang mở một hộp thoại (`modalOpen()`), phím Delete bị chặn nhưng **bấm chuột vào menu** thì
  lệnh vẫn chạy lên tài liệu phía sau.

### M3 · TRUNG BÌNH — Trang Hướng dẫn mô tả sai menu

- `renderer/help.js` (khối Tab/cửa sổ): *"Menu **Tập tin** còn có **Tách ra cửa sổ riêng** và
  **Chuyển tới cửa sổ**"*. Thực tế hai mục này **chỉ** ở menu chuột phải trên tab
  (`main.js`, handler menu ngữ cảnh tab). `git log -S` cho thấy chúng **chưa bao giờ** nằm trong
  menu Tập tin (thêm ở v0.2.42 cho menu tab; câu hướng dẫn viết ở v0.2.53).

### M4 · TRUNG BÌNH — Độ phủ: tính năng mới không có trên menu

Có trên toolbar nhưng **không** có trên menu bar:

- Tập tin: **Gộp file** (`openCombine`).
- Chỉnh sửa: **Chọn tất cả trang**, **Tìm** (Ctrl+F), **Tìm & Thay thế** (Ctrl+H),
  **Tạo bản theo mẫu**, **Chú thích**, **Sửa nội dung**.
- Trang: **Thêm trang trắng**, **Tách thành nhiều file**, **Xoá theo khoảng**,
  **Ghép nhiều trang vào một tờ**, **Đánh số trang**.
- Công cụ: **Bóc tách (AI)**, **OCR văn bản**, **Dịch**, **Nén**, **So sánh 2 PDF**,
  **Copy ảnh trong trang**, **Ký số**, **Xuất ra Office**.
- Hiển thị: **Vừa ngang / Vừa dọc / Vừa trang**, **Cột trang (F4)**, **Danh sách chú thích**.
- Trợ giúp: **Kiểm tra cập nhật**, **Bản quyền / Giới thiệu** (chỉ nằm trong Cài đặt).

Menu bar là nơi người dùng Windows *tra* lệnh và *học* phím tắt; Ctrl+F, Ctrl+H, F4,
PageUp/PageDown hiện chỉ xuất hiện trong trang Hướng dẫn và tooltip.

### M5 · THẤP — Phân loại lệch với toolbar

- Menu **Chuyển đổi** chứa *Khoá file* (bảo mật, không phải chuyển đổi) và 3 lệnh ảnh; toolbar
  chia **Công cụ ▾** (OCR/dịch/nén/so sánh/copy ảnh/khoá) và **Xuất ▾** (Office/ảnh). Người dùng
  phải học hai bản đồ.
- **Cài đặt…** nằm trong **Trợ giúp** — trái thói quen Windows (Tập tin/Công cụ → Tuỳ chọn).

### M6 · THẤP, cần probe — "Chọn tất cả" hai nghĩa

- Chỉnh sửa → Chọn tất cả = `role: "selectAll"` (chọn **chữ DOM**); nút "Chọn tất cả" ở cột trang
  = chọn **trang**. Renderer không xử lý Ctrl+A. Cần probe xem Ctrl+A ngoài ô nhập đang bôi đen
  cái gì.

### M7 · THẤP — Nhãn

- "Xóa" (menu, `MENU_STR`) vs "Xoá" (toolbar) — lẫn hai kiểu bỏ dấu.

## 4. Đã kiểm — KHÔNG phải vấn đề

- **Cổng bản quyền (BI-9/BI-26):** mọi lệnh trả phí trên menu đều tự gate ở tầng hàm:
  `mergeFiles`/`insertFile`/`replaceSelectedFromFile`/`extractSelected` gọi `gateProFeature()`;
  `openEncrypt`/`extractImages`/`openPdfToImages`/`openImagesToPdf` qua `convertReady()`.
  Không có lỗ.
- **i18n menu:** vi/en đủ 45/45 khoá; mọi khoá đều được dùng (menu bar hoặc menu ngữ cảnh).
- **Hoàn tác khi đang Sửa nội dung:** `restoreSnapshot()` gọi `TextEdit.reset()` — mất phiên sửa,
  không hỏng dữ liệu; nút toolbar hành xử y hệt ⇒ không phải lỗi riêng của menu.
- **Gemini:** mặc định `gemini-3.5-flash-lite` đã đúng ở `api.py` (`GEMINI_MODEL_CHOICES` đứng
  đầu), `src/utils/config.py`, `src/agents/gemini_agent.py`, `renderer/app.js`, `index.html`.
  Chỉ `app.py` (giao diện Streamlit cũ, không thuộc app desktop) còn danh sách cũ.

## 5. Đề xuất

### Nguyên tắc kiến trúc

Hiện có **hai** bảng điều phối song song (onclick của toolbar và `actions` của menu) ⇒ mỗi
tính năng mới phải nhớ cả hai, và guard thì chỉ mọc ở một bên. Đề xuất: **menu đi qua cùng một
cổng kiểm như toolbar**, theo một trong hai cách:

- **(A, khuyến nghị) Guard ở dispatcher:** trong `onMenuCommand`, trước khi gọi `actions[cmd]`,
  một hàm `menuBlocked(cmd)` dùng **chung** điều kiện với `updateToolbar()` (`has`, `editing`,
  `modalOpen()`), có toast lý do. Một chỗ, ghim được bằng test, không cần kênh IPC mới
  (`test:ipc` không đổi).
- (B) Đồng bộ `enabled` của mục menu từ renderer sang main (kênh mới `menu:state`, phải gửi lại
  khi đổi tab/cửa sổ). Đẹp hơn về UX nhưng thêm kênh + trạng thái theo tab ⇒ để sau, nếu cần.

Mục mới cho tính năng nằm trong module (editor.js, find-replace.js, batch-variants.js,
signatures…) phải gọi qua API `window.X` đã lộ hoặc qua hàm đã tự gate — **không** thêm gọi
"tên trần" chéo file (BI-14), **không** viết logic mới trong mục menu (BI-26).

### Cấu trúc menu đề xuất (gương của toolbar)

| Menu | Mục |
|---|---|
| Tập tin | Tab mới · Cửa sổ mới · Mở… · **Gộp file PDF…** │ Lưu · Lưu thành… │ In… │ Đóng tab · Đóng cửa sổ · Thoát |
| Chỉnh sửa | Hoàn tác · Làm lại │ Cắt · Sao chép · Dán │ **Chọn tất cả trang** │ **Tìm… (Ctrl+F)** · **Tìm & Thay thế… (Ctrl+H)** · **Tạo bản theo mẫu…** │ **Chú thích & đánh dấu** · **Sửa nội dung** |
| Trang | (gương `Trang ▾`) Ghép · Chèn · Thay · **Thêm trang trắng** │ Tách đang chọn · **Tách nhiều file** │ Xoay · Xoá · **Xoá theo khoảng** · **Ghép nhiều trang/tờ** · **Đánh số trang** |
| **Công cụ** | **Bóc tách (AI)** · **OCR văn bản** · **Dịch** │ **Nén** · **So sánh 2 PDF** · **Copy ảnh** │ **Ký số** · Khoá file |
| **Xuất** | **Xuất ra Office…** │ Trang PDF → ảnh · Ảnh → PDF · Xuất ảnh trong PDF |
| Hiển thị | Phóng to · Thu nhỏ · 100% · **Vừa ngang/dọc/trang** │ **Cột trang (F4)** · **Danh sách chú thích** │ Toàn màn hình │ Chia đôi… |
| Trợ giúp | Hướng dẫn (F1) │ Cài đặt… · **Kiểm tra cập nhật** · **Bản quyền & giới thiệu** |

Phím mà renderer đã giữ (Ctrl+F, Ctrl+H, F4) phải khai `registerAccelerator: false` — cùng mẫu
Ctrl+P/Ctrl+Z/F11 — để không bắn hai lần. Cut/Copy/Paste **giữ nguyên** `role` (REGRESSION-GUARD
mục clipboard vật thể: Ctrl+V chỉ đi bằng sự kiện DOM `paste`).

### Thứ tự thực hiện (mỗi đợt một commit, không gộp hành vi với tái cấu trúc)

1. **Đợt 1 — sửa hành vi (M1, M2):** `menuBlocked()` ở dispatcher + `!state.bytes` cho
   `mergeFiles`/`insertFile` + toast cho xoay khi chưa chọn trang. Không đổi menu.
2. **Đợt 2 — tài liệu (M3):** sửa câu trong `help.js` (cả vi/en), chạy `test:help`.
3. **Đợt 3 — cấu trúc menu (M4, M5, M7):** thêm mục/đổi nhóm theo bảng trên, `MENU_STR` vi+en,
   cập nhật `help.js` + `docs/REGRESSION-GUARD.md` §5.
4. (Tuỳ chọn) M6 sau khi probe; (B) đồng bộ `enabled` nếu Đợt 1 chưa đủ.

### Lưới test

- **Mới — `test/menu-contract.test.js`** (node thuần, như `ipc-contract`): (a) `MENU_STR.vi`/`.en`
  cùng khoá; (b) mọi `send("x")` trong template có `x` trong `actions` của renderer và ngược lại;
  (c) dispatcher gọi `menuBlocked` trước `actions[cmd]`; (d) mục có accelerator trùng phím renderer
  giữ phải có `registerAccelerator: false`. Thử đột biến cho từng ý (khôi phục bằng `cp`, không
  `git checkout`).
- Chạy `npm test` + `run_tests.py` trước/sau.
- **Probe tay (Electron thật):** đang Chú thích → menu Trang → Xoay/Xoá/Ghép/Chèn ⇒ bị chặn kèm
  toast; tương tự trong Sửa nội dung; chưa mở file → Ghép ⇒ toast; mở hộp thoại In → menu Xoá ⇒
  bị chặn; bản cấp phép hết hạn → mỗi mục trả phí mới ⇒ hộp kích hoạt; đổi ngôn ngữ ⇒ menu đổi;
  Ctrl+F/Ctrl+H/F4 chỉ chạy một lần.
