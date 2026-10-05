# RESEARCH 2026-10-05 — Chú thích từ phần mềm khác & chế độ cột trái (Trang / Dấu trang / Chú thích)

> Trạng thái: Q1–Q4 ở §7 **đã chốt** (2026-10-05, theo khuyến nghị); Q5: đã nhận 1 file mẫu (§3.5). **Đợt 1 xong** (BI-96); Đợt 2a trở đi chưa làm.
> Mọi khẳng định bên dưới hoặc **đã đo** (probe, ghi rõ "ĐO") hoặc **đọc từ mã nguồn** (ghi `file:dòng`). Không có khẳng định nào về Foxit/Acrobat được kiểm chứng trên máy này — các ca đó nằm trong danh sách test tay (§6).

## 1. Hai yêu cầu

1. **Nhận diện chú thích do phần mềm khác tạo** (Acrobat, PDF-XChange, Foxit…): hộp văn bản, hình, nét vẽ, ảnh dán… mở trong Nabu phải **chọn / sửa / di chuyển / xoá** được như Foxit đang làm, thay vì chỉ hiện ra mà không đụng được.
2. **Cột trái có nhiều chế độ** như Foxit: Trang (thumbnail, đang có) · **Dấu trang** (bookmark/outline) · **Chú thích** (mọi chú thích + chỉnh sửa của Nabu).

## 2. Kết luận ngắn

| Hạng mục | Khả thi? | Độ lớn | Rủi ro chính |
|---|---|---|---|
| Danh sách chú thích (mọi loại, kể cả của phần mềm khác) | **Có**, dữ liệu sẵn từ pdf.js | S | thấp — chỉ đọc |
| Dấu trang — chỉ xem & bấm để nhảy | **Có**, `pdf.getOutline()` | S | dấu trang trỏ vào trang đã xoá (đã đo, §3.3) |
| Dấu trang — **không bị mất** khi kéo đổi thứ tự trang | Có | M | **hiện tại Nabu xoá sạch dấu trang khi kéo trang** (đã đo) |
| Dấu trang — thêm / đổi tên / xoá / kéo | Có (tự dựng cây `/Outlines` bằng pdf-lib) | M | ghi sai cây = file lỗi trong Acrobat |
| Sửa chú thích của phần mềm khác | **Có, cho 8 loại phổ biến** | L | ghi đè làm hỏng chú thích của đối tác; lệch hiển thị giữa overlay và bản gốc |
| Chú thích của Nabu sửa được trong Foxit/Acrobat (chiều ngược lại) | Có, nhưng là việc riêng | L | font tiếng Việt khi Acrobat/Foxit tự vẽ lại |

Không cần sidecar Python, không cần thư viện mới: pdf.js 3.11.174 và pdf-lib 1.17.1 đang ship đã đọc được đủ dữ liệu (§3.1).

## 3. Hiện trạng — đã đo và đọc mã

### 3.1 ĐO: pdf.js / pdf-lib đọc được gì từ chú thích "ngoại"

Probe: tạo file bằng PyMuPDF (ghi `/FreeText`, `/Square`… chuẩn kèm `/AP`, giống cách Acrobat/PDF-XChange làm), rồi đọc bằng đúng phiên bản đang ship. Script: `scratchpad/mk_foreign.py`, `scratchpad/probe_foreign.js` (sẽ chuyển vào `desktop/scripts/` khi bắt đầu Đợt 1).

