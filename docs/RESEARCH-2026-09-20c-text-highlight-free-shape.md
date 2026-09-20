# Nghiên cứu khả thi — (1) Tô sáng theo đoạn chữ được chọn · (2) Shape tự do nhiều cạnh

Ngày 2026-09-20 · nhánh `claude/vietnamese-ocr-ai-iSvwV` · **đã thi công xong, xem §10**.

Mọi con số dưới đây **đo trên app thật** (Electron 33 / pdf.js 3.11.174 / pdf-lib 1.17.1 đang
vendored trong repo), không suy luận. Các ảnh chụp màn hình probe nằm ở thư mục nháp của phiên
(`scratchpad/cadperf/seldraw6.png`, `seldraw2.png`, `hl-zoom.png`, `hl-annot.png`).

---

## §0 — Trả lời ngắn

| Yêu cầu | Khả thi? | Chi phí ước lượng | Rủi ro |
|---|---|---|---|
| **(1)** Tô sáng theo đoạn chữ được chọn (kiểu Word), giữ nguyên tô sáng theo hình hiện có | **Có — cao. Hạ tầng đã có sẵn 80%** | ~1 ngày công + lưới test | **Thấp**: tính năng mới, không đụng đường nào đang chạy |
| **(2)** Shape tự do vẽ bằng các đoạn thẳng, có edit/resize/nền/màu/copy/paste | **Có, nhưng không "miễn phí"** | ~1,5–2 ngày công | **Trung bình**: 2 trong 6 khả năng bạn liệt kê (**resize** và **sửa từng đỉnh**) **chưa tồn tại cho bất kỳ hình dạng-điểm nào** — phải viết mới |

Và một **phát hiện ngoài lề nhưng quan trọng**: tô sáng hiện tại (hình chữ nhật) khi **áp dụng
vào file** đang **làm mờ chữ bên dưới** — xem §3.4. Đây là lỗi có thật, đã chụp ảnh, và nó sẽ
được sửa "tiện thể" nếu làm tính năng (1).

---

## §1 — Phương pháp

Cùng cách làm đã dùng ở hai đợt nghiên cứu tốc độ CAD: **lái app thật bằng CDP, không sửa mã**.

```
electron . <file.pdf> --remote-debugging-port=9333 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling
```

(ba công tắc là bắt buộc — cửa sổ bị che thì `requestAnimationFrame` ngừng và `page.render`
của pdf.js **treo hẳn**; xem BI-87.)

Bốn probe đã chạy:

| Probe | Hỏi gì | File thật |
|---|---|---|
| `seltest.js` | `.text-layer` có cho Range/getClientRects dùng được trên PDF tiếng Việt không? | `1.TCVN 3890 - 2023.pdf` (47 trang, A4, chữ thật) |
| `seldraw.js` | **Vẽ** các ô tô sáng ra màn hình rồi **nhìn** | trang 6 (chữ thân bài) |
| `seldraw2.js` | Sửa lỗi ô trùng tìm được ở probe trên, đo lại, nhìn lại | trang 6 |
| `mkhl.js` + `mkannot.js` | pdf-lib ghi được `/BM /Multiply` không? pdf.js đọc `/Highlight` + `/QuadPoints` không? | PDF tự dựng, mở lại bằng chính app |

---

## §2 — Hiện trạng: cái gì đã có sẵn

### 2.1 Đã có lớp chữ chọn được

`app.js` `addTextLayer()` (≈ dòng 1005) dựng `.text-layer` của pdf.js trên **mọi trang có chữ
thật**; trang scan không có chữ thì **không** dựng (đúng — không chọn được pixel).

Đo trên trang 6 của TCVN: **255 span**, lớp chữ nằm **khít** trên canvas — lệch `dx 0 · dy 0 ·
dw 1px · dh 0`. Tức toạ độ lấy từ lớp chữ **dùng thẳng được** cho chú thích, không cần hiệu chỉnh.

### 2.2 Đã có "tô sáng" — nhưng là hình chữ nhật

`kind: "highlight"`, có `x/y/w/h`, nằm trong `RESIZABLE_KINDS`, màu riêng `highlightColor`
(`#ffd54a`), vẽ trên màn hình bằng `mix-blend-mode: multiply; opacity: .4` (`app.css:708`).
**Bị làm phẳng thành pixel khi áp dụng** (không round-trip). Yêu cầu của bạn là giữ nguyên nó —
tài liệu này giữ nguyên, không đụng vào hành vi vẽ tay của nó.

