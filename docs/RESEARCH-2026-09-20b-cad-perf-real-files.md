# Bản vẽ CAD nhiều lớp — đo lại trên **file thật**

_Nghiên cứu 2026-09-20 (đợt 2). §0–§6 là **nghiên cứu, chưa sửa mã**; §7 là **phần đã
thi công** cùng ngày sau khi bạn chọn P1+P2, và §7.1 là một đề xuất của chính tài liệu
này **bị phép đo bác bỏ và gỡ đi**._

Đợt trước (`RESEARCH-2026-09-20-cad-many-layers-perf.md`) đo trên một file **tự dựng**
và tự ghi rõ cảnh báo đó ở §1.2. Đợt này đo trên **bốn bản vẽ thật** (hai file đầu ở §2,
file thứ ba ở §7.3, file 153 MB ở §7.4). Kết luận đổi khá nhiều — và bốn con số của đợt trước phải sửa lại (§6).

---

## 0. Trả lời ngắn

1. **Có chỗ nhanh được, và nó không nằm ở engine.** Nút thắt lớn nhất khi mở một bộ
   bản vẽ là **dải thumbnail chạy TRƯỚC trang đầu**. Mô hình hoá đúng trình tự của
   `app.js`: trang đầu hiện ở **1 241 ms**; đổi thứ tự → **299 ms** (nhanh **4,2×**).
   Trên file AutoCAD 22 trang: **1 238 ms → 254 ms** (**4,9×**).
2. **Lý do: vẽ một thumbnail 150 px đắt NGANG vẽ cả trang.** Đo được: cùng trang,
   canvas 75 px mất 168 ms, canvas 600 px mất 161 ms, canvas 36 MP mất 189 ms. Chi
   phí là **phát lại 77 000 lệnh vẽ**, gần như không phụ thuộc số pixel.
3. **Bảng Lớp (OCG) là đòn bẩy thật — nhưng không phải cho file bạn gửi.**
   `NA2-CD-S-LK4A.pdf` có **0 lớp** (đã bị làm phẳng, xem §2). Một file xuất thẳng từ
   AutoCAD trong cùng thư mục Downloads (`221121_layout`, producer `pdfplot14.hdi`) có
   **1 883 lớp**, và tắt một nửa số lớp làm thời gian vẽ trang rơi **85,6 ms → 24,1 ms
   (−72%)**.
4. **Zoom sâu**: vẽ **chỉ ô đang nhìn** thay vì cả trang nhanh **3–5×** (57 ms so với
   293 ms ở 300%) — và nét hơn, vì bỏ được cái hạ-dpr của `RasterCap`.
5. **KHÔNG nên đổi engine, KHÔNG nên nâng Electron *vì hiệu năng*.** Cả hai đều đã đo
   (§5.6, §5.7).

---

## 1. Cách đo — để bác bỏ được

| Thứ | Giá trị |
|---|---|
| Máy | Windows 11, máy dev, `devicePixelRatio = 1` |
| Runtime chính | `desktop/node_modules/.bin/electron` = **33.4.11 → Chromium 130** (đúng cái `npm start` chạy hôm nay) |
| Runtime đối chứng | Electron **44.4.1 → Chromium 152**, tải rời vào thư mục tạm, **không** đụng `node_modules` |
| pdf.js | bản đang vendor: **3.11.174** (`desktop/renderer/vendor/pdf.min.js`) |
| MuPDF | `pymupdf 1.27.2.3` trong `.venv` của repo |
| Probe | app Electron nhỏ, phục vụ file qua `http://127.0.0.1:7391` (bắt buộc — `file://` chặn `fetch`), cửa sổ `show: true` **và** `--disable-backgrounding-occluded-windows` + `--disable-renderer-backgrounding` + `--disable-background-timer-throttling` — xem §7.2, thiếu ba cờ này là số đo vô nghĩa |

**Bẫy đo đã xử lý:** canvas 2d của Chromium chỉ **ghi lại** lệnh vẽ rồi rasterise sau,
nên `render().promise` resolve xong **chưa có pixel**. Mọi số “render” dưới đây đều
ép rasterise bằng `ctx.getImageData(0,0,1,1)` rồi mới dừng đồng hồ.

**Một số đo tôi đã tự bác bỏ:** vòng 1 cho ra “đường offscreen của app đắt hơn vẽ
thẳng 60 ms”. Vòng 2 tách nhỏ từng pha thì ra: phát lệnh 101,6 ms + rasterise 67,8 ms
+ **blit copy 0,9 ms**. 60 ms kia là **nhiễu benchmark** (biến thể đầu mỗi vòng lặp
gánh GC của vòng trước), không phải chi phí thật. → **Không đụng vào đường offscreen.**

Probe nằm ở thư mục tạm của phiên; nói một tiếng là tôi đưa vào `tools/` để chạy lại
được bất cứ lúc nào.

