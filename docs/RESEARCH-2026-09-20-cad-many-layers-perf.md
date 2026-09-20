# Bản vẽ CAD/Revit nhiều lớp — đo xem chỗ nào thật sự chậm

_Nghiên cứu ngày 2026-09-20. **Chưa sửa một dòng mã nào.** Mọi con số dưới đây đều
đo được và tái lập được bằng bộ probe mô tả ở §1._

**Câu hỏi:** file PDF xuất từ AutoCAD/Revit có rất nhiều lớp (layer) — có cách nào
làm nhanh khâu render / nạp trang không? Có công cụ mới nào đáng đổi sang không?

**Trả lời ngắn:**

- **Đổi engine KHÔNG phải câu trả lời.** Đo được: MuPDF (chính `pymupdf` app đang
  đóng gói) vẽ trang thử mất **4 591 ms**, pdf.js 3.11 trên cùng trang mất **425 ms**
  — pdf.js **nhanh hơn ~10 lần** vì nó vẽ qua canvas GPU của Chromium. Nâng pdf.js
  3.11 → 6.3 cũng **không** phải thắng thẳng (§4).
- **Ba chỗ chậm thật đều nằm trong mã của mình, và đều sửa được nhỏ gọn** (§5):
  lớp chữ (text layer) làm mỗi nấc zoom tốn **~105 ms**, thumbnail đắt ngang trang
  đầy đủ (**~525 ms/thumb**), và operator list **~50 MB/trang** không bao giờ được
  thu hồi.
- **Bật/tắt lớp (OCG) vừa là tính năng người dùng CAD cần, vừa là đòn bẩy tốc độ
  thật:** tắt 4/8 lớp làm thời gian vẽ trang giảm **~36%** (§3.3).

---

## 1. Cách đo — để bác bỏ được

| Thứ | Giá trị |
|---|---|
| Máy | Windows 11, cùng máy dev |
| Electron | **44.4.1 → Chromium 152** (tải rời vào thư mục tạm; `node_modules` trong repo hiện vẫn kẹt ở Electron 33 dù `pnpm-lock.yaml` đã ghi 44.4.1 — xem §6) |
| pdf.js | bản đang vendor **3.11.174** và bản mới nhất **6.3.289** (npm, 2026-08-29) |
| Probe | app Electron nhỏ, phục vụ file qua `http://127.0.0.1` (bắt buộc: `file://` chặn cả `fetch()` lẫn `import()` ESM), cửa sổ **`show: true`** (cửa sổ ẩn không rasterise — bẫy đã ghi ở đợt trước) |
| File thử | **tự dựng**, không phải bản vẽ thật — xem cảnh báo §1.2 |

### 1.1 Một phép đo dễ sai mà tôi đã dính

Lần chạy đầu, pdf.js "vẽ xong" trang 16 MP trong 96 ms còn MuPDF mất 2 827 ms. Sai:
**canvas 2d của Chromium chỉ GHI LẠI lệnh vẽ rồi rasterise sau.** `render().promise`
resolve xong không có nghĩa là đã có pixel. Mọi số dưới đây vì thế đều tách làm hai:

```
issue  = thời gian pdf.js phát lệnh vẽ
flush  = ép rasterise bằng ctx.getImageData(0,0,1,1)
```

### 1.2 ⚠️ File thử là file **tổng hợp**, không phải bản vẽ của bạn

Script dựng thẳng content stream: khổ **A1** (2384×1684 pt), **8 lớp OCG**
(`A-GRID / A-WALL / A-DIMS / A-HATCH / A-FURN / E-POWR / A-ANNO / TITLEBK`), mỗi lớp
bọc trong `/OC /Lx BDC … EMC`.

| Hồ sơ | Nét vẽ / trang | Text run / trang | Dung lượng |
|---|---:|---:|---:|
| `cad.pdf` (vừa) | 83 320 | 2 500 | 2,53 MB |
| `cad-dense.pdf` (nặng) | 333 280 | 10 000 | 6,72 MB |