### 2.3 Đã có đúng thao tác "bấm từng điểm" mà tính năng (2) cần

`cloudpen` (Khoanh mây tự do, phím `F`) **đã là một đa giác bấm từng đỉnh**:

- bấm phát một → mở chế độ đa giác, mỗi lần bấm thêm một đỉnh (`editor.js:1763`),
- có dây thun theo con trỏ (`onMove`, `editor.js:1899`),
- đóng bằng bấm vào đỉnh đầu / `Enter` / bấm đúp; `Esc` để huỷ (`closePoly` / `cancelPoly`),
- **hoặc** giữ chuột kéo → tự do, tự đóng khi thả.

Khác biệt duy nhất so với thứ bạn muốn: đường đi của nó là **vỏ sò (scallop)** thay vì **đoạn
thẳng**. Nói cách khác: *tương tác đã xong, chỉ thiếu hình học.*

### 2.4 Đã có đường round-trip vector

`box · ellipse · cloud · cloudpen · draw` được ghi vào PDF thành annotation thật
(`/Stamp` + `/AP` **vector** + `/NabuData`), mở lại là **sửa tiếp được**
(`managed-codec.js` `shapeAppearance()` + `editor.js` nhánh `isVectorKind`). Thêm một loại
hình vector mới **không** phải viết lại đường ghi — chỉ thêm một nhánh trong `shapeAppearance`.

---

## §3 — Tính năng (1): tô sáng theo đoạn chữ được chọn

### 3.1 Đo được gì

Chọn một đoạn 250 ký tự tiếng Việt (có dấu) trên trang bìa, và một đoạn ~14 dòng trên trang thân bài:

| | Trang 1 (bìa) | Trang 6 (thân bài) |
|---|---|---|
| span trong lớp chữ | 42 | 255 |
| ô thô từ `getClientRects()` | 71 | 154 |
| ô rỗng phải bỏ (w/h ≈ 0) | 7 | 0 |
| **ô sau khi gộp theo dòng** | **12** | **14** |
| thời gian chọn + quy đổi toạ độ | **0,3 + 0,4 ms** | **0,4 ms** |
| dung lượng nếu lưu vào `/NabuData` | — | **613 byte** |

Chữ tiếng Việt có dấu lấy ra **nguyên vẹn** (`"PHÒNG CHÁY CHỮA CHÁY - PHƯƠNG TIỆN…"`).
`document.caretRangeFromPoint()` cũng chạy — nghĩa là **kéo chọn bằng chuột** (cách người dùng
thật sẽ dùng) có API để bám vào, không phải chỉ chọn bằng mã.

**Kết luận:** rẻ như không. 0,4 ms cho một handler `mouseup` là chi phí không đáng nói.

### 3.2 Bẫy thứ nhất — ô trùng làm vệt tô **đậm gấp đôi**

Bản gộp đầu tiên (gom theo "hàng" bằng cách làm tròn toạ độ y) cho ra **18 ô cho 14 dòng**, và
danh sách bề rộng có số **lặp lại y hệt** (374,6 hai lần; 505,4 ba lần). Vì vệt tô dùng
`mix-blend-mode: multiply`, **hai ô chồng nhau = nhân hai lần = đậm gấp đôi**: ảnh
`seldraw6.png` cho thấy rõ các dòng "TCVN 7027", "TCVN 7336", "TCVN 12110" **sẫm hơn hẳn** các
dòng còn lại. Đây chính là loại lỗi chỉ lộ ra khi **vẽ pixel ra rồi nhìn**, không lộ ra khi đọc số.

**Cách sửa đã đo:** gom dòng bằng **độ chồng lấn theo chiều dọc** (hai ô cùng dòng khi tâm ô này
nằm trong ô kia **và ngược lại** — đối xứng, nên một ô cao bất thường không nuốt dòng bên cạnh),
rồi hợp nhất theo trục x khi khe hở ≤ 1,5 pt. Kết quả trên cùng đoạn chọn:

```
154 ô thô → 14 ô · 0 cặp còn chồng nhau · tất cả cao đúng 12,0 pt · 0,4 ms · 613 byte
```

Ảnh `seldraw2.png`: sắc vàng **đều tăm tắp** trên mọi dòng. (Chi tiết thuật toán nằm trong probe,
sẽ chuyển thành hàm thuần `quadsFromRects()` có lưới test riêng — xem §7.)

### 3.3 Bẫy thứ hai — lớp chữ bị **tắt** trong chế độ chú thích