---

## 2. Hai file thật trông như thế nào

| | **NA2-CD-S-LK4A.pdf** (file bạn gửi) | **221121_layout ZR1,ZR2,ZR3.pdf** |
|---|---|---|
| Dung lượng | 3,35 MB | 8,4 MB |
| Số trang | 10 | 22 |
| Khổ | A1 ngang, 2384×1684 pt, cả 10 trang | A1 ngang, 2384×1684 pt |
| Producer | **PDFsharp 6.1.1** | **pdfplot14.hdi** (driver “DWG To PDF” của AutoCAD) |
| **Lớp (OCG)** | **0** | **1 883** |
| Nét vẽ trang 1 | 34 086 path / 62 858 đoạn | 20 495 path / 42 883 đoạn |
| Lệnh pdf.js trang 1 | **77 491** | 41 280 (trong đó **714** `beginMarkedContentProps`) |
| Chữ trang 1 | 483 span / 3 088 ký tự | — |
| Ảnh / pattern / shading / annot | 0 / 0 / 0 / 0 | 34 ảnh logo nhỏ (334×87) |

**Phát hiện quan trọng:** file bạn gửi **không còn lớp nào**. Quét byte thô:
`/OCProperties` 0 lần, `/BDC` 0 lần. Nó đã đi qua PDFsharp (một bước ghép/lưu lại),
và ở đó thông tin lớp đã mất — hoặc bản xuất gốc vốn đã không bật “xuất thông tin
lớp”. Nghĩa là: **với riêng file này, một bảng Lớp sẽ trống trơn.**

Ngược lại, file xuất thẳng từ AutoCAD giữ nguyên lớp, và cấu trúc của nó rất dùng được:

- `/OCProperties/D/Order` = mảng **gom theo bản vẽ nguồn**: `[(ZR1-01.pdf) …refs…]` →
  dựng cây “tờ → lớp” là tự nhiên, không phải tự nghĩ ra cách gom.
- `/OCProperties/D/OFF` **rỗng** → mở ra là 1 883 lớp đều bật.
- Nhưng **mỗi trang chỉ thật sự dùng 46–103 lớp** (đếm `/Resources/Properties` của
  trang). → Bảng lớp phải lọc **theo trang đang xem**, không đổ cả 1 883 dòng ra.

---

## 3. Số đo — Chromium 130, pdf.js 3.11 (runtime đang chạy)

### 3.1 Từng pha

| Pha | NA2 (10 trang) | AutoCAD (22 trang) |
|---|---:|---:|
| `getDocument` | 56 ms | 65 ms |
| `getOptionalContentConfig` | 0,2 ms | **20,5 ms** (1 883 lớp) |
| `getPage` × mọi trang | 1,8 ms | — |
| `getOperatorList` trang 1 (nguội) | 110 ms | 93 ms |
| `getOperatorList` (nóng, đã cache) | **0,1 ms** | — |
| `render` vừa-trang | **165 ms** | **87 ms** |
| `render` thumbnail 150 px | **175 ms** | **97 ms** |
| `render` mọi trang, cộng lại | 1 493 ms | 4 774 ms |
| `getTextContent` trang 1 | 73 ms (606 item) | — |
| Dựng lớp chữ | 28 ms (446 span) | — |
| Heap sau khi chạm mọi trang | 47 MB | 139 MB |

### 3.2 Chi phí vẽ **không** phụ thuộc số pixel

NA2 trang 1, cùng nội dung, chỉ đổi kích thước bitmap:

| Tỷ lệ | 0,1× | 0,25× | 0,5× | 1× | 2× | 3× |
|---|---:|---:|---:|---:|---:|---:|
| Bitmap | 0,04 MP | 0,25 MP | 1 MP | 4 MP | 16 MP | 36 MP |
| Vẽ | 173 ms | 164 ms | 163 ms | 155 ms | 160 ms | 189 ms |

Và cùng kết luận từ phía thumbnail:

| Bề ngang thumbnail | 75 px | 150 px | 300 px | 600 px |
|---|---:|---:|---:|---:|
| Vẽ | 168 ms | 162 ms | 161 ms | 161 ms |

→ **Một thumbnail đắt đúng bằng một trang.** Đây là cái quyết định toàn bộ §4.

### 3.3 Mở tài liệu: thứ tự hiện tại so với thứ tự đề xuất

Mô hình hoá đúng `renderAll` → `renderThumbs` → `renderViewer` (cùng 150 px, cùng
`rootMargin` 300 px, cùng đường offscreen, cùng luật “vẽ ngay 2 trang đầu”):