| Loại (Subtype) | pdf.js `getAnnotations()` trả về | pdf-lib bổ sung được | Tương ứng ở Nabu |
|---|---|---|---|
| FreeText | `contentsObj.str` (tiếng Việt có dấu **đúng**), `defaultAppearanceData.{fontSize,fontColor}`, `color` (= nền), `rect`, `rotation`, tác giả `titleObj` | `/DA`, `/RC` (rich text), `/DS`, `/CL` (đường dẫn của callout), `/IT`, `/Q` (căn lề), `/BS` | `text` |
| Square / Circle | `rect`, `color` (nét), `borderStyle.width` | **`/IC` (màu nền) — pdf.js KHÔNG trả**, `/BS /D` (nét đứt), `/BE` (viền mây) | `box` / `ellipse` / `cloud` |
| Ink | `inkLists` (nhiều nét) | `/BS` | `draw` (Nabu: **1 nét/đối tượng** → Ink nhiều nét thành nhiều `draw`) |
| Line | `lineCoordinates`, `lineEndings` (`OpenArrow`…) | `/LE` | `arrow` (chỉ khi có đầu mũi tên) |
| Polygon / PolyLine | `vertices` | | `poly` (PolyLine = đường hở — Nabu `poly` là hình kín → cần kiểm tra) |
| Highlight | `quadPoints` | | `texthl` |
| Text (ghi chú dán) | `contentsObj`, `titleObj`, `name` (biểu tượng) | `/Popup`, `/IRT` (trả lời) | `note` |
| Stamp | chỉ `contentsObj` + có `/AP` | `/AP` → XObject (ảnh hoặc vector) | `image` — **mất mát** nếu stamp là vector |
| Underline / StrikeOut / Squiggly / Caret / FileAttachment / Widget (form) / Link | có | | **không có tương ứng** → để nguyên |

Thêm hai số đo quan trọng:
- Chú thích **sống sót** qua `PDFDocument.create()+copyPages()` (cách Nabu đổi thứ tự trang): 10/10 còn nguyên. Tức là hiện tại Nabu **không làm mất** chú thích của đối tác khi lưu — vấn đề chỉ là **không tương tác được**.
- `/Popup` là một chú thích riêng trong `/Annots` (con của ghi chú Text). Xoá ghi chú mà quên Popup = để rác trong file.

### 3.2 Đọc mã: vì sao hiện tại "không đụng được"

- Lớp sửa của Nabu chỉ nhận **chú thích của chính nó**: `importManaged()` bỏ qua mọi dict không có `/NabuKind` (`desktop/renderer/editor-bake.js:689-711`, dòng `!dict.get(NABU_KIND)) continue`). Lưu thì `stripManagedAnnots` cũng chỉ đụng `/NabuKind` → chú thích ngoại được giữ nguyên, đúng, nhưng là "vùng cấm".
- Ở chế độ xem, pdf.js vẽ `/AP` của chúng lên canvas (`AnnotationMode.ENABLE`, `app.js:1005`) → **nhìn thấy nhưng chỉ là pixel**. Đây là cái mà người dùng cảm nhận là "bị flat". Thực tế file **không** bị flatten (trừ ca §3.4).

### 3.3 ĐO: dấu trang

- `pdf.getOutline()` + `getDestination()` + `getPageIndex()` dựng lại đủ cây, tiêu đề tiếng Việt đúng, trang đích đúng.
- **Lỗi đang có**: kéo đổi thứ tự trang (`reorderPage`, `app.js:1928` — dựng lại tài liệu bằng `PDFDocument.create()`) → `/Outlines` của catalog **mất hoàn toàn** (ĐO: `after create+copyPages: /Outlines present: false`). `page-vault.js:21-26` đã ghi đúng hiện tượng này cho khoá catalog. Các đường khác cũng dựng lại tài liệu: `extractSelected` (`app.js:2603`), `runNup` (`:2757`), `runCombine` (`:4628`), `bakeWithRedaction` (`editor-bake.js:1077`), kéo trang sang tab khác (`page-move.js:175`).
- Xoá trang bằng `removePage` (giữ catalog): dấu trang trỏ vào trang đã xoá **không phân giải được** — pdf.js ném `Kid reference not found in parent's kids` (ĐO). Panel dấu trang phải chịu được lỗi này (hiện mục mờ, không nhảy).

Hệ quả: nếu thêm panel Dấu trang mà **không** sửa các đường trên, người dùng sẽ *nhìn thấy* dấu trang biến mất sau khi kéo một trang — lỗi vốn đã có nhưng hiện chưa ai để ý vì Nabu chưa hiện dấu trang.

### 3.4 Ba lỗi nhỏ đang có, phát hiện khi đọc mã (chưa probe trong Electron)