Nó khớp **hình dạng** của một bản vẽ CAD (nhiều nét, nhiều lớp, nhiều nhãn chữ nhỏ)
nhưng **không** có: font SHX nhúng, tiling pattern cho hatch, ảnh raster nền, XObject
lồng nhau, transparency group. **Con số tuyệt đối sẽ khác trên file thật của bạn;
thứ hạng giữa các nút thắt thì nhiều khả năng không đổi.** Việc đầu tiên trước khi
thi công là chạy lại probe này trên **một bản vẽ thật**.

---

## 2. Mã hiện tại đang làm gì (đối chiếu nguồn)

| Khâu | Nơi | Ghi chú |
|---|---|---|
| Mở tài liệu | `app.js:631` `getDocument({data, isEvalSupported:false})` | không có tuỳ chọn nào liên quan OCG |
| Thumbnail | `app.js:680-750` | lười theo `IntersectionObserver`, render **riêng** ở bề ngang 150 px |
| Trang | `app.js:779-940` | lười + nhả bitmap ngoài `KEEP_MARGIN_PX` (1500 px) |
| Lớp chữ | `app.js:947-978` `addTextLayer` | dựng **mọi** span cho **mọi** trang đã vẽ |
| Zoom | `app.js:2804-2870` | `applyScaleToDom` ghi `--scale-factor` lên **từng** `.text-layer` |
| OCG / layer | **không có ở đâu cả** | `grep OCProperties\|optionalContent\|OCG` trong `desktop/` + `api.py`: **0 kết quả** |

**Về OCG, hai điều đã kiểm bằng cách đọc thẳng `vendor/pdf.min.js`:**

1. pdf.js **đã** tôn trọng cấu hình mặc định `/D` — lớp nào file CAD xuất ra ở trạng
   thái tắt thì không được vẽ. Nên app **không** đang vẽ thừa so với Acrobat.
2. Việc ẩn/hiện được quyết ở **phía hiển thị**, không phải phía worker:
   `beginMarkedContentProps("OC")` đặt cờ `contentVisible`, và cờ đó chặn `stroke` /
   `fill` / `showText` / `paintImageXObject` / `shadingFill`. Nghĩa là **tắt một lớp
   tiết kiệm khâu rasterise (phần đắt), không tiết kiệm khâu worker phân tích.**

---

## 3. Kết quả đo

### 3.1 Trang nặng (333 k nét, 10 k nhãn), pdf.js 3.11, Chromium 152

| Pha | Thời gian |
|---|---:|
| `getDocument` | 76 ms |
| `getOptionalContentConfig` | 0,9 ms (8 lớp) |
| `getPage(1)` | 0,4 ms |
| `getOperatorList` | **292 ms** (279 397 ops) |
| `render` @ vừa-trang (0,5 MP) | **502 ms** |
| `render` @ 100% (4,0 MP) | **425 ms** |
| `render` @ 200% (16,1 MP) | **1 350 ms** |
| `getTextContent` | 196 ms (10 045 item) |
| dựng text layer | 65 ms (19 978 span) |
| `getAnnotations` | 90 ms |

→ **Mở tới trang đầu tiên ≈ 1,1 s**, và cái đắt nhất là `render`, không phải khâu
nạp. Chú ý: `render` @0,5 MP **đắt hơn** @4 MP — chi phí là **phát lại 280 k lệnh
vẽ**, gần như không phụ thuộc kích thước bitmap. Điều này quyết định mấy kết luận sau.

### 3.2 So với engine "native"

| Engine | Vẽ trang nặng @100% |
|---|---:|
| pdf.js 3.11 (canvas Chromium) | **425 ms** |
| PyMuPDF 1.27 / MuPDF (`get_pixmap`) | **4 591 ms** |