`app.css:983`: `body.editing .text-layer { pointer-events: none; user-select: none; }` — cố ý,
để lớp chữ không cướp chuột của các công cụ vẽ. Vậy nên công cụ mới phải **mở lại** lớp chữ
**chỉ khi chính nó đang bật**:

```css
body.editing.tool-texthl .text-layer { pointer-events: auto; user-select: text; }
body.editing.tool-texthl .annot-layer { pointer-events: none; }
```

Không cần đụng `z-index` (hai lớp không khai z-index, chồng theo thứ tự cây); `pointer-events`
là đủ. Hệ quả phải nói trước: **khi đang ở công cụ này thì không chọn/di chuyển được vật thể** —
muốn sửa vệt đã tô thì về công cụ Chọn (`V`). Đây là quy tắc nhất quán với các công cụ vẽ khác.

### 3.4 Bẫy thứ ba — **lỗi có sẵn**: tô sáng đã áp dụng đang làm **mờ chữ**

Trên màn hình vệt tô là `multiply` (chữ giữ nguyên độ đen). Nhưng khi **áp dụng vào file**,
`editor.js drawOneAnnot` nhánh `highlight` ghi một hình chữ nhật `opacity: 0.35` **chế độ
Normal** — tức là **phủ lên trên chữ**. Dựng một PDF ba dòng chữ giống hệt nhau rồi mở bằng
chính app (`hl-zoom.png`):

| Dòng | Cách ghi | Kết quả nhìn thấy |
|---|---|---|
| A | `opacity 0.35` (đúng như bake hiện nay) | **chữ bị bạc đi thấy rõ** — so với phần chữ thò ra ngoài vệt thì xám hơn hẳn |
| B | `multiply, opacity 0.4` (đúng như màn hình) | chữ **đen nguyên**, nền vàng nhạt |
| C | `multiply, opacity 1.0` | chữ **đen nguyên**, nền vàng đậm |

Kiểm tra thêm bằng mã: bản pdf-lib đang vendored **có** `BlendMode` (12 chế độ, gồm `Multiply`)
và `drawRectangle` **nhận** tuỳ chọn `blendMode`; file ghi ra chứa `/BM /Multiply` thật.
(Bẫy của probe, không phải của sản phẩm: `doc.save()` mặc định bật object stream nên `grep`
chuỗi `/Multiply` trong file **không ra** — phải `save({useObjectStreams:false})` mới đọc được
bằng mắt. Đừng kết luận "pdf-lib không hỗ trợ" từ một lần grep.)

→ **Đề nghị:** khi làm tính năng (1) thì sửa luôn một dòng cho `highlight` cũ: thêm
`blendMode: BlendMode.Multiply`. Màn hình và file lúc đó mới **cùng một hình**, đúng tinh thần BI-40.
Đây là thay đổi **hành vi đầu ra** nên phải bạn đồng ý — xem câu hỏi ở §9.

### 3.5 Thiết kế đề xuất

**Loại mới `texthl`, KHÔNG dùng lại `highlight`.** Lý do: `highlight` là một hộp `x/y/w/h` và
được 6 chỗ khác nhau đối xử như hộp (`RESIZABLE_KINDS`, `annotBounds`, `translateAnnot`,
`renderAnnot`, `drawOneAnnot`, lưới resize). Nhét thêm một mảng `quads` tuỳ chọn vào đó là đúng
kiểu "trôi dạt giữa các chỗ gọi" mà chính codebase này ghi chú cảnh báo ở `RESIZABLE_KINDS`.
Loại riêng thì mỗi nhánh chỉ biết đúng một hình dạng.

```js
{ id, kind: "texthl",
  quads: [{x, y, w, h}, …],   // toạ độ scale-1, gốc trên-trái (giống mọi annot khác)
  color: "#ffd54a",            // dùng chung ô "Màu", đọc từ ed.highlightColor (BI-61)
  opacity: 0.4,
  text: "…" }                  // chữ đã chọn — để hiện trong bảng chú thích / tooltip
```

- **Màn hình:** một `.an.an-texthl` bọc N `<div>` con `mix-blend-mode: multiply`. Không có
  handle resize (kéo giãn một vệt tô chữ là vô nghĩa — nó bám chữ).
- **Di chuyển:** `translateAnnot` thêm nhánh `quads` (3 dòng). Có nên cho di chuyển không là
  câu hỏi ở §9 — Word thì không, Foxit thì không.