| | trang đầu **thấy pixel** | 2 trang | mọi thumbnail xong |
|---|---:|---:|---:|
| **NA2 · hiện tại** | **1 241 ms** | 1 483 ms | 1 483 ms (8 thumb) |
| **NA2 · đề xuất** | **299 ms** | 541 ms | 1 363 ms |
| **AutoCAD · hiện tại** | **1 238 ms** | 1 896 ms | 2 231 ms (8 thumb) |
| **AutoCAD · đề xuất** | **254 ms** | 614 ms | 2 251 ms |

Dấu vết thời gian nói rõ nguyên nhân: `IntersectionObserver` của dải thumbnail nổ ở
**mốc 9 ms**, tức 8 thumbnail × ~150 ms đã chiếm trọn luồng chính **trước khi**
trang đầu kịp vẽ. Tổng thời gian đến-khi-yên không xấu đi; chỉ có **thứ tự phục vụ**
đổi.

### 3.4 Tắt lớp trên file AutoCAD thật

| | Chromium 130 | Chromium 152 |
|---|---:|---:|
| Vẽ trang 1, **bật cả 1 883 lớp** | 85,6 ms | 61,4 ms |
| Vẽ trang 1, **tắt một nửa** | **24,1 ms** | **14,4 ms** |

→ **−72%** (130) / **−77%** (152). Mạnh hơn hẳn con số −36% của file tổng hợp đợt trước.

### 3.5 Zoom sâu: vẽ cả trang so với vẽ một ô 1200×800

| | cả trang | một ô đang nhìn |
|---|---:|---:|
| NA2 @200% (16 MP) | 159 ms | 85 ms |
| NA2 @300% (36 MP) | **293 ms** | **57 ms** |
| NA2 @500% (100 MP → `RasterCap` hạ dpr xuống 0,57) | không vẽ nổi ở dpr thật | **51 ms**, dpr thật |
| AutoCAD @300% | 121 ms | 38 ms |

→ Skia **có** cull hình học nằm ngoài ô. Vẽ theo ô vừa nhanh **3–5×** vừa **nét hơn**,
vì không phải đánh đổi độ phân giải như `RasterCap` đang làm (BI-78).

### 3.6 Luồng chính có bị treo không — không

Trong một lần vẽ trang (tổng 104 ms), khoảng **chặn dài nhất của luồng chính là
38,7 ms**. pdf.js tự cắt việc thành lát. Nghĩa là 1,8 s thumbnail **không** phải một
cú đơ 1,8 s, mà là một chuỗi ~20–40 ms rơi khung hình liên tục — khó chịu chứ không chết máy.

### 3.7 Bộ nhớ

| | NA2 (10 trang A1) | AutoCAD (22 trang A1) |
|---|---:|---:|
| Heap sau khi chạm mọi trang | 47 MB | 139 MB |
| Sau `page.cleanup()` cho mọi trang | **13 MB** | — |
| Trả giá khi cuộn ngược | vẽ lại 270 ms thay vì 228 ms | — |

≈ **3,5 MB/trang** thu hồi được — **không phải 50 MB/trang** như đợt trước đo trên file
tổng hợp. Xem §6.

---

## 4. Đề xuất — xếp theo (lợi ích ÷ rủi ro)

### P1 🔴 Trang đầu trước, thumbnail sau — và thumbnail lấy từ bitmap trang

**Lợi:** trang đầu **1 241 ms → 299 ms** (NA2) / **1 238 ms → 254 ms** (AutoCAD). Đo ở §3.3.

**Hai nửa, làm được độc lập:**

1. **Đổi thứ tự.** `renderThumbs` vẫn dựng DOM + đặt `IntersectionObserver` như cũ,
   nhưng callback **xếp chỉ số vào hàng đợi** thay vì gọi thẳng `renderThumbCanvas`.
   Hàng đợi chỉ bắt đầu rút sau khi `renderViewer` vẽ xong 2 trang đầu, và rút
   **một thumbnail mỗi `requestIdleCallback`**.
2. **Thumbnail miễn phí.** `renderPageCanvas` đã tạo sẵn một canvas **offscreen** chứa
   đúng bitmap trang. Trước khi nó bị vứt, `drawImage` thu nhỏ vào canvas thumbnail:
   **0,7 ms** thay vì 150–175 ms, cùng một bức ảnh.

**Về BI-4** (“không tính năng nào được đọc pixel canvas của viewer”): nửa 2 **không**
đọc canvas viewer. Nó đọc **canvas offscreen mà chính `renderPageCanvas` vừa tạo**,
bên trong cùng một hàm, trước khi `freePageCanvas` có cơ hội chạm vào bất cứ thứ gì.
BI-4 không bị chạm tới — và đây là lý do phải lấy từ `off`, **không** từ `m.canvas`.