MuPDF rasterise bằng CPU; pdf.js đẩy được xuống Skia/GPU. **Đưa việc vẽ sang sidecar
Python sẽ chậm đi ~10 lần** — chưa tính chi phí chuyển ảnh giữa hai tiến trình.
Giả thuyết "đổi sang engine native cho nhanh" **bị bác bỏ bằng đo đạc.**

### 3.3 Tắt bớt lớp có giúp không — có

| | pdf.js 3.11 | pdf.js 6.3 |
|---|---:|---:|
| `render` @100%, bật cả 8 lớp | 425 ms | 311 ms |
| `render` @100%, **tắt 4/8 lớp** | **273 ms** | **289 ms** |

→ **−36%** thời gian vẽ khi tắt một nửa số lớp (3.11). Với bản vẽ thật có 30–80 lớp
mà người dùng chỉ cần xem 5–10 lớp, tỷ lệ này sẽ còn tốt hơn.

### 3.4 Ba chi phí ẩn trong mã của mình

| Đo | Kết quả |
|---|---|
| Một nấc Ctrl+lăn, có 1 text layer 20 k span | **96 – 134 ms** |
| Một nấc Ctrl+lăn, không có text layer | **0,1 ms** ← sàn |
| Thumbnail 150 px, render riêng bằng pdf.js | **525 ms** |
| Thumbnail 150 px, thu nhỏ từ bitmap trang đã có | **66 ms** |
| Heap sau khi dựng operator list cho 2 trang | **105 MB** |
| Heap sau `page.cleanup()` | **55 MB** (≈ **50 MB/trang** thu hồi được) |

`app.js` gọi `page.cleanup()` **đúng một chỗ** (`app.js:2501`, đường in) và
`freePageCanvas` chỉ xoá bitmap — **text layer và operator list ở lại vĩnh viễn**.

---

## 4. Nâng pdf.js 3.11 → 6.3.289: đo rồi, **không** phải thắng thẳng

Cùng file nặng, **cùng Chromium 152**:

| Pha | 3.11.174 | 6.3.289 | |
|---|---:|---:|---|
| `getOperatorList` | 292 ms (279 k ops) | **533 ms** (150 k ops) | 🔴 chậm hơn 1,8× |
| `render` @ vừa-trang | 502 ms | **346 ms** | 🟢 −31% |
| `render` @100% | 425 ms | **311 ms** | 🟢 −27% |
| `render` @200% | 1 350 ms | 1 350 ms | ⚪ như nhau |
| `getTextContent` | 196 ms | **142 ms** | 🟢 −28% |
| **dựng text layer** | 65 ms | **796 ms** | 🔴 **chậm hơn 12×** |
| `getAnnotations` | 90 ms | 45 ms | 🟢 |
| **Tổng tới lúc thấy trang** (ops + render vừa-trang) | **794 ms** | **879 ms** | 🔴 **chậm hơn** |

Thêm ba dữ kiện:

- **`enableHWA: true`** (tuỳ chọn mới, mặc định `false`): đo 3 lần mỗi mức zoom —
  **không khác biệt** hoặc nhỉnh hơn một chút về phía xấu. Không phải nút thần kỳ.
- **pdf.js 6 KHÔNG chạy được trên Electron 33**: `UnknownErrorException: n.toHex is
  not a function` — nó dùng `Uint8Array.prototype.toHex`, chỉ có từ Chromium ~140.
  Chạy được trên Electron 44 (Chromium 152). Tức **C1 (Electron) là điều kiện cần
  của C2 (pdf.js)** — thứ tự trong `RESEARCH-2026-09-15` là đúng.
- API đã đổi thêm một chỗ nữa so với những gì §C2 của tài liệu đó liệt kê:
  **`OptionalContentConfig.getGroups()` đã bị gỡ**, thay bằng `getOrder()` + `getGroup(id)`.