- **Ghi vào file:** annotation **thật** `/Subtype /Highlight` + `/QuadPoints` + `/AP` (form
  multiply) + `/NabuKind` + `/NabuData` → mở lại **sửa/xoá được**, và **Acrobat/Foxit hiện nó
  trong danh sách chú thích** như một highlight chuẩn.
  Đã kiểm bằng file thật mở trong app: `/Highlight` **có AP** và `/Highlight` **không AP** đều
  hiển thị (pdf.js 3.11 tự dựng hình từ `QuadPoints`), `/Stamp` có AP cũng hiển thị. Ta vẫn sẽ
  **ghi `/AP`** để chắc chắn với các viewer khác.
- **Trang xoay:** mỗi ô là một hình chữ nhật được `map()` **từng góc một** — theo BI-45 thì
  loại hình học này **đúng sẵn** ở mọi góc xoay, không cần ma trận.

### 3.6 Trường hợp biên đã nghĩ tới

| Tình huống | Xử lý |
|---|---|
| Trang scan (không có lớp chữ) | Không chọn được chữ → hiện nhắc "trang này không có chữ; dùng Tô sáng hình" |
| Trang đã OCR bằng chính app | **Chưa kiểm** — phụ thuộc bản OCR có ghi lớp chữ ẩn vào PDF không (§8) |
| Chọn vắt qua **2 trang** | `getClientRects` trả ô của cả hai lớp → **tách theo trang**, tạo 2 vệt tô ở 2 trang |
| Đang zoom 250% | Toạ độ chia cho `state.scale` → lưu ở scale-1, nên zoom không ảnh hưởng |
| Chữ vẽ thành nét + lớp chữ ẩn (BI-67) | Tô được (bám lớp ẩn), và đúng — vệt tô chỉ là chú thích |
| Chọn rỗng / chỉ khoảng trắng | Không tạo vật thể |

---

## §4 — Tính năng (2): shape tự do bằng các đoạn thẳng

### 4.1 Cái đã có và cái chưa có

| Khả năng bạn yêu cầu | Có sẵn cho hình dạng-điểm (`draw`, `cloudpen`)? |
|---|---|
| Vẽ bằng các đoạn thẳng nối các điểm bấm | **Có** — `cloudpen` (chỉ khác ở hình vẽ ra là vỏ sò) |
| Màu nét, độ dày nét | **Có** |
| Nền (tô trong), **nền trong suốt**, độ mờ nền | **Có** (`FILLABLE_KINDS`, ba ô "Nền / Không nền / Mờ nền") |
| Copy / Paste (kể cả sang tab, sang file khác) | **Có** (`clip`, BI-46/BI-77) |
| Di chuyển | **Có** (`translateAnnot` nhánh `pts`) |
| Lưu vào file rồi mở lại **sửa tiếp** | **Có** (round-trip vector, BI-64/BI-69) |
| **Resize (kéo giãn)** | **KHÔNG** — `RESIZABLE_KINDS` chỉ có `highlight · redact · image · box · ellipse · check · cross` |
| **Sửa từng đỉnh sau khi vẽ xong** | **KHÔNG** — cơ chế `data-pt` mới chỉ dùng cho **hai đầu mũi tên** |

Nói thẳng: **phần "vẽ" gần như miễn phí, phần "edit/resize" là việc mới thật sự.**

### 4.2 Thiết kế đề xuất

**Loại mới `poly`** (tên hiển thị: *Hình tự do*), dùng lại toàn bộ tương tác của `cloudpen`:

```js
{ id, kind: "poly", pts: [{x,y}…], closed: true|false,
  color, width, fill, fillOpacity }
```

Bốn mảnh việc:

1. **Hình học** — `annot-geom.js` thêm `polyPath(pts, closed)` trả `{d, minX, minY, W, H}`
   (giống `strokePath` sẵn có, thêm `Z` khi đóng). **Một** hàm cho **hai** đích: `<svg>` trên
   màn hình **và** `/AP` trong file — đúng luật BI-40/BI-69, hai đường ghi không thể vẽ khác nhau.
2. **Round-trip** — `VECTOR_KINDS` và `MANAGED_KINDS` thêm `"poly"`; `shapeAppearance()` thêm
   một nhánh (≈ 10 dòng, sao chép nhánh `draw` + đóng path + nhận `fill`);
   `serializeManaged`/`deserializeManaged` dùng lại nhánh `pts` của `cloudpen`.
   ⚠ Bẫy `pad` của BI-64: bề rộng nét nằm **ngoài** đường path, `/BBox` phải cộng `2·lw`.