**Cạm bẫy phải xử lý (đã soi mã, không phải suy đoán):**
- Khi `Editor.active`, `renderPageCanvas` vẽ với `AnnotationMode.DISABLE` → **không**
  được lấy bitmap đó làm thumbnail (thumbnail sẽ thiếu chú thích đã bake). Chỉ lấy khi
  `!editing`.
- `refreshThumb` / xoay / xoá / chèn trang vẫn phải đi đường `renderThumbCanvas` cũ —
  cổng “chờ trang đầu” chỉ áp cho **lần mở**, không áp cho cập nhật sau đó.
- Cờ `data-rendered` của thumbnail giờ có **hai** nơi ghi → phải là **một** hàm đặt cờ,
  không phải hai (BI-14).
- Bề ngang raster thumbnail giữ nguyên 150 px (BI-34) — chỉ đổi **nguồn** pixel.

**Rủi ro:** thấp. Không đụng `state.bytes`, không đụng hình học, không đụng zoom.

**Lưới test:** §5 bảng dưới, dòng 1–5.

---

### P2 🟡 Lớp chữ dùng `transform` khi zoom (thừa hưởng từ đợt trước)

Đo lại trên trang CAD thật: một nấc zoom tốn **6,4 ms** với `--scale-factor`, **0,1 ms**
với `transform`. Trên bản vẽ thì 6,4 ms là vặt (chỉ 446 span) — **nhưng** đúng thay đổi
đó cứu hợp đồng nhiều chữ (đợt trước đo 96–134 ms với 20 000 span).

Sửa đúng 5 dòng trong `applyScaleToDom`: đưa `.text-layer` vào chung vòng lặp đang xử lý
`.note-layer` / `.search-layer` / `.fr-layer`, và ghi `dataset.pscale` trong `addTextLayer`.

**Rủi ro:** chạm BI-36. Giữa gesture, vệt bôi đen là **ảnh phóng** của vệt cũ (lệch tối
đa một nấc, ~0,2 s) — đúng đánh đổi đã chấp nhận cho vệt Ctrl+F. `commitScale` dựng lại
đúng khi dừng tay.

---

### P3 🟠 Bảng **Lớp** (OCG) — vừa là tính năng CAD, vừa là tốc độ

Đo được **−72%** thời gian vẽ khi tắt một nửa lớp trên file AutoCAD thật. Acrobat /
Foxit / Bluebeam đều có bảng này; app hiện **không có gì** (`grep OCProperties|OCG|
optionalContent` trong `desktop/` + `api.py` → 0 kết quả).

**Thiết kế rút ra từ dữ liệu thật, không phải từ tưởng tượng:**
- File có **1 883** lớp nhưng **mỗi trang chỉ dùng 46–103** → mặc định **lọc theo trang
  đang xem**; có công tắc “xem toàn tài liệu”.
- Tên lớp là chuỗi xref dài kinh khủng
  (`xr-r16.Thang bo thang may KT TDH$0$B5.CT04_…$0$KT-Kyhieu`) → phải có **ô lọc** và
  cắt tên hiển thị (giữ đoạn sau `$0$` cuối cùng), tooltip là tên đầy đủ.
- `/D/Order` đã gom sẵn **theo bản vẽ nguồn** → dùng luôn làm cây, đừng tự chế.
- File không có OCG (như NA2) → **ẩn hẳn bảng**, không hiện bảng rỗng.
- Bật/tắt: `occ.setVisibility(id, bool)` rồi vẽ lại các trang đang có bitmap với
  `page.render({ optionalContentConfigPromise: Promise.resolve(occ) })`.

**Rủi ro:** trung bình. Rủi ro **cao** nằm ở chỗ *ghi* trạng thái lớp vào file
(đụng `/OCProperties`, đúng loại rủi ro mất dữ liệu đã ghi ở
`RESEARCH-2026-08-28-hide-pages-textbg`). **Đề nghị pha 1: chỉ xem/tắt tạm trong phiên,
không ghi vào file.** Kèm một quyết định cần bạn chốt: khi một lớp đang tắt thì
**In / Xuất ảnh / So sánh** theo màn hình hay theo file gốc (§7).

---

### P4 🟢 Zoom sâu: vẽ theo ô (tile) thay vì hạ độ phân giải — **để sau cùng**

Đo được 3–5× nhanh hơn **và** nét hơn (§3.5). Nhưng nó chạm thẳng BI-36 (hai nửa của
zoom), BI-78 (`RasterCap`) và **mọi** overlay đang bám vào `canvas.style.*`. Đây là
việc lớn — chỉ nên làm nếu bạn thật sự hay zoom sâu trên A0/A1, và làm **sau khi** P1
đã ổn định.

---

### ❌ Đã đo và **bác bỏ**