1. **Trong chế độ Chú thích, mọi chú thích ngoại biến mất khỏi màn hình.** `renderPageCanvas` dùng `AnnotationMode.DISABLE` khi `Editor.active` (`app.js:1005`) — mục đích là ẩn bản đã nướng của chú thích Nabu (overlay vẽ thay), nhưng nó ẩn **tất cả**, kể cả hộp văn bản của đối tác và **giá trị ô form**. Trang đã vẽ trước khi vào chế độ thì vẫn hiện (không nhất quán; chỉ vẽ lại khi file có chú thích Nabu — `editor.js:3631`). Người dùng có thể vẽ đè lên ghi chú của đối tác mà không thấy nó.
2. **Danh sách Ghi chú (panel phải) đổi nguồn khi vào chế độ Chú thích**: ngoài chế độ thì đọc mọi `/Text` trong file (`app.js:1201-1228`, gồm cả của đối tác); trong chế độ thì chỉ lấy `Editor.getComments()` → ghi chú của đối tác **biến khỏi danh sách**.
3. **Bôi đen (redact) một trang vừa có chú thích Nabu vừa có chú thích ngoại**: trang được dựng lại thành ảnh với `AnnotationMode.DISABLE` (`editor-bake.js:272-276`) → chú thích ngoại trên trang đó **mất hẳn** (không còn đối tượng, cũng không thành pixel). Trang không có chú thích Nabu thì chú thích ngoại thành pixel (đúng ý đồ ghi trong comment).

### 3.5 ĐO: file mẫu thật của khách (Q5)

`SNQ-S1-ID-SHD-AR-007-00_…_INNO Comment_Sign_D.pdf` — 10 trang, 10,7 MB, bản vẽ A3 ngang (1191×842) + 1 trang Letter;
nền tạo bởi iOS Quartz, chú thích thêm bằng phần mềm ghi `/RC … xfa:APIVersion="Acrobat:10.1.5"` (dấu vết kiểu Acrobat).
**Không có dấu trang** (catalog: `/AcroForm /Metadata /Pages /Type /Version`, form 0 trường). Script: `scratchpad/survey.js`.

| Loại | Số lượng | Điều đáng chú ý cho Đợt 3 |
|---|---|---|
| FreeText `/IT /FreeText` | 3 | `/DA (… /F1 10 Tf)` + `/DS font-family:Arial` + `/RC` (XHTML). **Màu chữ nằm trong `/DS`/`/RC`, không phải `/DA`** (`/DA` ghi `1 1 1 rg` = trắng — đó là nền). Đọc màu chữ phải ưu tiên `/DS`. |
| FreeText `/IT /FreeTextCallout` | 2 | có `/CL` (đường dẫn 3 điểm) + `/LE /OpenArrow`, `/RD` lệch lớn (khung chữ chỉ là một phần `/Rect`) → tách hộp chữ + mũi tên |
| Square | 3 | **`/BE << /S /C /I 1 >>` = viền mây** → ánh xạ sang `cloud` của Nabu, không phải `box` |
| Line | 6 | 4 cái **không có `/LE`** (đường thẳng trơn — Nabu chưa có kind "line" riêng, `arrow` không đầu?) và 2 cái `/IT /LineArrow` `/LE [/None /OpenArrow]` → `arrow` |
| Highlight | 1 | `/QuadPoints` chuẩn → `texthl` |
| Stamp | 2 | 1 cái **ảnh dán từ clipboard** (`/Name /clipboard.image…`, `/AP` chứa Image XObject Flate 464×269, không SMask) → *là chú thích*, nhập được (Q5 đã rõ cho file này); 1 cái stamp vector nhỏ |
| Popup | 1 | con của ghi chú — xoá chủ phải xoá theo |

Mọi chú thích đều có `/NM` (UUID) ⇒ khoá tìm lại dict gốc khi lưu (N2) dùng được trên file thật.

## 4. Thiết kế đề xuất

### 4.1 Nguyên tắc (không thương lượng)