3. **Resize** — `annot-geom.js` thêm `scalePts(pts, box, dir, dx, dy)`: tính hộp bao, đổi hộp
   bằng `resizeRect()` **đã có**, rồi ánh xạ tuyến tính mọi điểm sang hộp mới. Thêm `poly` vào
   `RESIZABLE_KINDS` **không đủ** — nhánh `drag.type === "resize"` hiện đọc/ghi thẳng
   `a.x/a.y/a.w/a.h`, nên phải rẽ theo "hình dạng-hộp hay hình dạng-điểm".
   **Lợi ích kèm theo:** cùng cơ chế này áp được cho `draw` và `cloudpen` → *nét vẽ tay và mây
   tự do cũng kéo giãn được*, thứ hôm nay không làm được. (Có làm hay không là câu hỏi §9.)
4. **Sửa từng đỉnh** — mỗi đỉnh một `.handle[data-pt=i]`; `drag.type === "point"` đã tồn tại
   cho mũi tên, mở rộng để ghi `a.pts[i]`. Kèm: `Alt+bấm` lên đỉnh để xoá, bấm lên cạnh để chèn
   đỉnh (tuỳ chọn, có thể để pha 2).

### 4.3 Hai câu phải quyết trước khi gõ mã

- **Đóng hay hở?** Photoshop có cả hai (polygon lasso = đóng; pen = có thể hở). `closed` đã có
  sẵn trong cấu trúc dữ liệu của `cloudpen`, nên hỗ trợ cả hai gần như không tốn thêm gì; chỉ
  cần một quy ước đóng (bấm đỉnh đầu / `Enter` = đóng, `Esc` = hở & kết thúc, chẳng hạn).
- **Bấm từng điểm hay kéo tự do?** `cloudpen` làm **cả hai** bằng một cử chỉ (kéo = tự do, bấm =
  đa giác). Bê nguyên là rẻ nhất và người dùng đã quen tay.

---

## §5 — Ảnh hưởng hệ thống (bất biến phải giữ)

| Bất biến | Liên quan thế nào |
|---|---|
| **BI-41** thanh công cụ tràn thì **mất nút "Xong"** | Đang **15 nút**. Thêm 2 nút = **+152 px** trên **mọi** dòng của bảng đo trong BI-41 → công cụ Khoanh mây cần **1 895 px** để đủ một hàng. `flex-wrap` đang gánh việc này (thanh cao 46–127 px) — **không được gỡ**. Phải đo lại bằng probe sau khi thêm. |
| **BI-40 / BI-69** một bộ số học cho **hai** đích | `polyPath()` và `quadsFromRects()` phải là hàm **thuần**, dùng chung cho màn hình và bake. |
| **BI-45** bù xoay là chuyện của **primitive** | Ô tô sáng = hình chữ nhật từ hai góc đã map → đúng sẵn. `poly` đi đường `drawSvgPath` → **bắt buộc** truyền `rotate:` như `cloud`/`cloudpen`. |
| **BI-61** `colorSlotFor` là nguồn sự thật duy nhất | `texthl` phải **thêm vào `COLOR_SLOTS`** (dùng chung `highlightColor`), không được viết `ed.highlightColor` thẳng vào chỗ tạo vật thể. |
| **BI-64** `/AP` vector — bẫy là `pad` | Nhánh `poly` trong `shapeAppearance` phải cộng `2·lw` vào `/BBox`. |
| **BI-14** gọi hàm chéo module bằng tên trần | Hàm mới đặt ở `annot-geom.js` phải xuất ở `module.exports` **và** `window.AnnotGeom`. |
| **BI-36** zoom là hai nửa | Không phát sinh lớp DOM mới ở tầng trang (vệt tô nằm trong `.annot-layer` sẵn có) → không cần `data-pscale` mới. |
| **BI-9** cổng bản quyền | Nếu chú thích là tính năng có phí thì hai công cụ mới **không** thêm nút `id` mới vào `GATED_BTNS` (chúng nằm trong thanh chú thích đã bị cổng ở tầng "vào chế độ Chú thích"). Cần xác nhận lại khi thi công. |
| **`help.js` + `i18n.js`** | Mỗi công cụ mới phải có mục trong `SECTIONS` (mục `annotate` + bảng phím tắt) **cả VI và EN**, nếu không `npm run test:help` đỏ. |

**Phím tắt còn trống:** `b e g l p q s u w y z`. Đề xuất `B` = *bôi chữ* (texthl), `P` = *polygon* (poly).

---

## §6 — Kế hoạch thi công (nếu bạn duyệt)