**Kết luận:** nâng pdf.js là việc **bảo trì/bảo mật**, không phải việc **hiệu năng**.
Nếu nâng, phải xử lý hồi quy `TextLayer` 12× trước — mà §5.5 (P5) dưới đây lại làm
cho hồi quy đó gần như vô hại, nên thứ tự đúng là **P1/P5 trước, nâng pdf.js sau**.

---

## 5. Đề xuất — xếp theo (lợi ích ÷ rủi ro)

### P1 🔴 Zoom: cho `.text-layer` dùng `transform`, như ba lớp overlay kia

**Vấn đề.** `applyScaleToDom` (`app.js:2816-2820`) ghi `--scale-factor` lên từng
`.text-layer`. pdf.js 3.x đặt vị trí span bằng `calc(var(--scale-factor) * Npx)`,
nên **một dòng đó bắt trình duyệt tính lại layout của 20 000 span**. Đúng mười dòng
bên dưới, `.note-layer` / `.search-layer` / `.fr-layer` lại được xử lý **đúng cách**:
`transform: scale(k)` tính từ `dataset.pscale`.

**Đo.** Cùng lớp chữ 19 978 span, cùng nấc zoom:

| Cách | ms / nấc |
|---|---:|
| ghi `--scale-factor` (hiện tại) | **96 – 134** |
| `visibility:hidden` rồi mới ghi | 99 – 146 ← **không cứu được gì**, style recalc vẫn chạy |
| **`transform: scale(k)`** | **0,1 – 0,7** |
| không có lớp nào (sàn) | 0,1 |

**Việc phải làm.** Trong `applyScaleToDom`, đưa `.text-layer` vào đúng vòng lặp đang
xử lý `.note-layer` / `.search-layer` / `.fr-layer`: không đụng `width`/`height`,
đặt `transformOrigin`, `transform: scale(state.scale / dataset.pscale)`. Trong
`addTextLayer`, ghi `layer.dataset.pscale = String(state.scale)` như các lớp kia.
`commitScale` vốn đã dựng lại lớp chính xác ở tỷ lệ mới — không cần thêm gì.

**Rủi ro.** Chạm BI-36. Trong lúc đang lăn chuột, vệt bôi đen là **ảnh phóng** của
vệt cũ (lệch tối đa một nấc zoom, ~0,2 s) — **chính xác cùng đánh đổi đã chấp nhận
cho vệt Ctrl+F**. Dừng tay là dựng lại đúng.

### P2 🟠 Thumbnail của bản vẽ: thu nhỏ bitmap trang, đừng render lại

**Vấn đề.** Thumbnail 150 px không hề rẻ: vẫn phải phát lại toàn bộ operator list →
**525 ms/thumb**, đo được. Sidebar hiện ~8 thumbnail cùng lúc → **~4 s** worker+canvas
ngay khi mở một bộ bản vẽ, trong khi người dùng chỉ đang chờ **trang đầu**.

**Việc phải làm (hai nửa, độc lập):**
1. Khi trang `i` **đã** có bitmap trong viewer → vẽ thumbnail bằng
   `drawImage(pageCanvas, …)`: **66 ms** thay vì 525 ms, cùng một bức ảnh.
2. Với trang chưa vẽ: giữ nguyên đường cũ nhưng **xếp hàng theo `requestIdleCallback`**
   và **nhường trang đang xem đi trước**. Hiện `renderThumbs` và trang đầu tranh
   nhau **một** worker pdf.js duy nhất.

**Rủi ro.** Thấp; thumbnail là ảnh thuần. Nhưng nó **đọc pixel của canvas viewer** →
nằm sát ranh giới BI-4, phải hỏi trước (§7 câu 3).

### P3 🟠 Thu hồi operator list khi trang trôi khỏi cửa sổ giữ

**Vấn đề.** `freePageCanvas` nhả bitmap nhưng operator list (**~50 MB/trang** đo
được) ở lại trong heap mãi mãi. Bộ 20 bản vẽ = **~1 GB** không ai đòi lại. Đây đúng
là bản CAD của phát hiện M1 trong `PERF-MEMORY.md`.