- **N1 — Không chạm thì không ghi.** Chú thích ngoại được nhập vào overlay để chọn/sửa, nhưng nếu người dùng **không thay đổi** nó thì khi Lưu, dict gốc giữ **nguyên từng byte** (cùng tinh thần BI-59). Chỉ đối tượng bị sửa/xoá mới bị đụng. Một file của đối tác mở rồi lưu mà không sửa gì → chú thích của họ y hệt.
- **N2 — Không chắc thì để yên** (cùng triết lý `managedSrcBytes` trả `null`, BI-37): khi lưu, tìm lại dict gốc bằng `/NM` (nếu có) + Subtype + `/Rect` đã ghi nhớ lúc nhập; lệch → **không xoá**, báo toast. Thà có hai bản còn hơn mất chú thích của đối tác.
- **N3 — Loại không có tương ứng thì không nhập** (Underline/StrikeOut/Squiggly/Caret/FileAttachment/form/link): vẫn hiển thị, vẫn liệt kê ở panel Chú thích, không sửa được. Chú thích có cờ **Locked / ReadOnly** (`/F` bit 7, 8) → nhập ở dạng chỉ-đọc.
- **N4 — Một nguồn sự thật cho "kind"**: thêm loại nhập = đi qua đúng ~6 điểm của một kind (CLAUDE.md "Kiến trúc" mục 4); bộ ánh xạ ngoại→Nabu là **file thuần** (`foreign-annot.js`, `require()` được, có test lưới như `managed-codec.js`), không nhét vào `editor.js`.
- **N5 — Không gộp đợt**: sửa lỗi §3.4, panel cột trái, và nhập chú thích ngoại là **ba đợt riêng**, mỗi đợt một commit, test tay riêng.

### 4.2 Nhập chú thích ngoại (Đợt 3)

Luồng:
1. `enter()` → `importManaged()` (giữ nguyên) **+** `importForeign()` mới: duyệt `/Annots` bằng pdf-lib, bỏ qua dict có `/NabuKind`, ánh xạ theo bảng §3.1 → đối tượng overlay mang thêm `_foreign = { page, nm, subtype, rect, ref, dirty:false }`.
2. Overlay vẽ chúng bằng `renderAnnot` như mọi kind (vì trang đang vẽ với annotations DISABLE — chính cơ chế này đồng thời **sửa lỗi §3.4-1** cho các loại nhập được).
3. Mọi thao tác sửa đặt `dirty = true` (qua đường lịch sử hoàn tác sẵn có của editor).
4. `bakePending` → trong `bakeInPlace`: với mỗi `_foreign` **dirty** hoặc **đã xoá** → gỡ dict gốc (+ `/Popup` con, + trả lời `/IRT` nếu xoá ghi chú) theo N2; ghi lại bản mới. Không dirty → không làm gì, **không** ghi bản Nabu.
5. BI-60: đếm chú thích ngoại vào `_importedManaged` (hoặc biến song song) để "xoá hết" vẫn kích hoạt bake.
6. BI-3: không có chỗ ghi `state.bytes` mới — vẫn đi qua `bakePending` → `pushUndo()` sẵn có.

**Ghi lại dưới dạng gì khi đã sửa** — đây là quyết định lớn nhất (§7 Q1):

- **(A) Giữ kiểu gốc** — FreeText sửa xong vẫn là `/FreeText` (cập nhật `/Contents`, `/DA`, `/Rect`, xoá `/RC` cũ, `/AP` do Nabu vẽ) + gắn `/NabuData` để lần sau Nabu mở lại đầy đủ. Đối tác mở bằng Acrobat/Foxit vẫn sửa được như cũ. Tốn công: một bộ ghi cho mỗi Subtype.
- **(B) Đổi thành đối tượng Nabu** — tái dùng 100% `addManagedAnnot`. Nhanh, nhưng hầu hết kind của Nabu ghi ra `/Stamp` (`editor-bake.js:538-627`): hộp văn bản của đối tác, sau khi Nabu chỉ **dời chỗ**, sẽ thành một con dấu ảnh trong Acrobat — **đối tác không sửa chữ được nữa**. Đây là đúng cái vấn đề khách hàng đang than, chỉ theo chiều ngược lại.

Khuyến nghị: **(A) cho FreeText, Text-note, Highlight** (ba loại đối tác hay sửa qua lại); **(B) cho hình/nét** (Square/Circle/Ink/Line/Polygon) ở bước đầu, nâng lên (A) sau nếu cần. Stamp: chỉ cho **di chuyển / đổi cỡ / xoá** bằng cách sửa `/Rect` (theo đặc tả, `/AP` tự co giãn theo `/Rect`) — **không** raster hoá, không mất chất lượng.