Chia làm **hai đợt độc lập** — đợt sau không phụ thuộc đợt trước, có thể dừng sau đợt 1.

### Đợt A — tô sáng theo chữ (≈ 1 ngày)

| Bước | Việc | Xong khi |
|---|---|---|
| A1 | `annot-geom.js`: `quadsFromRects(rects)` thuần + `npm run test:cloud` mở rộng (hoặc lưới riêng `test:quads`) | Lưới xanh: ô trùng bị nuốt, 0 cặp chồng nhau, dòng cao đều |
| A2 | `editor.js`: loại `texthl` — tạo từ `window.getSelection()` ở `mouseup`, `COLOR_SLOTS`, `renderAnnot`, `annotBounds`, `translateAnnot` | Tô được trên màn hình, đúng màu, xoá được bằng công cụ Chọn |
| A3 | `app.css` + `index.html`: nút công cụ, CSS `body.editing.tool-texthl`, icon | Bật công cụ thì chọn được chữ; tắt thì không |
| A4 | `managed-codec.js`: ghi `/Highlight` + `/QuadPoints` + `/AP` multiply + `/NabuData`; đọc lại | Áp dụng → lưu → mở lại → **vẫn sửa/xoá được**; mở bằng Foxit thấy trong danh sách chú thích |
| A5 | **Sửa lỗi cũ**: `highlight` bake thêm `blendMode: Multiply` | Ảnh so sánh: chữ dưới vệt tô **không còn bạc** |
| A6 | `help.js` (VI+EN) + `REGRESSION-GUARD.md` (bất biến mới) + ma trận §5 | `npm run test:help` xanh |

### Đợt B — shape tự do (≈ 1,5–2 ngày)

| Bước | Việc | Xong khi |
|---|---|---|
| B1 | `annot-geom.js`: `polyPath(pts, closed)` + `scalePts(...)` + lưới test | Lưới xanh, gồm ca suy biến (<2 điểm, điểm trùng) |
| B2 | `editor.js`: loại `poly` dùng lại tương tác `cloudpen`; `FILLABLE_KINDS`; `COLOR_SLOTS` mặc định | Vẽ được cả hai kiểu (bấm điểm / kéo), `Esc`/`Enter` đúng |
| B3 | `managed-codec.js`: nhánh `poly` trong `shapeAppearance` (nhớ `pad`) + serialize/deserialize | Round-trip: mở lại sửa tiếp được; `npm run test:rotate` xanh ở 0/90/180/270 |
| B4 | Resize theo hộp bao cho **hình dạng-điểm** (`poly`, và nếu duyệt: `draw`, `cloudpen`) | Kéo 4 góc giãn đều, `Esc` giữa chừng trả về nguyên trạng |
| B5 | Sửa từng đỉnh (`data-pt`), tuỳ chọn thêm/xoá đỉnh | Kéo đỉnh đổi hình, undo/redo đúng một bước |
| B6 | Đo lại bề rộng thanh công cụ (BI-41) bằng probe Electron + help + guard | Nút "Xong" bấm được ở 900/1366/1920 px |

**Checkpoint bắt buộc sau mỗi đợt:** chạy **toàn bộ** 22 lưới hiện có (`npm run test:*`), rồi mở
app thật với 3 file: một văn bản chữ (TCVN), một bản vẽ CAD (`NA2-CD-S-LK4A.pdf`), một file scan.

---

## §7 — Lưới kiểm thử đề xuất

**Lưới tự động (node, không cần GUI)** — chỉ cho phần *thuần*, đúng như `page-range.js` /
`annot-geom.js` đang làm:

1. `quadsFromRects`: ô trùng hoàn toàn → 1 ô · hai dòng sát nhau **không** dính · ô rỗng bị loại ·
   khe 1,4 pt thì gộp, 1,6 pt thì không · danh sách rỗng → `[]`.
2. `polyPath`: 3 điểm đóng → path có `Z` · 2 điểm → mở · điểm trùng nhau → `null` (và bake phải
   **đồng ý** là không vẽ gì, giống `cloudPathPoly`).
3. `scalePts`: giãn 2× theo `se` → hộp bao gấp đôi, tỷ lệ các điểm giữ nguyên · kéo âm (lật) ·
   `dir` = `nw` thì gốc dịch.
4. `serializeManaged`/`deserializeManaged` cho `poly`: đi vòng tròn ra đúng object cũ.
5. `test:rotate`: `poly` ở 0/90/180/270 + một trang `/Rotate 45` (phải rơi về làm phẳng).
6. `test:defaults`: màu mặc định của `texthl` = `highlightColor`, không phải `color`.