**Việc phải làm.** Trong `freePageCanvas`, khi trang đã ra **ngoài** `KEEP_MARGIN_PX`
và không đang render/bake, gọi thêm `m.page.cleanup()`. Kèm ngưỡng: chỉ làm khi op
list thật sự lớn — với hợp đồng nhẹ thì `cleanup()` chỉ khiến trang phải parse lại
khi cuộn ngược, **lỗ**.

**Rủi ro.** Trung bình. `cleanup()` làm mất cache → cuộn ngược phải trả lại ~292 ms
parse. Phải đo A/B trên cả file nhẹ lẫn file CAD trước khi chốt ngưỡng. **Không được**
`cleanup()` khi đang chú thích / đang bake (BI-4, BI-2).

### P4 🟠 Bảng "Lớp" (OCG) — vừa là tính năng, vừa là tốc độ

App **chưa có gì** về OCG. Với người làm CAD đây là thiếu sót nghiệp vụ trước khi là
chuyện tốc độ: Acrobat/Foxit/Bluebeam đều có bảng Layers.

- Đọc: `doc.getOptionalContentConfig()` → `getGroups()` (3.x) / `getOrder()`+`getGroup()` (6.x).
- Tắt/bật: `occ.setVisibility(id, bool)`, rồi
  `page.render({ optionalContentConfigPromise: Promise.resolve(occ) })`.
- Lợi tốc độ đo được: **−36%** thời gian vẽ khi tắt 4/8 lớp.

**Rủi ro.** Trung bình–cao nếu làm cả phần *lưu* trạng thái lớp vào file (đụng
`/OCProperties`, tức đụng đúng loại rủi ro mất dữ liệu đã ghi ở
`RESEARCH-2026-08-28-hide-pages-textbg`). **Đề nghị pha 1 chỉ xem/tắt tạm trong
phiên, không ghi vào file.**

### P5 🟡 Lớp chữ theo yêu cầu, thay vì dựng sẵn

Sau P1, chi phí còn lại của lớp chữ là 196 ms `getTextContent` + 65 ms dựng DOM
(3.11) hoặc **796 ms** (6.3) mỗi trang. Dựng nó **lúc rảnh** (`requestIdleCallback`)
hoặc **khi người dùng thật sự cần** (bắt đầu bôi đen / mở Ctrl+F) sẽ cắt ~0,26 s
(3.11) hoặc ~0,94 s (6.3) khỏi đường tới-pixel-đầu-tiên của mỗi trang CAD.
Đây cũng chính là thứ vô hiệu hoá hồi quy `TextLayer` 12× ở §4.

### P6 🟢 Zoom sâu: cắt ô (tile) thay vì hạ độ phân giải

Ở 200% cả hai bản pdf.js đều mất **~1,35 s** — đây là tường rasterise, không phải
parse. `RasterCap` (BI-78) hiện giải quyết bằng cách **hạ dpr** → ảnh thô đi. Vẽ
**chỉ phần đang nhìn thấy** ở đúng dpr sẽ vừa nét hơn vừa nhanh hơn. Đây là việc
lớn, chạm thẳng BI-36/BI-78 và mọi overlay → **để sau cùng**, chỉ làm nếu người dùng
thật sự hay zoom sâu trên A0/A1.

### ❌ Những việc KHÔNG nên làm (đã đo, đã bác bỏ)

| Ý tưởng | Vì sao không |
|---|---|
| Đổi sang MuPDF/sidecar để vẽ | **chậm hơn ~10×** (4 591 ms vs 425 ms) |
| Nâng pdf.js 6.3 **vì hiệu năng** | tổng thời gian tới-trang **xấu hơn**; `TextLayer` chậm 12× |
| `enableHWA: true` | không đo được khác biệt |
| `visibility:hidden` lớp chữ khi zoom | không cứu được gì (99–146 ms) |
| Gom `getPage` theo lô | đã bác bỏ ở đợt 2026-09-15 (§9.1) — vẫn đúng |
| PDFium/WASM thay pdf.js | canvas GPU của Chromium đang thắng engine CPU; đổi là viết lại toàn bộ tầng overlay |