| Ý | Vì sao không |
|---|---|
| Bỏ canvas offscreen trong `renderPageCanvas` | blit copy chỉ **0,9 ms**; con số “60 ms” ở vòng đo 1 là nhiễu (§1) |
| `getContext("2d", {alpha:false})` | 159–172 ms so với 167–192 ms — nằm trong nhiễu, mà lại đổi cách nền trong suốt hiển thị |
| Nâng Electron 33 → 44 **vì hiệu năng** | AutoCAD 87 → 74 ms (−15%), NA2 165 → **176 ms** (xấu đi). Nâng Electron là việc bảo mật/bảo trì, không phải việc tốc độ |
| `page.cleanup()` khi trang trôi xa | thu hồi ~3,5 MB/trang trên file thật (không phải 50 MB), đổi lại cuộn ngược đắt thêm 42 ms. Chưa đáng |
| Đổi sang MuPDF/sidecar để vẽ | xem §6.2 — MuPDF **không** chậm như đợt trước nói, nhưng đường sidecar vẫn thua vì chi phí mã hoá + truyền + phải viết lại toàn bộ tầng overlay |
| Gom `getPage` theo lô | `getPage` × 10 trang = **1,8 ms**. Không có gì để lấy |

---

## 5. Lưới test (viết trước khi thi công)

| # | Mục | Kịch bản | Kỳ vọng |
|---|---|---|---|
| 1 | P1 | Mở `NA2-CD-S-LK4A.pdf` | Trang đầu hiện **trước** khi dải thumbnail vẽ xong; đo lại ≤ ~350 ms |
| 2 | P1 | Mở file 22 trang, cuộn dải thumbnail ngay lập tức | Thumbnail vẫn lấp dần, không trang nào trắng vĩnh viễn |
| 3 | P1 | Cuộn viewer qua trang 5 → nhìn dải thumbnail | Thumbnail trang 5 đúng ảnh trang 5 (lấy từ bitmap trang) |
| 4 | P1 | Mở Chú thích, vẽ vài thứ, cuộn tới trang mới | Thumbnail **không** bị lấy từ bitmap đang ẩn chú thích |
| 5 | P1 | Xoay / xoá / chèn / ghép trang | Thumbnail cập nhật đúng, không lệch chỉ số (BI-5, BI-39) |
| 6 | P1 | Hợp đồng A4 20 trang (file nhẹ) | Không chậm đi; thumbnail vẫn xong nhanh |
| 7 | P2 | Zoom rồi bôi đen chữ trên hợp đồng | Vệt chọn đúng chỗ sau khi dừng tay (BI-36) |
| 8 | P2 | Ctrl+lăn nhanh liên tục trên A1 | Trang bám tay, không nấc nào bị bỏ, dừng ~0,2 s là nét |
| 9 | P2 | Zoom trong lúc mở Ctrl+F | Vệt vàng đúng chỗ sau khi dừng |
| 10 | P3 | `221121_layout` (1 883 lớp) | Bảng liệt kê ~46–103 lớp của **trang đang xem**; tắt lớp → mất đúng nét đó, vẽ nhanh hơn |
| 11 | P3 | `NA2-CD-S-LK4A` (0 lớp) | Bảng **ẩn hẳn**, không lỗi console |
| 12 | P3 | Tắt lớp rồi In / Xuất ảnh / So sánh | Thống nhất **một** hành vi (phải chốt trước — §7) |
| 13 | Mọi mục | `cd desktop ; npm run test:geom ; npm run test:raster ; npm run test:split` + ma trận §5 của `REGRESSION-GUARD.md` (dòng “Virtualization / `renderPageCanvas` / `freePageCanvas`” và dòng “Zoom”) | Xanh |

---

## 6. Sửa lại bốn con số của đợt nghiên cứu trước

Đợt trước đã tự cảnh báo là đo trên file tổng hợp (§1.2 của tài liệu đó). Đây là phần
hiệu chỉnh trên file thật — không phải bắt lỗi, mà là đúng việc mà §7 câu 1 của tài liệu
đó yêu cầu làm.

**6.1 “Operator list ~50 MB/trang không bao giờ được thu hồi.”**
Trên file thật: ~**3,5 MB/trang** (47 MB → 13 MB cho 10 trang A1). P3 của đợt trước
(`page.cleanup()`) vì thế **tụt hạng**, không còn là việc đáng làm sớm.

**6.2 “Đưa việc vẽ sang MuPDF sẽ chậm đi ~10 lần (4 591 ms so với 425 ms).”**
**Không đúng trên bản vẽ thật.** Đo lại trên `NA2`, cùng khổ pixel (1133×800):

| | MuPDF 1.27 | pdf.js 3.11 |
|---|---:|---:|
| vừa-trang (1133×800) | **55–62 ms** | 165 ms |
| 100% (2384×1684) | 76 ms | 155 ms |
| 300% (7152×5052) | 250 ms | 293 ms |