**Lưới tay (GUI)** — thêm vào ma trận §5 của `REGRESSION-GUARD.md`:

| # | Thao tác | Kỳ vọng |
|---|---|---|
| 1 | Tô chữ vắt 5 dòng, có dấu tiếng Việt | Vệt bám sát dòng, **sắc độ đều**, không ô nào đậm gấp đôi |
| 2 | Tô rồi zoom 50% → 400% | Vệt bám chữ ở mọi mức zoom |
| 3 | Tô trên trang scan | Nhắc "trang không có chữ", không tạo vật thể |
| 4 | Tô vắt qua ranh giới 2 trang | Hai vệt ở hai trang |
| 5 | Áp dụng → lưu → mở lại | Vệt còn đó, **chọn và xoá được**, chữ **không bạc** |
| 6 | Mở file đó bằng Foxit/Acrobat | Hiện là highlight trong danh sách chú thích |
| 7 | Vẽ `poly` 6 đỉnh, đặt nền trắng 60% | Nền đúng, nét đúng |
| 8 | Kéo góc thu nhỏ còn 1/3 | Hình giãn đều, không méo |
| 9 | Kéo một đỉnh | Chỉ đỉnh đó đổi; `Ctrl+Z` một nhát trả lại |
| 10 | Copy `poly` → dán sang tab khác | Sang được, đúng màu/nền |
| 11 | `poly` trên trang xoay 90°, áp dụng, mở lại | Không xoay lệch, không lệch `pad` |
| 12 | Thu cửa sổ còn 1024 px khi đang ở công cụ mới | Nút "Xong" vẫn bấm được |

---

## §8 — Câu chưa trả lời được (và vì sao)

1. **File đã OCR bằng chính app có lớp chữ ẩn để tô không?** Chưa kiểm — cần một file đã chạy
   OCR để trả lời dứt điểm. Nếu **có**, tính năng (1) tự động dùng được cho cả tài liệu scan
   sau khi OCR, đây là điểm bán hàng đáng kể.
2. **Có nên cho di chuyển vệt tô chữ không?** Word/Foxit **không** cho (nó bám chữ). Cho phép
   thì dễ lỡ tay kéo lệch khỏi chữ.
3. **Bảng chú thích (panel Comments) có nên liệt kê vệt tô kèm đoạn chữ đã tô không?** Rất hợp
   lý cho việc soát tài liệu, nhưng là việc riêng, chưa tính vào ước lượng trên.

---

## §9 — Bốn quyết định — **đã chốt 2026-09-20**

| # | Câu hỏi | Quyết định |
|---|---|---|
| 1 | Vệt tô chữ sau khi áp dụng có sửa/xoá lại được không? | **CÓ** — ghi annotation thật (`/Highlight` + `/QuadPoints` + `/AP` + `/NabuData`) |
| 2 | Có sửa lỗi tô sáng cũ làm bạc chữ khi áp dụng không? | **CÓ** — đổi `Normal` → `Multiply` ở đường bake (bước A5) |
| 3 | Shape tự do đóng kín hay để hở? | **CẢ HAI** — bấm đỉnh đầu / `Enter` = đóng (tô nền được); `Esc` = kết thúc để hở |
| 4 | Resize + sửa đỉnh có áp cho Vẽ tay & Khoanh mây tự do không? | **CÓ, áp cho cả ba** — cùng một bộ mã; **phải test lại cả hai công cụ cũ** |

Hệ quả của quyết định 4 với kế hoạch §6: bước **B4** và **B5** mở rộng sang `draw` và `cloudpen`,
và ma trận §5 của `REGRESSION-GUARD.md` phải thêm dòng "đụng `scalePts` → test `draw` + `cloudpen`
+ `poly`". Đây là **đổi hành vi của hai công cụ đang chạy**, nên hai ca GUI mới:

| # | Thao tác | Kỳ vọng |
|---|---|---|
| 13 | Nét vẽ tay cũ (mở lại từ file đã lưu) → kéo góc thu nhỏ | Nét giãn đều, độ dày nét **không** đổi theo tỷ lệ (nét là thuộc tính, không phải hình học) |
| 14 | Mây tự do → kéo góc | Vỏ sò giãn theo, `bump` giữ nguyên kích thước danh nghĩa |

---

## §10 — Đã thi công (2026-09-20)

Cả hai đợt A và B ở §6 đã làm, theo đúng bốn quyết định ở §9. Đánh số **v0.2.71**.