---

## 6. Một phát hiện phụ về môi trường

`desktop/package.json` ghi `electron: ^44.0.0`, `pnpm-lock.yaml` ghi **44.4.1**, nhưng
`desktop/node_modules/.pnpm` **chỉ có `electron@33.4.11`**. Tức `npm start` trên máy
này đang chạy **Chromium 130**, không phải 152 như đợt C1 đã chốt. Cần `pnpm install`
để đồng bộ lại — và cần nhớ điều này khi đọc mọi số đo cũ.

---

## 7. Cần bạn quyết / làm rõ

1. **Một bản vẽ thật.** Mọi con số trên là từ file tổng hợp. Cho tôi 1–2 file PDF
   xuất từ AutoCAD/Revit (loại hay mở nhất, và loại nặng nhất) thì tôi chạy lại
   đúng probe này và hiệu chỉnh thứ tự ưu tiên.
2. **"Chậm" ở đâu?** Ba thứ này sửa bằng ba cách hoàn toàn khác nhau:
   (a) mở file lần đầu lâu · (b) cuộn/zoom giật · (c) máy hết RAM khi mở nhiều bản vẽ.
3. **Thumbnail lấy từ bitmap trang (P2):** chấp nhận không? Nó đọc pixel của canvas
   viewer, hợp lệ về mặt kỹ thuật nhưng nằm sát ranh giới BI-4 nên tôi không tự quyết.
4. **Bảng Lớp (P4):** chỉ cần xem/tắt tạm trong phiên, hay cần **lưu** trạng thái
   lớp vào file? Cái sau rủi ro cao hơn hẳn. Và khi một lớp đang tắt: **In / Xuất
   ảnh / So sánh** theo màn hình hay theo file gốc?

---

## 8. Lưới test cho từng mục (viết trước khi thi công)

| # | Kịch bản | Kỳ vọng |
|---|---|---|
| 1 | P1 · Hợp đồng thường: zoom rồi bôi đen chữ | vệt chọn đúng chỗ như cũ (BI-36) |
| 2 | P1 · Bản vẽ A1: Ctrl+lăn nhanh liên tục | trang bám tay, không nấc nào bị bỏ; dừng ~0,2 s là nét |
| 3 | P1 · Zoom trong lúc mở Ctrl+F | vệt vàng vẫn đúng chỗ sau khi dừng |
| 4 | P2 · Mở bộ 20 bản vẽ | trang đầu hiện **trước** khi sidebar vẽ xong; thumbnail cuối cùng vẫn đúng ảnh |
| 5 | P2 · Xoay/xoá/chèn trang | thumbnail cập nhật đúng, không lệch chỉ số |
| 6 | P3 · Cuộn xa rồi cuộn ngược | trang vẽ lại đúng, không trắng; RAM thấp hơn mốc trước |
| 7 | P3 · Hợp đồng nhẹ | **không** chậm đi (ngưỡng phải chặn `cleanup()` ở file nhẹ) |
| 8 | P3 · Đang chú thích rồi cuộn xa | chú thích chưa Áp dụng còn nguyên (BI-4, BI-2) |
| 9 | P4 · File CAD có 30+ lớp | bảng liệt kê đúng tên lớp; tắt lớp → mất đúng nét đó, vẽ nhanh hơn |
| 10 | P4 · File **không** có OCG | bảng ẩn đi, không lỗi console |
| 11 | P4 · Tắt lớp rồi In / Xuất ảnh / So sánh | thống nhất một hành vi (phải quyết trước — §7 câu 4) |
| 12 | Mọi mục | `cd desktop ; npm run test:geom ; npm run test:raster ; npm run test:split` + lưới BI-36/BI-78 trong `REGRESSION-GUARD.md` |