Mất mát cần nói trước với người dùng: rich text nhiều kiểu trong một hộp (`/RC`) sẽ thành một kiểu duy nhất sau khi sửa trong Nabu; font Helvetica gốc hiển thị bằng font sans của Nabu trong lúc sửa; FreeText dạng callout (có đường dẫn `/CL`) → hộp chữ + mũi tên riêng.

### 4.3 Cột trái nhiều chế độ (Đợt 2)

- Thanh tab nhỏ ở `sidebar-head` (`index.html:425-433`): **Trang · Dấu trang · Chú thích**. `#thumbs` giữ nguyên DOM và vòng đời (thumb-queue, kéo thả trang không đổi); hai panel mới là anh em của nó, ẩn/hiện bằng `hidden`. Nhớ tab cuối trong prefs.
- **Dấu trang**: cây thu/mở, bấm → nhảy tới trang (và toạ độ `XYZ` nếu có), mục hỏng → mờ + tooltip. Chỉ đọc ở đợt này.
- **Chú thích**: mọi chú thích của tài liệu — của Nabu **và** của phần mềm khác — nhóm theo trang, có biểu tượng loại, tác giả (`/T`), đoạn nội dung, lọc theo loại/tác giả. Bấm → nhảy tới và nháy khung. Đang ở chế độ Chú thích → lấy từ overlay (gồm chưa lưu) **+** chú thích ngoại (sửa lỗi §3.4-2). Thay thế panel Ghi chú bên phải (§7 Q2).
- Không thuộc diện trả phí (chỉ xem); sửa vẫn đi qua `btn-edit` vốn đã trong `GATED_BTNS` (BI-9/BI-26). Chữ động (đếm số) → `SKIP_IDS` (BI-10); chuỗi mới → `i18n.js`.

## 5. Kế hoạch theo đợt

| Đợt | Nội dung | Tệp chạm | Kiểm chứng tự động | Test tay |
|---|---|---|---|---|
| **0** | Chuyển probe vào `desktop/scripts/probe-foreign-annots.js` + fixture sinh bằng PyMuPDF; xin **file thật** từ đối tác (Acrobat, PDF-XChange, Foxit) | scripts, fixture | probe chạy được | — |
| **1** ✅ | **ĐÃ LÀM (2026-10-05, BI-96).** Đổi hướng so với dự kiến: thay vì chép `/Outlines` sang tài liệu mới kèm ánh xạ ref, `reorderPage` **di chuyển trang tại chỗ** (`PageRange.movePageInDoc`) ⇒ catalog còn nguyên (dấu trang, form, metadata), ref trang không đổi nên dấu trang tự đúng. Ít mã hơn, ít rủi ro hơn. Bẫy kế thừa thuộc tính trang được ghim (BI-96 Luật 1–2). Các đường dựng lại khác (redact, trích, N-up, gộp) **chưa** đổi | `page-range.js`, `app.js` | `test:pages` 85/85 (25 cặp from/to, dấu trang, form, cây lồng nhau); 4 đột biến đều đỏ; probe Electron 9/9 | kéo trang trên file có dấu trang → Lưu → mở **Acrobat/Foxit** (chưa làm — cần máy có Foxit) |
| **2a** ✅ | **ĐÃ LÀM (BI-97).** Thanh tab cột trái + panel Dấu trang (chỉ đọc) trong file mới `side-panels.js` | `side-panels.js`, `index.html`, `app.css`, `app.js` (init + 2 hook `docChanged`), `i18n.js`, `help.js` | `test:side` 23/23 (mock mọi kiểu đích + pdf.js thật + trang đã xoá), 7 đột biến đều đỏ, `test:scope` có luật nạp mới; probe Electron 17/17 + F11 4/4 | F4, resize, F11 ✅ (probe); file thật từ Word/Acrobat có dấu trang — **chưa** (cần file) |
| **2b** | Panel Chú thích ở cột trái (mọi loại, cả ngoại), gỡ/đổi panel phải theo Q2 | như trên | test thuần cho bộ gom/nhóm | danh sách đúng trong & ngoài chế độ Chú thích |
| **3a** | Sửa lỗi §3.4-1/-2/-3 (một commit mỗi lỗi) | `app.js`, `editor-bake.js` | test ghim | probe Electron |
| **3b** | `foreign-annot.js` (ánh xạ thuần ngoại→Nabu) + `importForeign` + "không chạm thì không ghi" + gỡ dict gốc an toàn (N2) | file mới, `editor-bake.js`, `editor.js` (`enter`) | lưới ánh xạ từng Subtype; test **byte-identical** khi mở→lưu không sửa; test xoá gỡ cả Popup; `test:rotate` thêm trang xoay 90/180/270 | ma trận §6 |
| **3c** | Bộ ghi kiểu gốc (A) cho FreeText → Text → Highlight, mỗi loại một commit | `foreign-annot.js`, `editor-bake.js` | round-trip: sửa → lưu → đọc lại bằng pdf.js ra đúng Subtype + nội dung | mở lại bằng **Foxit & Acrobat**: còn là hộp văn bản, sửa được, tiếng Việt đúng |
| **4** *(tuỳ chọn)* | Sửa dấu trang (thêm/đổi tên/xoá/kéo) | `outline-*.js` | lưới cây `/First/Last/Next/Prev/Parent/Count` | mở trong Acrobat |
| **5** *(tuỳ chọn, chiều ngược)* | Hộp văn bản **mới** của Nabu ghi ra `/FreeText` thay vì `/Stamp` | `editor-bake.js` | `test:managed`, `test:rotate` | Foxit/Acrobat sửa được chữ của Nabu |