### Mã mới

| File | Việc |
|---|---|
| `annot-geom.js` | `PTS_KINDS`/`QUAD_KINDS` + hai vị từ, `quadsFromRects()`, `polyPath()`, `countDistinct()`, `scalePts()`, `TEXTHL_OPACITY`; `annotBounds`/`translateAnnot` thêm nhánh cho hai họ hình mới |
| `editor.js` | loại `texthl` + `poly`; `captureTextHighlight()`; `addPtsGrips()`; `PEN_TOOLS`/`canClosePts()` gom `cloudpen` và `poly` về **một** bộ máy đa giác; `drag.type === "vertex"`; nhánh `resize` rẽ theo họ hình; **sửa lỗi bạc chữ** (`blendMode: Multiply`) |
| `managed-codec.js` | `poly` vào `VECTOR_KINDS` + `MANAGED_KINDS`, `texthl` vào `MANAGED_KINDS`; nhánh `poly` trong `shapeAppearance()`; serialise cho cả hai |
| `app.css` · `index.html` | `.an-texthl-q`, `.handle.h-vtx`, khối `body.editing.tool-texthl`; hai icon + hai nút công cụ |
| `test/annot-shape.test.js` (mới) | 35 khẳng định, 5 nhóm — `npm run test:shape` |

### Những gì **đo được** sau khi thi công

- **23 lưới test xanh** (thêm `test:shape`), trong đó `test:rotate` từ **645 → 816** khẳng
  định: `texthl` và `poly` (đóng / hở / có nền) chạy đủ **0/90/180/270°** ở **cả hai** đường ghi.
- **Thử trên app thật, lái bằng CDP `Input.dispatchMouseEvent`** (chuột thật, không gọi hàm
  nội bộ): bôi đen → **1 vệt, 6 ô dòng** · bấm 5 điểm → **5 đỉnh**, `Enter` đóng kín · kéo góc
  160×150 → **230×200** · **Áp dụng → mở lại Chú thích: cả hai vật thể quay lại** (`.an-texthl` 1,
  `.an-poly` 1, 6 ô) — round-trip chạy thật. Console **sạch**.
- **Hồi quy hai công cụ cũ:** mây tự do vẫn vẽ được **cả hai kiểu** (kéo → 2 mây rời ở 2 chỗ;
  bấm điểm + `Enter` → đóng kín, **4 chấm đỉnh**) · nét vẽ tay kéo góc 200×80 → 290×140 với
  `stroke-width` **giữ nguyên 2** · `Ctrl+Z` trả về 200×80 trong **một** bước.
- **Bề rộng thanh công cụ (BI-41) đo lại:** 17 công cụ × 4 bề rộng = 68 tổ hợp, nút **Xong**
  bấm được ở **tất cả**; thanh cao tối đa **127px @900/1024**, **87px @1366/1920** — **không đổi**
  so với trước khi thêm 2 nút.

### Một lỗi tìm ra **trong lúc thử GUI**, không phải lúc đọc mã

Nhánh `cloudpen` của `renderAnnot` `return el` **sớm**, trước khối tay nắm chung — nên mây tự
do đóng kín **không có một tay nắm nào**, trong khi `draw` và `poly` (có lời gọi riêng) thì có.
Đọc mã không thấy; probe hỏi DOM mới ra `{selected:true, allGrips:0}`. Đã sửa bằng cách cho
mỗi họ hình-điểm **tự gọi** `addPtsGrips` và để khối chung chỉ lo nửa **hộp** — một cơ chế,
không phải hai.

### Tài liệu đã cập nhật

`REGRESSION-GUARD.md` (**BI-88**, **BI-89**, BI-41 đo lại, 3 hàng ma trận §5) · `help.js` (VI+EN,
3 mục mới + 2 hàng phím tắt) · `HUONG-DAN-SU-DUNG.md` · `site/app.js` (thẻ tính năng) ·
`site/index.html` (khối "Mới") · `site/lich-su-phien-ban.html` (mục 0.2.71).

### Còn lại (không nằm trong yêu cầu)

- Bảng chú thích (panel Comments) chưa liệt kê vệt tô kèm đoạn chữ — §8 mục 3.
- Chưa kiểm trên file **đã OCR bằng chính app** xem lớp chữ ẩn có tô được không — §8 mục 1.
- Thêm/xoá đỉnh (Alt+bấm, bấm lên cạnh) để lại pha sau, đúng như §4.2 để ngỏ.