MuPDF **nhanh hơn ~3×** ở mức vừa-trang. Kết luận “đừng đổi engine” **vẫn đúng**, nhưng
lý do khác hẳn: mã hoá PNG để chuyển qua tiến trình tốn thêm **50 ms** (vừa-trang) đến
**602 ms** (300%), cộng IPC và giải mã lại ở renderer là hoà hoặc lỗ — **và** đổi engine
nghĩa là viết lại toàn bộ tầng overlay (chú thích, lớp chữ, Ctrl+F, capture) vốn đang bám
vào `canvas.style.*` của pdf.js. Bác bỏ vì **kiến trúc**, không phải vì tốc độ raster.

**6.3 “Lớp chữ làm mỗi nấc zoom tốn ~105 ms.”**
Đúng với trang 20 000 span, **không** đúng với bản vẽ: trang CAD thật chỉ có 446 span →
**6,4 ms/nấc**. P1 của đợt trước (tức P2 ở đây) vẫn nên làm, nhưng nó là việc cho **hợp
đồng nhiều chữ**, không phải việc cho **bản vẽ**.

**6.4 “Tắt 4/8 lớp giảm ~36% thời gian vẽ.”**
Trên file AutoCAD thật, tắt một nửa trong 1 883 lớp giảm **72%**. Đòn bẩy **mạnh hơn**
đợt trước ước tính.

**Và một điều đợt trước không thể biết:** nút thắt số 1 khi mở file (dải thumbnail chạy
trước trang đầu, §3.3) chỉ lộ ra khi mô hình đúng **trình tự mở** — đo từng hàm riêng lẻ
không thấy được.

---

## 7. Đã thi công (2026-09-20) — P1 nửa thứ nhất + P2

Bạn chọn **P1 + P2**. Kết quả sau khi thi công, đo lại bằng đúng probe ở §1:

| | trang đầu có pixel — **trước** | **sau** |
|---|---:|---:|
| `NA2-CD-S-LK4A` (10 trang A1) | 1 224 / 1 028 ms | **298 / 269 ms** |
| `221121_layout` (22 trang A1) | 913 / 921 ms | **253 / 181 ms** |
| `260521_CLD_NAVY` (30 trang A1) — *2 trang đầu* | 574 / 543 ms | **129 / 122 ms** |

(hai lần chạy mỗi ô; trang 1 của file thứ ba chỉ có 17 nét nên "trang đầu" vốn đã nhanh,
cái được là **hai** trang đầu.) Đổi lại, dải thumbnail xong muộn hơn: 1,5–2,3 s thay vì
1,3–1,8 s. Đó là đánh đổi cố ý.

**Đã thay đổi:**
- `renderer/thumb-queue.js` (**mới**, thuần, có lưới `npm run test:thumbs` — 19 assertion):
  quan sát viên của dải thumbnail chỉ **xếp hàng**; hàng đợi mở sau khi `renderViewer` vẽ
  xong 2 trang đầu, rồi rút **một thumbnail mỗi lát rảnh** (`requestIdleCallback`).
- `app.js` `applyScaleToDom`: `.text-layer` vào chung nhóm `transform` với ba lớp phủ kia;
  `addTextLayer` ghi `data-pscale`.
- `docs/REGRESSION-GUARD.md`: **BI-87** (mới) + BI-36 (cập nhật) + một dòng trong ma trận §5.

**Kiểm chứng trên app thật** (CDP, không sửa mã để đo):
- mở `NA2-CD-S-LK4A.pdf`: 8/10 thumbnail vẽ (2 trang cuối chưa vào tầm — đúng), trang 1
  bitmap 2384×1684, lớp chữ **700 span** với `pscale=1`, hàng đợi đã mở và rỗng, **console sạch**.
- zoom: vị trí một span tính theo tỷ lệ khung trang **không đổi** qua 100% → 150% (giữa cử
  chỉ, `transform: scale(1.5)`) → 150% (sau commit, `pscale=1.5`) → 50% (`scale(0.3333)`)
  → về 100%. Sáu mốc, cùng `fx=0.64152, fy=0.49562, fw=0.00587` (BI-36).
- 22/22 bộ lưới hiện có của `desktop/` vẫn xanh.

### 7.1 Một đề xuất đã bị chính phép đo bác bỏ: thumbnail lấy từ bitmap trang

§4/P1 nửa thứ hai ("thumbnail miễn phí, 0,7 ms") **đã dựng, đã đo, và đã gỡ bỏ**. Nó nhanh
thật, và nó **không** đụng BI-4 (đọc canvas *offscreen* mà `renderPageCanvas` vừa tạo, không
phải canvas viewer). Nhưng nó làm **hỏng hình**: bitmap trang A1 rộng gấp ~16 lần thumbnail,
nên một nét mảnh 1 px ở đó bị trung bình xuống còn ~1/16 mực. Cùng canvas 150×105, trang 1
của `NA2-CD-S-LK4A.pdf`:

| | độ sáng trung bình | tỷ lệ điểm tối |
|---|---:|---:|
| lấy từ bitmap trang | 238,8 | **8,5%** |
| vẽ thẳng ở 150 px | 176,2 | **37,1%** |

Nhìn hai ảnh cạnh nhau thì rõ ngay: bản lấy từ bitmap **bạc phếch**, khó nhận ra là trang nào.
pdf.js vẽ mỗi nét tối thiểu một pixel; một phép thu nhỏ thì không — thông tin đã mất, không
tham số lọc nào lấy lại được. Và nó gần như **không mua thêm tốc độ**: 299 ms so với 314 ms
tới trang đầu, vì cái được nằm ở **thứ tự**, không nằm ở nguồn pixel. Kết luận được giữ lại
dưới dạng ghi chú ⛔ ngay trên `renderThumbCanvas` và trong **BI-87 luật 3**.

### 7.2 Một cái bẫy đo mới, đã làm hỏng số của cả đợt trước

**Cửa sổ bị che thì `page.render` của pdf.js TREO HẲN, không phải chậm.** pdf.js chạy vòng
vẽ canvas từ `requestAnimationFrame`, mà Chromium ngừng rAF ở cửa sổ bị coi là occluded
(`document.hidden === true`, đo được). Hệ quả: một probe chạy khi cửa sổ không ở trên cùng
cho ra những con số vô nghĩa — trong đợt này tôi thu được **185 156 ms** cho một lần vẽ trang.
Nhiều khả năng đây cũng là lời giải cho con số **107 924 ms ở trang 14** mà tôi ghi ở bản
nháp trước khi so Chromium 130/152: chạy lại có chủ đích 3 lần cho ra 118–174 ms, và tôi đã
**không** đưa nó vào kết luận.