Mỗi đợt: `run_tests.py` + `npm test` xanh **trước và sau**; ghi ma trận "đụng gì → test gì" vào `REGRESSION-GUARD.md §5`, thêm BI mới cho N1/N2.

## 6. Ma trận test tay (Đợt 3)

Với **mỗi** file đối tác (Acrobat, PDF-XChange, Foxit) và **mỗi** loại trong bảng §3.1:
- mở → vào Chú thích → đối tượng **hiện**, **chọn được**, khung chọn khớp hình gốc (trang 0° và trang xoay 90/180/270)
- **không sửa gì** → Lưu → so file: dict chú thích ngoại **giống từng byte**
- dời chỗ / đổi cỡ / đổi màu / sửa chữ → Lưu → mở lại trong Nabu → đúng; mở trong **Foxit và Acrobat** → đúng loại, sửa tiếp được (với nhóm (A))
- xoá → Lưu → không còn chính nó, không còn Popup con, không ảnh hưởng chú thích khác
- Ctrl+Z trong editor và sau khi Áp dụng
- chú thích Locked → không sửa được, vẫn thấy
- form có giá trị → trong chế độ Chú thích vẫn thấy giá trị (lỗi §3.4-1)

## 7. Quyết định & câu hỏi còn mở

Đã chốt 2026-10-05 (người dùng chọn đúng khuyến nghị):
- **Q1 → Lai.** FreeText / Text-note / Highlight giữ kiểu gốc (A); Square/Circle/Ink/Line/Polygon thành đối tượng Nabu (B); Stamp chỉ dời / đổi cỡ / xoá qua `/Rect`, không raster hoá.
- **Q2 → Chuyển sang cột trái.** Một danh sách duy nhất ở tab "Chú thích"; nút "Ghi chú" trên thanh công cụ mở tab đó; bỏ `#comments-panel` bên phải (giữ tên `updateComments`/`window.updateComments` mà `editor.js` gọi — BI-14).
- **Q3 → Chỉ chú thích trong file** (của Nabu + ngoại, kể cả chưa lưu khi đang ở chế độ Chú thích). Không làm nhật ký phiên.
- **Q4 → Xem + không bị mất.** Đợt 1 + 2a; Đợt 4 (sửa dấu trang) để sau.

Còn mở:
- **Q5**: đã nhận **một** file (§3.5 — ảnh dán trong file đó LÀ chú thích Stamp). Vẫn nên có thêm file từ PDF-XChange / Foxit, vì với "ảnh dán vào": tuỳ phần mềm, ảnh có thể là chú thích `/Stamp` (nhập được) **hoặc** được ghi thẳng vào **nội dung trang** — trường hợp sau thuộc tính năng "Sửa đối tượng" (giống Foxit *Edit Object*), là một việc khác hẳn và lớn hơn.