**Luật đo từ nay:** mọi probe render phải bật
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-background-timer-throttling`.

Điều này **không** phải lỗi của thay đổi lần này: thumbnail cũng vẽ bằng cùng đường
`page.render`, nên cửa sổ bị che thì đường cũ cũng đứng y như vậy.

### 7.3 File thứ ba (`260521_CLD_NAVY_SGSU_TENDER_ID_ARC.pdf`) — **cũng 0 lớp**

30 trang A1, 19,6 MB, producer **GPL Ghostscript 10.05.1** qua PDF24 (nguồn là Revit:
`BIM_MODELS\INNO_SGSUNAVY_ID.pdf`). **0 OCG** — Ghostscript làm phẳng. Đây là file đầu tiên
trong loạt có trang thật sự nặng (file §7.4 còn nặng hơn):

| | trang 9 | trang 27 | trang 1 |
|---|---:|---:|---:|
| Lệnh pdf.js | 467 247 | 3 560 | 203 |
| `getOperatorList` | 286 ms | **793 ms** (ảnh 9469×6769) | 67 ms |
| Vẽ vừa-trang | **1 087 ms** | **1 136 ms** | 112 ms |
| Thumbnail 150 px | **922 ms** | 22 ms | 15 ms |

Cả bộ: vẽ 30 trang = **12,8 s**, riêng 30 thumbnail = **7,8 s**. Heap đạt 176 MB *dù* đã gọi
`page.cleanup()` sau mỗi trang. Hai điều đáng ghi:
1. Trên file này thumbnail chiếm ~85% chi phí trang ở những trang nặng ⇒ P1 ăn tiền nhất đúng ở đây.
2. Và đây **mới** là file mà `page.cleanup()` (P3 của đợt trước) có lý: một trang 467 k lệnh
   nặng hơn hẳn 77 k lệnh của `NA2`. Giá trị của P3 **phụ thuộc file**, không phải hằng số.

### 7.4 File thứ tư: `CS3HAM TKKT_Ghep.pdf` — 153 MB, 86 trang A1

Bạn đưa thêm file nặng nhất. **153 MB (146 MiB), 86 trang A1**, producer **GPL Ghostscript
10.07.0** qua PDF24 ⇒ **0 lớp OCG** (file thứ ba liên tiếp mất lớp). Content stream cộng lại
**199 MB**, ảnh cộng lại **906 MP**. Trang 1–2 là **bìa scan** — mỗi trang đúng một JPEG
4967×3509 (17,4 MP) và **8 lệnh vẽ**. Các trang bản vẽ thì ngược lại:

| | trang 15 | trang 25 | trang 85 | trang 1 |
|---|---:|---:|---:|---:|
| Nét vẽ (PyMuPDF) | 215 291 | 197 252 | 192 605 | 0 |
| Lệnh pdf.js | **485 567** | 443 892 | 397 331 | 8 |
| `getOperatorList` | 959 ms | 793 ms | 416 ms | 383 ms |
| Vẽ vừa-trang | **1 513 ms** | **1 672 ms** | 1 263 ms | 568 ms |

**App mở được, sạch.** Kiểm trên app thật: 86 thumbnail dựng đủ, 8 cái vẽ sẵn (đúng luật
lười) và **có mực**, trang 1 bitmap 2384×1684, hàng đợi thumbnail đã mở và rỗng, **console
không một lỗi**. RAM cả app ~**950 MB** (renderer 520 MB).

**Thay đổi hôm nay trên file này — trung tính đến tốt, và có một chỗ hơi xấu đi:**

| (3 lần chạy) | A hiện tại | B đã sửa |
|---|---:|---:|
| trang đầu | 534 / 537 / 540 ms | **564 / 561 / 560 ms** 🔴 chậm hơn ~25 ms |
| **2 trang đầu** | 2 536 / 2 828 / 2 834 ms | **1 233 / 1 238 / 1 247 ms** 🟢 **2,3×** |
| 8 thumbnail xong | 4 294 / 4 486 / 4 499 ms | 4 739 / 4 810 / 4 797 ms |

25 ms kia **không phải nhiễu**, và có lý do: trang 1 của file này là bìa scan chỉ 8 lệnh, nên
ở thứ tự cũ, thumbnail của **chính trang 1** chạy trước đã làm nóng operator list cho lần vẽ
trang đầy đủ (cả hai đều `intent: "display"` nên dùng chung cache). Đó là một món quà tình
cờ, và nó chỉ đủ bù khi trang đầu **rẻ**; ở ba file kia trang đầu là bản vẽ nặng nên 8
thumbnail nuốt mất 1 giây. Đổi 25 ms lấy 1 300 ms là đúng.

**Cái đắt thật trên file này KHÔNG phải thứ P1/P2 chạm tới.** Đo trong app thật, ở 100%,
nhảy tới một trang bản vẽ:

| | trang 3 | trang 15 | trang 25 | trang 37 | trang 85 |
|---|---:|---:|---:|---:|---:|
| tới lúc **có pixel** | 1 178 ms | 1 961 ms | **2 290–2 607 ms** | 1 130 ms | 1 162 ms |
| tới lúc xong hẳn (thêm lớp chữ) | 1 423 ms | 2 505 ms | 2 848–3 159 ms | 1 430 ms | 1 416 ms |

Đây là chi phí **cố hữu** của 200 k–486 k lệnh vẽ mỗi trang. Lớp chữ góp thêm 0,25–0,56 s
**sau khi** pixel đã lên, nên nó không làm chậm cái người dùng nhìn thấy.

**Và đây là file để trả lời dứt điểm P3 (`page.cleanup()`).** Mô hình cuộn qua 20 trang bản
vẽ rồi cuộn ngược 6 trang, cửa sổ giữ 3 trang như `KEEP_MARGIN_PX`:

| | hiện tại | thêm `cleanup()` |
|---|---:|---:|
| Tổng 26 lần vẽ | 14 827 ms | **16 334 ms** (+1,5 s) |
| Heap đỉnh | 364 MB | **261 MB** (−103 MB) |
| Heap còn lại | 364 MB | **196 MB** (−168 MB) |
| **Cuộn ngược 6 trang** | **1 384 ms** | **3 037 ms** (chậm **2,2×**) |

⇒ `cleanup()` mua bộ nhớ bằng tốc độ, **kể cả trên file nặng nhất**. Không đáng bật mặc
định; nếu làm thì phải có điều kiện (ví dụ chỉ khi heap vượt ngưỡng), và phải đo lại.

---

## 8. Cần bạn quyết

1. **“Chậm” của bạn là chậm ở đâu?** Ba thứ này sửa bằng ba cách khác nhau:
   (a) mở file lâu · (b) cuộn/zoom giật · (c) máy hết RAM khi mở nhiều bản vẽ.
   Nếu là (a) → P1 là toàn bộ câu trả lời.
2. **Bảng Lớp**: bạn có bản vẽ nào **còn lớp** để dùng thật không? (File gửi thì không
   còn — §2.) Nếu quy trình của bạn luôn đi qua một bước ghép/lưu lại làm mất lớp thì
   P3 không đáng làm, và thay vào đó nên chỉnh **cách xuất PDF từ AutoCAD/Revit**.
3. **Nếu làm P3:** khi một lớp đang tắt thì **In / Xuất ảnh / So sánh** theo màn hình
   hay theo file gốc? (Tôi nghiêng về: theo **file gốc**, và ghi rõ trên bảng Lớp.)
4. **Bạn có hay zoom sâu (>200%) trên A0/A1 không?** Câu này quyết định P4 có đáng hay không.
5. **Có muốn tôi đưa bộ probe vào `tools/`** để mọi con số trên chạy lại được không?
