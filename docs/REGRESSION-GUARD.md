# Sổ bất biến & chống hồi quy — Nabu PDF

_Lập 2026-07-25. Mục đích: **sửa tính năng mới không được làm hỏng tính năng cũ đang chạy tốt** — nhất là những thứ vừa fix xong ở bản trước._

**Cách dùng:** trước khi sửa, tra mục §5 (“đụng gì → test gì”). Sau khi sửa, chạy đúng
các mục test được chỉ. Khi phát hiện một hợp đồng ngầm mới, **ghi thêm vào §3** —
tài liệu này chỉ có giá trị nếu được cập nhật.

> **Đổi tên file (2026-10-01).** Nửa "baking" của `editor.js` đã được chuyển **nguyên văn** sang
> `desktop/renderer/editor-bake.js`: `renderTextPng`, `renderArrowPng`, `renderWatermarkPng`,
> `rasterRedacted`, `deserializeManaged`, `addManagedAnnot`, `importManaged`, `drawAnnots`,
> `drawOneAnnot`, `drawWatermark`, `bakeInPlace`, `bakeWithRedaction`, `rememberSignatureWidths`,
> `bakePending`. Ở MỌI chỗ dưới đây ghi "`editor.js` + một trong các tên này" (kể cả các mục BI cũ
> và phần kể lại lịch sử), đọc là `editor-bake.js`. Hành vi không đổi; giao diện giữa hai file
> (10 tên đi vào, 2 đi ra) được ghim bởi `test/bake-split.test.js`, và
> `node desktop/scripts/prove-bake-move.js --base <rev-trước-khi-tách>` chứng minh lại việc di
> chuyển là byte-identical. `exit()`, `enter()`, `discardExit()` và `window.Editor` vẫn ở `editor.js`.

---

## 1. Bản đồ rủi ro: file nào dễ vỡ nhất

| File | Dòng | Vì sao rủi ro cao |
|---|---|---|
| `desktop/renderer/app.js` | ~4440 | State trung tâm + 12 hàm nút thắt. **Gần như mọi bản phát hành đều đụng.** |
| `desktop/renderer/editor.js` | ~3180 | Overlay annotation, bake, form. Diff lớn nhất mỗi lần release. |
| `desktop/renderer/annot-text.js` | ~230 | Bố cục chữ (`layoutTextBox`). Rủi ro **thấp** nhờ lưới `npm run test:text`, nhưng sai ở đây **im lặng**: hộp trên màn hình và PNG đem bake lệch nhau → chữ tràn/xuống dòng khác trong file đã lưu → xem BI-40. |
| `desktop/renderer/managed-codec.js` | ~340 | Lớp object PDF riêng của chú thích sửa-lại-được. **Hậu quả cao nhất trong repo**: sai là **mất ảnh của người dùng** hoặc phình file âm thầm. Từ v0.2.58 chứa thêm số học đặt `/AP` trên trang xoay (`apMatrixFor`/`apRectFor`), từ v0.2.61 thêm `shapeAppearance` — appearance **vector** của chữ nhật/elip — cả hai đều thuần, nằm trong `test:managed` + `test:rotate`. Xem BI-37, BI-38, BI-14, BI-59, BI-64. |
| `desktop/renderer/annot-geom.js` | ~420 | Đường mây revision + nhãn mũi tên + `resizeRect` + (v0.2.50) `strokeExtend` (luật Shift của vẽ tay) + `symbolStrokes` (hình ✓/✗) + (v0.2.52) `snapLineEnd` (kéo một đầu mũi tên) và `annotBounds`/`translateAnnot`/`unionBounds`/`fitShift` (số học của copy–paste vật thể). Rủi ro **thấp** nhờ `npm run test:cloud` + `test:geom`; sai ở đây làm mây/dấu lệch chỗ **trong PDF đã lưu** (trên màn hình vẫn đúng), hoặc dán một mục ra **ngoài mép giấy** nơi không tay nắm nào tóm lại được → xem BI-40, BI-42, BI-46. |
| `desktop/renderer/editor-bake.js` — khối bake (`drawOneAnnot`) | ~200 dòng | Bù xoay trang. Rủi ro **cao và im lặng**: overlay trên màn hình luôn đúng, chỉ **file đã lưu** sai, và **chỉ trên trang có `/Rotate`** — tức đúng loại tài liệu (scan nằm ngang, bản vẽ A3) mà người viết code không mở hằng ngày. Nay có lưới `npm run test:rotate` đi qua **mọi** kind → xem BI-45. |
| `desktop/renderer/editor-bake.js` — ba nhánh `/AP` của `addManagedAnnot` | ~120 dòng | Cùng loại rủi ro im lặng như hàng trên, ở **đường annotation** thay vì đường dán cứng: viewer tự co giãn appearance cho khít `/Rect` (PDF §12.5.5) nên `/Rect` sai không làm con dấu lệch mà làm nó **méo**, và chỉ thấy trên trang xoay. `test:rotate` §5 đo lại đúng cùng một câu hỏi ("rơi vào đâu trên màn hình") bằng cách so với đường dán cứng đang ship, kèm **ca canh gác** → xem BI-59. |
| `desktop/renderer/editor.js` — hộp gõ chữ nội tuyến (`openTextEditor`, `renderLayer`, `PALETTE_KEEP_SEL`) | ~90 dòng | Rủi ro **trung bình**, hậu quả **mất chữ người dùng đang gõ**, và mất **im lặng**: hộp gõ là con của annot layer, `renderLayer` xoá layer bằng `innerHTML = ""`, còn Chromium **không phát `blur`** khi xoá phần tử đang focus ⇒ `commit` không chạy, không annot, không bước undo, không lỗi. Chỉ có **assertion trên source** trong `npm run test:defaults` → xem BI-75. |
| `desktop/src/main.js` + `src/tabs.js` | — | Tầng cửa sổ/tab — **hệ con mới nhất, ít va đập thực tế nhất** (ra mắt v0.2.41). Có lưới tự động `npm run test:tabs` cho phần logic thuần. |
| `desktop/renderer/page-move.js` | ~330 | Chuyển trang giữa hai tài liệu đang mở. Rủi ro **trung bình** nhưng hậu quả **cao nhất về dữ liệu**: nhánh MOVE **xoá trang ở tài liệu nguồn**. Nửa số học có lưới `npm run test:pagedrop`; nửa cử chỉ **máy không test được** (Chromium bỏ qua input tổng hợp trong đường kéo–thả, `TABS-2B-DESIGN.md` §2.2) nên chỉ có test tay + assertion trên source trong cùng lưới đó → xem BI-55, BI-56, BI-57, BI-58. |
| `desktop/renderer/page-vault.js` | ~330 | Trang ẩn có khoá (v0.2.64). Rủi ro **trung bình** (thuần, DOM-free, có lưới `npm run test:vault` từ commit đầu tiên) nhưng **hậu quả cao nhất có thể có**: sai ở đây là **mất hẳn một trang hợp đồng**, không lỗi, không cảnh báo. Bốn cạm bẫy đều đã đo và đều nằm trong lưới → xem BI-72, BI-73, BI-74. |
| `desktop/renderer/page-range.js` | ~170 | Số học khoảng trang. Rủi ro **thấp** vì có lưới `npm run test:pages`, nhưng hậu quả sai là **mất trang tài liệu** → xem BI-27. |
| `desktop/renderer/pan.js` | ~380 | Bàn tay/pan. Rủi ro **trung bình**: nó giành sự kiện chuột **trên cùng phần tử** với `editor.js`/`capture.js`. Nửa logic có lưới `npm run test:pan`; nửa DOM thì không → xem BI-30/31. |
| `desktop/renderer/find-replace.js` | ~700 | Tìm & Thay thế. Rủi ro **trung bình** nhưng hậu quả **cao và im lặng**: nó **ghi vào chữ gốc** của tài liệu hàng loạt. Nửa số học có lưới `npm run test:find`; nửa DOM chỉ có **assertion trên source** trong cùng lưới đó → xem BI-50, BI-51. |
| `desktop/renderer/wire.js` | ~130 | Bộ mã hoá payload nhị phân. Rủi ro **thấp** nhờ lưới `npm run test:wire`, nhưng sai ở đây **im lặng**: request vẫn đúng cú pháp, chỉ là base64 hỏng → xem BI-24. |
| `desktop/renderer/app.js` — khối zoom | ~170 dòng | `applyScaleToDom`/`commitScale` đụng CSS box của **mọi** trang + 4 lớp overlay. Sai là zoom mờ mãi hoặc chú thích lệch. Từ v0.2.66 còn giữ **hạn mức raster** (`viewRasterDpr`) — nới nó ra là **trang trắng im lặng** trên giấy khổ lớn. Nửa số học có lưới `npm run test:geom` → xem BI-36, **BI-78**. |
| ~~`editor.js` — ảnh round-trip~~ → `managed-codec.js` (v0.2.49) | ~180 dòng | Ghi/đọc/giải phóng object PDF riêng. Sai ở đây **mất ảnh của người dùng** hoặc phình file âm thầm. Có lưới `npm run test:managed` → xem BI-37, BI-38. |
| `desktop/renderer/app.css` — khối `@media print` + `app.js` `buildPrintPages` | ~50 dòng | Bố cục **tờ giấy**. Rủi ro **cao và im lặng**: sai ở đây không có lỗi, không có cảnh báo — chỉ là máy in nhả gấp đôi số tờ, hoặc mất phần dưới trang, và **chỉ trên khổ giấy mà người viết code không dùng** (A3/Letter). Nửa số học có lưới `npm run test:print`; nửa CSS chỉ probe `printToPDF` **đếm tờ** mới thấy → xem BI-43, BI-44. |
| `desktop/src/prefs.js` | ~80 | Tuỳ chọn phía main. Rủi ro thấp; nằm trong lưới `npm run test:tabs`. |
| `desktop/src/shell-combine.js` | ~200 | Verb “Gộp bằng Nabu PDF” của Explorer. Rủi ro **thấp** nhờ lưới `npm run test:combine` (thuần: parse argv, dedupe/sắp thứ tự, chính sách gom). Cái **không** có lưới là hai đầu OS: khoá registry do `build/installer.nsh` ghi, và đường `second-instance` thật — cả hai cần bản **đã cài**. Sai ở đây không mất dữ liệu; nó mất **im lặng** (mục menu chạy app không có cờ ⇒ thành “Open with”) → xem BI-62. |
| `desktop/build/installer.nsh` | ~20 | Khoá registry của verb. Không chạy lúc dev, **chỉ** chạy lúc cài ⇒ sai thì không ai biết cho tới khi có người cài thật. Ba thứ dễ sai: thiếu `MultiSelectModel=Player` (chọn >15 file là mục menu mất), thiếu **BOM UTF-8** (nhãn tiếng Việt thành mojibake), thiếu `customUnInstall` (gỡ app xong còn mục menu chết). Có ca đối chiếu với JS trong `test:combine` → xem BI-62. |
| `api.py` + `src/pdf/*.py` | — | Có lưới test tự động (`run_tests.py`) → rủi ro thấp hơn renderer. |

> *(Cập nhật 2026-10-01 — đo lại: `npm test` nay chạy mọi `desktop/test/*.test.js` (31 bộ tại 2026-10-01); nhưng chỉ ~24% số dòng
> renderer nằm trong file `require()` được từ node, ~76% còn lại chỉ có test cắt hàm /
> ghim mã nguồn và probe. Ba bộ canh **cấu trúc** mới, không đổi hành vi:
> `test:scope` (trùng tên toàn cục + thứ tự nạp `<script>`, BI-14), `test:ipc` (preload ⇄
> `ipcMain`, bề mặt pane chỉ-đọc BI-55), `test:bytes` (mọi chỗ ghi `state.bytes` phải
> `pushUndo()` trước, BI-3). Xem `docs/REVIEW-2026-10-01-perf-harness.md` §6.)*
>
> Renderer gần như **không có** test chạy trực tiếp lên `app.js`/`editor.js`. Ngoại lệ là
> các file được **cố ý tách ra cho DOM-free** — đợt đầu là **năm** file: `page-range.js`,
> `pan.js` (nửa trên), `wire.js`, và từ v0.2.48 `annot-text.js` + `annot-geom.js` (sau đó
> thêm `managed-codec`, `page-vault`, `raster-cap`, `thumb-queue`, `sig-image`). Tiêu chí chọn tách không phải “file to” mà là
> **“sai ở đây có im lặng không”** — mất trang, giành nhầm chuột, payload hỏng, chữ/mây
> lệch chỗ trong file đã lưu. Phần renderer còn lại (`app.js`, `editor.js`,
> `text-edit.js`) đụng DOM/canvas/pdf.js ở mọi dòng nên chỉ có tài liệu này + test tay
> + probe trình duyệt. Đó là lý do sổ bất biến tồn tại.

> **v0.2.48 — đã đo trước khi tách, và đây là con số:** `editor.js` (3641 dòng, 115 hàm,
> trung bình 24,5 dòng/hàm) có **33 hàm / 429 dòng thuần** (không DOM, không `ed`/`state`),
> **24 hàm / 315 dòng** chỉ đụng `ed`/`state`, và **58 hàm / 2075 dòng (57%) bám
> DOM/canvas**. Vì thế **module hoá toàn bộ file đã bị bác bỏ có chủ ý**: 57% kia tách ra
> chỉ *di chuyển* code chứ không làm nó test được, mà lại đụng file có diff lớn nhất repo.
> Bốn rào cản đo được, ghi lại để không phải điều tra lại:
> 1. **ESM bị chặn ở tầng nạp** — `tabs.js` dùng `loadFile` ⇒ origin `file://`; Chromium
>    fetch module script theo CORS nên `import` chết. Muốn ESM phải chuyển sang custom
>    protocol cho **cả 3 HTML**, viết lại CSP tay ở `main.js`, dưới `sandbox: true`.
>    Rủi ro dồn đúng chỗ mong manh nhất (đa tab/đa cửa sổ, BI-35) để đổi lấy tổ chức file.
> 2. **Bundler sẽ phá lưới hiện có** — `test:geom`/`test:managed` cắt source hàm ra khỏi
>    file *đang ship*; minify/bundle là mất tính chất “cái được test chính là cái chạy”.
> 3. **`ed` là điểm dính** — 345 chỗ đọc/ghi một object 43 thuộc tính. Tách file thì hoặc
>    phơi `ed` thành global (nhân BI-14 lên) hoặc viết lại để truyền state tường minh
>    (rewrite ngữ nghĩa trên file nguy hiểm nhất).
> 4. **Không có áp lực cộng tác** — 20 commit cả đời file, một người viết, gần như chỉ
>    thêm. Lập luận “file to đau vì nhiều người sửa” không áp dụng ở đây.
>
> ⚠️ **Thứ tự thao tác, luật rút ra ở v0.2.48:** chỉ tách code **đã ship và đã test tay**.
> Cả `annot-text.js` lẫn phần mây/mũi tên của `annot-geom.js` đã được chứng minh
> **byte-identical với editor.js của v0.2.47** trước khi move (script so từng dòng), nên
> bản chất là đổi chỗ ở. Ngược lại khối **managed-codec** (`managedSrcBytes`,
> `managedSrcDataUrl`, `collectManagedChain`, `freeManagedTrash`) **cố ý CHƯA tách**: lúc
> đó nó là code mới của chính v0.2.48, **chưa từng ship, chưa test tay GUI**. Tách nó
> cùng lúc sẽ làm đợt test tay không phân biệt được lỗi là của tính năng mới hay của phép
> move — trên đúng đường code mà sai là **mất ảnh của người dùng** (BI-37/38). Sau khi
> v0.2.48 ship và test tay xanh thì điều kiện đã thoả ⇒ tách được ở phiên sau.
>
> **Luật chung:** code vừa viết xong thì **kiểm chứng nó trước, refactor sau** — đừng gộp
> "tính năng mới" và "đổi chỗ ở" vào cùng một đợt test tay, vì lúc đó không có cách nào
> quy lỗi. Ngược lại, code đã ship thì refactor **rẻ**, vì đã có bản gốc để so byte.

> **Cách thứ hai để có lưới mà KHÔNG tách file** (v0.2.48, mở rộng cách đã dùng để kiểm
> chứng bản hợp nhất `page-range` ở v0.2.47): test **cắt thẳng hàm ra khỏi file đang
> ship lúc chạy** (khớp ngoặc từ `function <tên>(`) rồi `eval`, và cấp cho nó đúng
> những tên nó khép kín (`ed` giả, class của pdf-lib, `pushB64Chunks` thật). Cái được
> test **chính là** cái chạy trong app — không có bản copy nào để lệch — và `app.js` /
> `editor.js` **không phải** tách ra làm gì. Đổi tên hàm ⇒ test **đổ ngay** (đúng ý muốn).
> - `npm run test:geom` → `test/viewer-geom.test.js`: `resizeRect` (editor.js),
>   `nearestScrollDelta` + `wheelZoomFactor` (app.js) — 39 ca.
> - `npm run test:managed` → `test/managed-image.test.js`: cả vòng ghi→đọc→bake lại của
>   ảnh round-trip, chạy trên chính pdf-lib trong `node_modules` (đã đối chiếu sha256 với
>   `renderer/vendor/pdf-lib.min.js`) — 42 ca.
>
> **Nửa DOM thì vẫn phải probe trình duyệt.** v0.2.48 dựng probe bằng cách cho node cắt
> `applyScaleToDom` / `syncThumbFocus` / `currentPageIndex` ra, nhúng cùng `app.css` thật
> vào một trang HTML, rồi chạy bằng **chính Electron của dự án**
> (`./node_modules/.bin/electron`, `BrowserWindow({show:false})` → đọc `#out`): 30/30 —
> box canvas theo tỷ lệ, `--scale-factor` của pdf.js kéo span đi đúng, `.page-wrap`
> **được dùng lại** chứ không dựng lại, cột trang trượt đúng, và 4 tay nắm có đúng CSS.
> Probe là **file dùng một lần, không commit** (như các probe trước). Đừng dùng preview
> pane của IDE: nó render snapshot, **script không chạy**.

---

## 2. Kiến trúc phải nhớ trước khi sửa

- 14 file JS của renderer (`i18n, page-range, wire, annot-text, annot-geom, managed-codec,
  page-vault, app, pan, editor, text-edit, compare, capture, sign`) nạp bằng `<script>` **classic**, dùng
  chung **một scope**. `state`,
  `toast`, `sidecarFetch`, `showOverlay`… là biến toàn cục dùng chéo, **không phải
  module** → đổi tên một hàm trong `app.js` có thể làm `editor.js` chết mà không hề có
  cảnh báo lúc build. Năm file đã tách ra để test được, theo **ba mức** khác nhau — đọc
  kỹ trước khi tách file thứ bảy:
  - `page-range.js` — **sạch nhất**: chỉ phơi `window.PageRange`, không thả tên trần
    nào vào scope chung, nên `require()` được từ node. Dùng cho code **mới**.
  - `pan.js` — **nửa vời có chủ ý**: nửa trên logic thuần `require()` được, nửa dưới
    đụng DOM nằm sau cửa `typeof document === "undefined"` → node nạp nửa trên,
    trình duyệt chạy cả hai.
  - `wire.js` — **cố tình giữ tên trần**: `pdfJsonBody` / `b64ToU8` có sẵn **16 chỗ
    gọi** trong `app.js`/`text-edit.js`/`compare.js` từ trước khi tách. Khai ở top-level
    một classic script thì chúng vẫn nằm đúng scope chung như cũ ⇒ **không phải sửa
    chỗ gọi nào**. Đổi sang `window.Wire.*` là tự chuốc lấy đúng rủi ro BI-14. Đánh đổi:
    `wire.js` **phải nạp trước** `app.js`/`text-edit.js`/`compare.js` trong `index.html`.
    Đã kiểm chứng bằng probe rằng tên trần nhìn thấy được từ script khác.
  - `annot-text.js` + `annot-geom.js` (v0.2.48) — **cùng mức `wire.js`, cùng lý do**:
    ~25 và ~11 chỗ gọi có sẵn trong `editor.js`. Giữ tên trần ⇒ phía `editor.js` của
    lần tách này là **thuần xoá**, không một call site nào đổi, nên hành vi không thể
    lệch. `module.exports` cho node, `window.AnnotText` / `window.AnnotGeom` là **cùng
    bộ đó** dưới cái tên probe/test khẳng định được. Đánh đổi: **phải nạp trước
    `editor.js`**. Cả hai đều DOM-free trừ `measureCtx` — nó nằm sau cửa
    `typeof document === "undefined"` kiểu `pan.js`, và `measureText` nhận thêm tham số
    `ctx` **tuỳ chọn** để lưới node bơm ctx giả (chỗ gọi cũ truyền 3 tham số, không đổi).
  - `managed-codec.js` (v0.2.49) — **mức thứ tư: IIFE + `Object.assign(window, …)`**. Cần
    thiết vì nó destructure `PDFName`/`PDFRawStream`/`PDFDict`/`degrees` từ pdf-lib, và
    khai ở top level thì `degrees` **đụng `app.js:17`** ⇒ SyntaxError giết `app.js` ⇒ app
    trắng. Bọc IIFE cho binding thành private, publish bề mặt bằng `Object.assign` — bare
    name vẫn phân giải khi *đọc*, mà không thể trùng khai báo. **Đây là khuôn phải dùng cho
    mọi file mới có destructure từ thư viện.** Xem BI-14 (nửa sau).
  - `page-vault.js` (v0.2.64) — **IIFE bắt buộc** (destructure pdf-lib, đúng bẫy BI-14) nhưng
    phơi ra ở **mức `page-range.js`**: chỉ `window.PageVault`, **không** `Object.assign(window, …)`,
    không một tên trần nào. Làm được vì đây là code **mới**, không có call site cũ để giữ —
    và đó chính là tiêu chí: giữ tên trần chỉ đáng khi nó **xoá được** hàng chục chỗ sửa tay
    trong file diff lớn nhất repo. Đây là **khuôn cho mọi file mới** kể từ nay.
- **Mỗi tab = một renderer riêng** (`WebContentsView`, process riêng). `state` **không**
  chia sẻ giữa các tab. Cái chia sẻ là: main process, sidecar Python, thư mục recovery.
  → Mọi singleton ở main process là nguy cơ xung đột đa tab.

---

## 3. Sổ bất biến (đừng phá)

Mỗi mục: **bất biến → ở đâu → vì sao → dấu hiệu vỡ.**

### BI-1 · Undo khi đang mở overlay phải là undo *annotation*, không phải undo tài liệu
- `app.js:3446-3455` (nhánh `window.Editor.active`).
- Undo bytes tài liệu khi overlay đang sống sẽ lệch toàn bộ annotation đang chờ.
- **Vỡ khi:** Ctrl+Z lúc đang chú thích làm nhảy trang / mất hình vẽ.

### BI-2 · Overlay edit và Text edit loại trừ nhau
- `app.js:3131-3135` (`be.disabled = !has || textEditing`, `bt.disabled = … || overlayEditing`).
- Hai chế độ cùng ghi `state.bytes` → xung đột bake.
- **Vỡ khi:** bật được cả hai nút cùng lúc.

### BI-3 · Mọi thay đổi `state.bytes` phải đi qua `pushUndo()` TRƯỚC
- `app.js:148-158`. Gói chung: snapshot + xoá redo + `updateUndoRedo` + `markDirty`.
- Bỏ qua → mất undo **và** mất cờ dirty (→ đóng file không hỏi, mất dữ liệu).
- **Vỡ khi:** sửa xong mà tiêu đề không có chấm ●, hoặc Ctrl+Z không quay lại được.
- **Code MỚI dùng `commitBytes(bytes, {select, lastClicked, render})`** (`app.js`, sau `pushUndo`; từ file khác: `window.DocHistory.commitBytes`). Nó nhận bytes **đã xong**, nên không có gì ném lỗi được giữa bước undo và bước ghi (kiểu cũ `pushUndo(); try { load; sửa; save }` để lại một bước undo "ma" khi lỗi). **Không** dùng cho ghi không-hoàn-tác-được (ẩn trang, BI-74) hay thay cả timeline (`loadBytes`, `restoreSnapshot`) — các chỗ đó là mục `exempt` của `test:bytes`. 13 chỗ ghi tay cũ là *legacy*: chuyển dần từng chỗ (mỗi chỗ một commit + probe) khi có việc khác đụng tới, không chuyển hàng loạt. `test:bytes` bắt chỗ ghi mới và chỉ về `commitBytes`.

### BI-4 · Không tính năng nào được đọc **pixel** canvas của viewer
- Virtualization (`freePageCanvas` `app.js:739-745`) xoá bitmap trang trôi xa, chỉ giữ
  `canvas.style.*`. Print/compare/export/bake đều tạo canvas riêng từ `state.bytes.slice()`.
- **Vỡ khi:** thêm tính năng đọc pixel trang → ra ảnh trắng ngẫu nhiên tuỳ vị trí cuộn.
- **Cách làm đúng:** ép render trước bằng `renderPageCanvas(i)`, hoặc mở doc riêng.

### BI-5 · `rerenderChanged()` giả định bake **không đổi số trang**
- `app.js:1134-1149`; có kiểm tra số trang rồi mới fallback `renderAll()`.
- Đường nào bỏ qua kiểm tra đó sẽ lệch ánh xạ DOM ↔ trang.

### BI-6 · Guard đóng cửa sổ phải SKIP khi `appQuitting`
- `tabs.js:_onClose` + `main.js` (`appQuitting` đặt ở `before-quit`).
- Nút X **không** bắn `before-quit` (được hỏi); menu Thoát/Ctrl+Q **có** bắn (đã
  `stopSidecar`) → nếu guard chặn rồi user bấm Huỷ thì sidecar đã chết + có thể treo quit.
- **Đừng bỏ điều kiện `appQuitting`.** Mạng lưới an toàn cho đường này là autosave.

### BI-7 · `recovery:scan` chỉ trả kết quả cho **người hỏi đầu tiên mỗi lần chạy app**
- `main.js` (`recoveryScanDone`), ghi chú ở `preload.js:59-60`.
- Chống hỏi khôi phục nhiều lần khi mở nhiều cửa sổ/tab.
- **Hệ quả cần nhớ:** tab thứ 2 gọi sẽ nhận mảng rỗng — đó là **đúng thiết kế**, không phải lỗi.

### BI-8 · Mở tài liệu mới **không bao giờ** được đè lên tab đang có dữ liệu
- `app.js` `openDialog()` + nhánh drop; `main.js` `tabs:open-paths`; **quyết định thật
  nằm ở `tabs.js` `planOpen()`** — nó chỉ trả `fill` khác `null` khi người gọi khai
  `fillCurrent`, và lưới `npm run test:tabs` có ca canh gác cho đúng điều đó.
- Đây chính là lỗi đã phải hotfix ngay sau khi ra tab (`624fd7f` vá `7bd02d3`).
- **Vỡ khi:** bấm Mở → tài liệu đang xem biến mất.

### BI-9 · Nút tính năng trả phí phải có trong `GATED_BTNS`
- `app.js:2924-2936`, dùng bởi `installLicenseGuard()` + `updateToolbar()`.
- Danh sách **id nút** cứng; nút mới khai báo ở `editor.js`/`text-edit.js`/`index.html`
  mà quên thêm vào đây thì **thoát cổng bản quyền trong im lặng**.

### BI-10 · Phần tử có nội dung động phải nằm trong `SKIP_IDS` của i18n
- `i18n.js:463-469`.
- Không thì đổi ngôn ngữ sẽ ghi đè giá trị đang chạy bằng text tĩnh cũ.

### BI-11 · Ký số là thao tác **cuối cùng**
- `sign.js:13-14, 341`. Sửa rồi lưu đè file đã ký = mất hiệu lực chữ ký.

### BI-12 · Cache CTM của capture khoá theo *danh tính đối tượng* `state.pdf`
- `capture.js:26, 66-70` (`docToken`).
- Nếu sau này có đường thay tài liệu mà **giữ nguyên** đối tượng `state.pdf`, cache
  sẽ cũ trong im lặng → copy vùng ra sai toạ độ.

### BI-13 · `state.pageMetas` là trường **ẩn**, không khai trong `state = {}`
- Tạo động ở `app.js:648`; `capture.js` và `sign.js` phụ thuộc vào nó.
- Đọc khai báo `state` ở đầu file sẽ **không** thấy trường này tồn tại.

### BI-15 · `detachTab` **không bao giờ** được đóng `webContents`
- `tabs.js` — `detachTab` (chuyển nhà) vs `destroyTab` (khai tử). Hai đường tách bạch.
- Tab tách ra vẫn là **đúng renderer đó**, giữ nguyên tài liệu + lịch sử hoàn tác +
  phiên chú thích đang dở. Đóng `webContents` ở đường tách = người dùng mất việc đang làm
  chỉ vì kéo một cái tab.
- **Vỡ khi:** kéo tab ra → cửa sổ mới trắng trơn, hoặc tài liệu nạp lại từ đầu.

### BI-16 · Sau `detachTab`, tab **bắt buộc** phải có người nhận
- `moveTabTo` / `tearOutTab` luôn `adoptTab` ngay sau khi gỡ.
- Tab không ai nhận = một tiến trình renderer mồ côi, giữ nguyên RAM của cả tài liệu,
  không cửa sổ nào đóng được nó.

### BI-17 · Phím tắt của tab phải tra chủ sở hữu **động**
- `tabs.js` `ownerOf()` + `bindTabKeys()`.
- Listener `before-input-event` gắn vào `webContents`, mà `webContents` **đổi cửa sổ** khi
  tách tab. Đóng gói `this` vào listener → sau khi tách, Ctrl+Tab / Ctrl+1–9 điều khiển
  cửa sổ **cũ** (có thể đã bị huỷ).
- **Cũng đừng gắn lại listener lúc `adoptTab`** — sẽ thành hai listener, mỗi phím nhảy hai tab.

### BI-18 · Phiên nhớ **đường dẫn**, khôi phục sự cố nhớ **nội dung** — không trộn
- `src/session.js` (đầu file) + `docs/SESSION-RESTORE.md` §2.
- Tab chưa có file trên đĩa **không** nằm trong phiên; nội dung sửa dở là việc của
  `recovery:*`. Nhờ ranh giới này, một lỗi trong `session.js` **không thể** làm mất tài liệu.
- **Vỡ khi:** ai đó nhét bytes vào `session.json` cho tiện.

### BI-19 · Tab đã được main “đặt chỗ” không được nhận lời nhắc khôi phục sự cố
- `tabs.js` `createTab` gửi `tab:reserved` → `renderer/app.js` `checkRecovery` rút lui.
- `recovery:scan` chỉ trả kết quả cho người hỏi **đầu tiên** (BI-7). Một tab sắp nhận
  tài liệu mà giành mất danh sách rồi bỏ đi = **nuốt luôn lời nhắc của cả lần chạy đó**.
- Đi kèm: khi khởi động **có** bản nháp sự cố, main phải mở một tab trống để lời nhắc có chỗ hiện.

### BI-20 · Không ghi phiên khi một cửa sổ đang đóng dở
- Cờ `_closing` + `Session.anyClosing()`; bảng đầy đủ ở `docs/SESSION-RESTORE.md` §3.2.
- Lúc teardown danh sách tab rỗng dần → ghi vào đúng lúc đó là lưu lại một cái app
  đang chết dở làm thứ để khôi phục.
- **Vỡ khi:** đóng cửa sổ đang có 5 tab, mở lại chỉ còn 1 tab (hoặc không tab nào).

### BI-21 · “Giữ nguyên font” là một THANG BA BẬC — bậc nào cũng phải qua cửa kiểm tra glyph
- `api.py` `/edit-text` (khối chọn font) + `src/pdf/fonts.py`.
- Thứ tự **bắt buộc**: (1) font hệ thống theo họ (`_resolve_local_font`, thử lần lượt
  `_family_candidates`) → (2) chính font **nhúng trong PDF nguồn**
  (`_page_font_buffers` + `embed_page_font`) → **(2b) font hệ thống theo TÊN NẰM TRONG
  chương trình font nhúng** (`_embedded_font_name`, thêm 2026-11-20) → (3) DejaVu bó sẵn.
- Bậc 1 hỏng ở tên kiểu **“TimesNewRomanBold”** (kiểu chữ dính liền, không dấu gạch)
  → rơi thẳng xuống DejaVu, người dùng thấy **đổi font trong im lặng** dù đã chọn
  “Giữ nguyên”. Đó là lỗi đã sửa 2026-07-26.
- Bậc 2 dùng **font con (subset)** — chỉ chứa glyph tài liệu từng vẽ. Cửa kiểm tra
  `_font_covers` ở bậc này phải chạy **KHÔNG điều kiện**, không được gắn vào
  `needs_unicode`: chữ ASCII thuần cũng có thể thiếu glyph → ra ô vuông (□) đúng
  kiểu hồi quy v0.2.34.
- `_page_font_buffers` phải gọi **TRƯỚC `apply_redactions()`**.
- **Bậc 2b (căn cứ: file khách `0. TH.pdf`, 2026-11-20).** `/BaseFont` do công cụ tạo file
  ghi tuỳ ý (`CIDFont+F1`, `F2`…) nên bậc 1 — chỉ nhìn **tên span** — không bao giờ tới font
  cài trên máy; bậc 2 lại từ chối vì subset thiếu glyph (`Ề`, `Ố`) → cả dòng rơi DejaVu.
  Nhưng *bảng tên trong chính chương trình font* vẫn nói "Times New Roman Bold". Bậc 2b
  tra tên đó (`_resolve_local_font`) rồi **vẫn qua `_font_covers` trên file đã resolve, TRƯỚC
  khi nhúng** (trượt thì không để lại font thừa trên trang).
  - **Phải đứng SAU bậc 2.** Nó chỉ chạm các ca trước đây rơi thẳng xuống DejaVu ⇒ mọi ca bậc
    1/2 đang chạy giữ **byte y hệt**. Đưa lên trước bậc 2 = đổi nguồn glyph của mọi tài
    liệu đang ổn (đột biến M2 bắt được).
  - Tên tra được chỉ là **khoá tra cứu**, không quyết định cái gì được vẽ; `_font_covers` vẫn quyết định.
  - Đo trên `0. TH.pdf`, Tìm&Thay 22 chỗ: trước 11 DejaVu + 11 Times; sau **22/22 Times New Roman
    Bold**, cỡ y hệt gốc (12.0/9.72…, DejaVu từng ép xuống 10.35/9.0); mực in vùng "Tên dự án: "
    cố định lệch **0.0 %** so với bản gốc (trước sửa: +25 %).
  - Giới hạn đã biết: máy **không cài** họ font đó (Mac/Linux, font CAD riêng) vẫn rơi DejaVu.
  - **"Chữ hoa" không phải nguyên nhân** — là glyph có nằm trong subset của TRANG đó không
    (trang 0 thiếu `Ề Ố`; trang 5 lại thiếu chữ thường `ề ố ộ ự…`).
- **Vỡ khi:** sửa chữ xong đổi sang font khác hẳn (kể cả trên PDF có tên font chung kiểu
  `CIDFont+Fn` dù họ font thật đã cài) · hoặc ra □.
- Lưới: `.venv\Scripts\python test_edit_text_font.py` (13 ca; 5 ca của bậc 2b, đột biến 4/4:
  bỏ bậc 2b · đưa lên trước bậc 2 · bỏ kiểm glyph · quên bold) + `test_edit_text_rounds.py`.
  Ca cũ `test_subset_font_that_cannot_cover…` giữ **nguyên khẳng định**, chỉ đổi fixture
  (`rename=True`: tên thật trong chương trình font cũng là họ không ai cài) — trước đó fixture
  còn nói "DejaVu Serif" nên ngầm khẳng định chính cái khoảng hở này.

### BI-22 · Toàn màn hình: MAIN là nguồn sự thật, renderer chỉ phản ứng
- `src/tabs.js` (`setPresentation` / `_applyPresentation` / `_layout`) + `main.js`
  (`window:set-presentation`) + `renderer/app.js` (`togglePresentation` /
  `applyPresentation`).
- Renderer **không bao giờ** tự bật cờ `.presenting`; nó xin main, main đổi cửa sổ
  rồi phát `window:presentation` ngược lại cho **mọi tab** của cửa sổ đó. Vì cửa sổ
  có thể rời toàn màn hình bằng đường khác (nút cửa sổ, cử chỉ OS) — sự kiện
  `leave-full-screen` là cái kéo UI về đúng chỗ.
- **Vỡ khi:** thoát toàn màn hình bằng nút cửa sổ → app mất luôn thanh công cụ,
  không có đường quay lại; hoặc chuyển tab trong lúc trình chiếu thì tab kia vẫn
  còn nguyên thanh công cụ.
- Chế độ này **loại trừ** Chú thích/Sửa nội dung (hai chế độ đó cần thanh công cụ
  mà nó ẩn) — xem `updateToolbar()`.

### BI-23 · Redaction của `/edit-text` chỉ được lấy đi **chữ**, không lấy gì khác
- `api.py` `/edit-text` bước 1: `add_redact_annot(..., fill=False)` +
  `apply_redactions(images=PDF_REDACT_IMAGE_NONE, graphics=PDF_REDACT_LINE_ART_NONE)`.
- Hộp redaction là **bbox của chữ**, nên mọi thứ nó chồng lên (nền ô bảng, đường kẻ
  dưới tiêu đề, ảnh scan letterhead) là do **tài liệu** vẽ, không phải do chữ:
  - còn `fill` mặc định (1,1,1) → tô một hình chữ nhật đục lên trang: **vô hình trên
    giấy trắng, thành vệt trắng trên ô có nền**;
  - `images` mặc định `PDF_REDACT_IMAGE_PIXELS` → **xoá pixel** của ảnh dưới hộp;
  - `graphics` mặc định → **xoá nét vector bị hộp phủ trọn**, đúng kiểu Word vẽ gạch chân.
- `fill` **vẫn còn trong API** cho ai cố ý muốn tô đè — chỉ đổi giá trị mặc định.
- **Vỡ khi:** sửa 1 chữ trong ô bảng có nền → hiện vệt trắng; hoặc mất đường kẻ.
- Lưới: `.venv\Scripts\python test_edit_text_layout.py` (5 ca, **kiểm theo PIXEL** —
  nét vector vẫn “tồn tại” dưới lớp fill nên đếm object sẽ pass trong khi trang hỏng).
- `/translate` đã theo đúng luật này từ trước (`test_translate_layout.py`) — hai đường
  phải giữ giống nhau.

### BI-25 · Vẽ lại chữ phải bám **hình học** của face bị thay, không chỉ tên font
- `api.py` `/edit-text` (khối “match the geometry”), `TextEdit.orig_text` + `orig_size`,
  `text-edit.js` `apply()`.
- Font gốc thường **không dùng lại được**: PDF nhúng nó dạng subset mất cmap nên cửa
  kiểm tra glyph từ chối (BI-21) → buộc phải thay bằng font hệ thống. **Cùng tên
  không có nghĩa cùng thiết kế**: đo trên hoá đơn VNPT, “TimesNewRomanBold” nhúng
  chỉ bằng **0.83 bề rộng** và **0.91 chiều cao** của Times New Roman Bold của
  Windows, advance từng chữ lệch **ngược chiều nhau** (T hẹp hơn, o rộng hơn) → **không
  một cỡ chữ nào chỉnh được cả hai**, phải hai phép hiệu chỉnh độc lập:
  1. **Cao**: nhân cỡ chữ sao cho line box (ascender..descender) của font thay khớp
     line box PDF khai cho font gốc — `(bbox_h / orig_size) / (asc − desc)`.
  2. **Rộng**: đo **nguyên chuỗi gốc** trong font sắp vẽ rồi ép scale x bằng
     `bbox_w / text_length`. Áp bằng `morph` quanh gốc baseline, **sau** bước cao
     (text_length tỉ lệ với cỡ chữ nên hai phép độc lập và ghép chính xác).
- ⚠️ **Đo nguyên chuỗi, KHÔNG `strip()`**: bbox đang chia là bbox của **cả chuỗi**, dấu
  cách cuối có advance thật. Cắt chuỗi mà giữ nguyên bbox là lệch cặp → vẫn rộng
  (đo được: median 1.03, tệ nhất 1.08). Đúng cặp thì ra **0.9994 / 0.9996**.
- Cả hai đều có **vùng chết ±2%** và kẹp biên độ tin cậy → tài liệu bình thường
  (font thay = font gốc) **không bị đụng vào**.
- **Vỡ khi:** sửa 1 dòng thì dòng đó dài ra đè sang chữ bên cạnh, hoặc chữ cao hơn
  hẳn các dòng chưa sửa.
- Lưới: `.venv\Scripts\python test_edit_text_metrics.py` (7 ca; có ca **canh gác**
  chứng minh không sửa thì thật sự tràn).
- Ghi nhớ khi đọc số: PyMuPDF trả `size` của span là **trung bình nhân** của ma trận
  chữ, nên một cú nén ngang 0.84 hiện ra thành `size × sqrt(0.84)` — nửa cú nén đã
  nằm sẵn trong cỡ chữ.
- ⚠️ **Ca descriptor < 1 em (PDFsharp / bản vẽ CAD, 2026-10-09).** PyMuPDF dựng bbox từ
  `/Ascent − /Descent` của **descriptor**; tổng **< 1.000** thì nó bỏ, bbox dày **đúng
  bằng `size`** (= √(Sv·Sh)) — mốc đo chính xác giữa 850/−149 và 850/−151. PDFsharp ghi
  728/−210 ⇒ bước **Cao** đọc "line box 1.000 em" cho mọi run và thu chữ theo line box
  font thay (Arial 1.117): bộ bản vẽ khách thấp **10.5 %** (khung tên), **20 %** (bìa).
  Sửa: `_bbox_is_size_fallback(e)` nhận ca này ⇒ Sh = bề dài / advance đo bằng **chính
  chương trình font nhúng của run** (`_page_font_programs_exact`, khoá theo face, **không**
  theo họ — `_page_font_buffers` gộp ArialMT với Arial-BoldMT), Sv = size²/Sh. Không có
  chương trình đó ⇒ quy tắc cũ chạy y như trước. Đo trên file khách: cao 18.25→18.25,
  dài 101.88→101.88, bìa 45.75→45.88. Lưới: 4 ca `test_pdfsharp_*` / `font_program_key`
  trong `test_edit_text_metrics.py` (có ca canh gác fixture thật sự rơi vào ca fallback;
  đột biến tắt nhánh ⇒ 3 ca đỏ 0.772/0.851).

### BI-24 · Không bao giờ dựng payload PDF thành **một chuỗi JS**
- **Nhà của luật này: `renderer/wire.js`** (tách khỏi `app.js` 2026-07-28) — có lưới
  `npm run test:wire` (51 ca). Trước đó nó nằm giữa `app.js` và **không** test được;
  đó là vấn đề, vì mọi cách vi phạm luật này đều hỏng **im lặng**.
- `pdfJsonBody()` — dùng ở **16 chỗ gọi** trong `app.js`/`text-edit.js`/`compare.js`,
  **bằng tên trần** (xem §2 để biết vì sao cố tình giữ vậy).
- `JSON.stringify({pdf_b64: u8ToB64(bytes), …})` tốn **ba bản sao cỡ đầy đủ** trên heap
  renderer (chuỗi nhị phân trong `u8ToB64`, base64 nó trả về, và bản sao của
  `stringify`) ⇒ ~500MB rác tạm cho file 134MB, chồng lên `state.bytes` + lịch sử undo.
  Đúng loại hết-heap mà v0.2.40 đã vá cho chiều **tải về** và bỏ sót chiều **gửi lên**.
- `pdfJsonBody` ghép `Blob` theo mảnh → byte nằm trong blob store của Blink (tràn ra đĩa
  được), mỗi lúc chỉ có **một mảnh 48KB** là chuỗi JS. **Định dạng trên dây không đổi.**
- **Kích thước mảnh phải là bội của 3** — base64 chỉ chèn `=` ở cuối luồng, chia đúng
  mốc 3 byte thì các mảnh nối thẳng được. Đổi thành số khác là hỏng payload **im lặng**.
- Nhận cả `Uint8Array` (→ `pdf_b64`) lẫn object `{tên: bytes}` cho `/compare` (2 tài liệu).
- **Không còn hàm `u8ToB64`** (xoá 2026-07-27). Nó là công cụ duy nhất dựng được payload
  thành một chuỗi JS, tức là chính cái bẫy điều luật này sinh ra để chặn — để nó nằm đó thì
  người viết lời gọi sidecar mới sẽ tìm thấy và tái lập đúng lỗi cũ. Cần đưa binary lên dây
  thì **chỉ** có `pdfJsonBody` (một/nhiều trường) hoặc `binArrayJsonBody` (mảng trong 1 trường).
- Chỗ cuối cùng còn sót đã vá cùng ngày: **Ảnh → PDF** (`pickI2pImages` / `runImagesToPdf`).
  Nó phình bộ nhớ **hai lần**: giữ base64 của **mọi** ảnh đã chọn suốt lúc hộp thoại mở
  (base64 = 4/3 dung lượng gốc), rồi `JSON.stringify` cả mảng đó thành một chuỗi nữa.
  100 ảnh điện thoại 5MB ⇒ ~670MB chuỗi tạm chồng lên ~670MB đang giữ. Nay giữ **byte thô**
  và chỉ mã hoá lúc gửi; xoá danh sách sau khi tạo xong (giữ lại khi lỗi để còn thử lại).

### BI-26 · Menu chuột phải là lối vào **không có id nút** → cổng bản quyền phải ở tầng HÀM
- `app.js` `openThumbMenu()` + `GATED_BTNS` / `installLicenseGuard()`.
- Cổng bản quyền có **hai** tầng và chúng không thay thế nhau:
  1. `installLicenseGuard()` bắt click theo **id của `<button>`** — chỉ chặn được nút thật
     khai trong `index.html`;
  2. `gateProFeature()` gọi **bên trong từng hàm** (`addBlankPageAt`, `insertBuffersAt`,
     `extractSelected`, `openSplit`→`convertReady`).
- Mục menu chuột phải là `<div>` sinh động, **không có id** → tầng 1 **không nhìn thấy nó**.
  Cùng tình huống với kéo–thả PDF vào dải thumbnail (đã đi qua `insertBuffersAt`).
- **Luật:** mọi lệnh trả phí thêm vào menu ngữ cảnh **phải** gọi một hàm đã tự gọi
  `gateProFeature()`. Đừng viết logic mới thẳng trong `onClick` của mục menu.
- Ngược lại: nút mới trên **thanh công cụ** thì phải thêm id vào `GATED_BTNS` (BI-9) —
  `btn-tb-blank` / `btn-tb-extract` / `btn-tb-split` là ví dụ.
- **Vỡ khi:** máy chưa kích hoạt bản quyền mà chuột phải vào thumbnail vẫn chèn/tách được.

### BI-27 · Số học khoảng trang sống ở `page-range.js`, **không** nhân bản vào `app.js`
- `desktop/renderer/page-range.js` (`parseSpec` / `computeRange` / `formatList`) —
  file renderer **duy nhất** không đụng DOM, nên là file renderer **duy nhất** có lưới
  tự động: `npm run test:pages` (36 ca).
- Ba luật đã có ca test canh gác, đừng “đơn giản hoá” mất:
  - `"-3"` và `"3-"` là **rác**, không phải số âm — số âm sẽ kẹp về trang 1 rồi xoá nhầm;
  - bỏ **toàn bộ** khoảng trắng trước khi tách token, nếu không `"1 - 3"` thành 3 token rác;
  - `computeRange` trả `error: "all"` khi kết quả ăn hết tài liệu — PDF phải còn ≥1 trang.
- `extractFileName` cũng ở đây: tên file gợi ý khi tách trang **phải có trần độ dài**.
  Liệt kê mọi số trang là không giới hạn — **~80 trang đã vượt 255 ký tự**, giới hạn của
  Windows cho một thành phần tên file, mà chuỗi đó đi thẳng vào `defaultPath` của hộp
  thoại Lưu. Trần tính trên **chuỗi cuối cùng**, không tính theo số trang: `baseName`
  là dữ liệu người dùng, dài bao nhiêu không biết trước. Thứ tự cắt: thu gọn phần
  trang trước (rẻ hơn), cắt phần tên gốc sau cùng.
- **Bản sao duy nhất còn sót đã hợp nhất 2026-07-28**: `editor.js` từng có
  `parsePageRanges()` riêng cho hộp thoại “Áp ảnh / chữ ký cho nhiều trang”, viết
  **trước** khi có luật này. Nó khác `parseSpec` theo hướng chỉ gây hại: gạch en
  (`1–3` — thứ Word/Excel sinh ra) và dấu chấm phẩy bị coi là **rác**, và **một**
  token hỏng làm **hỏng cả chuỗi**. Nay dùng chung `window.PageRange.parseSpec`.
  Đi kèm **hai thay đổi hành vi có chủ ý**, không được coi là hồi quy:
  1. token rác bị **bỏ qua** thay vì từ chối cả chuỗi;
  2. số vượt trang cuối bị **kẹp** về trang cuối thay vì biến mất.
  Điều kiện để hai thay đổi đó chấp nhận được là **người dùng nhìn thấy kết quả
  trước khi bấm**: `syncImgPages()` viết bản xem trước vào `#imgpages-hint` mỗi lần
  gõ và **khoá nút Áp dụng** khi không còn trang nào — đúng khuôn `syncDeleteRange()`
  của hộp thoại xoá. **Bỏ bản xem trước đi là làm hai thay đổi trên thành lỗi im lặng**
  (gõ `99` trên tài liệu 10 trang sẽ đóng dấu chữ ký lên trang 10 mà không ai biết).
  Ba tình huống hỏng có **ba câu thông báo riêng** — “chưa nhận ra trang nào” khác
  hẳn “chỉ gõ đúng trang ảnh đang nằm”; trước đây hai cái dùng chung một câu sai.
  `#imgpages-hint` vì thế phải nằm trong `SKIP_IDS` (BI-10).
- `app.js` gọi qua `window.PageRange.*` (có tên gọi rõ ràng), **không** gọi tên trần — xem BI-14.
- **Vỡ khi:** gõ “từ 5 đến 12, trừ 7” mà trang 7 vẫn biến mất · hoặc “Chọn tất cả” rồi
  Tách ra file mới thì hộp thoại Lưu hiện tên file rác/dài lê thê.

### BI-29 · “Sẵn sàng” là HAI điều kiện độc lập — engine và API key, hai badge riêng
- `app.js` `renderSidecarBadge()` / `setApiBadge()` / `refreshApiBadge()`;
  `index.html` `#sidecar-badge` + `#api-badge`.
- Engine cục bộ (sidecar) lo OCR/nén/tách/so sánh/sửa chữ. **Bóc tách và Dịch cần
  THÊM một API key Gemini.** Một badge “OCR: sẵn sàng” duy nhất bị đọc thành “mọi thứ
  chạy được” — đó là lý do tách đôi (yêu cầu người dùng 2026-07-26).
- `apiKey.configured` là **ba trạng thái**: `true` / `false` / **`null` = chưa biết**.
  `null` **không được** vẽ thành “chưa có key” — engine chưa lên hoặc `/config` không
  gọi được thì ta *không biết*, và mắng người dùng về một cái key họ đang có là sai.
  `refreshApiBadge()` nuốt mọi lỗi về `null` đúng vì vậy.
- Nguồn sự thật là `GET /config` → `gemini_configured` (sidecar không bao giờ trả key
  đầy đủ, chỉ mask). Ba chỗ cập nhật: sidecar vừa ready · mở hộp thoại Cài đặt ·
  lưu key xong (dùng luôn phản hồi POST, không gọi lại).
- Tín hiệu **không được chỉ dựa vào màu**: `.badge.dot::before` vẽ chấm **đặc = sẵn
  sàng**, **rỗng (vòng tròn viền) = chưa**. Bỏ phần hình dạng đi là mất tín hiệu với
  người mù màu và trên theme sáng (warn/ok gần nhau).
- Cả hai badge nằm trong `SKIP_IDS` (BI-10) ⇒ registry i18n **không** vẽ lại chúng khi
  đổi ngôn ngữ ⇒ phải tự vẽ lại qua listener `i18n:changed`. Bỏ listener đó thì thanh
  công cụ thành nửa Việt nửa Anh.
- **Vỡ khi:** chưa nhập key mà badge API vẫn xanh · hoặc engine chưa lên mà đã báo
  “chưa có key” · hoặc đổi VI↔EN thì hai badge đứng nguyên tiếng cũ.

### BI-28 · `Editor.active` / `TextEdit.active` là **thuộc tính**, không phải hàm
- `editor.js:3324-3327` và `text-edit.js:595-598` đều khai `get active() { … }` trả về
  **boolean**. Gọi `window.Editor.active()` ném `TypeError` — và vì các chỗ dùng nằm
  trong listener `keydown`, ngoại lệ **nuốt luôn phần còn lại của handler**.
- Bẫy nằm ở chỗ `x && x()` **im lặng khi cờ tắt**: `false && …` không gọi gì cả, nên lỗi
  chỉ hiện khi tính năng **đang bật** — đúng lúc ít ai test. Đã có thật ở `app.js` nhánh
  ↑/↓/PageUp/PageDown và nhánh Delete (sửa 2026-07-26); hành vi lúc đó *tình cờ* vẫn đúng
  vì ngoại lệ cũng làm handler không chạy tiếp, nên lỗi sống rất lâu mà không ai thấy.
- Mẫu đúng, dùng ở `updateToolbar()`: `!!(window.Editor && window.Editor.active)`.
- Mở rộng: **chế độ Sửa nội dung không cần kiểm riêng trong `keydown`** — `isTyping()` đã
  bao nó qua class `body.text-editing`. Thêm kiểm tra thứ hai là thừa và dễ lệch nhau.
- **Vỡ khi:** console đầy `TypeError: … is not a function` lúc đang chú thích · hoặc code
  mới thêm vào cuối handler đó không bao giờ chạy khi đang chú thích.

### BI-30 · Bàn tay giành chuột bằng `stopImmediatePropagation`, KHÔNG phải `stopPropagation`
- `pan.js` `onPointerDown` + cửa `mousedown`/`click`.
- `editor.js` (`viewer.addEventListener("mousedown", onDown)`) và `capture.js`
  (`v.addEventListener("mousedown", onDown, true)`) nghe trên **CÙNG phần tử
  `#viewer`** với pan. `stopPropagation()` chỉ chặn sự kiện **đi sang nút tiếp
  theo**, **không** chặn các listener khác **trên chính nút đang đứng** → cửa của
  capture.js vẫn chạy. Đã đo được bằng probe: `stopPropagation` cho lọt, đổi sang
  `stopImmediatePropagation` mới sạch.
- Đừng đổi ngược lại “cho nhẹ”. Cũng đừng dựa vào việc `preventDefault()` trên
  `pointerdown` tự dập `mousedown` (đúng theo spec, nhưng **không kiểm chứng được
  bằng sự kiện tổng hợp** — sự kiện dispatch tay không sinh mouse event tương thích).
  Vì vậy cửa `mousedown` tường minh là **lớp bảo đảm chính**, không phải dự phòng.
- **Vỡ khi:** kéo bàn tay lúc đang Chú thích lại vẽ ra một hình · hoặc kéo chuột
  giữa trong chế độ Copy ảnh lại kéo ra khung marquee.

### BI-31 · Nút chuột GIỮA là tài nguyên chưa ai chiếm — đó là lý do pan chạy được mọi lúc
- `pan.js` `shouldPan` nhánh `button === MIDDLE`.
- `editor.js` `onDown`, `capture.js` `onDown` đều mở đầu bằng `e.button !== 0` →
  nút giữa **không thuộc về ai**. Chính điều đó cho phép “pan cả khi đang chú thích”
  mà không phải giành giật gì.
- **Luật:** đừng gắn hành vi mới vào nút giữa trong `#viewer`. Nếu buộc phải, phải
  sửa `shouldPan` **cùng lúc**, không thì hai tính năng chạy chồng nhau im lặng.

### BI-32 · Toàn màn hình: dải thumbnail **không được chiếm chiều rộng layout**
- `app.css` khối `body.presenting .sidebar` (`position:absolute` + `transform`) +
  `app.js` `applyPresentation`.
- Chế độ này gọi `fitPage()` **một lần** lúc vào, đo trên `#viewer` rộng nguyên
  màn hình. Nếu dải thumbnail chiếm chiều rộng thật thì “trọn trang” sai âm thầm,
  và mỗi lần rê chuột mở dải là cả trang nhảy layout.
- Vì vậy dải trượt bằng `transform`, **không** bằng `width`. Lưới đo trực tiếp
  bất biến này (`viewer.clientWidth` trước/sau khi mở dải phải **bằng nhau**).
- `applyPresentation` **không còn** ép `toggleSidebar(true)` như trước: CSS lo việc
  ẩn. Ai thêm lại lệnh ép đó sẽ giết luôn dải thumbnail.
- Sidebar mà người dùng **đã tự thu** trước khi vào F11 thì vẫn thu (`.sidebar-collapsed`
  thắng) — F4 trong F11 vì thế phải **vừa mở lại vừa ghim**, không thì nó là phím bấm
  không ra gì.
- **Vỡ khi:** F11 xong trang không còn vừa màn hình · hoặc rê chuột mép trái thì
  trang co lại/nhảy.

### BI-33 · Dải thumbnail phải ở **MỘT CỘT** ở mọi bề rộng
- `app.css` `.thumbs` (flex column) + `app.js` `wireThumb` nhánh `dragover`.
- Kéo rộng sidebar được rồi thì phản xạ tiếp theo là “cho nó dàn thành lưới như
  Acrobat”. **Đừng.** Gợi ý chèn khi kéo–thả PDF từ ngoài vào chọn *trên hay dưới*
  bằng `e.clientY` so với **đường giữa dọc** của thumbnail. Xếp thành lưới thì
  “trên/dưới” thành câu hỏi sai ⇒ chèn nhầm vị trí trang, im lặng.
- Muốn làm lưới thật thì phải sửa **cả** gợi ý chèn sang trục ngang **trước**.
- **v0.2.52 — cùng số học đó nay lo CẢ hai loại kéo, và số hiệu “khe” là hợp đồng:**
  `thumbGapAt` trả về **khe** (`gap`), nghĩa là “giữa trang `gap-1` và trang `gap`”, nên
  0 là trên trang đầu và `numPages` là dưới trang cuối. Đó **đúng** là con số
  `insertBuffersAt` đã nhận từ trước ⇒ kéo–thả file dùng thẳng. Nhưng `reorderPage`
  **cắt trang ra trước rồi mới chèn lại**, nên chỉ số đo trên danh sách **gốc** bị lệch
  1 khi trang đang di chuyển nằm **trước** khe đó — đó là `gapToReorderIndex`, và sai nó
  là trang **rơi cách chỗ đã hứa một ô**, im lặng.
- Gợi ý phải nằm ở **hai** thumbnail cùng lúc (`insert-after` trên trang trên +
  `insert-before` trên trang dưới): tô một mép của một trang mới chỉ trả lời “tôi đang ở
  trên trang nào”, chứ không trả lời “nó sẽ nằm đâu” — mà trang đang trỏ có **một khe ở
  mỗi bên**. Đó là lý do `showThumbGapCue` xoá cue **toàn dải** rồi vẽ lại: `dragover`
  của thumbnail vừa vào và `dragleave` của thumbnail vừa rời **không** có thứ tự bảo
  đảm với nhau.
- Hai khe hai bên trang đang kéo là **no-op** (`gapIsNoOp`) và bị **từ chối**
  (không `preventDefault` ⇒ con trỏ hiện “không cho phép”): một cú thả đứng yên vẫn tốn
  một lần ghi lại cả tài liệu + một bước undo.
- **Vỡ khi:** kéo trang 1 xuống giữa trang 3–4 mà nó rơi vào giữa 2–3 · thả đúng chỗ cũ
  mà tài liệu vẫn “bẩn” (có dấu ●) · kéo ra ngoài dải rồi quay lại thì cue vẫn còn dính.
- Lưới: `npm run test:geom` (`gapToReorderIndex`/`gapIsNoOp`, **cắt thẳng từ `app.js`**,
  đối chiếu với một phép splice thật chứ không với một công thức viết lại).

### BI-34 · Trần bề rộng sidebar bị quy định bởi **raster thumbnail**, không phải thẩm mỹ
- `app.js` `SIDEBAR_W_MAX` + `renderThumbCanvas` (`150 / base.width`).
- Thumbnail luôn rasterise ở **150px ngang**; panel rộng hơn chỉ là **phóng to**
  đúng bitmap đó. 300px ⇒ vẽ ~252px (1,7× — mềm nhưng vẫn nhận ra trang);
  vượt xa nữa thì nhoè.
- Nâng raster lên cho nét **không miễn phí**: thumbnail render lười nhưng **không
  bao giờ được giải phóng**, nên tài liệu vài trăm trang trả tiền cho mọi trang đã
  cuộn qua. Raster hợp với panel 420px sẽ **gấp ~4 lần** hoá đơn đó.
- **Luật:** đổi `SIDEBAR_W_MAX` thì phải trả lời câu hỏi raster + bộ nhớ, không
  chỉ nhìn cho đẹp.

### BI-35 · “Mở file mới trong” sống ở MAIN, và **cả ba** đường mở file phải hỏi cùng một chỗ
- `src/prefs.js` (lưu) + `src/tabs.js` `planOpen()` (quyết định, thuần, có lưới) +
  `main.js` (`tabs:open-paths`, `openPathInApp`) + `renderer/app.js` (`#set-open-in`).
- **Vì sao ở main, không phải localStorage:** file từ Explorer (“Open with”) có thể tới
  lúc **chưa có cửa sổ nào** — không có renderer để hỏi. Đúng lý do `session.js` giữ cờ
  `restore` trên đĩa. (Cũng là lý do **không** nhét vào `session.json`: giá trị của file
  đó nằm ở phạm vi hẹp — chỉ đường dẫn — xem BI-18.)
- Có **ba** đường mở tài liệu; bỏ sót một đường là người dùng thấy “lúc tab lúc cửa sổ”:
  1. nút Mở / Ctrl+O / menu Mở → `openDialog` → `tabs:open-paths`;
  2. kéo–thả PDF vào viewer khi tab **đã có** tài liệu → `tabs:open-paths`;
  3. Explorer “Open with” / mở file thứ hai / macOS `open-file` → `openPathInApp`.
- **Tab đang trống thắng tuỳ chọn** (`fillCurrent`). Không thế thì chọn 3 file trong một
  cửa sổ trắng sẽ **để nguyên cửa sổ trắng đó** và mở thêm cửa sổ thứ hai.
- Chọn **nhiều file** + “Cửa sổ mới” = **MỘT** cửa sổ mới chứa cả loạt. Mỗi file một cửa
  sổ nghĩa là mỗi file một **tiến trình renderer** — chọn 30 file thành sự cố tài nguyên.
- Giá trị đi qua IPC là **đầu vào không tin cậy**: `setOpenIn` chỉ nhận `"tab"`/`"window"`,
  còn lại về mặc định; đọc từ đĩa cũng qua đúng cửa đó (file có thể bị sửa tay).
- Mặc định **bắt buộc** là `"tab"` — đúng hành vi có từ trước khi có tuỳ chọn. Pref hỏng
  hay không đọc được **không bao giờ** được suy thành “rải tài liệu ra nhiều cửa sổ”.
- **Vỡ khi:** đổi sang “Cửa sổ mới” mà double-click file trong Explorer vẫn ra tab · chọn
  10 file thì mở 10 cửa sổ · tab trắng vẫn trắng còn file chui sang cửa sổ khác.
- Lưới: `npm run test:tabs` (mục `prefs.js` + `planOpen`, gồm 2 ca canh gác BI-8).

### BI-14 · Gọi hàm chéo module theo kiểu “tên trần” là điểm gãy im lặng
- `rerenderChanged` (gọi từ `editor.js:2521`, `text-edit.js:519`) và
  `showOverlay`/`hideOverlay` (gọi từ 4 module) **không** có `window.` và **không** có guard.
- Đổi tên/xoá chúng trong `app.js` → `ReferenceError` lúc chạy, không lỗi lúc build.
- Ngược lại `repaintRenderedPages` có guard `if (window.…)` — mẫu này an toàn hơn, nên theo.

**Mặt thứ hai của cùng vấn đề, mất một lần vỡ app mới thấy (v0.2.49):** khi **hoist code
vào một classic script mới**, phải kiểm trùng tên cho cả **binding destructure**, không
chỉ tên hàm.
- `managed-codec.js` khai `const { PDFName, PDFRawStream, PDFDict, degrees } = PDFLib`
  ở **top level**. `app.js:17` cũng khai `const { PDFDocument, degrees } = window.PDFLib`
  ở top level. Hai `const degrees` trong **cùng** global scope = **SyntaxError**, và nó
  không giết file mới — nó giết **`app.js`**, file nạp sau. `$` biến mất ⇒ `pan.js`,
  `editor.js`, `capture.js`, `sign.js` đổ theo. **App trắng.**
- **`node` không bao giờ thấy lỗi này**: `require()` cho mỗi module một scope riêng, nên
  **537/537 ca lưới xanh trong lúc app đang vỡ**. Chỉ probe Electron bắt được. Đây là ca
  cụ thể chứng minh vì sao §1 nói "nửa DOM thì vẫn phải probe" — nó không chỉ đúng cho DOM,
  mà cho **mọi** thứ phụ thuộc scope dùng chung.
- **Cách làm đúng, xem `managed-codec.js`:** bọc **IIFE** để mọi binding riêng (nhất là
  destructure từ thư viện) thành private, rồi publish bề mặt công khai bằng
  `Object.assign(window, SURFACE)`. Một **property** của global object vẫn được phân giải
  y như tên trần khi *đọc*, mà **không thể** SyntaxError với khai báo của script khác.
  (`annot-text.js`/`annot-geom.js` không cần IIFE vì chúng không destructure gì từ thư viện
  — nhưng nếu sau này có thêm, phải đổi sang khuôn IIFE.)
- **Vỡ khi:** mở app thấy trắng · console có `Identifier 'X' has already been declared` ·
  hoặc `$ is not defined` hàng loạt (dấu hiệu `app.js` chết, **không** phải `$` bị đổi tên).
- Kiểm nhanh trước khi thêm file: `grep -nE "^\s*const \{.*\} = " renderer/*.js` rồi đối
  chiếu từng tên trong ngoặc.

### BI-36 · Zoom là HAI nửa: đổi hình học ngay, rasterise sau — và **không** dựng lại `.page-wrap`
- `app.js` `applyScaleToDom()` + `commitScale()` + `scheduleScaleCommit()`; `zoomTo` gọi cả ba.
- Trước v0.2.48 `zoomTo` gọi thẳng `renderViewer()`: **mỗi nấc lăn chuột** xoá sạch mọi
  `.page-wrap`, dựng lại canvas + hai IntersectionObserver rồi rasterise. Đó là nguyên nhân
  “zoom bị khựng/giật”. Cờ `zooming` còn **âm thầm bỏ** những nấc tới trong lúc nó chạy.
- Luật: **nửa đồng bộ chỉ được đổi CSS box** (`canvas.style.*` và `transform` của **cả
  bốn** lớp phủ: `.text-layer` / `.note-layer` / `.search-layer` / `.fr-layer`). Không
  `page.render`, không tạo/xoá phần tử. Nét lại là việc của `commitScale` sau
  `SCALE_COMMIT_MS`.
- **`.text-layer` KHÔNG còn được ghi `--scale-factor` giữa lúc zoom** (đổi 2026-09-20).
  pdf.js 3.x viết vị trí span bằng `calc(var(--scale-factor) * Npx)`, nên ghi biến đó bắt
  trình duyệt **dựng lại layout của mọi span**: đo một nấc lăn chuột — 6,4 ms trên trang
  CAD (446 span), 96–134 ms trên trang nhiều chữ (~20 000 span), so với **0,1 ms** khi
  dùng `transform`. Lớp chữ giờ mang `data-pscale` như ba lớp kia và được `applyScaleToDom`
  scale theo `state.scale / pscale`; `addTextLayer` phải **gán `data-pscale`** — quên là
  lớp chữ scale sai hệ số ngay nấc zoom đầu tiên. Đã kiểm trên app thật: vị trí một span
  tính theo **tỷ lệ của khung trang** không đổi qua 100% → 150% (giữa cử chỉ) → 150% (sau
  commit) → 50% → về 100%: `fx=0.64152, fy=0.49562` ở **cả sáu** mốc.
- **Không được dựng lại `.page-wrap` khi zoom.** Overlay chú thích, ô nhập chữ đang mở,
  highlight Ctrl+F và cả hình học cuộn đều bám vào đúng phần tử đó — `renderViewer` phá
  hết (đó là lý do nó chỉ dùng cho **đổi tài liệu**, không dùng cho **đổi tỷ lệ**).
- `m.paintScale` = tỷ lệ mà bitmap hiện tại được vẽ ở. `commitScale` so nó với
  `state.scale` để biết trang nào còn đang bị kéo giãn; **quên gán** nó trong
  `renderPageCanvas` thì trang mờ mãi không bao giờ nét lại.
- `.note-layer`/`.search-layer` mang `data-pscale` **riêng của nó**, không dùng
  `m.paintScale`: `gotoMatch` dựng lại lớp tìm kiếm giữa hai nấc zoom, dùng tỷ lệ của
  trang sẽ scale **hai lần**.
- Bước lăn chuột là **phép nhân** (`wheelZoomFactor`, cơ số 1.1/nấc, kẹp ±3 nấc), và
  `zoomTo` làm tròn **3 chữ số thập phân**, không phải 2: cộng cố định 0.1 là nhảy 25% ở
  mức 40% và chỉ 3% ở mức 300%; còn làm tròn 2 chữ số thì các delta nhỏ của pinch
  trackpad bị vo về đúng tỷ lệ cũ ⇒ cử chỉ **chết**.
- **Vỡ khi:** zoom xong trang mờ mãi · chú thích/ô nhập chữ biến mất khi zoom · highlight
  tìm kiếm lệch sau khi zoom · Ctrl+lăn nhanh mất nấc · pinch trackpad không ăn.
- Lưới: `npm run test:geom` (`wheelZoomFactor`) + probe Chromium (nửa DOM — xem §1).

### BI-37 · Byte ảnh gốc của ảnh round-trip nằm trong stream `/NabuSrc` **không có `/Filter`**
- `editor.js` `addManagedAnnot` (nhánh `image`) ghi; `managedSrcBytes` đọc.
- **Vì sao không nhét vào `/NabuData` như mọi kind khác** (đo trên pdf-lib 1.17.1 đang ship):
  chuỗi hex tốn ~1.46× cỡ ảnh và >1 s để ghi 1 MB; **và cả** `PDFHexString.decodeText`
  **lẫn** `PDFString.decodeText` **ném `RangeError`** khi payload > ~150 KB (chúng spread cả
  buffer qua `String.fromCharCode`) ⇒ một PNG chữ ký đã không đọc lại được. Stream thô =
  1.00×, ~5 ms cho 2 MB, đọc ra đã là byte.
- **Không** khôi phục được từ ảnh trong `/AP`: pdf-lib giải mã PNG thành mẫu thô + `/SMask`,
  bỏ luôn container.
- **`/Filter` là cái khoá an toàn**: ta ghi không filter, nên có filter = tool khác đã nén
  lại ⇒ `managedSrcBytes` trả `null`, và khi đó `stripManagedFromPage` **từ chối xoá** annot
  đó. Mất byte gốc phải thành “ảnh chỉ đọc”, **không bao giờ** thành “ảnh bị xoá lúc bake”.
- **Vỡ khi:** mở lại file thấy ảnh nhưng bấm Chỉnh sửa thì ảnh biến mất sau khi Áp dụng.
- Lưới: `npm run test:managed`.

### BI-38 · Bỏ liên kết annot round-trip là **chưa đủ** — phải giải phóng chuỗi object của nó
- `editor.js` `stripManagedFromPage` → `collectManagedChain` → `freeManagedTrash`.
- pdf-lib giữ **mọi** object nó đọc được và ghi lại tất cả khi save. Chỉ `arr.remove(i)` thì
  ảnh/PNG appearance của bản cũ **nằm lại trong file mãi mãi** — một hộp văn bản bake 10 lần
  là 10 bản PNG. Với ảnh (megabyte) thì file phình đến mức không thể bỏ qua.
- An toàn được vì chuỗi đó là **của riêng** annot: `embedPng`/`embedJpg` của pdf-lib trả
  **ref mới mỗi lần gọi** (không bao giờ dedupe theo nội dung), và `/NabuImg` là tên resource
  không chỗ nào khác ghi. Cái gì **không** giống hệt output của ta thì **bỏ qua** — xấu nhất
  là phình như cũ, tuyệt đối không được để lại ref treo.
- **Thứ tự bắt buộc: bỏ liên kết cả tài liệu TRƯỚC, giải phóng SAU.** Một `/NabuSrc` được
  **chia sẻ** cho mọi trang mà “Áp ảnh/chữ ký cho nhiều trang” đặt lên; xoá bản của trang 1
  giữa vòng lặp làm `managedSrcBytes` của trang 2 trả `null` ⇒ annot đó **được giữ lại rồi
  ghi thêm bản mới** = một ảnh hai lần. Vì thế `stripManagedFromPage` nhận `trash` và
  `bakeWithRedaction` chỉ gọi `freeManagedTrash` **sau** vòng lặp.
- **Vỡ khi:** lưu vài lần thì file to dần dù nội dung không đổi · áp 1 chữ ký cho 20 trang
  ra file gấp 20 lần cỡ ảnh · sau khi áp dụng thấy ảnh nhân đôi trên một trang.
- Lưới: `npm run test:managed` (3 vòng re-bake + ca 5 trang dùng chung + ca `/Filter`).

### BI-39 · “Trang đang xem” trong cột trang **không phải** “trang đang chọn”
- `app.js` `syncThumbFocus()` + `.thumb.current` trong `app.css`.
- `state.selected` là tập trang cho Xoá/Tách/Trích/Xoay. Nếu cuộn tài liệu cũng đổi nó thì
  cuộn qua trang khác rồi bấm Xoá sẽ **xoá trang vừa cuộn tới** — đúng loại hậu quả BI-26.
  Vì thế `syncThumbFocus` chỉ gắn/bỏ class, **không chạm** `state.selected`.
- Cue hình phải **khác** `.selected` (viền accent) — hiện dùng nền `--bg-3` + số trang đổi màu.
- Đang kéo–thả sắp xếp trang (`state.dragSrc != null`) thì **không được cuộn** cột trang:
  `wireThumb` chọn khe chèn theo `e.clientY` so với đường giữa thumbnail (BI-33).
- Dùng số học `nearestScrollDelta` chứ **không** `el.scrollIntoView()` — cái đó cuộn cả
  **phần tử cha** và có animation, đánh nhau với smooth-scroll của viewer.
- Thứ tự khởi tạo: `renderAll` chạy `renderThumbs` **trước** `renderViewer`, nên
  `renderThumbs` chỉ **reset** `thumbFocusIdx`; đánh dấu là việc của cuối `renderViewer`
  (lúc đó `#viewer` mới chứa trang của tài liệu mới).
- **Vỡ khi:** cuộn tài liệu rồi bấm Xoá trang thì mất trang không mong muốn · thumbnail sáng
  sai trang sau khi mở file khác · cột trang nhảy khi đang kéo sắp xếp trang.
- Lưới: `npm run test:geom` (`nearestScrollDelta`) + probe Chromium.

---

### BI-40 · Chữ và mây có **một** bộ số học, dùng cho **hai** đích — màn hình và PDF đã bake
- `annot-text.js` `layoutTextBox()` là nguồn duy nhất cho **cả hai**: `measureText()` (hộp
  trên màn hình người dùng gõ vào) và `renderTextPng()` (PNG thật sự đem bake vào PDF).
  Hai đường lệch nhau là **lỗi im lặng**: màn hình trông đúng, file đã lưu bị tràn chữ /
  xuống dòng khác / khác số dòng. Không ai thấy tới khi khách mở hợp đồng.
- Cùng khuôn: `annot-geom.js` `cloudPath()` / `cloudPathPoly()` trả **một** chuỗi SVG path
  cho **cả** overlay `<svg>` (viewBox gốc 0) **và** `drawSvgPath` của pdf-lib. Hai luật
  bất khả xâm phạm: (1) **mọi toạ độ ≥ 0** — đó là việc của `pad`; âm là bị cắt trên
  overlay và đặt sai chỗ trong PDF; (2) `cloudPathPoly` **phải** trả `minX`/`minY` — bỏ
  đi là mọi mây freehand nhảy về góc trên-trái trang.
- Ba luật đã có ca canh gác, đừng “đơn giản hoá” mất:
  - `letterSpacing` nằm **GIỮA** các glyph ⇒ dòng n ký tự có **n-1** khoảng. Đếm n khoảng
    là âm thầm nới rộng **mọi** hộp (vô hình ở mặc định 0, sai với mọi ai chỉnh spacing).
  - `align: justify` **không** áp cho dòng cuối đoạn (`lastOfPara`), kể cả dòng ngay
    trước một dòng trống — nếu không thì đoạn nào cũng kết bằng một dòng bị kéo giãn.
  - `bumpOf({bump: 0})` phải trả về mặc định: `0` là falsy **có chủ ý**, vì `bump = 0`
    làm `Math.round(len / 0)` ra `Infinity` và treo lúc dựng path.
- Cột chữ của danh sách bullet/số lấy theo marker **rộng nhất** trong khối, không theo
  marker của từng dòng — nếu không thì “9.” và “10.” làm chữ bị bậc thang.
- **Đã sửa ở v0.2.49 — `fontFamily(falsy)` trả về stack `sans`.** Trước đó nó trả
  `'"sans", sans-serif'`, tức đi tìm font tên **literal** `sans` (không tồn tại) rồi rơi về
  `sans-serif` chung ⇒ **Arial** trên Windows. Hộp văn bản **không** đi vào nhánh này
  (`normTextStyle` luôn cấp `font: "sans"`), nhưng `textFont(fpx)` gọi **không có** `opts`
  thì có — và đó **đúng là** hai rasteriser `renderArrowPng` / `renderWatermarkPng`. Kết
  quả: **nhãn mũi tên + watermark render bằng Arial** còn mọi hộp văn bản dùng Segoe UI,
  suốt nhiều phiên bản, mà **không ai phát hiện được** vì cả hai **không có** tuỳ chọn font
  (`TOOL_CTLS.arrow` = `["color","penwidth","arrowlabel"]`; modal watermark chỉ có
  size/angle/opacity/color). `labelSize` cũng hardcode `14`. *(Từ BI-112: có ô **Cỡ nhãn**; mặc định vẫn 14.)*
- **Phạm vi ảnh hưởng của bản sửa, đã đo bằng probe (không suy luận):** `layoutTextBox`
  **0/1248** lệch · `measureText` **0/1248** lệch · hình học mây/mũi tên **0/178** lệch ·
  `textFont` **1104/1248** lệch — đúng những ca **không** có `font` tường minh (144 ca còn
  lại có `serif`/`mono`/tên font hệ thống nên không đổi). Tức hộp văn bản và hình học
  **không** đổi gì; chỉ nhãn mũi tên + watermark **bake mới** đổi font. Cái đã bake là
  pixel nên file cũ không đổi.
- **Nếu muốn cho người dùng chọn font cho nhãn mũi tên / watermark** thì đó là **tính năng
  khác**: phải thêm field `font` vào annot mũi tên + object watermark, thêm `"font"` vào
  `TOOL_CTLS.arrow`, và truyền style vào `textFont` ở hai rasteriser. Bản sửa v0.2.49
  **không** làm việc đó — nó chỉ làm mặc định nhất quán.
- **Vỡ khi:** gõ chữ Việt có dấu vào hộp rồi Xong mà chữ tràn khỏi khung · đổi
  letter/word spacing xong hộp rộng hơn chữ · khoanh mây freehand rồi Lưu mà mây nhảy chỗ.
- Lưới: `npm run test:text` (annot-text.js) + `npm run test:cloud` (annot-geom.js) +
  `npm run test:geom` (`resizeRect`). Nửa DOM vẫn phải probe — xem §1.

### BI-41 · `.edit-bar` phải `flex-wrap: wrap` — thanh tràn thì mất nút **Xong**
- `app.css` khối `.edit-bar` (dùng chung cho `#edit-bar` **và** `#tedit-bar`).
- Thanh này là **một hàng flex**, và nội dung của nó **phụ thuộc công cụ đang chọn**
  (`syncCtlVisibility`). Công cụ có palette rộng làm nó rộng hơn cửa sổ. Hai thứ bị đẩy
  ra ngoài đầu tiên lại đúng là `#ed-exit` và `#ed-apply` — tức người dùng chú thích được
  mà **không có đường nào ghi lại hay huỷ bỏ**. Kèm theo: `#ed-hint` có `min-width: 0`
  nên bị bóp về 0 rồi **chữ xuống dòng dựng đứng**, đẩy thanh cao **381px** và nuốt mất
  vùng xem trang.
- **Đo bằng probe Electron trên chính `app.css`** (không suy luận) — width nhỏ nhất còn
  bấm được "Xong", 13 nút công cụ / 15 nút:

  | Công cụ | 13 nút | 15 nút |
  |---|---|---|
  | select · image | 959px | 1035px |
  | highlight · note · redact | 1026px | 1102px |
  | draw · check · cross | 1110px | 1186px |
  | measure | 1225px | 1301px |
  | arrow | 1290px | 1366px |
  | box · ellipse | 1451px | 1527px |
  | **cloud · cloudpen** | **1667px** | **1743px** |

  Nghĩa là **trước khi thêm gì cả**, laptop 1366px đã mất nút Xong ở 3 công cụ. Mỗi nút
  công cụ thêm vào tốn **+76px** trên **mọi** dòng của bảng.
- **Đo lại 2026-09-20 sau khi thêm 2 nút (17 nút: + Tô sáng theo chữ, + Hình tự do).** Probe
  `Emulation.setDeviceMetricsOverride` trên app thật, **17 công cụ × 4 bề rộng**: nút **Xong**
  nằm trong khung nhìn **và bấm tích được** (`elementFromPoint` trả về chính nó) ở **tất cả
  68 tổ hợp**. Thanh cao tối đa **127px ở 900/1024px**, **87px ở 1366/1920px** — đúng bằng
  con số trước khi thêm. `flex-wrap` nuốt trọn +152px; đó là lý do nó còn ở đó.
- **17 nút chia thành 5 nhóm bằng `.sep` (2026-09-20).** Một dãy 17 icon không phân nhóm
  là một bức tường phải đọc từ trái sang phải mỗi lần. Năm họ: **chọn · chữ & tô sáng ·
  hình vẽ · ký hiệu & ghi chú · chèn & xử lý**. **Thứ tự nút KHÔNG đổi** — mọi họ vốn
  đã liền nhau, nên việc chia nhóm không lấy đi trí nhớ tay của ai; đảo thứ tự thì có.
  Đo lại sau khi thêm 4 dấu phân cách (9px mỗi cái): thanh cao **y nguyên** 127px @900/1024
  và 87px @1366/1920, "Xong" bấm được ở cả 68 tổ hợp.
- **`.edit-bar .tools` cũng `flex-wrap: wrap` (2026-09-20).** Dãy công cụ là **một** flex item
  của thanh, nên nếu nó không tự gấp thì dưới ~700px nó đẩy "Xoá mục"/"Xong" ra khỏi mép
  — đúng kiểu hỏng mà BI-41 sinh ra để chặn, chỉ ở bề rộng mà bảng đo đầu tiên không
  chạm tới. Đo sau khi thêm: **640 / 700 / 800px** — "Xong" bấm được ở **mọi** công cụ
  (thanh cao tối đa 206px ở 640px, chấp nhận được — nút commit vẫn trên màn hình).
- **Icon phải được CHỌN BẮNG CÁCH NHÌN, ở đúng 18px.** `ic-texthl` và `ic-poly` đều phải vẽ
  lại sau khi dựng thử trong app: bản đầu của `ic-texthl` ("mấy dòng chữ + một dải") đọc
  ra **icon canh lề / danh sách**, và `ic-poly` vẽ kèm 5 chấm đỉnh thì ở 18px các chấm **dính
  vào đường biên thành hình ngôi sao**. Dựng 4 phương án cạnh nhau ở đúng cỡ thật rồi chọn
  mới ra được — **đừng chọn icon bằng cách đọc đường `d`**.
- Có `wrap` thì ở mọi width 900–1920px nút Xong luôn bấm được, thanh cao **46–127px**.
- **Luật:** thêm nút vào `#ed-tools` (hay control vào palette) thì phải trả lời câu hỏi
  bề rộng, không chỉ nhìn cho vừa mắt trên màn hình của mình. Và **đừng gỡ `flex-wrap`**
  "cho gọn một hàng" — nó là thứ duy nhất đang giữ nút commit trên màn hình.
- **Vỡ khi:** thu nhỏ cửa sổ khi đang Chú thích → không thấy "Xong"/"Hủy bỏ" · hoặc chọn
  công cụ Khoanh mây thì thanh công cụ phình cao che mất trang.
- **Cập nhật v0.2.53 — `#ed-hint` không còn là chỗ để chữ hướng dẫn.** Câu hướng dẫn theo
  từng công cụ (15 câu) + `SELECT_HINT` / `ARROW_HINT` / hint nhóm đã bị **bỏ**, chuyển sang
  **Trợ giúp → Hướng dẫn sử dụng** (`renderer/help.js`). Ô `#ed-hint` giữ lại nhưng **chỉ**
  cho **trạng thái tạm**: dòng "đang vẽ mây từng điểm" và tỷ lệ của công cụ Đo — cả hai đều
  ngắn và phụ thuộc trạng thái. Ghi qua **một** hàm duy nhất `setEdStatus()` trong
  `editor.js`.
  - **Luật:** **đừng để chữ có thể dài trở lại ô này.** Đó chính là cái đẩy thanh lên
    381px. Muốn thêm hướng dẫn thì thêm vào `SECTIONS` của `help.js`, ở đó nó được dịch
    (VI/EN) và không ảnh hưởng bố cục thanh công cụ. `#ed-hint` nằm trong `SKIP_IDS` của
    `i18n.js`, nên mọi chữ đặt vào đây vĩnh viễn **không có bản tiếng Anh**.
  - Đã đo lại bằng probe Electron sau khi bỏ: công cụ *Khoanh mây*, thanh cao **86px** ở
    1366px và 1024px, **127px** ở 900px, nút **Xong** bấm được ở cả ba.
  - Lưới: `npm run test:help` (chặn lệch bản dịch VI/EN, markup `**`/`` ` `` không cân,
    và thiếu bất kỳ cử chỉ nào từng chỉ sống trong hint cũ).

### BI-42 · ✓ / ✗ và đoạn thẳng Shift dùng **một** bộ số học ở `annot-geom.js`
- `annot-geom.js` `symbolStrokes()` + `strokeExtend()`; chỗ gọi ở `editor.js`
  (`renderAnnot` nhánh `SYMBOL_KINDS`, `drawOneAnnot`, nhánh `drag.type === "draw"`).
- **`symbolStrokes` là cùng khuôn BI-40**: một hàm, **hai** người đọc — `<svg>` overlay và
  `page.drawLine` lúc bake. Viết riêng hình ✓ cho phần bake là tái lập đúng lớp lỗi im
  lặng của BI-40: màn hình đúng, file giao cho khách sai.
- **`strokeExtend` có đúng một cái bẫy, và nó im lặng hoàn toàn:** điểm neo của đoạn
  thẳng phải được **chốt một lần** lúc Shift vừa nhấn rồi mang theo qua các lần
  `mousemove` (`drag.lineFrom`). Suy lại neo = "điểm cuối" ở mỗi lần move sẽ ghim nó vào
  chính điểm vừa ghi ⇒ đoạn thẳng luôn dài 0 ⇒ **Shift trông như không làm gì**, không
  lỗi, không cảnh báo. `npm run test:cloud` có ca canh gác dựng lại đúng lỗi đó.
- `e.shiftKey` đọc **live từ event** (đúng khuôn `resizeRect` ở `onMove`), nên nhấn/thả
  Shift giữa chừng ăn ngay — đó là thứ cho phép một nét trộn cả gấp khúc lẫn vẽ tay. Nếu
  đổi sang đọc từ một cờ `keydown` toàn cục thì cờ sẽ **kẹt** khi Shift được thả lúc cửa
  sổ mất focus.
- ✓/✗ nằm trong `RESIZABLE_KINDS` ⇒ được 4 tay nắm + Shift-giữ-tỷ-lệ **miễn phí**; đổi lại
  chúng **bắt buộc** phải có `x/y/w/h` thật (`resizeRect` chỉ biết hộp).
- Bấm-một-cái ra cỡ mặc định là việc của **`onUp`**, không phải `onDown`: `onDown` không
  biết cử chỉ sẽ là bấm hay kéo. Hộp bị **kẹp vào trong trang** ở bước đó — dấu treo nửa
  ngoài mép giấy thì 4 tay nắm không tóm lại được.
- Màu: ✓ và ✗ có **màu nhớ riêng** (`ed.checkColor`/`ed.crossColor`, khuôn `redactColor`)
  nhưng **dùng chung ô "Màu"**. `colorSlotFor()` là chỗ duy nhất quyết định ghi vào đâu, và
  nó ưu tiên **kind của mục đang chọn** hơn công cụ hiện tại — nếu không, dưới công cụ Chọn
  việc đổi màu một dấu ✗ sẽ âm thầm ghi đè màu chung của bút tô sáng/vẽ tay.
- ~~Hai loại này **flatten** khi bake~~ — **từ v0.2.73 chúng round-trip** (`MANAGED_KINDS` +
  `VECTOR_KINDS`, đi đúng con đường chữ nhật / elip / mây đã đi ở BI-64). `/AP` dựng trong
  `shapeAppearance` từ **chính** `symbolStrokes()` ở gốc 0 — tức `symbolStrokes` nay có **ba**
  người đọc (overlay, flatten, `/AP`), không được viết lại hình ✓ riêng cho bất kỳ ai. Nét trong
  `/AP` sàn ở **1** (như nhánh flatten), không phải 0.1 như `lw` của các shape khác. Nhánh flatten
  vẫn còn: trang `/Rotate` lệch 90° (`apRotatable` false) và chế độ redact vẫn đi qua nó.
  `test:rotate` §6/§7 so mực `/AP` với mực flatten ở 4 góc × 2 khổ.
- **Vỡ khi:** giữ Shift mà nét vẫn ngoằn ngoèo (hoặc đứng im) · dấu ✓ trên màn hình một
  nơi, trong PDF đã lưu một nẻo · ✓/✗ bấm Xong xong không chọn / copy lại được · đổi màu ✗ xong bút tô sáng cũng đổi màu theo · đóng dấu
  sát mép trang rồi không kéo tay nắm được nữa.
- Lưới: `npm run test:cloud`. Nửa DOM + nửa bake vẫn phải probe — xem §1.

### BI-43 · Ảnh trang in phải **vừa TRONG** tờ giấy, không phải vừa **bề ngang** — và khoảng trang của hộp thoại hệ thống đếm **TỜ**
- `app.css` khối `@media print` (`.print-sheet` / `.print-page`) + `app.js`
  `buildPrintPages()` (bọc mỗi ảnh trong `.print-sheet`) + `main.js` `print:page`.
- **Lỗi gốc, đã có thật (báo 2026-07-31, sửa ở v0.2.51):** ảnh trang nằm thẳng dưới
  `#print-root` với `width:100%; height:auto` — tức **vừa bề NGANG**, chiều cao thả tự do.
  Tỷ lệ giấy lệch tỷ lệ trang **một chút** là ảnh cao hơn tờ giấy ⇒ Chromium ngắt phần
  dưới sang **tờ thứ hai**. Đo bằng probe Electron trên chính stylesheet này, trang nguồn
  595.2×841.92pt (tỷ lệ 1,414516):

  | Giấy | fit-to-width (cũ) | contain (nay) |
  |---|---|---|
  | A4 | 1 tờ/trang | 1 tờ/trang |
  | **A3** | **2 tờ** — tràn 0,11 mm | 1 tờ/trang |
  | **Letter** | **2 tờ** — tràn 26 mm | 1 tờ/trang |
  | Legal / Tabloid | 1 tờ/trang | 1 tờ/trang |

- **Vì sao lỗi chỉ hiện khi "Mở hộp thoại máy in của hệ thống":** `pageSize` ta truyền chỉ
  có hiệu lực ở nhánh `silent: true`. Mở hộp thoại hệ thống thì **giấy do driver quyết**
  — máy đầu tiên gặp lỗi này là driver **HP Color LaserJet A3/11x17**, tức A3. Nhưng đây
  **không** phải lỗi của hộp thoại: chọn **A3 trong hộp thoại của Nabu** (không mở hộp
  thoại hệ thống) tái hiện y hệt. Đừng đi vá tầng IPC.
- **Hậu quả tổ hợp — chỗ làm người dùng hiểu sai hoàn toàn:** khoảng trang trong hộp thoại
  hệ thống đếm **TỜ IN**, không đếm trang tài liệu. Khi 1 trang = 2 tờ, gõ `1-2` in ra
  **trang 1 hai lần** (nửa trên + dải dưới). Vì vậy bất biến "1 trang = 1 tờ" **là điều
  kiện để mọi khoảng trang có nghĩa**, không chỉ là chuyện thẩm mỹ.
- **`html, body { height: 100% }` trong khối print KHÔNG phải trang trí.** Không có nó,
  `height:100%` của `.print-sheet` rơi về `auto`, clamp thành vô hiệu và lỗi tràn quay lại
  y như cũ — đã đo đúng cái sai đó trước khi chốt hình dạng này.
- `<img class="print-page">` **không được** là con trực tiếp của `#print-root`: cái clamp
  cần hộp `.print-sheet` cỡ cố định để clamp vào. Ai "đơn giản hoá" bỏ wrapper là dựng lại
  nguyên lỗi.
- Giữ **đúng tỷ lệ**: giấy rộng/cao hơn trang thì để dải trắng, **không** kéo méo, **không**
  cắt. Lấp chỗ trắng đó (tự xoay trang ngang) là **tính năng khác**, cố ý chưa làm.
- **Vỡ khi:** in 4 trang ra 8 tờ, tờ chẵn chỉ có một dải mỏng · chọn `1-2` ở hộp thoại hệ
  thống ra hai bản của trang 1 · đổi Khổ giấy sang A3/Letter thì số tờ nhân đôi.
- Lưới: `npm run test:print` (số học khoảng trang, **cắt thẳng từ `app.js`**). Nửa CSS
  **phải** probe: dựng `.print-sheet` với `app.css` thật rồi `printToPDF` từng khổ giấy và
  **đếm tờ** — v0.2.51 chạy 40 ca (5 dạng tài liệu × 8 khổ giấy) + một probe boot
  `index.html` thật lái hộp thoại bằng sự kiện `input` thật. Đọc lại content stream là
  **vô giá trị** ở đây, phải đếm tờ và đếm pixel (cùng bài học của v0.2.50).

### BI-44 · Ô "Trang cần in" để trống = in tất cả, và bản xem trước là bắt buộc
- `app.js` `printPageIndices()` + `syncPrintPages()`; `index.html` `#print-pages` +
  `#print-pages-hint`; lưới `npm run test:print`.
- Ô trống **phải** ra đúng hành vi có từ trước khi có ô này (in cả tài liệu). Hộp thoại
  cũng **reset ô về trống mỗi lần mở** — khoảng trang còn sót của lần in trước sẽ âm thầm
  bỏ trang ở lần này.
- Dùng `window.PageRange.parseSpec`, **không** viết bộ parse thứ hai (BI-27). Kèm theo là
  **nghĩa vụ** hiển thị bản xem trước + khoá nút "In": `parseSpec` cố ý **bỏ qua token rác**
  và **kẹp số vượt trang cuối** thay vì từ chối, nên gõ `99` trên tài liệu 4 trang sẽ in
  trang 4. Có bản xem trước thì đó là tiện; bỏ nó đi thì đó là **in sai trang trong im lặng**.
- `#print-pages-hint` phải nằm trong `SKIP_IDS` (BI-10) — nó bị ghi lại mỗi lần gõ.
- **Chỉ raster những trang được chọn.** Mọi ảnh trang được giữ trong DOM cùng lúc, nên in
  2 trang của tài liệu 400 trang phải tốn 2 trang bộ nhớ, không phải 400. Đây cũng là lý do
  `buildPrintPages` **nhận tham số** và `printDoc` **không** raster trước khi mở hộp thoại.
- **Vỡ khi:** mở hộp thoại In lần thứ hai thì tự nhiên chỉ in vài trang · gõ rác mà vẫn
  bấm In được · đổi VI↔EN thì dòng gợi ý nhảy về text tĩnh.

### BI-45 · Bù xoay trang là chuyện của **primitive**, không phải của “ảnh”
- `editor.js` `drawOneAnnot` + `drawWatermark` (khối chú thích ở đầu `drawAnnots`);
  lưới `npm run test:rotate`.
- `map` = `vp1.convertToPdfPoint`, và viewport scale-1 của pdf.js **đã mang sẵn** góc
  xoay. Nên chia làm hai loại, và ranh giới **không** phải “ảnh / không phải ảnh”:
  1. **Hình học dựng từ các điểm ĐÃ MAP RIÊNG LẺ thì đúng miễn phí** — `drawLine` từng
     đoạn (vẽ tay · thân + đầu mũi tên · thân + gạch đầu dim · nét ✓/✗),
     `drawRectangle` lấy min/max của hai góc đã map (box · tô sáng), `drawEllipse` lấy
     tâm + bán trục từ khoảng đã map (hai bán trục **tự đổi chỗ** theo trang — đúng).
  2. **Thứ nào đưa cho pdf-lib một HỆ TOẠ ĐỘ CỤC BỘ rồi để pdf-lib đặt hệ đó** thì
     **bắt buộc** `rotate: pageRotate(page)`, vì trục cục bộ đang ở không gian **màn
     hình** mà pdf-lib đọc như không gian user. Hôm nay gồm `drawImage` (chữ · ảnh ·
     watermark · PNG nhãn mũi tên/dim) **và `drawSvgPath` (mây · mây tự do)**.
- **Lỗi thật, do người dùng báo 2026-08-04:** v0.2.11 vá đúng ba chỗ `drawImage` và kết
  luận “hình axis-aligned không bị ảnh hưởng” — **đúng lúc đó**. Khoanh mây ra đời
  **sau**, đi qua `drawSvgPath`, và `drawSvgPath` có **option `rotate` riêng** mà không
  ai truyền ⇒ mây bake bị xoay 90/180/270° trên mọi trang có `/Rotate` (tức mọi trang
  “landscape” do xoay), suốt từ khi có mây tới v0.2.52.
- **Đã đo, không suy luận** (pdf.js 3.11.174 + pdf-lib 1.17.1 đang ship): `drawSvgPath`
  áp `translate(x,y)·R(rotate)·scale(1,-1)`, và `R(gócTrang)·scale(1,-1)` **chính là**
  phép biến đổi màn-hình→user mà `convertToPdfPoint` hàm ý, ở **cả bốn** góc. Ở 0° nó là
  ma trận đơn vị ⇒ tài liệu không xoay **không đổi một byte**.
- **Luật:** thêm một primitive vẽ mới vào `drawOneAnnot` thì phải trả lời nó thuộc loại
  1 hay loại 2, **và** thêm kind đó vào `KINDS` của `test/annot-rotate.test.js`. Lớp lỗi
  ở đây là “primitive mới âm thầm không tham gia bù xoay”, nên phòng tuyến duy nhất là
  một lưới đi qua **mọi** kind.
- **Vỡ khi:** khoanh mây / đóng dấu / khoanh vùng trên trang scan nằm ngang → Áp dụng
  xong hình nhảy sang chỗ khác hoặc quay 90°. Trên màn hình **vẫn đúng** (overlay vẽ ở
  không gian màn hình) — chỉ file đã lưu sai, đúng khuôn im lặng của BI-40.
- Lưới: `npm run test:rotate` (96 ca — mỗi kind × 4 góc, so **điểm mực trong content
  stream** quy về không gian màn hình; có **ca canh gác** dựng lại đúng lỗi cũ bằng một
  `drawSvgPath` thiếu `rotate` và đòi nó **phải khác** 0°, nên một lưới xanh mới có
  nghĩa là bù xoay đang thật sự hoạt động).

### BI-46 · Clipboard vật thể sống **ngoài** `ed` — đó chính là tính năng
- `editor.js` `let clip` + `copySelected` / `pasteClip`; lưới `npm run test:cloud`
  (mục `annotBounds` / `translateAnnot` / `unionBounds` / `fitShift` + ca chốt vị trí
  khai báo).
- `reset()` **và** `bakePending()` đều xoá `ed.annots`. Nhét clipboard vào `ed` là
  **bấm “Áp dụng” sẽ xoá clipboard** — đúng cái mà yêu cầu “copy … paste ở trang khác,
  **ngay cả khi đã áp dụng xong**” đòi phải sống sót. Vì thế nó là binding cấp module.
  Không lưu ra đĩa, **không** chia sẻ giữa các tab (mỗi tab một renderer — §2).
- **Giới hạn phải nói ra, đừng đi tìm bug:** chỉ `MANAGED_KINDS` (chữ · ghi chú · mũi
  tên · ảnh · **chữ nhật · elip · mây · mây-vẽ-tay** từ v0.2.61, BI-64) quay lại thành đối
  tượng sống sau khi Lưu. Vẽ tay, tô sáng, che thông tin, đo, ✓/✗ **flatten thành pixel**
  (BI-42) ⇒ đã áp dụng rồi thì **không còn đối tượng để chọn**.
  Cách dùng đúng: copy **trước** khi Áp dụng — clip sống qua bake, đó là điều làm cho
  trình tự đó chạy được. Cho các kind kia round-trip là **tính năng khác** (giá: BI-37/38).
- **Nhóm bị kẹp theo HỘP HỢP (`unionBounds`), không kẹp từng mục**: kẹp riêng lẻ sẽ
  **xé nhóm** — mục sát mép trượt còn mục bên cạnh đứng yên ⇒ dán một bản vẽ sang trang
  nhỏ hơn là nó rời ra. Một `fitShift` cho cả nhóm, cùng một delta cho mọi thành viên.
- Chọn nhiều là **trong MỘT trang** (`toggleSelect`). Không phải hạn chế tạm: chính nó
  giữ cho một cú kéo nhóm chỉ cần **một** `renderLayer` mỗi mousemove, và cho
  copy/delete được phép giả định một trang.
- `ed.selMore` là **tập phụ**, `ed.sel` vẫn là “mục chính” với nghĩa cũ — có ~30 chỗ đọc
  `ed.sel` và tất cả đều muốn **đúng một** đối tượng. Tay nắm đổi cỡ (`gripsFor`) chỉ vẽ
  khi chọn **một** mục: `resizeRect`/`snapLineEnd` mỗi hàm chỉ biết một annot.
- Ctrl+C đi bằng **sự kiện DOM `copy`** + đường dự phòng `keydown`, Ctrl+V **chỉ** bằng
  sự kiện DOM `paste`: menu Edit của `main.js` dùng `role: "copy"`/`role: "paste"` (và
  **không** đặt `registerAccelerator: false` như các mục lân cận), nên phím tắt do menu
  chiếm và cái nó gây ra là `webContents.copy()/paste()` → sinh **sự kiện DOM**. Đó cũng
  là đường `capture.js` đã dùng để dán ảnh từ clipboard hệ điều hành nhiều bản nay.
  **Paste không có đường dự phòng keydown** — bắn hai lần là dán ra hai vật thể.
- **Bàn giao gesture:** clipboard hệ điều hành **có ảnh** thì Ctrl+V vẫn thuộc
  `capture.js` (handler của editor rút lui, không `preventDefault`). Bấm phải mà **không
  chọn gì và clipboard vật thể rỗng** thì cũng rút lui ⇒ menu ảnh cũ hiện y như trước.
  Hai tính năng không che nhau, ở cả hai thứ tự.
- **Vỡ khi:** copy xong bấm Áp dụng rồi Ctrl+V không ra gì · dán nhóm sang trang khác
  thì các mục rời rạc ra · Ctrl+V dán ảnh hệ điều hành không còn chạy · chọn 3 mục rồi
  đổi màu chỉ 1 mục đổi · Esc giữa lúc kéo nhóm chỉ 1 mục về chỗ cũ.

### BI-47 · Phím tắt phải nhường cho modal — `isTyping()` **không** đủ
- `app.js` `modalOpen()` + hai chỗ gọi trong `window keydown`; `editor.js` chốt ngay đầu
  `window keydown`.
- `isTyping()` chỉ đúng khi focus nằm trên **INPUT / TEXTAREA / SELECT**. Focus nằm trên
  **nút** của hộp thoại, hay trên một khung cuộn được (`#help-doc` có `tabindex="0"`), thì
  `isTyping()` = **false** và phím rơi xuống tài liệu phía sau:
  - `Delete` → `deleteSelected()` của `app.js` **xoá thật các trang đang tick**, hoặc
    `deleteSelected()` của editor **xoá annotation đang chọn** — không dấu vết, không hỏi.
  - chữ cái đơn → đổi công cụ chú thích sau lưng hộp thoại (`TOOL_KEYS`).
  - `↑`/`↓`/`PageUp`/`PageDown` → `preventDefault()` chặn cuộn của **chính hộp thoại** rồi
    **nhảy trang tài liệu** thay vì cuộn nội dung đang đọc.
  - `Esc` → huỷ polygon đang vẽ dở thay vì đóng hộp thoại.
- Lỗ này **có sẵn từ trước** cho Watermark / Điền form / Áp nhiều trang / Hiệu chuẩn; nó chỉ
  lộ ra khi trang **Hướng dẫn sử dụng** (v0.2.53) mở được **ngay trong lúc đang Chú thích**
  và mang theo cả một vùng văn bản dài phải cuộn được.
- **Bỏ hết phím ở cấp window khi có modal là an toàn — đã kiểm:** cả 4 modal của editor
  (`wm-modal`, `dim-modal`, `imgpages-modal`, `form-modal`) đều có nút **Hủy** riêng, và các
  ô nhập của chúng gắn `keydown` **thẳng lên input**, nên không cái nào phụ thuộc handler
  cấp window.
- **Luật:** thêm phím tắt toàn cục nào thì kiểm **cả** `isTyping()` **và** `modalOpen()`.
  Thêm hộp thoại mới thì nó **phải** dùng đúng class `.modal` — `modalOpen()`, chốt
  Esc-thoát-toàn-màn-hình và mọi chốt trên đều nhận diện qua class đó, không qua id.
- **Vỡ khi:** mở một hộp thoại, bấm một **nút** trong đó (không phải ô nhập), rồi bấm
  `Delete` → trang/annotation phía sau biến mất · hoặc `↓` trong trang Hướng dẫn làm nhảy
  trang tài liệu thay vì cuộn hướng dẫn.

### BI-48 · Đóng hộp thoại phải **BẤM HỘ nút Hủy**, không được set `hidden` thẳng
- `app.js` `dismissModal()` / `topOpenModal()` (ngay dưới `modalOpen()`), ba chỗ gọi:
  `Esc` (window, bubble), bấm nền (`document mousedown`), nút `.modal-x` (uỷ quyền click).
- Nhiều hộp thoại **hình dạng Promise**: `promptPassword()` và `askInsertPos()` chỉ
  `resolve()` **trong hàm `done()` của nút Hủy**; `closePrintModal()` và `closeDialog()`
  của `sign.js` còn dọn state riêng. Ẩn phần tử sau lưng chúng thì hộp thoại **biến mất
  khỏi màn hình nhưng `await` treo vĩnh viễn** — không lỗi, không dấu vết, và người dùng
  chỉ thấy "app đơ" ở lần thao tác tiếp theo. Vì thế `dismissModal` gọi `btn.click()`.
- **Hợp đồng markup:** mỗi `.modal` (trừ `data-modal-manual`) phải có **đúng một**
  `[data-modal-close]` **và một** `.modal-x`. Thêm hộp thoại mới mà quên → `Esc` im lặng
  không làm gì. Probe boot đếm cả hai (`dialogs_without_close` / `dialogs_without_x` phải
  rỗng), đó là lưới duy nhất bắt được thiếu sót này.
- **`stopImmediatePropagation`, không phải `stopPropagation`:** handler `Esc` này và
  handler phím tắt lớn **nằm cùng trên `window`**, mà `stopPropagation` không chặn listener
  anh em trên **cùng một node**. Thiếu nó thì `Esc` đóng hộp thoại **rồi thoát luôn toàn
  màn hình**, vì chốt `!modalOpen()` của handler kia lúc đó đã thành true. Kéo theo: khối
  này **phải khai TRƯỚC** `window keydown` lớn trong `app.js` — đổi chỗ là hỏng.
- `#help-modal` là **ngoại lệ duy nhất**, đánh dấu `data-modal-manual`: `help.js` tự giữ
  `Esc` (bấm lần đầu xoá từ khoá tìm, lần hai mới đóng) và tự giữ bấm-nền.
- **Vỡ khi:** mở PDF có mật khẩu → bấm nền để đóng ô nhập mật khẩu → mở file khác:
  không có gì xảy ra (promise cũ còn treo) · hoặc `Esc` trong lúc F11 làm mất cả hộp
  thoại lẫn chế độ toàn màn hình.

### BI-49 · Payload PDF **lớn** phải đi đường nhị phân, không phải base64-trong-JSON
- `api.py` `/compress-bin` + `_compress_pdf_bytes()`; `app.js` `runCompress()`.
- Đường JSON tốn ~5 lần cỡ file ở đỉnh (base64 trên dây → `str` lúc parse JSON → bytes
  giải mã → bản sao của fitz → base64 trả về). Đó là lý do có `_MAX_PDF_B64` (~200MB), và
  cũng là lý do **"nén" từ chối đúng những file đáng nén nhất**. Đường nhị phân chở
  **chính bytes** cả hai chiều nên có trần riêng `_MAX_PDF_BIN` (1GB).
- **Hợp đồng nhận biết:** thành công = `Content-Type: application/pdf` (body là PDF);
  thất bại = JSON. Client phân biệt bằng content-type, **không** bằng mã HTTP. Giống hệt
  `/edit-text?raw=1`. Đổi bên nào cũng phải đổi bên kia.
- **Header X-\* phải nằm trong `expose_headers` của CORS.** Origin của renderer là
  `file://` ⇒ mọi lệnh gọi là cross-origin ⇒ JS chỉ đọc được header nào được liệt kê. Thiếu
  thì `res.headers.get("X-Original-Size")` trả `null` **không kèm lỗi ở đâu cả**.
  `runCompress` cố ý **không** đọc chúng (tự tính từ `state.bytes.length` và
  `buf.byteLength`) — nhưng danh sách vẫn phải đúng cho người viết code sau.
- **Hai route dùng CHUNG `_compress_pdf_bytes`** để không bao giờ lệch nhau về "nén là
  làm gì"; `test_compress_bin_matches_json_route` là lưới canh đúng chỗ đó.
- **Vỡ khi:** nén file 300MB báo "PDF quá lớn" · hoặc nén xong hiện "Đã nén: 0 B → 0 B".

### BI-54 · Nén file lớn phải chạy ở TIẾN TRÌNH RIÊNG — thread không cứu được
_Ghi 2026-08-12, từ `docs/REVIEW-caps-2026-08-12.md`. Sửa ở `api.py`
(`_compress_worker_cmd`, `_compress_via_worker_blocking`, `_COMPRESS_WORKER_MIN_BYTES`)
+ `sidecar.py` (`--compress-worker`, `_err`)._

- **Vấn đề, đo được:** mọi route trong `api.py` là `async def`, nên một lệnh PyMuPDF đồng
  bộ chiếm trọn **một** event loop — mà app dùng **một** sidecar cho **mọi tab và cửa sổ**.
  Nén 30 trang làm `/health` **không trả lời 13.088 ms**; ở trần 3000 trang (0,377 s/trang)
  là **~19 phút** mọi tab khác treo theo.
- **Ba lý do khiến thread KHÔNG phải lời giải** — ghi lại để không ai mất buổi chiều tìm
  lại: (1) `doc.rewrite_images()` chiếm **98,9%** thời gian và **giữ GIL suốt** — thread
  quan sát chạy được **0,1%** thời gian và không xong nổi một vòng lặp cho tới khi nén
  xong; (2) nó là **một** lệnh mức document, **không có tham số khoảng trang**, nên không
  cắt nhỏ để chèn `await` được; (3) PyMuPDF gọi `mupdf.reinit_singlethreaded()` **lúc
  import**, bỏ khoá nội bộ của MuPDF — chạy hai thread cùng lúc không chỉ vô ích mà **không
  an toàn**. Tiến trình con có GIL riêng và context MuPDF riêng; cha chờ bằng `subprocess`
  trong thread, mà **chờ tiến trình thì nhả GIL**. Kết quả đo lại: **32 ms**, bằng lúc rảnh.
- **Worker là CHÍNH chương trình này chạy lại** với `--compress-worker` (`sidecar.py`), nên
  không có nhị phân thứ hai phải build/ký/ship. `sys.executable` là `sidecar.exe` khi
  frozen, là python của venv khi dev ⇒ **hai dạng argv khác nhau**, có lưới canh
  (`test_compress_worker_command_shape`).
- **Hợp đồng mã thoát: 0 = xong · 3 = lỗi của người gọi (stderr là câu tiếng Việt cho người
  dùng, map thành HTTP 400) · 1 = hỏng bên trong.** Đổi một đầu phải đổi đầu kia.
- **stderr của worker phải ghi UTF-8 tường minh** (`_err`). Đây là **lỗi thật đã bắt được
  lúc làm**: `sys.stderr.write` trong tiến trình con mã hoá theo **codepage console**
  (cp1258/cp1252 trên Windows) còn cha giải mã UTF-8 ⇒ "preset phải là…" đến tay người dùng
  thành rác. `test_compress_worker_reports_caller_errors_as_400` so **đúng từng ký tự**.
- **Có ngưỡng, và ngưỡng là cố ý.** Khởi động worker tốn một lần `import api` (đo 2,1 s ở
  dev, hơn nữa khi frozen). Dưới `_COMPRESS_WORKER_MIN_BYTES` (25 MB) thì nén tại chỗ —
  đo được **0,00 s** cho file nhỏ; bật worker ở đó chỉ là phí thuần.
- **Không được để mất TÍNH NĂNG vì worker.** Nếu không khởi chạy được (thiếu script, hết
  chỗ temp, máy bị khoá), route bắt `OSError` và **quay về nén tại chỗ** — tức đúng hành vi
  trước khi có worker, chậm nhưng không hỏng.
- **Đường JSON `/compress` KHÔNG đổi** — nó chỉ phục vụ lưới test; hai đường vẫn dùng chung
  `_compress_pdf_bytes` (BI-49).
- **Chỉ Nén được chuyển ra ngoài, không phải mọi thứ.** Dựng index của Tìm nhả GIL ~45% và
  chỉ mất ~1,8 s cho 600 trang, không đáng đổi rủi ro. Và vì `reinit_singlethreaded`, đưa
  **bất kỳ** việc PyMuPDF nào sang thread sẽ khiến nó chạy song song với việc PyMuPDF đang
  chạy trên event loop ⇒ **không được làm** nếu chưa đặt toàn bộ sau cùng một khoá.
- **Ước tính thời gian tính theo BYTE, không theo TRANG** (`compressEta`, `app.js`). Đo
  trên ba loại tài liệu — scan toàn ảnh, 600 trang chữ, bản vẽ vector kiểu CAD khổ A0 —
  **giây/MB** trải 0,098–0,189 (**2 lần**) còn **giây/trang** trải 0,001–0,439 (**439
  lần**). Ước tính theo trang sẽ sai **hai bậc độ lớn** với loại tài liệu nó không được
  hiệu chuẩn. Và phải **theo preset**: `lossless` bỏ hẳn `rewrite_images` (98,9% công
  việc) nên nhanh hơn ~50 lần — đo trên một file 57,8 MB: screen 0,047 · ebook 0,155 ·
  printer 0,179 · lossless 0,003 s/MB. Ngưỡng worker là một **bậc thang** cộng thêm
  (~3 s), không phải độ dốc. Lưới `npm run test:geom` so lại với chính các số đo này, và
  so **xuyên ngôn ngữ** `COMPRESS_WORKER_MIN_BYTES` (JS) với `_COMPRESS_WORKER_MIN_BYTES`
  (api.py) — lệch nhau thì ước tính sai âm thầm.
- **Hỏi lại trước khi nén tài liệu rất lớn, và hỏi TRƯỚC `bakePending()`.** Đỉnh bộ nhớ cả
  chuỗi ≈ **4 lần cỡ file** (bytes ở renderer + bản sao Blob + body ở sidecar + bản của
  worker), nên 300 MB là ~1,2 GB rải trên ba tiến trình — chỗ máy 8 GB bắt đầu đuối. Đây là
  **cảnh báo, không phải từ chối**: trần cứng `_MAX_PDF_BIN` = 1 GB vẫn giữ làm chốt chặn
  đầu vào vô lý, còn giới hạn thật là **máy**, không phải định dạng. Thứ tự bắt buộc: hỏi
  **trước** `Editor.bakePending()`, vì bake ghi chú thích vào tài liệu — bake trước rồi
  người dùng bấm Hủy là để lại một file đã bị sửa và bẩn.
- **`#cmp-eta` phải nằm trong `SKIP_IDS`** — nó là số liệu sống, đổi ngôn ngữ mà quét trúng
  thì đè mất (BI-10). Sáu chuỗi `t()` của khối này **không** nằm trong markup tĩnh nên
  không được i18n quét tự động; lưới `test:geom` liệt kê đích danh cả sáu.
- **Vỡ khi:** nén file lớn mà tab khác vẫn treo · hoặc preset sai báo lỗi bằng ký tự rác ·
  hoặc nén file nhỏ bỗng mất 3 giây · hoặc bản **đóng gói** nén xong không ra file (argv
  frozen sai) · hoặc nháy cửa sổ console đen mỗi lần nén (thiếu `CREATE_NO_WINDOW`) · hoặc
  đổi mức nén mà dòng ước tính đứng im · hoặc bấm Hủy ở hộp cảnh báo mà tài liệu đã bị bẩn.

### BI-50 · Tìm & Thay thế: mọi hit là offset của MỘT phiên bản bytes — bytes đổi thì list là hư cấu
- `renderer/find-replace.js` (`invalidate`, `applyEdits`, `indexAtOrAfter`, `groupEdits`);
  hai chỗ móc trong `app.js`: cuối `renderAll()` và cuối `rerenderChanged()`.
- Mỗi hit mang `page` + `start/end` **đo trên đúng một bản** tài liệu. Bất cứ thứ gì đổi
  bytes — chính thao tác Thay, `Ctrl+Z`, xoay trang, **xoá trang**, bake watermark — làm
  cả list sai: offset dịch, và sau khi xoá trang thì `page` trỏ sang **trang khác hẳn**,
  nên vệt tô nằm trên chữ vô can và bấm **Thay** sẽ **ghi đè đúng chữ vô can đó**.
- **Vì thế `invalidate()` móc vào hai HÀM PHỄU** (`renderAll` / `rerenderChanged`) chứ
  không vào từng chỗ gọi — thêm một thao tác sửa tài liệu mới thì nó tự được che.
  `applyEdits` bật cờ `fr.suppress` để phễu không quét chồng lên lần quét có neo của nó.
- **Sau mỗi lần ghi là QUÉT LẠI, không sửa list tại chỗ.** Một lần ghi làm hỏng ba thứ
  cùng lúc: các hit khác **trong cùng span** dịch offset, hit cross-span **đè lên span
  đó** thành rác, và **chính chữ vừa thay có thể chứa từ khoá**. Quét lại giết cả ba;
  neo (`indexAtOrAfter`) đặt **ngay sau** chữ vừa chèn nên "hợp đồng → phụ lục hợp đồng"
  không mời lại vô hạn.
- **Nhiều hit trong CÙNG một span phải gộp thành MỘT edit** (`groupEdits`). `/edit-text`
  redact hộp span rồi vẽ lại từ `new_text`; hai edit rời trên cùng span thì cái sau dựng
  lại từ **text gốc** và **xoá kết quả của cái trước** — mà toast vẫn báo "đã thay 2".
- **Không có endpoint ghi riêng.** Thay thế đi qua `/edit-text` với **đúng payload
  text-edit.js gửi** (kể cả `orig_text`/`orig_size` — BI-25, và `font` là tên font gốc —
  BI-21). Sidecar chỉ thêm endpoint **đọc** `/text-find`.
- **Cố ý KHÔNG fold dấu**, khác `Ctrl+F`: gõ "hop dong" **không** ra "hợp đồng". Fold
  đúng cho việc đọc, sai cho việc ghi — thay một kết quả fold là **xoá dấu** trong hợp
  đồng của người dùng. Hệ quả chấp nhận: hai ô tìm cho số khác nhau.
- **Khớp cắt qua 2 span thì ĐẾM và TÔ, không thay** (`replaceable: false`, vàng nét đứt).
  Bỏ im lặng sẽ bị đọc là "app tìm sót".
- **Panel không phải `.modal`** — cố ý, vì phải đọc trang phía sau khi duyệt. Nên nó
  **nằm ngoài** mọi thứ `modalOpen()` quản, và ô nhập tự giữ `Esc` của mình.
  `placePanel()` đặt `top` theo mép trên của `main`: hàng 1 thanh công cụ **rewrap**
  (đo được 57px ở 1920 → 98px ở 1366) nên mọi hằng số CSS đều sai ở một bề rộng nào đó.
- **Vỡ khi:** tìm xong → xoá một trang → vệt tô vẫn còn và bấm Thay ghi nhầm chỗ · hoặc
  "Thay tất cả" báo N nhưng mở lại file thấy vài chỗ chưa đổi (lỗi gộp span) · hoặc bấm
  Thay mãi không hết vì chữ thay chứa từ khoá.

### BI-51 · Tìm & Thay thế: quét là hành động NGƯỜI DÙNG YÊU CẦU, và thông báo lỗi không được bị đè
- `renderer/find-replace.js` (`runFind`, `refreshStatus`, `setSticky`, `markStale`,
  `setBusy`, `syncButtons`); nút `#fr-go` trong `index.html`. Lưới `npm run test:find`.
- **Một lần quét = một lượt đi hết tài liệu.** base64 cả PDF → sidecar mở lại →
  `get_text("dict")` **mọi trang**. Vài mili-giây với hợp đồng 3 trang, **vài chục giây**
  với bộ bản vẽ A1 480 trang. Vì thế **KHÔNG quét theo từng ký tự gõ** (v0.2.55 có
  debounce 350ms — gõ "2026" là **bốn** lượt đi hết tài liệu, và chúng **đua nhau**).
  Gõ chỉ đặt cờ `stale`; **Enter / nút Tìm** mới là lệnh quét.
- **`stale` khoá GHI, không khoá ĐỌC.** Vệt tô cũ vẫn đúng với bytes hiện tại (BI-50) nên
  cứ để, ↑↓ vẫn duyệt được — nhưng hai nút **Thay** phải tắt, vì thay theo hit của **từ
  khoá cũ** bằng **chữ thay mới** là ghi nhầm chỗ trong im lặng.
- **`fr.sticky` phải thắng số đếm trong `refreshStatus()`.** Đây là lỗi thật của v0.2.55:
  `runFind` ghi câu lỗi rồi `finally { setBusy(false) }` → `refreshStatus()` → **đè ngay
  lập tức** bằng "Không tìm thấy kết quả nào.". Hệ quả: **mọi** thất bại — 400 "PDF quá
  lớn", PDF là bản scan, mất kết nối sidecar, chạm trần `max_hits` — đều đến tay người
  dùng dưới dạng "không tìm thấy", tức là **báo sai nguyên nhân**. Bốn câu bắt buộc đi
  qua `setSticky()`, không phải `setStatus()`.
- **Ô `#fr-find` khi bận: `readOnly`, KHÔNG `disabled`.** `disabled` làm rơi phím và mất
  focus → ký tự gõ trong lúc quét biến mất. Ngược lại `#fr-case`/`#fr-word` **phải** nằm
  trong danh sách `setBusy` — thiếu chúng thì tick giữa lúc quét đẻ ra lượt quét thứ hai.
- **Mỗi lượt quét mang số thế hệ (`fr.runSeq`) + `AbortController`.** Lượt bị thay thế
  không được vẽ, không được gỡ cờ bận. Đóng panel cũng huỷ lượt đang chạy.
- **Trần payload phải khớp hai phía.** `MAX_B64` trong renderer = `_MAX_PDF_B64` trong
  `src/pdf/util.py`; lưới so **xuyên ngôn ngữ** hai hằng số này. Chặn ở renderer để khỏi
  mất vài giây dựng chuỗi base64 ~280MB cho một request chắc chắn bị từ chối.
- **Vỡ khi:** gõ vào ô Tìm mà app đứng hình vài chục giây · hoặc file >200MB báo "không
  tìm thấy" thay vì "PDF quá lớn" · hoặc file scan báo "không tìm thấy" thay vì nhắc OCR ·
  hoặc đổi từ khoá rồi bấm Thay và nó thay theo từ khoá cũ.

### BI-52 · /text-find: khớp MỘT lần trên DÒNG, hai trần khác nhau, cache khoá bằng toàn bộ bytes
- `api.py` (`_find_build_index`, `_find_index_for`, `_find_scan_index`, `_text_find_core`,
  `/text-find`, `/text-find-bin`); `renderer/find-replace.js` (`MAX_FIND_BIN`,
  `MAX_EDIT_B64`, `overWriteLimit`). Lưới `.venv\Scripts\python test_text_find.py` +
  `npm run test:find`.
- **Biên "Đúng nguyên từ" tính trên DÒNG ghép, không trên span.** Bản cũ khớp hai lượt
  (trong span + trên dòng) nên dòng vẽ thành `["AB","2026"]` báo `2026` là nguyên từ
  (đúng là nó đứng đầu *span* của nó) **và cho thay** ⇒ **hỏng chữ `AB2026`**. Ghi sai
  trong im lặng. Khớp một lượt trên `joined` rồi ánh xạ ngược ra span cho biên đúng, và
  ít code hơn hẳn dạng hai lượt.
- **Span toàn khoảng trắng GIỮ text trong `joined`, nhưng không bao giờ nhận lệnh ghi.**
  PyMuPDF đẻ ra span `' '` thật mỗi khi một dòng được vẽ làm nhiều mẩu (bước nhảy Td/TJ —
  rất hay gặp ở văn bản canh đều/xuất từ CAD). Vứt nó đi làm dòng ghép thành `"Hợpđồng"`
  nên **không tìm ra "Hợp đồng"**. Cờ `host=False` giữ chữ mà chặn ghi.
- **ĐO ĐƯỢC, đừng đoán:** PyMuPDF **tự gộp** span cùng style vẽ liền nhau, nên "202"+"6"
  cùng style **không** tách. Tách span nghĩa là style **thật sự** khác — lệch cỡ chữ
  **0.0001pt cũng đủ**. Vì vậy "gộp lại span cùng style" là việc **không có gì để làm**;
  mọi chỗ tách đều đi nhánh `replaceable=False` (BI-50).
- **HAI trần, khác nhau, và renderer phải soi gương cả hai.** Đọc đi `/text-find-bin`
  (body **là** file PDF) → trần `_MAX_PDF_BIN` = 1GB. Ghi vẫn đi `/edit-text` (request là
  base64 JSON) → trần `_MAX_PDF_B64` ≈ 200MB. Nên tài liệu 300MB **tìm được nhưng chưa
  thay được**, và UI phải **nói thẳng** (mờ hai nút Thay + ghi lý do trên dòng đếm) chứ
  không để người dùng bấm Thay rồi nhận lỗi. Lưới so **xuyên ngôn ngữ** cả hai hằng số.
- **Cache index span khoá bằng blake2b của TOÀN BỘ bytes.** Khoá bằng độ dài + vài mẩu
  lấy mẫu là sai chết người: sửa ở giữa file vẫn trùng khoá ⇒ dùng lại index ôi thiu ⇒
  **mọi offset trỏ sai chỗ** — đúng kiểu vỡ của BI-50 nhìn từ phía kia. Cache giữ **một**
  tài liệu, đổi bằng **một tuple** `(key, pages)` để đọc song song không bao giờ ghép
  khoá mới với index cũ. Có trần `_FIND_CACHE_MAX_PARTS` để file bệnh hoạn không ghim
  hàng trăm MB trong sidecar.
- **Bộ cứu font legacy phải giống hệt `/text-spans`.** Thiếu nó thì "Sửa nội dung" hiện
  đúng chữ TCVN3 còn Tìm bảo không có — hai tính năng bất đồng về việc trang giấy ghi gì.
- **Trần cache là con số ĐO ĐƯỢC, không phải số cho đẹp** (sửa 2026-08-12). Một span
  phẳng tốn **~1.5 KB** khi tính đủ hai tuple hộp, origin, text và tên font — đo trên PDF
  600 trang chữ thật: **27.000 span → +41 MB RSS**. Giá trị đầu tiên là `300_000`, tức
  cho phép **~450 MB** — đúng cái "hàng trăm MB" mà trần này sinh ra để ngăn. Nay
  `_FIND_CACHE_MAX_PARTS = 80_000` (≈100 MB). Không tài liệu nào bị **từ chối**: vượt trần
  thì chỉ là lần tìm sau parse lại. Cache **không** được thả khi đóng panel/tài liệu/tab —
  nó chỉ bị thay khi index một tài liệu khác, nên trần là thứ duy nhất chặn nó.
- **Hit cắt-qua-span phải mang HAI hộp khác nhau** (sửa 2026-08-12). `bbox` theo hợp đồng
  là hộp **chưa xoay** (chính là hình chữ nhật `/edit-text` sẽ redact), `bbox_view` là hộp
  **hiển thị**. Bản đầu dựng **một** union từ `parts[i][3]` (đã xoay) rồi chép vào cả hai
  ⇒ `bbox` nói dối trên trang có `/Rotate`. Vô hại **chỉ chừng nào** loại hit này còn
  `replaceable=False`; ngày ai đó gỡ hạn chế đó thì `/edit-text` redact **sai hình chữ
  nhật**, im lặng, và chỉ trên trang xoay. Nay hai union riêng (`parts[i][2]` và
  `parts[i][3]`); trên trang **không** xoay `rotation_matrix` là đơn vị nên hai hộp trùng
  nhau — đó là lý do phép sửa này không đổi gì với tài liệu thường. Lưới: `R10c`/`R10d`.
- **Vỡ khi:** tìm "Hợp đồng" trong văn bản canh đều ra 0 kết quả · hoặc tick "Đúng nguyên
  từ" rồi Thay làm hỏng chữ dính liền · hoặc sửa tài liệu xong tìm lại vẫn ra kết quả cũ
  (cache ôi thiu) · hoặc file 300MB tìm được nhưng bấm Thay ra lỗi khó hiểu.

### BI-53 · Câu xác nhận không được HỨA nhiều hơn thứ đã quét; sidecar chết phải nói ra
_Ghi 2026-08-12, từ đợt rà soát hệ quả của việc nâng trần (`docs/REVIEW-caps-2026-08-12.md`)._

- **"Thay tất cả" chỉ được nói "toàn bộ tài liệu" khi lượt quét đã đi hết.**
  `renderer/find-replace.js` (`fr.truncated`, `fr.truncatedPage`, `replaceAll`).
  `/text-find` dừng ở `max_hits` = 5000 — **đo được**: một từ khoá phổ biến trên file 600
  trang dừng ở **trang 28**, tức 5% tài liệu. Hộp xác nhận là **chỗ duy nhất** nói cho
  người dùng biết thao tác này bao trùm cái gì, nên câu "trong toàn bộ tài liệu" ở đó biến
  đúng hộp thoại sinh ra để chặn bất ngờ thành thứ **gây** bất ngờ: thay 5000 trong số
  nhiều hơn thế, được báo "đã xong", phần còn lại nằm im. Cờ **phải nằm trên `fr`** —
  `replaceAll` không đọc được chuỗi trong `fr.sticky`. Đặt lại **ở đầu** `runFind`, trước
  request: mọi nhánh return sớm (rỗng, quá lớn, lỗi mạng) nếu không sẽ để cờ của lượt
  trước đứng lại sau lưng lần "Thay tất cả" kế tiếp.
- **Sidecar chết đột ngột phải đẩy `state: "error"` ra renderer.**
  `desktop/src/sidecar.js` (`startSidecar(token, onExit)`, cờ `handle.stopping`) +
  `main.js` (`bootSidecar`). Trước đây `child.on("exit")` chỉ `console.log`, còn
  `sidecarState` chỉ được ghi **một lần** từ promise lúc khởi động ⇒ sau khi sidecar chết,
  badge vẫn "OCR: sẵn sàng", mọi nút engine vẫn sáng, mỗi lần bấm là một lỗi `fetch` trần,
  và cách chữa duy nhất là khởi động lại app — **không có gì trên màn hình gợi ý điều đó**.
  Renderer **đã** xử lý sẵn `state:"error"` (badge đỏ + `updateToolbar` làm mờ); nó chỉ
  chưa bao giờ được báo. Trần mới (1 GB, 3000 trang, index cả tài liệu) làm ca OOM-kill
  thành chuyện có thật chứ không còn lý thuyết.
- **Nửa khó là nửa thứ hai: tắt CÓ CHỦ Ý phải im lặng.** `stopSidecar` chạy lúc thoát app
  và lúc "khởi động lại engine", mà sự kiện `exit` của đứa cũ đến **không đồng bộ** — có
  thể sau khi đứa thay thế đã chạy. Bắn callback ở đó là vẽ "Engine đã dừng đột ngột" đè
  lên một sidecar hoàn toàn khoẻ mạnh. Vì thế có cờ `handle.stopping` (đặt **trước** khi
  kill), **và** thêm một lớp chốt ở `main.js`: `if (sidecar !== handle) return`.
- **Vỡ khi:** bấm "Thay tất cả" trên tài liệu lớn, được báo "đã thay xong" mà mở ra vẫn còn
  hàng nghìn chỗ chưa đổi · hoặc kill `sidecar.exe` mà badge vẫn xanh và nút vẫn bấm được ·
  hoặc "khởi động lại engine" xong badge lại đỏ dù engine mới đang chạy.

---

### BI-55 · Một renderer không bao giờ được biết định danh của renderer khác
_Ghi 2026-08-12, cùng đợt "kéo trang sang tài liệu khác" (`docs/SPEC-page-drag.md`)._

- **Main là router duy nhất.** `desktop/src/main.js` (`routePages`, `askRenderer`) +
  `src/tabs.js` (`pageTargetTabs`). Đường đi của một cú chuyển trang là
  `nguồn → main → đích → main → nguồn`, và `webContents` của đích **không bao giờ** rời khỏi
  `main.js`. Renderer chỉ được phép nói hai thứ: "có trang ở toạ độ này" (main tự tra cửa sổ
  nào đang ở đó) hoặc một `tabId` **do chính main phát ra** trong `pages:targets`.
- **Vì sao là bất biến, không phải sở thích:** mỗi tab là một renderer chạy PDF của người
  dùng. Cho tab A gọi tên tab B là mở đường cho A **đọc tài liệu của B** — và một PDF độc
  hại chỉ cần thắng đúng một renderer là đủ. Trả lời của renderer cũng chỉ được nhận từ
  **đúng webContents đã được hỏi** (`pageReqs` giữ `wc`, `pages:reply` so trước khi resolve).
- **Vỡ khi:** thêm một channel nhận `docId`/`tabId` do renderer tự khai rồi lấy bytes theo
  đó · hoặc gửi `wc`/`webContentsId` xuống renderer cho "tiện".

### BI-56 · Chuyển trang = CHÈN, XÁC NHẬN, rồi mới XOÁ — không bao giờ đổi thứ tự
_Ghi 2026-08-12._

- `desktop/renderer/page-move.js` (`dragEnd` → `const moved = !!shift && res.ok && unchanged(fp)`
  → `if (moved) await deletePages(indices)`), `answerReceive` (`inserted = state.numPages - before`).
  Đích chỉ trả `ok: true` khi tài liệu **thật sự dài ra** — không phải khi `insertBuffersAt`
  trả về, vì hàm đó **return im lặng** khi bị cổng bản quyền chặn hoặc khi không có bytes.
- **Kịch bản hỏng phải là "trang nhân đôi", không phải "trang biến mất".** Nhân đôi thì thấy
  được và `Ctrl+Z` được; biến mất là mất việc của người dùng. Mọi timeout, mọi renderer chết
  giữa đường đều rơi về phía nhân đôi vì nguồn **chưa xoá gì**.
- **Nửa dễ bỏ sót:** `unchanged(fp)`. Chỉ số trang được đo lúc bắt đầu kéo; nếu tài liệu
  nguồn đổi trong lúc chuyển (người dùng bấm Ctrl+Z, xoá trang khác…) thì những chỉ số đó
  **trỏ sang trang khác** — xoá theo là xoá đúng thứ người dùng không hề nhắm tới. Dấu vân
  tay là `docId + numPages + bytes.length`.
- **Vỡ khi:** kéo Shift một trang sang cửa sổ khác rồi đóng cửa sổ đích ngay giữa lúc chèn,
  mà trang ở nguồn vẫn mất · hoặc nút "Xoá khỏi bản gốc" xoá sai trang sau khi đã Ctrl+Z.

### BI-57 · Điểm thả nằm trong cửa sổ NGUỒN ⇒ luôn là đường sắp xếp cũ
_Ghi 2026-08-12._

- `desktop/src/tabs.js` (`classifyPageDrop`: `if (src && inside(src.rect)) return { action: "self" }`
  — **trước** vòng quét mọi cửa sổ khác, và **bất chấp** `z`). Đường liên tài liệu chỉ được
  chen vào khi cú thả **không** rơi vào cửa sổ đã bắt đầu nó.
- Kéo–thả sắp xếp trang trong cùng tài liệu đã phát hành từ v0.2.41 và là thao tác dùng hằng
  ngày; tính năng mới **thêm việc** ở `dragstart`/`dragend` chứ không sửa việc cũ. Với cú kéo
  nội bộ, main trả về `self` và **không có một byte IPC nào** được gửi đi, không cue nào được
  vẽ ở đâu.
- Chú ý ca "cửa sổ nguồn bị cửa sổ khác che": vẫn là `self`. Nhường cho `z` ở đây là biến một
  cú sắp xếp bình thường thành gửi trang sang tài liệu khác. Có test: `npm run test:pagedrop`.
- **Vỡ khi:** kéo sắp xếp trang trong một cửa sổ đang bị cửa sổ khác chồng lên, mà trang lại
  bay sang tài liệu kia.

### BI-58 · Vòng đọc con trỏ phải có watchdog, và cue không được sống lâu hơn phiên kéo
_Ghi 2026-08-12._

- `desktop/src/main.js` (`pageDrag`, `PAGE_DRAG_MAX_MS`, `stopPageDrag`, `endPageHover`).
  Main **bám con trỏ bằng `setInterval`** trong lúc kéo, vì `event.screenX/screenY` từ trong
  một `WebContentsView` lệch theo khung cửa sổ (`docs/TABS-2B-DESIGN.md` §2.3) nên toạ độ của
  renderer không dùng được. Cái giá là một timer — và một timer thì phải có đường chết chắc
  chắn: `dragend` (đường thường) **và** watchdog 30s (đường `dragend` không bao giờ tới).
- **`hover-end` bắn SAU khi chèn xong, không phải trước.** Ở `pages:drag-end`, timer bị dừng
  ngay nhưng cue **để nguyên**, và `stopPageDrag()` nằm trong `finally`. Hạ cue trước khi chèn
  làm cửa sổ đích nháy — và nếu cột trang của nó vừa được **tự bung** ra để nhận thì nó sập
  lại rồi mở ra lần nữa.
- Tự bung cột trang phải **trả lại trạng thái cũ** khi phiên kéo không thả vào đó
  (`renderer/page-move.js`: `springOpened`, `settleSpring`). Người dùng cố ý thu gọn cột thì
  một cú kéo đi ngang **không được** đổi bố cục của họ.
- **Vỡ khi:** kéo trang rồi nhả ngoài màn hình mà CPU vẫn quay (timer sống) · hoặc vạch chèn
  đứng chết ở cửa sổ đích sau khi phiên kéo đã xong · hoặc cột trang tự bung rồi ở lại dù
  người dùng chỉ lướt qua.

---

### BI-59 · Trang 0° phải ra **byte y hệt** — `/Matrix` chỉ được ghi khi trang thật sự xoay
_Ghi 2026-08-12._

- `desktop/renderer/managed-codec.js` (`normAngle`, `apRotatable`, `apMatrixFor`, `apRectFor`) +
  ba nhánh `/AP` của `addManagedAnnot` (text / arrow / image).
- Bối cảnh: trước v0.2.58 ba nhánh đó **từ chối** trang có `/Rotate` và rơi xuống dán cứng thành
  pixel. Dán cứng là **không thể đảo lại** — `importManaged()` không còn gì để đọc, nên hộp văn
  bản trên mọi bản vẽ (và trên mọi trang người dùng vừa **Xoay trang** trong app) là vĩnh viễn
  không sửa lại được. Xem `docs/SPEC-annot-rotated.md`.
- **Luật:** `if (normAngle(angle)) ap.Matrix = apMatrixFor(angle);` — trang 0° **không có key
  `/Matrix`** nào cả, và `apRectFor(0, w, h, bx, by)` trả đúng `[bx, by, bx+w, by+h]` mà code cũ
  viết thẳng. Tài liệu không xoay là tuyệt đại đa số; chúng phải lưu ra **cùng dãy byte** như
  trước khi BI-59 tồn tại. Đừng "gọn hoá" bằng cách ghi luôn matrix đơn vị.
- **`/Rect` phải đúng bbox của `Matrix × BBox`**, không phải `[bx, by, bx+w, by+h]`. Theo
  PDF 32000-1 §12.5.5 viewer *co giãn* appearance cho khít `/Rect` — sai một chỗ này thì con dấu
  không lệch, nó **méo**, và một test chỉ nhìn `/Matrix` sẽ không thấy gì.
- Góc **không chia hết 90** (`/Rotate 45` — sai chuẩn nhưng có file thật) vẫn phải dán cứng.
  `apRotatable` là cửa duy nhất; đừng thay bằng `% 360 !== 0`.
- **Vỡ khi:** tài liệu bình thường (0°) lưu ra khác byte so với bản trước · hoặc con dấu/hộp chữ
  trên trang xoay bị **méo** (dấu hiệu `/Rect` sai) hoặc **lệch 90°** (dấu hiệu `/Matrix` sai) ·
  hoặc re-bake trên trang xoay để lại **hai** con dấu.

---

### BI-60 · Cổng bake phải hỏi “có gì THAY ĐỔI”, không phải “có gì để THÊM”
_Ghi 2026-08-12._

- `desktop/renderer/editor.js`: `exit()`, `bakePending()`, `hasUnsaved`, `openTextEditor`,
  và trường `ed._importedManaged`.
- Bối cảnh — report thật ở v0.2.58: tạo một hộp văn bản → Lưu → vào Chú thích → xoá → **hộp
  quay lại**. Cơ chế xoá (`stripManagedAnnots`) chưa bao giờ sai; **hai cái cổng** chặn không
  cho nó chạy, cả hai đều gác bằng `hasAny()`:
  - `exit()`: `if (ed._dirty && hasAny())` — xoá hết thì `ed.annots` rỗng ⇒ `hasAny()` **false**
    ⇒ **không bake** ⇒ annotation vẫn nằm trong `state.bytes` ⇒ `repaintRenderedPages()` vẽ nó
    lại. Có từ **v0.2.35**, đúng bản sinh ra chú thích sửa-lại-được.
  - `bakePending()`: `if (!hasAny()) return false` — nên **Ctrl+S cũng không cứu được**.
- **Luật:** cổng phải là `hasAny() || ed._importedManaged`. `_importedManaged` = số annot
  round-trip mà `importManaged()` **nhận quyền sở hữu** từ file trong phiên này; nó là **cách
  duy nhất** biết rằng bake vẫn còn việc (xoá) khi không còn gì để thêm. Phải gán ở **cả hai**
  chỗ gọi `importManaged()` (`enter()` và nhánh lưu-giữa-phiên của `bakePending()` — chỗ thứ
  hai đọc lại file nên số phải cập nhật theo) và **xoá trong `reset()`**.
- `hasUnsaved` cũng vậy: “tôi đã xoá hết hộp văn bản” **là** một thay đổi chưa lưu. Gác bằng
  `hasAny()` thì đóng app không hỏi gì và mất luôn.
- **Xoá trắng nội dung hộp văn bản = XOÁ hộp**, không phải “không có gì thay đổi”. Chốt cũ
  `if (text && text !== existing.text)` (có từ **v0.2.20**) làm việc xoá nội dung thành no-op
  im lặng. Không giữ được hộp rỗng: `deserializeManaged` từ chối payload không có `text`
  (`if (!data.text) return null`) nên nó sẽ biến mất ở lần mở sau, và `renderTextPng` sẽ bị
  đòi một PNG cỡ 0. Nhánh `editOrig` của ghi chú vốn đã làm đúng — dùng nó làm mẫu.
- **Vỡ khi:** xoá hộp văn bản cuối cùng rồi bấm Xong → nó quay lại · hoặc xoá trắng nội dung
  rồi bấm ra ngoài → chữ cũ hiện lại · hoặc xoá hết rồi đóng app → **không** có cảnh báo.
- Lưới: `npm run test:managed` §3b (cơ chế, đo thật) + §3c (hai cổng, assertion trên source —
  `exit()`/`bakePending()` cần DOM nên không đo trực tiếp được).

### BI-61 · Màu chú thích: `colorSlotFor` là nguồn sự thật DUY NHẤT, và bốn màu có NGHĨA không được gộp
_Ghi 2026-08-13._

- `desktop/renderer/editor.js`: `DEFAULT_ANNOT_COLOR`, `savedAnnotColor()`, `COLOR_SLOTS`,
  `colorSlotFor()`, `setDefaultColor()`, khối `ed`; `renderer/app.js` `#set-annot-color`;
  `index.html` `#ed-color` + `#set-annot-color`.
- Mặc định dùng chung đổi **vàng `#ffd54a` → đỏ `#d32f2f`** ở v0.2.60 vì hộp văn bản / mũi
  tên màu vàng trên giấy trắng gần như vô hình; **→ `#e90000`** (RGB 233,0,0) ở v0.2.73, `crossColor`
  đổi theo (✗ vẫn là ô riêng, chỉ trùng giá trị).
- **Nét mặc định (v0.2.73):** `DEFAULT_PEN_WIDTH = 1`, `savedPenWidth()` / `normPenWidth()` /
  `setDefaultPenWidth()`, key `nabu-annot-penwidth`, `#set-pen-width` + `#ed-penwidth`. Một giá trị
  `ed.penWidth` dùng chung cho mọi kind có nét. **Các fallback `a.width || 2` KHÔNG phải mặc định** —
  chúng là độ dày một vật thể lưu **không kèm width** vẫn luôn được vẽ, tức thuộc về **định dạng file**;
  đổi chúng thành 1 là làm file đã lưu mỏng nét đi khi mở lại. test:defaults đếm và canh.
- **BỐN kind giữ ô màu riêng vì màu của chúng là NGHĨA, không phải sở thích:**
  `check` xanh (= đúng), `cross` đỏ (= sai), `highlight` vàng highlighter
  (`mix-blend-mode: multiply` 0.4 ⇒ đỏ thành vệt hồng), `redact` đen. Gộp chúng vào một
  màu “cho đơn giản” là làm dấu ✓ mang nghĩa **sai** và ô che thôi không còn đen.
- **Luật:** `COLOR_SLOTS` là một **Map** khai ở đầu IIFE cùng `SYMBOL_KINDS`. Mọi nhánh phục
  vụ **nhiều kind** (màu phụ thuộc `ed.tool`) **phải** đi qua `ed[colorSlotFor(ed.tool)]` —
  đừng viết lại một ternary `ed.tool === "redact" ? ed.redactColor : ed.color` tại chỗ gọi,
  đó đúng là cái đã bị xoá và đúng cách các chỗ gọi lệch nhau.
  - Nhánh chỉ tạo **một** kind mà kind đó **không** có slot riêng (arrow, dim, draw,
    cloudpen, text, note) đọc `ed.color` trực tiếp là **đúng** và đang làm vậy — 7 chỗ.
    ⚠️ Nhưng nếu sau này cấp slot riêng cho một trong số đó (ví dụ `note`), **phải** đổi
    chỗ tạo nó sang `colorSlotFor`, nếu không nó sẽ im lặng vẽ bằng màu chung.
  - Map **không phải** object literal: `COLOR_SLOTS["constructor"]` trên object literal trả
    về hàm của prototype (truthy) ⇒ `ed[hàm]` = `undefined` ⇒ vật thể màu đen im lặng.
  - Khai ở **đầu** file, không cạnh `colorSlotFor`: `colorSlotFor` là function declaration
    (hoisted) nhưng Map là `const`; một lời gọi lúc IIFE-init sẽ đụng **TDZ** ⇒ app trắng.
- **`|| "#ffd54a"` trong `deserializeManaged()` (2 chỗ: arrow + note) là hằng số của ĐỊNH
  DẠNG FILE, không phải preference.** Trỏ chúng sang mặc định mới = mọi file đã lưu đổi màu
  khi mở lại. Có ca canh gác trong lưới.
- Preference nằm ở **localStorage phía renderer** (`nabu-annot-color`), **không** phải
  `prefs.js`: `prefs.js` tồn tại cho quyết định main phải ra khi **chưa có cửa sổ nào**
  (BI-35); màu chú thích thì chỉ renderer đọc. Đọc/ghi **chỉ** ở `editor.js` và phơi qua
  `window.Editor.getDefaultColor/setDefaultColor` — `app.js` không được giữ bản sao thứ hai
  của key hay của regex kiểm hex.
- **Ba literal phải bằng nhau:** `DEFAULT_ANNOT_COLOR`, `value=` của `#ed-color`, `value=`
  của `#set-annot-color`.
- Đổi màu ở Cài đặt **không** sơn lại vật thể đã vẽ (đó là mặc định cho vật thể **mới**, y
  như `ed.fontSize`), còn ô **Màu** trên thanh **không** ghi vào preference.
- **Vỡ khi:** dấu ✓ ra đỏ · bút tô sáng ra hồng · ô che ra đỏ · vật thể mới ra **đen** (slot
  sai tên) · đổi màu ở Cài đặt rồi khởi động lại thì mất · mở file cũ thấy mũi tên đổi màu.
- Lưới: `npm run test:defaults` (45 ca — 3 literal, validate storage, 4 slot có nghĩa,
  ca canh gác `constructor`/`__proto__`, và 2 fallback `#ffd54a` của import).

### BI-62 · Verb “Gộp bằng Nabu PDF”: Explorer gọi app MỘT LẦN MỖI FILE — nhánh combine phải hỏi TRƯỚC, và batch phải mở tab RIÊNG
_Ghi 2026-08-13._

- `desktop/src/shell-combine.js` (thuần, có lưới) + `main.js` (`combineBucket`,
  `openCombineBatch`, `sendCombineToView`, `combineReady`) + `tabs.js` (`createTab`
  `combinePaths`) + `preload.js` (`onCombinePrefill`) + `renderer/app.js`
  (`combineFromShell`, `addCombineEntries`) + `build/installer.nsh`.
- **Sự thật của shell, phải nhớ trước khi sửa:** verb kiểu command-line được gọi **một lần
  cho mỗi file** được chọn, `%1` chỉ có một đường dẫn. `MultiSelectModel` **không** gộp lại;
  nó chỉ quyết định mục menu có hiện hay không:

  | Kiểu verb | `Document` | `Player` |
  |---|---|---|
  | legacy (command line) | 15 mục | **100 mục** |
  | COM (DropTarget) | 15 mục | không trần |

  ⇒ `Player` là **bắt buộc** (thiếu nó thì chọn 16 file là mục menu **biến mất**), và 100 là
  trần của OS. Nhận cả loạt trong **một** tiến trình cần COM `IDropTarget` — Electron không
  làm được mà không có helper native, **đã cố ý không làm**.
- **Bộ gom mà shell buộc phải có thì repo đã có sẵn:** `requestSingleInstanceLock` +
  `second-instance`. Tiến trình 2..N chuyển argv về tiến trình đầu rồi thoát. Không cần thêm
  binary nào (app khác phải ship hẳn một exe phụ cho việc này).
- **Luật 1 — THỨ TỰ HỎI.** `pdfPathFromArgv()` **cũng** tìm thấy đường dẫn trong argv của
  một lần gọi combine (cờ bị bỏ qua vì bắt đầu bằng `-`, đường dẫn thì không). Nên
  `ShellCombine.combinePathFromArgv()` phải được hỏi **TRƯỚC** ở **cả hai** lối vào argv
  (`second-instance` và đường khởi động). Sai thứ tự = chuột phải Gộp lại thành **mở file**.
- **Luật 2 — TAB RIÊNG.** `runCombine()` kết thúc bằng `loadBytes()`, tức là **thay tài
  liệu của tab nó chạy trong đó**. Dùng lại tab đang có tài liệu sẽ dựng lên câu hỏi “bỏ
  thay đổi chưa lưu?” mà người dùng không gây ra. Batch luôn mở **tab của riêng nó**, và vẫn
  hỏi `Prefs.getOpenIn()` cho tab-hay-cửa-sổ — đây là **đường mở tài liệu thứ tư**, bỏ sót
  nó là phá BI-35.
- **Luật 3 — KHÔNG GỘP IM LẶNG.** `%1` không mang chỉ số và N tiến trình tới theo thứ tự OS
  xếp lịch, nên **thứ tự click không sống sót**. Sắp theo tên **tự nhiên** (2 trước 10) rồi
  **luôn** mở hộp thoại để người dùng xác nhận/sắp lại. Gộp thẳng theo thứ tự tuỳ ý tạo ra
  tài liệu sai mà không ai phát hiện.
- **Luật 4 — CỜ VÀ KHOÁ REGISTRY SỐNG Ở HAI FILE.** `--nabu-combine` + subkey có trong cả
  `shell-combine.js` lẫn `build/installer.nsh`, và **không có gì lúc build đối chiếu**. Lệch
  = mục menu chạy app **không có cờ** ⇒ app coi là “Open with” ⇒ tính năng mất im lặng. Lưới
  đối chiếu hai file; đừng xoá ca đó.
- **Luật 5 — `SHCTX`, không hard-code HKCU/HKLM.** NSIS phân giải `SHCTX` theo chế độ cài mà
  electron-builder đã đặt, nên bản per-user ghi HKCU còn bản per-machine (đã nâng quyền) ghi
  HKLM. Hard-code HKCU = đăng ký verb cho **tài khoản admin** khi người khác nâng quyền hộ.
- `installer.nsh` phải là **UTF-8 CÓ BOM** (nhãn verb là tiếng Việt; NSIS 3 cần BOM). Thiếu
  BOM = mục menu ra mojibake. Có ca test đọc 3 byte đầu.
- `customUnInstall` **phải** `DeleteRegKey`, không thì gỡ app xong còn mục menu trỏ vào exe
  đã bị xoá.
- Trần một lượt là **60 file** (`MAX_BATCH`) vì mỗi file được đọc thành bytes rồi đẩy qua
  IPC. Phần bị cắt **phải được nói ra** (`dropped` → toast), không bao giờ cắt im lặng.
- **Windows 11:** đây là verb registry legacy nên nó nằm trong **“Hiện thêm tùy chọn”**
  (Shift+F10), **không** ở menu ngắn. Menu ngắn chỉ nhận `IExplorerCommand` đăng ký qua sparse
  MSIX **đã ký**, mà bản build đang **không ký** (`SIGNING.md`). Đã ghi trong Hướng dẫn để
  không bị báo là “thiếu tính năng”.
- **Vỡ khi:** double-click **một** file PDF lại mở hộp thoại Gộp · chuột phải Gộp lại **mở
  từng file** · chọn 5 file ra **hai** hộp thoại (cửa sổ gom quá ngắn) · batch **đè** lên tài
  liệu đang đọc · chọn 16 file thì mục menu mất (thiếu `Player`) · gỡ app xong menu vẫn còn.
- Lưới: `npm run test:combine` (77 ca — parse argv gồm ca canh gác “Open with phải ra
  null”, dedupe/sắp thứ tự/trần, chính sách gom của `createCombineBucket` gồm cửa
  chờ-app-sẵn-sàng, đối chiếu `.nsh` ↔ JS, và assertion thứ tự hỏi trên source `main.js`).
  ⚠️ **Chưa có lưới cho:** verb thật trong registry và đường `second-instance` thật — cả hai
  cần bản **đã đóng gói + đã cài**. Xem §5 để biết phải test tay những gì.

### BI-63 · `File.path` ĐÃ CHẾT ở Electron 33 — đường dẫn file kéo–thả phải qua `webUtils.getPathForFile`
_Ghi 2026-08-13. **Đo được, không suy luận.**_

- `desktop/src/preload.js` `pathForFile` + `renderer/app.js` `droppedPath()`.
- **Số đo:** trong renderer của Electron 33.4.11, `typeof f.path` của một `File` là
  **`"undefined"`**. Nghĩa là chốt `if (f.path && state.bytes)` trong handler `drop` (có từ
  trước, viết cho Electron ≤31) **là code chết** — mọi lần kéo–thả đều rơi xuống nhánh
  `loadBytes`, tức là **nạp vào chính tab đang mở** thay vì mở tab mới như BI-8/BI-35 quy
  định. Không lỗi, không cảnh báo; chỉ là tài liệu đang đọc bị thay.
- Typings của Electron 33 **vẫn còn** khai `interface File { path: string }`, nên đọc
  `.d.ts` sẽ tưởng nó còn sống. Đừng tin typings ở điểm này — đo bằng probe.
- **Luật:** đường dẫn của file kéo vào lấy qua `webUtils.getPathForFile(file)` (gọi trong
  **preload**, phơi ra thành `window.desktop.pathForFile`), giữ `f.path` làm fallback để
  không phụ thuộc vào một API duy nhất.
  - **Đã đo:** `webUtils` **dùng được** trong preload có `sandbox: true` +
    `contextIsolation: true` (đúng cấu hình `src/tabs.js`): `typeof webUtils === "object"`,
    `getPathForFile` là `function`.
  - Với `File` dựng bằng JS (không có file thật trên đĩa) nó trả **chuỗi rỗng** `""` —
    đúng như tài liệu. Nên `droppedPath()` phải nhận **chuỗi không rỗng**, chứ không phải
    "bất kỳ giá trị truthy": `""` là falsy nên lọt, nhưng một giá trị sai hình dạng khác
    sẽ được chuyển thẳng sang main làm tên file.
- **Vỡ khi:** kéo một PDF vào tab **đã có** tài liệu mà nó **thay** tài liệu đó thay vì mở
  tab mới · kéo nhiều file rồi chọn “Mở từng file” mà chỉ mở được một file kèm toast
  “không lấy được đường dẫn”.
- Lưới: `npm run test:confirm` §3b (assertion trên source). Đường OS thật (kéo từ Explorer
  vào để lấy đường dẫn **thật**) **không** probe được — phải test tay.

---

### BI-64 · Chữ nhật · elip · **khoanh mây** round-trip bằng `/AP` **VECTOR** — cái bẫy là `pad`, không phải ma trận

- `managed-codec.js` `shapeAppearance()` + `MANAGED_KINDS` + `VECTOR_KINDS`/`isVectorKind`
  + nhánh vector của `serializeManaged`; `editor.js` nhánh vector của `addManagedAnnot` +
  `deserializeManaged`. Lưới: `npm run test:managed` §6 + `npm run test:rotate` §6/§7.
- **Bốn kind, MỘT nhánh mỗi nơi.** `VECTOR_KINDS = {box, ellipse, cloud, cloudpen}` có tên
  riêng vì câu hỏi “kind này có vector không” bị hỏi ở **ba** file; viết chuỗi `||` ở mỗi
  chỗ là đúng cách để ba chỗ đó trôi khỏi nhau (lý lẽ y hệt `RESIZABLE_KINDS`).
- **Tại sao vector chứ không phải PNG như chữ/mũi tên.** Chữ và mũi tên rasterise vì mực
  của chúng là **glyph tiếng Việt** — nhúng font để vẽ được "Nghiệm thu" là bài toán ta cố
  ý không có. Hình chữ nhật và elip không có cái cớ đó: pdf-lib **export sẵn** đúng những
  hàm sinh operator mà `page.drawRectangle`/`page.drawEllipse` gọi bên trong, nên `/AP` có
  thể dùng **chính đường vẽ** mà nhánh flatten của `drawOneAnnot` đang dùng — chỉ khác chỗ
  chứa (Form XObject thay vì content stream của trang). Được ba thứ: nét **không mờ** ở mọi
  mức zoom và khi in, tốn vài chục byte thay vì một bitmap supersample, và — vì hình học đến
  từ **cùng một hàm** — bản sửa-lại-được **không thể** trôi khỏi bản flatten.
- **`pad` là thứ chịu lực, và nó là chỗ dễ sai nhất.** Form `/AP` **cắt** theo `/BBox`, mà
  **một nửa nét vẽ nằm NGOÀI** đường path nó bám theo — ở góc vuông bo mí (miter) còn với ra
  xa hơn (√2 nửa nét). Lấy BBox đúng bằng w×h là **gọt mất viền** của người dùng ở cả bốn
  cạnh. `shapeAppearance` đệm **trọn một bề rộng nét** mỗi bên, vẽ hình ở `(pad, pad)` bên
  trong form, và neo form tại `map(a.x - pad, a.y + a.h + pad)` — **ba chỗ phải cùng nói về
  một số `pad`**, sai lệch một chỗ là hình lệch đúng một bề rộng nét (2–8pt): **không thấy
  trên ảnh chụp màn hình, sai trong file**, và **không** bị bắt bởi bất kỳ test nào chỉ so
  `/Rect` với công thức dựng từ chính `pad` đó.
- **Mây chồng HAI lớp đệm, và đó là bẫy riêng của nó.** `annot-geom` đã dịch path đi trọn
  một `bump` (để bướu không âm) — đó là **đệm hình học**, dùng chung với `<svg>` của lớp phủ.
  `/BBox` còn phải cộng thêm **đệm NÉT** nữa. Nhầm hai thứ này là viền mây bị gọt (chỉ
  `test:managed` bắt được) hoặc hình lệch (chỉ `test:rotate` bắt được).
- **`drawSvgPath` LẬT trục y** (`translate · R · scale(1,-1)`), nên điểm neo của nó là góc
  **TRÊN**-trái của hộp path, không phải dưới-trái như `drawRectangle`. Trong form, điểm đó
  là `(lw, hPt - lw)`. Viết nhầm thành `(lw, lw)` là mây lộn ngược **và** lệch.
- **Bên trong form LUÔN vẽ ở `degrees(0)`.** Đường flatten **bắt buộc** truyền
  `rotate: pageRotate(page)` cho `drawSvgPath` (BI-45 — quên nó chính là lỗi mây bị quay trên
  mọi trang xoay tới tận v0.2.52); trong Form XObject thì hệ toạ độ local **chính là** không
  gian form, đã dựng đứng theo màn hình, và `/Matrix = R(angle)` mới là thứ quay. Truyền góc
  trang vào `shapeAppearance` là **quay HAI lần**.
- **`shapeAppearance` trả về `ox`/`oy`** — toạ độ lớp phủ của góc dưới-trái form — nên chỗ
  gọi map **đúng một điểm** và không cần biết luật đệm của từng kind. Cố ý: `pad` của hộp
  (nửa nét bo mí) và của mây (trọn một bướu **cộng** nét) là hai thứ khác nhau, và để chỗ gọi
  tự suy ra là **bốn** cơ hội lệch một bề rộng nét.
- **Đa giác suy biến (<3 điểm phân biệt) phải bị TỪ CHỐI ở cả hai đầu:** `shapeAppearance`
  trả `null` ⇒ `addManagedAnnot` trả `false` ⇒ rơi về `drawOneAnnot`, chỗ `cloudPathPoly`
  cũng trả `null` và vẽ **không gì cả** — hai bên đồng ý. `deserializeManaged` cũng từ chối,
  nếu không sẽ có một vật **vô hình, không chọn được** nằm trong `ed.annots` mà lần bake sau
  âm thầm đánh rơi. Điểm `NaN` cũng bị lọc: nó đầu độc `Math.hypot` và cả chu vi.
- **Vì thế `test:rotate` §6 đọc content stream BÊN TRONG form**, không phải hộp bao của nó:
  với ảnh round-trip thì `/AP` chỉ là một `Do` của hình vuông đơn vị nên bao form **chính là**
  bao mực; với hình vector thì bao form là bao **phần đệm**. Đo xong đẩy từng điểm qua
  `/Matrix` rồi qua phép ánh xạ §12.5.5 lên `/Rect`, đúng như một trình đọc thật làm, và so
  với **đường flatten đã phát hành** ở 0° — thứ mà §1 đã ghim vào đúng chỗ người dùng vẽ.
- **Hai ca guard, và chúng không phải trang trí:** (i) `/AP` **thiếu `/Matrix`** — đúng ở 0°,
  sai ở cả ba góc phần tư (lỗi tiền-BI-59 dựng lại bằng tay); (ii) **quên `pad` ở khâu neo** —
  sai ở **cả 0°**, đó là lý do (i) một mình không đủ. Không có hai ca này, §6 xanh mà không
  chứng minh được gì. Đã mutation-test: `pad = 0` làm đỏ 8 ca ở `test:managed` + 4 ở
  `test:rotate`; bỏ `/Matrix` làm đỏ 12 ca; neo thiếu `pad` làm đỏ 24 ca. Riêng phần mây:
  neo `drawSvgPath` ở `(lw, lw)` → **49** ca đỏ ở `test:rotate`; quên `- g.pad` → **49**;
  `rotate: degrees(90)` trong form (đúng lỗi BI-45) → **98**. Còn `/BBox` không cộng nét thì
  `test:rotate` **KHÔNG** thấy (mực không dời, chỉ bị cắt) — **2** ca của `test:managed` là
  thứ duy nhất bắt được. **Hai lưới bù nhau: đừng bỏ lưới nào.**
- **Độ mờ nền đi bằng ExtGState ghi TRỰC TIẾP (inline) trong `/Resources`, tuyệt đối không
  đăng ký thành object gián tiếp.** Đây không phải chuyện thẩm mỹ: `collectManagedChain` giải
  phóng `/NabuSrc`, `/NabuImg` và bản thân form — một ExtGState gián tiếp là **object thứ tư
  không ai giải phóng**, rò rỉ đều đặn sau **mỗi** lần bake. Đúng lớp lỗi mà BI-38 tồn tại để
  chặn. Dict trực tiếp chết cùng form giữ nó. Nền **đục hoàn toàn thì không ghi ExtGState** —
  không có gì để đặt thì đừng trả giá.
- **Chỉ `ca` (alpha nền), không `CA` (alpha nét):** đường flatten truyền cho pdf-lib đúng một
  `opacity`, mà pdf-lib hiểu là alpha **nền**. Bịa thêm alpha nét ở đây là làm bản bake **lệch
  khỏi lớp phủ trên màn hình**.
- **`deserializeManaged` phải rơi về một LITERAL, không bao giờ về màu mặc định đang nhớ.**
  Màu mặc định là một **tuỳ chọn sống**; đọc nó ở đây là ngày người dùng đổi màu thì **mọi
  hình trong file cũ đổi màu theo**. `test:defaults` chặn bằng cách so **chuỗi con trên toàn
  bộ source của hàm — kể cả trong comment**, nên đừng nhắc tên hằng đó ở đây.
- **Còn cố ý flatten:** vẽ tay, tô sáng, che thông tin, đo, ✓/✗. Không phải bỏ sót — mỗi
  loại cần nhánh appearance riêng, và ra từng lớp một là điều giữ cho các ca guard của
  `test:rotate` còn có nghĩa.
- **Vỡ khi:** vẽ chữ nhật **hoặc khoanh mây** → Áp dụng → Lưu → mở lại → **không chọn được**
  (rơi về flatten) · mây mở lại **lộn ngược** hoặc lệch trọn một bướu ·
  chọn được nhưng **lệch đúng một bề rộng nét** lên trên-trái · viền **bị gọt** một sợi ở cả
  bốn cạnh (BBox thiếu đệm) · hình trên trang **đã xoay** ra **méo hoặc lệch 90°** · lưu 3–4
  lần liên tiếp mà **file phình** (ExtGState rò) · elip nền mờ mở lại thành **đục**.
- Lưới: `npm run test:managed` (§6) · `npm run test:rotate` (§6 + §7, xem BI-65) ·
  `npm run test:defaults`.
  Nửa GUI vẫn phải thử tay — xem hàng tương ứng ở §5.

---

### BI-65 · “Landscape” là **HAI** thứ khác nhau, và mỗi trang phải dùng **viewport của CHÍNH NÓ**

- `editor.js` `bakeInPlace()` / `bakeWithRedaction()` — dòng
  `const vp1 = (await state.pdf.getPage(i + 1)).getViewport({ scale: 1 });` **nằm TRONG**
  vòng lặp trang. Lưới: `npm run test:rotate` §7.
- **Hai nghĩa của “trang ngang”, và chúng đi hai đường số học khác nhau:**
  · `/MediaBox` **rộng** (bản vẽ CAD, `/Rotate 0`) → `vp1.width/height` đổi thẳng;
  · `/MediaBox` **cao** + `/Rotate 90` (ảnh scan dựng đứng bị xoay) → `convertToPdfPoint`
  **hoán vị** hai chiều bên trong.
  Trước v0.2.61 lưới chỉ phủ nghĩa thứ hai. Bộ hồ sơ thật có **cả hai**, và rất thường
  **trong cùng một file** — tờ bản vẽ ngang đóng chung với thuyết minh dọc.
- **Lớp lỗi mà §7 tồn tại để chặn không phải “xoay sai”** (§1/§5/§6 đã giữ việc đó) mà là
  **“bake dùng viewport của trang này cho trang khác”**. Trong tài liệu **một hướng** lỗi đó
  **tàng hình hoàn toàn**; trong tài liệu trộn hướng nó ném mực **ra ngoài mặt giấy**. Vì thế
  §7(b) dựng **một** tài liệu 4 trang {dọc 0°, ngang 0°, dọc 90°, ngang 270°}, bake trong
  **một lượt** đúng như `bakeInPlace`, rồi so **từng trang** với đáp án một-trang của chính nó.
- **Ca guard là thứ làm §7(b) có nghĩa:** nó nhấc `vp1` ra ngoài vòng lặp (dùng map của
  **trang 0** cho mọi trang) và **đòi** kết quả phải SAI ở trang 1–3, đồng thời vẫn ĐÚNG ở
  trang 0 — nếu không thì ca guard chỉ đang đo nhiễu.
- **“Áp dụng xong trang tự quay” có HAI đường gây ra, §7 chốt cả hai:** mực xoay (so bộ điểm
  hiển thị) **và** bản thân trang xoay — nên §7(b) kiểm luôn `page.getRotation().angle` và
  `getWidth()/getHeight()` **không đổi** sau khi bake.
- **Đường redact là đường nguy hiểm nhất và nó CỐ Ý phẳng hoá xoay:** `bakeWithRedaction`
  **không** copy trang bị che, nó rasterise rồi dựng trang **MỚI**
  `out.addPage([vp1.width, vp1.height])` **không `/Rotate`**, và map mực qua
  `makeMap(vp1, "image")`. Ảnh PNG **đã ở hướng hiển thị** — cộng thêm góc xoay của trang lên
  nữa là tờ ngang ra **quay 90°** sau khi Áp dụng. §7(c) đo đúng phép tính đó ở 90° và 270°
  (bản thân `rasterRedacted` cần canvas nên không chạy được ở node).
- **Vỡ khi:** file có cả trang dọc lẫn trang ngang → chú thích trên trang **thứ hai trở đi**
  lệch hoặc biến mất · tờ ngang **quay 90°** sau khi Áp dụng · che thông tin trên trang đã
  xoay làm trang đó **nằm ngang ra** · bản vẽ A3 ngang `/Rotate 0` đúng nhưng A4 dọc trong
  cùng file thì sai (dấu hiệu kinh điển của `vp1` bị nhấc khỏi vòng lặp).
- Lưới: `npm run test:rotate` §7 (a: mọi kind vector trên `/MediaBox` rộng × 4 góc ·
  b: tài liệu trộn hướng + guard · c: trang redact).

### BI-66 · Vẽ lại chữ phải theo **CHIỀU VIẾT CỦA CHÍNH ĐOẠN CHỮ**, không theo `/Rotate` của trang

- `_text_frame()` + khối vẽ lại của `/edit-text` ([api.py](../api.py)); trường `dir` của
  `/text-spans`, `/text-find` và `TextEdit`; `ed.dir` ở
  [text-edit.js](../desktop/renderer/text-edit.js) `apply()`, `dir` ở
  [find-replace.js](../desktop/renderer/find-replace.js) `editForSpan()`.
  Lưới: `.venv\Scripts\python test_edit_text_rotate.py`. Chẩn đoán đầy đủ + số đo:
  [SPEC-text-edit-rotated.md](SPEC-text-edit-rotated.md).
- **Đã đo, không suy luận** (PyMuPDF 1.27.2 đang ship): `page.insert_text` — như **mọi**
  hàm ghi nội dung của PyMuPDF — vẽ ở không gian trang **CHƯA XOAY** và **bỏ qua hoàn
  toàn** `/Rotate`: gọi y hệt trên trang 0°/90°/180°/270° cho ra **cùng một** bbox.
  `get_text` cũng báo ở đúng không gian đó. Nên bản thân endpoint **không có cách nào
  biết** chữ nó đang thay chạy theo chiều nào — trước bản vá nó vẽ **mọi** đoạn từ trái
  sang phải.
- **Lỗi thật, do người dùng báo 2026-08-20:** trên bộ hồ sơ thầu/CAD (`/Rotate 90`), chữ
  gốc chạy **DỌC** trong không gian chưa xoay để đọc **xuôi** sau khi viewer xoay lại ⇒
  “Sửa nội dung” và **chữ thay thế của Tìm & Thay thế** ra **quay 90°**. Đây là **lớp lỗi
  BI-45 ở một tầng khác**: BI-45/BI-65 vá đường bake chú thích (pdf-lib, phía renderer);
  đường này là chữ **thật** của trang (PyMuPDF, phía sidecar) và **không** dùng chung một
  dòng số học nào với nó.
- **`page.rotation` là câu trả lời SAI, và đây là con số:** file tham chiếu
  (`260521_CLD_NAVY_SGSU`, 30 trang, **trang nào cũng** `/Rotate 90`) có **5799** đoạn đọc
  xuôi — `dir (0,-1)` — **và 902** nhãn dựng dọc — `dir (-1,0)`. Một góc trang **không thể**
  mô tả cả hai; lấy góc trang mà vá thì 902 đoạn kia sai theo kiểu mới. Nguồn sự thật duy
  nhất là `line["dir"]` của **chính đoạn chữ**, nên nó được chuyển suốt từ
  `/text-spans`/`/text-find` → renderer → `/edit-text`.
- **Ba phép tính, không phải một.** Sửa chiều mà bỏ hai chỗ còn lại là đổi lỗi lộ thành
  lỗi im:
  1. **Chiều vẽ** — một ma trận `morph` mang cả xén-nghiêng, nén ngang **và** góc chữ:
     `Matrix(hscale, 0, shear, 1, 0, 0) * Matrix(theta)`. **Thứ tự bắt buộc** như vậy: nén
     ngang thuộc hệ **của chữ**, phép xoay mới đưa hệ đó ra trang; đảo lại thì trên đoạn đã
     xoay cái nén rơi vào **chiều cao glyph** thay vì bước tiến (đã đo).
  2. **`hscale` / `vscale` (BI-25)** chia cho bề ngang / bề cao của bbox. bbox là
     **axis-aligned**, nên trên đoạn xoay 90° bề ngang chính là **chiều cao dòng** và bề cao
     chính là **độ dài chữ** — hai số **đổi chỗ**. Với đoạn dài thì tỷ số rơi ra ngoài dải tin
     cậy và bị loại (may), nhưng với đoạn **ngắn** nó rơi **vào trong** dải ⇒ chữ bị nén còn
     một nửa mà **không báo gì**. Vì thế `adv`/`thick` được chọn theo `quadrant`.
  3. **Gạch chân** vẽ theo `u_dir`/`n_dir` (dọc theo chữ / xuống dưới đường chân), không
     phải theo trục x/y của trang.
- **Không phải góc vuông thì KHÔNG suy diễn.** Nhãn dẫn của bản vẽ được viết ở 15°, 22.7°,
  30°, 49°… — `insert_text(rotate=…)` chỉ nhận bội số 90 nên đường vá dùng **ma trận**, tái
  tạo **đúng** góc đó. Nhưng bbox axis-aligned của một đoạn chữ chéo **không** tách được
  thành “dọc theo chữ” và “ngang qua chữ”, nên ở đó `quadrant = None` và **cả hai** phép
  chỉnh hình học bị **tắt** — thà không chỉnh còn hơn chỉnh theo một số đo đã biết là sai.
  Dưới `_DIR_SNAP_DEG = 2°` thì **bắt vào** góc vuông: file thật có đoạn lệch 0.11°, và bắt
  đúng góc giữ cho `u`/`n` không nhiễm bụi float (`cos 90° = 6e-17`).
- **Dải chết là hợp đồng, không phải may mắn:** không có `dir` (renderer cũ, caller khác,
  test cũ) ⇒ `theta = 0` ⇒ `Matrix(0)` là ma trận đơn vị và `morph` về đúng biểu thức cũ ⇒
  tài liệu Word/Excel bình thường ra **y hệt từng pixel**. Lưới có ca `D3` đo đúng điều đó.
- **Luật:** thêm bất kỳ phép vẽ nào vào vòng lặp `for e in edits` của `/edit-text` (viền,
  gạch giữa, chỉ số trên/dưới…) thì phải trả lời nó đi theo **hệ của chữ** (`u_dir`/`n_dir`,
  hoặc nằm trong `morph`) hay hệ của **trang**, **và** thêm ca vào `test_edit_text_rotate.py`.
  Lớp lỗi ở đây là “phép vẽ mới âm thầm không tham gia bù xoay” — hệt BI-45.
- **Vỡ khi:** sửa một dòng trên bản vẽ A1 nằm ngang → chữ mới **quay 90°** · Thay tất cả
  trên hồ sơ CAD → chữ thay thế nằm **vắt ngang** bản vẽ · nhãn kích thước dựng dọc sau khi
  sửa thì **nằm ngang ra** · đoạn **ngắn** trên trang xoay bị **nén còn ~50%** · gạch chân
  **cắt ngang** chữ thay vì nằm dưới. Trên trang **không** xoay thì mọi thứ vẫn đúng — đúng
  khuôn im lặng của BI-40/BI-45.
- Lưới: `test_edit_text_rotate.py` (107 ca — helper thuần · dải chết · 4×4 tổ hợp
  {góc trang} × {chiều chữ} · gốc đường chân · `/Rotate` không tự đổi · trục hình học ·
  gạch chân · góc chéo 30° · **đường Tìm & Thay thế đi hết vòng**). **Mỗi** nhóm có **ca
  canh gác** gửi `dir=None` để dựng lại đúng lỗi cũ và **đòi** kết quả phải SAI — bỏ ma
  trận `morph` ra thì lưới đỏ 26 ca, nên một lưới xanh mới có nghĩa.
- Trường `dir` **cũng là trường thứ 9 của tuple span dẹt** trong `_find_build_index`. Tuple
  đó là **hợp đồng theo vị trí**: fixture `part()` của `test_text_find.py` phải đi theo, nếu
  không nó đang test một hình dạng tài liệu mà sidecar không bao giờ sinh ra.
---

### BI-67 · Chữ **thành nét vẽ** + lớp text vô hình: redact xoá lớp vô hình, **mực vẫn còn**

- `_fix_span_box` / `_fix_text_dict` / `_page_text_dict` và bộ dò mực
  `_probe_pixmap` / `_px_box` / `_ink_survived` / `_ring_color`
  ([src/pdf/layout.py](../src/pdf/layout.py)); bước **1** + **1b** của `/translate-pdf`
  ([api.py](../api.py)). Lưới: `test_helpers.py` (10 ca thuần) + `test_translate_layout.py`
  (4 ca dựng file).
- **Lỗi thật, người dùng báo:** bấm **Dịch**, file ra vẫn đọc được **nguyên** tiếng Việt và
  bản tiếng Anh **nằm đè lên** — không đọc được cái nào. Thiết kế nói rõ bản gốc phải biến
  mất.
- **Hai lỗi ĐỘC LẬP chồng lên nhau, và vá một cái không đủ.** Đã đo trực tiếp trên file
  người dùng gửi:
  1. **Chữ nhìn thấy KHÔNG phải chữ.** Content stream 775 KB toàn `m/l/c/f` — 33 đường
     **tô đặc** vẽ ra toàn bộ chữ của trang, kèm một lớp font **Type3 rỗng** chỉ để
     `get_text` đọc được. `apply_redactions` xoá đúng lớp vô hình đó (`get_text` về **0**
     ký tự) nhưng render **y hệt trước** — vì `graphics=PDF_REDACT_LINE_ART_NONE` (thêm ở
     v0.2.43 để cứu gạch chân và ô bảng có nền) nói **đừng đụng vào nét vẽ**, mà mực CHÍNH
     LÀ nét vẽ.
  2. **bbox của span lệch xuống đúng một dòng.** MuPDF báo
     `bbox=(56, 43, 71.6, 57) origin=(56, 43)` — **đường chân nằm trên cạnh TRÊN** của
     hộp, trong khi mực thật ở `y 32.94..43.17`. Nên ô redact **và** ô `insert_textbox`
     đều thấp hơn chữ một dòng.
- **Bật lại xoá nét vẽ KHÔNG phải câu trả lời — đã thử cả ba chế độ.** `REMOVE_IF_COVERED`
  và `REMOVE_IF_TOUCHED` chỉ xoá những sub-path heuristic của MuPDF cho là bị phủ: tiêu đề
  quay lại **mất dấu** (“PHAM VI CÔNG VIEC”), gạch ngang trang biến mất. Vá theo hướng đó
  là đổi một lỗi lộ lấy một lỗi bẩn.
- **Nguồn sự thật là ĐO, không phải đoán:** render trang 72 dpi **trước** và **sau**
  `apply_redactions`, so **đúng ô của block đó**. Không đổi **một** pixel ⇒ redact chứng
  minh là **không xoá được gì** ⇒ chữ nhìn thấy không phải chữ ⇒ che nền. Phép thử này
  **không** hỏi “vùng này có tối không”, nên chú thích nằm **trên ảnh** (redact xoá được
  glyph ⇒ pixel ĐỔI) không bao giờ bị nhận nhầm.
- **Che nền lấy màu từ dải ngay TRÊN và DƯỚI block**, không phải viền quanh: với một dòng
  chữ, hai dải đó là khoảng cách dòng ⇒ chính là màu nền trang, còn hai bên có thể chạm cột
  bên cạnh. Dải **không** đồng màu (ảnh, gradient) ⇒ **không vẽ gì**, đếm vào
  `blocks_uncleaned` và báo cho người dùng: một mảng đặc đè lên ảnh phối cảnh là hỏng nặng
  hơn một trang nói thẳng là không dọn được.
- **Bản vá bbox nằm ở TẦNG CHUNG (`_page_text_dict`), cố ý.** `/text-spans`, `/text-find`
  và `_page_text_blocks` là ba cửa duy nhất đọc span; đi chung một cửa thì Dịch, Sửa nội
  dung và Tìm & Thay thế **không thể** bất đồng về chỗ của một chữ. Thêm cửa thứ tư = gọi
  `_page_text_dict`, **không** gọi `page.get_text("dict")`.
- **Tài liệu bình thường không thể chạm vào luật này:** với font thật MuPDF dựng
  `y0 = origin.y - ascender*size`, nên `origin.y - y0 ≈ 0.9*size` — cách xa ngưỡng
  `0.25*size`; ca lỗi cho đúng **0**. Ngưỡng là **phân số của cỡ chữ**, không phải số điểm
  tuyệt đối, nên chú thích 4pt và tiêu đề 40pt cùng một luật. Chỉ áp cho **dòng ngang**
  (`dir ≈ (1,0)`) — trên dòng dọc `origin.y - y0` mang nghĩa khác hẳn (BI-66).
- **Số thay thế là ĐO được:** `asc = 0.9`, `desc = -0.25`. Trên file thật, dòng cao nhất cần
  `0.89*size` trên đường chân và đuôi chữ sâu nhất xuống `0.21*size`.
- **Vỡ khi:** dịch một brochure/catalogue xuất từ InDesign/Canva (“giữ chữ tìm được” =
  outline + lớp vô hình) → bản dịch **đè** lên bản gốc · “Sửa nội dung” trên cùng file đó
  tô sáng **khoảng trắng dưới** chữ · Tìm & Thay thế ghi chữ mới thấp hơn một dòng · và
  ngược lại, nếu ngưỡng bị nới thì tài liệu Word **bình thường** bị dịch ô hộp lên trên.
- **Luật:** đừng bao giờ đổi `graphics=` của `apply_redactions` để “cho chắc”. Câu hỏi đúng
  là “redact có xoá được gì không”, và câu đó phải **đo**, không suy luận.
---

### BI-68 · `blocks_covered` / `pages_failed` là **kết quả**, không phải log — `success` không có nghĩa là xong

- `TranslateResponse` ([api.py](../api.py)) và toast của `runTranslate`
  ([app.js](../desktop/renderer/app.js)). Lưới:
  `test_translate_layout.py::test_pages_the_model_gave_nothing_for_are_reported`.
- **Lỗi thật, trong cùng một lượt báo lỗi:** file 3 trang, Gemini chỉ trả kết quả cho trang
  1. Hai trang kia ra file **nguyên tiếng Việt** và app báo **thành công**. Code cũ:
  `if not translations: continue` — bỏ qua **im lặng**.
- Người dùng sắp **gửi file này cho người khác**. Một trang không dịch mà không ai nói là
  lỗi tệ hơn một trang dịch xấu.
- **Luật:** trong `/translate-pdf`, mọi nhánh `continue` bỏ qua công việc phải **cộng vào
  một bộ đếm có trong response**, và toast phải đổi sang `warn` khi bộ đếm khác 0. `success`
  chỉ có nghĩa “đã tạo được file”.
---

### BI-69 · `draw` round-trip: điểm phải **thưa hoá**, và nét phải **cùng một hình** ở cả hai đường ghi

- `strokePath` / `simplifyStroke` ([annot-geom.js](../desktop/renderer/annot-geom.js));
  nhánh `draw` của `shapeAppearance` + `serializeManaged`
  ([managed-codec.js](../desktop/renderer/managed-codec.js)); nhánh `draw` của
  `deserializeManaged` + `drawOneAnnot` ([editor.js](../desktop/renderer/editor.js)).
  Lưới: `test:cloud` (14 ca hình học), `test:managed` (round-trip + thưa hoá),
  `test:rotate` §6/§7 (`draw` + `draw flat`).
- **Điều `draw` khác MỌI kind managed khác:** nó là kind duy nhất mà điểm **lưu vào file
  không phải** điểm trên object. `cloudpen` là dăm góc **bấm chuột** nên ghi nguyên; `draw`
  thêm một điểm **mỗi lần chuột di chuyển**, nên một nét chéo qua trang A4 là vài trăm điểm
  và một chữ ký là vài nghìn — tất cả phải nằm trong chuỗi hex `/NabuData`, trên **mỗi**
  trang, ở **mỗi** lần lưu.
- **Thưa hoá phải LŨY ĐẲNG, và đó mới là điểm mấu chốt** — không phải tỷ lệ nén. RDP giữ
  lại đúng những điểm cách dây cung **hơn** `tol`, nên chạy lại trên chính kết quả của nó
  trả về y nguyên. Không có tính chất đó thì **lưu → mở lại → lưu** bào mòn đường cong thêm
  một chút mỗi vòng và chữ ký từ từ thành đa giác — đúng lớp lỗi “dịch lại file đã dịch”.
- **`tol = 0.3 pt ≈ 0.1 mm`**: một phần mười bề rộng nét mảnh nhất thanh công cụ cho, và
  dưới cả độ phân giải in 600 dpi (0.042 mm/px ⇒ 2.5 px).
- **Trần `maxPts` NỚI DUNG SAI, không cắt cụt.** Quá hạn thì `tol` nhân đôi rồi chạy lại;
  mất **đuôi** chữ ký là hỏng nặng hơn một đường cong thô hơn.
- **Hai đường ghi vẽ CÙNG một hình, bằng hai primitive khác nhau — và đó là chủ ý.**
  Đường flatten vẫn là `drawLine` **từng đoạn** vì mỗi đầu mút được `map` **riêng**, thứ
  giữ cho nét đúng trên trang `/Rotate` mà không cần `rotate:` (chính cái bẫy BI-45); `/AP`
  là **một** `drawSvgPath`. Chúng bằng nhau **chỉ khi** cả hai bo tròn: `lineCap: Round`
  bên flatten, `1 J` + `1 j` bên `/AP` — **một đầu bo tròn ở mỗi mối nối chính là một mối
  nối bo tròn**. Bỏ `1 j` thì mối gấp Shift mọc **gai mitre** dài tới 10 lần bề rộng nét;
  bỏ `lineCap` thì nét flatten có **khấc** giữa các đoạn.
- **`1 j` phải nằm TRONG `q/Q` của form**, chèn vào sau `ops[0]` (`pushGraphicsState`) chứ
  không đặt trước — trạng thái đồ hoạ rò ra ngoài form là lỗi không thấy được cho tới khi có
  operator thứ hai.
- **Nét thẳng tuyệt đối có một cạnh bằng 0** (`strokePath` trả `H = 0` cho nét ngang, đúng
  như vậy — không fudge). `/BBox` cạnh 0 **cắt sạch** đường vẽ; thứ cứu nó là phần đệm bề
  rộng nét của `shapeAppearance`. Ca `draw flat` trong `test:rotate` tồn tại đúng để giữ
  phần đệm đó.
- **`redact` sẽ KHÔNG BAO GIỜ vào `MANAGED_KINDS`.** Nó tồn tại để **phá huỷ** nội dung bên
  dưới; một ô che sửa lại được thì không còn là ô che.
- **Vỡ khi:** vẽ tay rồi Lưu → mở lại **không chọn được** (quên `MANAGED_KINDS`) · file
  phình vài MB vì một chữ ký (quên thưa hoá) · nét mờ dần sau vài vòng lưu (thưa hoá không
  lũy đẳng) · nét ngang **biến mất** sau khi lưu (`/BBox` cạnh 0) · nét bake ra **khác**
  nét round-trip ở mối nối (thiếu `1 j` hoặc `lineCap`).
---

### BI-70 · Xoay hộp văn bản nướng vào **RASTER**, không vào `/AP` — và tâm không được dịch

- `normRot` / `rotatedBox` ([annot-text.js](../desktop/renderer/annot-text.js)); nhánh xoay
  của `renderTextPng`, `ox`/`oy` ở `drawOneAnnot` + `addManagedAnnot`, transform của
  `renderAnnot` và `openTextEditor` ([editor.js](../desktop/renderer/editor.js)).
  Lưới: `test:text` (13 ca thuần), `test:managed` (round-trip + toán raster trên canvas giả).
- **Vì sao nướng vào raster.** Appearance của hộp văn bản **vốn đã** là PNG (glyph tiếng
  Việt, không nhúng font — xem đầu file editor.js), nên xoay glyph trên canvas **không tốn
  gì thêm** và annot vẫn là stamp **thẳng trục**. Nhờ vậy `apMatrixFor`/`apRectFor` giữ
  nguyên **một** nghĩa duy nhất — “trang bị xoay” — tức là toàn bộ lưới BI-59 / `test:rotate`
  không phải đụng tới. Đi đường `/Matrix` sẽ mua thêm độ nét mà hộp văn bản **không có**
  (nó là ảnh) và trả bằng việc mở lại đúng chỗ nguy hiểm nhất của codebase.
- **Bất biến duy nhất phải giữ: xoay KHÔNG được làm dịch TÂM raster.** Canvas phình ra để
  chứa glyph đã xoay, và `ox`/`oy` trả lại **đúng một nửa** phần phình đó, nên tâm rơi
  đúng chỗ tâm hộp thẳng đã ở. Chia không đều thì raster vẫn **đúng cỡ** mà chữ vẫn **sai
  chỗ** — đo được, nhìn không ra.
- **`ox`/`oy` KHÔNG cùng dấu.** Quay 1/4 thì hộp **phình theo một trục và co theo trục
  kia**, nên đừng khẳng định “luôn âm”. Thứ cố định là chia đều.
- **Ở 0° phải ra byte y hệt:** `rotatedBox(w, h, 0)` trả **đúng** `(w, h)` — không epsilon,
  không ceil — và `ox = oy = 0`, nên mọi call site cũ không đổi một chữ. Cùng lời hứa
  BI-59.
- **Dấu góc:** dương = **ngược chiều kim đồng hồ** trên màn hình, cùng quy ước watermark
  (`rotate(${-angle}deg)` trong CSS, `-angle` radian trên canvas). Hai thứ chữ xoay được
  của app mà cãi nhau về chiều “45” là một báo lỗi riêng.
- **Chuẩn hoá vào `(-180, 180]`:** ô nhập là số độ, người dùng gõ 350 nghĩa là “10 chiều
  kia”, và con số này **đi vào `/NabuData`** — lưu 350 và -10 thành hai giá trị khác nhau
  thì hai hộp trông y hệt lại so sánh không bằng nhau.
- **KHÔNG đo lại hộp khi xoay.** `a.w`/`a.h` vẫn là cỡ hộp **thẳng**; góc chồng lên trên.
  Đo lại thành hộp bao đã xoay thì lần xoay sau áp lên hộp **đã xoay rồi** ⇒ hộp phình
  không giới hạn.
- **Chọn và kéo không cần thêm phép tính nào:** hit-test ở đây là
  `e.target.closest(".an")`, nên trình duyệt tự thử hình **đã xoay**; còn kéo là phép tịnh
  tiến, bất biến với góc. Đây là lý do tính năng này rẻ, và nó chỉ đúng chừng nào hit-test
  còn dựa vào DOM — chuyển sang hit-test hình học thì **phải** xoay ngược con trỏ trước.
- **Transform của overlay là MỘT chuỗi.** `charScale` từng là writer duy nhất của
  `el.style.transform`; thuộc tính này **không cộng dồn**, nên gán hai lần là mất cái đầu.
  Và tâm (từ v0.2.79: **tâm raster**, `textRotationPivot` — xem BI-110) được viết thẳng ra bằng `translate·rotate·translate` chứ **không** đổi
  `transform-origin` sang `50% 50%`: phần tử đã bị **nới rộng** `1/charScale`, nên 50% của
  nó không phải tâm người dùng nhìn thấy.
- **Vỡ khi:** xoay hộp rồi Lưu → mở lại **thẳng lại** (quên `rot` trong payload) · chữ
  xoay xong **trôi** khỏi chỗ cũ (chia `ox`/`oy` không đều) · xoay 45° rồi xoay tiếp thì hộp
  **to dần** (đo lại hộp) · gõ lại nội dung thì ô nhập **thẳng** trong khi chữ nghiêng ·
  hộp có `charScale` khác 1 thì xoay xong **lệch ngang**.
### BI-71 · Nền hộp văn bản: khung `<div>` và khung PNG **lệch nhau đúng `pad`** — đừng dùng `el.style.background`
- `editor.js` `renderAnnot` (nhánh `text`, khối `.an-text-bg`) ghi phía màn hình;
  `renderTextPng` ghi phía PDF. `app.css` `.an-text { z-index: 0 }` + `.an-text-bg`.
- **Số đo, đừng suy luận lại** (chạy trên chính `annot-text.js`, chữ 16pt):
  ```
  element box (màn hình) : left = a.x + 0.00   w = 93.00   tâm = a.x + 46.50
  raster  box (PNG bake) : left = a.x − 2.40   w = 93.33   tâm = a.x + 44.27
  ```
  Cùng **kích thước**, lệch đúng `pad = fontSize × 0.15`. Lý do: chữ trên màn hình vẽ từ
  **góc trên-trái** của `<div>` (`.an-text` không có padding), còn trong PNG chữ thụt vào
  `pad` cả 4 phía và bake bù bằng cách đặt ảnh ở `a.x − padPt`.
- **Vì thế nền là một `<div>` LÓT đặt ở `(−pad, −pad)` cỡ `a.w × a.h`**, không phải
  `el.style.background`. Đo lại toàn bộ trên Chromium thật: sai lệch **tệ nhất 0.333pt**
  (đúng bằng 1/RS — hạt của phép `ceil`), tức mắt thường không thấy.
- **Ba chi tiết không được bỏ:**
  · `z-index: -1` chỉ nằm yên trong hộp chữ vì `.an-text` có `z-index: 0` → nó **tự tạo
  stacking context**; bỏ dòng đó thì nền chui xuống dưới canvas trang và **biến mất**.
  · Dưới `charScale`, cả `left` lẫn `width` của lớp lót phải **chia trước** cho charScale
  (phần tử cha đang bị `scaleX`).
  · Trong raster, `globalAlpha = s.opacity` phải đặt **trước** `fillRect`, và độ mờ của
  nền đi trong chuỗi `rgba()` — hai cái **nhân nhau**, vì trên màn hình `el.style.opacity`
  làm mờ **cả** chữ lẫn nền.
- **`text` vào `FILLABLE_KINDS`, TUYỆT ĐỐI KHÔNG vào `isVectorKind`** — cái sau lái sang
  `shapeAppearance()` (appearance vector); nền hộp chữ nằm trong PNG.
- **Bố cục chữ không được biết đến cái nền.** `normTextStyle` dựng object từ danh sách
  trường cố định nên nó **rơi** `fill`/`fillOpacity` — đó là thứ bảo đảm một mảng nền
  không bao giờ đẩy được một glyph (BI-40). Có ca canh gác trong `test:text`.
- **Vỡ khi:** mép nền trên màn hình lệch ~3px so với file PDF · nền biến mất hẳn (mất
  `z-index: 0`) · nền đặc trong khi chữ mờ · hộp có `charScale` thì nền thừa/thiếu bề ngang
  · file cũ mở ra tự mọc nền đen (ghi `fill: "none"` vào `/NabuData` thay vì bỏ khoá).
- Lưới: `npm run test:managed` (rect nền trong raster + round-trip `/NabuData`) ·
  `npm run test:text` (nền không đụng layout) · `npm run test:defaults` (hộp mới **không**
  nền, và ba handler đi qua `fillSlotFor`).

### BI-72 · Kho trang ẩn: `/NabuVault` trên **PAGE DICT** — không bao giờ `/NabuKind`, không bao giờ catalog
- `renderer/page-vault.js`; UI ở `app.js` (`scanVaultPages`, `hidePagesWithPassword`,
  `unhidePagesWithPassword`, `exportWithoutHiddenPages`).
- **Đo được trên pdf-lib 1.17.1 — bảng này là lý do tồn tại của thiết kế:**

  | Nơi cất blob | save→load | **reorder trang** | xoá trang khác | ghép/chèn |
  |---|---|---|---|---|
  | catalog (`/Root`) | ✅ | ❌ **MẤT** | ✅ | ✅ |
  | page dict | ✅ | ✅ | ✅ | ✅ |

  Cột giữa là `reorderPages()` (`app.js`) — nó dựng lại tài liệu bằng
  `PDFDocument.create()` + `copyPages()` và **bỏ lại catalog cũ**. Tức là kéo-thả sắp xếp
  một cái là bay sạch trang ẩn, không một dòng lỗi nào.
  *(2026-10-05: `reorderPage` nay di chuyển **tại chỗ** — BI-96 — nên catalog sống sót. Luật
  ở đây **vẫn đứng**: bake có redact, tách/trích trang, N-up, gộp file vẫn dựng lại như cũ.)*
- **Không được đặt tên khoá là `/NabuKind`:** `stripManagedFromPage` xoá **mọi** annotation
  mang khoá đó, và nó chạy ở **mỗi lần bấm Áp dụng**. Chú thích lên trang giữ chỗ là mất
  kho. Vì thế kho nằm trên **page dict** (không phải annotation) với **namespace riêng**.
- **1 trang ẩn = 1 trang giữ chỗ.** Số trang **không đổi** — đó là thứ giữ cho blob **đi
  theo trang của nó** qua reorder/ghép/tách/chuyển tab, và giữ cho “trang 7/12” vẫn là 7/12.
- **Vỡ khi:** kéo sắp xếp trang xong thì không bỏ ẩn được nữa · chú thích lên trang giữ chỗ
  rồi Áp dụng thì trang ẩn biến mất · badge 🔒 hiện sai thumbnail sau khi xoá/ghép trang.
- Lưới: `npm run test:vault` (V4 = reorder, V5 = removePage, V6 = merge, V7 =
  `stripManagedAnnots`).

### BI-73 · Đường đọc kho trang ẩn **phải chịu được `/Filter /FlateDecode`** — luật BI-37 không áp dụng ở đây
- `page-vault.js` `readVaultBytes`.
- **Đo được:** ta ghi stream **không filter**; sau **bất kỳ** vòng sidecar nào
  (`/add-page-numbers`, `/edit-text`, `/compress`, Tìm & Thay thế — tất cả đều
  `doc.tobytes(deflate=True)`) nó quay về là
  `<< /NabuFmt /vault /Length n /Filter /FlateDecode >>`.
- BI-37 dạy “có `/Filter` ⇒ không tin, bỏ qua”. Ở **ảnh** thì hậu quả là “ảnh thành chỉ
  đọc” — chấp nhận được. Ở **trang ẩn** thì hậu quả là **mất trang vĩnh viễn**. Nên ở đây
  phải **tự giải nén** bằng `DecompressionStream("deflate")` (đã đo là có trong renderer
  `file://` lẫn node). Filter **lạ** thì báo lỗi rõ và **không xoá gì**.
- **Luật chung rút ra:** “không đọc được ⇒ để nguyên”, không bao giờ “không đọc được ⇒ dọn đi”.
- **Vỡ khi:** ẩn trang → Đánh số trang → không bỏ ẩn được nữa.
- Lưới: `npm run test:vault` V8 (Flate) + V9 (filter lạ, phải giữ nguyên trang giữ chỗ).

### BI-74 · Ẩn trang phải **xoá lịch sử hoàn tác và ghi đè bản phục hồi** — nếu không, bản rõ vẫn nằm trên đĩa
- `app.js` `hidePagesWithPassword` → `resetHistory()` + `scrubRecoverySnapshot()`.
- `pushUndo()` giữ snapshot bytes **trước khi ẩn** trong RAM, và `autosaveTick` đã có thể
  **ghi nó xuống thư mục recovery**. Ẩn xong mà không dọn thì trang “đã ẩn” vẫn còn nguyên
  bản rõ ở hai chỗ — với một tính năng bán ra dưới chữ “mật khẩu” thì đó là lỗi, không phải
  chi tiết.
- **Đây là ngoại lệ có chủ ý của BI-3.** Mọi thay đổi `state.bytes` khác đều phải qua
  `pushUndo()` trước; đường này **cố ý không**, và bù lại bằng `markDirty` thủ công
  (`state.dirty = true` + `updateDirtyIndicator()`) để chấm ●, guard đóng và autosave vẫn
  biết file đã đổi. Hộp thoại **nói trước** rằng Ctrl+Z sẽ không hoàn tác được.
- **Bỏ ẩn thì ngược lại**: nó đưa bản rõ trở lại **có chủ đích**, nên `pushUndo()` chạy
  bình thường, đúng BI-3.
- **Ngoài tầm với, phải nói thật với người dùng:** file gốc trên đĩa (chưa lưu đè), Windows
  shadow copy, bản in.
- **BI-137:** `scrubRecoverySnapshot` nay gửi `scrub:true` ⇒ main XOÁ `autosave.pdf` cũ và mọi `*.nabu-tmp` sót TRƯỚC khi ghi bản đã niêm (vì ghi nguyên tử giữ bản cũ tới phút chót — chính là bản rõ). Ghi lỗi sau đó ⇒ khe TRỐNG, không phải khe còn bản rõ.
- **Vỡ khi:** ẩn trang xong, mở file recovery trong `userData` vẫn thấy trang gốc · ẩn xong
  bấm Ctrl+Z ra lại trang gốc.
- Lưới: máy không kiểm được — probe renderer (`vault-drive.js` mẫu ở phiên v0.2.64) khẳng
  định `#btn-undo` bị vô hiệu và `recovery.save` đã chạy lại sau khi ẩn.

### BI-75 · Ô kiểu chữ **không được chốt** hộp gõ chữ — và vì thế `renderLayer` phải **cõng** hộp gõ qua lần dựng lại
- `editor.js`: `PALETTE_KEEP_SEL` / `inPalette` · `renderLayer` (khối `keep`) ·
  `openTextEditor` (`paint`, `ta.addEventListener("blur", …)`, `clearTaHooks`) ·
  `fillTargetAnnot` / `applyFillToSel` · listener uỷ quyền trên `#edit-bar, #fmt-panel`.
- **Vấn đề gốc (v0.2.64):** ba ô Nền là `<input>` thường. `mousedown` vào chúng làm
  textarea `blur` → `commit()` chạy → hộp được tạo bằng **nền CŨ**, giá trị vừa chọn chỉ
  ăn vào hộp **kế tiếp**. Kéo thanh `%` sau đó không thấy gì vì `applyFillToSel` thoát
  ngay khi `ed.sel == null`, mà đường tạo hộp văn bản **không** set `ed.sel`.
- **Đừng “khôi phục” mẹo `mousedown → preventDefault()`** của các nút B/I/U ở đây: trên
  `input type=range` nó **giết luôn cú kéo**, trên `input type=color` nó có thể **chặn hộp
  chọn màu mở ra**. Chỗ đúng là **handler `blur`**, lọc theo `e.relatedTarget`.
- **Hệ quả bắt buộc, và đây là phần dễ mất dữ liệu:** `renderLayer` làm
  `layer.innerHTML = ""`, còn hộp gõ chữ là **con của layer đó**. Xoá một phần tử đang
  focus **không phát `blur`** trong Chromium ⇒ `commit` không bao giờ chạy ⇒ **mất chữ
  đang gõ, không annot, không bước undo, không một dòng lỗi**. Trước v0.2.65 không ai
  chạm vào vì mọi đường ra khỏi textarea đều chốt trước. Nay focus có thể sang palette mà
  **không** chốt, nên bất kỳ `syncOverlays()` phát từ một ô kiểu chữ đều rơi vào đây giữa
  lúc gõ. `innerHTML = ""` chỉ **tháo rời**: node, `value`, vùng chọn và listener đều còn
  sống nhờ tham chiếu `keep` — nhưng **focus thì không**, nên phải `focus()` +
  `setSelectionRange()` lại, không thì con trỏ nhảy về `<body>` (hoặc về cuối chuỗi).
- **`#edit-bar [data-ctl]`, KHÔNG phải `#edit-bar`:** `#ed-tools` nằm **bên trong**
  `#edit-bar`, Copy / Dán / Áp dụng cũng vậy. Nới thành `#edit-bar` là mất chữ ở **mỗi
  lần đổi công cụ** và ở **mỗi lần bấm Áp dụng**.
- **Mục tiêu của ba ô Nền khi hộp gõ đang mở là `ed._taAnnot`, không bao giờ là `ed.sel`:**
  `setTool` không deselect, nên lựa chọn cũ sống qua lần đổi công cụ và **bản thân nó có
  thể cũng là một hộp văn bản** — không phép kiểm `kind` nào phân biệt được. Hộp gõ đang
  mở thì nó **sở hữu** ba ô đó; hộp mới chưa tồn tại thì mục tiêu là **không có gì**.
- **Vỡ khi:** gõ chữ → bỏ tick “Không nền” → hộp đóng lại và vẫn trong suốt · gõ chữ →
  đổi cỡ chữ → **chữ đang gõ biến mất** · gõ giữa từ → kéo thanh Mờ nền → phần gõ tiếp
  nhảy xuống cuối · đổi công cụ giữa lúc gõ → mất chữ.
- Lưới: `npm run test:defaults` nhóm “the Nền controls survive an open text editor”
  (16 ca, đều là canh-gác: ba ca then chốt đã được kiểm là **đỏ** khi hoàn nguyên bản sửa).

### BI-76 · Ba ô nền: **control là sự thật của vật thể ĐANG SỬA, `ed[slot]` là sự thật của vật thể SAU** — và 0% với ô tick là **một** trạng thái
- `editor.js`: `clampFillPct` · `FILL_ON_FROM_ZERO_PCT` · `setFillPctCtl` · `setFillOn` ·
  `fillFromCtls` · `applyFillToSel` · `onFillColorInput` / `onFillNoneToggle` /
  `onFillOpacityInput`; cộng nhánh `FILLABLE_KINDS` trong `syncControls` (chiều ngược:
  vật thể → control). Nối tiếp BI-75 (mục tiêu là ai) và BI-71 (hình học của lớp lót).
- **Hai nửa của sự thật, đừng trộn:**
  · `syncControls()` khi chọn một vật thể chỉ ghi **DOM** — cố ý: `ed[slot.*]` là **mặc
  định cho vật thể tiếp theo**, đúng cùng lằn ranh mà `#ed-color` giữ.
  · Vì thế `applyFillToSel()` phải đọc **`fillFromCtls()`** (ba control), **không** đọc
  `ed[slot]`/`effFill()`. Đọc `ed[slot]` là lỗi đã ship ở v0.2.64 **và còn nguyên ở
  v0.2.65**: chọn một chữ nhật nền **vàng 40%**, tick rồi bỏ tick ô nền → vật thể quay lại
  **TRẮNG 100%** trong khi ô màu vẫn hiện vàng và slider vẫn hiện 40%. Mất dữ liệu, và
  thanh công cụ nói dối về việc đó.
  · Ngược lại, `effFill()`/`effFillOpacity()` **vẫn phải sống** — chúng là đường **tạo
  mới** (4 chỗ: `text`, nhánh shape, `cloudpen`, và `taFillPreview` cho hộp chưa tồn tại).
  Xoá chúng “vì handler không dùng nữa” là làm mọi vật thể mới ra **không có nền**.
  · Đây cũng là luật `refreshFillSwatch` đã theo từ v0.2.65 (“đọc control, không đọc
  `ed.*`”) — nay ba handler theo cùng một luật, nên chip, con số và vật thể không thể
  nói ba chuyện khác nhau.
- **0% và ô “Không nền” là MỘT trạng thái, không phải hai.** Không có trạng thái thứ ba
  “có nền, alpha 0”: nó vô hình mà ô tick lại báo “đang có nền” — đúng cái làm ô tick
  trông như bản sao vô dụng của slider (khiếu nại thật của người dùng, 2026-08-29).
  · kéo slider về 0 ⇒ **tự tick** + `ed[slot.on] = false` + vật thể nhận `fill: "none"`;
  · bỏ tick khi slider đang ở 0 ⇒ nâng lên `FILL_ON_FROM_ZERO_PCT` (100%) — “bật nền” thì
  phải **thấy** nền;
  · `syncControls` cũng tick khi `pct === 0`. **Nhưng biến `none` phải giữ nghĩa hẹp**
  (“không có `fill` nào”), vì dòng ngay dưới nó — `$("ed-fill").value = none ? … : a.fill`
  của v0.2.65 (F3) — phụ thuộc vào nghĩa hẹp đó.
- **HAI số 0 khác nhau, phải dọn riêng.** Slider là thứ **vật thể đang sửa** sắp nhận;
  `ed[slot.opacity]` là thứ **vật thể sau** sắp nhận. Cửa hông: kéo về 0% (nhớ 0), chọn
  vật thể khác đang 70%, bỏ tick → slider không ở 0 nên không nâng, nhưng **số 0 đã nhớ**
  còn đó ⇒ chữ nhật vẽ tiếp theo ra vô hình mà ô tick lại trống. `setFillOn` nâng **từng
  số 0 một**, nên dọn cái đã nhớ không bao giờ âm thầm sơn lại vật thể trên màn hình.
- **Ô tick là nút MUTE, không phải slider thứ hai.** Đó là toàn bộ lý do nó tồn tại: tick
  là tắt hẳn, bỏ tick là bật lại **đúng màu và đúng độ mờ đang hiện** — thử có/không nền
  mà không mất giá trị đã chọn. Nhãn là **“Không nền”**, không phải “Trong suốt”: cái tên
  cũ đọc như một **mức** của **Mờ nền**, và đó chính là chỗ hiểu nhầm.
- **Ba handler phải là hàm CÓ TÊN.** Tới v0.2.65 chúng là thân arrow inline, nên
  `test:defaults` không gọi được và cả hai lỗi trên nằm ngoài mọi lưới. Bọc lại thành
  arrow inline là làm mù lưới lần nữa.
- **Handler không tự vẽ lại chip hay nền hộp gõ.** Listener uỷ quyền trên `#edit-bar`
  (BI-75) làm việc đó sau **bất kỳ** thao tác palette, và nó **nổi bọt SAU** handler của
  chính phần tử — nên nó thấy vật thể đã cập nhật. Thêm `refreshFillSwatch()` vào từng
  handler là đúng cái drift mà listener uỷ quyền sinh ra để tránh.
- **Vỡ khi:** tick rồi bỏ tick trên vật thể đang chọn → nền ra **màu khác** với màu ô
  swatch đang hiện · slider ở 0% mà ô “Không nền” vẫn trống · vẽ vật thể mới ra **vô hình**
  · chip caro và con số % nói khác nhau.
- Lưới: `npm run test:defaults` §4c (chạy **thật** ba handler trên DOM giả + mục tiêu giả,
  gồm ca canh gác quét **36 tổ hợp** trạng thái×hành động) và §4d (nhãn + tooltip khớp
  từ điển i18n). Đã kiểm bằng cách **hoàn nguyên cả ba nửa của bản sửa** → 11 ca đỏ, kể cả
  đúng con số `#ffffff` của vụ mất dữ liệu.

### BI-77 · Clipboard liên-tab: main chỉ được **ĐẨY** vào `clip`, **không bao giờ được hỏi** lúc dán — và clip nhận từ tab khác mang `page: -1`
- `main.js`: `objClip` · `annots:clip-write` / `annots:clip-read`; `preload.js`:
  `writeAnnotClip` / `readAnnotClip` / `onAnnotClipChanged`; `editor.js`: `SHARE_EXCLUDED` ·
  `isShareableKind` · `shareClip` · `adoptSharedClip` · `requestPaste`. Lưới `npm run test:clip`.
- **Quyết định phải ĐỒNG BỘ, việc thì được async.** `editor.js` giành cử chỉ `Ctrl+V`
  bằng `preventDefault()` **ngay trong** sự kiện `paste`, đọc `clip` ở module scope. Luật
  bàn giao với đường dán-ảnh của `capture.js` (“có ảnh trên clipboard OS thì bỏ qua, không
  `preventDefault`”) **dựa hoàn toàn** vào chỗ này chạy đồng bộ.
  · Đổi thành `await window.desktop.readAnnotClip()` là hỏng: câu trả lời về **sau** khi
  sự kiện đã bubble sang `capture.js` → `Ctrl+V` khi thì dán hai lần, khi thì không dán gì,
  **tuỳ thời điểm**. Không có exception nào ném ra.
  · Vì thế main **chỉ broadcast** (`annots:clip-changed`) và `adoptSharedClip` ghi thẳng
  vào chính biến `clip`. Nhờ vậy **mọi** chỗ đọc cũ — guard của listener `paste`, nút
  “Dán”, bản thân `pasteClip` — **không phải sửa một dòng nào**. Đó là lý do bản vá này
  không đụng vào logic dán sẵn có.
  · `readAnnotClip` **chỉ** được gọi một lần lúc renderer khởi động (cho tab mở **sau**
  khi copy, vốn không nhận được broadcast). Gọi nó trong `pasteClip`/`requestPaste` là tái
  phạm — lưới §3 của `test:clip` canh đúng chuyện đó, kể cả `paste` listener bị đổi thành
  `async`.
  · `requestPaste` là chỗ **duy nhất** được `await`, và chỉ để **làm việc** (bật Chỉnh sửa),
  không bao giờ để **quyết định** — lúc nó chạy thì `preventDefault()` đã gọi xong. Sau
  `await enter()` phải **kiểm lại** `ed.active` + `clip`: người dùng có thể đã bấm Escape,
  hoặc tab khác đã xoá clip, trong lúc `importManaged()` còn đang chạy.
- **`page: -1` là số học, không phải giá trị canh gác cho vui.** `pasteClip` lệch
  `PASTE_STEP` khi dán **đúng trang nguồn** (`i === clip.page`) để bản sao không nấp hoàn
  toàn dưới bản gốc. Clip đến từ **tài liệu khác** không có bản gốc nào trên trang này, nên
  giữ `srcPage` sẽ khiến trang 0 của file B bị nhầm là trang nguồn của file A → **mọi** lần
  dán liên-tài-liệu lệch 12pt khỏi chỗ người dùng đã copy. `-1` không bao giờ là chỉ số
  trang, nên nhánh đó chết hẳn và bản dán rơi đúng toạ độ gốc.
- **Ảnh qua tab từ v0.2.72 — nhưng KHÔNG được broadcast.** Ảnh mở lại là chuỗi base64
  **nhiều MB** (xem `edSnapshot`); đẩy nó tới **mọi** tab ở **mỗi** `Ctrl+C` là cái giá đã bị
  từ chối từ đầu, và vẫn bị từ chối. main giữ clip **đầy đủ** (`objClip` + `id`) nhưng phát đi
  `lightClip()` — ảnh bỏ `dataUrl`, gắn `_pending`, clip gắn `heavy`. Tab dán lấy pixel **một
  lần** qua `annots:clip-fetch` trong `hydrateClip()`, gọi từ `requestPaste` **sau** khi quyết
  định đã xong. Luật đồng bộ ở trên **không đổi một chữ**: listener `paste` vẫn chỉ đọc
  `clip.items.length`, và clip `heavy` quyết định y hệt clip nhẹ. `pasteClip` **từ chối** clip
  còn `heavy` (chốt chặn cuối). `hydrateClip` phải kiểm `clip !== c` sau `await` — một lần copy
  mới đến giữa chừng thì dán **cái mới**, không bao giờ đè pixel cũ lên clip mới.
  Trần `SHARE_IMAGE_CAP` cho **một** lần copy: vượt thì **tất cả** ảnh ở lại (không bao giờ một
  tập con tuỳ ý), toast nói rõ.
  Một lần copy **không có** mục nào chia sẻ được thì **XOÁ** clip chung, không để clip cũ
  đứng lại — nếu không, tab khác sẽ lặng lẽ dán thứ người dùng đã copy từ hai thao tác trước.
- **"Lần copy gần nhất thắng", không phải "ảnh OS luôn thắng" (v0.2.72).** Luật bàn giao cũ
  nhường `Ctrl+V` cho `capture.js` hễ clipboard OS có ảnh — mà copy đối tượng thì **không
  đụng** clipboard OS. Luồng thường gặp nhất vì thế hỏng: chụp màn hình → dán vào trang →
  chỉnh cỡ → `Ctrl+C` → `Ctrl+V` = dán lại **ảnh chụp gốc cỡ mặc định** (và với **mọi** đối
  tượng khác nữa, hễ clipboard OS còn ảnh). Nay listener `copy` ghi `NABU_CLIP_MIME`
  (`application/x-nabu-annots`) vào clipboard OS — Chromium **làm rỗng** clipboard trước khi
  ghi, nên ảnh cũ mất — và listener `paste` coi dấu đó là **của mình**. Ảnh copy ở đâu đó
  **sau** thì thay dấu ⇒ `capture.js` thắng, đúng như luật bàn giao yêu cầu.
  · **Mọi** đường copy phải đi qua `copyGesture()` (nút, menu chuột phải, `Ctrl+C` dự phòng ở
  keydown): nó gọi `document.execCommand("copy")` — **đã đo** trên Chromium 152 là phát sự
  kiện `copy` kể cả khi không có vùng chọn chữ — nên dấu được ghi dù đường nào chạy. Gọi thẳng
  `copySelected()` từ một đường mới là **tái phạm**: đối tượng vẫn copy được nhưng ảnh cũ lại
  cướp `Ctrl+V`. Lưới `test:clip` §3 canh cả ba đường.
  · Hệ quả chấp nhận: copy một đối tượng trong Nabu **thay** nội dung clipboard Windows (như
  Copy ở mọi app). Dán sang Word lúc đó không ra gì.
- **Toạ độ vốn đã liên-tài-liệu**, đó là lý do việc này rẻ: annot nằm trong không gian
  **điểm PDF scale-1** (`editor.js` §đầu file, đo lại ở `layer.dataset.w = cw / state.scale`),
  nên trang đích chỉ tham gia qua khổ giấy `pw/ph` — và `fitShift(unionBounds(...))` đã kẹp
  biên đúng từ v0.2.52. “Dán sang tài liệu khác” **bằng đúng** “dán sang trang khác”.
- Đã kiểm bằng **mutation test**: đổi `page: -1` → `srcPage` ⇒ 2 ca đỏ; đổi guard của
  `paste` thành `await readAnnotClip()` ⇒ 2 ca đỏ. Ca định vị listener cũng khẳng định thân
  hàm **khác rỗng**, vì bản đầu tiên của lưới này *pass giả* khi regex trượt CRLF.
  v0.2.72: phát `objClip` đầy đủ thay vì `lightClip` ⇒ 4 ca đỏ; bỏ dòng `c.items = full`
  trong `hydrateClip` ⇒ 1 ca đỏ. Nghiệm thu GUI trên app thật (CDP, 2 tab): ảnh copy ở tab A
  dán sang tab B **có pixel**; ảnh không kèm dấu ⇒ luồng đặt ảnh; có dấu ⇒ clip thắng.

---

### BI-78 · Bitmap trang phải có **hạn mức pixel** — quá 268 MP Chromium trả về **trang trắng, không lỗi**
- `app.js`: `MAX_VIEW_MEGAPIXELS` / `MAX_VIEW_SIDE_PX` / `viewRasterDpr` (cạnh `KEEP_MARGIN_PX`)
  và **ba dòng** dùng nó trong `renderPageCanvas` (`rd`, `pw`/`ph`, `transform`).
- **Số đo** (Chromium 148, đúng `vendor/pdf.min.js` đang ship — chi tiết + cách chạy lại probe
  ở `docs/RESEARCH-2026-09-07-zoom-range-20-500.md`):
  - vượt **area ≈ 268 MP** (`2^28`, đo được 267,96): Chromium **vẫn nhận** `canvas.width`,
    **vẫn** trả về `2d context`, `page.render` **vẫn resolve** (~7 ms) và **không ném lỗi** —
    nhưng **không vẽ gì**. Đọc lại pixel ra `[0,0,0,0]`.
  - vượt **cạnh 16 384 px** (giới hạn texture Skia): rơi khỏi đường GPU, cùng một lượt vẽ đi
    từ 36 ms → **305 ms** (A0 ở 500%: **1 624 ms**).
  - A0 · dpr 1,5 ở **300%** — tức **trần cũ** — đã là **621 MB một trang**. Lỗ hổng này có
    **trước** khi nới dải zoom, không phải do nới mà sinh ra.
- **Vì sao `try/catch` trong `renderPageCanvas` KHÔNG cứu được:** nó chỉ bắt exception, mà ở đây
  không có exception nào. Code đi tiếp, gán `canvas.width = pw` (**xoá bitmap cũ đang hiển thị**),
  blit một offscreen rỗng, rồi gán `m.paintScale = state.scale` ⇒ `commitScale` coi trang đó **đã
  nét** và **không bao giờ** vẽ lại. Người dùng thấy **trang trắng vĩnh viễn**, không thông báo,
  không một dòng console.
- **Luật:** hạn mức kẹp **độ phân giải thiết bị** (`rd`), **không** kẹp CSS box. Hình học trang,
  `.text-layer`, lớp chú thích, `m.paintScale` và hình học cuộn **giữ nguyên** ở tỷ lệ đầy đủ —
  đúng như BI-36 yêu cầu. Chỉ pixel là thô hơn, và chỉ ở những ca mà **không kẹp là trắng trang**.
- **Không** thay hạn mức bằng “đọc lại một pixel để kiểm tra”: đọc lại một canvas 32 MP là một cú
  đồng bộ GPU→CPU trên main thread, đắt hơn nhiều lần cái nó phát hiện. Hạn mức là hằng số nên
  **chứng minh được** bitmap không thể vượt giới hạn, khỏi cần kiểm tra lúc chạy.
- **Không** giải bằng cách “chọn trần zoom thấp cho an toàn”: giấy đủ lớn thì **trần nào cũng**
  vượt 268 MP (A0 vỡ ngay ở **400%**). Trần và hạn mức là hai việc khác nhau.
- `viewRasterDpr` **không bao giờ** trả về lớn hơn `dpr` thật — rasterise trên độ phân giải màn
  hình chỉ tốn bình phương mà không nét thêm.
- Bước của nút ±/Ctrl± là **phép nhân** (`ZOOM_STEP_BASE = 1.25`), cùng lý do với
  `wheelZoomFactor`: `±0.2` cố định là **+100% tương đối** ở sàn 20% và **+4%** ở gần trần 500%.
  Zoom ra là **chia**, không phải nhân với `2 - base`, để vào-rồi-ra là một vòng khép kín.
- Ba chỗ chữ quảng cáo dải zoom (`index.html` title · **key VÀ value** của nó trong `i18n.js` ·
  `help.js` hai ngôn ngữ) được `npm run test:geom` **so trực tiếp với `ZOOM_MIN`/`ZOOM_MAX`**.
  Key của i18n **chính là** chuỗi tiếng Việt trong markup: sửa markup mà quên key thì bản tiếng
  Anh **âm thầm** hiện tiếng Việt (`t()` trả lại chính đầu vào, không báo lỗi).
- **Vỡ khi:** trang trắng ở mức zoom cao trên bản vẽ A0/A1 (nhưng zoom xuống là hiện lại) ·
  zoom cao thấy khựng ~0,3 s mỗi trang · RAM renderer nhảy vài trăm MB mỗi trang · tooltip ô zoom
  nói một dải khác với dải app thật sự nhận.
- Lưới: `npm run test:geom` (nhóm “viewRasterDpr” + nhóm chữ) — thử **cố tình** đổi `ZOOM_MAX`
  thành `6` thì phải **đỏ 5 ca**, gồm cả ba ca chữ.

---

### BI-79 · Chia đôi màn hình: khung xem thuộc **CỬA SỔ**, không thuộc **TAB** — và hình học chỉ có **một** hàm
- `src/tabs.js`: `splitRects()` (thuần) · `solveWidths` · `MAIN_MIN_W = 620` / `MAIN_HARD_MIN_W = 420`
  / `VIEW_MIN_W = 260` / `VIEW_HARD_MIN_W = 180` / `SPLIT_GUTTER = 6` · `_rects()` ·
  `viewPaneScreenRects()` · `addViewPane` / `closeViewPane` / `setPaneRatios`.
- **Luật 1 — pane thuộc cửa sổ.** `viewPanes` nằm trên `TabbedWindow`, **không** trên tab. Nhờ vậy
  `activateTab` · `destroyTab` · `detachTab` · `moveTabTo` · `tearOutTab` · `adoptTab` · `closeTab` ·
  `Ctrl+W` · `Ctrl+Tab` · `activeContents` **không cần biết pane tồn tại**. Gắn pane vào tab thì cả
  vòng đời tab phải học lại — và đó là chỗ hỏng sẽ xuất hiện dưới dạng "kéo tab sang cửa sổ khác
  làm mất khung xem" hoặc "đổi tab thì tab mới đè lên khung xem".
- **Luật 2 — một hàm hình học.** `_layout()` và **mọi** hit-test đều đi qua `_rects()` → `splitRects()`.
  Đọc bố cục bằng số học khác ở chỗ khác là đưa **pixel trên màn hình** và **vùng bắt chuột** ra
  khỏi nhịp nhau; `docViewScreenRect` đã ghi đúng luật đó từ trước khi có tính năng này.
- **Luật 3 — khung xem chỉ đọc, và đó là LỜI GIẢI chứ không phải hạn chế.** Chỉ khung chính ghi
  được ⇒ mở **cùng một file** ở hai khung không thể thành "bản lưu này đè mất bản lưu kia".
  `src/view-preload.js` phải giữ **bề mặt tối thiểu**: không `dialog:save-*`, không `file:write-pdf`,
  không `recovery:*`, không sidecar. Thêm bất kỳ kênh ghi nào vào đó là **xoá** bảo đảm này.
- **Luật 4 — `MAIN_MIN_W` là số ĐÃ ĐO, không phải số chọn cho đẹp.** Ở 420px thanh công cụ khung
  chính ăn **49%** chiều cao; ở 380px trang **tràn ngang**. Số đo ở
  `docs/RESEARCH-2026-09-08-split-view.md` §10.3. Bản kế hoạch đầu đoán 420 và **phép đo đã bác bỏ**.
- **Luật 5 — chrome view phủ HẾT cửa sổ khi chia khung.** Đó là điều kiện để dải rãnh 6px nhận được
  chuột mà không cần thêm tiến trình hay lớp phủ trong suốt (probe P-A). Chrome view phải ở **đáy**
  z-order: nó được `addChildView` **một lần** trong constructor và **không bao giờ** thêm lại —
  `addChildView` trên một child đã có sẽ **đẩy nó lên trên cùng** và chôn mọi tài liệu sau nó.
- **Luật 6 — đóng pane thì HUỶ hẳn `webContents`.** Ngược hẳn BI-15/BI-16 (tab bị detach không bao
  giờ được đóng vì nó sắp sang cửa sổ khác). Pane không giữ việc chưa lưu, mà một tiến trình
  renderer tốn **~80 MB chỉ để tồn tại** ⇒ để lại là rò rỉ theo số lần từng chia khung.
- **Luật 7 — kéo rãnh KHÔNG được gọi `_emit()`.** `_emit` dựng lại toàn bộ DOM thanh tab, kể cả tay
  nắm đang giữ `setPointerCapture` ⇒ phiên kéo chết ngay frame đầu. Đường đúng: `setPaneRatios` →
  `_layout()` → đẩy **`split:geom`** (chỉ hình học) → thanh tab **chỉ đặt lại vị trí** tay nắm. Và
  `lostpointercapture` + `pointercancel` **bắt buộc** kết thúc phiên kéo (BI-58).
- **Luật 8 — thanh tab KHÔNG được chép các hằng số sàn.** Nó gửi tỷ lệ thô; main kẹp bằng
  `solveWidths` rồi trả lại hình học thật. Chép sàn sang renderer là tạo bản sao thứ hai của một
  con số đã đo, và hai bản sao đó sẽ lệch nhau.
- **Vỡ khi:** đổi tab lúc đang chia khung thì tab mới **đè lên** khung xem · kéo trang từ cửa sổ
  khác rơi lệch **đúng bằng bề rộng khung chính** · một dòng desktop nhấp nháy giữa hai khung (làm
  tròn bề rộng lẻ không dùng largest-remainder) · tay nắm rãnh **rời khỏi** biên thật khi kéo tới
  sàn · kéo rãnh một cái là hết kéo được (DOM bị dựng lại) · mỗi lần chia khung rồi đóng lại tốn
  thêm ~80 MB vĩnh viễn.
- Lưới: `npm run test:split` (306 ca hình học thuần) · `npm run test:pagedrop` (82 ca) ·
  `npm run test:tabs` (120 ca, có nhóm phiên) · probe Electron `scratchpad/probe-split2` (42/43,
  ca đỏ duy nhất là môi trường — xem §12 của memo).

### BI-80 · Khung xem **từ chối** trang thả vào — và "từ chối" khác "không có gì ở đây"
- `src/tabs.js` `classifyPageDrop` (giá trị `readonly`) · `pageDropTargets()` (khoá `panes`) ·
  `renderer/page-move.js` `dragEnd` (nhánh toast).
- **Luật:** một trang thả trúng khung xem phải trả về `readonly` và **nói ra**; thả trúng rãnh /
  dải tab / ra ngoài mọi cửa sổ vẫn là `none` và vẫn **im lặng**. Cùng là "không có gì xảy ra"
  nhưng ý nghĩa ngược nhau: cái sau là cách bình thường để **huỷ** một cú kéo, cái trước là một cử
  chỉ nhắm vào vùng hình-dạng-tài-liệu — im lặng ở đó người dùng đọc là **lỗi**.
- **Luật — phép giải nằm ở hàm THUẦN, không ở hit-test từng cửa sổ.** "Điểm này thuộc mặt phẳng
  nào" là câu hỏi về **tất cả cửa sổ cùng lúc**: chúng chồng nhau và cái ở **trên** thắng (luật
  `z` đã có sẵn trong `classifyPageDrop`). Gọi một hit-test lần lượt từng cửa sổ sẽ trả lời **sai**
  đúng ca chồng lấn — khung xem của cửa sổ trước che tài liệu của cửa sổ sau thì trang bị chèn vào
  tài liệu người dùng **không nhìn thấy** ở điểm đó.
- **BI-57 không bị chạm:** nhánh `self` vẫn đứng **trước** và vẫn ăn trọn mọi điểm trong **tài
  liệu** của cửa sổ nguồn. Panes của **chính** cửa sổ nguồn trả `readonly` — hợp lệ, vì cú kéo
  trong DOM của renderer nguồn không bao giờ với tới một `WebContentsView` khác.
- **Vỡ khi:** thả trang vào khung xem → **không có gì xảy ra và không có lời giải thích** · hoặc
  ngược lại, trang bị chèn vào tài liệu ở **phía sau** khung xem.
- Lưới: `npm run test:pagedrop`, nhóm "khung xem chỉ đọc".

### BI-81 · Phiên: thêm khoá mới thì **KHÔNG** nâng `VERSION` — và cửa sổ không chia khung phải cho ra **đúng object cũ**
- `src/session.js` `VERSION = 1` · `src/tabs.js` `snapshotSession` / `restoreSession`.
- **Luật:** `session.js` **vứt bỏ** file có `v` khác `VERSION` (`readFile`: `if (raw.v !== VERSION)
  return null`). Nâng version để thêm một khoá **tuỳ chọn** sẽ khiến **mọi máy đang cài** mất phiên
  nó đang giữ — đánh đổi tài liệu đang mở thật lấy một gợi ý bố cục.
- **Luật:** khoá mới chỉ được ghi **khi thật sự có dữ liệu**. Cửa sổ không chia khung phải cho ra
  đúng bộ khoá cũ `{bounds, maximized, active, tabs}` — không thừa `panes: []`, không thừa
  `ratios: null`. Test so khớp **đúng bộ khoá**, không chỉ so giá trị.
- **Luật:** khôi phục theo **thứ tự phụ thuộc** — pane dựng **sau** tab, `ratios` đặt **sau** khi
  đủ số pane, vì `addViewPane` reset `paneRatios` mỗi lần số khung đổi.
- **Vỡ khi:** người dùng cập nhật app và **mất sạch tab đang mở** · hoặc mở lại app thì rãnh nhảy
  về mặc định dù đã kéo.
- Lưới: `npm run test:tabs`, nhóm "snapshotSession: chia khung".

### BI-82 · "Qua được biên tab" và "sống sót sau khi lưu" là **hai câu hỏi khác nhau**
- `renderer/editor.js`: `SHARE_EXCLUDED` · `SHARE_EXTRA` · `isShareableKind`.
- **Luật:** `isShareableKind` **không** được rút gọn lại thành `isManagedKind(k) && …`. Nó trả lời
  câu hỏi về **payload** và **ý nghĩa ở tài liệu đích**; `MANAGED_KINDS` trả lời câu hỏi về
  **round-trip qua `/NabuData`**. Chúng trùng nhau ở gần hết mọi kind, và đó chính là cái bẫy.
  - `image`: round-trip được, và **qua** biên tab từ v0.2.72 — nhưng câu hỏi payload vẫn được
    trả lời, ở **main** (`lightClip` + `annots:clip-fetch`, BI-77) chứ không bằng cách giữ lại.
    `SHARE_EXCLUDED` nay **rỗng** và lưới khoá nó rỗng: thêm lại một kind vào đó phải là một
    quyết định có lý do, không phải một dòng lén.
  - `check` / `cross` (v0.2.69): **không** round-trip (vẫn flatten, BI-42) nhưng **qua được** —
    vài chục byte JSON, và ở tài liệu đích nó đúng bằng thứ công cụ ✓ tạo ra tại chỗ.
  - `highlight` / `under` / `strike` / `redact`: **không** qua — chúng bám vào đoạn chữ, hoặc là
    lời hứa về nội dung của **chính** file này. "Cho tất cả qua" là sai, không phải là rộng rãi.
- **BI-42 không bị chạm:** thêm một kind vào `SHARE_EXTRA` **không** đưa nó vào `MANAGED_KINDS`, nên
  không byte nào trong PDF xuất ra đổi khác. Test khoá cả hai chiều.
- **Vỡ khi:** mỗi `Ctrl+C` trên một tấm ảnh đẩy vài MB tới **mọi** tab (bỏ `lightClip`) · hoặc
  copy liên-tab **âm thầm** ngừng chạy cho một kind vốn vẫn chạy (thu nhầm).
- Lưới: `npm run test:clip` §1 — `SHARE_EXTRA` được so khớp **đúng bằng** `{check, cross}`.

### BI-83 · Electron 44 xoá `clipboard.writeImage`/`readImage` — hai nhánh dưới đây **đều là mã sống**
- `desktop/src/main.js`: handler `clipboard:write-image` / `clipboard:read-image`.
- **Luật:** rẽ nhánh bằng `typeof clipboard.writeImage === "function"`, tức theo **cái runtime
  thật sự có**, không theo số phiên bản và không theo `process.versions.electron`. Chỉ được xoá
  nhánh cũ khi sàn tối thiểu đã là Electron ≥ 44 ở **mọi** nơi build.
- **`nativeImage.createFromBuffer(...).isEmpty()` phải đứng TRƯỚC cả hai nhánh.** Nhánh 44 chỉ
  gọi `clipboard.write()` và `await` nó — API mới **resolve kể cả khi không ghi được gì**, nên
  nếu bỏ chốt giải mã thì payload hỏng sẽ trả `{ok:true}` mà clipboard vẫn trống.
- **Vỡ khi:** "Sao chép ảnh"/"Dán ảnh vào trang" im lặng không làm gì (nhánh sai được chọn), hoặc
  `{ok:true}` dối trá.
- ⚠️ **Không kiểm được bằng máy ở đây:** shell của phiên phát triển không có quyền window station
  tương tác (`clip.exe` → "Access is denied"), nên vòng ghi–đọc clipboard **không pass trên bất kỳ
  Electron nào. Phải test tay.** Xem `docs/RESEARCH-2026-09-15-deps-perf-audit.md` §14.8.

### BI-84 · `PrinterInfo.isDefault` không còn do Electron cấp — main phải tự đắp lại
- `desktop/src/main.js`: `osDefaultPrinterName()` + handler `print:printers`.
  `desktop/renderer/app.js`: `populatePrinters()` đọc `p.isDefault`.
- **Luật:** hợp đồng với renderer là `p.isDefault`, **giữ nguyên**. Nếu runtime đã điền cờ
  (Electron ≤ 43) thì **không được đụng vào danh sách**; chỉ khi không có cờ nào mới đọc
  `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows` value `Device` và gắn cờ.
- **Vì sao không phải chuyện thẩm mỹ:** mất cờ thì combo box rơi vào **máy in đầu danh sách**,
  không lỗi, không cảnh báo — mà máy mặc định trên máy đo là **driver A3** (xem
  `nabu-print-sheet-fit`), tức là in ra **sai khổ giấy**.
- **Vỡ khi:** không máy in nào được chọn sẵn, hoặc **nhiều hơn một** máy in bị gắn `isDefault`.
- Lưới: probe CDP gọi thật `window.desktop.getPrinters()` và đòi **đúng 1** cờ (§14.5).

### BI-85 · Từ Electron 43, thiếu `defaultPath` nghĩa là **Downloads**, không phải "thư mục lần trước"
- `desktop/src/main.js`: `openDefault()` / `saveDefault()` / `rememberDir()`.
  `desktop/src/prefs.js`: `DIR_KEYS` · `getLastDir` · `setLastDir`.
- **Luật:** mọi `showOpenDialog`/`showSaveDialog` phải **vừa** truyền `defaultPath` từ ngăn của nó
  **vừa** ghi lại thư mục người dùng chọn. Bỏ sót một nửa là hộp thoại quên, đúng bằng hành vi mà
  bản vá này sinh ra để chặn.
- **Bốn ngăn riêng, không dùng chung một biến:** `open-pdf` / `save-pdf` / `open-files` /
  `save-file`. Gộp lại là lưu một file xlsx sẽ đổi luôn nơi "Mở PDF" bắt đầu lần sau.
- **Giá trị này đi thẳng vào một hộp thoại native**, nên `setLastDir` chỉ nhận đường dẫn **tuyệt
  đối** và **bucket có trong `DIR_KEYS`**; `prefs.json` là file người dùng sửa tay được.
- **`write()` không được ghi `lastDirs` khi rỗng** — `test:tabs` chốt hình dạng file đúng bằng
  `{v:1, openIn:"window"}`, và người chưa mở hộp thoại nào thì file của họ phải không đổi một byte.
- Lưới: `npm run test:tabs` — 17 assertion cho `lastDirs` (lọc, ngăn riêng, còn sau restart, rác
  trên đĩa bị bỏ).

### BI-86 · Hash CSP của script chống nháy theme — gắn với TỪNG BYTE, và hỏng trong im lặng
- `desktop/src/main.js`: directive `script-src` trong chuỗi `csp`.
  `desktop/renderer/index.html:7` và `desktop/renderer/view.html:8`: thẻ `<script>` inline.
- **Bối cảnh:** CSP của app đã chặn đúng đoạn script này **suốt cả Electron 33 lẫn 44** ⇒
  theme chỉ áp muộn từ `app.js` ⇒ nền tối **nháy trắng mỗi lần mở tab/cửa sổ**. Dấu vết
  duy nhất nằm trong log runtime, không có lỗi nào nổi lên UI.
- **Luật 1 — hash viết THẲNG vào chuỗi CSP**, không giấu sau hằng số có tên. Lưới gác đọc
  `main.js` như **văn bản**; một lớp gián tiếp làm nó xanh mà không chứng minh gì (đã xảy
  ra ở lần thử đầu, và lưới bắt được).
- **Luật 2 — hai script theme phải TRÙNG TỪNG BYTE.** Hôm nay chúng giống hệt nhau, nên
  **một** hash phủ cả hai. Sửa một file mà quên file kia = file kia bị chặn lại lặng lẽ.
- **Luật 3 — `error.html` / `loading.html` KHÔNG được cấp hash.** `grep` cả repo không có
  chỗ nào nạp chúng. Cấp quyền chạy cho script của trang chết là mở bề mặt chính sách để
  đổi lấy số không. Nếu có ngày nối chúng vào app thì phải cấp hash cùng lúc.
- **Luật 4 — hash làm script CHẠY ĐƯỢC; VỊ TRÍ mới là thứ chống nháy.** Thẻ phải nằm
  trong `<head>`, **trước** `<link rel=stylesheet>` đầu tiên, và **không** `async`/`defer`.
  Dời xuống hay thêm `defer` là nháy trắng quay lại **trong khi CSP vẫn xanh và log vẫn
  sạch** — không có tín hiệu nào khác ngoài lưới này.
- **Vỡ khi:** người nền tối thấy chớp trắng mỗi lần mở tab (không ai báo lỗi, vì không có lỗi).
- **Cách đo lại, đừng đo sai:** chạy app **không cổng debug** với
  `--enable-logging=file --log-file=<path>` rồi đếm `"Content Security Policy"` trong log.
  ⚠️ **KHÔNG** thử bằng `eval()` qua DevTools `Runtime.evaluate` — nó **được miễn trừ CSP
  của trang** nên luôn báo "allowed"; đó là một dương tính giả đã tốn hẳn một vòng truy lỗi.
  Muốn thử trong trang thì **chèn một `<script>` inline vào DOM**.
  ⚠️ `--user-data-dir` là bắt buộc (xem BI-85 / SETUP.md §2).
- Lưới: `npm run test:tabs` — tự tính lại hash từ HTML rồi đối chiếu `script-src`, cộng 4
  assertion vị trí thẻ. Đã kiểm bằng đột biến: bỏ hash / đổi một dấu cách / thêm `defer` /
  dời xuống dưới CSS đều làm lưới đỏ.

### BI-87 · Thumbnail đắt NGANG cả trang — nên nó phải xếp hàng SAU trang đầu, và không được lấy từ bitmap trang
- `renderer/thumb-queue.js` (thứ tự, thuần, có lưới) + `app.js`: `renderThumbs` (quan sát
  viên chỉ **xếp hàng**), `renderViewer` (`thumbQueue.open()` sau 2 trang đầu),
  `renderAll` `finally` (lưới an toàn: mở cổng kể cả khi nạp lỗi giữa chừng).
- **Sự thật đo được (đừng tin trực giác):** giá của một lần `page.render` là **phát lại
  operator list**, gần như không phụ thuộc số pixel. Trên trang A1 77 k lệnh: 0,04 MP mất
  173 ms, 4 MP mất 155 ms, 36 MP mất 189 ms; thumbnail 75 px mất 168 ms, 600 px mất 161 ms.
  ⇒ **một thumbnail 150 px tốn đúng bằng cả trang.**
- **Vì sao phải có cổng:** `renderAll` chạy `renderThumbs` **trước** `renderViewer`, và
  `IntersectionObserver` của dải thumbnail nổ ở mốc ~9 ms ⇒ 8 thumbnail (~1,2 s luồng
  chính) chạy **trước** trang người dùng đang chờ. Đo trên ba bản vẽ thật, thời gian tới
  **trang đầu có pixel**: 1 224 / 913 / 147 ms → **298 / 253 / 116 ms** sau khi đổi thứ tự.
- **Luật 1 — quan sát viên KHÔNG được gọi thẳng `renderThumbCanvas`.** Nó gọi
  `thumbQueue.queue(i)`. Ai đưa lại lời gọi trực tiếp vào là lấy lại nguyên cái chậm cũ,
  **không có lỗi nào nổi lên**.
- **Luật 2 — `reset()` phải chặn được pump đang bay.** Mở tài liệu mới trong lúc dải
  thumbnail cũ đang rút hàng: vòng lặp đọc lại cờ cổng **mỗi lượt**, nếu không nó tiêu
  luồng chính đúng lúc trang đầu của tài liệu mới cần.
- **Luật 3 — ĐỪNG lấy thumbnail từ bitmap trang.** Đã dựng, đã đo, đã gỡ (2026-09-20):
  bitmap trang A1 rộng gấp ~16 lần thumbnail, nên nét mảnh 1 px ở đó bị trung bình còn
  ~1/16 mực. Cùng canvas 150×105 của trang 1 `NA2-CD-S-LK4A.pdf`: lấy từ bitmap →
  **độ sáng trung bình 238,8 · 8,5% điểm tối** (bạc phếch); vẽ thẳng 150 px →
  **176,2 · 37,1%** (đọc được). Và nó gần như **không** mua thêm tốc độ: 299 ms so với
  314 ms tới trang đầu. Ghi chú ⛔ ngay trên `renderThumbCanvas` giữ lại kết luận này.
- **Vỡ khi:** mở bộ bản vẽ CAD thấy trang đầu lâu như cũ · dải thumbnail trắng vĩnh viễn
  (cổng không bao giờ mở) · thumbnail bản vẽ mờ nhạt không nhận ra trang.
- **Cạm bẫy khi ĐO LẠI:** cửa sổ bị che thì Chromium ngừng `requestAnimationFrame`, mà
  pdf.js chạy vòng vẽ canvas **từ rAF** ⇒ `page.render` **treo hẳn**, không phải chậm
  (`document.hidden === true`). Mọi probe đo render phải chạy với
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling`, nếu không sẽ thu được những con số vô nghĩa kiểu
  185 000 ms.
- Lưới: `npm run test:thumbs` (7 nhóm, gồm cả ca “reset giữa lúc đang rút hàng”) + mở thật
  một bộ bản vẽ nhiều trang. Số liệu: `docs/RESEARCH-2026-09-20b-cad-perf-real-files.md`.

### BI-88 · Tô sáng theo chữ: hai ô chồng nhau là **đậm gấp đôi**, và bản bánh phải là **Multiply**
- `annot-geom.js` `quadsFromRects()` + `TEXTHL_OPACITY` · `editor.js`
  `captureTextHighlight()`, nhánh `texthl` của `renderAnnot` / `addManagedAnnot` /
  `drawOneAnnot` · `app.css` `.an-texthl-q` + khối `body.editing.tool-texthl`.
- **Luật 1 — các ô của một vệt tô KHÔNG được chồng nhau.** Vệt tô vẽ bằng
  `mix-blend-mode: multiply`, nên hai ô chồng nhau **nhân hai lần** và dòng đó sẫm hơn hẳn
  các dòng còn lại. Đo được trên `1.TCVN 3890 - 2023.pdf`: một đoạn chọn 14 dòng trả về
  **154 hình chữ nhật, có cả bản sao y hệt nhau**; gom theo ô làm tròn `y` còn **18 ô cho 14
  dòng** và vết đậm nhạt lỗ chỗ thấy rõ trong ảnh. Gom theo **độ chồng lấn theo chiều dọc**
  (đối xứng hai chiều) cho **14 ô, 0 cặp chồng nhau, cao đều 12 pt**. Lỗi này **không lộ ra
  trong số liệu** — phải vẽ pixel ra rồi nhìn (cùng bài học với BI-87 luật 3).
- **Luật 2 — bản bánh vào file phải là `/BM /Multiply`, không phải `opacity` thường.**
  Đây là **lỗi đã có từ trước** và được sửa cùng đợt này: `drawOneAnnot` từng ghi
  `opacity: 0.35` chế độ Normal, tức **phủ màu lên trên chữ**. Dựng ba dòng chữ giống hệt
  nhau rồi mở bằng chính app: dòng `opacity 0.35` có chữ **bạc đi thấy rõ**, hai dòng
  `multiply` giữ chữ **đen nguyên**. Màn hình vốn đã là multiply, nên đây là BI-40 áp cho
  **chế độ hòa trộn** thay vì cho hình học. Bẫy khi kiểm tay: `doc.save()` mặc định bật
  object stream nên `grep /Multiply` trong file **không ra gì** — phải
  `save({useObjectStreams:false})` mới đọc được bằng mắt.
- **Luật 3 — công cụ này mượn chuột của lớp chữ, và phải trả lại.** `body.editing` tắt
  `pointer-events` của `.text-layer` để các công cụ vẽ sở hữu chuột; `body.editing.tool-texthl`
  bật lại **và tắt `.annot-layer`**. Dùng `pointer-events`, **không** `z-index` — xếp lại tầng
  sẽ đưa lớp chữ lên trên các vệt đã vẽ. Hệ quả **là luật, không phải lỗi**: đang ở công
  cụ này thì không chọn/kéo được vật thể — về **Chọn** (`V`). `setTool` là nơi **duy nhất**
  bật/tắt class này.
- **Luật 4 — một đoạn chọn vắt hai trang thành HAI vật thể.** Mỗi trang là một hệ toạ
  độ riêng; `captureTextHighlight` cắt `Range` theo từng `.text-layer` rồi mới hỏi hình chữ
  nhật. Cả cụm vẫn là **một** bước hoàn tác.
- **Vỡ khi:** vệt tô có dòng đậm dòng nhạt · sau khi Áp dụng thì chữ dưới vệt **xám đi** ·
  bật công cụ mà **không bôi đen được chữ** · tắt công cụ rồi mà vẫn không chọn được hình
  vẽ (class còn sót).
- Lưới: `npm run test:shape` (nhóm 2 pin đúng luật 1) + `npm run test:rotate` + lưới tay
  ở §5. Số liệu và ảnh: `docs/RESEARCH-2026-09-20c-text-highlight-free-shape.md`.

### BI-89 · Hình dạng-điểm đổi cỡ bằng `scalePts` từ **ảnh chụp trước khi kéo**, và nét **không** co theo
- `annot-geom.js` `scalePts()` + `PTS_KINDS`/`isPtsKind` · `editor.js` nhánh `resize` của
  `onDown`/`onMove`/`cancelDrag`, `addPtsGrips()` · `app.css` `.handle.h-vtx`.
- `draw` / `cloudpen` / `poly` không có `x/y/w/h`, nên `RESIZABLE_KINDS` **không còn là câu
  trả lời đầy đủ** cho "có kéo giãn được không": nửa hộp ở khối tay nắm chung cuối
  `renderAnnot`, nửa hình-điểm ở `addPtsGrips` mà **từng nhánh tự gọi** — vì cả ba nhánh
  đó `return el` sớm. **Đây chính là lỗi đã vấp:** `cloudpen` ban đầu không được gọi nên mây
  tự do đóng kín **không có một tay nắm nào**, đọc mã không thấy, chỉ probe hỏi DOM mới ra.
- **Luật 1 — mọi lần di chuyển chuột phải tính từ `drag.orig`, không từ điểm hiện tại.**
  `drag.orig` giữ **cả hai**: danh sách điểm và hộp bao lúc bắt đầu kéo. Tính lại hộp bao
  từng lượt là cộng dồn sai số làm tròn ⇒ hình **trôi dần** khỏi con trỏ (đúng luật
  `resizeRect` đã theo từ đầu).
- **Luật 2 — `width` và `bump` KHÔNG nhân theo tỷ lệ.** Chúng là thuộc tính của **nét**,
  không phải của **hình**: thu một ghi chú nhỏ lại mà nét mảnh theo thì chú thích biến mất khi in.
- **Luật 3 — `data-vtx` KHÁC `data-pt`.** `data-pt` đã có nghĩa "một ĐẦU của annot hai
  điểm" (mũi tên / đoạn đo) và được một nhánh trong `onDown` đọc để ghi `a.x1/a.x2`. Chỉ
  số đỉnh 1 hoặc 2 sẽ rơi thẳng vào nhánh đó và ghi đè trường mà hình không có.
- **Luật 4 — `draw` có tay nắm góc nhưng KHÔNG có tay nắm đỉnh** (`VERTEX_KINDS`): điểm
  của nét vẽ tay là vết chuột, lại bị **thưa hoá khi lưu** (BI-69), nên đỉnh vừa kéo có thể
  không sống sót qua một vòng lưu. Quá `VERTEX_GRIP_MAX` điểm thì cũng thôi hiện — không ai
  sửa được hình bị chôn dưới hàng trăm chấm.
- **Vỡ khi:** kéo góc thì hình trôi đi thay vì giãn · thu nhỏ xong nét mảnh như sợi tóc ·
  kéo một đỉnh làm mũi tên ở đâu đó nhảy chỗ · `Esc` giữa lúc kéo không trả về được hình cũ.
- Lưới: `npm run test:shape` (nhóm 4, gồm cả ca nét **ngang tuyệt đối** — cao 0 thì không có
  gì để nhân, phải **tịnh tiến**, không được ra NaN) + `npm run test:geom`.

### BI-90 · Thay trang: chỉ trên một dải **liền nhau**, và **chèn trước — xoá sau**
- `page-range.js` `contiguousRun` · `replacePlan` · `replaceInDoc`; `app.js` `askReplaceSpec` ·
  `replaceSelectedFromFile` · `replaceSelectedWith`; `#replace-modal`. Lưới `npm run test:pages`
  (chạy `replaceInDoc` trên **tài liệu pdf-lib thật**, phân biệt trang bằng bề rộng).
- **Luật 1 — vùng chọn có khoảng hở thì TỪ CHỐI**, mục menu **mờ** kèm gợi ý "(chọn các trang
  liền nhau)". "Thay trang 2 và 5 bằng 3 trang" không có một nghĩa duy nhất; đoán sai là trang
  hợp đồng nằm nhầm chỗ, không lỗi nào báo.
- **Luật 2 — `copyPages` trước, `insertPage` trước, `removePage` SAU (cao → thấp).** Xoá trước
  thì thay **toàn bộ** tài liệu đi qua trạng thái cây trang **rỗng**, pdf-lib không được làm
  cho trạng thái đó. Mutation "chèn cùng một chỉ số" ⇒ 3 ca đỏ.
- **Luật 3 — đọc file nguồn TRƯỚC khi mở hộp thoại**: số trang nguồn quyết định hộp thoại,
  và file hỏng / có mật khẩu phải báo **ngay**, không phải sau khi người dùng đã gõ khoảng.
- **Luật 4 — ô khoảng trang KHÔNG được `disabled`.** Phần tử disabled **không nhận focus**, nên
  "bấm vào ô là tự chọn *Chỉ các trang*" thành mã chết — bản đầu vấp đúng chỗ này, probe GUI bắt.
- Trang **ẩn có khoá** (BI-72) trong vùng thay ⇒ hỏi riêng (thay = mất vĩnh viễn bản gốc đã mã
  hoá, chỉ còn `Ctrl+Z` trong phiên). **Một** `pushUndo` cho cả thao tác.
- **Vỡ khi:** trang mới rơi sai chỗ · thay hết trang thì lỗi · `Ctrl+Z` không về đủ · chọn rời
  mà vẫn thay được.

### BI-91 · Chữ ký lưu sẵn: **mã hoá hoặc không lưu**, và kho không đọc được thì **không bao giờ bị ghi đè**
- `src/signatures.js` (thuần, tiêm `fs`/`crypto`/`checkPng`) · `main.js` `sig:*` +
  `safeStorage` · `preload.js` `signatures` · `renderer/sig-image.js` (thuần) ·
  `renderer/signatures.js` · `editor.js` `placeSignature` / `pagePointFromClient` /
  `rememberSignatureWidths`. Lưới `npm run test:sig`.
- **Luật 1 — `safeStorage` không mã hoá được ⇒ TỪ CHỐI lưu.** Người dùng đã chọn lưu mã hoá;
  âm thầm ghi PNG thường là đúng cái họ đã loại trừ.
- **Luật 2 — giải mã / parse hỏng ⇒ danh sách rỗng + `unreadable`, và MỌI lệnh ghi bị từ chối**
  cho tới khi người dùng bấm "Tạo kho mới" — lệnh đó **đổi tên file cũ sang bên cạnh**, không
  xoá (luật page-vault §4). Ca điển hình: file bị chép sang tài khoản Windows khác.
- **Luật 3 — kiểm hợp lệ lúc VÀO**, cả từ đĩa lẫn từ IPC: PNG thật (magic + `nativeImage` decode,
  ≤ 4096 px), ≤ `MAX_PNG_BYTES`, ≤ `MAX_ITEMS`, tên cắt ký tự điều khiển. Mục hỏng trong file tay
  sửa bị bỏ qua từng mục, không làm hỏng cả kho.
- **Luật 4 — `sigId` nằm trên annotation nhưng KHÔNG được vào file.** `managed-codec` ghi ảnh từ
  **danh sách trường cố định** (`x,y,w,h,fmt`); đổi sang kiểu "ghi cả object" là rò `sigId` vào
  mọi PDF có chữ ký. Probe GUI giải mã `/NabuData` thật để khẳng định.
- **Luật 5 — đường Ảnh cũ không đổi.** `placeImage` chỉ đọc thêm `wPt`/`center`/`sigId` khi
  chúng có mặt; ảnh thường vẫn là quy tắc 240pt, góc trên-trái tại điểm bấm.
- Menu chuột phải lấy toạ độ trang **lúc mở menu**; thanh Chú thích hiện ra đẩy trang xuống
  ~41px nhưng chữ ký theo **trang**, không theo màn hình (probe đo trong không gian trang).
- **Vỡ khi:** kho ghi ra dạng đọc được · mở app bằng tài khoản khác xoá mất kho · chữ ký lệch
  khỏi chỗ bấm · ảnh chèn bằng công cụ Ảnh đổi cỡ/vị trí so với trước.

### BI-92 · Di chuyển chữ: redact ở `bbox` GỐC, vẽ ở `origin + offset`, offset là VECTOR trong không gian hiển thị
_Ghi 2026-09-30 (v0.2.73)._
- `api.py` `TextEdit.offset`, `_view_offset_to_page`, `/edit-text` (dời `ox, oy` + khung nền) ·
  `renderer/text-edit.js` `startDrag` / `commitMove` / `isPristine` / `renderBoxes` (ghost + preview) /
  `stage()` (giữ `offset` khi gõ lại).
- **Offset đi theo không gian HIỂN THỊ** (chỗ chuột và `bbox_view` sống), sidecar tự quy đổi. Quy đổi
  bằng **hiệu hai điểm** qua `derotation_matrix`, không nhân thẳng vector: trên trang `/Rotate 90`
  ma trận đưa (0,0) tới (0,H), nhân thẳng là cộng thêm H.
- **Redaction không đi theo** — xoá ở chỗ cũ là cả ý nghĩa của "di chuyển". Đổi `bbox` theo offset ở
  renderer thay vì gửi `offset` là **xoá luôn chữ đang nằm ở chỗ mới**.
- Không `offset` / `[0,0]` ⇒ output **pixel y hệt** trước (test D1–D3) — Tìm & Thay thế dùng chung
  `/edit-text` và không gửi offset.
- Renderer: dưới 4 px là **click** (mở ô sửa như cũ) · kéo xong nuốt đúng **một** click (cờ xoá ở
  `pointerdown` kế, không bao giờ nuốt click của cử chỉ sau) · nghe trên `window` và tìm lại phần tử
  theo `data-id` vì blur của ô đang mở dựng lại mọi box · trong lúc kéo chỉ đổi `left/top`, dựng lại
  **một lần** khi thả · span `suspect` chưa OCR **không** kéo được (vẽ lại rác bằng font đọc được).
- **Vỡ khi:** chữ trên bản vẽ xoay chạy ngược hướng kéo · chữ cũ còn ở chỗ cũ · bấm một ô không mở ô
  sửa nữa · kéo về chỗ cũ vẫn để lại một edit vẽ lại tại chỗ · Tìm & Thay thế đổi output.
- Kiểm: `.venv\Scripts\python test_edit_text_move.py` (có ca canh gác R3 + phá quy đổi ⇒ 7 đỏ) và
  probe CDP kéo thật ở zoom ≠ 100% (px ÷ scale).

### BI-93 · Thứ tự chồng của chú thích **là** thứ tự trong mảng — không có trường `z`, và đừng thêm
- `annot-geom.js` `reorderZ` · `editor.js` `zPlan` / `reorderSelected` / `pickUnder`, mục
  menu chuột phải "Đưa lên trên cùng / Đưa lên một lớp / Đưa xuống một lớp / Đưa xuống dưới
  cùng", phím `Ctrl+]` / `Ctrl+[` (+`Shift`), `Alt`+bấm. Lưới: `npm run test:zorder`.
- **Mô hình:** chồng lớp = vị trí trong `ed.annots[trang]`. `renderLayer` dựng DOM theo thứ
  tự mảng; bake ghi các kind "sống" vào `/Annots` theo thứ tự mảng; `importManaged` đọc
  `/Annots` theo thứ tự đó. Nên đổi chỗ trong mảng là **toàn bộ** tính năng, và **thêm một
  trường `z`** sẽ tạo ra hai nguồn sự thật có thể lệch nhau mà không báo lỗi.
- **Lịch sử (đã kiểm bằng `git show`, không phải suy đoán):** repo **chưa từng** có lệnh
  đổi thứ tự. Báo cáo "trước có, nay không" khớp với việc `MANAGED_KINDS` mở rộng: trước
  v0.2.61 chỉ `text/note/image/arrow` là chú thích sống, còn chữ nhật/elip bị nướng vào
  *nội dung trang* sau khi Lưu — nằm **dưới** mọi hộp văn bản. Từ v0.2.61 (chữ nhật, elip,
  mây) và v0.2.63 (nét vẽ tay) chúng thành chú thích và xếp theo **thứ tự tạo**, nên hình
  vẽ sau đè lên chữ. Cộng thêm: `.an-box`/`.an-ellipse` là `<div>` kín nên **nuốt click**
  cả khi không có nền — chữ nằm gọn trong khung vẽ sau thì **không chọn được** → Alt+bấm.
- **Giới hạn không sửa được:** `highlight`, `redact`, `dim` không thuộc `MANAGED_KINDS`,
  bị nướng vào nội dung trang ⇒ sau khi Lưu **luôn nằm dưới** mọi chú thích sống (trong
  phiên Chỉnh sửa, trước khi Áp dụng, chúng vẫn xếp đúng theo mảng). Chú thích do app khác
  tạo cũng luôn nằm dưới chú thích của Nabu (ta thêm vào cuối `/Annots`). Trợ giúp có nói.
- **Phải giữ:** (1) `pushEdUndo()` **trước** khi đổi mảng, và **không** ghi bước hoàn tác
  khi không có gì dịch chỗ; (2) đổi **tại chỗ** bằng `splice` — code khác giữ tham chiếu
  mảng của trang qua một lần render; (3) từ chối khi đang kéo (`drag`), như `edUndo`;
  (4) phím tắt đọc `e.code`, không `e.key` (Shift đổi `]` thành `}` và mỗi bàn phím một
  khác); (5) **không** thêm hàng nút vào `.edit-bar` — hết chỗ (BI-41), nên lối vào là
  menu + phím. Cần nút thì phải vào `KIND_CTLS` **và** đo lại bảng BI-41.
- **Alt+bấm** chỉ ở công cụ Chọn, và chỉ khi ≥2 vật chồng nhau dưới con trỏ; mỗi lần bấm đi
  xuống một vật, hết thì quay lại trên cùng. `elementsFromPoint` bỏ qua
  `pointer-events:none` nên `.an-text-bg` không thành "lớp ma".
- Test tay (renderer không chạy được trong node): xem hàng "Thứ tự chồng" ở §5.

### BI-94 · Kiểu nét (liền / nét đứt / chấm): **một** bảng số, **bốn** nơi vẽ — và "liền" là sự VẮNG MẶT của khoá
- `annot-geom.js` `DASH_KINDS` · `normDash` · `dashSpec` · `dashSegments` — `editor.js`
  `applyDashSvg` · `appendDashedOutline` · `stampDash` · `#ed-dash` — `editor-bake.js`
  `renderArrowPng` · `drawOneAnnot` · `deserializeManaged` — `managed-codec.js`
  `shapeAppearance` · `serializeManaged`. Lưới: `npm run test:dash` (174 ca).
- **Năm loại có kiểu nét:** `box`, `ellipse`, `draw`, `poly`, `arrow` (mũi tên chỉ đứt **thân**; đầu
  mũi tên là đa giác tô đặc, giữ nguyên). **Không** có: khoang mây (viền vốn là các cung), dấu ✓ ✗,
  đoạn đo `dim`. `_dashOf()` ở codec là nơi duy nhất quyết định "annot này có mẫu nét không" — một
  khoá `dash` lạc vào cloud/✓ (dán từ nơi khác, file sửa tay) bị bỏ qua cả lúc ghi lẫn lúc đọc.
- **Bốn nơi vẽ phải đọc cùng một `dashSpec(dash, width)`** (BI-40): `<svg>` overlay, `/AP` vector
  (`borderDashArray`), PNG canvas của mũi tên (`setLineDash` nhân `RS`, rồi **xoá ngay** sau nét
  thân), và nhánh nướng dự phòng (`drawLine` có `dashArray`). Độ dài tỉ lệ theo bề dày nét:
  dash = `[4w, 3w]` đầu **phẳng**; chấm = `[0.01, 2w]` đầu **tròn** (0.01 chứ không 0: dash dài 0
  hợp lệ PDF nhưng không reader nào cũng vẽ).
- **Đầu nét thuộc về kiểu.** Đầu tròn kéo dài mỗi nét thêm một bề dày ở mỗi đầu và nuốt khoảng hở,
  nên `dash` dùng đầu phẳng; vì vậy `draw`/`poly` (vốn luôn đầu tròn) đổi sang đầu phẳng **chỉ khi**
  đứt. ⚠️ **`LineCapStyle.Butt` bằng `0`, tức falsy**: `dashCap || Round` luôn rơi về Round — lỗi này
  đã xảy ra trong lúc viết và chỉ lưới test bắt được. Viết `ds ? dashCap : Round`.
- **Liền = không có gì.** `dashSpec` trả `null`, mọi nhánh rẽ `if (ds)` bị bỏ qua, `serializeManaged`
  **không ghi** khoá `dash`, `deserializeManaged` **không đặt** thuộc tính, chọn "Liền" **xoá** khoá
  (không ghi `"solid"`). Hệ quả: file cũ và hình liền ra **byte y hệt** (BI-59) — đã đo A/B trên 11
  vật thể × 4 góc xoay × hai đường ghi (managed + flatten), 46 108 byte `/NabuData` + `/AP` + `/Rect` +
  content stream: cùng SHA-256 giữa HEAD và bản sửa. Ca "solid == toán tử dựng tay bằng pdf-lib
  không có `borderDashArray`" nằm trong `test:dash` để giữ điều đó sau này.
- **Hộp & elip không dùng `border: dashed` của CSS**: trình duyệt tự chọn độ dài nét, còn `/AP` thì
  theo `dashSpec`. Khi đứt, `appendDashedOutline` thay viền bằng `<svg class="an-dash">` vẽ
  `<rect>`/`<ellipse>` với đúng số của `dashSpec`. **Hộp thụt vào nửa bề dày + `crispEdges`; elip giữ nét
  nằm giữa, khử răng cưa** — đây là kết quả **đo trên app thật** sau khi người dùng báo "đổi Liền → Nét đứt
  thấy nét dày lên thành 2": `width` trong model **không hề đổi** (luôn 1, cả `/NabuData` lẫn `1 w`
  trong `/AP`), nhưng viền CSS của hộp liền bị Chromium **làm tròn xuống số điểm ảnh nguyên và nằm
  trong khung**, còn nét SVG nằm giữa biên thì trải **2 hàng xám 50%** ở zoom 100% và mang thêm **25% / 50% mực** ở
  125% / 150%. Bảng đo (hàng điểm ảnh · độ phủ mực): liền 1 hàng · 1.00 ở mọi zoom; đứt-nằm-giữa 2 hàng ·
  1.00 / 1.25 / 1.50; **thụt + crispEdges: 1 hàng · 1.00 ở 100/125/150/200%, trùng hàng với viền liền**.
  ⚠️ `crispEdges` **một mình** còn tệ hơn (làm tròn nét LÊN 2px ở 125/150%), và **không** được cho elip
  (răng cưa thành bậc thang 2px) — nên elip chỉ giữ nét giữa. Chỉ là chỉnh overlay: `/AP` đã lưu vẫn nằm giữa,
  và bản trang đã lưu hiển thị liền và đứt **giống hệt** nhau (đã đo, pdf.js 100% và 300%).
  **Chỉ độ dài nét được bảo đảm khớp, không phải pha**: hai bên không bắt đầu đường nét từ cùng một
  điểm được bảo đảm (SVG `<rect>` đi từ góc trên-trái; đường của pdf-lib do `drawRectangle`/`drawEllipse`
  tự chọn) — mẫu nét có thể lệch pha nhưng không lệch độ dài. Chưa đo pha; đừng hứa nó khớp.
- **Nhánh nướng dự phòng của nét vẽ tay / hình tự do** (chỉ chạy trên trang `/Rotate` không phải bội
  của 90°) vẽ từng đoạn bằng `drawLine`; mẫu nét **khởi động lại ở mỗi lệnh `drawLine`**, nên với
  nét vẽ tay gồm vô số đoạn 1–2pt nó sẽ thành **liền**. Vì vậy `dashSegments` đi dọc cả đường **một
  lần** rồi mới cắt: lưới đo 100 đoạn 1pt cho cùng 58pt mực như một đoạn 100pt, ở cả bốn góc xoay.
- **Mặc định cho hình vẽ SAU chỉ sống trong phiên** (`ed.dash`, không ghi localStorage / Cài đặt): một
  mặc định "đứt" bị quên lặng lẽ biến mọi hình sau thành đứt là bất ngờ tệ hơn việc chọn lại. Chọn
  trước khi vẽ → áp cho hình sau; chọn vật rồi đổi → áp cho cả nhóm đang chọn, **một** bước hoàn tác
  (gộp theo `"dash:" + ed.sel`). Ô chọn được đồng bộ lại ở `setTool` (về giá trị mặc định) và
  `syncControls` (về giá trị của vật đang chọn) — cùng luật với ô Nét.
- **Thanh chỉnh sửa rộng thêm** (BI-41): nhãn "Kiểu nét" + ô chọn rộng 127px, hiện cho box / elip /
  vẽ tay / hình tự do / mũi tên. **Đã đo bằng probe Electron, có baseline HEAD** (cùng cách dựng, cùng
  `innerWidth` in ra): cao `#edit-bar` **y hệt HEAD** ở mọi ca — công cụ Hộp 86px (1366, 1100, 1344),
  mũi tên đang chọn 87/86/87px — và `#ed-apply`/`#ed-exit` nằm trọn trong cửa sổ cả ở 1100px
  (x 951–1088). Không có hàng mới nào bị đẩy xuống. Bảng BI-41 ở trên **chưa** đo lại cho 126px thêm này
  ở các công cụ rộng nhất (khoang mây không có ô này nên không đổi) — nếu sau này thêm ô nữa, đo lại.
- **Thêm kiểu nét mới** (ví dụ chấm-gạch) = thêm **một** nhánh vào `dashSpec` + một `<option>` +
  khoá i18n; **không** sửa ở bốn nơi vẽ. Nếu thấy mình sửa ở bốn nơi, đang làm sai.
- Test tay (renderer không chạy được trong node): xem hàng "Kiểu nét" ở §5.

### BI-95 · Ghép nhiều trang vào một tờ (N-up): `embedPage` của pdf-lib **bỏ qua `/Rotate`, CropBox, chú thích — và ném lỗi muộn**
- `renderer/page-nup.js` (thuần, `window.PageNup`) · `app.js` `askNup` / `openNup` / `runNup` · `index.html`
  `#btn-nup` (menu Trang ▾) + `#nup-modal` · **MIỄN PHÍ** (quyết định của chủ dự án; dự án theo AGPL-3.0): `btn-nup` **không** nằm trong
  `GATED_BTNS` và `openNup` **không** gọi `gateProFeature()`. Muốn khoá sau này phải làm **cả hai** (BI-9, BI-26).
  Lưới: `npm run test:nup` (88 ca). Mục tiêu người dùng: "2 trang ngang vào 1 tờ A4 dọc".
- **Năm điều đã ĐO trên pdf-lib 1.17.1, không phải đoán** (đừng quên khi đổi cách nhúng):
  1. Trang giữ nguyên là **vector** (Form XObject) — chữ vẫn sắc khi phóng to / in.
  2. **`/Rotate` bị bỏ qua**: trang lưu 595×842 có `/Rotate 90` nhúng ra 595×842. `placement()` tự bù: xoay
     theo chiều kim đồng hồ = góc **âm**, và gốc dời về góc sẽ thành dưới-trái (pdf-lib áp
     translate → rotate → scale, đã đọc `operations.drawPage`). Test dùng phép biến đổi **độc lập** (đặt 4
     góc của hộp lưu rồi so với hộp hiển thị) cho cả 0/90/180/270.
  3. **CropBox bị bỏ qua** nếu không truyền `boundingBox`; `pageGeom` lấy CropBox ∩ MediaBox (CropBox nằm
     ngoài MediaBox = rác, quay về MediaBox). Ma trận mặc định của pdf-lib đã dời `-left,-bottom`.
  4. **Không mang chú thích** (`/Annots` ở trang kết quả là mảng rỗng do `addPage` tạo). Nên `runNup`
     **đếm** (`countAnnots`) và **hỏi trước** khi mất, kèm "Ctrl+Z hoàn tác được". Chỉ đếm số mục —
     không tự đoán cái nào "quan trọng". Chú thích sửa-lại-được của Nabu cũng mất ở đây.
  5. ⚠️ **Trang không có `/Contents` làm `save()` ném `MissingPageContentsEmbeddingError`** — không phải
     `embedPage()`. Trang do "Thêm trang trắng" tạo ra là đúng loại này. `try/catch` quanh `embedPage`
     **không bắt được gì** (lưới test bắt được lỗi này lúc viết); phải nhìn `page.node.Contents()` **trước**.
     Ô của trang trắng để trống (giữ viền nếu bật).
- **Ghi vào tài liệu: thay các trang đã chọn bằng các tờ, một bước hoàn tác** (`commitBytes`). Mọi thứ có
  thể ném (load, dựng, `save`) xảy ra **trước** `pushUndo` nên không để lại bước hoàn tác ma. Tài liệu
  được dựng lại bằng `PDFDocument.create()` + `copyPages` (như `reorderPage` **trước BI-96**) — nên **thông tin
  tài liệu / mục lục / form cấp catalog không đi theo**; trang không chọn được chép nguyên vẹn
  (còn `/Rotate`). Không chạm file trên đĩa cho tới khi người dùng lưu.
- **Từ chối khi có trang ẩn** (`state.vaultPages.size`, BI-74): tài liệu bị dựng lại từ đầu sẽ làm rơi thứ
  kho trang ẩn giữ ở catalog. Từ chối còn hơn đoán. Cũng từ chối khi đang ở chế độ chú thích / sửa chữ.
- **Quy tắc phạm vi** (`plan`): các trang chọn được dùng theo thứ tự trang, mỗi tờ `per` trang; các tờ nằm
  **tại vị trí trang chọn đầu tiên**, trang khác giữ nguyên chỗ. Lẻ trang → tờ cuối ít ô hơn (không bỏ
  trang nào). Chọn rời rạc cho ra kết quả có nghĩa nhưng **không phải điều người dùng hay tưởng** — hộp
  thoại hiện số trang còn lại để họ thấy.
- **Ô tự điền sẵn danh sách trang phải KHÔNG cắt**: `PageRange.formatList(list, Infinity)`. Mặc định nó kết
  thúc bằng "…" sau 8 nhóm; `parseSpec` âm thầm bỏ token đó **cùng trang cuối** — mất trang không lỗi.
- **Đã kiểm bằng bộ dựng hình độc lập (MuPDF)**, không chỉ toán: 5 trang đánh dấu (0°, 90°, 270°, 180°, CropBox)
  → dấu đỏ nằm đúng góc hiển thị, lệch ≤ 0,8 px ở 72 dpi.
- **Chưa đo:** Foxit / Acrobat mở kết quả · tài liệu lớn (hàng trăm trang, `embedPages` chạy trên luồng UI) ·
  trang có độ trong suốt / nhóm màu phức tạp · khổ trang rất lệch tỉ lệ (một trang 10×1000pt) · mở file kết
  quả rồi **Ctrl+Z qua lại nhiều lần** với tài liệu rất lớn (bộ nhớ lịch sử).
- Thêm khổ tờ mới = thêm một dòng vào `SHEETS` + một `<option>` + khoá i18n. Thêm "5/6/8 trang một tờ" =
  mở rộng `gridOf` (hiện chỉ 2 và 4) **và** `normOpts` (đang ép `per` về 2 hoặc 4).

### BI-96 · Sắp xếp trang di chuyển **tại chỗ** — không dựng lại tài liệu, và **ghim 4 thuộc tính kế thừa** trước khi đổi cha
- `renderer/page-range.js` `movePageInDoc` (thuần) · `app.js` `reorderPage`. Lưới `npm run test:pages`
  (25 cặp `(from,to)` so với phép `splice` cũ · dấu trang · form · cây trang lồng nhau).
  Kế hoạch gốc: `docs/RESEARCH-2026-10-05-foreign-annots-sidebar-panels.md` §3.3, Đợt 1.
- **Vì sao:** bản cũ `create()` + `copyPages` bỏ lại **toàn bộ catalog**. ĐO trên file thật của khách (10 trang,
  20 chú thích Acrobat): catalog `/AcroForm /Metadata /Pages /Type /Version` → còn `/Pages /Type`. Với file có
  dấu trang: kéo **một** thumbnail là **mất sạch dấu trang**. Tại chỗ thì catalog còn nguyên **và ref của từng
  trang không đổi** ⇒ dấu trang tự trỏ đúng trang đã dời, không cần ánh xạ lại.
- **Luật 1 — ghim `Resources`/`MediaBox`/`CropBox`/`Rotate` lên lá TRƯỚC khi rời cha.** Trong cây trang lồng
  nhau, trang có thể **kế thừa** chúng từ nút `/Pages` trung gian. `copyPages` tự ghim; `insertPage` của
  pdf-lib **không** (đã đọc mã 1.17.1: `normalize()` chỉ lo `Resources`, và `insertPage` không gọi nó). Bỏ
  ghim ⇒ trang dời ra khỏi nút trung gian **mất MediaBox** (pdf-lib ném lỗi khi đọc) — mutation đã thử, đỏ.
- **Luật 2 — vắng mặt suốt chuỗi cha thì ghim GIÁ TRỊ MẶC ĐỊNH** (`Rotate 0`, `CropBox = MediaBox`). Trang
  thẳng thả vào một nhánh `/Rotate 90` sẽ nằm ngang nếu không. Mutation "bỏ mặc định Rotate" ⇒ đỏ đúng 1 ca.
- Xoá trước – chèn sau **an toàn ở đây** (khác BI-90 Luật 2): di chuyển cần ≥ 2 trang nên cây không bao giờ rỗng.
- **Đã kiểm E2E trong Electron thật** (CDP, file có 4 dấu trang + 10 chú thích PyMuPDF): kéo trang 1 xuống cuối →
  dấu trang trỏ đúng trang mới, chú thích đi theo trang, chọn đúng trang, Ctrl+Z về đủ, 0 lỗi renderer.
  Tốc độ ngang bản cũ (file 10,7 MB: 32–79 ms so với 58–76 ms, trong nhiễu).
- **Chưa làm (vẫn dựng lại, vẫn mất catalog):** bake có redact (`bakeWithRedaction`), tách/trích trang, N-up,
  gộp file. Dấu trang trỏ vào trang **đã xoá** thì hỏng (pdf.js ném `Kid reference not found`) — panel dấu
  trang (Đợt 2a) phải chịu được.
- **Vỡ khi:** kéo trang xong mở Foxit/Acrobat không còn dấu trang / form · trang vừa kéo đổi khổ hoặc xoay ·
  trang nằm lệch một ô so với vạch gợi ý (đó là BI-33/`gapToReorderIndex`, không phải hàm này).

### BI-97 · Cột trái nhiều chế độ: `#thumbs` **không đổi chủ**, và dấu trang hỏng **được giữ lại**
- `renderer/side-panels.js` (`window.SidePanels`, phần thuần `resolveOutline` / `destTarget`) · `index.html`
  `.side-tabs` / `.side-pane` · `app.js` gọi `SidePanels.init({...})` và `docChanged()` ở **cả hai** chỗ thay
  `state.pdf` (`renderAll`, `rerenderChanged`). Lưới `npm run test:side`; nạp **trước** `app.js` (`test:scope`).
- **Luật 1 — khung Trang chỉ được BỌC, không được dời nội dung.** `#thumbs`, `#page-count`, `#btn-select-all`,
  observer, hàng đợi vẽ, kéo–thả sắp xếp (BI-33/BI-39) vẫn thuộc `app.js` y như cũ. Khung ẩn là `display:none`
  ⇒ IntersectionObserver của thumbnail tự đứng; quay lại thì `onThumbsShown` cho `syncThumbFocus` chạy lại
  (lúc ẩn nó không cuộn được một danh sách cao 0).
- **Luật 2 — `side-panels.js` không đọc tên trần nào của `app.js`** (BI-14): `state.pdf`, `pageMetas`,
  `scrollToPage`… đi qua `deps`. Thêm nhu cầu mới ⇒ thêm vào `deps`, đừng gọi thẳng.
- **Luật 3 — dấu trang không phân giải được vẫn ở trong cây, `page = null`, hiện mờ kèm lý do.** Bỏ nó đi thì
  cây trong Nabu lệch với cây Foxit hiện cho cùng file. Trang đích tính bằng `getPageIndex` (ref) **hoặc** số
  nguyên (đích dạng số trang); ngoài `[0, numPages)` ⇒ coi như hỏng. `/Count` âm = nhánh **đóng sẵn** (như Acrobat).
- **Luật 4 — nhảy tới đích theo TỈ LỆ của khung trang đang sống**, đo bằng viewport scale 1 (mang `/Rotate` và gốc
  MediaBox) — đúng cả khi đang zoom dở, vì khung trang đổi cỡ ngay còn bitmap vẽ sau (BI-36).
- Lựa chọn tab nhớ ở `localStorage` (`nabu-side-pane`) — tiện ích theo máy, đọc/ghi đều bọc `try`.
- **Đã kiểm E2E trong Electron thật** (CDP, 17/17): cây 4 mục đúng cấp, bấm nhảy đúng trang, Thu/Mở hết, kéo
  trang khi đang xem dấu trang ⇒ cây tự cập nhật, Ctrl+Z, tiếng Anh, F4, quay lại khung Trang.
- **Vỡ khi:** thumbnail không vẽ sau khi quay lại tab Trang · kéo trang xong dấu trang vẫn chỉ trang cũ · bấm dấu
  trang nhảy lệch khi đang zoom / trang xoay · đổi ngôn ngữ làm mất cây (thiếu `SKIP_IDS`, BI-10).

### BI-98 · Danh sách "Chú thích": đọc bằng pdf-lib **trong Worker**, và trong chế độ Chú thích **không liệt kê bản Nabu của file**
- `renderer/annot-scan.js` (một file, ba ngữ cảnh: `<script>` → `window.AnnotScan`; `new Worker("annot-scan.js")`;
  node) · `side-panels.js` (`composeItems` / `groupByPage` / `filterItems` + DOM) · `editor.js` `listObjects` /
  `focusObject` (thay `getComments` / `focusNote` — số thành viên `window.Editor` không đổi) + một dòng báo ở cuối
  `renderLayer` · `app.js` `updateComments` (giữ tên, chỉ chuyển tiếp) · `#btn-comments` mở tab. Lưới
  `npm run test:annotscan` + `npm run test:side`. Panel "Ghi chú" bên phải **đã bỏ** (Q2: một danh sách duy nhất).
- **Luật 1 — pdf.js không đủ, pdf-lib trên luồng UI thì treo.** pdf.js không lộ `/NabuKind` `/NabuData` `/NM`
  (với nó hộp chữ Nabu là `/Stamp` không chữ), nên phải đọc dict bằng pdf-lib. ĐO: `PDFDocument.load` 18–54 ms
  với file khách 10 trang nhưng **2,5–2,9 s** với 400 trang / 2 000 chú thích. Trong Worker: khoảng hở khung hình
  lớn nhất **17 ms** suốt lúc quét file 400 trang (probe Electron). Worker hỏng ⇒ tự lùi về luồng UI + `console.warn`.
  **Đừng** gọi `AnnotScan.scanAnnots` trực tiếp từ luồng UI ở chỗ mới.
- **Luật 2 — trong chế độ Chú thích: đối tượng sống của overlay + CHỈ mục ngoại (`kind == null`) của file.**
  `importManaged` đã nhấc chú thích Nabu ra overlay; liệt kê cả bản trong file là mỗi hộp chữ hai dòng, một dòng cũ.
  (Hệ quả biết trước: chú thích Nabu mà `importManaged` **không** nhấc được — ví dụ ảnh có `/NabuSrc` bị phần mềm
  khác nén lại — không hiện trong danh sách lúc đang sửa.)
- **Luật 3 — tin báo thay đổi đi qua `renderLayer`, không phải `syncOverlays`.** ĐO bằng probe: vẽ một hình chữ nhật
  **không** gọi `syncOverlays` ⇒ bản đầu đặt móc ở đó và danh sách đứng yên. `renderLayer` chạy ở mọi thay đổi (và
  mỗi `mousemove` khi kéo) ⇒ bên nhận **debounce** 120 ms.
- **Luật 4 — danh sách là của `state.bytes` hiện tại.** Mảng bytes khác cái đã quét ⇒ hiện "Đang đọc…" và quét lại,
  không bao giờ hiện danh sách cũ. Quét chạy sau **mọi** `docChanged` dù tab đang ẩn — badge thanh công cụ đếm từ nó.
- **Luật 5 — không thêm khoá i18n cho chữ trần "Chú thích" / tên công cụ đang là chữ tĩnh**: registry dịch MỌI nút chữ
  tĩnh trùng khoá ⇒ thêm khoá là đổi luôn nhãn nút "Chú thích" trên thanh công cụ (app cố ý giữ tên này).
  `test:annotscan` buộc mọi nhãn loại có bản dịch; `test:side` buộc mọi `tr()` có bản dịch và id động nằm trong `SKIP_IDS`.
- Không ẩn chú thích nào đang hiện trên trang: `/Rect` hỏng ⇒ vẫn liệt kê (bấm thì về trang); trả lời (`/IRT`, trừ
  `/RT /Group`) cộng vào cha, cha không có ⇒ liệt kê riêng; chỉ bỏ Popup / Link / Widget và chú thích có cờ Hidden.
- **Đã kiểm E2E trong Electron thật trên FILE CỦA KHÁCH** (CDP, 27/27): badge 19, nhóm theo trang, 2 tác giả, lọc
  loại/người, bấm → khung nháy trong tầm nhìn, EN; vào Chú thích → 19 mục viền đứt, vẽ hình → dòng sống + badge 20,
  bấm dòng → chọn đúng hình và cuộn tới; Xong → đọc lại từ file 20; Ctrl+Z → 19. Worker xác nhận qua CDP auto-attach.
- **Vỡ khi:** badge đứng yên sau khi vẽ / xoá · mỗi hộp chữ Nabu hiện hai lần khi đang sửa · mở file lớn mà cửa sổ
  khựng · nhãn loại hiện mã thô (`cloudpen`) · chú thích của Acrobat mang chữ trắng (đọc `/DA` thay vì `/DS`).

### BI-99 · Trong chế độ Chú thích chỉ ẩn **bản đã nướng của chính Nabu** — chú thích của người khác và giá trị form **vẫn vẽ**
- `renderer/annot-hide.js` (`window.AnnotHide`: `entryOf` / `plan` / `render`) · `managed-codec.js` `replacedOnBake`
  (luật duy nhất, `stripManagedFromPage` đọc chung) · `editor-bake.js` `importManaged` ghi `ed._owned` (trang → mục
  `{id, subtype, rect}`) · `editor.js` `Editor.ownedAnnots(i)`, `reset()` xoá, `enter()` vẽ lại khi `_owned.size` ·
  `app.js` `renderPageCanvas`. Lưới `npm run test:annothide`; `test:bake-repaint` ghim thứ tự ở `bakePending`.
- Trước đây: `AnnotationMode.DISABLE` khi `Editor.active` ⇒ bấm "Chú thích" là chữ đỏ của đối tác, khoanh mây, giá trị
  ô form **biến khỏi trang** (ĐO trên file khách: 1 371 → 245 điểm đỏ trên canvas trang 1; 245 là nét đỏ của bản vẽ).
- **Luật 1 — ẩn theo TÊN, qua `AnnotationStorage { noView: true }` + `ENABLE_STORAGE`.** pdf.js 3.11 bỏ qua chú thích
  có `noView` (`Annotation.mustBeViewed` trong worker); tên = `Ref.toString()` của pdf.js (`"12R"` / `"12R3"`), cùng số
  đối tượng pdf-lib thấy. Mục lưu tồn tại **đúng một lời gọi `page.render()`** (đặt → gọi → gỡ, đồng bộ): pdf.js chụp
  storage lúc gọi (ĐO bằng `getOperatorList`: gỡ ngay sau lời gọi, kết quả đang bay không đổi). Không để lại gì trên
  tài liệu cho lần vẽ / in / thumbnail sau.
- **Luật 2 — "của Nabu" = đúng cái lần nướng sau sẽ THAY** (`replacedOnBake`): có `/NabuKind`, trừ ảnh có `/NabuSrc`
  không đọc được (bake giữ nó ⇒ nó phải tiếp tục hiện). Hai bản luật lệch nhau = chú thích ẩn-mà-còn hoặc hiện hai lần.
- **Luật 3 — không chắc thì như cũ.** Mỗi mục chỉ được tin khi trang đang vẽ có đúng chú thích đó với cùng `/Subtype`
  và `/Rect`; lệch (danh sách từ bytes khác — bake đánh số lại, bake bôi đen dựng lại tài liệu), mục nội tuyến (không số
  đối tượng), `getAnnotations` lỗi ⇒ `"all"` ⇒ `DISABLE`. Sai chỉ có thể là **ẩn thừa**, không bao giờ vẽ hai lần.
- **Luật 4 — `bakePending` giữa phiên: `importManaged` TRƯỚC `rerenderChanged`.** Đọc lại sau thì lần vẽ dùng danh
  sách trước bake: rỗng (phiên bắt đầu không có chú thích Nabu) ⇒ hình vừa nướng **vẽ hai lần** (ĐO trong Electron:
  309 điểm xanh trên canvas dưới bản overlay); cũ ⇒ không khớp ⇒ ẩn hết.
- **Luật 5 — bôi đen dùng CÙNG danh sách** (`rasterRedacted`, §3.4-3). Trang bôi đen được dựng lại chỉ từ ảnh này,
  nên cái gì ảnh không vẽ là **mất khỏi file**: trước đây trang có chú thích Nabu bị vẽ `DISABLE` ⇒ chú thích của đối
  tác trên trang đó mất hẳn (ĐO: 1 371 → 238 điểm đỏ sau khi bôi đen). Nay chỉ bản Nabu bị bỏ (overlay vẽ lại bằng
  vector; cái đã xoá ở overlay **không** quay lại thành pixel), mọi chú thích khác thành pixel như trang không có của
  Nabu. Không còn dựa vào `_managedPages` ở đây (tập đó gồm cả trang chỉ có đối tượng MỚI — chẳng có gì để giấu).
- Còn lại: ghi chú `/Text` của người khác **không có `/AP`** vẫn không có dấu trên trang khi đang sửa (`addNoteMarkers`
  chỉ chạy ở chế độ xem — dấu HTML sẽ chặn chuột của công cụ vẽ); vẫn thấy trong tab Chú thích. Đợt 3b nhập chúng.
- **Đã kiểm E2E trong Electron thật trên FILE CỦA KHÁCH** (CDP, 21/21 + bôi đen 12/12; trả hành vi cũ ⇒ 4 và 3 đỏ;
  đảo thứ tự Luật 4 ⇒ 1 đỏ): vào Chú thích → điểm đỏ y nguyên; vẽ khung xanh, lưu giữa phiên → canvas không có khung (overlay vẽ), đỏ y
  nguyên, storage rỗng; Xong → khung trên canvas; vào lại → ẩn; xoá ở overlay → không hiện lại từ file; Hủy bỏ → hiện.
- **Vỡ khi:** vào Chú thích mà chữ / hình của đối tác hoặc giá trị form biến mất · hộp chữ Nabu hiện hai lần (một bản
  mờ lệch dưới overlay) sau Ctrl+S giữa phiên · xoá hộp chữ Nabu rồi cuộn đi cuộn lại thấy nó hiện lại · bôi đen trang có hộp chữ Nabu
  mà chú thích của đối tác trên trang đó biến mất, hoặc hộp chữ vừa xoá hiện lại thành pixel.

### BI-100 · Hình của phần mềm khác **sửa được** trong Chú thích — **không đụng thì không ghi**, gỡ bản gốc chỉ khi chắc chắn
- `renderer/foreign-annot.js` (`window.ForeignAnnot`: `readForeign` / `toObjects` / `planForeign` / `removeOriginal` /
  `applyKeep`) · `editor-bake.js` `importManaged` → `importForeignAnnot` (ghi `ed._foreignImported` + `ed._owned`),
  `foreignPlan` / `removeForeign` trong **cả hai** đường bake, `applyKeep` trong `drawAnnots` · `editor.js` `copySelected`
  bỏ `_foreign`, `listObjects` trả `fileRef` / `author` / `subtype` · `side-panels.js` `composeItems` bỏ dòng file đã nhập ·
  `annot-scan.js` `labelOf` (Line nhập thành `poly` vẫn là "Đường kẻ"). Lưới `npm run test:foreign`.
- **Nhập (nhóm B của Q1):** Square → `box` / `cloud` (`/BE /S /C`), Circle → `ellipse`, Line có MỘT đầu mũi tên → `arrow`
  (đầu ở `x2,y2`), Line trơn → `poly` hở 2 điểm, Polygon → `poly` kín (`PolygonCloud` → `cloudpen`), PolyLine → `poly` hở,
  Ink n nét → n `draw` (MỘT bản gốc). Toạ độ qua `convertToViewportPoint` của viewport scale-1 — nghịch đảo đúng cái map
  bake ghi ra (trang xoay đúng sẵn, BI-45; test: sửa màu trên trang `/Rotate 90` → đọc lại đúng chỗ).
  **Chưa nhập** (vẫn vẽ bởi pdf.js, viền đứt trong danh sách): FreeText / Text / Highlight (nhóm A, Đợt 3c), Stamp.
- **Luật 1 — N3: thứ Nabu không nói được thì KHÔNG nhập**, chứ không nhập rồi làm sai: `/CA` < 1, viền 0 hoặc không `/C`,
  cờ Hidden / NoRotate / NoView / ReadOnly / Locked, `/OC`, có trả lời hoặc là trả lời (`/IRT`), đường kích thước, `/LL`,
  `/Cap`, mũi tên hai đầu, PolyLine có đầu mũi tên, Circle mây, dict nội tuyến (không số đối tượng).
- **Luật 2 — N1 quyết bằng GIÁ TRỊ, không bằng theo dõi thao tác.** Lúc nhập lưu `JSON.stringify(serializeManaged(a))` của
  từng bản sao; lúc bake: bản gốc "không đụng" ⇔ đúng ngần ấy bản sao, đúng trang đó, giá trị y như lúc nhập (không kể thứ
  tự). Không đụng ⇒ bake **bỏ qua** bản sao, **không** gỡ bản gốc ⇒ dict giữ nguyên số đối tượng và nội dung. Kéo rồi Ctrl+Z
  về chỗ cũ = không đụng. `copySelected` bỏ `_foreign` ⇒ bản dán là đối tượng Nabu mới, bản gốc yên.
- **Luật 3 — N2: gỡ bản gốc chỉ khi trang đó, số đối tượng đó vẫn là đúng nó** (`/Subtype` + `/Rect` + `/NM`); lệch ⇒ giữ,
  toast cảnh báo, bản Nabu vẫn được ghi (hai bản còn hơn mất lời bình). Gỡ kèm `/Popup`; luồng `/AP` chỉ giải phóng khi
  không chú thích nào khác dùng chung.
- **Luật 4 — bản sửa giữ người tạo**: `applyKeep` chép `/T /Contents /NM /Subj /CreationDate` lên chú thích Nabu vừa ghi; `/NM` là tên DUY NHẤT nên một bản gốc thành nhiều bản Nabu (Ink nhiều nét) thì chỉ bản nhập đầu tiên mang `/NM` (`planForeign` → `keepFor`)
  (không đè khoá Nabu đã ghi). Danh sách vẫn hiện tên tác giả; mở lại vẫn cùng `/NM`.
- **Luật 5 — đường bôi đen**: `removeForeign(src)` **trước** `copyPages`; bản gốc không đụng nằm trên trang bôi đen thì vẫn
  được vẽ vào ảnh (`keepIds` loại khỏi danh sách ẩn của `rasterRedacted`), như mọi chú thích khác của đối tác (BI-99 Luật 5).
- **Luật 6 — CON DẤU (Đợt 3b-2): chỉ `/Rect`, không bao giờ vẽ lại.** Stamp → đối tượng `image` hiện **ảnh đại diện** vẽ từ
  chính `/AP` (`stampProxyPdf`: form `/BBox` qua `/Matrix` khớp vào `/Rect`, `/CA` thành graphics state, xoay theo trang;
  `stampProxyUrl` vẽ nền trong suốt, tối đa 3×, tối đa 200 con dấu mỗi lần vào). Kéo / đổi cỡ ⇒ `planForeign.rects` ⇒
  `updateRect` đổi **duy nhất** `/Rect` của bản gốc (cùng số đối tượng, cùng `/AP`, không thêm ảnh); xoá ⇒ gỡ kèm Popup
  và luồng ảnh; bản sao (dán / Áp nhiều trang) ⇒ ảnh Nabu mới, **không** mang `/NM` gốc. Trang bôi đen: con dấu đã kéo
  được vẽ bằng ảnh đại diện (trang đó vốn là ảnh). Con dấu có `/Rotate` riêng ⇒ không nhập. ĐO trên file khách: ảnh đại
  diện của ảnh dán lệch trung bình **4,38/255** so với trang; kéo 60, −40 px ⇒ `/Rect` dời đúng 60, +40 pt, mọi khoá khác
  y nguyên; file không to thêm.
- **Luật 7 — HỘP VĂN BẢN (Đợt 3c, nhóm A): sửa xong vẫn là CHÍNH `/FreeText` đó** (cùng số đối tượng, không `/NabuKind`) để
  đối tác sửa tiếp trong Acrobat / Foxit. `writeFreeText` ghi `/Contents` (dòng `\r`), `/DA` (giữ tên font của họ, cỡ +
  màu của Nabu), `/DS`, `/Q`, `/C` (nền), `/M`; **bỏ `/RC`** (nhiều kiểu → một kiểu — mất mát Q1 đã chấp nhận); vẽ `/AP` mới
  bằng chính bộ dựng chữ PNG của Nabu (tiếng Việt không cần nhúng font) + nền + **viền của họ** (màu đọc từ `RG` trong `/AP`
  gốc); khung = hộp, phần ảnh chữ tràn ra ghi vào `/RD` ⇒ lần nhập sau đọc lại đúng hộp; trang xoay qua `/Matrix` +
  `apRectFor` như nhánh ảnh (BI-59). Hộp Nabu **không tự ngắt dòng** ⇒ lúc nhập chữ được ngắt theo bề rộng hộp (`wrapText`,
  đo bằng `layoutTextBox`); nếu người dùng không gõ lại chữ, `/Contents` gốc được ghi lại **nguyên văn** (không thêm dấu xuống
  dòng). Callout (`/CL`), hộp có `/Rotate` riêng, `/CA` < 1, hộp rỗng ⇒ không nhập. N2 không nhận ra bản gốc ⇒ bản gốc giữ
  nguyên, bản sửa ghi thành hộp chữ Nabu bên cạnh (không mang `/NM`) + cảnh báo. ĐO trên file khách: gõ lại "size 50mm" qua ô
  sửa chữ thật ⇒ `37 0 R` vẫn là `/FreeText`, `/DA` `/F1 10 Tf 1 0 0 rg`, `/RC` bỏ, viền đỏ còn; kéo `22 0 R` 30 pt ⇒ chữ y nguyên.
- **Luật 8 — GHI CHÚ DÁN (Đợt 3c-2): vẫn là CHÍNH `/Text` đó.** `writeTextNote` ghi `/Contents`, `/Rect` (theo hộp, từng góc qua
  map — trang xoay đúng sẵn), `/C`, `/M`; biểu tượng `/AP` của họ **giữ** khi màu không đổi, **bỏ** khi đổi màu (Acrobat / Foxit
  vẽ lại theo màu mới; chế độ xem của Nabu luôn có dấu ghi chú riêng). `/Popup`, `/Name`, tác giả giữ nguyên. **Trả lời gõ
  trong Nabu = một `/Text` RIÊNG có `/IRT`** (`replyAnnot`: `/NM` mới, `/M` theo giờ gõ, không bịa `/T`) — đúng cách Acrobat
  lưu luồng, chứ không nhồi vào `/Contents` của họ; từ đó ghi chú là một luồng ⇒ lần nhập sau để yên (như mọi luồng).
  Ghi chú có trả lời / là trả lời ⇒ không nhập. `/F 28` (NoZoom + NoRotate — Acrobat ghi cho MỌI ghi chú) được chấp nhận
  cho `/Text`; ghi chú bị khoá vẫn không nhập. ĐO trong Electron (file kiểu Acrobat, 18/18): "Sửa gốc" ⇒ cùng `/Text`, biểu
  tượng + Popup còn; "Thêm bình luận" ⇒ một `/Text /IRT` mới, lời của họ không đổi; luồng sẵn có y nguyên.
- **Luật 9 — TÔ SÁNG (Đợt 3c-3): vẫn là CHÍNH `/Highlight` đó.** Nhập thành `texthl` (một hộp mỗi quad, độ mờ = `/CA` ×
  `ca` trong ExtGState của `/AP` — bộ ghi của Nabu để alpha ở ĐÓ với `/CA 1`, nên phải đọc ở đó, không thì sửa lần hai âm thầm
  đổi độ mờ). Ghi: `writeHighlight` nhờ chính bộ ghi `texthl` của Nabu (đã ra `/Highlight` thật, quad theo từng góc, Multiply)
  tạo MỘT chú thích tạm, chuyển `/Rect /QuadPoints /C /CA /AP` sang dict GỐC, bỏ chú thích tạm (không để lại `/NabuKind`);
  `/Contents` (chữ được tô) chỉ ghi khi đổi; `/M` mới. ĐO trên file khách: đổi màu `54 0 R` qua ô Màu thật ⇒ cùng
  `/Highlight`, quad của họ y nguyên (±0,01 pt), chỉ `/AP /C /CA /M /Rect` đổi.
- **Hiệu năng (ĐO):** vào Chú thích trên 400 trang / 2 000 chú thích nhập được (hình, đường, Ink, hộp chữ, tô sáng) ⇒ 2 000 đối
  tượng sau ~0,5 s, một khung hở lớn nhất 267 ms (nạp pdf-lib — có từ trước). Con dấu có trần 200 ảnh đại diện mỗi lần vào.
- **Đếm vào `_importedManaged`** (BI-60): xoá hết hình của đối tác vẫn kích hoạt bake.
- **Đã kiểm E2E trong Electron thật trên FILE CỦA KHÁCH** (CDP, 20/20 hai lần): vào Chú thích → 11 hình (3 mây, 2 mũi tên,
  6 đường kẻ) là đối tượng sống, tác giả `hang_`, bản gốc ẩn theo tên; danh sách 19 dòng (11 sống + 8 viền đứt); Xong không
  sửa → file **y từng byte**; kéo khoanh mây bằng chuột (40, 20 px) + xoá một đường kẻ → Xong: mây thành MỘT chú thích Nabu
  giữ `hang_` + `/NM`, đường kẻ mất, **18 chú thích còn lại cùng số đối tượng, cùng dict**; copy + dán một khoanh mây → bản
  gốc y nguyên + một mây Nabu mới; Ctrl+Z → **đúng bytes gốc**. Bôi đen trang 1 → 11 hình ở trang 6–10 còn là chú thích của
  đối tác. Nhập mất 64–211 ms với file 10 MB.
- **Vỡ khi:** sửa hộp văn bản của đối tác xong mà Acrobat thấy nó là con dấu (không gõ được nữa) / mất tên người tạo / chữ bị ngắt dòng lạ sau khi chỉ kéo · kéo con dấu / ảnh dán của đối tác xong mà nó bị mờ / thành ảnh Nabu / file to ra · mở file của đối tác, vào Chú thích, không sửa gì mà Lưu ra file khác · đối tác mở lại thấy hình bị nhân đôi /
  mất tên người tạo / mất lời bình · xoá hình của đối tác mà Popup còn lại · hình trên trang xoay lệch chỗ sau khi sửa ·
  danh sách liệt kê một hình hai lần khi đang sửa.

### BI-101 · Vẽ lại trang "ngay bây giờ" phải chờ lần vẽ đang dở — không bao giờ để trang kẹt `rendered=0` với bitmap cũ
- `app.js` `repaintPage(i)` — dùng bởi `repaintRenderedPages` (vào / ra Chú thích) và `rerenderChanged`. Lưới
  `npm test -- render-race thumb-refresh`.
- Kiểu cũ "đặt `rendered=0` rồi gọi `renderPageCanvas`" hỏng khi trang đang vẽ dở: `renderPageCanvas` từ chối trang
  `m.rendering`, mà lần vẽ dở đã đặt `rendered=1` TRƯỚC khi bị xoá ⇒ không ai đặt lại ⇒ trang giữ bitmap của chế độ vừa
  rời và không được vẽ lại cho tới khi cuộn đi cuộn lại. ĐO trên file khách (probe_hide, 3/3 lần): ra khỏi Chú thích khi
  trang 1 còn đang vẽ cho chế độ sửa ⇒ ở chế độ XEM con dấu của đối tác và khung Nabu vẫn bị ẩn. Lỗi có từ trước; Đợt 3b
  làm nó dễ xảy ra hơn (vào Chú thích lâu hơn vì vẽ ảnh đại diện con dấu).
- Luật: chờ lần vẽ dở xong (tối đa ~5 s), rồi mới đặt cờ và vẽ lại; trang đang vẽ dở được coi là "đang hiện".
- **Vỡ khi:** ra khỏi Chú thích mà hình / con dấu / hộp chữ còn ẩn trên trang đầu tiên cho tới khi cuộn.

### BI-102 · Chữ `/edit-text` vẽ ra phải **đọc lại đúng ký tự đã gõ** — ToUnicode gộp, không thay
- `api.py` `/edit-text` (vòng `drawn_fonts` → `by_xref` sau `subset_fonts`), `src/pdf/fonts.py`
  `_merge_tounicode` / `_parse_tounicode` / `_tounicode_cmap` / `_drawn_glyph_map`. Lưới:
  `.venv\Scripts\python test_edit_text_tounicode.py` (7 ca).
- `insert_text` dựng ToUnicode bằng cách **đảo cmap** của font; Arial Windows dùng chung glyph cho U+002D/U+00AD
  và U+0020/U+00A0, PyMuPDF 1.27.2 chọn ký tự giống-mà-khác ⇒ trang **nhìn đúng**, lớp chữ là
  `I2_BD\xadS\xad5.001` — Tìm & Thay thế không tìm lại được, copy mang soft hyphen ẩn. DejaVu có glyph riêng nên
  lưới cũ không bao giờ thấy. Đo trên bộ bản vẽ khách sau Thay tất cả.
- Luật: mỗi glyph đã vẽ ↦ đúng ký tự đã vẽ (trùng glyph ⇒ code point **thấp** thắng), **gộp** vào CMap cũ:
  PyMuPDF dùng **một object font cho mọi trang** chèn cùng file font (đo: ghi theo trang ⇒ trang 2 mang chữ số của
  trang 13), nên CMap là trạng thái chung. Không đọc được CMap ⇒ **không đụng** (chữ vẫn đúng, chỉ lớp chữ như cũ).
- ⚠️ PyMuPDF ghi code point ngoài BMP dạng số trần `<10780>` (không phải surrogate) — bộ đọc phải nhận, không thì
  mọi lần gộp bị từ chối **im lặng** (đã vấp lúc làm).
- ⚠️ Fixture dựng bằng `insert_text` + Arial **tự mang lỗi này** ⇒ file nguồn của test phải được làm sạch trước
  (xem `_arial_src`), và các trang phải **khác nhau** — fixture đồng nhất đã để lọt đột biến "chỉ gộp trang cuối".
- **Vỡ khi:** thay xong tìm lại chính chữ vừa thay (có `-` hoặc dấu cách) ra 0; copy số hiệu bản vẽ dán sang
  Excel mất dấu gạch.

### BI-103 · "Tạo bản theo mẫu" không sửa file đang mở, không ghi file chưa **đọc lại**, không ghi đè khi chưa hỏi
- `renderer/batch-variants.js`, `main.js` `dialog:choose-dir` / `file:write-new-pdf`. Lưới:
  `npm test -- batch-variants` (86 ca: luật mã, tên file, khoảng giá trị, đếm kiểm tra, chốt nguồn).
- Không có đường ghi riêng: payload là `FindReplace.pure.groupEdits` → `/edit-text` (thừa hưởng BI-21/23/25/66/102).
  Nguồn là `state.bytes` **đang mở** (gồm thay đổi chưa lưu) nhưng **không bao giờ** gán `state.bytes` / gọi
  `pushUndo` (test ghim).
- Mỗi file đầu ra được **quét lại** trước khi ghi: số chỗ mã cũ và mã mới phải đúng như dự đoán
  (`expectedCounts`/`countsMatch`); lệch ⇒ file đó **không ghi**, báo lý do. Đếm mã mới trên bản gốc làm
  **trước** vòng lặp (sidecar chỉ cache một chỉ mục).
- "Khớp nguyên mã" (`code_boundary`) bật mặc định — `I1` không khớp trong `I10`. Quét chạm trần 5000 ⇒ **chặn**
  tạo bản (không hứa "mọi chỗ").
- Ghi bằng cờ `wx`; tồn tại ⇒ hỏi "Ghi đè?" từng file. Tên file: chỉ basename `.pdf`, không ký tự cấm (main kiểm).
  Hộp chọn thư mục tuân BI-85 (khôi phục + ghi nhớ thư mục).
- Đo E2E trên app thật (CDP, file khách): 25 chỗ/13 trang → 2/2 file I2, I3; mỗi file 0 `I1`, 25 mã mới, cao chữ
  18.25 = gốc; file đang mở giữ nguyên object bytes; lần 2 hỏi ghi đè từng file, chọn bỏ qua ⇒ "0/2, Bỏ qua: …".
- **Vỡ khi:** file sinh ra còn sót mã cũ / dính mã I10; file đang mở bị đổi hoặc Ctrl+Z có thêm bước; hộp
  "Ghi đè?" nằm dưới hộp thoại; Esc đóng hộp thoại khi đang ghi dở.

### BI-104 · Hộp chữ cố định bề rộng (`boxW`): màn hình, ô gõ và file lưu **ngắt dòng ở cùng một chỗ**
- `annot-text.js` (`normTextStyle.boxW`, `wrapItemsPt`, `wrapLine`, `wrappedDisplayText`), `editor.js`
  (`openTextEditor` setBox/applyBox/ResizeObserver, drag `"textbox"`, nhánh resize `a.kind === "text"`,
  `#fmt-wrap`), `managed-codec.js` + `editor-bake.js` (`boxW` trong /NabuData). Lưới: `npm run test:text`
  (B1–B12, có chốt nguồn editor.js).
- Bấm = hộp **thường** như cũ (ngắt chỉ ở Enter); **kéo** khi đặt = hộp cố định bề rộng; kéo tay nắm / kéo
  giãn ô gõ / nút "Tự xuống dòng theo khung" đổi bề rộng; **chiều cao luôn tự giãn**.
  ⚠️ "Kéo giãn ô gõ" chỉ tính khi người dùng **đang nhấn chuột trên ô gõ** — xem BI-111 (đổi kiểu chữ lúc gõ từng biến hộp
  thường thành hộp cố định). Hộp thường giờ có ô gõ
  `wrap="off"` — ô gõ không còn giả vờ xuống dòng (đúng lời phàn nàn gốc).
- ⚠️ Chỗ ngắt dòng quyết **một lần, ở pt** (`wrapItemsPt` đo ở `fpx/upp`): canvas ở 3× không rộng đúng 3× ⇒
  ngắt theo tỉ lệ của lời gọi thì overlay (1×) và PNG bake (3×) lệch dòng ở chữ sát mép. Overlay hiển thị
  **dòng đã ngắt** (`white-space: pre`), không bao giờ để trình duyệt tự gói (`pre-wrap` = thuật toán khác).
- `boxW` nằm trong `normTextStyle` ⇒ mọi đường đo lại tự mang theo; ghi vào payload **chỉ khi > 0** ⇒ hộp cũ
  byte-identical (BI-59). Tay nắm chỉ khi **không xoay** (tay nắm nằm trên phần tử đã xoay, kéo đọc ở hệ trang).
- Ô gõ: `border-box` toàn cục ⇒ bề rộng = `boxW·scale` + padding/viền (đọc computed style; `applyTextCss` đặt
  `paddingLeft` = thụt lề); ẩn thanh cuộn dọc (nó ăn bề rộng ⇒ ngắt sớm), tự giãn cao.
- Đo E2E (app thật, CDP, chuột/phím thật): bấm → 1 dòng, không tay nắm; kéo 150pt → vùng chữ ô gõ đúng
  150px, hộp 5 dòng; kéo tay nắm −50pt → 7 dòng, cao tự giãn; tắt nút → 1 dòng, Ctrl+Z → 7; kéo giãn ô gõ hộp
  thường → thành hộp cố định 3 dòng; bake → PNG trong file **7 dòng đúng từng chữ**; mở lại → y hệt.
- **Vỡ khi:** trên màn hình 7 dòng mà file lưu 6/8; hộp cũ mở ra bị ngắt dòng; kéo tay nắm hộp chữ làm chữ
  méo/không đổi dòng; Esc lúc kéo tạo hộp làm mất ô gõ.

### BI-105 · Menu gốc (thanh menu Electron) đi qua **cùng luật** với thanh công cụ — một cổng ở dispatcher
- `app.js` `menuBlockReason(cmd, ctx)` (thuần) + `menuGuardContext()` + `window.desktop.onMenuCommand`. Lưới:
  `npm run test:menu` (bảng chân trị, dispatcher gọi cổng TRƯỚC `fn()`, hợp đồng `send("x")` ⇄ `actions`, chuỗi từ
  chối có bản EN). Review gốc: `docs/REVIEW-2026-10-12-menu-bar.md` (M1/M2).
- Menu gốc **không có trạng thái bật/tắt** — mục nào cũng bấm được bất kể toolbar đang tắt nút. Trước bản này chỉ
  `replaceSelectedFromFile` có khoá "đang chỉnh sửa" ⇒ **đo trên mã cũ** (app thật, `MenuItem.click()` của menu
  thật): đang Chú thích, menu Trang → Xoay rồi Xoá ⇒ tài liệu 3 → 2 trang, +2 bước hoàn tác, trình chú thích **vẫn mở**
  (chỉ số trang xê dịch dưới lớp phủ). Không có tài liệu, Ghép PDF… cho chọn file rồi `PDFDocument.load(null)` ném lỗi
  không ai bắt.
- **Luật:** lệnh cấu trúc trang (`rotateL/R`, `delete`, `merge`, `insert`, `replace`, `extract`) cần tài liệu, bị
  chặn khi `Editor.active`/`TextEdit.active`, khi có `.modal` đang mở, khi `#overlay` (đang xử lý) hiện. Lệnh mở hộp
  thoại/chạy việc (`print`, `encrypt`, `extractImages`, `pdfToImages`, `imagesToPdf`) chỉ nhường hộp thoại đang mở và
  việc đang chạy — **không** đòi tài liệu (Ảnh → PDF không cần; các hàm đó tự `convertReady`). Mở/Lưu/Hoàn tác/Zoom/
  Trợ giúp **không bao giờ** bị cổng này chặn (Lưu và zoom cố ý dùng được khi đang chỉnh sửa; Ctrl+S/Ctrl+O là
  accelerator thật của menu nên chặn ở đây = đổi cả bàn phím).
- Thêm lệnh menu mới ⇒ thêm `send("x")` ở `main.js` **và** khoá `x` trong `actions` (test đỏ nếu lệch); lệnh đổi cấu
  trúc trang ⇒ thêm vào tập `PAGE` của `menuBlockReason`. Không viết lại guard trong từng hàm.
- **Đợt 3 (menu = gương của toolbar):** Trang / Công cụ / Xuất trùng `Trang ▾` / `Công cụ ▾` / `Xuất ▾` từng mục, cùng
  thứ tự. Mục nào **là** một nút toolbar thì đi qua `clickToolbarFor(id)`: bấm chính nút đó ⇒ thừa hưởng handler,
  trạng thái bật/tắt (`updateToolbar`) và cổng bản quyền. ⚠️ Capture guard chỉ biết id **được bấm**; mục trong
  `Công cụ ▾`/`Xuất ▾` được gate qua **nút dropdown**, và `openOffice`, `Compare.open`, `Capture.toggle` **không tự
  gate** ⇒ `clickToolbarFor` coi mục là trả phí khi nó **hoặc** nút dropdown của nó nằm trong `GATED_BTNS` — rộng
  đúng bằng đường toolbar, không hơn (Trang ▾ không gate ⇒ Ghép nhiều trang/tờ vẫn miễn phí). **Đừng** thay proxy
  bằng gọi thẳng handler (lưới G5 ghim bảng lệnh → nút). Tập `TOOL` của `menuBlockReason`: chặn khi đang chỉnh sửa
  — `btn-edit` vẫn BẬT lúc đang Chú thích vì nó là nút **thoát**, nên mục menu "Chú thích" bấm hộ sẽ kết thúc +
  bake phiên nếu không chặn. Phím renderer giữ (Ctrl+F/H/P/Z/Y, F4, F11, Delete) hiện trên menu với
  `registerAccelerator: false` (lưới H). "Chọn tất cả" (`role`, Ctrl+A = chọn chữ) giữ nguyên; "Chọn tất cả trang" là
  mục riêng, không đảo chiều như nút toolbar.
- E2E Đợt 3 (2026-10-12): 34/34 — cấu trúc menu thật vi+en, các proxy mở đúng hộp thoại, Chú thích bấm lại khi đang
  chú thích **không** thoát phiên, bản quyền giả lập "chưa kích hoạt" chặn Office/So sánh/Copy ảnh/Ký số/Chú thích
  nhưng không chặn Ghép nhiều trang/tờ. (Bẫy probe: `openSettings()` đọc lại bản quyền thật ⇒ đặt lại `licState`
  trước mỗi bước.)
- Đổi tên / gom lại menu cấp 1 ⇒ `test:menu` nhóm E đỏ cho tới khi `help.js` gọi đúng tên mới (Hướng dẫn từng
  mô tả sai menu Tập tin suốt từ v0.2.53 — REVIEW M3). Mục mới trên menu ⇒ cập nhật câu “cũng có trong menu …” của
  `help.js`: lưới chỉ kiểm được **tên menu**, không kiểm được danh sách lệnh trong câu.
- E2E (2026-10-12, app thật, CDP + Node inspector): bản sửa 28/28 + 7/7 (không tài liệu); bản HEAD cũ đỏ đúng 4 ca.
- **Vỡ khi:** đang Chú thích/Sửa nội dung mà menu Trang vẫn đổi được trang; chưa mở file mà Ghép/Chèn mở hộp chọn
  file; Ảnh → PDF bị từ chối khi chưa mở file; Phóng to/Lưu bị từ chối khi đang chỉnh sửa.

### BI-106 · Căn đều (justify): màn hình căn **đúng những dòng** file lưu căn
- `annot-text.js` `isLastOfPara` (luật "dòng cuối đoạn" — một hàm, hai người đọc) + `justifiedDisplayLines`;
  `editor.js` `renderJustifiedLines` (nhánh `st.align === "justify"` của `renderAnnot`); `app.css`
  `.an-text-line` / `.jl` / `.an-text-mk`. Lưới: `npm run test:text` nhóm J (J1 so cờ màn hình với dòng mà
  `layoutTextBox` **thật sự** giãn, đọc từ ops; J6 nửa "hộp cố định" của luật; J5 chốt nguồn editor.js/app.css).
  Nghiên cứu gốc: `docs/RESEARCH-2026-10-12-text-format-panel.md` F1.
- Lỗi cũ (đã đo): overlay là `white-space: pre` với dòng ngắt sẵn bằng `\n` ⇒ CSS coi **mọi** dòng là dòng cuối đoạn
  ⇒ `text-align: justify` không giãn dòng nào; bake (`layoutTextBox`) giãn mọi dòng trừ dòng cuối đoạn. App thật
  (HEAD cũ): hộp thường "a b" trên màn hình kết thúc ở 21,9 pt, trong file ở 203,7 pt (lệch 182 pt); hộp cố định lệch
  7,3 pt. Màn hình căn trái, file căn đều — khuôn im lặng BI-40.
- Sửa: hộp **căn đều** dựng **một phần tử mỗi dòng**; dòng nào bake giãn thì mang `.jl` (`text-align-last:
  justify` — một dòng đơn là "dòng cuối" của chính nó), rộng đúng `width` của bake tính từ thụt lề (chia
  `charScale` như `el.style.width`). Dấu đầu dòng là `inline-block` (nguyên khối) để giãn không nới khoảng sau
  "1.". Dòng trống giữ cao một dòng (`min-height: 1lh`). Căn trái/giữa/phải **không đổi gì** (vẫn một chuỗi).
- E2E (2026-10-12, app thật, chuột/phím thật qua CDP): hộp cố định 240 pt + hộp thường có dòng trống, gõ tiếng Việt
  ⇒ đầu mỗi từ và mép phải mỗi dòng **trùng bake ≤ 0,02 pt**; hàng dọc đúng bội số line-height (kể cả dòng trống);
  hộp căn trái vẫn một nút chữ. 11/11. Chưa đo: danh sách + căn đều (cột dấu đầu dòng trên màn hình vốn là xấp xỉ),
  `charScale` ≠ 100%, ô gõ (`<textarea>`) của hộp thường lúc đang gõ vẫn hiện căn trái (trình duyệt không giãn
  dòng có ngắt cứng) — chỉ là bản xem trước lúc gõ, Ctrl+Enter là thấy đúng.
- **Vỡ khi:** hộp căn đều trên màn hình thẳng mép phải mà file lưu lởm chởm (hoặc ngược lại); dòng cuối đoạn bị
  giãn trên màn hình; khoảng sau "1."/"•" bị nới; dòng trống giữa hai đoạn biến mất trên màn hình; hộp căn
  trái/giữa/phải đổi bố cục.

### BI-107 · Bảng Định dạng văn bản: thu gọn / mở rộng (nhớ theo máy) + ô "Bề rộng khung"
- `index.html` `#fmt-collapse` (trong `.fmt-head`), `#fmt-boxw` (ngay sau `#fmt-wrap`); `editor.js` banner
  Format panel: `FMT_COLLAPSED_KEY`/`setFmtCollapsed`, khối "Bề rộng khung (pt)", nửa `bw` của `syncFmtPanel`,
  `syncFmtPanel()` cuối `onUp`; `app.css` `.fmt-panel.collapsed`. Lưới: `npm run test:fmtpanel` (cắt từng khối khỏi
  editor.js chạy trên DOM giả + chốt markup/CSS/i18n). Nghiên cứu gốc: `docs/RESEARCH-2026-10-12-text-format-panel.md` P1, P2.
- **Thu gọn** là một **class**, độc lập với `hidden`: `updateFmtPanel` vẫn quyết **khi nào** bảng hiện, nút chỉ quyết hiện
  **bao nhiêu** (dải 40 px chỉ còn nút). Lưu `localStorage["nabu-fmt-collapsed"]` ("1"/"0"), mọi truy cập trong
  try/catch (không đọc được = mở rộng). Tiêu đề nút **tĩnh** — không có chữ động nên không cần `SKIP_IDS` (BI-10).
  `mousedown` preventDefault như mọi nút của bảng (ô gõ đang mở không mất focus; `#fmt-panel` nằm trong
  `PALETTE_KEEP_SEL` nên bấm nút không bỏ chọn hộp).
- **Bề rộng khung**: cùng số học với kéo tay nắm (đặt `boxW`, đo lại `w/h`, giữ `x/y`). Chỉ bật cho hộp **cố định bề
  rộng** đang chọn — ô này **không** biến hộp thường thành hộp cố định (việc đó là của `#fmt-wrap`). `input` áp ngay
  nhưng **bỏ qua** số < `MIN_BOX_W` (gõ "150" không bóp hộp về 24 pt ở chữ "1"); `change` (Enter / rời ô) kẹp vào
  [`MIN_BOX_W`, max của ô] và ghi lại số đã kẹp; rác/rỗng ⇒ hiện lại bề rộng hiện tại. `min` của markup **phải bằng**
  `MIN_BOX_W` (lưới K8). Hộp **đã xoay** (không có tay nắm, BI-104) đổi được bề rộng qua ô này.
- Hoàn tác: một bước cho mỗi đợt gõ (khoá `boxw:<id>`, gộp 800 ms như mọi ô số của bảng). Hai lần sửa cách nhau < 800 ms
  gộp làm một — cùng luật với Giãn dòng/Giãn ký tự…, không phải lỗi riêng của ô này.
- E2E (2026-10-12, app thật, chuột/phím thật, hai lần mở app cùng hồ sơ): 17/17 — mở lần đầu: bảng mở rộng 236 px, chưa lưu
  gì; ô tắt khi chưa chọn; hộp kéo 240 pt ⇒ ô hiện 240; gõ "1" không đổi hộp, "150" ⇒ hộp hẹp lại 3 → 5 dòng; Tab với "5" ⇒
  24; Ctrl+Z hai lần ⇒ 150 rồi 240; xoay 90° ⇒ không tay nắm, ô vẫn bật, 120 ⇒ 6 dòng; thu gọn ⇒ dải 40 px, vẫn giữ chọn;
  EN dịch đúng; mở lại app ⇒ bảng **vẫn thu gọn**, bấm ⇒ mở 236 px. (Bẫy probe: Chromium ghi localStorage xuống đĩa trễ
  ~5 s — giết tiến trình sớm hơn thì "mất"; thoát bình thường thì không.)
- Chưa làm (cố ý): hộp xoay đổi bề rộng giữ `x/y` như tay nắm, nên tâm xoay dịch theo — giống hệt trên file đã lưu (không
  lệch BI-40), chỉ là hộp "trượt" một chút trên màn hình. Hoàn tác (`edRestore`) bỏ chọn nhưng không gọi
  `updateFmtPanel` — có từ trước, ô Tự xuống dòng cũng vậy; ô Bề rộng khung khi đó gõ vào không làm gì.
- **Vỡ khi:** gõ số đầu tiên làm hộp co về 24 pt; ô sửa được hộp thường; kéo tay nắm xong ô vẫn hiện số cũ; mở lại app
  bảng không nhớ thu gọn; bảng thu gọn vẫn đè 236 px; bấm nút thu gọn làm mất focus ô gõ / bỏ chọn hộp.

### BI-108 · Bảng Định dạng: Ký tự đặc biệt + kiểu chữ mặc định ("Đặt làm mặc định" / "Xoá định dạng")
- `index.html` `#fmt-symbols` (10 nút `data-ch`), `#fmt-set-default`, `#fmt-clear`; `annot-text.js` `TEXT_DEFAULT_KEYS`,
  `TEXT_SIZE_MIN/MAX/DEFAULT`, `pickTextDefault`, `parseTextDefault` (thuần, `test:text` nhóm T); `editor.js` `ed._taInsert`
  (trong `openTextEditor`, xoá ở `clearTaHooks`), khối "Ký tự đặc biệt", khối `TEXT_DEFAULT_LS`, `clr.disabled` trong
  `syncFmtPanel`, dòng gán lại `#ed-font` cuối `loadSystemFonts`. Lưới: `npm run test:fmtpanel` nhóm S + D. Nghiên cứu
  gốc: `docs/RESEARCH-2026-10-12-text-format-panel.md` P3, P4.
- **Ký tự đặc biệt** chỉ chèn khi **ô gõ đang mở** (vào đúng con trỏ, thay vùng đang bôi đen) — không có ô gõ thì báo cách
  mở, không tự nối vào hộp đang chọn. `document.execCommand("insertText")` để Ctrl+Z **trong ô gõ** gỡ được ký tự và
  `input` chạy như phím gõ (growDown, hộp cố định bề rộng); `setRangeText` + `input` là đường dự phòng. Nút có
  `mousedown` preventDefault — mất focus là ô gõ **chốt** hộp (`blur` → commit). Là ký tự Unicode, không phải chỉ số
  trên/dưới (một hộp một kiểu). Glyph: bake là raster canvas ⇒ font dự phòng của hệ thống vẽ; đã đo cả 10 ký tự có
  glyph thật ở sans/serif/mono trên Windows 11 (khác hẳn BI-102, nơi font **nhúng** của sidecar thiếu glyph).
- **Đặt làm mặc định**: lấy kiểu của hộp đang chọn (không chọn ⇒ kiểu bảng đang đặt, **kèm cỡ chữ**) qua
  `pickTextDefault` ⇒ ghi `localStorage["nabu-text-default"]` + nạp vào `ed` (`opacity` → `ed.textOpacity`). Mang:
  font, cỡ, B/I/U, gạch ngang, căn lề, giãn dòng/đoạn/ký tự/từ, co giãn ngang, thụt lề, danh sách, độ mờ. **Không** mang:
  màu (Cài đặt → Màu mặc định giữ, dùng chung mọi loại), nền, góc xoay, bề rộng khung. Không phải bước hoàn tác (là tuỳ chọn,
  không sửa tài liệu). Nạp lúc load: chuỗi hỏng / sửa tay ⇒ kiểm lại từng trường hoặc bỏ qua; storage lỗi ⇒ không ném.
  Chỉ hộp **mới** đổi — không đụng hộp nào đã có ⇒ file cũ lưu lại vẫn y byte (BI-59).
- **Xoá định dạng**: chỉ bật khi đang chọn hộp chữ; đưa đúng các trường `TEXT_DEFAULT_KEYS` về kiểu **gốc của app**
  (`pickTextDefault({})`), **không** về kiểu mặc định đã lưu — đó là lối thoát nếu đã lỡ đặt một mặc định lạ (chọn hộp → Xoá
  định dạng → Đặt làm mặc định). Giữ màu, nền, góc xoay, bề rộng khung, chữ, vị trí; đo lại kích thước; một bước hoàn tác.
- ⚠️ Ba cách viết kiểu gốc phải khớp: literal `ed` trong editor.js, `#ed-fontsize` min/max/value trong index.html, và
  `pickTextDefault({})` (lưới D8/D8b). Font máy (`/fonts`) nạp trễ: trước đây `<select>` hiện trống nếu kiểu đang đặt là
  một font máy — giờ `loadSystemFonts` gán lại `#ed-font` (khi không có hộp chữ đang chọn).
- E2E (2026-10-12, app thật, chuột/phím thật, hai lần mở cùng hồ sơ): 17/17 — glyph 10 ký tự × 3 font; "S = 120 m" + ² + " ±5"
  ⇒ đúng chuỗi, ô vẫn focus; ← ×3 + ⌀ ⇒ chèn giữa đúng chỗ; Ctrl+Z trong ô gỡ ⌀; không có ô gõ ⇒ gợi ý, hộp không đổi; hộp
  24 pt + đậm + giữa ⇒ Đặt làm mặc định ⇒ lưu đúng 15 trường, không màu/xoay; hộp mới 24/đậm/giữa; Xoá định dạng ⇒ 16/thường/
  trái, giữ màu; Ctrl+Z ⇒ về 24/đậm/giữa; EN đúng; mở lại app ⇒ bảng bắt đầu ở 24/đậm/giữa, hộp mới đúng kiểu.
- **Vỡ khi:** bấm ký tự làm ô gõ đóng/chốt; ký tự vào cuối thay vì chỗ con trỏ; ô vuông thay ký tự trong file lưu; hộp
  mới không theo mặc định sau khi mở lại app; Đặt làm mặc định đổi màu/góc xoay của hộp mới; Xoá định dạng xoá màu/nền/
  xoay hoặc về kiểu đã lưu thay vì kiểu gốc; mở file cũ thấy hộp chữ đổi kiểu.

### BI-109 · Hộp chữ: Viền khung (vẽ trong raster) + Sao chép / Dán định dạng
- **Viền khung** — model: `borderColor` (#rrggbb; có ⇔ có viền), `borderWidth` (pt, 0,25…12, mặc định 1), `borderDash`
  ("dash"|"dot"; vắng = liền). Một người đọc duy nhất: `annot-text.js normTextBorder` (null = không viền). Vắng key = không
  viền ⇒ hộp cũ: payload /NabuData và raster **y byte** (BI-59). **Không** nằm trong `normTextStyle` (như fill): viền không
  bao giờ tới `layoutTextBox`, không dời glyph.
- Sáu chỗ chạm (khuôn "thêm trường"): `renderTextPng` (editor-bake.js: `strokeRect` **bên trong** hình chữ nhật của nền —
  lùi nửa nét — sau nền, trước glyph, trong khung đã xoay, `globalAlpha` = độ mờ chữ, nét đứt = `dashSpec`×RS; raster
  **không** lớn thêm), `renderAnnot` (editor.js: `<svg class="an-text-border">`), `serializeManaged` (managed-codec.js
  `_normTextBorder`, ghi chỉ khi có; dash chỉ khi không liền), `deserializeManaged` (editor-bake.js, cùng nhánh), bảng
  Format (`writeBorder`, `syncFmtPanel`), `writeFreeText` (`delete style.borderColor` — FreeText của đối tác giữ viền **của
  file nó**, vẽ bằng vector; điều khiển viền tắt cho `a._foreign`). Copy/paste vật thể, undo, clip liên tab: sao chép
  nguyên đối tượng ⇒ tự mang theo.
- ⚠️ **Hình chữ nhật**: raster vẽ trên `cw × chh` px (ceil ở 3×), KHÔNG phải `a.w × a.h` (ceil theo pt từ bố cục 1×) — lệch
  tới ~1 pt. Nền không lộ, viền thì lộ. Overlay hỏi đúng hình chữ nhật raster: `textRasterBoxPt` (bố cục ở 3×) +
  `textRasterGeom` (công thức pad/ceil mà `renderTextPng` cũng gọi — một công thức, hai người đọc). Hộp **có viền** đặt cả nền
  lẫn viền lên hình chữ nhật đó; hộp không viền giữ `a.w × a.h` như cũ.
- ⚠️ **Co giãn ngang** (`charScale`): phần tử mang `scaleX`; viền là `<svg>` viewBox theo pt, `preserveAspectRatio="none"`,
  rộng `w/charScale` px — phép co không đều của viewBox triệt tiêu đúng `scaleX` của cha ⇒ nét và nhịp đứt **đều** hai trục,
  như raster (vẽ viền trước khi co từng glyph). Đo: ma trận màn hình của rect `sx = sy` (0,99994 / 0,99980).
- **Sao chép / Dán định dạng** — `copyTextFormat`: 15 trường kiểu chữ (`TEXT_DEFAULT_KEYS`) + màu + nền + viền; **không** góc
  xoay, bề rộng khung, chữ, vị trí. `applyTextFormat`: key nguồn không có ⇒ **xoá** khỏi đích (nguồn không nền ⇒ đích hết nền;
  xoá chứ không gán "none" — BI-59); `noBorder` cho FreeText đối tác. Dán lên **mọi hộp chữ đang chọn** (Ctrl+click), vật thể
  khác trong nhóm bỏ qua, đo lại từng hộp, **một** bước hoàn tác. Clip ở cấp banner (`let fmtClip` khai **trước**
  `syncFmtPanel` — đọc nó; `let` khai sau = TDZ khi gọi sớm), sống qua Xong / đổi trang. Hai nút + phím của Word
  `Ctrl+Shift+C/V` (`e.code`, không khi đang gõ, chỉ `preventDefault` khi làm được việc); Ctrl+C vật thể vẫn đòi
  `!e.shiftKey` nên hai đường không cùng chạy. Không có "chế độ chổi" bấm-để-áp: không thêm trạng thái con trỏ cho `onDown`.
- E2E (2026-10-12, app thật, chuột/phím thật, đối chiếu **pixel đỏ của file đã lưu** render bằng pdf.js ở 2× — không đọc canvas
  viewer, BI-4): viền 2 pt — mép file vs màn hình lệch ≤ **0,27 pt**; nét đứt + co giãn ngang 60% ≤ **0,24 pt**; vào lại Chú
  thích ⇒ viền đọc lại từ file; Ctrl+Shift+C → chọn 2 hộp (Ctrl+click) → Ctrl+Shift+V ⇒ cả hai 22 pt/đậm/viền đỏ đứt, số vật thể
  không đổi (phím không dán vật thể); một Ctrl+Z gỡ cả hai; nút Dán định dạng cũng chạy; EN đúng. 15/15.
- ✅ (đã sửa ở BI-110) **Hộp đã xoay — lệch CÓ TỪ v0.2.63, viền chỉ làm lộ ra** (đo cùng probe): xoay 90° ⇒ khung trong file dịch (+0,4; −4,2) pt
  so với màn hình, cùng kích thước; 30° ⇒ 1,7 pt. Nguyên nhân: `renderAnnot` xoay phần tử quanh tâm **phần tử** (a.w/2, a.h/2),
  `renderTextPng` xoay quanh tâm **raster** = tâm phần tử − (pad, pad); hai tâm khác nhau ⇒ thêm tịnh tiến
  2·pad·√2·sin(θ/2) (90° ≈ 4,8 pt ở 16 pt, tỉ lệ cỡ chữ). Glyph lệch y như viền (cùng khung xoay). File là đúng, màn hình sai;
  comment "the raster turns about the same visual centre" trong renderAnnot là không đúng. Việc riêng (đổi hành vi xoay,
  không gộp vào đây). Ô gõ chưa xem trước viền lúc đang gõ.
- **Vỡ khi:** file lưu có viền lệch / dày / mảnh khác màn hình; hộp không viền đổi byte; co giãn ngang làm cạnh dọc mảnh đi trên
  màn hình; dán định dạng đổi góc xoay / bề rộng khung / chữ, hoặc dán vào hình vuông/mây; FreeText đối tác bị thêm viền Nabu;
  Ctrl+Shift+V dán cả vật thể.

### BI-110 · Hộp chữ XOAY: màn hình xoay quanh **tâm raster**, đúng điểm file đã lưu xoay
- `annot-text.js` `textRotationPivot` (+ `TEXT_PLACE_PAD_EM` = 0,15 — `padPt` của bake); `editor.js` `renderAnnot` (khối
  `if (st.rot)`) **và** `openTextEditor` (khối `if (existing && st.rot)`). Lưới: `test:text` nhóm X (hàm thuần + chốt hai chỗ gọi),
  `test:managed` "pivot rot …" (so với **chính số học** của `renderTextPng` + vị trí đặt của bake trên canvas giả), 7/7 đột biến đỏ.
- **Lỗi cũ (từ v0.2.63, lộ ra khi làm viền BI-109):** overlay xoay phần tử quanh tâm **phần tử** (a.w/2, a.h/2); raster xoay quanh
  tâm **canvas** và bake đặt canvas ở (a.x − pad, a.y − pad) ⇒ điểm file xoay = (rasterW/2 − pad, rasterH/2 − pad) tính từ góc hộp.
  Hai tâm cách nhau ≈ (pad, pad) (BI-71 đã đo: a.x + 46,50 vs a.x + 44,27 ở 16 pt). Xoay một hình quanh hai điểm khác nhau = thêm
  tịnh tiến 2·pad·√2·sin(θ/2). Comment cũ "the raster turns about the same visual centre, so the two agree" là **sai**.
- **Đo (app thật, chuột/phím thật, pixel đỏ của viền trong file đã lưu render bằng pdf.js 2× vs rect `<svg>` trên màn hình; viền
  dính cứng với glyph trong cùng khung xoay):**
  ```
                 16pt 30° / 90° / 180°        48pt 30° / 90° / 180°
  trước (HEAD)   1,67  / 4,89 / 5,39 pt       5,00 / 14,69 / 14,69 pt
  sau            0,34  / 0,22 / 0,42 pt       0,50 /  0,52 /  0,21 pt
  sau, co ngang 60%: 0,51 / 0,44 / 0,43        0,59 /  0,19 /  0,21 pt
  ```
  Phần dư ≤ 0,6 pt là hạt ceil 1/RS + chênh `pad` placement (0,15·size) với `pad` raster (ceil ở 3×) — cùng cỡ BI-71.
- ⚠️ **Tâm tính bằng px HIỂN THỊ, không chia `charScale`:** phép xoay áp SAU `scaleX`, nên toạ độ tâm là toạ độ người dùng thấy
  (đo: co ngang 60% vẫn ≤ 0,59 pt). Đừng "sửa" cho giống `el.style.width` (chia `charScale`) — lưới X3 đỏ.
- ⚠️ **Ô gõ của hộp xoay phải xoay quanh CÙNG điểm** (`textRotationPivot(existing.text, …)`), nếu không chữ nhảy khi mở/đóng ô
  gõ. Đo: điểm bất động của transform ô gõ trùng điểm của phần tử (lệch 0,000 pt, cả khi co ngang — phải tách `scaleX` khỏi ma
  trận phần tử trước khi giải, nếu không "điểm bất động" của rotate∘scale không phải tâm).
- Hộp **không xoay** không đổi gì (khối chỉ chạy khi `st.rot`); chọn / kéo vẫn nhờ DOM hit-test (BI-70). Tốn một
  `layoutTextBox` ở 3× mỗi lần vẽ, chỉ cho hộp đang xoay.
- **Vỡ khi:** hộp xoay trên màn hình và trong file đã lưu không trùng (rõ nhất ở 90°/180° chữ to); bấm đúp hộp xoay để sửa thì
  chữ nhảy chỗ; hộp xoay có co giãn ngang lệch ngang khi lưu.

### BI-111 · Ô gõ hộp chữ: chỉ cú kéo của NGƯỜI DÙNG mới biến hộp thường thành hộp cố định bề rộng
- `editor.js` `openTextEditor`: `ResizeObserver` + cờ `pressed` (pointerdown trên ô gõ → pointerup/pointercancel một-lần trên
  **document**) + `userResized()`. Lưới: `npm run test:taresize` (cắt khối khỏi editor.js, ResizeObserver / ô gõ / document giả;
  W1–W8), 8/8 đột biến đỏ.
- **Lỗi cũ (từ BI-104, v0.2.78):** ô gõ hộp thường rộng theo `cols` = 26 glyph trung bình của **font hiện tại**, nên mọi lần tô lại
  kiểu (bảng → `ed._taPreview` → `paint`) làm nó rộng/hẹp đi; observer coi **mọi** thay đổi bề rộng là "người dùng kéo góc ô gõ" ⇒
  `setBox` ⇒ hộp cố định ở bề rộng ô gõ. Đo app thật (Chú thích → T → bấm → gõ → …): bấm **Đậm** ⇒ hộp cố định **254 pt** cho nhãn
  44 pt; cỡ 24 ⇒ **310 pt**; đổi font serif ⇒ hộp cố định hẹp gói chữ. In nghiêng / căn lề / giãn ký tự không đổi bề rộng ô gõ nên
  không dính. (Từng thấy 1 lần không có thao tác bảng nào — cùng cơ chế nếu font tải trễ sau lần đo đầu; cổng mới phủ luôn.)
- **Luật:** đổi bề rộng chỉ là "kéo" khi `pressed` — góc resize là cách duy nhất người dùng đổi bề rộng phần tử này. Không nhấn ⇒ chỉ
  dời mốc `baseW` (app tô lại, font, zoom…). Nhả chuột kiểm lại một lần (khung cuối của cú kéo có thể chưa qua observer). Nhả ở
  **ngoài** ô gõ vẫn được (thu hẹp kéo con trỏ ra ngoài) — listener ở document, tự gỡ. `ownW` (bề rộng do chính mã ghi) vẫn không
  tính là kéo.
- E2E (2026-10-12, app thật, chuột/phím thật): 14/14 — 2 ca gõ thường, B, I, cỡ 24, serif, giãn ký tự 2, căn giữa, 4 lần lặp ⇒ đều
  **hộp thường** (B ⇒ 47 pt, cỡ 24 ⇒ 66 pt); **đối chứng**: kéo góc ô gõ −120 px ⇒ hộp cố định 91 pt, +60 px ⇒ 271 pt (tính năng
  BI-104 còn nguyên). Cùng probe trên HEAD cũ: B ⇒ 254 pt, cỡ 24 ⇒ 310 pt, serif ⇒ hộp gói chữ — đỏ 3 ca.
- **Vỡ khi:** đang gõ hộp mới mà bấm Đậm / đổi cỡ / đổi font thì hộp thành "Tự xuống dòng theo khung" rộng bất thường; hoặc ngược
  lại, kéo góc ô gõ **không** còn biến hộp thường thành hộp cố định.

### BI-112 · Cỡ nhãn mũi tên / đường đo: một phép kẹp, mặc định 14 ở MỌI chỗ đọc
- `annot-geom.js` `LABEL_SIZE_MIN/MAX/DEFAULT` (6 / 72 / 14) + `normLabelSize`; `editor.js` `LABEL_SIZE_KINDS` (arrow, dim — khai
  **trước** `ed`, syncControls đọc nó), `ed.labelSize` (theo phiên, như `dash` / `arrowLabelEnd`), ô `#ed-labelsize`
  (`data-ctl="labelsize"`: công cụ Mũi tên + Đo; mục đang chọn arrow + dim), `applyLabelSize`. Lưới: `npm run test:labelsize`
  (45 ý, 14/14 đột biến đỏ) + ghim bề mặt `test:annot-geom`.
- Trường `labelSize` có từ lâu, mọi chỗ đọc đều `a.labelSize || 14` (overlay ×2, `renderArrowPng`, `drawOneAnnot` ×2,
  `serializeManaged`), nhưng **không có điều khiển** nào ghi nó (đường đo còn ghi cứng `labelSize: 14` lúc tạo).
- **Luật:**
  - Mặc định = 14 ở **mọi** chỗ đọc và trong `LABEL_SIZE_DEFAULT` — đổi một chỗ thì nhãn chưa từng chỉnh đổi cỡ, và /NabuData của
    mũi tên đổi byte (BI-59). Mũi tên mới giờ **luôn** mang `labelSize`; codec vốn đã ghi `labelSize: a.labelSize || 14` nên mũi tên
    14 pt ra **byte y hệt** mũi tên vẽ trước P7 (test ghim).
  - Rác (NaN, "", chuỗi, 0, âm) ⇒ **14**, không phải sàn 6. `input` vẽ trực tiếp; `change` ghi lại giá trị đã kẹp vào ô.
  - Áp cho **cả vùng chọn** (chỉ arrow/dim), một bước hoàn tác mỗi đợt (`"labelsize:" + ed.sel`), không hoàn tác nếu không gì đổi
    (đặt 14 cho mũi tên không có khoá ⇒ không ghi khoá). Như Nét: mục còn đang chọn khi đổi công cụ vẫn nhận cỡ mới.
  - Đường đo **không** phải chú thích quản lý — cỡ chỉ sống tới khi bake (làm phẳng thành PNG đúng cỡ); mũi tên giữ cỡ qua lưu ↔ mở.
- E2E (2026-10-12, app thật, chuột/phím thật, gõ vào ô): 22/22 — ẩn ở công cụ Chữ, hiện ở Mũi tên/Đo với 14; mũi tên mặc định 14;
  không chọn gì thì đổi ô không đụng mũi tên cũ; mũi tên sau 28; đo hiện 28 → đặt 20 → số đo 20; chọn mũi tên 28 hiện 28, gõ 10 chỉ
  đổi mũi tên đó, Ctrl+Z một bước về 28; chọn mũi tên mặc định hiện 14, đường đo hiện 20; 500 ⇒ 72 (ô + hình), Ctrl+Z về 20.
  **File đã lưu:** mực nhãn 28 pt / 14 pt = **1,95**, số đo 20 / 14 = **1,45**, tâm mực mỗi nhãn nằm trong khung chữ trên màn hình;
  mở lại: mũi tên 28 vẫn 28 (overlay + ô), mũi tên mặc định vẫn 14.
- **Vỡ khi:** ô Cỡ nhãn không hiện ở Mũi tên/Đo, hoặc hiện ở loại khác; nhãn trên màn hình khác cỡ trong file đã lưu; mũi tên mở
  lại mất cỡ; mũi tên cũ đổi cỡ / /NabuData đổi byte dù không ai chỉnh.

### BI-113 · Ô Nét áp cho MỌI loại mà nó hiện ra — kể cả đường đo
- `editor.js` `PEN_WIDTH_KINDS` (khai trước `ed`) dùng chung cho handler `ed-penwidth` và `syncControls`. Lưới:
  `npm run test:penwidth` (13 ý; ghim tập này == các kind mà `KIND_CTLS` hiện "penwidth"; cắt handler chạy với vùng chọn giả),
  6/6 đột biến đỏ.
- **Lỗi cũ:** `KIND_CTLS.dim` hiện ô Nét cho đường đo đang chọn, nhưng hai danh sách chép tay phía sau (handler + syncControls) đều
  thiếu `"dim"`. Đo app thật: gõ Nét 6 ⇒ nét vẫn 1 pt trên màn hình **và** trong file đã lưu, còn ô vẫn hiện 6 như thể đã áp.
- **Luật:** thêm kind hiện ô Nét ⇒ thêm vào `PEN_WIDTH_KINDS` (test đỏ nếu lệch hai chiều). Không viết lại danh sách kind tại chỗ.
- E2E (2026-10-12): 6/6 — đường đo Nét 1 → chọn → gõ 6 ⇒ đường + 2 vạch 6 pt; Ctrl+Z một bước về 1; chọn lại hiện 6; Xong ⇒ file
  đã lưu dày **6 pt** (trước khi sửa: 1 pt, đỏ 3/6).
- **Vỡ khi:** chọn một hình có ô Nét, đổi số mà nét không đổi (hoặc đổi trên màn hình mà file vẫn nét cũ).

### BI-114 · Sửa nội dung: Căn lề + Gạch ngang — căn trong khoảng của đoạn GỐC, không gửi gì = byte cũ
- Sidecar `api.py` `TextEdit.align` / `TextEdit.strike`, `_norm_align`, `_pitch_from_metrics`, `_insert_line_pitch`,
  `_STRIKE_RISE_EM`; trong `edit_text`: `draw_run` (insert_text + lần thử lại cũ), `lines_at`. Renderer `text-edit.js`: nút
  `#te-strike`, nhóm `#te-align`, `normAlign` / `setAlignBtns` / `readAlign`. Lưới: `test_edit_text_align.py` (48 ý, 10/10 đột
  biến đỏ) + `npm run test:teformat` (28 ý, 14/14 đột biến đỏ). **Sửa `*.py` ⇒ build lại sidecar trước khi đóng gói.**
- **Luật:**
  - Căn lề đặt **mỗi dòng** trong khoảng mà run GỐC chiếm **dọc theo chữ** (`adv`, cùng khung `u_dir`/`n_dir` của BI-66):
    phải ⇒ mép cuối = mép cuối cũ; giữa ⇒ giữ tâm. Chữ dài hơn thì tràn ra phía bên kia — đúng nghĩa căn lề.
  - `align` vắng / "left" / rác ⇒ **đúng một lời gọi `insert_text` như trước** (pixel y hệt — test D1); `/text-find` và renderer
    cũ không gửi trường nào. Không đo được (run xiên, không có font object) ⇒ căn trái.
  - Căn ⇒ vẽ **từng dòng**; khoảng dòng phải lấy từ **`CheckFontInfo` của tài liệu** (đúng chỗ insert_text đọc), **không** từ
    `fitz.Font`: đo được Base-14 "helv" có sẵn trong file báo hộp dòng ≤ 1 em ⇒ 1,2, còn `fitz.Font("helv")` nói 1,374 ⇒ dòng 2
    lệch 1,9 pt (test M1 helv). Cắt dòng bằng `splitlines()` như insert_text.
  - Gạch ngang: mỗi dòng một nét, cao `0,28 em` trên đường chân chữ theo `−n_dir` (xoay cùng nhãn dọc), dày như gạch chân. Gạch
    chân của bản **căn trái** giữ nguyên một nét cũ (U2); bản căn phải/giữa thì gạch chân từng dòng tại chỗ đã dời.
  - Năm chỗ của một trường kiểu chữ trong `text-edit.js` (readControls, onControlChange, stage, seedEdit, isPristine) + `styleChanged`
    phải đủ — thiếu một chỗ là nút sáng mà Áp dụng ghi kiểu cũ. `test:teformat` ghim cả năm vào cùng một tập khoá.
- E2E (2026-10-12, app thật + sidecar dev = mã mới, chuột/phím thật): 15/15 — số tiền "1.000.000" căn phải gõ thành "12.500.000" ⇒
  mép phải **499,92** (cũ 500,00; bắt đầu lệch sang trái, không ở 438,9); tiêu đề căn giữa dài ra ⇒ tâm **299,87** (cũ 300); đường
  chân chữ giữ nguyên; chữ bên cạnh không xê dịch; bấm S không gõ lại ⇒ vẫn được ghi (3 đoạn); mở lại đoạn đã sửa ⇒ thanh hiện đúng
  Căn phải / S; file đã lưu có nét gạch **liền 100 %** bề rộng chữ, cao 3,75 pt trên đường chân chữ (cỡ 12).
- *(Ghi chú cũ "nút định dạng đóng ô gõ" — đã sửa ở BI-115.)* Đã biết, **không** do P8: bấm bất kỳ nút định dạng nào (cả B/I/U có sẵn) khi ô gõ đang mở ⇒ `renderBoxes()` dựng lại lớp và ô gõ
  đóng lại; chữ đang gõ **không** mất (`onControlChange` chép `open.value` trước). Probe đối chứng bằng nút B: y hệt.
- **Vỡ khi:** sửa số trong cột căn phải mà số lệch cột; dòng 2 của chữ căn giữa lệch dòng so với căn trái; gạch ngang nằm dưới chân
  chữ hoặc không xoay theo nhãn dọc; sửa một đoạn KHÔNG chọn căn lề mà kết quả khác trước P8.

### BI-115 · Sửa nội dung: bấm nút định dạng KHÔNG đóng ô gõ đang mở; Esc bỏ cả định dạng vừa bấm
- `text-edit.js` `onControlChange`: ô gõ đang mở ⇒ chỉ ghi kiểu vào bản sửa + `updateHint()`, **không** `renderBoxes()` (nó dựng lại
  cả lớp, và `<textarea>` nằm trong lớp). `beginEdit`: `before` = bản sửa lúc mở ô; `cancel` (Esc) trả về `before` (hoặc xoá bản
  sửa mới) + `syncControls(sp)`. Lưới: `npm run test:teformat` K1–K4 (cắt `onControlChange` chạy với ô gõ giả), 5/5 đột biến đỏ.
- **Lỗi cũ (có từ khi có B/I/U):** bấm B / I / U (và S / Căn lề của BI-114) lúc đang gõ ⇒ ô gõ biến mất; phím gõ tiếp **không vào đâu**.
  Đo app thật: gõ "12" → B → gõ ".345" → Enter → Áp dụng ⇒ file ghi **"12"** (mất ".345").
- **Luật:** đổi kiểu khi ô gõ đang mở không được làm mất ô gõ; ô được vẽ lại khi commit (Enter / blur), lúc đó `stage()` ghi lại từ thanh.
  Vì nút định dạng giờ ghi tạm bản sửa trong lúc ô còn mở, **Esc** phải trả bản sửa về đúng lúc mở ô (đoạn chưa sửa ⇒ không còn bản sửa).
  Ô chọn font / cỡ / màu vẫn lấy focus như cũ (ô gõ commit trước, rồi `change` ⇒ `renderBoxes()`).
- E2E (2026-10-12, app thật): 15/15 — sau B / S / Căn phải ô gõ vẫn mở + focus, gõ tiếp nối được ("12.345"); Enter ghi tạm; mở lại thấy
  đúng chữ + kiểu; Esc sau khi bấm I chỉ bỏ I (B / S / Căn phải từ trước còn); đoạn mới bấm B rồi Esc ⇒ bộ đếm về như cũ, thanh tắt B;
  Áp dụng ⇒ file có **"12.345"** căn phải mép 499,90. Cùng probe trên HEAD cũ: đỏ 9/15. Probe P8 15/15 chạy lại (đối chứng B nay giữ focus).
- **Vỡ khi:** bấm B/I/U/S/căn lề lúc đang gõ mà ô gõ đóng hoặc chữ gõ tiếp bị mất; Esc mà định dạng vừa bấm vẫn được ghi.

### BI-116 · Xoay / lật ẢNH chèn: một mô hình `rot`/`flipH`/`flipV`, một ma trận cho overlay, `/AP` và đường phẳng — mặc định = **vắng mặt**
- Kế hoạch & các lựa chọn đã chốt: `docs/PLAN-2026-10-23-image-rotate-flip.md`. **Chỉ renderer, không đổi `*.py`** (sidecar không build lại).
  - `annot-geom.js` (thuần): `normImgRot` `cosSinDeg` `imageXformed` `imageCorners` `imageCm` `imageBounds` `imageOp` `resizeRotated`
    `rotateDragAngle`; `annotBounds` của ảnh trả **hộp bao đã xoay**.
  - `managed-codec.js` `serializeManaged` (ghi `rot` / `flipH` / `flipV` **chỉ khi có**) · `editor-bake.js` `deserializeManaged` (đọc lại,
    bỏ giá trị rác) · `addManagedAnnot` nhánh image (form `BBox` = hộp bao đã xoay + `cm` dựng từ `imageCm`) · `drawOneAnnot` nhánh image
    (đường phẳng: `pushOperators` q/cm/Do/Q, vì `drawImage` của pdf-lib không lật được).
  - `editor.js`: `renderAnnot` (ảnh), núm xoay `.handle.h-rot` (`data-rot`) + `onDown`/`onMove`/`cancelDrag` nhánh `rotate`,
    `layerPointRaw`, resize ảnh đang xoay, `applyImageOp`/`imageOpPlan`/`imageTargets` + nhóm mục trong menu chuột phải, `applyImgPages`;
    `app.css` `.h-rot` + `.annot-layer:has(.handle.h-rot)`. `help.js` (VI+EN), `i18n.js` ("Lật ngang", "Lật dọc", "Đặt lại xoay / lật").
  - Lưới: `npm run test:imgxf` (347 ý: hình học thuần, `imageCm`, ghim cấu trúc DOM, lệnh menu) · `test:rotate` mục **5b** (9 tư thế ×
    4 góc `/Rotate` × 2 writer + chế độ che) · `test:managed` mục **8b** (khoá mặc định, round-trip file PDF thật, snapshot undo,
    `applyImgPages` cắt từ mã ship) · `annot-geom.test.js` ghim bề mặt export.
- **Luật:**
  - **Mô hình:** `rot` độ **ngược chiều kim đồng hồ** (cùng dấu hộp chữ / watermark, `normRot` ở `annot-text.js`; `normImgRot` là bản
    sao có test ghim bằng nhau), tâm xoay = **tâm hộp**, thứ tự **lật trong khung ảnh rồi xoay**. `x/y/w/h` **luôn là hộp chưa xoay**
    (như hộp chữ — xoay không đo lại hộp nên không phình mỗi lần xoay).
  - **Mặc định là VẮNG MẶT, không bao giờ `rot: 0` / `flipH: false`** — ở `serializeManaged`, `deserializeManaged`, `applyImgPages`,
    `applyImageOp`, kéo núm về 0°, Esc. Ảnh chưa chạm / đã đưa về tư thế gốc phải ra **JSON và byte y hệt** (BI-59). Cổng của mọi
    writer là `imageXformed`; ảnh chưa chạm đi **nhánh cũ nguyên văn**.
  - **Một định nghĩa "ảnh nằm ở đâu" cho ba nơi (BI-40):** overlay = `rotate(-rot)` lên phần tử + `scale(±1,±1)` lên `<img>`
    (lật **chỉ** lên `<img>`: lật cả phần tử thì 4 tay nắm đổi chỗ dưới con trỏ), bake = `imageCm` (ba góc của `imageCorners`, mỗi góc
    được `map` **riêng** ⇒ trang `/Rotate` đúng miễn phí, BI-45 loại 1 — **không** thêm `rotate: pageRotate`). Sửa một nơi mà không sửa nơi
    kia = đúng trên màn hình, sai trong file.
  - **Lật theo MÀN HÌNH:** lật một ảnh đã xoay phải **đổi dấu góc** (`F·R(θ) = R(−θ)·F`), không chỉ bật cờ — không thì ảnh 30° lật quanh
    trục riêng và quay sai hướng. `imageOp` giữ luật này; ba ca probe dùng oracle độc lập (đối xứng qua tâm) để dự đoán không tự khớp với mã.
  - **Ở `test:rotate`, ảnh KHÔNG vào `KINDS`:** `KINDS` đọc toán tử path còn ảnh chỉ phát `Do`. Mục 5b so **thứ tự** BL,BR,TR,TL của
    hình vuông đơn vị với `imageCorners` — thứ tự là điểm mấu chốt vì lật giữ nguyên **tập** 4 góc, so tập đã sắp xếp mù với lật
    (có ca bảo vệ ghim điều đó).
  - **Núm xoay:** chỉ cho **một** ảnh đang chọn (`gripsFor`) và **không** cho stamp ngoài (`_foreign`, BI-100). Dùng con trỏ **không kẹp**
    (`layerPointRaw`) vì núm nằm trên mép trang; kẹp ⇒ góc kéo bị lệch khi con trỏ ở ngoài tờ (đột biến "con trỏ bị kẹp" đỏ ở T8b của probe bước 4). Kéo **tương đối** so với điểm
    bấm; Shift (đọc trực tiếp từ sự kiện) = bước 15°, áp lên **kết quả**; undo đẩy **lười** ở lần di chuyển thật đầu tiên; Esc trả góc cũ và
    chỉ bỏ snapshot nếu cú kéo đã đẩy (nếu bỏ khi chưa đẩy: ăn mất bước undo trước — T4b). `onDown` xét `data-rot` **trước** nhánh góc.
  - **Resize khi xoay:** `resizeRotated` (kéo đưa về khung của hộp, góc đối diện đứng yên **trong không gian trang**); bằng `resizeRect` ở 0°.
    Hộp chữ xoay thì **mất** tay nắm (`isFixedTextBox`) — ảnh thì được giữ nhờ hàm này.
  - **Menu (BI-41: không thêm hàng vào thanh sửa):** mỗi ảnh Nabu đang chọn tự xử lý quanh **tâm riêng**; **một** bước undo cho cả nhóm, đẩy
    **trước** khi sửa, chỉ khi có gì đổi (Đặt lại trên ảnh chưa chạm bị xám); không chạy giữa cú kéo; mục có hậu tố "(N ảnh)".
    Không thêm cửa mới qua cổng bản quyền: chỉ chạy khi `ed.active` (vào qua `btn-edit` ∈ `GATED_BTNS`).
  - `.annot-layer { overflow: hidden }` vẫn cắt theo tờ; chỉ khi có núm mới `overflow: visible` (`:has`), để núm của ảnh sát mép trên bấm được.
- **Đo (app thật, chuột / phím / chuột phải thật qua CDP):**
  - Bước 4 — 32/32: kéo núm sang trái = +90°, tâm không dời; Shift 118° → 120°; Esc giữa chừng trả góc và undo kế tiếp lùi đúng **một**
    bước; resize ảnh xoay 30°: góc nw đứng yên < 1 px, rộng +40 px dọc trục riêng; núm của ảnh sát mép trên bấm được, kéo ra 20° dù con trỏ
    ở ngoài tờ. Bước 5 — 40/40 **bằng pixel thật** (chụp màn hình, đọc màu tại tâm dự đoán của 4 phần tư ảnh): xoay trái → lật ngang →
    lật dọc → xoay phải đúng màu đúng chỗ ở mỗi bước; 4 undo / 4 redo; nhóm 2 ảnh quanh tâm riêng (tâm dời < 0,6 px), một undo hoàn lại cả hai.
  - **Bước 6 — end-to-end 55/55** (hai lần mở app thật, 4 trang, trang 1 `/Rotate 90`): Áp dụng rồi **render lại `state.bytes` bằng pdf.js** — 6
    ảnh (PNG ×5 gồm trang `/Rotate 90`, JPEG, bản Áp nhiều trang, bản Sao chép → Dán) cho **cùng màu ở cùng chỗ** với overlay; `/NabuData`
    đúng `rot`/`flipH`/`flipV`/`fmt jpg`; chỉ trang xoay có `/Matrix`; **mở lại file** ⇒ cả 6 về đúng hộp và tư thế (< 0,02), sửa tiếp
    (Xoay phải 90° trên trang `/Rotate 90`, Lật dọc) rồi Áp dụng lại ⇒ vẫn 6 ảnh, ảnh không sửa giữ nguyên tư thế, pixel đúng.
  - **Byte y hệt BI-59:** harness bake ảnh **chưa chạm** qua chính `addManagedAnnot`/`drawOneAnnot` đang ship, sha256 của 16 tài liệu (AP trang
    0/90/180/270, phẳng, chế độ che, `/Rotate 45`, 3 trang dùng chung ảnh, landscape `/Rotate 90` số lẻ, cờ tắt rõ ràng) — **trước (08db635)
    và sau khớp từng dòng**; harness tất định (chạy hai lần ra cùng hash).
  - Đột biến: `test:imgxf` ba nhóm (15 + 14 + 15 ca), `test:rotate`/bake 13/13, mức probe bước 4 5/5 · bước 5 7/7 · bước 6 5/5 (bake vẽ
    như ảnh thẳng, `imageCm` nhầm góc, `/AP` không lật trục y, mở lại không đọc `rot`, Áp nhiều trang rơi cờ lật). Đối chứng mã cũ: đỏ đúng chỗ.
- **Đã biết / chưa làm (cố ý):**
  - Mở file có ảnh đã xoay bằng bản Nabu **cũ**: `/AP` vẫn vẽ đúng, nhưng sửa lại + Áp dụng sẽ **mất xoay** (bản cũ đọc `x/y/w/h` là hộp chưa xoay).
  - Ảnh nằm sẵn trong **nội dung trang** PDF gốc, và stamp của phần mềm khác (`_foreign`), **không** xoay được.
  - Chưa có: ô nhập góc (chủ dự án chọn không thêm), phím tắt, hít về 0° khi không giữ Shift, `cursor` của 4 tay nắm góc vẫn theo trục màn hình khi
    ảnh xoay. Ảnh xoay có thể thò ra ngoài tờ (bị cắt theo tờ như mọi vật thể; `annotBounds` chỉ dùng để kẹp khi dán / đặt chữ ký).
  - **Chưa kiểm:** Acrobat / Foxit (mới đo bằng pdf.js), `/Rotate` 180 / 270 ở mức e2e (đã có lưới đơn vị 4 góc), đường **bake che** (phẳng) ở mức
    e2e, stamp ngoài với file mẫu thật.
- **Cách kiểm cho lần sau (script nằm ngoài repo, cần gói `ws`):** probe CDP trên app thật, **pixel thật** bằng `Page.captureScreenshot`
  (cửa sổ hiện, đọc lại ảnh chụp trong renderer bằng canvas) và render file đã lưu bằng `pdfjsLib` trong renderer; dự đoán lấy từ
  `imageCorners`/`imageOp` thuần, **không** lấy từ DOM. Bẫy đã gặp: con trỏ CDP làm tròn **pixel nguyên** ⇒ ca "snap 113° → 120°" nằm sát
  biên 112,5° và ra 105° (chọn 118°); `undo`/`redo` dựng lại lớp và **bỏ chọn** (phải bấm lại ảnh trước khi kéo núm); `placeSignature` luôn ghi
  `fmt: "png"` — muốn ảnh **JPEG** phải đi cửa `beginImagePaste` rồi bấm lên trang.
- **Vỡ khi:** ảnh xoay/lật trên màn hình và trong file đã lưu **không trùng** (rõ nhất ở trang `/Rotate`, ảnh lật, ảnh JPEG); ảnh chưa chạm ra byte
  khác bản trước; lật ảnh đang xoay mà nó quay sai hướng; đưa ảnh về tư thế gốc rồi file vẫn có `rot`/`flip`; Esc khi kéo núm ăn mất bước undo
  trước; núm không bấm được ở ảnh sát mép trên; mở lại file xoay mất `rot`/`flip`; Áp nhiều trang hoặc Dán làm rơi góc xoay / lật; một lệnh menu
  tạo nhiều bước undo cho một nhóm.

### BI-117 · Núm xoay chuột cho HỘP CHỮ: xoay quanh **tâm raster** (không phải tâm hộp), dùng lại mô hình `rot` có từ v0.2.63
- Kế hoạch: `docs/PLAN-2026-10-30-text-rotate-multiedit.md` (Đợt A). **Chỉ renderer, không đổi `*.py`.** Không đổi mô hình lưu, bake, codec.
  - `annot-text.js` `textRotateCenter(a)` = `(a.x, a.y) + textRotationPivot(...)` (điểm BI-110, tính ở không gian TRANG) · `editor.js`: khối knob
    `text` ở cuối `renderAnnot` (khối của ảnh để **nguyên** — `test:imgxf` ghim nó), `onDown` nhánh `data-rot` nhận `text` và lấy `center` theo loại,
    `onMove` làm tròn 0,1° **chỉ cho chữ** + đẩy giá trị vào `#ed-textrot`, `cancelDrag` trả ô Xoay về góc cũ · `help.js` (VI+EN).
- **Luật:**
  - **Tâm kéo = `textRotateCenter`, KHÔNG phải tâm hộp.** Dùng tâm hộp ⇒ góc kéo lệch 3–6° ở mọi cú kéo (đo, đột biến M1 của probe: 90°→84,4°;
    33°→28,1°; 60°→54,8°; Shift 120°→105°). Pivot **không phụ thuộc `rot`** (layout là của hộp thẳng) nên đọc một lần ở `onDown` là đủ.
  - **Chữ không theo luật "vắng mặt = mặc định" của ảnh (BI-116):** `serializeManaged` luôn ghi `rot: s.rot` cho chữ (đã từ trước). Vẫn `delete a.rot` khi 0° cho gọn.
  - Núm chỉ cho **một** hộp đang chọn (`gripsFor`) và **không** cho `_foreign` (FreeText của phần mềm khác: `writeFreeText` không ghi `rot` về dict
    ⇒ mở lại sẽ mất xoay — BI-100). Hộp co ngang (`charScale ≠ 1`) bị `scaleX` kéo méo cả núm ⇒ núm tự `scaleX(1/charScale)`.
  - Kéo núm **không** đổi mặc định `ed.textRot` của hộp mới ("hộp này", khác ô Xoay vốn đặt cả mặc định) — quyết định của người làm, chưa hỏi chủ dự án.
- **Đo (app thật, chuột / phím thật qua CDP, pixel thật; PDF 2 trang, trang 2 `/Rotate 90`) — 49/49:**
  - Kéo 90° → 89,9°; 33° → 32,1°; 60° (trang `/Rotate 90`) → 60,1° (sai số = chuột CDP làm tròn pixel nguyên, R = 150 px). Shift 118° → 120° và ô Xoay
    = `120`; Esc giữa chừng trả **cả** góc và ô Xoay; một Ctrl+Z sau Esc hoàn lại đúng cú kéo trước (Esc không ăn bước undo).
  - **File đã lưu = overlay quanh cùng một điểm:** hộp 0° có độ lệch hằng giữa chữ DOM và chữ raster (≈ −3,5 pt dọc — có sẵn, không do núm); ba
    hộp xoay (90° · 32,1° co ngang 60% · 60,1° trang `/Rotate 90`) cho tâm vùng mực **lệch R(θ)·(độ lệch hằng) không quá 1,0 pt** (sai số còn lại = 1 px).
    Pivot sai sẽ cộng thêm 2·pad·√2·sin(θ/2) ≈ 4,8 pt ở 90° ⇒ probe bắt được.
  - Áp dụng → mở lại phiên sửa: cả 5 hộp (kể cả 0°) về đúng góc đã kéo.
- **Lưới:** `test:text` nhóm **Y** (Y1 `textRotateCenter` ba ý × 4 cỡ/co ngang — gồm "không đổi theo `rot`" và "không phải tâm hộp"; Y2–Y4b ghim bề mặt
  `editor.js`) · `test:imgxf` hai ghim `onDown` / `onMove` được **sửa có chủ đích** (thêm nhánh text), khối knob ảnh nguyên văn. Đột biến: 8/8 đỏ (tâm hộp,
  knob cho `_foreign`, bỏ làm tròn, `onDown` không nhận text, Esc không trả ô Xoay, bỏ đối trọng `charScale`, pivot lệch 2 pt, ô Xoay không theo núm) +
  probe app thật 5 ca đỏ với M1.
- **Đã biết / chưa làm:** ô **Xoay** (`setTextRot`) **không chặn `_foreign`** (có từ trước; xoay một FreeText của phần mềm khác rồi lưu — chưa tái hiện, nghi mất
  góc khi mở lại); hộp có `opacity` < 1 thì núm cũng mờ; chưa kiểm Acrobat / Foxit; `/Rotate` 180 / 270 chưa e2e; chưa có núm cho nhiều hộp (xoay nhóm bằng ô Xoay / +90°).
- **Cách kiểm cho lần sau:** probe CDP viết ngoài repo (cần gói `ws`, cổng 9335). **Bẫy đã gặp:** (1) bấm `btn-edit` ngay sau lần vẽ trang đầu tiên **bị nuốt**
  (đợi ~3 s sau khi nạp); (2) `applyTextFmt` ghi cả **mặc định palette** ⇒ ô `fmt-scale` đặt cho hộp trước **rò** sang hộp tạo sau (đã làm hỏng dự đoán tâm của ca
  trang 2 lúc đầu — lỗi probe, không phải lỗi sản phẩm) ⇒ luôn đặt lại `fmt-scale` cho mỗi hộp; (3) so mực overlay-vs-file phải có **ca đối chứng 0°** cùng trang,
  vì DOM và raster đặt chữ lệch nhau một vector hằng.
- **Vỡ khi:** bấm vào núm làm hộp nhảy hoặc góc kéo lệch vài độ (tâm sai); ô Xoay không theo núm; Esc ăn mất bước undo; hộp co ngang có núm méo / lệch;
  FreeText của phần mềm khác có núm; hộp 0° ra `/NabuData` khác bản trước; ảnh mất núm hoặc đổi cách xoay.

### BI-118 · Sửa style NHIỀU hộp chữ: mọi điều khiển chữ đi qua `textTargets` / `forTextTargets` — một nhóm ghi cùng lúc, MỘT bước undo
- Kế hoạch: `docs/PLAN-2026-10-30-text-rotate-multiedit.md` (Đợt B + C làm liền một lượt, không tách commit refactor — xem dưới). **Chỉ renderer.**
  Ctrl/Cmd+click chọn nhiều đã có từ trước (cùng trang); màu / nét / kiểu nét / cỡ nhãn đã áp cả nhóm. Phần còn lại ~20 handler **chỉ đọc hộp chính** (`ed.sel`).
  - `editor.js` (khối ngay sau `selAnnots`): `textTargets()` = hộp chữ trong vùng chọn (đúng thứ tự trang); `selSig()` = id đã sắp xếp nối lại, làm khoá gộp undo
    (1 hộp ⇒ đúng `<khoá>:<id>` như cũ); `forTextTargets(key, fn, remeasure)` = **một** đường ghi: đẩy undo **trước**, `fn` từng hộp, đo lại (`a.w/a.h`)
    nếu cần, vẽ lại một lần, `false` khi không có hộp chữ ⇒ không ghi sổ gì; `textRef()` = hộp bảng đang HIỂN THỊ (hộp chính nếu là chữ, không thì hộp chữ đầu).
  - Đã chuyển: cỡ chữ, font, B/I/U, `Xoay` / `+90°`, `applyTextFmt` (căn lề, thụt lề, danh sách, gạch ngang, giãn dòng/đoạn/chữ/từ, co ngang, độ mờ),
    Tự xuống dòng, Bề rộng khung, Viền, Xoá định dạng, Nền (`fillTargets`). `syncControls` / `syncFmtPanel` / `updateFmtPanel` / `syncCtlVisibility` hiển thị theo nhóm.
- **Luật:**
  - **Hộp chữ trong vùng chọn nhận điều khiển chữ; thứ khác không.** Hình chữ nhật / ảnh / mũi tên trong nhóm không bị ghi (đo: size 24 lên 3 hộp + 1 chữ nhật ⇒ chữ nhật nguyên).
    Một vùng chọn **không** có hộp chữ: chỉ đổi mặc định palette, **không** đẩy undo, không vẽ lại.
  - **Một thao tác = một bước undo cho cả nhóm**, đẩy trước khi sửa (`forTextTargets`); `selSig` khác nhau giữa các nhóm nên một đợt gõ ở nhóm A không gộp vào nhóm B trong 800 ms.
    B/I/U và font **không** gộp (như cũ: `key = null`).
  - **B/I/U kiểu Word:** nút bật/tắt theo trạng thái của hộp chính, rồi **ghi giá trị đó cho mọi hộp** — nhóm không bao giờ nửa đậm nửa thường.
  - **`Xoay` gõ số = tuyệt đối cho cả nhóm; `+90°` = tương đối, mỗi hộp từ góc riêng** (một hàng nhãn lệch góc vẫn giữ độ lệch). Mặc định palette `ed.textRot` theo hộp chính.
  - **Bề rộng khung** chỉ ghi hộp **đang cố định** (`boxW > 0`) — hộp điểm không bị biến thành hộp cố định bằng ô này (BI-104); **Tự xuống dòng** bật: mỗi hộp bắt đầu ở bề rộng tự nhiên **riêng** của nó (không hộp nào dịch chỗ).
  - **Viền:** bỏ `_foreign` (FreeText của phần mềm khác giữ viền của file — BI-100); chỉ ghi lại hộp **khác** viền muốn (hộp đã đúng giữ nguyên byte); tắt ⇒ xoá cả ba khoá (BI-59).
  - **Nền (BI-75/76 giữ nguyên):** ô gõ đang mở ⇒ đúng MỘT hộp (`ed._taAnnot`), không bao giờ cả nhóm. Không thì: mọi vật thể được chọn **cùng kind với kind đang hiển thị** (`fillCtlKind` — kind của hộp chính dưới Select); hộp chính là hình chữ nhật ⇒ chỉ chữ nhật đổi, hộp chữ trong nhóm không (slot nền riêng theo kind). Giá trị luôn đọc từ **điều khiển**, không từ `ed[slot]`.
  - **Hiện/ẩn điều khiển:** nhóm hiện điều khiển của hộp chính **cộng** điều khiển của các thành viên khác **nếu** nằm trong `GROUP_CTLS` (color · font · fontsize · biu · textrot · fill · penwidth · dash · labelsize) — chỉ những cái handler thật sự áp cả nhóm. `arrowrev`, `arrowlabel`, `imgpages`, `cloudsize`, `redact`, `measure` **không** vào (handler chỉ đọc hộp chính — hiện ra là nói dối). Bảng Định dạng mở khi có **ít nhất một** hộp chữ trong nhóm (trước: chỉ khi hộp chính là chữ).
  - **Sắp xếp theo trang (căn giữa/cạnh):** một hộp thôi — 2+ hộp thì 7 nút xám `disabled` và `arrangeSelected` từ chối (căn giữa cả nhóm = chồng lên nhau).
  - Không đổi: nội dung chữ, vị trí `x/y`, "Đặt làm mặc định" / "Sao chép định dạng" (theo hộp chính), mô hình lưu, bake, codec, sidecar.
- **Lưới:** `npm run test:multiedit` — 76 ý, **cắt từ mã ship** (`HELP_SRC` = chính các hàm helper, không dùng đồ giả): helper (H), thanh font (F), B/I/U (U), bảng (P: lề / giãn / wrap / bề rộng / xoá), viền (B), Arrange + hiện/ẩn điều khiển + panel (A/V),
  ghim cấu trúc "không còn `pushEdUndo(... + ed.sel)` ở chín handler" (S). `test:defaults` thêm G1–G6 (Nền nhóm, ô gõ, hộp chính là chữ nhật). `test:fmtpanel` / `test:defaults` **sửa rig có chủ đích** để chạy helper thật (ghim cũ giữ ý nghĩa: hộp đơn y hệt).
  Đột biến: 16 cái, **15 bị bắt** — M8 (`fillTargets` bỏ lọc kind) lọt vì `applyFillToSel` lọc lần hai (hai tầng, **tương đương hành vi**); 15/16 gồm cả M14 sau khi siết ca "bề rộng riêng" (P5 so từng số).
- **Đo (app thật, chuột / phím thật qua CDP, PDF 2 trang; 3 nhãn + 1 chữ nhật; Ctrl+click = `modifiers:2`) — 23/23:**
  - **Chọn MỘT hộp** → **B** chỉ đậm hộp đó, Ctrl+Z un-bold (hồi quy). **Ctrl+click 3 hộp**: viền chọn trên cả 3; thanh font + bảng hiện; **B** ⇒ [700,700,700]; cỡ 24 ⇒ [24,24,24]; **I**; **Nền**; **Viền** (tick thật trong bảng); **căn phải**;
    **+90°** ⇒ [90,90,90]; hai Ctrl+Z gỡ +90° và căn phải **cùng lúc cho cả 3** mà nền + viền còn.
  - Chữ nhật là hộp chính + Ctrl+click một nhãn ⇒ thanh font **và** bảng vẫn hiện; gõ cỡ 30 ⇒ chỉ nhãn đổi.
  - **Áp dụng → render file đã lưu**: mép vùng nền + viền của cả 3 hộp **trùng màn hình 0,00 pt ở cả 4 cạnh** (cùng số điểm ảnh mực: 4719 / 4719). **Mở lại**: cả 3 còn đậm + nghiêng + 24 + nền + viền.
  - Đối chứng: probe với đột biến "chỉ hộp đầu" ⇒ **7 ý đỏ** (B [700,400,400], cỡ [24,16,16], I, căn lề, +90° [90,0,0], cỡ ở nhóm lẫn loại, mở lại).
- **Đã biết / chưa làm (cố ý):** không có kéo khung chọn / Ctrl+A (chuột trống vẫn là "bỏ chọn"); chọn nhiều chỉ trong **một trang**; bảng hiển thị giá trị của hộp chính / hộp chữ đầu, **không** có trạng thái "hỗn hợp";
  Đợt B và C làm **một lượt** nên không có commit refactor tách riêng như kế hoạch — bù lại, mọi ghim hành vi hộp đơn cũ (`test:fmtpanel`, `test:defaults`) chạy trên helper thật và xanh; `remeasure` N hộp = N lần `layoutTextBox` ở 3× mỗi lần kéo thanh trượt (chưa đo với nhóm vài chục hộp);
  ô **Xoay** vẫn không chặn `_foreign` (BI-117); chưa kiểm Acrobat / Foxit (chỉ pdf.js).
- **Cách kiểm cho lần sau:** probe CDP ngoài repo (gói `ws`). **Bẫy đã gặp:** bảng Định dạng **cuộn** — nút nằm ngoài khung nhìn thì click CDP trượt (dùng `scrollIntoView` rồi đo lại rect trước khi bấm; một lần tưởng "Viền không ghi" thật ra là click ra ngoài); `Editor.undo()` bỏ chọn; bấm `btn-edit` ngay sau lần vẽ đầu bị nuốt.
- **Vỡ khi:** nhấn B / đổi cỡ / Nền / Viền mà chỉ một hộp trong nhóm đổi; một thao tác nhóm cần N lần Ctrl+Z; hình chữ nhật hoặc ảnh trong nhóm bị ghi kiểu chữ; chọn hình chữ nhật trước rồi Ctrl+click chữ mà thanh font / bảng biến mất; nút
  hoàn tác nhóm đẩy nhiều bước; viền ghi vào FreeText của phần mềm khác; ô Bề rộng biến hộp điểm thành hộp cố định; **một hộp đơn** đổi cách ghi / khoá undo so với trước.

### BI-119 · `/edit-text` trên chữ OUTLINE + lớp chữ VÔ HÌNH: phải xoá **nét vector của đúng span đó**, không tô nền, không đụng gì khác
- **Căn cứ (đo 2026-11-18, file khách `CT3_Thang bo-thang may thap.pdf`, 54 trang):** 7 trang AutoCAD (p0,2,11,19,31,38,47) vẽ mỗi glyph thành **nét tô vector `f`**
  và giữ chữ thật ở **render mode 3 (`Tr 3`, vô hình)** để còn tìm kiếm được — 100 % run của các trang này là `texttrace type=3`. `/text-find` / `/text-spans` chỉ thấy lớp vô hình;
  redaction của `/edit-text` lại **chỉ lấy chữ** (BI-23, `graphics=LINE_ART_NONE`) ⇒ lớp vô hình bị xoá còn nét nhìn thấy nguyên vẹn ⇒ chữ mới **chồng lên** chữ cũ
  (`T.K.K.T` đè `T.K.B.V.T.C`). 44 trang Revit (chữ thật) không bị.
- **Sửa:** `api.py` `_erase_outlined_glyphs(fitz, page, edits)`, gọi ở bước **0b** (trước redaction chữ của BI-23). Với mỗi edit mà span là run **`type 3`** (run phủ ≥ 50 % hộp span):
  gom các nét **`f`, cùng màu chữ, nằm trọn trong hộp span + 1.5 pt, không phải “đường kẻ” (cao < 12 % và rộng > 60 % hộp)** → **MỘT** redact rect = hợp các nét + 0.6 pt →
  `apply_redactions(images=NONE, graphics=PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, text=PDF_REDACT_TEXT_NONE)`. Chữ vô hình để bước 1 xoá như cũ.
- **Luật:**
  1. **Trang không có chữ vô hình ⇒ không làm gì** (một lần `get_texttrace`, ~0.03–0.08 s) — mọi file Word / Revit / PDFsharp đi đúng đường cũ. Đo: 44/44 trang Revit giống hệt **từng điểm ảnh** trước/sau.
  2. **Chỉ nét của span đang sửa.** Span bên cạnh, đường kẻ (tô mảnh, cùng màu), nét khác màu, ô trắng nền — còn nguyên (mỗi cái một ca test).
  3. **MỘT rect hợp nhất cho mỗi span** — đo: 11 rect riêng trong **một** `apply_redactions` làm **sót 1 glyph** (V hoặc B) dù thử riêng thì xoá được; một rect hợp nhất sạch (0.9 s), apply từng cái cũng sạch nhưng chậm gấp đôi.
  4. **Phải nới biên:** nét glyph vượt hộp lớp chữ ~1 pt (p0: 1489.2 so với 1490.2); nét cong có bound theo điểm điều khiển lớn hơn `rect` `get_drawings` báo ⇒ không nới thì `IF_COVERED` bỏ sót.
  5. **Không tô nền** (khác phương án “ô trắng”): ô trắng sẽ che đường kẻ / chi tiết bên dưới — đúng điều người dùng phàn nàn. `fill` vẫn là tuỳ chọn tường minh của API (BI-23).
  6. PyMuPDF thiếu hằng `PDF_REDACT_LINE_ART_REMOVE_IF_COVERED` ⇒ bỏ qua bước (về hành vi cũ), không lỗi; thiếu tham số `text=` ⇒ gọi lại không có (vẫn chỉ xoá lớp chữ của chính span này).
- **Lưới:** `.venv\Scripts\python test_edit_text_outlined.py` (6 ca, theo **PIXEL**: chữ cũ hết; span bên cạnh / đường kẻ / nét khác màu còn; trang chữ thật: helper trả 0 và content stream y nguyên).
  **Đột biến 5/5 bị bắt** (bỏ gọi ⇒ `406→406 điểm ảnh` = đúng lỗi gốc; bỏ lọc màu; bỏ lọc đường kẻ; nới vùng 150 pt; bỏ cổng `type 3`).
  **Probe file thật, code thật (không phải nguyên mẫu):** Ctrl+H `T.K.B.V.T.C → T.K.K.T` toàn file ⇒ 7 trang họ B: mực chữ cũ **470→0** (trước sửa 470→470), **0 điểm ảnh lệch ngoài vùng sửa**; 44 trang Revit y hệt.
- **Chưa kiểm / còn mở:** thử trong **app Electron** (chỉ gọi thẳng `edit_text` ở sidecar — cùng đường renderer dùng, nhưng chưa bấm tay); `/translate` (`api.py` ~3300, cùng cách redact) **chưa** áp bước này; PDF **quét** có lớp OCR vô hình trên **ảnh** — không có nét vector để xoá nên vẫn còn ảnh cũ
  (cần cách khác: tô nền lấy mẫu); nét outline lệch hộp lớp chữ > 1.5 pt ngang sẽ không bị xoá (fixture ban đầu của test tự vấp đúng điều này); sidecar **phải build lại** trước khi phát hành (`check-sidecar-fresh.js`).
- **Vỡ khi:** sửa chữ trên trang AutoCAD / “text as geometry” mà chữ cũ còn thấy dưới chữ mới; hoặc ngược lại — sửa xong mất đường kẻ / nhãn bên cạnh / nét màu khác trong hộp; hoặc trang chữ thật đổi từng điểm ảnh sau khi sửa.

### BI-120 · pdf-lib cắt cụt stream có `/Length` GIÁN TIẾP — bản vá phải nạp trước mọi đường mở PDF
- **Căn cứ (đo 2026-11-21, lưới mới `npm run sweep:corpus` trên corpus pdf.js, 1.104 file):** 10 file bị qpdf kêu sau khi chỉ **mở rồi lưu, không sửa gì**
  (`input stream is complete but output may still be valid`), 9 trong số đó cùng một nguyên nhân. `PDFObjectParser.parseDictOrStream` chỉ tin `/Length` khi nó là **một số**;
  gặp `/Length 674 0 R` thì rơi vào `findEndOfStreamFallback`, dò tới `endstream` rồi coi byte ngay trước đó là **dấu xuống dòng ngăn cách**.
  `tracemonkey.pdf` (bài báo 14 trang, file gốc **sạch** theo qpdf): ảnh object 483 dài **1013** byte, byte cuối là `0x0D`, `endstream` viết **dính liền** dữ liệu
  (`… 72 17 33 0d | 65 6e 64 73 74 72 65 61 6d`) ⇒ pdf-lib cắt còn **1012** ⇒ luồng deflate mất byte cuối ⇒ ảnh giải nén ra **8074 byte rác** thay vì 7943, và `/Length` ghi ra cũng là 1012.
- **Sửa:** `desktop/renderer/pdflib-stream-length.js`, **hai lượt** (object chứa độ dài thường nằm **sau** stream trong file, lúc phân tích stream nó chưa có trong context):
  (1) `parseDictOrStream` ghi stream có `/Length` gián tiếp vào danh sách chờ kèm `bytes.offset()` — mỏ neo trỏ ngay sau từ khoá `endstream`;
  (2) bọc `PDFParser.parseDocument`, phân tích xong thì tra độ dài thật và cắt lại từ byte gốc.
- **Luật:**
  1. **Ba cửa, sai một cửa là bỏ qua** (giữ nguyên hành vi pdf-lib): (a) độ dài tra được là số nguyên dương và **khác** độ dài đang có; (b) tìm lại được điểm bắt đầu — byte ở đó khớp 8 byte đầu **và** 8 byte cuối của nội dung parser đã cắt (3 ứng viên, lệch nhau 0/1/2 byte xuống dòng); (c) ngay sau `start + độ dài thật` là `endstream` (cho phép tối đa một dấu xuống dòng). ⇒ bản vá **chỉ** động vào file đang bị đọc sai.
  2. **KHÔNG sửa luật xuống dòng trong `findEndOfStreamFallback`** — có file mà `\r` đúng là dấu ngăn cách; đổi ở đó sẽ làm hỏng chúng.
  3. **Thứ tự nạp là một phần của bản sửa** (BI-14): vá sửa **prototype** của parser, nạp sau một file đã gọi `PDFDocument.load` là vá hụt. `index.html`: ngay sau `vendor/pdf-lib.min.js`, trước `app.js` / `managed-codec.js` / `page-vault.js` / `editor-bake.js` — bốn luật này đã ghim trong `test:scope`.
  4. **Mỗi scope toàn cục là một bản pdf-lib riêng ⇒ mỗi nơi phải vá riêng.** `<script>` của index.html KHÔNG với tới: (a) **Web Worker** `annot-scan.js` (`importScripts("vendor/pdf-lib.min.js")` rồi `importScripts("pdflib-stream-length.js")`, đúng thứ tự); (b) **tiến trình main** — `src/signing-worker.js` gọi `applyStreamLengthFix(require("pdf-lib"))` ngay sau `require`, nơi tài liệu sẽ được **ký** trên phần byte đã hỏng. Quên một nơi là nơi đó đọc bằng parser chưa vá, **im lặng**.
  5. Một bản duy nhất, dùng chung cho renderer / worker / main / lưới quét corpus — **đừng chép thêm bản thứ hai**.
- **Lưới:** `npm run test:streamlen` (dựng PDF đúng ca: ca hỏng cắt lại đúng từng byte; ca có xuống dòng thật **không** bị đụng; độ dài khai báo vô lý bị **từ chối**).
  Cộng **hai ghim nguồn** trong cùng file test: mọi `renderer/*.js` có `importScripts("vendor/pdf-lib.min.js")` phải importScripts bản vá **sau** đó; mọi `src/*.js` có `require("pdf-lib")` phải gọi `applyStreamLengthFix`. `test/annot-scan.test.js` ghim đúng hai dòng importScripts của worker, đúng thứ tự.
  **Đã thử cho đỏ:** vô hiệu hoá bản vá ⇒ 4/11 ca đỏ, thoát 1; gỡ dòng importScripts của worker ⇒ ghim nguồn đỏ. `npm run sweep:corpus`: **1.043 → 1.052 `ok`**, 9 file hết lỗi, 0 file xấu đi.
- **Đo diện ảnh hưởng (2026-11-22, toàn corpus 1.104 file, lưu 2 lần không vá để chứng minh đầu ra tất định rồi vá và lưu lần 3):**
  **1.051 file ra byte Y HỆT** trước/sau bản vá, **13 file đổi byte**, 26 mã hoá + 14 file pdf-lib không mở được (bỏ qua), **0 file không tất định**.
  Chỉ **89/1.104 (8 %)** file có `/Length` gián tiếp; `tracemonkey.pdf` có **348** stream loại đó mà bản vá chỉ chạm **1**. Mỗi stream bị chạm đều được **thêm lại** byte đã mất và khớp đúng con số chính file đó khai:
  `bug1727053` 334→336, `issue10572` 278→279, `issue19517` 3665→3666, `issue9243` 63→64, `tracemonkey` 1012→1013 — không stream nào bị cắt ngắn đi.
  **4 trong 13 file đó (`bug1727053`, `issue10572`, `issue19517`, `issue9243`) qpdf KHÔNG hề kêu** ⇒ lưới quét corpus báo **thiếu**: mất byte trong stream mà vẫn giải nén được thì `--check` không thấy.
- **Probe trong app THẬT (2026-11-22, `electron . --remote-debugging-port` + CDP, 4 lần chạy, mỗi lần một `--user-data-dir` mới):**
  | Lần | Thẻ `<script>` vá | `__nabuStreamLengthFix` | ca lỗi dựng trong trang (đúng = 32) | Worker `annot-scan` | lỗi console |
  |---|---|---|---|---|---|
  | 1 | có | `true` | **32** | trả lời `ok=true` | 2 lỗi nội bộ Electron (xem dưới) |
  | 2 | có, **mở `tracemonkey.pdf` thật qua argv** | `true` | object 483: **1013**, đúng con số file khai | — | — |
  | 3 | **gỡ ra (đối chứng)** | **`false`** | **31 — lỗi tái hiện** | trả lời `ok=true` | 0 |
  | 4 | có, hồ sơ mới | `true` | **32** | trả lời `ok=true` | 0 |

  Lần 3 là **đối chứng**: gỡ đúng một dòng thì phép đo quay về trạng thái lỗi ⇒ probe đo đúng thứ cần đo.
  Lần 2 lưu tài liệu đang mở bằng chính `PDFLib` của trang → `qpdf --check` **sạch**, ảnh object 483 giải nén **7943 byte** (= 47×169, đúng).
  Hai lỗi ở lần 1 (`sandboxed_renderer.bundle.js script failed to run`, `binding.startupData is null`) là **của Electron**, **không tái hiện** ở lần 4 với cùng mã ⇒ nhiễu lần chạy đầu, không phải do bản vá.
  `typeof window.state` là `undefined` ở **cả** lần 3 lẫn lần 4 — đó là bình thường (`state` khai bằng `const` ở cấp 0 nên không gắn vào `window`); đọc bằng **tên trần** thì thấy `state.bytes` = 1.016.315 byte, 14 trang.
- **Chưa kiểm / còn mở:** chưa bấm tay qua **giao diện** (probe gọi thẳng `PDFLib` trong trang, không đi qua nút Lưu / hộp thoại của app); 9 file còn lại trong mốc chưa sửa (5 `load_fail`, 2 `output_error`, 1 `edit_fail`, `doc_actions.pdf` `output_warn` — nguyên nhân khác).
- **Vỡ khi:** nâng pdf-lib lên bản mới (kiểm lại tên `PDFObjectParser` / `PDFParser` / `parseDictOrStream` còn lộ ra ở bundle UMD không), hoặc thêm một file mở PDF mà nạp **trước** `pdflib-stream-length.js`.

### BI-121 · `/compress` phải chạy trong TIẾN TRÌNH CON — `rewrite_images` segfault được, và segfault thì giết cả sidecar
- **Căn cứ (đo 2026-11-22, lưới `tools/corpus_sweep_sidecar.py` trên 1.104 file corpus pdf.js):** `doc.rewrite_images()` làm MuPDF **segfault** (`0xC0000005`).
  Chạy riêng từng thao tác, **3 lần mỗi thao tác, trong tiến trình sạch**: `blendmode.pdf`, `bug_jpx.pdf`, `perf_structure_transfer_functions.pdf` đều **3/3 chết ở `compress`**, **0/3** ở `pagenum` / `split` / `encrypt`.
  Chết cả khi mở từ **đường dẫn** lẫn từ **stream** (mỗi file 1–2 trên 3 lần) ⇒ **không phải** lỗi cách mở file của ta.
  Trong vòng quét đầy đủ, số file `crash` thay đổi giữa hai lần chạy (2 rồi 4) vì segfault phụ thuộc trạng thái bộ cấp phát sau các thao tác trước đó.
- **Vì sao không chặn theo nội dung:** nó **không tất định**. Không có điều kiện nào trên dữ liệu chặn trước được một cách đáng tin, và `try/except` **không bắt được segfault** — tiến trình chết ngay. Cô lập tiến trình là cách duy nhất chắc chắn.
- **Sửa:** bỏ ngưỡng `_COMPRESS_WORKER_MIN_BYTES` (25 MB). `/compress` **và** `/compress-bin` đều đi qua `_compress_anywhere` ⇒ **mọi** lần nén chạy trong tiến trình con.
- **Luật:**
  1. **Không route nào được gọi thẳng `_compress_pdf_bytes`.** Nối thẳng lại = lần nén đó chạy trong chính sidecar và segfault quay lại. `test_compress_always_runs_out_of_process` ghim điều này bằng cách thay `_compress_anywhere` và đếm.
  2. **Chỉ quay về nén tại chỗ khi KHÔNG KHỞI ĐỘNG NỔI tiến trình con** (`OSError`: thiếu script, hết chỗ temp, máy bị khoá chính sách) — mất tính năng tệ hơn một rủi ro hiếm. Worker **chết** (mã thoát khác 0) thì **không** thử lại tại chỗ — lần thử lại duy nhất được phép là **một tiến trình con nữa, ở `lossless`** (BI-122).
  3. **`sidecar.py` không được `import api` ở cấp module.** Cờ `--compress-worker` phải xử lý trước; `api`, `uvicorn`, `argparse` nạp bên trong `main()`. Lõi nén ở `src/pdf/compress.py` **chỉ phụ thuộc PyMuPDF** (đo: `import fitz` 0,082 s · `import fastapi` 0,267 s · `import api` 0,378 s). Ghim: `test_compress_worker_does_not_import_the_whole_server`.
  4. **Thông điệp lỗi của worker là hợp đồng**: `CompressRequestError` → mã thoát 3 → `HTTPException` 400 với nguyên văn tiếng Việt, đi qua ranh giới tiến trình bằng **UTF-8** cả hai đầu (ghim sẵn ở `test_compress_worker_reports_caller_errors_as_400`).
  5. **Ước lượng thời gian ở renderer cộng chi phí tiến trình con cho MỌI kích thước** (`COMPRESS_WORKER_START_S`), không còn bậc thang ở 25 MB.
- **Số đo chi phí, kèm một đính chính của chính tôi:** 3,72 s rồi 3,04 s là **lần chạy đầu**, khi ảnh `sidecar.exe` 75 MB chưa nằm trong cache hệ điều hành. **Khi đã ấm** (trung vị 5 lần, có chạy làm nóng, đo lại trên bản build `0ebf06fc`): `tracemonkey.pdf` **0,54 s** ở bản đóng gói so với **0,23 s** nén tại chỗ ⇒ chi phí thật ~**0,3 s**. Nén một trang rỗng ở bản đóng gói: **0,29 s**. Bản dev: 0,76 s → **0,38 s** sau khi worker thôi phải `import api`. Trong app thật `sidecar.exe` vốn đang chạy sẵn nên ảnh đã ấm.
- **Lưới an toàn phía app:** `main.js` **tự dựng lại** sidecar sau khi nó chết, trần **3 lần / 5 phút** (`sidecar.planSidecarRestart`, hàm thuần, 8 ca trong `test:sidecar` + ghim nguồn `onExit` thật sự gọi nó). Quá trần thì quay về thông báo cũ.
- **Chưa kiểm / còn mở:** chưa bấm tay nút "Nén" trong app đóng gói; chi phí ~0,3 s mỗi lần nén có thể bỏ hẳn bằng **worker thường trú**, chưa làm. (`op_fail:compress` — 6 file `Bad PatternType` / `pixmap may not have alpha to save as JPEG` — **đã sửa ở BI-122**.)
- **Vỡ khi:** một route nén gọi thẳng `_compress_pdf_bytes`; `sidecar.py` nạp `api` trở lại ở cấp module; hoặc nâng PyMuPDF mà không chạy lại `tools/corpus_sweep_sidecar.py`.

### BI-122 · Nén lại ảnh là việc "cố gắng": `rewrite_images` gãy thì bỏ ảnh, **không** bỏ cả thao tác nén
- **Căn cứ (đo 2026-11-22, `tools/corpus_sweep_sidecar.py`, 1.104 file corpus pdf.js):** 8 file ra `op_fail:compress`, hai nhóm nguyên nhân khác hẳn nhau:

  | Nhóm | File | Lỗi | Bắt được bằng `try/except`? |
  |---|---|---|---|
  | A | `clippath.pdf`, `issue18894.pdf` | `FzErrorFormat code=7: Bad PatternType` | **có** |
  | A | `issue19326.pdf`, `issue19517.pdf`, `jpx_numcomps.pdf`, `jpx_smaskindata.pdf` | `FzErrorArgument code=4: pixmap may not have alpha to save as JPEG` | **có** |
  | B | `blendmode.pdf`, `perf_structure_transfer_functions.pdf` | thoát `3221225477` (= `0xC0000005`) | **không** — segfault (BI-121) |

  Cả 8 đều gãy **bên trong `doc.rewrite_images()`**. Mọi nhánh khác (`subset_fonts`, `tobytes`) chạy bình thường trên chính những file đó.
- **Số đo dẫn tới bản vá:**
  - Nhóm A, bỏ hẳn bước ảnh rồi `tobytes(deflate, garbage=4, clean)`: **6/6 ra PDF hợp lệ**; qpdf **sạch 5/6**, file thứ sáu (`clippath.pdf`) cảnh báo đúng **cảnh báo đã có sẵn ở bản gốc** (`kid 0 … Resources is missing or invalid`), nên không tính là ta làm hỏng.
  - Nhóm B, đo bằng **chính lệnh worker** (`sidecar.py --compress-worker`), **10 lần mỗi file mỗi preset**, mỗi lần một tiến trình sạch:

    | file | `ebook` chết | `lossless` chết |
    |---|---|---|
    | `blendmode.pdf` | **10/10** | **0/10** |
    | `perf_structure_transfer_functions.pdf` | **8/10** | **0/10** |
    | `bug_jpx.pdf` | **7/10** | **0/10** |

    Cột trái **không ổn định giữa các loạt đo** — cùng file, cùng mã, một loạt khác cho 5/5 và một loạt khác nữa cho 3/5; đúng tính chất đã ghi ở BI-121. Cột phải thì ổn định: **30/30** lần `lossless` đều sống. Bản vá đứng trên cột phải, không phải cột trái.
  - Hai cách xử lý nhóm A cho **độ dài đầu ra bằng nhau từng cặp** trên cả 6 file: lưu tiếp tài liệu đã bị sửa dở, hay mở lại từ byte gốc. (Không so được **byte**: PyMuPDF nhúng `/ID` mới mỗi lần ghi, nên cùng một mã chạy hai lần đã khác hash.)
- **Sửa:** `compress_pdf_bytes_ex` bọc `rewrite_images` trong `try/except`; gãy thì **đóng tài liệu, mở lại từ byte gốc**, lưu bằng deflate + `garbage=4` và trả về `CompressResult(data, images_failed=True)`. Worker thoát **4** cho trường hợp đó; `_compress_anywhere` bắt `RuntimeError` (worker chết) và **thử lại một lần ở `lossless`, vẫn trong tiến trình con**.
- **Luật:**
  1. **Mở lại từ byte gốc, đừng lưu tài liệu đã sửa dở.** `rewrite_images` không nguyên tử — nó có thể thay vài ảnh rồi mới ném. 6 file đo được cho kết quả như nhau, nhưng 6 file không phải một lời hứa; một lần `fitz.open` thêm trên nhánh hiếm rẻ hơn việc phải đoán tài liệu đang ở trạng thái nào. Ghim: `test_compress_discards_a_half_rewritten_document` (hàm giả lập xoá một trang trước khi ném; lưu tiếp ⇒ 2 trang, đỏ).
  2. **Mã thoát 4 là THÀNH CÔNG kèm ghi chú, không phải "worker chết".** Đọc nhầm ⇒ mọi file ảnh gãy đi vào nhánh thử lại, tốn thêm một tiến trình cho đúng việc vừa làm xong. Ghim hai đầu: `test_worker_exit_four_is_success_not_death` + `test_worker_exit_code_four_is_the_same_number_on_both_sides` (ghim nguồn `sidecar.py`).
  3. **Chỉ thử lại MỘT lần, và chỉ khi preset không phải `lossless`.** Ở `lossless` chẳng còn gì để bỏ bớt — thử lại chỉ là chết lần nữa, chậm gấp đôi. Ghim: `test_compress_does_not_retry_a_lossless_worker_death`.
  4. **`images_failed` nghĩa là "không làm được việc đã hứa", không phải "đã bỏ qua ảnh".** Preset `lossless` vốn không nén ảnh nên **luôn** là `False`. Ghim: `test_compress_lossless_never_claims_an_image_failure`.
  5. **Phải nói ra với người dùng.** `/compress` có trường `images_failed`; `/compress-bin` có header `X-Images-Failed: 1` — và tên đó **phải nằm trong `expose_headers`** của CORS, thiếu thì renderer đọc ra `null` **mà không báo lỗi ở đâu cả**. Header chỉ gửi khi đúng là đã gãy. Renderer đổi **lời văn** của toast (không chỉ đổi màu) và vẫn **lưu file bình thường**. Ghim: `npm run test:imgfail` — lưới bắc cầu hai ngôn ngữ, đọc tên header từ chính `api.py`.
- **Kết quả trên lưới quét (cùng corpus, cùng commit `57dead10`):** `op_fail:compress` **8 → 0**, `broken_input:compress` **1 → 0**, `ok` **1044 → 1052**, `crash` **0 → 0**. Không file nào xấu đi. Mốc mới ghim ở `tools/corpus-baseline-sidecar.json` (12 file không sạch, trước là 20).
- **Vì sao lưới Python phải giả lập:** hai lỗi của nhóm A đến từ sâu trong MuPDF trên ảnh JPX/pattern và **không dựng lại được** bằng PyMuPDF — thử `insert_image` với `RGBA`/`LA` ở ba cỡ đều **không** làm `rewrite_images` ném lỗi (nó tách alpha thành `/SMask` nên ảnh nền hết alpha), và repo không giữ PDF nhị phân trong test. Nên test thay chính `fitz.Document.rewrite_images`. File thật được chấm ở lưới thứ ba.
- **Đã kiểm trên BẢN ĐÓNG GÓI (`dist/sidecar/sidecar.exe`, build `0ebf06fc`)** — vì mã thoát và argv của bản frozen khác bản dev (cùng lý do BI-54 bắt buộc test tay trên bản đóng gói):
  - **Mã thoát 4 sống qua PyInstaller:** 6/6 file nhóm A ra đúng `exit=4` **và vẫn có file kết quả**; `tracemonkey.pdf` lành ra `exit=0` (không báo nhầm).
  - **Nhóm B trên bản frozen:** `blendmode.pdf` `ebook` chết 5/5 · `lossless` **0/5**; `perf_structure_transfer_functions.pdf` 4/5 · **0/5**; `bug_jpx.pdf` 4/5 · **0/5**.
  - **Cả đường dây qua HTTP:** chạy `sidecar.exe --port …` như server thật rồi POST `/compress-bin`. `jpx_smaskindata` + `clippath` (nhóm A) và `blendmode` + `perf_structure` (nhóm B) đều trả về **PDF hợp lệ kèm header `X-Images-Failed: 1`**; `blendmode` ra đúng 49.992 byte của đường `lossless`, tức **worker chết rồi tự thử lại thật**. `tracemonkey.pdf` **không** có header đó. **`/health` vẫn 200 sau tất cả** — server sống sót qua mọi cái chết của worker.
  - Một bẫy của chính phép kiểm, ghi lại để khỏi vấp lại: uvicorn gửi header **chữ thường**, nên `dict(response.headers).get("X-Images-Failed")` trả về `None` và phép kiểm đầu tiên báo oan 3 lỗi. Phải đọc qua chính đối tượng headers (không phân biệt hoa thường). Phía renderer dùng `Headers.get()` của Fetch API nên **không** dính bẫy này.
- **Đã bấm tay trong app (chủ repo, 2026-11-22)** — `SS-71.pdf` (4,92 MB), nút **Nén**: ra file, toast ghi *"Đã nén: 4.92 MB → 4.26 MB (87%)"*, **không** có câu về ảnh. Đó là **đúng**: chạy lại chính file đó qua `sidecar.exe --compress-worker` cho `exit=0` ba lần liền và output **4.470.473 byte trùng khít** file app lưu ra, tức `rewrite_images` chạy trót lọt nên không có gì để báo. Phép thử này chứng minh **đường nén qua tiến trình con (BI-121) chạy thật trong app đóng gói** — nhưng nó **không** chạm vào nhánh BI-122, vì file lành thì nhánh đó không bật.
- **Probe renderer thật (`desktop/scripts/probe-images-failed.js`)** — thứ còn thiếu là: CORS có để `X-Images-Failed` lọt qua tới renderer không? Renderer chạy từ `file://` nên mọi lệnh gọi sidecar là **cross-origin**; thiếu `expose_headers` thì `.get()` trả `null` **mà không báo lỗi ở đâu cả**. Chạy app thật với `--remote-debugging-port`, gọi **chính `sidecarFetch`** mà `runCompress` dùng, rồi đọc header y như nó đọc:

  | file | `res.headers.get("X-Images-Failed")` |
  |---|---|
  | `jpx_smaskindata.pdf` | **`"1"`** — renderer đọc được `x-images-failed` trong danh sách header |
  | `tracemonkey.pdf` | `null` — không gửi, đúng |

  Không bấm nút Nén thật vì nút đó kết thúc bằng **hộp thoại Lưu native** mà CDP không bấm được; phần còn lại sau `.get()` chỉ là nối chuỗi, đã ghim ở `npm run test:imgfail`.
  - Hai cái vấp khi viết probe, ghi lại vì cả hai đều im lặng: (a) `sidecar` là **biến trần** ở scope toàn cục của renderer, hỏi `window.sidecar` luôn ra `undefined` (§2, BI-14); (b) `spawn(…, {shell: true})` rồi `child.kill()` chỉ giết `cmd.exe`, Electron sống tiếp và **giữ cổng debug** — lần chạy sau treo vô hạn vì nối vào một target đã chết. Spawn thẳng `electron.exe` và `taskkill /T`.
- **Đã nhìn tận mắt câu toast (`desktop/scripts/probe-images-failed-toast.js`)** — chạy **chính `runCompress()`** trong app thật, đi hết cả nhánh `if (r.saved)`, rồi đọc `#toast`:

  | file nén | `#toast`.textContent | class |
  |---|---|---|
  | `clippath.pdf` | *"Không giảm thêm được — đã lưu bản gốc tối ưu. **Ảnh trong file này không nén lại được.**"* | `toast warn` |
  | `tracemonkey.pdf` | *"Đã nén: 992 KB → 822 KB (83%)"* | `toast good` |

  Và file **thật sự ra đĩa** (459 B / 842.144 B, cả hai bắt đầu bằng `%PDF`), hộp thoại Lưu được gọi đúng 2 lần.
  - **Cách vượt hộp thoại Lưu native:** thay `window.desktop.savePdf` trong renderer **không được** — contextBridge khoá object đã lộ ra, phép gán im lặng không ăn (thử rồi: gán xong so lại vẫn ra hàm cũ). Phải nối vào tiến trình **main** bằng `--inspect` và thay đúng một hàm `dialog.showSaveDialog`. Mọi mã khác — IPC, `fs.writeFile`, renderer — là mã ship thật. Còn lại trong corpus, **không** thuộc đường nén: 5 `op_fail:pagenum`, 1 `op_fail:split` (`opt_demo.pdf`, `22 is not in list` — lỗi Python của chính ta), 2 `timeout` (sidecar **không có hạn giờ nào**), 1 `open_fail`, 3 `output_warn`.
- **Vỡ khi:** ai đó gỡ `try/except` quanh `rewrite_images`; lưu tiếp tài liệu đã sửa dở cho "nhanh"; đổi mã thoát 4 ở một bên; bỏ `X-Images-Failed` khỏi `expose_headers`; hoặc nâng PyMuPDF mà không chạy lại `tools/corpus_sweep_sidecar.py`.

### BI-123 · Mỗi lần nén phải có TRẦN thời gian — hôm qua nó chạy mãi mãi
- **Căn cứ (đo 2026-11-22):** `bomb_giant.pdf` (bom giải nén, **123 KB, 1 trang**, corpus pdf.js) vượt **100 s** ở **cả** `ebook` lẫn `lossless`, không có dấu hiệu dừng. Người dùng bấm **Nén** rồi chỉ còn cách tắt app: lớp phủ không bao giờ tắt và **không có nút Hủy** (`runCompress` nói thẳng điều đó trong comment).
- **Sửa:** `COMPRESS_TIMEOUT_S = 30 * 60` truyền vào `subprocess.run`. Hết giờ ⇒ tiến trình con bị giết, ném `CompressTimeout`.
- **Vì sao đúng 30 phút** (đây là chỗ dễ sửa bừa nhất): trần công việc **hợp lệ** là `MAX_PAGES` 3000 trang × ~0,377 s/trang ≈ **19 phút**. Hạ xuống dưới mức đó là bắt đầu **giết những lần nén đúng đắn**. Và **không scale theo dung lượng được**: `bug1978317.pdf` chỉ **1,5 MB / 1 trang** mà mất **76–92 s hợp lệ**, trong khi `bomb_giant.pdf` **123 KB** thì không bao giờ xong — dung lượng không nói lên gì về thời gian.
- **Luật:**
  1. **`CompressTimeout` là lớp RIÊNG, không phải `RuntimeError` trần.** `RuntimeError` đang là tín hiệu "worker chết ⇒ thử lại không nén ảnh" (BI-122); hết giờ mà đi vào nhánh đó là bắt người dùng chờ thêm một trần nữa — đo được `bomb_giant.pdf` vượt hạn ở **cả hai** preset. Ghim: `test_compress_does_not_retry_after_a_timeout`.
  2. **Hạn giờ phải thật sự tới `subprocess.run`.** Lưới đầu tiên tôi viết nuốt mất nó (hàm giả lập ném `TimeoutExpired` mà không nhìn tham số), nên xoá `timeout=` vẫn xanh. Nay hàm giả lập **khẳng định** `timeout == COMPRESS_TIMEOUT_S`.
  3. **Trần không được hạ xuống dưới 20 phút.** Ghim bằng số: `test_compress_has_a_ceiling_and_it_is_generous`.
- **Đã làm tiếp:** trần này mới là chặn "mãi mãi". Nút **Hủy** là việc riêng và **nay đã có** — xem **BI-126**. Trần vẫn cần: nó lo cho lần nén mà người dùng bấm xong rồi bỏ đi.
- **Vỡ khi:** ai đó hạ trần cho "phản hồi nhanh hơn"; hoặc đổi `CompressTimeout` thành `RuntimeError` trần.

### BI-124 · `/split` tự chữa trường form thiếu `/Kids` — và phải MỞ LẠI tài liệu trước khi thử lại
- **Căn cứ (đo 2026-11-22):** `opt_demo.pdf` (corpus pdf.js) — widget **22** và **23** ghi `/Parent 21 0 R`, nhưng trường **21** (`veg`, nhóm radio) **không có `/Kids` nào cả**, trong khi hai trường anh em **5** (`fruit`) và **9** (`shared`) thì có. Chuẩn PDF đòi trường cha phải liệt kê widget con trong `/Kids`.
  `insert_pdf` đi từ `/Fields`, theo `/Parent` lên cha, rồi tìm widget trong `/Kids` của cha — `idx = parent["old_kids"].index(xref)` → `ValueError: 22 is not in list`, và **cả thao tác tách hỏng**. **qpdf chấm file gốc là *sạch*** ⇒ đây là chỗ PyMuPDF khắt khe hơn trọng tài, không phải file hỏng theo nghĩa thông thường.
- **Sửa:** `_repair_orphan_field_kids` dựng lại `/Kids` từ chính dữ liệu đã có trong tài liệu (widget nào trỏ `/Parent` về trường nào thì là con của trường ấy), rồi tách lại **một lần**.
- **Số đo:** vá đúng ⇒ **5.663 byte, đủ 9 widget** kể cả nhóm `veg`, qpdf chấm đầu ra **sạch**. Đường rẻ hơn `insert_pdf(widgets=False)` ⇒ cũng chạy, nhưng **1.619 byte, 0 widget** — mất trắng cả form.
- **Luật:**
  1. **Chỉ vá SAU KHI `insert_pdf` đã hỏng**, và **chỉ khi phép vá thật sự chạm vào cái gì** (`if not da_va: raise`). Tài liệu lành không đi qua đây, nên đường tách bình thường không chịu thêm một phép đọc xref nào.
  2. **Chỉ thêm thứ còn thiếu, không viết lại form của người ta.** Trường đã có `/Kids` đủ con thì bỏ qua. Ghim: `test_repair_only_touches_fields_that_are_actually_missing_kids` (chạy phép vá hai lần, lần hai phải trả về rỗng).
  3. **Thử lại phải MỞ LẠI tài liệu từ byte gốc.** Lần đầu tôi vá ngay trên `doc` cũ: ra **1.619 byte, không còn widget nào** — *mất trắng cả form mà vẫn báo thành công*, tức một lỗi mất dữ liệu **im lặng**. `insert_pdf` hỏng giữa chừng để lại sổ sách nội bộ đã sửa dở. Cùng bài học với BI-122.
- **Lỗ hổng đã biết của chính lưới này:** luật 3 **không có ca hành vi nào giữ**. Tài liệu dựng tay trong `test_pdf_ops.py` **không tái hiện được** chỗ đó (đo: cả hai đường đều ra 1.302 byte / 2 widget — cấu trúc gây bẩn chỉ xuất hiện trên form nhiều nhánh như `opt_demo.pdf`), mà `test_*.py` là cổng của `/deploy` nên không được phụ thuộc corpus ngoài repo. **Lưới quét corpus cũng không đỡ**: nó chấm qpdf + số trang, **không đếm widget**. Nên luật 3 chỉ còn **ghim nguồn** giữ (`test_split_retry_reopens_the_document_from_the_original_bytes`). Đụng khối thử lại ⇒ đọc mục này trước.
- **Vỡ khi:** bỏ phép mở lại cho "nhanh"; hoặc cho phép vá chạy trước khi tách (nó sẽ đụng vào form lành).

### BI-125 · Câu lỗi của thư viện không phải câu cho người dùng — và `fitz.open` thành công không có nghĩa là tài liệu dùng được
- **Căn cứ (đo 2026-11-22):** mọi thao tác thất bại còn lại của lưới quét trả **thẳng văn bản của PyMuPDF** ra toast. Người dùng đọc được đúng những câu này: `22 is not in list` · `cannot save with zero pages` · `code=4: index out of bounds` · `code=4: not a dict (null)` · `code=7: Invalid number of pages`. Không câu nào nói cho họ biết nên làm gì.
- **Sửa:** `nice_pdf_error` (`src/pdf/util.py`) khớp theo **chuỗi con** và **luôn giữ nguyên văn gốc trong ngoặc**; không khớp thì trả lại nguyên văn chứ không bịa. Khớp theo chuỗi con là **cố ý**: số hiệu lỗi của MuPDF đổi theo phiên bản, lời văn bền hơn.
- **Hai chỗ chặn sớm đi kèm:**
  1. **`/add-page-numbers` chốt 0 trang**, như `/split` vẫn chốt. Thiếu nó thì 3 file corpus (`issue21436.pdf`, `poppler-91414-0-53.pdf`, `-54.pdf`) đi hết đường rồi mới chết ở `tobytes`.
  2. **`_open_pdf_stream` đếm trang ngay sau khi mở.** **MuPDF mở lười**: cây trang chỉ đọc khi có người hỏi. `poppler-67295-0.pdf` (794 byte) `fitz.open` trả về bình thường, rồi `doc.page_count` mới ném. Vì **mỗi route đọc số trang ở một chỗ khác nhau**, lỗi ấy thoát ra thành **500 Internal Server Error** thay vì một câu 400 đọc được — và không route nào tự lo được, vì chúng đều giả định "mở được là dùng được". Nên phép đếm nằm ở **một chỗ, cho mọi route**.
- **Luật:** **đừng nuốt nguyên văn của thư viện.** Mất nó là mất khả năng tra cứu; lưới `test_library_errors_become_vietnamese_but_keep_the_original` đỏ ngay nếu ai đó bỏ phần trong ngoặc.
- **Vỡ khi:** thêm route đọc PDF mà không đi qua `_open_pdf_stream`; hoặc trả `str(e)` thẳng ở một route ghi file mới.

### BI-126 · Nút Hủy cho nén — và nó phải THẮNG MỌI CUỘC ĐUA, nếu không thì nó nói dối
- **Vì sao làm được bây giờ mà trước thì không:** nén đã nằm ở **tiến trình con** từ BI-121, nên "dừng lại" chỉ là giết đúng tiến trình đó. Hồi còn nén tại chỗ thì không có đường nào — `rewrite_images()` giữ GIL suốt thời gian chạy, **không có điểm nào chen một phép kiểm tra cờ vào giữa** (đo ở BI-121: luồng quan sát chạy được 0,1 % thời gian và không thực hiện nổi một vòng lặp).
- **Hình dạng:** renderer sinh một mã việc (`newJobId()`), gửi kèm ở `/compress-bin?…&job=`; nút Hủy gọi `POST /compress-cancel?job=` và sidecar giết tiến trình con mang mã đó. Mọi route vốn đã nằm sau token per-launch nên không cần thêm lớp xác thực nào.
- **NÚT KHÔNG ĐƯỢC NÓI DỐI — đây là cả thiết kế.** Renderer **không** `AbortController`. Abort chỉ làm renderer thôi nhìn, còn máy vẫn nén tiếp tới 30 phút và vẫn ăn RAM gấp 4 lần file; người dùng không có cách nào biết. Sidecar mới là bên biết lần nén đã dừng hẳn chưa, nên ta **hỏi nó và chờ nó trả lời**. Gửi lệnh hủy mà không tới ⇒ mở lại nút, giữ lớp phủ, nói ra bằng toast — **không** đóng lớp phủ giả vờ là xong.
- **Ba cuộc đua, cả ba phải thua cái Hủy** (người dùng bấm được ở bất kỳ mili-giây nào):
  1. **Đang chạy** → `/compress-cancel` tra sổ ra `proc` rồi `kill()`.
  2. **Trước khi có tiến trình con** (còn đang ghi file tạm) → lúc đó `job.proc` là None nên không giết được gì; `_compress_via_worker_blocking` **đọc lại cờ ngay sau `Popen`** và giết luôn. Thiếu bước này là vừa sinh ra một tiến trình nén **mồ côi** chạy tiếp sau lưng người dùng.
  3. **Trước cả khi route kịp ghi sổ** → để lại **bia mộ** trong sổ; lần nén ấy vừa ghi sổ là thấy và chết lúc chào đời. Xảy ra thật: nút Hủy hiện ra **trước khi `fetch` được gọi**, và thân một PDF vài trăm MB mất một lúc mới truyền xong. Không có bia mộ thì Hủy báo "không tìm thấy" rồi máy nén tiếp — im lặng hoàn toàn. Vì thế ô trong sổ được ghi **trước** `await request.body()`, không phải sau.
- **Cái bẫy lặng lẽ nhất, và là lý do `CompressCancelled` là lớp RIÊNG:** tiến trình bị giết thoát với **mã lạ**, mà mã lạ nghĩa là *"worker chết ⇒ thử lại ở `lossless`"* (BI-122). Để nó rơi vào `except RuntimeError` thì bấm Hủy xong máy **chạy thêm một lần nén nữa** — đúng thứ người dùng vừa bảo đừng làm. Cùng khuôn với `CompressTimeout` (BI-123), và cả hai nằm chung một `except` ở `_compress_anywhere`.
- **Luật:**
  1. **Cờ `cancelled` được đọc TRƯỚC mọi phép diễn giải mã thoát.** Đảo thứ tự là rơi thẳng vào cái bẫy trên.
  2. **`Popen` + `communicate(timeout=…)`, không phải `subprocess.run`.** run() không đưa lại tay nắm nào. Đổi lại, việc dọn xác mà run() vốn làm hộ thì **phải tự làm**: nhánh hết giờ `kill()` rồi `communicate()` lần nữa. Quên là để lại một tiến trình nén không ai cầm handle — đúng thứ BI-123 sinh ra để chặn. Hạn giờ của BI-123 **vẫn còn nguyên**, chỉ chuyển sang `communicate`.
  3. **Hủy KHÔNG phải lỗi.** Cả hai route trả `cancelled` tách khỏi `error`, và renderer bật toast thường chứ không toast đỏ "Nén lỗi: …" cho việc chính người dùng vừa yêu cầu.
  4. **Ô trong sổ sống đúng một request** (`finally: pop`). Rò một ô là rò luôn cái tay nắm tiến trình con nằm trong nó. Sổ có trần `_MAX_COMPRESS_JOBS` vì bia mộ mang tên do **client tự đặt**.
  5. **Nút Hủy của lớp phủ là TÙY CHỌN và mặc định không có.** `#overlay` dùng chung cho ~49 thao tác, phần lớn không dừng giữa chừng được; một nút bấm vào không làm gì còn tệ hơn là không có nút. Handler dựng lại mỗi lần `showOverlay` và gỡ hẳn ở `hideOverlay` — giữ lại handler cũ thì thao tác sau mọc ra nút Hủy đi hủy việc đã xong (đúng kiểu lỗi `#confirm-modal` từng vấp với nút thứ ba).
- **KHÔNG hủy được, và biết là không:** nhánh dự phòng "nén tại chỗ" khi **không sinh nổi tiến trình con** (thiếu script, hết chỗ temp, máy bị khoá chính sách). Nén tại chỗ giữ GIL suốt, không có điểm nào chen phép kiểm tra cờ vào. Hiếm, và vẫn có trần giờ của BI-123 đỡ — nhưng đừng quên nó có đó.
- **Đã bấm tận tay (`desktop/scripts/probe-compress-cancel.js`)** — app thật, nút thật, `.click()` thật, trên `bomb_giant.pdf` (bom giải nén, **không bao giờ nén xong**: đo được vượt 100 s ở cả `ebook` lẫn `lossless`). Đó là lý do chọn đúng file này: probe xong trong vài giây thì chỉ có một cách giải thích. Probe đếm tiến trình có `--compress-worker` trong dòng lệnh **trước và sau** khi bấm — toast chỉ nói renderer *nghĩ* gì, con số ấy nói hệ điều hành *thấy* gì — rồi kiểm `/health` để chắc là ta giết tiến trình con chứ không giết sidecar. Số đo (2026-11-22, bản dev):

  | | |
  |---|---|
  | lớp phủ | hiện, nút **Hủy** hiện, **chưa** khoá, chữ `"Hủy"` |
  | từ lúc bấm tới lúc `runCompress` kết thúc | **0,50 s** (tổng 3,9 s) |
  | toast | `"Đã hủy nén."`, class `toast` — **không** `bad` |
  | lớp phủ sau đó | đã tắt |
  | tiến trình `--compress-worker` | **2 → 0** |
  | `/health` sau khi hủy | **200** |

- **Tiến trình con là một CẶP ở dev, MỘT ở bản đóng gói — và `kill()` dọn sạch cả hai.** Đo riêng (`do_cay_tien_trinh`, nén `bomb_giant.pdf` 6 s rồi giết, đếm lại sau 2 s): dev ra `['7736 25060', '29832 7736']` (python.exe của venv là **stub**, nó sinh python thật làm con) → sau `kill` còn **0**; bản đóng gói ra **1** tiến trình → sau `kill` còn **0**. `TerminateProcess` trên Windows vốn **không** giết con cháu, nên đây không phải chuyện hiển nhiên: stub của venv dựng con trong một **Job Object kill-on-close** (đúng thiết kế của CPython launcher), còn bản đóng gói thì onedir chạy `--compress-worker` **không hề fork**. Hệ quả cho người sửa: đừng ghim cứng "phải có đúng 1 worker" — con số cần về 0 là con số **sau khi hủy**.
- **Bẫy của chính phép đo này:** lọc tiến trình bằng mỗi `CommandLine -like '*--compress-worker*'` thì câu lệnh **tự đếm chính nó** (dòng lệnh của PowerShell có chứa đúng chuỗi đang tìm), số đếm không bao giờ về 0 và probe báo sai là "tiến trình không chết". Phải `-Filter` theo **tên tiến trình** trước.
- **Vỡ khi:** ai đó "đơn giản hoá" bằng `AbortController`; đổi `CompressCancelled` thành `RuntimeError` trần; bỏ phép đọc cờ sau `Popen`; chuyển chỗ ghi sổ ra sau `await request.body()`; hoặc bỏ `btn.onclick = null` ở `hideOverlay`.

### BI-127 · Đừng lặng lẽ phá chữ ký số — hỏi trước khi ghi đè một file đã ký
- **Lỗi nghiệp vụ:** mọi đường lưu của app dựng lại TOÀN BỘ file (pdf-lib `save()`), nên ký số xong (hoặc nhận hợp đồng đã ký từ bên khác), sửa gì đó rồi Ctrl+S là **mất chữ ký, không một lời cảnh báo**. App không hề biết file nó sắp ghi đè là file đã ký (`grep ByteRange` ở renderer lẫn sidecar = 0 kết quả; cảnh báo duy nhất là toast sau khi ký ở `sign.js`, chỉ có nghĩa với file do chính mình ký). **Đo (spike 2026-11-22, corpus pdf.js):** trong 7 file ký thật mà pdf-lib mở được, đường lưu hiện tại phá vùng ký **7/7**.
- **Chốt 1 CHỈ làm phần "đừng phá lặng lẽ"** — hỏi trước khi ghi. Nó **không** giữ được chữ ký; việc đó là lưu incremental (các chốt sau, xem memory `incremental-save-spike`).
- **Vì sao chặn ở MAIN, trên FILE ĐANG NẰM TRÊN ĐĨA, mà không phải ở renderer lúc mở file:**
  1. renderer có **13 chỗ** ghi PDF (12 × `savePdf` + `writePdf`) — chặn ở đó là sửa 13 chỗ và sót chỗ thứ 14;
  2. lúc mở file, byte có thể **đã bị sửa** (khôi phục sau crash, tab tách ra, `adoptTab`) — renderer thấy "file không có chữ ký" trong khi file trên đĩa thì có;
  3. "Lưu thành" chọn **trúng đường dẫn của chính file đã ký** cũng phải bị bắt.
  Nguồn sự thật duy nhất = file ở đường dẫn sắp bị ghi đè, ngay trước khi byte chạm đĩa. Cổng nằm ở `desktop/src/signed-scan.js` (thuần, test được trong node), nối vào hai handler ở `main.js`: **`dialog:save-pdf`** và **`file:write-pdf`**. Renderer chỉ đổi **một dòng** (`saveDoc`: `if (res.canceled) return;`).
- **"Chữ ký còn nguyên" = các byte trong `/ByteRange` còn nguyên.** Dữ liệu mới phải **bắt đầu bằng đúng những byte cũ** tới hết vùng ký (`C + L2`). Đó cũng chính là tính chất của "ghi nối" — nên chốt incremental sau này đi qua cổng này mà **không cần sửa gì**. Ta **không** xác minh mật mã (chưa có trọng tài độc lập, pyHanko không có trong venv).
- **Một `/ByteRange` chỉ được tính khi nhìn ĐÚNG như của một chữ ký thật:** bốn số nguyên, bắt đầu từ 0, không vượt cỡ file; và khoảng hở `[L1, C)` là một **chuỗi hex đóng trong `< >`**. **Có HAI quy ước thật** (đo trên corpus): Acrobat/Foxit để cả hai dấu `< >` **trong** khoảng hở; một số bộ ký khác để chúng **ngoài** (`signed_verified.pdf`). Bản đầu chỉ nhận quy ước thứ nhất và **loại nhầm một file ký thật** — test tầng corpus bắt được nó, file giả tự dựng thì không. Kiểm "ruột là hex" chặt hơn hẳn việc chỉ nhìn hai dấu ngoặc.
- **9 file corpus chứa chữ `/ByteRange`, chỉ 6 là chữ ký còn nguyên.** 3 file còn lại (`issue6127`, `xfa_filled_imm1344e`, `poppler-395-0-fuzzed`) **đã vỡ sẵn**: offset trỏ vào giữa chuỗi hex hoặc vào chữ thường (`"Alternate"`, `"NANumber"`) vì file bị công cụ khác dựng lại hoặc bị fuzz. Đừng "sửa" để chúng được đếm — loại chúng là mục đích của điều kiện này.
- **Luật:**
  1. **Mọi đường ghi PDF của tài liệu ở main phải qua `SignedScan.guardWrite`.** Handler ghi PDF mới ⇒ thêm cổng. (`file:write-new-pdf` đã có cổng từ BI-135.)
  2. **Lệnh `writeFile` phải nằm SAU CẢ HAI nhánh rẽ `cancel` và `copy`.** Chỉ "gọi cổng trước lệnh ghi" là chưa đủ: đột biến thử (ghi rồi mới xét câu trả lời) vẫn qua phép kiểm đó trong khi người dùng bấm Huỷ mà file vẫn bị ghi đè — test đã được siết sau khi đột biến này lọt lưới.
  3. **Nút an toàn là nút MẶC ĐỊNH** (`defaultId: 0` = "đi chỗ khác"); Enter không bao giờ phá chữ ký. Thứ tự nút và bảng ánh xạ `["copy","overwrite","cancel"]` phải đổi **cùng nhau**. **Mọi đáp án lạ ⇒ `cancel`** (nút hỏng không được biến thành ghi đè); hộp thoại ném lỗi ⇒ `cancel`.
  4. **Fail-open có chủ đích:** mọi lỗi **đọc** file đích (không tồn tại, bị khoá, không đủ quyền, là thư mục) ⇒ coi như không có thông tin ⇒ cho ghi như trước. Cổng là lời nhắc, không được thành lý do để "Lưu" không lưu nổi; chính lệnh ghi sẽ báo lỗi thật. Ngược lại với cổng ở phía **ghi nối** (chốt sau), nơi phải fail-closed.
  5. **Đọc theo khúc, không nạp cả file** (file đích có thể vài trăm MB và nằm trong main — bài học `large-pdf-decode-oom`). Hai khúc chồng nhau đúng `len("/ByteRange") − 1` byte để kim vắt qua ranh giới vẫn lọt trọn vào một khúc và không khúc nào thấy nó hai lần; test quét mọi cỡ khúc 32..200.
- **Số đo:** quét cả 1.104 file corpus **266 ms**, 0 lỗi đọc, 0 báo nhầm ngoài 9 file kể trên. File **300 MB** (cache OS đã ấm): không ký **~100 ms**; đã ký, chữ ký còn nguyên (so toàn bộ tiền tố) **~200 ms**; bản mới lệch sớm **~100 ms** (so sánh dừng ngay). Xấp xỉ chi phí ghi chính file đó.
- **Đã thử cho đỏ — 12 đột biến tạm trên file đang ship, cả 12 làm test đỏ:** bỏ vùng chồng giữa hai khúc · chỉ nhận một quy ước dấu · so thiếu một byte · đáp án lạ thành ghi đè · bỏ kiểm ruột hex · bỏ cổng ở từng handler (2) · ghi trước khi xét câu trả lời · nút mặc định thành "Vẫn ghi đè" · `copy` không quay lại hộp Lưu thành · `saveDoc` bỏ nhánh `canceled` · `loss` luôn false. (Bẫy của chính phép đo: cây làm việc là **CRLF** (`autocrlf`), nên chuỗi đột biến nhiều dòng với `\n` không khớp — viết đột biến trên **một dòng**.)
- **Còn mở / chưa kiểm:**
  - **Chưa bấm tay hộp thoại thật trong Electron** — main không chạy được trong node nên test chỉ ghim cấu trúc bằng regex. Ca phải bấm: mở `signed_verified.pdf` (corpus) → xoay trang → Ctrl+S → ba nút; xem bảng §5.
  - ~~`file:write-new-pdf` chưa có cổng~~ — ĐÃ CÓ Ở BI-135.
  - **Lưu thành ra file MỚI** từ tài liệu vốn đã ký thì **không** cảnh báo "bản sao này không còn chữ ký hợp lệ" (file gốc vẫn nguyên, nhưng bản sao mang chữ ký hỏng đi tiếp).
  - **Nghi, chưa đo:** ký số **lần thứ hai** (F3, `signing-worker.js` nạp rồi `pdfDoc.save({useObjectStreams:false})`) có thể phá chữ ký thứ nhất — cùng một lỗi, ở đường ký thay vì đường lưu.
  - Chưa có trọng tài mật mã độc lập; chỉ nói được "byte được ký còn nguyên".
- **Vỡ khi:** thêm đường ghi PDF ở main mà không qua `guardWrite`; đặt `writeFile` trước các nhánh rẽ; đổi thứ tự nút hoặc `defaultId` mà không đổi bảng ánh xạ; "sửa" điều kiện `<…>`/hex cho dễ nhận hơn (sẽ đếm cả 3 chữ ký đã vỡ và hỏi người dùng vô cớ); biến lỗi đọc file thành chặn lưu; đọc cả file đích vào RAM.

### BI-128 · Lõi ghi nối (incremental) — chốt 2 của "đừng phá chữ ký", và nó phải FAIL-CLOSED
- **Phạm vi: chỉ một hàm** — `src/pdf/incremental.py` · `append_revision(original, edited, out)`. **Chưa có route, chưa nối vào app** (chốt 3, 4): chưa đổi hành vi nào của app. Nhận file gốc (như đang nằm trên đĩa) và bản pdf-lib vừa dựng lại sau khi sửa; tạo ra *file gốc + một revision* chứa đúng những object khác nhau. Nối vào CUỐI file không đụng tới các byte trong `/ByteRange`, nên chữ ký còn nguyên — và đúng là điều kiện mà cổng BI-127 (`signed-scan.js`) kiểm, nên chốt 4 đi qua cổng mà không cần sửa gì.
- **Vì sao "so rồi nối" khả thi:** pdf-lib giữ nguyên SỐ HIỆU mọi object đã có và cấp số mới từ `max + 1`, nên object số `x` ở hai file là cùng một vật; khác nhau ⇒ nối. **Đo (lưới quét 1.104 file, pdf-lib xoay trang 1 → nối → qpdf):** **958 file ok, 0 lỗi thật**; trung vị **804 byte** thêm cho mỗi lần nối; 7/7 file ký thật giữ vùng ký (đường lưu cũ: 0/7).
- **FAIL-CLOSED — khác hẳn cổng BI-127 (fail-OPEN).** BI-127 chỉ là lời nhắc nên lỗi đọc ⇒ cho ghi. Ở đây một file nối sai mà trông như thành công — trên đúng loại file người ta ký để chứng minh nó không bị sửa — là thứ không được phép xảy ra. Mọi điều không chắc ⇒ `IncrementalRefused(reason)` với một lý do TRONG `REASONS`; người gọi lùi về đường cũ + cảnh báo. 103/1.104 file bị từ chối (xem "Số đo"). Test ghim: `REASONS` không được chứa lý do mà không chỗ nào raise (`slot_mismatch` từng như vậy sau khi bị gỡ).
- **Luật:**
  1. **Object chữ ký (`/ByteRange`, `/Type /Sig`, `/FT /Sig`) mà khác đi ⇒ từ chối.** So theo KHOÁ để một cách viết khoảng trắng khác không bị coi là "chữ ký bị đổi".
  2. **Bỏ qua mọi `/ObjStm` và `/XRef` phía `edited`; `edited` đặt object THƯỜNG lên số đang là kho của `original` ⇒ từ chối.** pdf-lib cấp kho mới ở các số TRÙNG số kho đang chứa object sống của gốc (160F-2019: 543–546); chép kho ⇒ qpdf "supposed object stream is not a stream".
  3. **Stream: ghi dữ liệu, rồi đặt lại NGUYÊN VĂN từ điển bằng `update_object`.** `update_stream` XOÁ `/Filter` và `/DecodeParms` (mupdf coi dữ liệu đưa vào là CHƯA nén) ⇒ chữ mới biến mất, JPEG thành rác. **KHÔNG đặt lại từng khoá bằng `xref_set_key`:** khoá kiểu `string` mất dấu ngoặc qua `xref_get_key` (`./states.pdf`) nên hoặc ném "invalid key in dict" (`tracemonkey`, `PTEX.FileName`) hoặc — tệ hơn — ghi sai lặng lẽ.
  4. **So hai object (`_same_content`):** stream bỏ qua `/Length` (gốc ghi `674 0 R` gián tiếp, pdf-lib ghi `1013` — không có điều này, xoay MỘT trang trên `tracemonkey` nối **+778 KB**, 348/350 object; có thì **777 B**); từ điển bằng nhau nếu **cùng khoá và cùng (KIỂU, giá trị)** HOẶC **văn bản y hệt** — hai cách sai theo hai hướng không liên quan (khoá: nhạy định dạng của từ điển lồng; văn bản: nhạy THỨ TỰ khoá, mà MuPDF ghi `/Type` lên đầu còn pdf-lib để cuối), nên "một trong hai" không thể bằng nhầm; object KHÔNG phải từ điển (mảng, số) phải so văn bản vì `xref_get_keys` trả rỗng. Giữ cả KIỂU: số `5` và chuỗi `(5)` in ra cùng là `5`.
  5. **Ba tầng tự kiểm, và tầng cuối mới là tầng quan trọng:** (a) sau `_apply`, đọc từ bộ nhớ (`apply_failed`); (b) tiền tố byte y hệt gốc (`prefix_changed`); (c) **MỞ LẠI file kết quả** — không bị "sửa chữa", số trang và hướng từng trang khớp `edited`, và **từng object đã ghi đọc lại TỪ ĐĨA** (`verify_failed`). Lý do (c): `issue5896` có từ điển font với khoá **tên rỗng** (`/ 15 0 R`) — khớp hoàn toàn trong bộ nhớ, nhưng MuPDF ghi ra đĩa `/15 0 R` (đọc lại là tên "15") và qpdf kêu "expected dictionary key". Chỉ đọc lại từ đĩa mới thấy. Cũng nhờ (c) mà 3 file có xref hỏng sẵn (qpdf: "file is damaged") bị từ chối thay vì cho ra file mà người đọc lặng lẽ bỏ qua phần nối.
  6. **Chỉ "vắng mặt" khi PyMuPDF báo đúng hai thông điệp ô trống** (`bad xref`, `cannot find object in xref`). Mọi lỗi đọc khác ⇒ `unreadable_object`. Nuốt chúng thành "vắng mặt" là bỏ rơi lặng lẽ một object đang được tham chiếu.
  7. **Ghi qua `.part` rồi `os.replace`:** `out_path` hoặc là kết quả ĐÃ kiểm xong, hoặc không tồn tại. Thất bại/từ chối không để lại file dở.
  8. **Tái dùng ô trống của bảng xref gốc được phép, và được ĐẾM (`reused`).** Bản đầu từ chối ca này (`slot_mismatch`) và chặn nhầm file ký thật `prefilled_f1040`. Đo bằng file dựng tay có ô được LIỆT KÊ trống với gen=1: PyMuPDF ghi với gen 0, tham chiếu `3 0 R` vẫn tới được, qpdf mã 0.
  9. **Hai file giống hệt ⇒ KHÔNG tạo revision rỗng** (PyMuPDF còn từ chối nối khi không có gì đổi); kết quả là bản sao nguyên văn.
  10. **KHÔNG dùng cho ẩn trang / redaction.** Ghi nối giữ MÃI byte cũ, mà BI-74/BI-91 bắt chúng xoá thật. Chính sách đó thuộc người gọi (chốt 4), không thuộc lõi.
- **Số đo — `tools/corpus_sweep_incremental.py` (1.104 file, ~73 s, 6 luồng):** 958 ok · 83 `refused:repaired` (file méo mà MuPDF phải sửa xref — corpus cố tình chứa) · 33 `broken_input` · 10 `pdflib_fail` · 6 `unreadable_object` (object stream hỏng) · 4 `container_collision` (kho **XRef** của file dùng xref stream bị pdf-lib dùng lại số — nới được nếu sau này đo thấy cần) · 4 `verify_failed` · 3 `apply_failed` (`saveIncr`: file không có trang) · 2 `not_pdf` · 1 `encrypted`. Mốc: **958 ok / 0 lỗi thật** — CHƯA có file baseline (lõi chưa có route); so bằng mắt cho tới khi có. Lưới thoát 1 nếu có `output_worse` / `prefix_changed` / crash / timeout / ngoại lệ lạ.
- **Đã vấp lúc làm — mỗi cái do lưới hoặc test bắt, không phải đọc code:** `xref_set_key` (tracemonkey) · `/Length` gián tiếp (+778 KB) · khoá tên rỗng (issue5896) · so văn bản làm 5/7 file ký thật bị từ chối oan vì thứ tự khoá · tên hàm `xref_get_keylist` không tồn tại (là `xref_get_keys`) · ô trống báo `RuntimeError` chứ không phải `ValueError`.
- **Bẫy của chính phép đo (dễ vấp lại):**
  1. **`tools/pdflib_rotate.js` PHẢI áp bản vá BI-120** (`applyStreamLengthFix`) như app thật nạp ngay sau pdf-lib. Không có, cả họ `tracemonkey*` ra khỏi pdf-lib với `/Length` cụt một byte và lưới đổ cho lõi một cảnh báo qpdf nó không gây ra.
  2. **Đừng sửa mã trong lúc lưới đang quét:** mỗi tiến trình con nạp module ở một thời điểm khác nhau ⇒ kết quả là hỗn hợp nhiều phiên bản (đã bỏ một lượt vì vậy).
  3. **Windows khoá file đang mở:** test dùng `with fitz.open(...)`, nếu không `TemporaryDirectory` không xoá được.
  4. MuPDF ghi `/ByteRange[0 10 20 30]` KHÔNG có dấu cách — đừng so chuỗi có dấu cách.
  5. Cây làm việc là CRLF (`autocrlf`) — đột biến test phải nằm trên MỘT dòng.
- **Đã thử cho đỏ — 18 đột biến tạm trên file đang ship, cả 18 làm test đỏ.** Lượt đầu lọt 3: **M11** do chính chuỗi đột biến gõ sai; **M17** (verify không so dữ liệu stream thô) và **M18** (object không phải từ điển bỏ so văn bản) là **lỗ hổng thật của test** — đã thêm `test_verify_objects_catches_each_kind_of_mismatch` và `test_non_dictionary_objects_are_compared_by_text`. Phép kiểm `is_repaired` sau khi mở lại **chưa có đột biến** (không có cách dựng ca ép nó đỏ trong test).
- **Còn mở / chưa kiểm:**
  - **Chưa có route, tiến trình con, hạn giờ** (chốt 3) và **chưa nối vào `saveDoc`** (chốt 4). Đọc hai tài liệu lớn trong sidecar chưa được đo; theo BI-121 nên đi tiến trình con.
  - **Mới thử MỘT loại sửa: xoay trang 1.** Chưa thử thêm chú thích, điền form, chữ ký thứ hai.
  - **Chưa mở bằng Acrobat/Foxit**, chưa có trọng tài mật mã độc lập — chỉ nói được "byte được ký còn nguyên" và "qpdf sạch".
  - **Sidecar:** `api.py` chưa import lõi nên bản sidecar hiện tại KHÔNG thiếu gì, nhưng `check-sidecar-fresh` kiểm theo đường dẫn `*.py` nên `/deploy` sẽ đòi rebuild cho tới khi chốt 3 nối route và rebuild một lần.
  - 4 ca `container_collision` trên kho XRef — file ký bằng xref stream có thể rơi vào đây; đo thêm trước khi nới.
- **Vỡ khi:** bỏ bước đọc-lại-từ-đĩa (c); đặt lại khoá stream bằng `xref_set_key`; so object bằng văn bản thuần (nối thừa, và từ chối oan file ký thật) hoặc bằng khoá thuần (bỏ lọt mảng/số); thêm lý do vào `REASONS` mà không raise; nuốt `RuntimeError` bất kỳ thành "ô trống"; cho phép ghi đè object chữ ký; đưa ghi nối vào đường ẩn trang/redaction; dùng lõi này mà không có tiến trình con + hạn giờ (chốt 3).

### BI-129 · Route ghi nối + tiến trình con + hạn giờ — chốt 3 của "đừng phá chữ ký"
- **Phạm vi:** `POST /save-incremental-bin` (`api.py`), tiến trình con `sidecar.py --incremental-worker`, hạn giờ, lưới quét đi qua worker thật, file mốc. **Chưa nối vào app** (chốt 4): renderer chưa gọi route này, nên chưa đổi hành vi nào của người dùng. Lõi vẫn là BI-128; đây là phần BỌC.
- **AI ĐỌC FILE GỐC, AI GHI.** Renderer không giữ byte file gốc (giữ thêm một bản 400 MB là đúng cái bẫy `large-pdf-decode-oom`), nhưng file gốc VỐN ĐANG NẰM TRÊN ĐĨA — chính là file sắp bị ghi đè. Route nhận `original_path` (sidecar tự **đọc**), byte đã sửa đi ở thân request dạng nhị phân (BI-24/BI-49, như `/compress-bin`). **Sidecar KHÔNG BAO GIỜ ghi vào file của người dùng:** nó trả byte đã nối, và đường ghi vẫn là `file:write-pdf` ở main — nơi cổng BI-127 kiểm LẠI rằng kết quả giữ nguyên vùng ký trước khi chạm đĩa. Nghĩa là cổng BI-127 là lớp kiểm ĐỘC LẬP: dù sidecar nói dối hay file gốc bị đổi giữa lúc ta làm, ghi đè sai vẫn bị bắt. Test ghim điều này: kết quả của route đi qua `signed-scan.js` thật mà không bị hỏi, còn bản pdf-lib dựng lại thì bị hỏi (`test_route_result_passes_the_js_signature_gate_but_a_rewrite_does_not`).
- **`original_path` bị siết** vì do renderer đặt: tuyệt đối, đuôi `.pdf`, là file thường. Route chỉ trả về thứ lõi đã chứng minh là PDF hợp lệ nối với byte của chính người gọi; file không phải PDF bị `not_pdf` từ chối và không byte nào của nó đi ra. Mọi route nằm sau token per-launch.
- **MỘT DẠNG TRẢ LỜI CHO MỌI THẤT BẠI CÓ CHỦ ĐÍCH:** `{"success": false, "refused": true, "reason", "detail"}` với HTTP **200** (như `cancelled` của `/compress-bin`: hợp đồng là "JSON = không có PDF"). Từ chối của lõi, hết giờ, worker chết, không khởi động được, file gốc biến mất — với người gọi đều nghĩa là "lùi về đường lưu cũ + cảnh báo", nên chung một nhánh. **Chỉ yêu cầu SAI mới là HTTP 400** (thiếu đường dẫn, không tuyệt đối, không `.pdf`, thân rỗng, quá 1 GB). Từ vựng `reason` là đóng kín: `REASONS` của lõi ∪ `WORKER_REASONS` (`timeout`, `worker_unavailable`, `worker_failed`, `original_missing`); một lý do lạ từ stderr của worker bị ép về `worker_failed`. Thành công: thân LÀ PDF, số liệu ở header (`X-Changed`, `X-Added`, `X-Reused`, `X-Original-Size`, `X-Result-Size`, `X-Unchanged: 1`) — **mọi tên phải nằm trong `expose_headers` của CORS**, nếu không renderer đọc ra `null` mà không báo lỗi (test ghim).
- **KHÔNG CÓ NHÁNH "CHẠY LÕI TẠI CHỖ"** khi không khởi động nổi worker — khác `_compress_anywhere`, nơi mất tính năng nén tệ hơn một rủi ro segfault hiếm. Ở đây mất ghi nối chỉ có nghĩa là lùi về đường cũ, còn segfault tại chỗ giết cả sidecar đang phục vụ mọi tab. Fail-closed: không chắc ⇒ không làm. (Test gài bẫy: nếu ai thêm nhánh đó, lõi chạy trong tiến trình và test đỏ.)
- **Hợp đồng cha–con nằm MỘT chỗ** — `src/pdf/incremental.py` (module lá, nạp `collections/logging/os/shutil/tempfile`, `fitz` nạp lười, KHÔNG `import api`): `WORKER_FLAG`, `EXIT_OK=0`, `EXIT_INTERNAL=1`, `EXIT_REFUSED=5`, `INCREMENTAL_TIMEOUT_S`, `meta_path`, `worker_main`. `sidecar.py` chỉ là bộ phân loại ba dòng, xử lý cờ TRƯỚC `argparse` và TRƯỚC `import api`. `api.py` so mã thoát với `_incremental_core.EXIT_*`, không bao giờ với số cứng (test ghim). stdout của worker luôn TRỐNG; số liệu đi qua `<ra>.meta.json` ghi SAU khi `<ra>` đã `os.replace` xong; lý do từ chối đi qua stderr dạng `lý_do<TAB>chi_tiết`.
- **HẠN GIỜ 120 s — suy từ số đo, không từ cảm giác** (tiến trình sạch, đúng lệnh worker, 2026-11-22):

  | ca | thời gian | RAM đỉnh worker |
  |---|---|---|
  | 256 MB, 1.500 trang, stream lớn | 2,0 s → **1,4 s** sau đường tắt | 70 MB |
  | 30 MB, 300 trang | 0,37 s | 65 MB |
  | 9 MB, **100.000 object** nhỏ | 15,3 s → **2,7 s** | — |
  | 28 MB, **300.000 object** nhỏ | 46,7 s → **8,1 s** | — |

  **Chi phí theo SỐ OBJECT chứ không theo byte** (~153 µs/object trước, ~27 µs sau), nên KHÔNG suy được hạn giờ từ dung lượng — y như nén ở BI-123. RAM của worker gần như không đổi theo cỡ file (PyMuPDF mở từ đường dẫn, ta so từng stream một); phần nặng nằm ở TIẾN TRÌNH CHA (giữ bản đã sửa + đọc kết quả, cỡ 2× file, y hệt `/compress`). 120 s ≈ 15× ca tệ nhất đã đo: máy chậm gấp ba hay ổ đĩa bị quét virus vẫn không chạm. Chạm tới là file bệnh lý, và quá hạn **không mất dữ liệu** — người gọi lùi về đường lưu cũ. Test ghim: hằng số phải nằm trong [60, 600] s.
- **ĐƯỜNG TẮT TRONG `plan_changes`** (làm vì số đo trên): loại sớm object y hệt bằng MỘT phép so văn bản + dữ liệu thô, và chỉ hỏi `/Type` khi văn bản chứa `ObjStm`/`XRef` (tiền lọc rẻ, vẫn xác nhận bằng `_type_of`). **Chứng minh tương đương, không đoán:** so kế hoạch của lõi CÓ và KHÔNG có đường tắt trên **cả 958 file ok** của corpus — 956 giống hệt; 2 file (`bug1885505`, `quadpoints`) chỉ khác ở chỗ bản chậm nối THỪA 3 object, vì file gốc viết `/XStep 10.0` còn pdf-lib viết `/XStep 10` (văn bản in ra y hệt, dữ liệu thô y hệt, là cùng một số). Đường tắt không bao giờ thêm một object mà bản chậm không thêm. Nó cũng làm 2/3 đột biến mới của lõi (M19–M21) đỏ.
- **Lưới quét đi qua WORKER THẬT** (`tools/corpus_sweep_incremental.py`, KHÔNG gọi lõi tại chỗ nữa) nên hợp đồng mã thoát/stderr/meta cũng được quét; `--exe <sidecar.exe>` chạy cùng lưới trên BẢN ĐÓNG GÓI (argv của bản frozen khác bản dev — chỗ BI-54 từng vấp); có `--update-baseline` và mốc `tools/corpus-baseline-incremental.json` như hai lưới kia (so ra khác mốc = hồi quy, kể cả đổi lý do từ chối). Lượt quét dev: **958 ok · 0 lỗi thật · 86 s**, từng file giống hệt lượt quét lõi tại chỗ trước đó.
- **Đã vấp lúc làm (mỗi cái do chạy thử hoặc test bắt):** `api.py` **không có `import json` ở mức module** (chỉ nạp cục bộ trong một hàm) ⇒ `json.load` ném `NameError` và ĐƯỜNG THÀNH CÔNG hỏng ở lần chạy đầu · tài liệu giả `FakeDoc.mk` in số `5` và chuỗi `(5)` thành CÙNG văn bản nên đường tắt che mất khác biệt kiểu (sửa tài liệu giả cho trung thực, không nới đường tắt) · công cụ quét in tiếng Việt nên chết ở dòng đầu trên console cp1252 · **script sửa file bằng `str.replace` lặng lẽ KHÔNG áp 2 chỗ** vì chuỗi `\n` thoát sai — luôn `assert old in s` trước khi `replace`.
- **Đã thử cho đỏ.** Lõi: 21 đột biến (18 của BI-128 + 3 nhắm đường tắt), cả 21 đỏ. **Phần bọc: 18 đột biến, cả 18 đỏ** — lượt đầu lọt 2, đều là lỗ hổng thật của test: **R9** (route ném 500 thay vì `refused`: không test nào đi vào nhánh `except Exception` chung) và **W5** (worker bỏ kiểm số tham số: test chỉ so mã thoát `1`, mà một lỗi Python không bắt cũng thoát mã 1 — phải kiểm thông điệp có chủ đích và KHÔNG có traceback). Đã thêm `test_an_unexpected_exception_in_the_route_is_a_refusal_not_a_500` và siết `test_worker_exit_code_contract`. Bẫy của phép đo: `str.replace` mặc định thay lần xuất hiện ĐẦU — `proc.kill()` và `shutil.rmtree` cũng có ở khối nén BI-126, nên đột biến phải nhắm lần xuất hiện CUỐI (khối BI-129 nằm sau).
- **Đã quét BẢN ĐÓNG GÓI** (sidecar dựng từ `7b38f154`, sạch): `--exe` trên 1.104 file = **958 ok / 0 lỗi thật**, cùng phân bố với worker dev, không xấu đi so với mốc; worker chậm nhất 2,8 s. Bẫy: `--exe` đường tương đối làm 1.104 file `FileNotFoundError` (công cụ chạy tiến trình con ở thư mục khác) — dùng đường tuyệt đối. Sửa công cụ này sẽ làm `check-sidecar-fresh` đòi build lại (`*.py` khớp mọi thư mục), nên để dành cho lần build sau.
- **Còn mở / chưa kiểm:**
  - ~~Chưa nối vào `saveDoc`~~ → ĐÃ NỐI ở BI-130 (chốt 4). Cũng chưa có chính sách "khi nào gọi route này": ẩn trang / redaction (BI-74/BI-91) PHẢI đi đường ghi lại toàn bộ, không đi đường nối.
  - **Tiến trình cha giữ ~2× cỡ file** (bản đã sửa + kết quả) — chưa đo trên file vài trăm MB thật qua HTTP; cùng cấu hình với `/compress-bin`.
  - **Mới thử MỘT loại sửa** (xoay trang 1). Chưa thử thêm chú thích, điền form, chữ ký thứ hai.
  - **Chưa mở bằng Acrobat/Foxit**, chưa có trọng tài mật mã độc lập.
  - Không có nút Hủy cho việc này (khác nén): một lần lưu dài vài giây, hạn giờ 120 s là đủ.
- **Vỡ khi:** thêm nhánh "chạy lõi tại chỗ" khi worker không khởi động; để sidecar ghi vào file của người dùng; trả 500 hoặc một dạng JSON thứ hai cho một thất bại có chủ đích; hạ `INCREMENTAL_TIMEOUT_S` sát số đo; đặt lại số mã thoát ở một nơi thứ hai; quên thêm tên header mới vào `expose_headers`; để `sidecar.py` import `api` trước khi xử lý cờ worker (mỗi lần lưu chậm thêm ~0,4 s); thêm một `import` nặng vào `src/pdf/incremental.py` (module lá phải nhẹ); "tối ưu" `plan_changes` mà không so lại kế hoạch trên cả corpus.

### BI-130 · "Lưu nối thêm" cho file đã ký — nối lõi BI-128/129 vào Ctrl+S (chốt 4 của "đừng phá chữ ký")

- **Hành vi.** Ctrl+S lên một file ĐÃ KÝ mà bản mới sẽ phá vùng ký ⇒ hộp BI-127 nay có thêm nút đầu (mặc định) **"Lưu nối thêm (giữ chữ ký)"**; bấm ⇒ main gọi sidecar `/save-incremental-bin`, kiểm lại kết quả bằng chính cổng BI-127, rồi ghi. Thành công ⇒ toast "Đã lưu nối thêm (giữ vùng ký)". Mọi thất bại ⇒ hộp hỏi LẠI với ba nút cũ kèm lý do bằng tiếng Việt; **không bao giờ tự ghi đè**.
- **Ở main, không ở renderer** (`desktop/src/signed-save.js`, thuần, tiêm được): byte tài liệu đã qua IPC tới main một lần để ghi, gọi sidecar từ đó không thêm lần chép nào; hộp thoại cũng ở đó; và giữ được "sidecar không bao giờ ghi file người dùng". HAI LỚP kiểm độc lập: lõi Python tự kiểm (BI-128) và cổng JS kiểm lại tiền tố (BI-127) — một trong hai sai thì lớp kia vẫn chặn.
- **Chính sách ẩn trang / redaction (BI-74/BI-91): KHÔNG được nối.** Ghi nối giữ MÃI byte cũ, mà bôi đen/ẩn trang sinh ra để huỷ chúng. `state.contentRemoved` (app.js) là cờ **chỉ tăng**: đặt khi nướng redaction (`bakePending`), khi ẩn trang thành công, và khi khôi phục sau sự cố (không biết phiên đã mất làm gì); chỉ `loadBytes` hạ. `saveDoc` gửi `contentRemoved: !!(cờ || vaultPages.size)`; preload gửi `true` trừ khi `opts.contentRemoved === false`; main chỉ mở đường nối khi `=== false` VÀ sidecar `ready` VÀ có cổng. **Thiếu thông tin = đóng**, không phải mở.
- **Cái giá phải nói thật** (có trong hộp thoại): ghi nối giữ vùng ký nguyên byte nhưng trình đọc PDF vẫn có thể báo "đã sửa sau khi ký"; và nội dung người dùng đã xoá (trang xoá…) vẫn còn trong lịch sử file. Xoá trang KHÔNG bị chặn (không phải redaction) — chỉ được cảnh báo.
- **Thiết kế hộp.** `askSignedOverwrite` ánh xạ nút→hành động qua MỘT mảng khoá `keys` (4 hoặc 3 phần tử, Huỷ luôn cuối), dùng cho cả `buttons` lẫn kết quả; nút lạ ⇒ `cancel`. Nút đầu luôn là nút KHÔNG phá chữ ký (`defaultId: 0`). `dialog:save-pdf` (Lưu thành) KHÔNG đề nghị nối: ở đó không có "file gốc" để so.
- **Đã thử cho đỏ.** 34 đột biến lên `signed-save.js`, `main.js`, `preload.js`, `app.js`, `editor-bake.js` — cả 34 đỏ. Bốn ca đầu chỉ "đỏ" vì TREO quá 90 s (vòng hỏi lặp vô hạn, hạn giờ client, thiếu cổng) — chưa tính là bắt được; đã sửa test (ask giả tự huỷ sau 5 lần, `within()` quanh lệnh gọi mạng) để chúng ĐỎ NGAY có tên. Bẫy: vòng `await` vô hạn chỉ dùng microtask nên timer không cứu được. `print` tiếng Việt ra console cp1252 làm script đột biến chết SAU khi chạy xong (mất kết quả, file vẫn khôi phục) — đặt `PYTHONIOENCODING=utf-8`.
- **Ghim BI-127 phải cập nhật** (`signed-scan.test.js` §3): `file:write-pdf` nay gọi `SignedSave.planSignedWrite(` thay vì `SignedScan.guardWrite(` trực tiếp; `cancelId`/ánh xạ nút đi qua `keys`. Ý định các ghim giữ nguyên (cổng trước lệnh ghi, nút an toàn mặc định, nút lạ ⇒ huỷ); phần chạy thật nằm ở `signed-save.test.js` §3 (cắt nguyên văn `askSignedOverwrite` và handler `file:write-pdf` ở main.js, chạy với file thật + cổng thật + sidecar giả).
- **ĐÍNH CHÍNH sau khi thử bằng Foxit thật (BI-131/134):** nhãn ban đầu "Lưu nối thêm (giữ chữ ký)" NÓI QUÁ. Với sửa trang (xoay, thêm chữ, xoá trang) Foxit báo chữ ký **KHÔNG HỢP LỆ** ("2 Page(s) Modified, 1 Page(s) Deleted"); ghi nối chỉ giữ **bản đã ký gốc còn nguyên và xem lại được**. Đã sửa: nhãn thành **"Lưu nối thêm (giữ nguyên bản đã ký)"**, lời trong hộp nói rõ có thể bị báo KHÔNG HỢP LỆ (đã quan sát ở Foxit) và bản đã ký xem lại được; toast "Đã lưu nối thêm (giữ nguyên bản đã ký)". Ghi nối vẫn tốt hơn ghi đè (Foxit báo "Error during signature verification" — mất hẳn chữ ký), và vẫn là đường ĐÚNG cho thay đổi được phép (thêm chữ ký — BI-133).
- **Còn mở / chưa kiểm:**
  - **CHƯA bấm tay trên Electron thật** (hộp 4 nút, nối thật qua sidecar đóng gói, toast). Test chỉ chạy được tới ranh giới `dialog`.
  - **Mới thử MỘT loại sửa ở tầng lõi** (xoay trang 1) và chưa mở kết quả bằng Acrobat/Foxit: "vùng ký còn nguyên byte" là điều kiện cần cho digest chứ chưa phải bằng chứng Acrobat coi chữ ký còn hợp lệ (DocMDP, khoá trường).
  - Mỗi lần Ctrl+S sau đó trên cùng file ký lại hiện hộp (renderer giữ bản pdf-lib, đĩa là bản đã nối) — an toàn, hơi phiền; chưa nhớ lựa chọn theo tài liệu.
  - ~~`writeFile` đè thẳng lên file ký~~ — ĐÃ SỬA Ở BI-136 (ghi tạm + fsync + đổi tên).
  - Lưu thành bản MỚI từ tài liệu đã ký vẫn không cảnh báo là bản sao mất chữ ký (`file:write-new-pdf` đã có cổng ở BI-135).
  - Renderer không có chỉ báo tiến độ trong lúc chờ sidecar (thường vài giây; trần 120 s ở sidecar, 150 s ở client).
- **Vỡ khi:** đường nối mở khi `contentRemoved` không phải `false` rõ ràng; thêm một thao tác xoá-thật mà không đặt cờ; ghi `data` thô thay vì `plan.data`; ánh xạ nút dùng chỉ số cứng; tin kết quả của sidecar mà bỏ lớp kiểm tiền tố ở main; nối khi sidecar chưa sẵn sàng.

### BI-131 · Chốt 5 của "đừng phá chữ ký": thử đầu-cuối trên file ký THẬT, có trọng tài mật mã độc lập

Không đổi hành vi — thêm **bằng chứng** cho BI-127…130 và các công cụ để lặp lại nó. Mọi thứ dưới đây chạy được lại bằng ba lệnh ở "Chạy lại".

- **Trọng tài độc lập** `tools/verify_pdf_signatures.py`: đọc `/ByteRange` + `/Contents`, nhờ **OpenSSL** (`cms -verify -noverify`) kiểm băm ByteRange == `messageDigest` và chữ ký toán học đúng. **Đã chứng minh trọng tài biết nói "hỏng"** (không chỉ biết nói "tốt"): file ký thật ⇒ HỢP LỆ; lật 1 byte TRONG vùng ký ⇒ HỎNG; làm hỏng ô `/Contents` ⇒ HỎNG; nối thêm byte SAU vùng ký ⇒ vẫn HỢP LỆ (chính tính chất mà ghi nối dựa vào). `-noverify` bỏ qua chuỗi tin cậy (chứng thư thử là tự ký) nên "hợp lệ" = "byte được ký chưa đổi + chữ ký toán đúng", **không** = "chứng thư đáng tin" và **không** xét phần nối sau vùng ký (DocMDP / khoá trường / "đã sửa sau khi ký" — đó là chuyện của Acrobat/Foxit).
- **Vì sao không dùng corpus pdf.js làm nền**: `signed_verified.pdf` (file duy nhất ta tưởng là "đã xác minh") **KHÔNG hợp lệ theo OpenSSL ngay ở bản gốc** — fixture của pdf.js không giữ chữ ký toán đúng. Nên nền là file ta tự ký: `tools/signed_fixture.js` ký bằng ĐÚNG đường của app (`pdflibAddPlaceholder` + `signpdf.sign`, lưu không object stream, như `signing-worker.js`), chỉ thay Signer token USB bằng OpenSSL + chứng thư tự ký dùng-một-lần; "bản đã sửa" = pdf-lib **vendor của renderer** + bản vá BI-120 mở file đã ký → sửa → `save()` mặc định (có object stream), như `state.bytes` thật.
- **Lõi, 12 ca, CẢ worker dev lẫn `sidecar.exe` đóng gói** (`tools/signed_e2e.py [--exe tuyệt_đối]`): xoay trang, thêm chữ, vẽ hình, chèn ảnh, đổi tiêu đề, thêm trang, xoá trang, điền form (ô nhập + tick), nhiều thao tác, **lưu lần hai** lên chính kết quả đã nối, **lưu lại y hệt**, nội dung đã xoá còn trong lịch sử. Mọi ca: OpenSSL HỢP LỆ, file bắt đầu bằng ĐÚNG mọi byte file ký, `qpdf --check` mã 0, và PyMuPDF thấy số trang / góc xoay / chữ / giá trị form / tiêu đề **y hệt bản đã sửa**. Phình thêm 271 B–1,8 KB trên file 22 KB; lưu lại y hệt = **+0 B** (`unchanged`). Đối chứng: bản pdf-lib viết đè (đường cũ) **không còn chữ ký nào trong file** — nếu nó vẫn hợp lệ thì phép thử vô giá trị. **0 từ chối** trên bộ này (từ chối chỉ gặp khi file gốc hỏng cấu trúc, xem S6).
- **App Electron thật, 6 kịch bản** (`desktop/scripts/probe-signed-save.js`, 3/3 lần chạy xanh): renderer thật (`rotateSelected` → `saveDoc`) → preload → main thật → HTTP thật tới sidecar thật → ghi đĩa thật → OpenSSL kiểm file vừa ghi. S1 nối thành công (hộp 4 nút, nút đầu mặc định, toast "Đã lưu nối thêm", OpenSSL hợp lệ, +916 B); S2 Ctrl+S lần hai (+0 B); S3 `contentRemoved` ⇒ hộp 3 nút, Huỷ ⇒ đĩa y nguyên; S4 Huỷ dừng hẳn; S5 "bản sao" ⇒ mở hộp Lưu thành; S6 sidecar từ chối ⇒ hộp hỏi LẠI 3 nút kèm lý do. **Đã thử cho đỏ:** phá preload cho luôn gửi `contentRemoved: false` ⇒ S3 đỏ 4 ca (và đáp án "Huỷ" của hộp 3 nút thành "Vẫn ghi đè" trên hộp 4 nút — đúng cảnh tượng mất file mà cờ này sinh ra để chặn).
- **Hộp thoại native KHÔNG được bấm thật**: probe nối vào main qua `--inspect` và thay `dialog.showMessageBox`/`showSaveDialog` bằng hàm ghi lại tuỳ chọn + trả đáp án đặt trước. Thử thật: nhãn/thứ tự/`defaultId`/`cancelId`, ánh xạ nút → hành động, mọi thứ sau đó. KHÔNG thử: hộp trông ra sao trên màn hình, phông, ngắt dòng của lời giải thích dài.
- **Bẫy của chính probe (đừng vấp lại).** (1) Chữ ký phủ tới HẾT file ký ⇒ làm hỏng cái đuôi của file là làm mất luôn chữ ký, và app coi đó là file KHÔNG ký (đúng) — muốn gây "sidecar từ chối mà chữ ký còn" thì phải NỐI một revision hỏng SAU vùng ký. (2) `state.contentRemoved` chỉ hạ ở `loadBytes`; một kịch bản đặt cờ rồi kịch bản sau tái dùng tài liệu ⇒ cờ rò, hộp thành 3 nút và đáp án số 1 thành "Vẫn ghi đè" ⇒ lần chạy đầu của S5 đỏ chập chờn vì vậy. Mỗi kịch bản phải mở tài liệu sạch (`state.dirty=false` trước `loadBytes`, kiểm `loadBytes` không trả `false`) và ĐẾM SỐ NÚT chứ không chỉ số hộp. (3) `ws` không cần: Node 22 có `WebSocket` toàn cục.
- **Đổi cổng `check-sidecar-fresh.js`**: thêm `":(exclude)tools/*"`. Không file nào trong bundle import `tools.*`, nhưng `"*.py"` khớp mọi thư mục nên mỗi lần thêm/sửa công cụ đo đòi dựng lại sidecar ~30 phút (và đã ép ta bỏ nguyên một lỗi công cụ ở BI-129). Nếu SAU NÀY mã trong bundle import từ `tools/` thì phải bỏ dòng loại trừ.
- **Chạy lại:** `node tools/signed_fixture.js <dir>` (dựng) · `.venv\Scripts\python tools/signed_e2e.py [--exe D:\…\sidecar.exe]` (12 ca lõi) · `cd desktop ; node scripts/probe-signed-save.js` (6 kịch bản app thật; cần cổng 9345/9346 trống). Cần `openssl`, `qpdf`, `node` ≥ 22.
- **VẪN CHƯA LÀM — đừng đọc BI-131 như "đã xác nhận Acrobat chấp nhận":**
  - **Foxit PDF Reader 2026.2.1.39815 — KẾT QUẢ ĐÃ QUAN SÁT (ảnh người dùng gửi, panel Digital Signatures; Acrobat Reader CHƯA mở):**
    · **file 5 và 6** (xoay 180° + thêm chữ + **xoá trang** + đổi tiêu đề, lưu nối thêm): Foxit báo **"Signature is invalid: The document has been altered or corrupted since the Signature was applied"** kèm cảnh báo **"2 Page(s) Modified", "1 Page(s) Deleted"** — dù OpenSSL xác nhận byte được ký KHÔNG đổi. Foxit phân tích revision và coi sửa/xoá trang là thay đổi KHÔNG được phép. **Đây là bản chất của việc sửa một file đã ký, không có cách nối nào tránh được**; cái ghi nối giữ được là *bản đã ký gốc còn nguyên và xem lại được* ("Click to view this version"), không phải chữ ký còn hợp lệ.
    · **file 7** (đối chứng, đường lưu cũ): "Error during signature verification… errors in the formatting or information contained in the signature" — chữ ký bị phá hẳn (ByteRange lỗi thời).
    · **file 8 (2 chữ ký) và 9 (5 chữ ký), KÝ NỐI THÊM:** mọi chữ ký đều **"The document has not been modified since this signature was applied"** — kể cả chữ ký 1 dù đã có chữ ký 2–5 nối sau (thêm chữ ký là thay đổi được phép). Trạng thái chung "Signature is unknown" chỉ vì danh tính người ký (chứng thư tự ký) không nằm trong danh sách tin cậy.
    · **file 1** (gốc): "Signature was not yet verified" → sau Validate "unknown"; dòng "Form Fields Filled In: dong_y" là do người dùng bấm ô tick trong Foxit (tab có dấu *), không phải lỗi của file.
    · **file 2** (CHỈ xoay trang, lưu nối thêm), sau khi bấm Validate: **"Signature is invalid: The document has been altered or corrupted since the Signature was applied" + "1 Page(s) Modified"** ⇒ một mình việc xoay đã đủ làm Foxit báo không hợp lệ.
    · **file 4** (CHỈ điền form: ho_ten + dong_y, lưu nối thêm): chữ ký **"unknown"** (KHÔNG phải invalid) kèm cảnh báo "Form Fields Filled In" và "Form Fields with Property Changes" ⇒ **điền form là thay đổi được phép**, chữ ký không bị phá. Dòng mô tả bị cắt ở "The revision of the document t…" (nên mở rộng panel để đọc đủ; trạng thái "unknown" thay vì "invalid" là bằng chứng chính).
    · **file 3** (CHỈ thêm chữ): ảnh chụp trước khi bấm Validate ("not yet verified") ⇒ **CHƯA có kết luận**. Suy luận (chưa kiểm): giống xoay, bị báo "Page(s) Modified".
    · **file 10** (5 người ký, tiếng Việt), sau Validate: mọi chữ ký đã thấy "has not been modified since this signature was applied" (rev 1–4 đọc được; rev 5 bị cắt khỏi ảnh). Cây chữ ký chỉ hiện CN của chứng thư ("E2E Signer N"), KHÔNG hiện Reason/Location ⇒ **chưa nhìn được chữ tiếng Việt trong Foxit** (cần Show Signature Properties).
    · **Hai ảnh có "tích vào ô" (file 2 và file 10, tab có dấu *):** đó là chỉnh sửa do CHÍNH Foxit làm trong bộ nhớ (chưa lưu), chụp TRƯỚC khi Validate ("not yet verified") ⇒ không phải kết quả của file do app tạo, **không dùng làm bằng chứng**.
  - **Chưa thử bản đóng gói đầy đủ** (electron-builder + cài đặt): mới thử **sidecar đóng gói** (`--exe`, cả 1.104 file corpus ở BI-129 lẫn 12 ca này) và app ở chế độ dev. Argv/đường dẫn/quyền của app đã cài chưa được thử.
  - Chứng thư **tự ký, không có dấu thời gian RFC3161, không PAdES/LTV (DSS), một người ký, ký vô hình**. Chữ ký thật từ token VNPT/Viettel/FPT (có TSA, có chuỗi, có thể có hình hiển thị) chưa thử; chữ ký có `/DocMDP` (chứng nhận) và khoá trường cũng chưa.
  - **ĐÃ ĐO — ký LẦN HAI bằng F3 (signing-worker) PHÁ chữ ký thứ nhất** (`tools/signed_double_sign.js`): pdf-lib dựng lại cả file nên file mới không bắt đầu bằng byte file đã ký; cả vùng đầu `[0:L1]` lẫn vùng đuôi `[C:C+L2]` của chữ ký 1 đã đổi ⇒ chỉ còn MỘT chữ ký hợp lệ (OpenSSL), dict chữ ký cũ còn trơ trong file với ByteRange lỗi thời. **Luồng ký không hề cảnh báo** (`sign.js` chỉ nhắc "đừng sửa rồi lưu đè" SAU khi ký; không đọc xem tài liệu đã có chữ ký). Với hợp đồng nhiều bên ký, đây là lỗ hổng sản phẩm thật, **cùng họ với BI-127 nhưng nằm ở đường KÝ chứ không phải đường LƯU**; chưa sửa. Hướng: (a) cảnh báo trước khi ký lên file còn chữ ký (nhỏ); (b) ký NỐI THÊM — thêm trường chữ ký + chữ ký như một revision (lớn, cần trọng tài như ở đây).
  - **Đo cỡ thật qua HTTP** (`tools/big_signed_fixture.js` + `tools/big_route_probe.py`): file ký **152 MB** (19 trang, ảnh không nén) → route trả trong **1,7 s (dev) / 1,9 s (sidecar.exe)**, RAM đỉnh cả cây tiến trình **272 / 292 MB** (≈ 1,9× cỡ file: cha giữ bản sửa + kết quả, worker ~65 MB), `X-Changed=2`, byte gốc nguyên, OpenSSL hợp lệ. Chưa đo ≥ 400 MB, và chưa đo phía main/renderer (mỗi nơi còn giữ thêm bản sao của tài liệu).
  - Các tồn đọng của BI-130 vẫn nguyên (`writeFile` không atomic, Lưu thành bản mới không cảnh báo, không có chỉ báo tiến độ, mỗi Ctrl+S sau đó lại hiện hộp).

### BI-132 · Cảnh báo trước khi KÝ lên tài liệu đã có chữ ký (đường KÝ của họ BI-127)

- **Lỗ hổng (đo ở BI-131).** `signing-worker.applySignature` mở file bằng pdf-lib rồi lưu lại TOÀN BỘ; ký lần hai lên file đã ký làm chữ ký 1 mất (cả vùng đầu `[0:L1]` lẫn vùng đuôi `[C:C+L2]` đổi byte; chỉ còn MỘT chữ ký hợp lệ theo OpenSSL) và luồng ký không nói gì. Hợp đồng nhiều bên ký = phá ngầm công sức của người ký trước.
- **Cổng.** `signing.js · declineIfSigned` chạy trong `sign:apply` TRƯỚC worker (nên hộp PIN của token không hiện): quét đúng các byte sắp ký (`payload.bytes`) bằng `SignedScan.findSignaturesInBuffer` (cùng luật nhận `/ByteRange` với `findIntactSignatures` của BI-127, bản bộ nhớ, `Buffer.indexOf` native). Còn chữ ký ⇒ main hiện hộp **Huỷ / Vẫn ký (mất chữ ký trước)**; nút đầu, mặc định và Esc đều là Huỷ. **Chỉ `"sign"` mới đi tiếp**; huỷ, hộp thoại ném lỗi, giá trị lạ ⇒ `{ok:false, reason:"declined"}`, worker không được gọi. Renderer coi `declined` là huỷ chứ không phải lỗi (toast thường, không đỏ — như "Đã hủy nén", BI-126).
- **Khi KHÔNG hỏi (đúng chủ ý):** tài liệu không có chữ ký; hoặc đã bị pdf-lib dựng lại (sửa rồi mới ký) — chữ ký cũ đã mất từ lúc SỬA chứ không phải lúc ký, và BI-127 lo chuyện đó ở lệnh Lưu. Chữ ký hợp lệ luôn nằm ở một object cấp cao (ByteRange phủ cả file thô) nên không bị giấu trong object stream; quét thô trên byte thật là đủ.
- **Hai bản quét phải đồng ý với nhau** (`signing-warn.test.js` §1): trên 18 file giả (cả hai quy ước `< >`, đệm đầu, phần nối sau vùng ký, ô giữ chỗ, ruột không phải hex, ô > 1 MiB, bị cắt cụt, rỗng) và trên 9 file corpus pdf.js có chữ `/ByteRange`. Luật dùng chung nên dễ trôi lệch; test này là chỗ canh.
- **Lối ra cho người dùng, nói thật trong hộp:** "muốn thêm chữ ký mà giữ chữ ký cũ, hãy ký bằng công cụ hỗ trợ ký nhiều lần (Acrobat/Foxit)". Từ BI-133 hộp này có thêm nút "Ký nối thêm" khi sidecar chạy (3 nút); lời hướng dẫn Acrobat/Foxit giữ lại cho dạng 2 nút.
- **Đã thử cho đỏ:** 22 đột biến (`signed-scan.js`, `signing.js`, `main.js`, `sign.js`) — cả 22 đỏ. Fixture ô > 1 MiB (và ô vừa dưới 1 MiB) được thêm TRƯỚC khi chạy bộ đột biến vì thấy luật `MAX_GAP` của bản bộ nhớ chưa có ca nào canh. **App thật** (`probe-signed-save.js` S7/S7b/S8): file ký ⇒ hộp 2 nút, Huỷ ⇒ `declined` mà token không bị gọi; "Vẫn ký" ⇒ vượt cổng (worker từ chối vì thumbprint giả — `no_cert`); tài liệu đã qua pdf-lib ⇒ không hộp nào.
- **Còn mở:** hộp native chưa bấm tay; (đường "ký nối thêm" đã làm ở BI-133); chưa quét chữ ký nằm sau một revision hỏng (hiếm); cảnh báo ở lúc SỬA một file ký (chứ không chỉ lúc Lưu/Ký) chưa có.
- **Vỡ khi:** gọi worker trước cổng; coi giá trị lạ/hộp lỗi là "sign"; quét `state.bytes` ở renderer thay vì `payload.bytes` ở main (có thể khác nhau); đổi luật nhận ByteRange ở MỘT trong hai bản quét.

### BI-133 · KÝ NỐI THÊM — thêm chữ ký thứ N mà giữ N−1 chữ ký trước (nút trong hộp "đã có chữ ký")

- **Hành vi.** Ký lên tài liệu còn chữ ký ⇒ hộp BI-132 nay có thêm nút đầu (mặc định) **"Ký nối thêm (giữ chữ ký trước)"**, kèm lời nói thật: trình đọc PDF sẽ ghi chú các chữ ký trước là "có thay đổi sau khi ký (thêm chữ ký)" — bình thường với tài liệu nhiều người ký. Hộp 3 nút khi sidecar đang chạy, nếu không thì 2 nút như BI-132. Ký xong vẫn đi qua hộp Lưu thành như mọi lần (chọn đúng đường dẫn file gốc thì cổng BI-127 thấy byte cũ nguyên ⇒ ghi thẳng).
- **Cách làm — tái dùng, không viết bộ dựng PDF thứ hai** (`desktop/src/sign-append.js`, thuần; `applyAppendSignature` ở `signing-worker.js`): (1) pdf-lib + `pdflibAddPlaceholder` dựng "bản đã thêm chỗ giữ chữ ký" — **hai chỉnh sửa bắt buộc**: ô `/Contents` phải là hex '0' THẬT (thư viện ghi NUL; lõi PyMuPDF đọc ra chuỗi rỗng và mất chỗ) và tên trường duy nhất (thư viện cứng `Signature1` ⇒ trùng trường của chữ ký trước); (2) lõi ghi nối BI-128/129 qua sidecar biến nó thành file gốc + MỘT revision (đã tự kiểm, fail-closed); (3) ở đây: tìm chỗ giữ chữ ký MỚI trong phần nối, điền `/ByteRange` (ba TÊN giữ chỗ 11 byte → số đệm khoảng trắng, độ dài file KHÔNG đổi), băm đúng `[0:L1]+[C:C+L2]`, ký, ghép chữ ký vào ô.
- **Điều phối định tuyến** (`signing.js · routeSigning`): "append" chỉ được chấp nhận khi sidecar `ready` có cổng; `mode:"append"` + `{port, token}` gửi cho worker. **Lỗi ghi nối xảy ra TRƯỚC PIN** (token chỉ được gọi ở bước ký cuối) nên an toàn để HỎI LẠI bằng hộp 2 nút kèm lý do (Vẫn ký / Huỷ); **lỗi ở/sau bước ký** (`cancelled/no_cert/tsa/other/sign_failed/bad_signature/signature_too_large`, danh sách ở `SignAppend.SIGN_STAGE_REASONS`, MỘT nguồn) báo thẳng — lùi về "Vẫn ký" sẽ hỏi PIN lần nữa. Chỉ thử nối MỘT lần (vòng hỏi tối đa 2).
- **Rào cản fail-closed** (`appendSign`): không có chữ ký ⇒ `not_signed`; **tài liệu chứng nhận `/DocMDP /P 1` ⇒ `docmdp_locked`** (cấm sửa; P=2/3 được; thiếu /P ⇒ 2 theo đặc tả; nhiều chữ ký ⇒ lấy mức NGHIÊM nhất); kết quả của lõi không bắt đầu bằng ĐÚNG byte đầu vào ⇒ `prefix_changed`; chỗ giữ chữ ký MỚI không nằm ở phần nối ⇒ `placeholder_missing`; chữ ký không vừa ô ⇒ `signature_too_large`; và kiểm lần cuối trên chính byte sẽ giao: còn nguyên byte cũ VÀ cổng BI-127 đếm được N+1 chữ ký.
- **Chữ ký nhìn thấy** (hình + khung) chạy qua cùng đường: `beforePlaceholder` từ chối trang xoay (`rotated`, như đường cũ), `afterWidget` gắn AP. Kiểm bằng PyMuPDF: widget `Signature2` ở đúng trang, đúng khung đã vẽ.
- **Bằng chứng.** Spike trước khi viết code (OpenSSL: CẢ HAI chữ ký hợp lệ). **JS:** `sign-append.test.js` 81 ca (hàm thuần + bộ điều phối giả + đường thật: pdf-lib + lõi Python + OpenSSL, chuỗi 4 người ký, mỗi bước N chữ ký HỢP LỆ/0 hỏng + qpdf mã 0 + đối chứng lật byte ⇒ HỎNG), `sign-append-worker.test.js` 23 ca (`applyAppendSignature` thật, vô hình + nhìn thấy + trang xoay + lỗi truyền qua), `signing-warn.test.js` 151 ca (định tuyến + hộp thoại, cắt nguyên văn từ main/signing). **Đột biến 41/41 đỏ** — lượt đầu lọt 2 (A5 lớp kiểm cuối, A7 vòng tìm ngược): đều là lỗ hổng TEST, đã thêm ca (2j: ô chữ ký > 1 MiB; 1b: /ByteRange thường nằm SAU chỗ giữ chữ ký). **Test bắt được một lỗi THẬT tôi vừa tạo:** `cancelId: keys.length - 1` làm Esc của hộp 2 nút trỏ vào "Vẫn ký" (đúng kiểu lỗi mà họ BI-130 cảnh báo); sửa thành `keys.indexOf("cancel")`. **E2E qua HTTP THẬT** (`tools/sign_append_e2e.js [--exe]`): 4 người ký liên tiếp (một người có hình hiển thị), **cả sidecar dev lẫn `sidecar.exe` đóng gói**: sau người ký k có ĐÚNG k chữ ký, tất cả hợp lệ theo OpenSSL, qpdf mã 0, tên trường duy nhất, ~0,3–0,5 s mỗi lần. **App Electron thật** (`probe-signed-save.js` S7–S7d): hộp 3 nút; Huỷ ⇒ `declined`; "Ký nối thêm" ⇒ pdf-lib + sidecar THẬT ghi nối rồi mới dừng ở token (thumbprint giả ⇒ `no_cert`, chỉ hỏi 1 lần); nối bị từ chối ⇒ hộp hỏi LẠI 2 nút kèm lý do.
- **Chi phí:** mỗi chữ ký nối thêm làm file phình ~33 KB (ô `/Contents` giữ chỗ 32.000 chữ số hex = `SIGNATURE_LENGTH`, giống đường cũ — không phải lỗi). Cần sidecar chạy (không có sidecar ⇒ chỉ còn 2 nút).
- **Phát hiện bên lề — lỗi CÓ TỪ TRƯỚC, cả hai đường ký — ĐÃ SỬA Ở BI-134:** `@signpdf/placeholder-pdf-lib` ghi `Reason/Name/Location/ContactInfo` bằng `PDFString.of(text)`, hàm này CẮT mỗi ký tự Unicode về 1 byte ⇒ "Đồng ý" thành `<10D36E6720FD>` (đã đo: `PDFString.of('Đồng ý Hà Nội')` ghi `(?\x10 …)`, còn `PDFHexString.fromText` ghi đúng UTF-16BE). Ảnh hưởng: lý do/nơi ký có dấu tiếng Việt hiện sai trong bảng chữ ký của Acrobat/Foxit (hình hiển thị là PNG nên không ảnh hưởng). Test dùng ASCII có chủ ý. Hướng sửa: dựng lại các chuỗi này bằng `PDFHexString.fromText` sau `pdflibAddPlaceholder`.
- **VẪN CHƯA — đừng đọc BI-133 như "đã xác nhận Foxit/Acrobat chấp nhận":**
  - **Foxit PDF Reader 2026.2.1.39815 ĐÃ KIỂM (ảnh người dùng gửi):** file 8 (2 chữ ký) và 9 (5 chữ ký) — mọi chữ ký đều "The document has not been modified since this signature was applied" (kể cả chữ ký 1 sau khi có chữ ký 2–5); "unknown" chỉ vì danh tính (chứng thư tự ký) chưa được tin cậy. **Acrobat Reader CHƯA mở.** Lời trong hộp thoại đã sửa theo kết quả này (trước đó viết rằng trình đọc sẽ ghi chú "có thay đổi sau khi ký" — Foxit KHÔNG nói vậy).
  - **Chưa ký bằng token/chứng thư thật**: helper .NET cần chứng thư trong Windows cert store; ta dùng OpenSSL + chứng thư tự ký. Chữ ký có dấu thời gian RFC3161 (TSA) lớn hơn — chưa thử với ô 32.000 hex trong thực tế; chuỗi CA dài của VNPT/Viettel/FPT chưa thử.
  - **DocMDP P=2/3** được phép nhưng chưa kiểm bằng Acrobat; P=1 chỉ được kiểm bằng chuỗi byte tự dựng (không có file chứng nhận thật).
  - **Hộp native chưa bấm tay**; ký nối thêm chỉ có trong hộp "đã có chữ ký" — người dùng không thấy tuỳ chọn nào khác.
  - Tài liệu có chữ ký nhưng ĐÃ bị pdf-lib dựng lại (sửa rồi mới ký) vẫn đi đường cổ điển (chữ ký cũ đã mất lúc sửa).
- **Vỡ khi:** lùi về "Vẫn ký" sau lỗi giai đoạn KÝ (hỏi PIN lần hai); coi `SIGN_STAGE_REASONS` là danh sách thứ hai ở nơi khác; điền ByteRange làm đổi độ dài file; ghép chữ ký khi chưa kiểm kết quả lõi bắt đầu bằng đúng byte đầu vào; `cancelId` tính bằng vị trí cố định thay vì `keys.indexOf("cancel")`; để pdf-lib ghi ô `/Contents` bằng NUL; dùng tên trường `Signature1` cứng.

### BI-134 · Chữ có dấu trong từ điển chữ ký (Reason / Name / Location / ContactInfo)

- **Lỗi (có từ trước, cả đường ký cổ điển lẫn ký nối thêm).** `@signpdf/placeholder-pdf-lib` ghi bốn trường này bằng `PDFString.of(text)`, hàm CẮT mỗi ký tự Unicode về 1 byte (đã đo: "Đồng ý Hà Nội" → các byte `10 D3 6E 67 20 FD…`; `PDFHexString.fromText` ghi đúng `<FEFF…>`). Lý do/nơi ký có dấu tiếng Việt hiện sai trong bảng chữ ký của trình đọc. Hình hiển thị của chữ ký là PNG nên không ảnh hưởng.
- **Sửa (`desktop/src/sig-text.js`, thuần).** Gọi thư viện với chuỗi RỖNG (ra `/Reason ()` …) rồi điền giá trị đúng vào chính các chỗ trống đó trong byte thô của object chữ ký (thư viện đăng ký nó dưới dạng `PDFInvalidObject`). Chữ chỉ gồm ký tự an toàn (`A-Za-z0-9 .,;:_-/@+`) ghi dạng chuỗi thường; MỌI thứ khác (dấu tiếng Việt, ngoặc, gạch chéo ngược, xuống dòng, ký tự ngoài BMP) ghi dạng hex UTF-16BE có BOM. Chỉ chỗ trống `/Key ()` ở mức cao nhất bị đụng — `/Prop_Build /App /Name (Nabu PDF)` không rỗng nên giữ nguyên; điền lần hai KHÔNG đè giá trị đã có. **Metadata không bao giờ được làm hỏng việc ký**: mọi lỗi ⇒ trả false, chữ ký vẫn đúng (chỉ thiếu chữ).
- **Hai nơi gọi:** `signing-worker.js · applySignature` (cổ điển; nay nhận `deps.signer` để test thay token bằng OpenSSL) và `sign-append.js · makePrepare` (ký nối thêm; điền chữ TRƯỚC khi đổi NUL→'0', đọc object SAU khi điền — đọc trước thì bước NUL ghi đè mất chữ).
- **Bằng chứng.** `sig-text.test.js` 50 ca: mã hoá (kể cả `a(b`, `\\`, `😀`, xuống dòng, 3.500 ký tự), đọc lại bằng pdf-lib ĐỘC LẬP và bằng PyMuPDF (không dùng chính hàm sửa để chấm), đường KÝ THẬT của worker (cổ điển + nối thêm, OpenSSL: chữ ký vẫn hợp lệ), ghim cấu trúc. **Đột biến 14/14 đỏ** — lượt đầu lọt 2: T4 (test "không đè" dùng giá trị có dấu nên ghi dạng hex không khớp mẫu bị đột biến — thêm ca ASCII) và T12 (đột biến tôi viết chỉ sửa một chú thích, tức mutant tương đương — viết lại thành phép đổi thứ tự thật). `tools/sign_append_e2e.js` nay ký bằng tên/lý do/nơi tiếng Việt có dấu và đọc lại bằng PyMuPDF (dev và `sidecar.exe`: đạt).
- **ĐÃ NHÌN TRONG FOXIT (2026-11-22):** mở Signature Properties của chữ ký 3 trong `10-KY-NOI-THEM-tieng-Viet-5-nguoi-ky.pdf`: **Reason "Đồng ý — lần 3", Location "Hà Nội"** hiện đúng dấu. (Trạng thái unknown + "subsequent changes" ở ảnh đó là do người dùng tích ô form trong Foxit, không phải lỗi file.)
- **CHƯA:** Acrobat Reader; chữ ký 5 của file 10 bị cắt khỏi ảnh; file đã ký TRƯỚC bản sửa vẫn mang chữ hỏng (không sửa ngược được).
- **Vỡ khi:** truyền chữ cho `pdflibAddPlaceholder` thay vì điền sau; thêm một nơi dựng chữ ký mới mà quên `fixSignatureStrings`; `PDFString.of` cho chữ người dùng nhập ở bất kỳ chỗ nào khác trong từ điển chữ ký.

### BI-135 · Cổng BI-127 cho `file:write-new-pdf` (Tạo bản theo mẫu)

- **Lỗ hổng cũ.** BI-127 quy định *mọi* đường ghi PDF ở main phải qua `SignedScan.guardWrite`, nhưng `file:write-new-pdf` với `overwrite:true` (cờ `"w"`) đè thẳng lên file CÓ SẴN. Renderer chỉ hỏi một câu chung "Đã có file X. Ghi đè?" mà không biết file đích đã ký số ⇒ bấm "Ghi đè" là phá chữ ký của một file KHÁC với tài liệu đang mở (nên không có `state.path` nào để nối, cũng không có cảnh báo nào).
- **Sửa.** Trong handler, khi `overwrite === true`: `SignedScan.guardWrite(fp, data, ask)` với `ask` = `askSignedOverwrite` (cùng hộp BI-127, ba nút: **Bỏ qua file này** · Vẫn ghi đè · Huỷ; nút mặc định 0 = nút KHÔNG phá chữ ký; KHÔNG có nút "Lưu nối thêm" vì không có bản gốc để nối). "Bỏ qua" hoặc "Huỷ" ⇒ **không ghi**, trả `{ saved:false, skipped:true, path }`. `overwrite:false` dùng cờ `"wx"` (không bao giờ đè) nên không cần cổng. File chưa tồn tại, file không ký, hoặc bản mới bắt đầu bằng đúng byte vùng ký (không mất gì) ⇒ ghi thẳng, KHÔNG hỏi. Tham số handler đổi `_e` → `e` (vì nay dùng `senderWindow(e)`).
- **Renderer** (`batch-variants.js · writeOne`): `r.skipped` sau lần ghi đè ⇒ `{ skipped:true }` (vào danh sách "Bỏ qua: …" của đợt, KHÔNG phải lỗi làm hỏng cả đợt).
- **Bằng chứng.** `test/signed-newfile.test.js` (npm `test:signednew`): CẮT NGUYÊN VĂN `askSignedOverwrite` + handler ở main.js, chạy thật với cổng BI-127 thật, file thật trên đĩa, hộp thoại giả — ma trận overwrite × (chưa có / không ký / đã ký / ký-nhưng-giữ-vùng-ký) × từng nút (0 / Huỷ / nút lạ / -1 / undefined / hộp ném lỗi / Vẫn ghi đè), kiểm tên/thư mục xấu không thụt lùi, nhãn tiếng Anh; `writeOne` cắt từ renderer chạy với `window.desktop` giả; ghim cấu trúc (cổng TRƯỚC lệnh ghi, chỉ khi overwrite, cả "copy" lẫn "cancel" đều không ghi; cả ba handler ghi PDF của main đều có cổng). **Đột biến 11/11 đỏ** (bỏ cổng, đảo điều kiện, copy/cancel vẫn ghi, bỏ `skipped`, nhãn, đường dẫn hỏi sai, cờ luôn `"w"`, ép "overwrite", renderer bỏ/ném lỗi). Probe app thật: `scripts/probe-signed-save.js` kịch bản S9.
- **CHƯA:** hộp native chưa bấm tay. (Ghi đè không nguyên tử đã sửa ở BI-136.)
- **Vỡ khi:** thêm handler ghi PDF mới vào đường dẫn người dùng mà quên `guardWrite`; đổi cờ `"wx"` thành `"w"` ở nhánh `overwrite:false`; để renderer coi `skipped` là lỗi.

### BI-136 · Ghi file nguyên tử (file tạm + fsync + đổi tên) cho mọi đường ghi PDF ra đường dẫn người dùng

- **Lỗi (có từ trước).** `fs.promises.writeFile(fp, data)` mở file với cờ `"w"` — CẮT NÓ VỀ 0 BYTE NGAY — rồi mới ghi. Mất điện / treo máy / ổ đầy / tiến trình bị giết giữa chừng ⇒ file đích còn 0 byte hoặc nửa chừng và bản cũ (cả chữ ký số của một hợp đồng đã ký) không còn ở đâu. Cửa sổ rủi ro tỉ lệ với cỡ file (hàng trăm MB ⇒ hàng giây). **Đã chứng minh bằng đối chứng:** giết tiến trình thật giữa lúc ghi theo cách cũ ⇒ file chỉ còn đúng nửa dữ liệu MỚI, bản cũ mất.
- **Sửa (`desktop/src/atomic-write.js`).** Thuần, `fs`/`sleep` tiêm được. Quy trình: (1) mở file tạm `<đích>.<6 byte hex>.nabu-tmp` CÙNG thư mục (cờ `"wx"`; hậu tố KHÔNG phải `.pdf` để không lọt vào hộp chọn/quét PDF); (2) `writeFile` → **`fsync`** → đóng → **kiểm cỡ** (`stat.size === byteLength`, bắt ghi thiếu không báo lỗi); (3) `rename` đè lên file đích — bước DUY NHẤT chạm file thật. Mọi lỗi trước bước 3 ⇒ file đích **nguyên vẹn từng byte**, tạm bị xoá, lỗi gốc không bị lỗi dọn rác che. Thiếu `fsync` thì sau mất điện NTFS có thể giữ tên mới nhưng dữ liệu rỗng — vì vậy nó bắt buộc, không phải tuỳ chọn.
- **Nơi dùng:** `dialog:save-pdf`, `file:write-pdf` (kể cả kết quả Lưu nối thêm BI-130), `file:write-new-pdf` nhánh `overwrite:true`. **Cố ý GIỮ nguyên** `writeFile` thô cờ `"wx"` của nhánh file MỚI (không có gì để mất; chính cờ này chặn đè nhầm — BI-135).
- **Quyết định thiết kế đã cân nhắc (đừng đảo mà không đọc):**
  · **Đổi tên lỗi ⇒ KHÔNG rơi về ghi thẳng.** Windows hay trả `EPERM/EBUSY/EACCES` TẠM THỜI (diệt virus, OneDrive, Explorer chạm vào file): thử lại 6 lần chờ 40→1280 ms. Hết lượt ⇒ ném lỗi `…file gốc còn nguyên [EPERM]`, xoá tạm. Rơi về ghi thẳng ở đây là đúng lúc file đang bị giữ — tức là tự bỏ lớp bảo vệ khi cần nó nhất. Renderer đã có đường xử lý `saved:false/error` (rơi sang Lưu thành).
  · **Không tạo được file tạm vì QUYỀN (`EACCES/EPERM`) ⇒ rơi về ghi thẳng** (chưa đụng gì; thư mục chỉ-đọc nhưng chính file ghi được — giữ hành vi cũ, `atomic:false`). Mọi lỗi mở tạm khác (`ENOSPC`, `EMFILE`, `EIO`…) ⇒ ném, KHÔNG rơi về ghi thẳng (ổ đầy mà cắt cụt file thì mất cả bản cũ).
  · **Liên kết tượng trưng:** chỉ khi `lstat` nói là symlink mới `realpath`, rồi đặt tạm cạnh file THẬT và đổi tên đè lên file thật (liên kết còn nguyên). File thường KHÔNG gọi `realpath` (libuv trên Windows đổi ổ ánh xạ `Z:` thành đường UNC).
  · **KHÔNG làm:** quét dọn file `.nabu-tmp` cũ (readdir mỗi lần Lưu trên thư mục mạng lớn là chi phí lặp để dọn rác hiếm); fsync thư mục (Node không mở được thư mục trên Windows).
- **Cái giá đã đo** (ổ của máy dev, trung vị 3 lần): 20 MB 7→51 ms · 152 MB 50→226 ms · 400 MB 142→455 ms. Phần chênh là `fsync` (cách cũ chỉ ghi vào cache hệ điều hành, CHƯA xuống đĩa nên nhanh hơn mà mong manh hơn). Ổ cơ học/mạng có thể chậm hơn — chưa đo.
- **Hệ quả cần biết:** (1) file thay bằng một file MỚI cùng tên ⇒ thời gian tạo, ACL tuỳ chỉnh, hard link của file cũ không giữ (ACL lấy theo thư mục; sản phẩm chỉ chạy Windows nên không chmod); (2) tiến trình bị giết giữa lúc ghi để lại MỘT file `*.nabu-tmp` (rác an toàn, xoá tay được, không đụng file thật); (3) file bị chương trình khác khoá không cho đổi tên nay báo lỗi `…đang mở ở chương trình khác?` thay vì ghi hỏng.
- **Bằng chứng.** `test/atomic-write.test.js` (npm `test:atomic`, 47 ca): hợp đồng (đè/tạo mới/view có offset như dữ liệu IPC/rỗng/sai kiểu), thứ tự thao tác (open→write→sync→close→stat→rename), tạm cùng thư mục + hậu tố + cờ `wx`, chèn lỗi ở từng bước (ENOSPC giữa chừng, sync, đóng, ghi thiếu không lỗi, EEXIST, lỗi dọn rác che lỗi gốc, mở tạm EACCES vs ENOSPC/EMFILE/EIO/ENOENT), thử lại đổi tên (thành công sau 3 lần, hết lượt, lỗi không tạm thời không chờ), người đọc giữa lúc ghi vẫn thấy bản cũ, hai lần ghi song song không lẫn, nhánh symlink bằng đồ giả, và **GIẾT TIẾN TRÌNH THẬT** (SIGKILL/TerminateProcess) kèm đối chứng cách cũ. **Đột biến 21/21 đỏ** (16 trong module + 4 điểm nối ở main.js + `wx`→`w`). Pin ở `signed-scan/signed-save/signed-newfile/ipc-bytes` được cập nhật sang tên `writeFileAtomic` (giữ nguyên ý: cổng đứng TRƯỚC lệnh ghi; ghi plan.data chứ không phải data thô; đếm ≥ 6 chỗ dùng `asWritable`). Probe app thật: không còn `.nabu-tmp` sau S1–S9.
- **CHƯA / NGOÀI PHẠM VI:** (`autosave.pdf` + `manifest.json` của khôi phục sự cố đã làm ở BI-137); `dialog:save-file` (xuất xlsx/csv/json) vẫn ghi thẳng; chưa thử trên ổ mạng/SMB, OneDrive đang đồng bộ, hay có diệt virus bật; ca symlink thật không chạy được trên máy dev (cần Developer Mode) nên chỉ kiểm bằng đồ giả.
- **Vỡ khi:** ghi PDF ra đường dẫn người dùng bằng `fs.promises.writeFile` thô (trừ `wx` file mới); bỏ `fsync` hoặc kiểm cỡ; rơi về ghi thẳng khi đổi tên lỗi; đặt tạm ở thư mục khác ổ; hậu tố tạm là `.pdf`; gọi `realpath` cho file thường.

### BI-137 · Autosave / khôi phục sự cố ghi nguyên tử (`recovery:save` / `scan` / `read`)

- **Lỗi (có từ trước).** `recovery:save` dùng `writeFile` cắt cụt `autosave.pdf` rồi ghi lại tại chỗ ⇒ một cú sập GIỮA lúc autosave (chu kỳ 2 phút, hoặc 15 s sau lần sửa) phá chính bản phục hồi cũ, đúng lúc cần nó; với tài liệu lớn cửa sổ rủi ro kéo dài hàng giây. Thêm: hai file (`autosave.pdf`, `manifest.json`) ghi riêng — có PDF mà thiếu manifest thì `recovery:scan` bắt `JSON.parse` lỗi và **lặng lẽ bỏ qua** dù dữ liệu còn đó, trong khi `hasRecoveryOrphans()` (chỉ nhìn `autosave.pdf`) vẫn nói "có" ⇒ app mở một tab trống để hỏi mà không có gì để hỏi.
- **Sửa (`desktop/src/main.js`, dùng `AtomicWrite` của BI-136):**
  · Cả hai file ghi nguyên tử. **PDF trước, manifest sau** (PDF là thứ đáng giá; manifest chỉ là nhãn tên/đường dẫn/giờ). Sập giữa hai lần ghi ⇒ PDF mới + nhãn cũ vài chục giây (vô hại). Manifest ghi lỗi KHÔNG làm hỏng lần lưu (`saved:true`).
  · `recovery:scan` / `recovery:read` **chịu được thiếu/hỏng manifest** (JSON cụt, `null`, số, rỗng): vẫn đề nghị và đọc được bản PDF, nhãn mặc định (`document.pdf`, không đường dẫn ⇒ Ctrl+S sẽ hỏi Lưu thành, an toàn), giờ lấy từ mtime. Giờ bản quá hạn 14 ngày cũng tính từ mtime khi manifest thiếu `savedAt`.
  · **Thư mục mồ côi** (không có `autosave.pdf` — autosave ĐẦU TIÊN bị giết chỉ để lại `*.nabu-tmp`, hoặc chỉ có manifest): không đề nghị gì, nhưng xoá khi quá 14 ngày (theo mtime thư mục) để thư mục không phình mãi.
  · **`scrub:true` (ẩn trang, BI-74):** `scrubRecoverySlot` xoá `autosave.pdf` cũ + mọi `*.nabu-tmp` TRƯỚC khi ghi bản đã niêm (không đụng manifest). Lý do: ghi nguyên tử giữ bản cũ tới phút chót, mà bản cũ của khe này chính là BẢN RÕ trước khi ẩn; ghi lỗi hay sập giữa chừng với "ghi nguyên tử thuần" sẽ để lại đúng thứ BI-74 cấm. Giá phải trả có chủ ý: sập giữa lúc xoá và ghi ⇒ khe trống (mất bản phục hồi), không phải khe còn bản rõ — thà mất còn hơn lộ. Autosave THƯỜNG không scrub (bản cũ phải được giữ khi ghi lỗi).
  · **Lỗi cũ sửa kèm:** `scrubRecoverySnapshot` gửi `path:` trong khi main đọc `srcPath` ⇒ sau mỗi lần ẩn trang manifest mất đường dẫn gốc (khôi phục xong Ctrl+S không ghi về file gốc). Nay gửi `srcPath`.
- **Bằng chứng.** `test/recovery-atomic.test.js` (npm `test:recoveryatomic`, 45 ca): CẮT NGUYÊN VĂN khối helper + bốn handler ở main.js, chạy với thư mục thật; "khởi động lại sau sập" = môi trường mới trên cùng userData (cờ `recoveryScanDone` bắt đầu lại). Gồm: vòng đời save→scan→read→clear; ghi hết ổ giữa chừng ⇒ bản cũ còn nguyên và đọc được; **ghi dở không bao giờ xong (mô phỏng bị giết) ⇒ khởi động lại vẫn khôi phục đúng bản cũ**, file dở chỉ nằm ở `*.nabu-tmp` và `clear` dọn luôn; thiếu/hỏng manifest (4 kiểu); manifest lỗi ở lần đầu/lần sau; scrub xoá bản rõ + tmp sót, kể cả khi ghi lỗi; đối chứng autosave thường giữ bản cũ; prune quá hạn (theo manifest và theo mtime), thư mục mồ côi mới/cũ; BI-7 (scan lần hai rỗng); docId độc hại; pin cấu trúc (hai lần ghi đều qua AtomicWrite, PDF trước manifest, scrub trước lệnh ghi, renderer gửi `scrub:true` + `srcPath`, autosaveTick KHÔNG scrub). **Đột biến 15/15 đỏ** (lượt đầu R11 lọt vì là đột biến tương đương — chỉ dời dòng khai báo; viết lại thành phép đảo thật ⇒ đỏ ở 2b, 3a, 8b). Probe app thật `scripts/probe-signed-save.js` kịch bản **S10**: chạy chính `scrubRecoverySnapshot` của renderer → IPC → main → đĩa; kiểm không còn byte bản rõ, manifest giữ `srcPath`.
- **CHƯA:** chưa kéo cả luồng ẩn trang thật bằng UI (S10 gọi thẳng hàm scrub của renderer); chưa thử cú sập thật của app đang autosave tài liệu lớn; ghi nguyên tử cần chỗ trống ~gấp đôi tài liệu tạm thời trong userData (bản cũ + tạm); `fsync` mỗi lần autosave thêm vài trăm ms I/O nền với file 400 MB (không chặn main — chạy trên threadpool); bản phục hồi tạo TRƯỚC BI-137 vẫn có thể là PDF cụt (không kiểm tra hợp lệ lúc khôi phục).
- **Vỡ khi:** quay lại `writeFile` thô cho `autosave.pdf`/`manifest.json`; ghi manifest TRƯỚC PDF; `scan`/`read` đòi manifest hợp lệ; bỏ `scrub:true` ở đường ẩn trang hoặc cho autosave thường scrub; để scrub rơi về "giữ bản cũ khi ghi lỗi".

### BI-138 · `/split` chạy trong TIẾN TRÌNH CON và có TRẦN thời gian (10 phút)

- **Lỗi (có từ trước; đo 2026-11-22).** Route `/split` là `async def` chạy `insert_pdf` thẳng trên event loop. `insert_pdf` giữ GIL suốt thời gian chạy ⇒ MỘT lần tách chậm làm **đứng cả sidecar** (mọi tab, `/health`, mọi route), không chỉ riêng thao tác tách. `bug1978317.pdf` (1,5 MB, 1 trang) **không tách xong sau 600 s** (đo riêng, tiến trình đã bị giết ở mốc 600 s; `fitz.open` mất 0,16 s, vậy là kẹt ở `insert_pdf`). Người dùng bấm Tách và chỉ còn cách tắt app.
- **ĐÍNH CHÍNH sổ cũ.** `docs/CORPUS-SWEEP.md` và bàn giao 2026-11-22 gộp `bomb_giant.pdf` vào `/split` là SAI: `bomb_giant.pdf` tách trong **0,0 s** (nó chỉ treo ở nén và đánh số trang). File làm `/split` kẹt là `bug1978317.pdf` — file mà ở nén chỉ **chậm hợp lệ** (76–92 s, BI-123), ở tách thì **treo**. Hai thao tác, hai hành vi.
- **Sửa.** Cùng khuôn BI-121/129. Lõi chuyển sang module lá `src/pdf/split.py` (`split_to_zip`, `repair_orphan_field_kids` chuyển NGUYÊN VĂN từ `api.py`, `worker_main`, `SPLIT_TIMEOUT_S`, `SplitTimeout`); `sidecar.py --split-worker <in.pdf> <out.zip> <pairs.json>`; `api._split_via_worker_blocking` (Popen + `communicate(timeout)`, giết khi hết giờ, dọn thư mục tạm). **CHA** vẫn làm phần rẻ và quyết định mọi câu 400 (mở file, đếm trang, khoảng trang, trần 1000 file) — hành vi lỗi không đổi một chữ; **CON** chỉ làm vòng `insert_pdf`. `api._repair_orphan_field_kids` còn là bí danh (test và lưới khác gọi tên cũ).
- **Vì sao 10 phút (chỗ dễ sửa bừa).** Tách hợp lệ rất nhanh, vì nó chỉ sao chép trang và deflate: 3000 trang ra 1000 file (trần của route) = **0,63 s**; 300 trang ảnh ra 300 file = 0,21 s. Không có công thức theo trang như nén (`MAX_PAGES` × 0,377 s), nên không cần 30 phút. 10 phút là hàng chục lần ca hợp lệ nặng nhất tôi hình dung (tài liệu ~400 MB, mỗi file con một ảnh lớn), và vẫn cắt được file treo thật. Ghim: `test_timeout_is_a_ceiling_not_a_slow_detector` (60 s … 30 phút). **Chưa đo** tài liệu hàng trăm MB thật — nếu có người dùng bị cắt oan, đo trước rồi mới nâng.
- **Luật.**
  1. **`insert_pdf` không bao giờ chạy trên event loop.** `test_event_loop_keeps_running_while_the_worker_works` (một coroutine tick đều trong lúc worker ngủ 2 s) + ghim nguồn `test_route_no_longer_runs_insert_pdf_on_the_event_loop`.
  2. **Hết giờ / worker chết KHÔNG rơi về tách tại chỗ** (`_NoInProcess` đếm lời gọi `split_to_zip` trong tiến trình sidecar). Chỉ khi **không khởi động nổi** worker (`OSError`) mới tách tại chỗ — cùng đánh đổi với `_compress_anywhere`: mất tính năng tệ hơn một rủi ro hiếm.
  3. **`SplitTimeout` là lớp RIÊNG và được bắt TRƯỚC `except Exception`** (không để `nice_pdf_error` nhào nặn câu hết giờ). Ghim nguồn.
  4. **Giết thật, không mồ côi:** `test_timeout_kills_the_worker_and_reports_it` đọc pid worker rồi hỏi hệ điều hành.
  5. **`split.py` là module lá** (danh sách trắng `io/json/sys/zipfile`; `fitz` nạp lười). `src.pdf.util` kéo fastapi nên cũng bị cấm.
  6. **Lỗi của thư viện vẫn được dịch** (BI-125): cha chạy `nice_pdf_error` trên stderr của worker — `test_library_message_from_the_worker_still_gets_the_vietnamese_translation`.
- **Bằng chứng.** `test_split_worker.py` 20 ca (chạy worker THẬT ở mọi chỗ có thể, kể cả `bug1978317.pdf` thật với hạn 5 s: trả lời gọn, event loop vẫn tick; tự bỏ qua nếu corpus vắng). `test_pdf_ops.py` giữ nguyên mọi ca `/split` cũ (chạy qua worker), duy nhất ghim nguồn `test_split_retry_reopens_the_document_from_the_original_bytes` đổi trỏ sang `split.py` (cùng ý). **Đột biến 13/13 đỏ** (route chạy lõi trên event loop; bỏ hạn giờ; hết giờ không giết worker; hết giờ/chết rơi về tách tại chỗ; không dọn thư mục tạm; `SplitTimeout` bị `except Exception` nuốt; `split.py` import fastapi; nhánh thử lại không mở lại tài liệu; sidecar bỏ cờ; đếm file lệch; bỏ trần 1000 file; worker nuốt lỗi trả 0; trần > 30 phút). Lượt đầu lọt 2 và đều là lỗ hổng của TEST/phạm vi chạy, không phải của mã: (a) mutant `except Exception as e0` đặt TRƯỚC `except SplitTimeout` — hành vi **tương đương**, ghim thứ tự chỉ tìm đúng chuỗi `as e:` nên không thấy; đã siết bằng regex `except\s+Exception\b`; (b) nhánh thử lại không mở lại tài liệu — ghim nằm ở `test_pdf_ops.py` mà runner đột biến chỉ chạy `test_split_worker.py`; chạy đúng test thì đỏ. Ba mutant "đỏ" lượt đầu thật ra là **runner chạy treo** (file `bug1978317.pdf` thật chạy tại chỗ), không phải test đỏ; chạy lại từng test có tên thì đỏ đúng chỗ.
- **CHƯA / NGOÀI PHẠM VI.** **Nút Hủy** cho `/split` (cần đổi renderer + tái dùng sổ việc `_compress_jobs`; người dùng vẫn chờ tới 10 phút trên file treo, nhưng sidecar không còn đứng). `/add-page-numbers` vẫn chạy tại chỗ (`bomb_giant.pdf` treo ở đó). Chưa build lại sidecar (`check-sidecar-fresh` sẽ ĐỎ tới khi build) và chưa thử bản đóng gói thật. Chưa đo thêm chi phí khởi động worker ở bản đóng gói (khuôn compress đo ~0,3–0,5 s).
- **Vỡ khi:** chạy lại `insert_pdf` trên event loop "cho nhanh"; để hết giờ rơi về tách tại chỗ; nhét `import api`/`src.pdf.util` vào `split.py`; hạ trần dưới 60 s hoặc nâng quá 30 phút mà không đo; quên nhánh `--split-worker` trong `sidecar.py` (argparse từ chối cờ lạ, worker thoát mã 2 ⇒ MỌI lần tách trả lỗi; `test_worker_cli_end_to_end` và `test_route_splits_through_the_real_worker` đỏ).

### BI-139 · Nút HỦY cho `/split` (dùng chung sổ việc và `/compress-cancel` với nén, BI-126)

- **Vì sao.** BI-138 chỉ cho trần 10 phút: trên file treo (`bug1978317.pdf`) người dùng vẫn nhìn lớp phủ quay tới 10 phút, không có lối ra. Hủy được là NHỜ BI-138 (tách đã nằm ở tiến trình con nên "dừng" chỉ là giết đúng tiến trình đó).
- **Cách làm — tái dùng, không nhân đôi.** `SplitRequest.job` (mặc định rỗng = hợp đồng cũ). `/split` vào ô sổ việc `_compress_job_slot(req.job)` (cùng `_compress_jobs`/`_CompressJob`/`/compress-cancel` của nén); `_split_via_worker_blocking(…, job)` gắn tiến trình vào ô và đọc cờ `cancelled`. Hủy ⇒ giết tiến trình con ⇒ ném `CompressCancelled` ⇒ route trả `ZipResponse(success=False, cancelled=True, error="Đã hủy tách.")` (HTTP 200; `ZipResponse.cancelled` mặc định False nên các route khác dùng chung model không đổi). Tên "compress" là di sản; ĐỔI NÓ là đổi hợp đồng với renderer, đừng đổi nếu không có lý do. Renderer: `runSplit` sinh `fields.job = newJobId()` TRƯỚC `showOverlay`, nút Hủy gọi `POST /compress-cancel?job=<cùng mã>`, KHÔNG abort fetch (sidecar mới biết tách đã dừng hẳn chưa), toast thường "Đã hủy tách." (không đỏ).
- **Ba cuộc đua của BI-126, đều đã xử lý ở đường tách:** (1) Hủy tới lúc còn đang ghi file tạm ⇒ cờ bật, ngay sau `Popen` thì giết; (2) Hủy tới TRƯỚC khi route ghi sổ (thân JSON còn truyền; FastAPI parse xong mới gọi handler nên khe này rộng hơn ở nén) ⇒ "bia mộ", `_compress_job_slot` thấy và bỏ cuộc không động tới PDF; (3) cờ nằm trên cùng một ô nên không có lần chạy thứ hai nào để lọt (tách không có lần thử lại như nén).
- **Luật.**
  1. **Cờ thắng cả mã thoát** — kể cả khi worker kịp tách xong (`test_cancel_wins_even_if_the_worker_finished_cleanly`): người dùng bảo dừng thì không trả file.
  2. **Hủy KHÔNG phải lỗi:** `CompressCancelled` được bắt TRƯỚC `except Exception` (ghim nguồn + hành vi); renderer đọc `data.cancelled === true`.
  3. **Mã đi kèm `/split` phải TRÙNG mã đi tới `/compress-cancel`** — lệch một chữ là hủy hư không, không lỗi ở đâu. `split-cancel.test.js` CHẠY `runSplit` thật (cắt nguyên văn khỏi `app.js`, đồ giả cho tên trần) và so hai mã.
  4. **Hủy không tới được sidecar ⇒ việc VẪN chạy ⇒ mở lại nút, nói thật, KHÔNG đóng lớp phủ** (đã đo bằng hành vi, không chỉ regex).
- **Bằng chứng.** `test_split_worker.py` +7 ca (giết giữa chừng có hỏi hệ điều hành pid; bia mộ không sinh worker nào; cờ bật trước Popen giết ngay — worker giả ngủ 25 s phải chết trong <10 s; hủy mã khác không đụng việc này; sổ việc không rò). `desktop/test/split-cancel.test.js` 31 ca (npm `test:splitcancel`). **Đột biến 16/16 đỏ** (8 Python, 8 JS): lượt đầu 2 mutant "không áp được" là lỗi MẪU thay thế của tôi (một đoạn trùng với hàm nén; một regex), chạy lại bằng mẫu đúng thì đỏ. Một lỗ hổng TEST đã vá trước đó: ca "cờ bật trước Popen" ban đầu dùng worker thật nên mutant bỏ `proc.kill()` vẫn xanh (cờ được đọc lại ở cuối) — đổi sang worker giả ngủ lâu và đo thời gian. `desktop/scripts/probe-split-cancel.js` (app Electron thật, nút thật, `.click()` thật, `bug1978317.pdf`; đếm tiến trình `--split-worker` trước/sau và hỏi `/health`) — **kết quả (2026-11-22, bản dev):** lớp phủ hiện, nút Hủy hiện và không khoá; trước khi bấm có **2** tiến trình `--split-worker` (cặp stub venv + python thật, như ở nén); bấm ⇒ `runSplit` kết thúc sau **0,51 s**, toast **"Đã hủy tách."** (class `toast`, không `bad`), lớp phủ tắt, **0** worker còn sống, `/health` = 200.
- **CHƯA / NGOÀI PHẠM VI.** Nhánh tách TẠI CHỖ (chỉ khi không khởi động nổi worker) KHÔNG hủy được và còn giữ GIL nên cả `/compress-cancel` cũng không được phục vụ trong lúc đó — hiếm, và không tệ hơn trước BI-138. `/add-page-numbers` vẫn chưa có hạn giờ lẫn Hủy. Chưa build lại sidecar; chưa thử bản đóng gói; chưa bấm tay bằng chuột thật ngoài probe.
- **Vỡ khi:** đổi tên tham số `job` ở một bên; để `/split` bắt `Exception` chung trước `CompressCancelled`; abort `fetch` ở renderer thay vì hỏi sidecar; bỏ `fields.job` (nút vẫn hiện nhưng hủy hư không); đóng lớp phủ trước khi sidecar trả lời; cho `ZipResponse.cancelled` mặc định True.

### BI-140 · `/add-page-numbers` chạy trong TIẾN TRÌNH CON, có TRẦN 10 phút và nút HỦY

- **Lỗi (có từ trước; đo 2026-11-22).** Cùng họ BI-138: route `async def` chạy `insert_text` thẳng trên event loop; PyMuPDF giữ GIL ⇒ MỘT lần chậm làm đứng cả sidecar. `bomb_giant.pdf` (123 KB, 1 trang) treo **ngay trong `insert_text` của trang đầu** (sau cảnh báo "syntax error in content stream"), **không xong sau 60 s**. Khác `/split`: `bug1978317.pdf` ở đây chỉ mất **1,8 s** (`tobytes` 1,4 s) — hai thao tác, hai file treo khác nhau.
- **Sửa — cùng khuôn BI-138/139.** `src/pdf/pagenum.py` (module lá: `stamp_page_numbers`, `worker_main`, `PAGENUM_TIMEOUT_S`, `PageNumberTimeout`); `sidecar.py --pagenum-worker <in.pdf> <out.pdf> <plan.json>`; `api._pagenum_via_worker_blocking` (Popen + `communicate(timeout)`, giết khi hết giờ/hủy, dọn thư mục tạm); `PageNumberRequest.job` + `PdfBytesResponse.cancelled` (mặc định False — các route dùng chung model không đổi); dùng CHUNG `_compress_jobs`/`/compress-cancel`. Renderer `runPageNumbers`: `job` sinh trước `showOverlay`, nút Hủy, toast thường "Đã hủy đánh số.".
- **Điểm khác `/split` — CHA dựng `plan` thuần dữ liệu.** Phần đánh số cần `_fmt_page_label`, `_hex_rgb01`, `WRITE_GARBAGE` ở `src/pdf/util.py`, mà util kéo fastapi (~0,27 s mỗi lần khởi động worker). Thay vì import (đắt) hay nhân đôi mã (lệch), **cha tính sẵn** nhãn từng trang / màu RGB / mức garbage rồi gửi xuống qua `plan.json`; worker không import util và **util không bị đụng một dòng**. Hệ quả: `WRITE_GARBAGE` (BI-23: ≥1 để lỗi bôi đen không còn mồ côi) phải đi theo `plan["garbage"]` chứ KHÔNG hard-code ở worker — ghim bằng `test_route_builds_the_plan_in_the_parent_including_write_garbage` **và** `test_write_garbage.py` (đột biến `garbage=0` ⇒ cả hai đỏ).
- **Vì sao 10 phút.** Đánh số hợp lệ rất nhanh: 3000 trang chữ = `insert_text` 1,56 s + `tobytes` 0,26 s; `tracemonkey.pdf` (14 trang) 0,16 s. Ghim 60 s … 30 phút. Chưa đo tài liệu hàng trăm MB thật.
- **Luật.** (1) `insert_text` không bao giờ chạy trên event loop (`test_event_loop_keeps_running_while_the_worker_works` + ghim nguồn). (2) Hết giờ / worker chết KHÔNG rơi về đánh số tại chỗ; chỉ `OSError` (không khởi động nổi worker) mới lùi. (3) `PageNumberTimeout` và `CompressCancelled` bắt TRƯỚC `except Exception`. (4) Cờ hủy thắng cả mã thoát, kể cả khi worker kịp xong. (5) `pagenum.py` là module lá (danh sách trắng `json/sys`). (6) Đầu ra qua worker = đầu ra hàm tại chỗ (cùng content stream từng trang, kể cả xoay 90/180/270). (7) **Hủy/lỗi KHÔNG chạm tài liệu đang mở:** `runPageNumbers` return TRƯỚC `pushUndo()` / `state.bytes =` (`test/pagenum-cancel.test.js` chạy hàm thật và đo `pushUndoCalls`/`state.bytes`; và `pushUndo` trước khi đổi bytes — BI-3 — cũng được đo).
- **Bằng chứng.** **Ảnh nền trước khi sửa:** 25 ca (5 tài liệu — 5, 6 trang có xoay 90/180/270, 30, `tracemonkey`, `bug1978317` 12 MB — × 5 bộ tham số) chụp bằng dấu vân tay ngữ nghĩa (góc xoay + khung + hash content stream đã giải nén từng trang), sau khi sửa **khớp 25/25**. (Hash CẢ FILE không dùng được làm chuẩn: đo được 23/25 ca ra byte khác nhau giữa hai lần chạy cùng một mã — nguyên nhân CHƯA truy ra, khả năng là `/ID` hoặc ngày giờ do PyMuPDF ghi; dấu vân tay ngữ nghĩa thì ổn định 25/25.) `test_pagenum_worker.py` **28 ca** (chạy worker THẬT; có ca `bomb_giant.pdf` thật hạn 5 s: trả lời gọn, event loop vẫn tick; có ca số nằm THẲNG và đúng góc nhìn thấy trên trang xoay). `desktop/test/pagenum-cancel.test.js` **38 ca** (npm `test:pagenumcancel`, CHẠY `runPageNumbers` thật). **Đột biến 31/31 đỏ** (22 Python, 9 JS — lượt đầu **1 lọt**: bỏ `rotate=page.rotation`. Đó là lỗ hổng TEST THẬT: test so-với-hàm-tại-chỗ không thấy vì cả hai dùng chung hàm, và `test_pdf_ops.py` không có ca trang xoay nào. Đã thêm `test_numbers_are_upright_and_in_the_visible_corner_on_rotated_pages`; lần đầu viết nó đỏ **trên mã đúng** vì `get_text("dict")` trả hướng/toạ độ ở không gian trang CHƯA xoay — phải ánh xạ qua `rotation_matrix` trước khi so; sau đó mutant đỏ đúng "trang 2 xoay 90: số nằm nghiêng"). `desktop/scripts/probe-pagenum-cancel.js` (app Electron thật, `bomb_giant.pdf`, đếm tiến trình `--pagenum-worker`, hỏi `/health`, và so `state.bytes` trước/sau) — **kết quả (2026-11-23, bản dev):** lớp phủ hiện, nút Hủy hiện và không khoá; trước khi bấm có **2** tiến trình `--pagenum-worker` (cặp stub venv + python thật); bấm ⇒ `runPageNumbers` kết thúc sau **0,52 s**, toast **"Đã hủy đánh số."** (class `toast`, không `bad`), lớp phủ tắt, **0** worker còn sống, **tài liệu đang mở còn nguyên (cùng đối tượng `state.bytes`)**, `/health` = 200. **ĐÍNH CHÍNH về lần chạy đầu của probe này (đã ghi sai nguyên nhân ở bản đầu của đoạn này):** lần chạy đầu bị kẹt ở "Đang tải tài liệu…" hơn 5 phút với cửa sổ `visibilityState: "hidden"`; tôi đã kết luận "cửa sổ ẩn ⇒ pdf.js ngừng vẽ". Điều đó CHƯA được tách riêng: về sau đo được `loadBytes(bomb_giant.pdf)` mất **147.257 ms (~2,5 phút) ngay cả khi cửa sổ `visible`** (pdf.js vẽ trang bom giải nén), và probe cũ `await` không hạn giờ nên lặng lẽ chờ hết thời gian đó mỗi lần mở. Cửa sổ ẩn vẫn là một rủi ro có thật (probe nay bật ba cờ chống throttle + `Page.bringToFront` và in `visibilityState`), nhưng đừng đọc lần kẹt đầu là bằng chứng của riêng nó. **Mọi số đo thời gian ở BI này (Hủy 0,5 s) tính TỪ LÚC BẤM, không gồm bước mở file** — `probe-compress-cancel.js` / `probe-pagenum-cancel.js` (file `bomb_giant.pdf`) mất thêm ~2,5 phút ở bước mở; `probe-split-cancel.js` (`bug1978317.pdf`) không bị. Kịch bản `desktop/e2e/cancel.e2e.js` tránh bước đó bằng `setBytesUnrendered` (mở tài liệu nhỏ thật, rồi thay `state.bytes` — xem BI-141).
- **CHƯA / NGOÀI PHẠM VI.** Nhánh đánh số TẠI CHỖ (chỉ khi không khởi động nổi worker) không hủy được. Ba khuôn worker (`compress`, `split`, `pagenum`) + `incremental` giờ gần giống nhau ~60 dòng (`Popen` + `communicate(timeout)` + cờ hủy + dọn tạm): **cố ý chưa gộp** để không trộn refactor với tính năng — gộp là việc riêng, chỉ sau khi cả ba đã ship và test tay. Chưa build lại sidecar; chưa thử bản đóng gói; `/edit-text`, `/translate` và các route chạy tại chỗ khác chưa có hạn giờ.
- **Vỡ khi:** import `src.pdf.util` vào `pagenum.py` (mỗi lần đánh số chậm thêm ~0,3 s, im lặng); hard-code `garbage` ở worker (lỗi bôi đen quay lại mồ côi — BI-23); cho hủy/lỗi rơi xuống `pushUndo()`; bỏ `rotate=page.rotation` (số nằm nghiêng ở scan xoay); hạ trần < 60 s hoặc nâng > 30 phút không đo; để `PageNumberTimeout`/`CompressCancelled` sau `except Exception`.

### BI-141 · Bộ khung e2e: móc hộp thoại native + `app-driver` (hướng A của "kênh điều khiển")

- **Vì sao hướng A, không phải `--control` (loopback + token).** Khảo sát: 6 probe CDP cũ (~1.700 dòng) đã làm được gần hết thứ `--control` hứa (bấm nút thật, đọc state) và mỗi probe chép lại nguyên bộ nối CDP/dọn tiến trình. Lỗ hổng THẬT chỉ là **hộp thoại native** (10 chỗ `dialog.show*` ở `main.js` + 1 ở `updater.js`; renderer không điều khiển được) — trước đây vượt bằng cách nối `--inspect` vào main rồi `eval` (mong manh). Một kênh lắng nghe trong app đóng gói (xử lý hợp đồng) là bề mặt tấn công mới để lấy thứ CDP đã cho; và "lệnh theo tên" của PdfCraft cần command registry mà Nabu chưa có (nút rải rác trong `app.js`) nên chỉ còn là `click #id`.
- **Móc: `src/test-hooks.js`** (+ MỘT dòng ở `main.js`: `if (process.env.NABU_TEST_HOOKS) require("./test-hooks").install({ dialog })`). Vá `showMessageBox`/`showSaveDialog`/`showOpenDialog` trên đối tượng `dialog` dùng chung (phủ cả `updater.js`). Trả lời từ `<NABU_TEST_HOOKS>/answers.json` (hàng đợi theo phương thức; đổi `epoch` ⇒ hàng đợi bắt đầu lại — bộ khung ghi nguyên tử, main chỉ đọc, hai bên không bao giờ cùng ghi một file) và ghi `calls.jsonl`. **Luật an toàn (đừng nới):** (1) đáp án là DỮ LIỆU — chỉ `JSON.parse`, không `eval`/`new Function`/`require` đường dẫn từ file (ghim nguồn); (2) hết đáp án ⇒ **HUỶ** + `unexpected:true`, KHÔNG BAO GIỜ "đồng ý/ghi đè" (kịch bản thiếu đáp án phải làm app không ghi gì); (3) biến môi trường có mà thư mục sai/tương đối ⇒ NÉM LỖI lúc khởi động (fail-closed); (4) luôn in `[test-hooks] ACTIVE` ra stderr. **Bản đóng gói VẪN chứa file này** (`electron-builder` `src/**/*`), nằm im nếu không có biến môi trường; ai đặt được biến môi trường của app thì vốn đã chạy được mã bằng quyền người dùng. **Quyết định cần chủ dự án xác nhận:** chấp nhận móc này nằm trong bản phát hành (đổi lại: test được cả bản đóng gói) hay loại nó khỏi bản đóng gói (`!src/test-hooks.js` trong `files`; khi đó `require` ném và app không lên nếu ai đó đặt biến môi trường).
- **Bộ khung: `desktop/e2e/lib/app-driver.js`** (`launch`, `ready`, `page(i)`, `openPdf`, `setBytesUnrendered`, `dialogs.answer/calls/unexpected`, `workers(flag)`, `close`) + `e2e/lib/fixtures.js` (PDF mẫu bằng pdf-lib) + `scripts/run-e2e.js` (`npm run e2e [-- từ khoá]`; mã thoát 2 = BỎ QUA, "chưa kiểm", không phải xanh). **KHÔNG thuộc `npm test` và KHÔNG là cổng `/deploy`:** cần phiên có giao diện, sidecar `.venv`, và kịch bản Hủy cần corpus ngoài repo (`NABU_CORPUS`).
- **Kịch bản.** `e2e/harness-smoke.e2e.js` (chạy đầu tiên: app lên + sidecar + `visible`; hộp Lưu/Mở trả lời theo kịch bản và file thật ra đĩa; không đáp án ⇒ không ghi + `unexpected`; ảnh chụp; đóng app không để lại tiến trình/thư mục). `e2e/cancel.e2e.js`: nút Hủy của Nén/Tách/Đánh số bấm THẬT trên file không-bao-giờ-xong (đếm worker trước/sau, `/health`, toast không đỏ, tài liệu còn nguyên, không hộp thoại nào) **cộng hai thứ probe cũ không có:** thao tác kế tiếp trên file lành vẫn chạy đến cùng (qua móc hộp thoại cho bước Lưu), và `dialogs.unexpected()` rỗng.
- **BÀI HỌC ĐO LƯỜNG (đắt giá — đọc trước khi tin chữ "treo").** `openPdf` chờ viewer vẽ xong. Đo được **`loadBytes(bomb_giant.pdf)` mất 147.257 ms (~2,5 phút) ngay cả khi cửa sổ `visible`** (pdf.js vẽ trang bom giải nén). Các probe cũ `await` nó KHÔNG hạn giờ nên lặng lẽ chờ hết; mọi lần tôi thử đều bỏ cuộc sớm hơn (hạn 25 s ở các phép chia đôi, 120 s ở e2e) và đọc thành "app kẹt". Tôi đã mất cả một buổi chia đôi driver / móc hộp thoại / `Page.enable` / cổng / biến môi trường / PowerShell — **tất cả đều vô tội**; nguyên nhân là giả định "hết giờ = treo" khi chưa đo. Hệ quả: (a) `setBytesUnrendered` — mở tài liệu nhỏ thật bằng `loadBytes`, rồi THAY `state.bytes` (không vẽ lại) khi cái cần kiểm là thao tác ở sidecar; KHÔNG dùng để kiểm hành vi viewer; (b) mọi số đo "Hủy 0,5 s" ở BI-126/139/140 tính TỪ LÚC BẤM, không gồm bước mở; (c) lời giải thích "cửa sổ ẩn" cho lần kẹt đầu của probe đánh số trang ở BI-140 đã được ĐÍNH CHÍNH (không tách riêng được); (d) viewer mất 2,5 phút để vẽ một file bom là chuyện của pdf.js, chưa được xử lý (không có hạn giờ/nút Hủy ở bước mở) — việc riêng nếu muốn.
- **Bằng chứng.** `test/test-hooks.test.js` 58 ca (`dialog` giả + thư mục tạm thật + ghim nguồn); **đột biến 17/17 đỏ** (lượt đầu lọt 1: đường dẫn tương đối CÓ tồn tại; một mutant "đỏ" chỉ vì sai cú pháp — đã thay bằng mutant hợp lệ). Smoke: đạt trong Electron thật. `cancel.e2e.js`: đạt toàn bộ (Hủy xong ≤ 0,11 s sau khi bấm; worker 2 → 0; `/health` 200). **Lỗi của chính tôi đã sửa:** `test-hooks.test.js` ban đầu để rò ~200 thư mục `nabu-hooks-test-*` trong `%TEMP%` (210 → 210 sau khi sửa; test nay xoá thư mục tạm khi thoát, kể cả khi đỏ).
- **CHƯA / NGOÀI PHẠM VI.** (1) **Chưa đột biến chính các file e2e** (mỗi mutant phải dựng lại cả app; kiểm tính đúng của e2e hiện dựa vào đối chiếu với số đo của probe cũ). (2) **Chưa chuyển** `probe-signed-save.js` (còn dùng `--inspect`) và `probe-images-failed*.js`; ba probe Hủy cũ (`scripts/probe-{compress,split,pagenum}-cancel.js`) được GIỮ cho tới khi chủ dự án yên tâm với `cancel.e2e.js`. (3) **Chưa tự động hoá dòng nào của ma trận §5** ngoài Hủy. (4) Chưa thử trên bản đóng gói; chỉ Windows (`taskkill`, PowerShell). (5) Chưa có móc cho `shell.openExternal`, clipboard, in — thêm khi một kịch bản cần.
- **Vỡ khi:** để móc trả "đồng ý" khi hết đáp án; cho móc đọc đáp án bằng `eval`/`require`; nạp `test-hooks` không điều kiện ở `main.js`; coi "hết giờ ở bước `openPdf`" là treo mà không đo; bỏ ba cờ chống throttle / kiểm `visibilityState` ở `launch`/`ready`; để e2e chạy với `hooks:false` mà vẫn bấm thao tác có hộp thoại (hộp thật hiện ra và chặn).

## 4. Hàm nút thắt (đổi chữ ký = ảnh hưởng diện rộng)

| Hàm | Định nghĩa | Ai gọi |
|---|---|---|
| `toast()` | `app.js:58` | cả 6 module, ~172 chỗ |
| `sidecarFetch()` | `app.js:49` | 4 module (~28 chỗ) — điểm duy nhất gắn token `X-Sidecar-Token` |
| `pushUndo()` / `commitBytes()` | `app.js` | 3 module, 10 chỗ — xem BI-3 (`commitBytes` là đường chuẩn cho code mới, chưa có chỗ gọi nào ngoài test). Phơi ra ngoài bằng **`window.DocHistory`** (`{ pushUndo, commitBytes }`), **không** phải `window.History` (tên đó là constructor của DOM → guard `if (window.History)` không bao giờ sai được) |
| `pdfJsonBody()` | **`wire.js`** | 3 module, 16 chỗ, **gọi bằng tên trần** — xem BI-24 + §2 |
| `renderAll()` | `app.js:486` | 13 chỗ |
| `rerenderChanged()` | `app.js:1138` | **chỉ** module khác gọi — xem BI-14 |
| `updateToolbar()` | `app.js:3084` | 3 module, 11 chỗ — chứa BI-2 và BI-9 |
| `showOverlay/hideOverlay` | `app.js:66/70` | 4 module — xem BI-14 |
| `binArrayJsonBody()` | **`wire.js`** | 1 chỗ — Ảnh→PDF. Cùng luật BI-24, dạng **mảng** binary trong một trường |
| `b64ToU8` | **`wire.js`** | 13 chỗ — chiều **giải mã** cho mọi vòng gọi sidecar. Chiều **mã hoá** cố ý **không còn helper** — xem BI-24 |
| `pushB64Chunks` | **`wire.js`** | 3 chỗ trong `wire.js` + **`editor.js` `managedSrcDataUrl`** (dựng `data:` URL cho MỘT ảnh round-trip). Là bộ mã hoá byte→base64 **duy nhất** được phép dùng; đừng gói lại thành helper tổng quát — BI-24 |
| `stripManagedFromPage(doc, page, trash)` | `editor.js` | 2 chỗ (`stripManagedAnnots`, `bakeWithRedaction`). Tham số `trash` **không phải tuỳ chọn cho vui**: bỏ nó là giải phóng ngay giữa vòng lặp — xem BI-38 |
| `planOpen()` | `tabs.js` | 1 chỗ (`tabs:open-paths`) — quyết định tab hay cửa sổ. Thuần + có lưới, xem BI-35 |

---

## 5. Ma trận “đụng gì → phải test gì”

| Nếu bạn sửa… | Bắt buộc test lại |
|---|---|
| `pushUndo` / `snapshot` / history | Ctrl+Z–Ctrl+Y sau: xoay, xoá trang, ghép, chèn, bake chú thích, sửa nội dung · chấm ● xuất hiện · đóng file bẩn có hỏi |
| `state.bytes` ở bất kỳ đâu | Lưu ra file mở lại được · in · undo · autosave (BI-3) |
| Virtualization / `renderPageCanvas` / `freePageCanvas` | Cuộn nhanh lên-xuống PDF nhiều trang · in · so sánh · copy vùng ảnh (BI-4) · **`m.paintScale` còn được gán sau khi vẽ** (BI-36) |
| Dải thumbnail (`renderThumbs` / `renderThumbCanvas` / `thumb-queue.js`) | `cd desktop ; npm run test:thumbs` · mở một bộ bản vẽ CAD nhiều trang → **trang đầu hiện TRƯỚC khi dải thumbnail vẽ xong**, rồi thumbnail lấp dần và **rõ nét** · mở tài liệu khác ngay giữa lúc dải đang lấp → không trang nào trắng vĩnh viễn · xoay/xoá/chèn trang → thumbnail đúng, không lệch chỉ số (BI-87, BI-5, BI-39) |
| Zoom (`zoomTo`, `applyScaleToDom`, `commitScale`, `wheelZoomFactor`, `renderViewer`) | `cd desktop ; npm run test:geom` · Ctrl+lăn **nhanh liên tục** → trang bám tay, dừng lại ~0.2s là **nét**, không nấc nào bị bỏ · Ctrl+lăn trên A0 nhiều trang → không treo · zoom rồi bôi đen chữ → **vệt chọn đúng chỗ** · Ctrl+F có kết quả rồi zoom → highlight đúng chỗ · zoom **khi đang Chú thích** → hình vẽ/hộp chữ theo đúng tỷ lệ, ô nhập chữ đang mở **không mất** · zoom khi đang “Sửa chữ” → ô span đúng chỗ · Vừa bề ngang / Vừa cả trang / Ctrl+0 · F11 vào/ra · **dải mới 20–500% (v0.2.66):** gõ `500` rồi `20` vào ô zoom → nét, cuộn không đứng máy · gõ `5` / `0` / `999` / `abc` → kẹp về 20 / 20 / 500 / không đổi, **không NaN** · nút ±/Ctrl± bấm **vào rồi ra** cùng số lần → về **đúng** tỷ lệ ban đầu (bước nhân, xem BI-78) · **A0/A1 (bản vẽ CAD) ở 300 → 400 → 500%** → **không được có trang trắng**, và RAM renderer phải **thấp hơn** bản trước · ba nút “Vừa…” trên A0 vẫn xuống được **8%** (sàn 20% không được ăn `FIT_MIN_SCALE`) (BI-36, BI-78, BI-22) |
| Cột trang theo trang đang đọc (`syncThumbFocus`, `nearestScrollDelta`, `.thumb.current`) | `npm run test:geom` · cuộn tài liệu → thumbnail sáng đúng trang & tự trượt vào khung nhìn · **tick chọn vài trang rồi cuộn đi đâu đó → Xoá trang vẫn xoá đúng các trang đã tick** (BI-39, BI-26) · đang kéo sắp xếp trang thì cột **không nhảy** (BI-33) · thu sidebar (F4) rồi cuộn → không lỗi console · F11 → dải trang vẫn sáng đúng trang |
| Ảnh round-trip (`addManagedAnnot` nhánh image, `managedSrcBytes`, `collectManagedChain`, `freeManagedTrash`, `MANAGED_KINDS`) | `cd desktop ; npm run test:managed` · chèn 1 ảnh → Áp dụng → Lưu → **mở lại** → Chỉnh sửa → ảnh **kéo/đổi cỡ/xoá được**, “Áp nhiều trang” vẫn dùng được · lưu 3–4 lần liên tiếp → **cỡ file không phình** · áp 1 chữ ký cho 20 trang → file ~1 lần cỡ ảnh, không 20 · ảnh trên trang **đã xoay** → **cũng sửa lại được** kể từ v0.2.58, xem hàng dưới (BI-59) · xoá ảnh round-trip rồi **thêm ô redact trên chính trang đó** → Áp dụng: ảnh **không** quay lại thành pixel, và ảnh còn lại **không nhân đôi** (BI-37, BI-38) |
| Chữ nhật / elip / **khoanh mây** round-trip (`shapeAppearance`, `VECTOR_KINDS`, nhánh vector của `addManagedAnnot` · `serializeManaged` · `deserializeManaged`, `MANAGED_KINDS`) | `cd desktop ; npm run test:managed ; npm run test:rotate ; npm run test:defaults` · vẽ 1 chữ nhật **viền không nền** + 1 elip **có nền mờ** + 1 **khoanh mây hộp** + 1 **khoanh mây vẽ tay** → Áp dụng → Lưu → **mở lại** → Chú thích → cả hai **chọn/kéo/đổi cỡ/đổi màu/đổi nét/xoá được**, elip vẫn **mờ đúng độ mờ đã lưu** · zoom 400% → viền **nét, không rỗ** (vector, không phải PNG) · so **viền có bị gọt** không ở cả 4 cạnh với nét dày 8pt · lặp trên trang **đã xoay 90/180/270** → không méo, không lệch · Lưu 3–4 lần liên tiếp → **cỡ file không phình** · mở file đã bake bằng **Foxit + Acrobat + Chrome** → thấy đúng chỗ, đúng màu (BI-64) |
| Nền hộp văn bản (`FILLABLE_KINDS`, `fillSlotFor`/`FILL_SLOTS`, `ed.textFill*`, khối `.an-text-bg` trong `renderAnnot`, `fillRect` trong `renderTextPng`, `.an-text { z-index: 0 }`) | `cd desktop ; npm run test:text ; npm run test:managed ; npm run test:defaults` · hộp chữ **nền vàng 100%** trên nền trắng → Áp dụng → Lưu → mở file bằng viewer khác: **mép nền trùng** đúng chỗ trên màn hình · nền **30%** → xuyên thấy nội dung trang, PDF **giống hệt** màn hình · nền + **Mờ chữ 50%** → cả chữ **và** nền cùng mờ ở cả hai nơi · nền + **xoay 45°** → nền quay theo, **không trôi** khỏi chữ · nền + `charScale 60%` → nền ôm đúng bề ngang · Áp dụng → Chỉnh sửa lại → sửa chữ → **nền còn** · Áp dụng → **Đánh số trang** (qua sidecar) → mở lại → nền còn · trang `/Rotate 90` → nền **không méo** · file **cũ** (trước v0.2.64) → hộp chữ vẫn trong suốt, **không tự mọc nền** · chọn hình chữ nhật rồi chọn hộp chữ → ô **Nền** hiện đúng giá trị **của từng loại** (slot riêng) · in (Ctrl+P) → nền in ra (BI-71) · **lượt đầu, đây là ca vỡ của v0.2.64 (BI-75)**: chọn công cụ Hộp văn bản → bấm lên trang → **gõ chữ trước** → rồi mới bỏ tick **Trong suốt** và kéo **Mờ nền** → khung gõ **đổi nền ngay trước mắt**, hộp **không** bị đóng, bấm ra ngoài thì hộp ra **đúng** màu và **đúng** % vừa kéo · đang gõ mà **đổi cỡ chữ / phông / B-I-U / canh lề** → khung gõ đổi theo, **chữ đang gõ còn nguyên** · gõ **giữa từ** rồi kéo Mờ nền → thả chuột là **con trỏ về đúng chỗ đang gõ**, không nhảy xuống cuối · đang gõ mà **đổi công cụ** hoặc bấm **Áp dụng** → hộp **được chốt** như cũ (không được im lặng mất chữ) · mở lại hộp cũ bằng công cụ Hộp văn bản (gõ sửa chữ) → kéo Mờ nền → **chính hộp đó** đổi nền, không phải hộp khác · chọn một hình chữ nhật, đổi sang công cụ Hộp văn bản, kéo Mờ nền → **hình chữ nhật không đổi gì** và **không sinh bước undo rỗng** · chọn hộp chữ **không có nền** → ô màu hiện đúng màu mà bỏ tick sẽ nhận (không phải màu của hình vừa chọn trước đó) · **ô xem trước** cạnh thanh Mờ nền: trắng 30% và trắng 100% **trông khác nhau rõ**, Không nền thì thấy ô caro |
| Ba ô nền (`onFillColorInput`/`onFillNoneToggle`/`onFillOpacityInput`, `setFillOn`, `fillFromCtls`, `clampFillPct`, nhánh `FILLABLE_KINDS` của `syncControls`) | `cd desktop ; npm run test:defaults` · chọn 1 chữ nhật nền **vàng 40%** → tick **Không nền** → bỏ tick → phải ra **lại vàng 40%**, không phải trắng 100% · kéo **Mờ nền** về **0%** → ô **Không nền** phải **tự tick**, chip thành ô caro · bỏ tick khi slider ở 0% → slider nhảy lên **100%** và thấy nền · kéo về 0%, chọn vật thể khác đang 70%, tick rồi bỏ tick, rồi **vẽ hình mới** → hình mới phải **thấy được** · để 1 chữ nhật đang chọn rồi đổi sang công cụ **Hộp văn bản**, kéo Mờ nền → chữ nhật **không đổi** và **không** ăn bước hoàn tác (BI-75) · gõ chữ trong hộp mới, kéo Mờ nền → khung gõ đổi màu, **không mất chữ** · đổi tool Hộp văn bản ↔ Chữ nhật → ba ô hiện đúng bộ **của từng loại** · đổi VI↔EN → nhãn **Không nền** dịch đúng (BI-76) |
| Trang ẩn có khoá (`renderer/page-vault.js`, `scanVaultPages`, `hidePagesWithPassword`, `unhidePagesWithPassword`, `exportWithoutHiddenPages`, `#vault-modal`) | `cd desktop ; npm run test:vault` · **ba ca không được phép đỏ**: ẩn → **kéo thả sắp xếp trang** → bỏ ẩn được (BI-72) · ẩn → **chú thích lên trang giữ chỗ → Áp dụng** → bỏ ẩn được (BI-72) · ẩn xong mở thư mục recovery trong `userData` → **không còn bản rõ** (BI-74) · ẩn → Lưu → đóng app → mở lại → bỏ ẩn được · ẩn → **Đánh số trang** → bỏ ẩn được (BI-73) · ẩn → **Nén file** → bỏ ẩn được · ẩn → khoá cả file bằng mật khẩu (`/encrypt`) → mở khoá → bỏ ẩn được · ẩn → **In** → in ra trang giữ chỗ, không phải nội dung gốc · mở file có trang ẩn bằng **Acrobat/Chrome** → thấy trang giữ chỗ, **không đọc được** nội dung, file không lỗi · tách/trích trang giữ chỗ ra file mới → bỏ ẩn được ở file mới · chuyển trang giữ chỗ **sang tab khác** → blob đi theo · sai mật khẩu → hỏi lại, **tài liệu không đổi** · badge 🔒 và dòng “N trang đang ẩn” đúng sau mỗi lần xoá/ghép/sắp xếp trang |
| Tay nắm đổi cỡ (`resizeRect`, `scalePts`, `RESIZABLE_KINDS`, `canResize`, `.handle.h-*`) | `npm run test:geom ; npm run test:shape` · kéo **cả 4 góc** của ảnh/tô sáng/redact/chữ nhật/elip → góc đối diện **đứng yên** · **giữ Shift** → không méo · Esc giữa lúc kéo → về đúng vị trí+cỡ cũ · Ctrl+Z sau khi đổi cỡ · bấm vào tay nắm rồi **không kéo** → không tạo bước undo rỗng · **từ v0.2.71 làm thêm cho hình dạng-điểm**: kéo 4 góc của **nét vẽ tay**, **mây tự do** và **hình tự do** → giãn đều, **độ dày nét không đổi**, `bump` của mây không đổi · kéo một nét **ngang tuyệt đối** → không biến mất, không NaN · kéo dài (rê qua lại nhiều lần rồi về chỗ cũ) → hình **về đúng cỡ cũ**, không trôi (BI-89) |
| Tô sáng theo chữ (`quadsFromRects`, `captureTextHighlight`, nhánh `texthl`, `body.editing.tool-texthl`) | `cd desktop ; npm run test:shape ; npm run test:managed ; npm run test:rotate ; npm run test:defaults` · bôi đen **5 dòng tiếng Việt có dấu**, bắt đầu và kết thúc **giữa dòng** → vệt bám sát chữ, **sắc độ đều**, không dòng nào đậm gấp đôi (BI-88) · zoom 50% → 400% → vệt vẫn bám chữ · trên **trang scan** → không chọn được chữ, không tạo vật thể, không lỗi console · chọn **vắt qua 2 trang** → hai vệt, một Ctrl+Z gỡ cả hai · Đang ở công cụ này → **không** chọn được vật thể (đúng luật); về **Chọn** (`V`) → chọn/xoá được ngay · Áp dụng → Lưu → **mở lại** → vệt còn đó và **chọn/xoá được**, **chữ dưới vệt không bị bạc** · mở file đó bằng **Foxit/Acrobat** → hiện trong danh sách chú thích, kèm đoạn chữ · lặp trên trang **đã xoay 90/180/270** → đúng chỗ · tô sáng **hình chữ nhật** (`H`) cũ → cũng phải **hết bạc chữ** sau khi Áp dụng (cùng một nhánh) |
| Hình tự do (`poly`) và bộ máy đa giác dùng chung (`PEN_TOOLS`, `canClosePts`, `closePoly`/`cancelPoly`, `polyPath`, nhánh `poly` của `shapeAppearance`) | `cd desktop ; npm run test:shape ; npm run test:cloud ; npm run test:managed ; npm run test:rotate` · **hồi quy trước**: **Khoanh mây tự do** (`F`) vẽ bằng **cả hai** cách (kéo / bấm từng điểm), đóng bằng điểm đầu / `Enter` / bấm đúp, `Esc` huỷ — **y như cũ** · rồi `poly`: bấm 5 điểm → `Enter` → **đóng kín**, tô **nền 60%** → nền đúng · bấm 3 điểm → `Esc` → **để hở**, chỉ có nét, **không** tự tô nền · đổi từ `poly` sang `cloudpen` **giữa lúc đang bấm điểm** → hình dở dang bị bỏ, không sót · kéo từng **chấm tròn** đổi hình; một `Ctrl+Z` trả lại · copy → dán sang **tab khác** → đúng màu/nền · Áp dụng → Lưu → mở lại → **sửa tiếp được**, zoom 400% vẫn **nét** (vector) · lặp trên trang **xoay 90/180/270** → không méo, không lệch `pad` (BI-64) |
| `editor.js` bake | Chú thích → Xong → sửa lại được · số trang không đổi · comment panel còn đúng (BI-5) |
| Cổng bake (`exit()`, `bakePending()`, `hasUnsaved`, `ed._importedManaged`) hay `openTextEditor` | `cd desktop ; npm run test:managed` · **đường xoá, làm trên tài liệu chỉ có ĐÚNG MỘT chú thích** (đó là ca vỡ): tạo hộp văn bản → Xong → Lưu → vào Chú thích → `Delete` → Xong → hộp **mất thật**, mở lại file vẫn mất · lặp lại nhưng thay `Delete` bằng **xoá trắng nội dung rồi bấm ra ngoài** → hộp mất, chữ cũ **không** hiện lại · lặp lại nhưng bấm **Ctrl+S** thay vì Xong → cũng mất · xoá hết rồi **đóng app** → **có** hỏi lưu · xoá 1 trong 2 hộp → hộp còn lại **nguyên vẹn**, không nhân đôi (BI-60) |
| Đặt `/AP` trên trang xoay (`apMatrixFor`, `apRectFor`, `apRotatable`, `normAngle`, ba nhánh `/AP` của `addManagedAnnot`) | `cd desktop ; npm run test:rotate ; npm run test:managed` · `docs/SPEC-annot-rotated.md` §7 lưới tay: với **cả 4 góc** `/Rotate` × {hộp chữ, mũi tên, ảnh, ghi chú} → bake → **Xong** → mở lại Chú thích → **sửa/kéo/xoá được**, không méo, không lệch 90° · re-bake 3 lần → **không** thành hai con dấu, file không phình · mở file đã bake bằng **Foxit + Acrobat + Chrome** → thấy đúng chỗ · và **hồi quy quan trọng nhất**: một tài liệu 0° bake rồi lưu phải ra **byte y hệt** bản trước (BI-59) |
| Ảnh → PDF (`runImagesToPdf`) và **giá trị trả về của `loadBytes`** | Ảnh→PDF → kết quả **mở ra trong app** (không bắt Lưu trước), có chấm ● · sắp xếp lại trang / xoay / chú thích được · Ctrl+S → hiện hộp thoại **Lưu thành** · đang có tài liệu **bẩn** rồi chạy Ảnh→PDF → chọn **"Ở lại"** thì **vẫn được hỏi nơi lưu** file vừa tạo (không mất công convert) · đóng app khi chưa lưu → **có** cảnh báo |
| Hướng trang trong bake (`vp1` trong vòng lặp của `bakeInPlace`/`bakeWithRedaction`, `makeMap`, `pageRotate`) | `cd desktop ; npm run test:rotate` §7 · **ca vỡ là tài liệu TRỘN HƯỚNG**: ghép 1 file có trang **A4 dọc** + trang **A3 ngang** (`/MediaBox` rộng, `/Rotate 0`) + trang **dọc đã Xoay 90°** → khoanh mây / chữ nhật trên **từng** trang → Áp dụng → mọi hình **đứng yên đúng chỗ**, **không trang nào tự quay**, khổ giấy không đổi · lặp lại kèm **che thông tin** trên trang ngang (đường raster dựng trang mới) → tờ ngang **vẫn nằm ngang** · in thử: số tờ không tăng (BI-65, BI-45) |
| Tầng tab/cửa sổ (`main.js`, `tabs.js`) | Toàn bộ `docs/TABS-TEST-L1.md` (24 mục) |
| Tách tab / kéo tab (`detachTab`, `adoptTab`, `classifyDrop`, `shell.js` dragend) | `docs/TABS-2B-DESIGN.md` §6.2 (18 mục) · BI-15/16/17 · **mục #1 là hồi quy của tính năng sắp xếp tab** |
| Chuyển trang giữa 2 tài liệu (`renderer/page-move.js`, `classifyPageDrop`, `docViewScreenRect`, `routePages`, `pages:*`) | `cd desktop ; npm run test:pagedrop` · `docs/SPEC-page-drag.md` §7.1 (22 mục) · BI-55/56/57/58 · **mục #1 và #2 là hồi quy của kéo-sắp-xếp trang và kéo file PDF vào cột trang** — hai thứ đã chạy tốt từ v0.2.41 mà tính năng này gắn thêm việc lên đúng cùng một cử chỉ |
| Clipboard vật thể **liên-tab/liên-tài-liệu** (`objClip` + `annots:clip-*` ở `main.js`, `writeAnnotClip`/`readAnnotClip`/`onAnnotClipChanged` ở `preload.js`, `SHARE_EXCLUDED`/`isShareableKind`/`shareClip`/`adoptSharedClip`/`requestPaste` ở `editor.js`) | `cd desktop ; npm run test:clip ; npm run test:managed ; npm run test:text` · **ca vỡ nguy hiểm nhất là hồi quy của dán-ảnh**: copy một vật thể trong Nabu, **sau đó** copy một **ảnh** ở app khác, rồi `Ctrl+V` ở tab đang có clip vật thể → phải dán **ảnh**, **không** dán vật thể (luật bàn giao với `capture.js` — BI-77; từ v0.2.72 là "lần copy gần nhất thắng", nên thứ tự copy là **bắt buộc** trong ca này) · copy 1 hộp văn bản ở tab A → `Ctrl+V` ở tab B → **đúng vị trí, đúng cỡ chữ, đúng màu, đúng nền** · copy ở A → **Áp dụng** ở A → dán ở B (clip sống sót bake) · copy ở A → **xé tab B ra cửa sổ riêng** → dán được · copy ở A → **mở tab C mới** → dán được (đường `readAnnotClip` lúc khởi động) · dán vào tab **chưa bật Chỉnh sửa** → tự bật rồi dán, có toast · chọn nhóm Ctrl+click 3 mục → dán sang B **giữ nguyên cự ly tương đối** · dán sang trang **nhỏ hơn** ở B → cả nhóm lùi vào trong tờ, **không rời ra** · dán **hai lần liên tiếp** ở B → bản thứ hai lệch 12pt (không nấp lên nhau), bản **thứ nhất không lệch** · dán sang trang **đã xoay 90/180/270** ở B → Áp dụng → Lưu → mở lại: đúng chiều, đúng chỗ · copy **ảnh** ở A (kể cả ảnh vừa dán từ ảnh chụp màn hình) → `Ctrl+V` ở B → **có ảnh, đúng cỡ đã chỉnh** (v0.2.72, BI-77) · chụp màn hình → dán vào A → chỉnh cỡ → `Ctrl+C` → `Ctrl+V` **ngay trong A** → ra **bản đã chỉnh**, không phải ảnh chụp gốc · copy nhóm **ảnh + hộp chữ** ở A → B nhận **cả hai** · copy **vệt tô sáng** ở A → B không nhận, toast nói rõ · đóng hết tab trừ một → clip cũ **không** làm app lỗi |
| Chia đôi màn hình (`splitRects`/`solveWidths`/`_rects`/`viewPaneScreenRects`/`addViewPane`/`setPaneRatios` ở `tabs.js` · `sendFileToPane`/`view:*`/`split:*` ở `main.js` · `renderer/view.*` · `src/view-preload.js` · `#split`/`#gutters` ở `shell.*`) | `cd desktop ; npm run test:split ; npm run test:pagedrop ; npm run test:tabs` · **ba ca hồi quy phải làm trước**: app **không** chia khung phải y hệt bản cũ (chrome đúng 40px, tab chiếm hết) · `Ctrl+\` rồi **đổi tab** → tab mới nằm gọn trong khung chính, **không đè** khung xem · `Ctrl+\` rồi **kéo tab sang cửa sổ khác** / **xé tab ra** → không mất khung xem, không lỗi console (BI-79) · mở **cùng một file** ở cả hai khung → sửa + `Ctrl+S` ở khung chính → khung xem **tự nạp lại**, **giữ nguyên trang đang đọc** và chip "bản lưu HH:MM" đổi giờ · **kéo rãnh** hết cỡ sang trái → khung chính dừng ở sàn, tay nắm **không rời khỏi biên thật**; Alt-Tab **giữa lúc kéo** → phiên kéo kết thúc, không kẹt (BI-58) · bấm **tên file** trên khung xem → menu native có "Cùng tài liệu khung chính" + các tab + "Mở file khác…" · đổi khung xem sang file khác → nút **Sửa file này** hiện; bấm → file đó sang khung chính, tài liệu cũ sang khung xem · **kéo trang từ cửa sổ khác thả vào khung xem** → toast từ chối, **không** im lặng, và **không** chèn nhầm vào tài liệu phía sau (BI-80) · file **có mật khẩu** ở khung xem → dòng nhắc "hãy mở ở khung chính", không treo · file có **trang ẩn** (`/NabuVault`) ở khung xem → hiện **trang giữ chỗ** (đúng, không phải lỗi — BI-72) · bản vẽ **A0/A1** ở khung xem → **không trắng trang** (BI-78 dùng chung `raster-cap.js`) · `Ctrl+S` / **In** / `Ctrl+Z` khi đang chia khung → **luôn** tác động lên khung chính · `Ctrl+\` lần nữa → đóng hết, nút ◫ tắt, rãnh biến mất · **đóng app rồi mở lại** → bố cục chia khung **và** tỷ lệ rãnh quay lại (BI-81) · nâng cấp từ bản cũ → **phiên cũ không bị mất** (BI-81) |
| Bộ lọc chia sẻ clipboard (`SHARE_EXTRA`/`SHARE_EXCLUDED`/`isShareableKind` ở `editor.js`) | `cd desktop ; npm run test:clip` · copy **dấu ✓** ở file A → `Ctrl+V` ở **tab khác** và ở **cửa sổ khác** → sang được, đúng màu/cỡ/vị trí · copy **✗ + hộp văn bản** cùng lúc → **cả hai** sang · copy **✓ + ảnh** cùng lúc → **cả hai** sang (v0.2.72) · ở file đích bấm **Xong** → lưu → mở lại: dấu ✓ nằm trên trang và **không chọn lại được** (đúng BI-42, không phải lỗi) · toast sau khi copy gọi tên **tiếng Việt** ("1 dấu tích ✓"), không phải `check` (BI-82) |
| Khôi phục phiên (`src/session.js`, `snapshotSession`, `_closing`, `tab:reserved`) | `docs/SESSION-RESTORE.md` §5.3 (14 mục) · BI-18/19/20 · **mục #12 là hồi quy của khôi phục sự cố** |
| Guard đóng | BI-6: nút X vs menu Thoát vs Ctrl+Q — cả 3 đường |
| Recovery/autosave | BI-7: mở 2 tab, chỉ tab đầu được hỏi khôi phục · **BI-137:** `cd desktop ; npm run test:recoveryatomic ; npm run test:atomic` · sập giữa lúc autosave ⇒ bản cũ còn khôi phục được · ẩn trang ⇒ khe phục hồi không còn bản rõ (BI-74) |
| `uiConfirm` (nhất là `thirdText`) hay lời mời khôi phục (`checkRecovery`) | `cd desktop ; npm run test:confirm` · chọn **Để sau** → lần mở sau **vẫn hỏi** (đúng) · chọn **Xoá, không hỏi lại** → lần mở sau **im hẳn** · nhãn nút phải ghi đúng **số bản** sẽ xoá · ngay sau đó mở một hộp thoại yes/no khác (vd đóng file bẩn) → **không** được thấy nút thứ ba sót lại · `Esc` / bấm nền / ✕ trên hộp có 3 nút → vẫn là **Hủy**, không phải nút xoá |
| Thêm nút tính năng mới | BI-9: khoá bản quyền có ăn không · BI-10: đổi VI/EN không mất chữ · **và ghi cử chỉ / phím tắt của nó vào `SECTIONS` của `help.js`** — thanh công cụ không còn chỗ để chữ hướng dẫn (BI-41) |
| Trang Hướng dẫn (`renderer/help.js`, `#help-modal`, khối `.help-*` trong `app.css`) | `cd desktop ; npm run test:help` · mở bằng **cả 3** đường: menu **Trợ giúp**, **F1**, nút **?** · bấm từng mục lục · ô tìm gõ **không dấu** ("mui ten") vẫn ra đúng phần · đóng bằng **Đóng / Esc / bấm nền** · đổi **VI↔EN** (cả nhãn menu native) · đổi theme **Sáng** · mở **trong lúc đang Chú thích** có 1 mục đang chọn rồi bấm `Delete` → mục **không** bị xoá (BI-47) |
| `#ed-hint` / `setEdStatus` / `#te-hint` | BI-41: **không** đặt câu hướng dẫn vào đây · thu cửa sổ về 1024px ở công cụ *Khoanh mây* → thanh **không** phình, nút **Xong** còn bấm được · vẽ mây từng điểm → có dòng nhắc cách đóng; đổi công cụ → ô **trắng** · công cụ Đo → thấy `Tỷ lệ: chưa/đã hiệu chuẩn` đúng trạng thái |
| Menu gốc (`buildMenu` ở `main.js`, `menuBlockReason`/`menuDisabledReason`/`clickToolbarFor`/`onMenuCommand` ở `app.js`) | `cd desktop ; npm run test:menu` · BI-105 · **mỗi mục mới**: bấm khi chưa mở file / khi đang Chú thích / khi engine chưa sẵn sàng / khi bản quyền chưa kích hoạt (Công cụ, Xuất, Ký số, Chú thích ⇒ hộp kích hoạt; Trang ▾ miễn phí ⇒ không) · đang **Chú thích** và đang **Sửa nội dung** → menu Trang → Xoay/Xoá/Ghép/Chèn/Tách/Thay ⇒ toast “Bấm Xong…”, số trang không đổi · mở Cài đặt → menu Xoá ⇒ “Đóng hộp thoại…” · chưa mở file → Ghép/Chèn ⇒ “Mở PDF trước.”, **không** hiện hộp chọn file · chưa mở file → Ảnh → PDF **vẫn mở** · đang chỉnh sửa → Phóng to vẫn chạy · đổi VI↔EN → toast từ chối đổi theo |
| Menu chuột phải trên thumbnail (`openThumbMenu`) | BI-26 · chuột phải **ngoài** vùng đang chọn → chỉ chọn trang đó · chuột phải **trong** vùng đang chọn → giữ nguyên nhiều trang · đang Chú thích/Sửa nội dung → **không** ra menu · chọn hết trang → mục Xoá phải mờ |
| Thay trang (`replacePlan`/`replaceInDoc` ở `page-range.js`, `askReplaceSpec`/`replaceSelectedWith` ở `app.js`, `#replace-modal`) | `cd desktop ; npm run test:pages` · BI-90 · chuột phải trang 3 → Thay… → file 5 trang → **Tất cả** → tài liệu +4 trang, trang mới ở vị trí 3–7 · chọn trang 2–4 → Thay → `3, 1` → dòng tóm tắt ghi đúng số trang còn lại, trang mới theo thứ tự **1, 3** · chọn trang 1 **và** 3 → mục Thay **mờ** · thay **mọi** trang → không lỗi · bấm vào ô khoảng trang → radio tự chuyển *Chỉ các trang* · `Esc` → không đổi gì · file nguồn có mật khẩu → báo ngay, không mở hộp thoại · `Ctrl+Z` → về nguyên bản · thay một **trang ẩn** → hỏi xác nhận · đang Chú thích → menu Trang không thay được |
| Chữ ký lưu sẵn (`src/signatures.js`, `sig:*` ở `main.js`, `renderer/signatures.js`, `renderer/sig-image.js`, `placeSignature` ở `editor.js`) | `cd desktop ; npm run test:sig ; npm run test:clip` · BI-91 · Cài đặt → Chữ ký của tôi → thêm **ảnh scan JPG nền trắng** → "Xoá nền trắng" **tự tick**, xem trước nền caro, kéo Độ mạnh → nét không mất · thêm **PNG nền trong** → "Xoá nền trắng" **không** tick · Lưu → đóng app → mở lại → còn · chuột phải lên trang (chế độ xem **và** Chú thích) → "Chèn chữ ký: tên" có ảnh nhỏ → chữ ký **giữa chỗ bấm** · đổi cỡ → Xong → lần chèn sau **đúng cỡ đó** · nút chữ ký trên thanh Chú thích → chọn → bấm trang · chép `signatures.bin` sang **tài khoản Windows khác** → báo không đọc được, **không** xoá, "Tạo kho mới" giữ file cũ bên cạnh · công cụ **Ảnh** thường → vẫn 240pt, góc trên-trái tại điểm bấm (không hồi quy) · đổi **VI↔EN** |
| `page-range.js` hay hộp thoại xoá theo khoảng | `cd desktop ; npm run test:pages` · gõ “từ 5 đến 12, trừ 7” trên tài liệu thật → trang 7 **còn nguyên** · Ctrl+Z quay lại đủ trang (BI-27, BI-3) |
| Hộp thoại “Áp ảnh / chữ ký cho nhiều trang” (`imgPagesSpec`, `syncImgPages`) | `npm run test:pages` · chèn 1 ảnh rồi Áp nhiều trang: gõ `1-3` → dòng gợi ý ghi đúng “Sẽ áp sang N trang: …” và nút Áp dụng **mở** · dán `1–3` (gạch en, copy từ Word) → **vẫn nhận** · gõ `abc` → “Chưa nhận ra trang nào”, nút Áp dụng **khoá** · gõ đúng số trang ảnh đang nằm → “Chỉ có đúng trang ảnh đang nằm”, nút **khoá** · gõ số lớn hơn số trang → gợi ý cho thấy nó **kẹp về trang cuối** trước khi bấm · Ctrl+Z hoàn tác được (BI-27, BI-10) |
| Tên file gợi ý khi Tách trang (`extractFileName`) | `npm run test:pages` · mở PDF ≥200 trang → Chọn tất cả bỏ 1 trang → Tách → tên trong hộp thoại Lưu **ngắn, đọc được**, lưu thành công (BI-27) |
| Khối `@media print` của `app.css`, `.print-sheet`, `buildPrintPages`, `printScaleFor` | `cd desktop ; npm run test:print` · **đếm TỜ, không tin mắt**: in ra "Microsoft Print to PDF" tài liệu 4 trang với Khổ giấy **A4, rồi A3, rồi Letter** → mỗi lần đúng **4 tờ**, tờ nào cũng thấy đủ 4 mép trang · lặp lại với **tick "Mở hộp thoại máy in của hệ thống"** → vẫn 4 tờ · gõ `1-2` ở hộp thoại hệ thống → ra **trang 1 và trang 2**, không phải trang 1 hai lần · PDF **A0** nhiều trang → không treo, không hết bộ nhớ (BI-43) |
| Hộp thoại In — ô "Trang cần in" (`printPageIndices`, `syncPrintPages`, `#print-pages`) | `npm run test:print` · để trống → gợi ý "Sẽ in tất cả N trang", nút In **mở**, in đủ cả tài liệu · gõ `1-2` → chỉ 2 tờ · dán `1–2` (gạch en) → **vẫn nhận** · gõ `abc` → nút In **khoá** · gõ `99` trên tài liệu 4 trang → gợi ý cho thấy nó **kẹp về trang 4** trước khi bấm · in xong mở lại hộp thoại → ô **trống lại** · đổi VI↔EN lúc đang gõ → dòng gợi ý **không** bị ghi đè (BI-44, BI-27, BI-10) |
| Badge trạng thái (`renderSidecarBadge`, `setApiBadge`, `/config`) | Mở app lúc engine chưa lên → OCR chấm rỗng, API “…” · engine lên & chưa có key → API chấm rỗng vàng · nhập key → chuyển xanh **ngay**, không cần khởi động lại · bấm badge API → mở Cài đặt đúng ô nhập · đổi VI↔EN → cả hai badge đổi theo (BI-29) |
| Bất kỳ điều kiện nào đọc `Editor.active` / `TextEdit.active` | Vào Chú thích rồi bấm ↑/↓/PageUp/PageDown/Delete → **không** có lỗi trong console, trang không bị xoá · thoát Chú thích → Delete xoá lại được (BI-28) |
| Menu ngữ cảnh dùng chung (`showPageMenu` trong `capture.js`) | Chuột phải lên **trang PDF** (Sao chép ảnh/vùng/Dán) vẫn đúng · mở menu này rồi mở menu kia → menu cũ đóng · cuộn dải thumbnail → menu đóng |
| Chiều vẽ lại chữ (`_text_frame`, `theta`/`u_dir`/`n_dir`, `morph`, trường `dir` của `/text-spans`·`/text-find`·`TextEdit`, `ed.dir` ở `text-edit.js`, `dir` ở `editForSpan`) | BI-66 · `.venv\Scripts\python test_edit_text_rotate.py` · rồi **test tay trên bản vẽ `/Rotate 90` thật** (bộ hồ sơ thầu/CAD): **Sửa nội dung** một dòng đọc xuôi → chữ mới **đọc xuôi**, thẳng hàng với dòng bên cạnh · sửa một **nhãn kích thước dựng dọc** → vẫn **dựng dọc**, cùng chiều với nhãn kế bên · **Ctrl+H → Thay tất cả** → mọi chữ thay thế đúng chiều của chỗ nó thay · sửa một đoạn **rất ngắn** (2–3 ký tự) trên trang xoay → **không** bị nén lại · bật **gạch chân** → gạch nằm **dưới** chữ, cùng chiều · lặp lại trên trang **không** xoay để chắc không có gì dịch đi (BI-66, BI-25, BI-45) |
| Cỡ/hình học chữ vẽ lại (`hscale`, `vscale`, `orig_text`, `orig_size`, `_bbox_is_size_fallback`, `_page_font_programs_exact`) | `test_edit_text_metrics.py` · sửa 1 dòng trên hoá đơn thật → **không** dài ra đè chữ bên cạnh, **không** cao hơn dòng chưa sửa · **và** trên bản vẽ PDFsharp (khung tên) → số hiệu thay vào **cao bằng** `DAOL.` đứng cạnh, không thấp/bè (BI-25) |
| "Khớp nguyên mã" (`code_boundary` của `_find_occurrences` / `/text-find(-bin)`) | `.venv\Scripts\python test_text_find.py` (C1–C7c) · mặc định **tắt** ⇒ Ctrl+H không đổi gì · trên bộ bản vẽ khách: `I1` + khớp nguyên mã = 25 chỗ (đủ 12 số hiệu `I1_BD-S-…`), **không** khớp `I10`/`I11`/`PI1`; "Đúng nguyên từ" chỉ ra 13 (coi `_` là chữ — cố ý giữ nguyên) |
| Hộp chữ cố định bề rộng (`boxW`, `wrapItemsPt`, drag `"textbox"`, `#fmt-wrap`) | BI-104 · `npm run test:text` **và** `npm test -- rotate managed bake-split` · **test tay**: Chú thích → T → **bấm** → gõ dòng dài → vẫn 1 dòng (như cũ) · **kéo** khi đặt → gõ → xuống dòng theo khung · chọn hộp → kéo tay nắm → dòng đổi, cao tự giãn · Xong → mở lại file → **cùng** chỗ ngắt · mở file **cũ** có hộp chữ → **không** đổi gì · hộp xoay → không có tay nắm · tiếng Việt có dấu sát mép phải |
| Căn đều hộp chữ (`justifiedDisplayLines`, `isLastOfPara`, `renderJustifiedLines`, `.an-text-line`) | BI-106 · `npm run test:text` (nhóm J) · **test tay**: Chú thích → T → **Căn đều** → kéo hộp ~240 pt → gõ 2 đoạn tiếng Việt → Ctrl+Enter: mọi dòng trừ dòng cuối mỗi đoạn **thẳng mép phải** · hộp thường nhiều dòng có dòng trống → dòng trống còn nguyên · Xong → mở lại file → **cùng** hình · đổi sang Căn trái → về như cũ |
| Bảng Định dạng: thu gọn (`#fmt-collapse`, `FMT_COLLAPSED_KEY`) / Bề rộng khung (`#fmt-boxw`) | BI-107 · `npm run test:fmtpanel` · **test tay**: Chú thích → T → bảng mở rộng → bấm **›** → dải hẹp, trang lộ ra · đóng app → mở lại → T → bảng vẫn thu gọn · bấm lại → mở · kéo hộp chữ ~240 pt → chọn → ô Bề rộng khung = 240 · gõ 150 → hộp hẹp, nhiều dòng hơn · Ctrl+Z → 240 · xoay 90° → gõ 120 → đổi dòng · Xong → mở lại file → cùng chỗ ngắt · hộp thường → ô tắt |
| Bảng Định dạng: Ký tự đặc biệt (`#fmt-symbols`, `ed._taInsert`) / kiểu mặc định (`#fmt-set-default`, `#fmt-clear`, `pickTextDefault`, `TEXT_DEFAULT_LS`) | BI-108 · `npm run test:fmtpanel` + `test:text` (nhóm T) · **test tay**: T → bấm trang → gõ "m" → bấm ² → gõ tiếp: ô không đóng · Ctrl+Z trong ô → mất ² · Xong → mở lại file → ² còn đúng (không ô vuông) · chọn hộp → cỡ 24 + Đậm + Căn giữa → Đặt làm mặc định → hộp mới đúng kiểu, **màu không đổi** · đóng app → mở lại → hộp mới vẫn kiểu đó · chọn hộp → Xoá định dạng → về 16/thường/trái, giữ màu/nền/xoay · Ctrl+Z → về lại · mở file **cũ** → hộp chữ không đổi |
| Viền khung hộp chữ (`borderColor/Width/Dash`, `normTextBorder`, `textRasterGeom`/`textRasterBoxPt`, `.an-text-border`, `writeBorder`) · Sao chép / Dán định dạng (`copyTextFormat`, `applyTextFormat`, `fmtClip`, Ctrl+Shift+C/V) | BI-109 · `npm run test:text` (V, F) + `test:fmtpanel` (P5, B) + `npm test -- managed` (raster + round-trip) · **test tay**: chọn hộp chữ → Viền quanh hộp chữ → đỏ 2 pt → Xong → mở lại file: viền **đúng chỗ, cùng độ dày** · nét đứt + Co giãn ngang 60% → cạnh dọc không mảnh hơn cạnh ngang · hộp đã xoay có viền → Xong → so · mở file **cũ** → không hộp nào có viền · Ctrl+Shift+C một hộp → Ctrl+click 2 hộp khác → Ctrl+Shift+V → đúng kiểu, góc xoay/bề rộng giữ · Ctrl+Z một lần → cả hai về · nhóm có cả hình vuông → hình vuông không đổi · FreeText từ Acrobat → ô Viền tắt |
| Tâm xoay hộp chữ (`textRotationPivot`, khối `if (st.rot)` của `renderAnnot`, `if (existing && st.rot)` của `openTextEditor`) | BI-110 · `npm run test:text` (X) + `npm test -- managed` (pivot) · **test tay**: hộp chữ 48 pt có Viền → xoay 90° → nhớ chỗ khung trên màn hình → Xong → **mở lại file** (hoặc xem bằng Foxit) → khung **cùng chỗ** · lặp 30°, 180° và với Co giãn ngang 60% · bấm đúp hộp xoay → ô gõ **không nhảy** khỏi chữ · hộp không xoay → không đổi gì |
| Ô gõ hộp chữ: ResizeObserver + `pressed` (`openTextEditor`, `userResized`) | BI-111 · `npm run test:taresize` · **test tay**: Chú thích → T → **bấm** lên trang → gõ vài chữ → bấm **Đậm**, đổi **cỡ** 24, đổi **font** → Ctrl+Enter → chọn hộp: "Tự xuống dòng theo khung" **không** tick, hộp vừa khít chữ · **kéo góc** ô gõ của hộp thường → thành hộp cố định (đúng BI-104) · kéo góc thu hẹp, nhả chuột **ngoài** ô gõ → vẫn nhận |
| Cỡ nhãn mũi tên / đường đo (`normLabelSize`, `applyLabelSize`, `#ed-labelsize`, mọi `labelSize \|\| 14`) | BI-112 · `npm run test:labelsize` + `test:annot-geom` · **test tay**: Chú thích → Mũi tên: ô **Cỡ nhãn** = 14 → đặt 28 → vẽ mũi tên, gõ nhãn → chữ to · chọn mũi tên → ô hiện 28, gõ 10 → chỉ mũi tên đó đổi, Ctrl+Z về 28 · Đo: đặt 20 → số đo to · Xong → nhãn trong file đúng cỡ trên màn hình · mở lại Chú thích → mũi tên vẫn 28 |
| Ô Nét (`PEN_WIDTH_KINDS`, handler `ed-penwidth`, `syncControls`) | BI-113 · `npm run test:penwidth` · **test tay**: Đo → kéo một đoạn → Chọn đoạn đó → Nét 6 → đường + 2 vạch dày lên · Ctrl+Z về 1 · Xong → file đã lưu nét 6 |
| Sửa nội dung — Căn lề / Gạch ngang (`api.py` `edit_text` `align`/`strike`, `_insert_line_pitch`; `text-edit.js` `#te-align`, `#te-strike`) | BI-114 · `test_edit_text_align.py` + `npm run test:teformat` + toàn bộ `test_edit_text_*.py` · **build lại sidecar** · **test tay**: Sửa nội dung → bấm số trong cột căn phải → gõ số dài hơn → Căn phải → Áp dụng → mép phải không đổi · tiêu đề căn giữa → giữ tâm · S trên một dòng → gạch giữa chữ · sửa KHÔNG chọn căn lề → như trước |
| Sửa nội dung — nút định dạng khi ô gõ đang mở (`onControlChange`, `beginEdit` `before` / `cancel`) | BI-115 · `npm run test:teformat` · **test tay**: Sửa nội dung → bấm một đoạn → gõ vài chữ → bấm **B** → ô gõ còn mở, gõ tiếp được → Enter → Áp dụng → đủ chữ · bấm đoạn khác → B → **Esc** → đoạn đó không bị tính là đã sửa |
| Xoay / lật ảnh (`annot-geom.js` `imageXformed`/`imageCorners`/`imageCm`/`imageBounds`/`imageOp`/`resizeRotated`/`rotateDragAngle` · `serializeManaged`/`deserializeManaged` nhánh image · `addManagedAnnot` + `drawOneAnnot` nhánh image · `renderAnnot` ảnh, `.handle.h-rot`, `onDown`/`onMove`/`cancelDrag` nhánh `rotate`, `applyImageOp`, mục menu chuột phải, `applyImgPages`) | BI-116 · `cd desktop ; npm run test:imgxf ; npm run test:rotate ; npm run test:managed ; npm run test:cloud` · **hồi quy quan trọng nhất (BI-59):** ảnh **chưa chạm** bake ra **byte y hệt** bản trước (dựng harness sha256 trên HEAD cũ và mới, ảnh thường ở trang 0/90/180/270 + phẳng + chế độ che) · **test tay**: chèn ảnh nhiều màu (4 góc khác màu) → kéo **núm** trên đầu ảnh sang trái → xoay ngược chiều kim đồng hồ, giữ **Shift** nhảy 15°, **Esc** giữa chừng về góc cũ, Ctrl+Z lùi đúng một bước · kéo 4 góc ảnh **đang xoay** → góc đối diện đứng yên · chuột phải → Xoay trái/phải 90°, Lật ngang/dọc (ảnh đang xoay 30° lật ngang → đối xứng qua trục dọc trên màn hình), Đặt lại → **hết** transform (xám khi chưa chạm) · Ctrl+click 2 ảnh → mỗi ảnh quanh tâm riêng, **một** Ctrl+Z hoàn lại cả hai · Xong → **mở lại file** (cả trang `/Rotate 90`, ảnh JPEG) → ảnh **đúng chỗ, đúng chiều** như trước khi lưu, còn sửa tiếp được · Áp nhiều trang và Sao chép → Dán → bản sao **giữ góc xoay / lật** · mở file đã bake bằng **Foxit + Acrobat + Chrome** → thấy đúng chiều · ảnh sát mép **trên** trang → núm vẫn bấm được |
| Núm xoay hộp chữ (`textRotateCenter` ở `annot-text.js` · `renderAnnot` khối knob của `text` · `onDown` nhánh `data-rot` · `onMove`/`cancelDrag` nhánh `rotate`, đồng bộ ô `#ed-textrot`) | BI-117 · `cd desktop ; npm run test:text ; npm run test:imgxf ; npm run test:rotate ; npm run test:fmtpanel` · **test tay**: chọn MỘT hộp chữ → núm tròn trên đầu hộp → kéo sang trái = xoay ngược chiều kim đồng hồ, ô **Xoay** chạy theo, Shift nhảy 15°, Esc về góc cũ, Ctrl+Z lùi đúng **một** bước · hộp **co ngang 60%**, hộp **cố định bề rộng**, hộp ở trang `/Rotate 90` → xoay quanh đúng tâm (hộp **không nhảy** lúc bấm vào núm) · Xong → mở lại → góc còn, sửa tiếp được · chọn 2 hộp → **không** có núm (dùng ô Xoay / +90°) · FreeText của phần mềm khác → **không** có núm · ảnh vẫn xoay bằng núm như cũ (BI-116) |
| Sửa style NHIỀU hộp chữ (`textTargets` / `selSig` / `forTextTargets` / `textRef`; `ed-fontsize` · `ed-font` · B/I/U · `setTextRot` / `+90°` · `applyTextFmt` · `fmt-wrap` · `applyBoxW` · `writeBorder` · `fmt-clear` · `fillTargets` / `applyFillToSel` · `syncCtlVisibility` + `GROUP_CTLS` · `updateFmtPanel` / `syncFmtPanel` · `syncControls` · `arrangeSelected`) | BI-118 · `cd desktop ; npm run test:multiedit ; npm run test:defaults ; npm run test:fmtpanel ; npm run test:teformat ; npm run test:text` · **test tay**: chọn 1 hộp → bấm **B** → CHỈ hộp đó đậm, Ctrl+Z hoàn lại (**hồi quy: chọn một hộp phải y như trước**) · Ctrl+click 3 hộp → **B**, cỡ chữ, **I**, **Nền**, **Viền**, **căn phải**, **+90°** → cả 3 đổi, mỗi điều khiển **một** Ctrl+Z hoàn lại cả nhóm · nhóm có hộp ở góc khác nhau → **+90°** mỗi hộp cộng từ góc riêng · nhóm gồm hộp cố định bề rộng + hộp điểm → gõ **Bề rộng khung** chỉ đổi hộp cố định · chọn hình chữ nhật trước rồi Ctrl+click một hộp chữ → thanh font + bảng Định dạng **vẫn hiện**, cỡ chữ chỉ đổi hộp chữ · nhóm có FreeText của phần mềm khác → Viền **không** ghi vào nó · 2 hộp → các nút **Sắp xếp theo trang** **xám** · mở ô gõ của một hộp khi đang chọn nhóm rồi đổi Nền → chỉ hộp đang gõ đổi · Xong → Lưu → mở lại → cả nhóm còn đậm / nghiêng / cỡ / nền / viền, mép nền + viền trong file **trùng** màn hình |
| `renderer/batch-variants.js` · Tạo bản theo mẫu · `dialog:choose-dir` / `file:write-new-pdf` | BI-103 · `npm test -- batch-variants tabs-logic ipc-contract global-scope` · **test tay trên bộ bản vẽ thật**: Ctrl+H → "Tạo bản theo mẫu…" → mã `I1`, giá trị `I2, I3` → Quét → **25 chỗ / 13 trang**, danh sách ngữ cảnh đúng → bỏ tích 1 dòng → "sẽ thay 24" → Tạo file → 2 file mới cạnh file gốc, mở ra số hiệu **cao bằng** `DAOL.` · bấm Tạo lần nữa → hỏi **Ghi đè?** từng file, nằm **trên** hộp thoại · Ctrl+Z trên file đang mở → **không** có bước nào từ việc này · đang Chú thích → bị từ chối |
| Lớp chữ của chữ vẽ lại (`drawn_fonts`, `_merge_tounicode`, CMap) | `test_edit_text_tounicode.py` · Ctrl+H thay `I1`→`I2` trên bản vẽ thật rồi **tìm lại** `I2_BD-S` → ra đủ số chỗ; copy số hiệu dán Notepad → còn dấu `-` (BI-102) |
| Redaction / `add_redact_annot` / `apply_redactions` | `test_edit_text_layout.py` **và** `test_translate_layout.py` **và** `test_edit_text_outlined.py` (BI-119 — chữ outline + lớp chữ vô hình: chữ cũ phải hết, đường kẻ / màu khác / span bên cạnh / trang chữ thật phải còn) · sửa 1 chữ trong ô bảng **có nền** → không vệt trắng, không mất đường kẻ (BI-23) |
| `wire.js` (`pdfJsonBody` / `binArrayJsonBody` / `pushB64Chunks` / `b64ToU8` / `B64_CHUNK`) hay bất kỳ chỗ gọi sidecar nào có PDF | `cd desktop ; npm run test:wire` (51 ca) · mở file **lớn** (≥100MB) rồi: Sửa nội dung · Nén · So sánh 2 file · Tách — không tab nào chết vì hết bộ nhớ · **Ảnh → PDF với ~50 ảnh máy ảnh**: tạo được file, PDF mở lại đúng số trang và đúng thứ tự (BI-24) |
| Thứ tự `<script>` trong `index.html` | `find-replace.js` **sau** `app.js` (dùng tên trần `state`/`sidecarFetch`/`pdfJsonBody`/`rerenderChanged` và gắn nút lúc nạp); `wire.js` **trước** `app.js`/`text-edit.js`/`compare.js`/`editor.js`/`sign.js`; `annot-text.js` + `annot-geom.js` + `managed-codec.js` **trước** `editor.js` (và `managed-codec.js` sau `vendor/pdf-lib.min.js` + `wire.js` + `annot-text.js`); `pan.js` sau `app.js` và trước `editor.js`/`capture.js`. Mở app → console **không** có `ReferenceError` · thử một lệnh gọi sidecar bất kỳ (Nén) (§2, BI-14, BI-40) |
| `annot-text.js` / `annot-geom.js` | `npm run test:text` + `test:cloud` + `test:geom` · rồi **test tay**: gõ chữ Việt vào hộp → Xong → mở lại file, chữ **không** tràn khung · khoanh mây (hộp + freehand) → Lưu → mây đúng chỗ · mũi tên có nhãn ở cả hai đầu (BI-40) |
| Bất kỳ lệnh vẽ nào trong `drawOneAnnot` / `drawWatermark` (thêm kind, đổi anchor, đổi primitive) | `cd desktop ; npm run test:rotate` **và thêm kind mới vào `KINDS` của lưới đó** · rồi test tay trên **trang đã xoay**: mở PDF scan nằm ngang (hoặc Xoay phải 90° một trang bất kỳ) → khoanh mây · khoanh vùng · mũi tên · dấu ✓ · hộp chữ → **Áp dụng** → mở lại file: mọi thứ **đúng chỗ, đúng chiều** như lúc vẽ · lặp lại trên trang **không** xoay để chắc không có gì dịch đi (BI-45, BI-40) |
| Thứ tự chồng (`reorderZ`, `zPlan`/`reorderSelected`/`pickUnder`, mục menu "Đưa lên/xuống…", `Ctrl+]`/`Ctrl+[`, `Alt`+bấm) | `cd desktop ; npm run test:zorder ; npm run test:cloud ; npm run test:clip` · vẽ **hộp văn bản**, rồi vẽ **chữ nhật viền không nền** bao quanh nó → chữ **bị che, bấm không trúng** (đúng) → **Alt+bấm** chọn được hộp chữ → chuột phải → **Đưa lên trên cùng** → chữ hiện trên khung, bấm trúng được ngay · `Ctrl+]`/`Ctrl+[` đi từng lớp, `Ctrl+Shift+]`/`[` đi tới đầu/cuối · mục menu **xám** khi đã ở đầu/cuối · chọn **nhóm 3 mục** (Ctrl+bấm) → đưa lên → cả nhóm đi, **giữ nguyên thứ tự trong nhóm** · **một** Ctrl+Z trả lại đúng thứ tự cũ, Ctrl+Y làm lại · Áp dụng → Lưu → **mở lại** → thứ tự **không đổi** · Lưu 3 lần liên tiếp → thứ tự vẫn không đổi, file không phình · mở file bằng **Foxit + Acrobat + Chrome** → hộp chữ nằm **trên** khung · trang **xoay 90°** → vẫn đúng · gõ chữ trong hộp đang sửa + `Ctrl+]` → **không** đổi lớp (đang gõ) · đổi **VI↔EN** → 4 mục menu có tên tiếng Anh (BI-93) |
| Kiểu nét (`DASH_KINDS`/`normDash`/`dashSpec`/`dashSegments` ở `annot-geom.js`, `applyDashSvg`/`appendDashedOutline`/`stampDash`/`#ed-dash` ở `editor.js`, nhánh dash của `shapeAppearance`/`serializeManaged`, `renderArrowPng`, `drawOneAnnot`, `deserializeManaged`) | `cd desktop ; npm run test:dash ; npm run test:managed ; npm run test:rotate ; npm run test:cloud` · **hồi quy trước (quan trọng nhất)**: một tài liệu **0° chỉ có hình liền** → Áp dụng → Lưu phải ra **byte y hệt** bản trước (BI-59) · vẽ **mỗi loại một hình** (chữ nhật, elip, nét vẽ tay, hình tự do, mũi tên) với **Nét đứt**, rồi cùng bộ đó với **Chấm**, độ dày **1, 4 và 12** → trên màn hình, đứt **đều** và **không nuốt** khoảng hở (đầu phẳng); Chấm là **chấm tròn** · mũi tên: chỉ **thân** đứt, **đầu mũi tên đặc** · Áp dụng → Lưu → **mở lại** → hình vẫn đứt và ô **Kiểu nét** hiện đúng giá trị khi chọn từng hình; đổi lại **Liền** → lưu → mở lại → liền · chọn **2–3 hình khác loại** (Ctrl+bấm) rồi đổi kiểu → cả nhóm đổi, **một** Ctrl+Z trả lại tất cả · công cụ **Khoanh mây / ✓ / ✗ / Đo / Ghi chú / Hộp chữ** → **không** có ô Kiểu nét · copy một hình đứt → dán sang **tab khác** và **file khác** → vẫn đứt · mở file đã lưu bằng **Foxit + Acrobat + Chrome + Edge** → nét đứt **đúng độ dài và đúng đầu nét** (chữ nhật/elip/vẽ tay/hình tự do là `/AP` vector, mũi tên là PNG: kiểm riêng **mũi tên Chấm**, probe chưa đo pixel của nó) · zoom 400% → viền **nét, không rỗ** · trang **xoay 90/180/270** → đứt đúng chỗ, không méo · trang **bị che thông tin (redact)** có hình đứt → hình vẫn **đứt** sau khi bake (đường raster dựng trang mới) · hình đứt **có nền mờ** → nền đúng, chỉ viền đứt · Lưu 3–4 lần liên tiếp → **cỡ file không phình**, mẫu nét **không đổi** · đổi **VI↔EN** → nhãn "Kiểu nét / Line style", "Liền / Solid", "Nét đứt / Dashed", "Chấm / Dotted" · cửa sổ **hẹp (~1100px)**: nút **Xong** vẫn thấy được ở công cụ Hộp (BI-41, BI-94) |
| Ghép nhiều trang vào một tờ (`page-nup.js` `placement` / `pageGeom` / `plan` / `build`, `askNup`/`openNup`/`runNup`, `#btn-nup`, `#nup-modal`) | `cd desktop ; npm run test:nup` (88 ca) · rồi **test tay**: mở file có **trang ngang, trang lưu dọc có `/Rotate 90`, và một trang trắng** → Trang ▾ → Ghép nhiều trang vào một tờ → 2 trang, A4 dọc → trang xoay phải hiện **thẳng** (không nằm ngang), trang trắng để ô trống, Lưu rồi mở bằng **Foxit/Acrobat** và nhìn lại · Ctrl+Z → về đúng số trang cũ · chọn 2 trang rồi mở hộp thoại → ô "Các trang" đã điền sẵn đúng · gõ `abc` → nút Ghép bị khoá · trang có liên kết → hộp xác nhận nói đúng số mục sẽ mất · tài liệu có trang ẩn → bị từ chối bằng thông báo |
| Cột trái nhiều chế độ (`side-panels.js`, `.side-tab`, `#pane-outline`, `SidePanels.init/docChanged`) | `cd desktop ; npm run test:side ; npm run test:scope` · file **có dấu trang** (xuất từ Word có Heading, hoặc Acrobat) → tab Dấu trang → cây đúng cấp, nhánh đóng/mở như Acrobat · bấm mục → nhảy đúng chỗ (cả khi đang **zoom 300%** và trên trang **xoay 90°**) · **xoá** trang có dấu trang → mục đó **mờ**, không lỗi console · kéo đổi thứ tự trang khi đang xem dấu trang → cây cập nhật · về tab Trang → thumbnail vẫn vẽ, trang hiện tại sáng · F4, F11 + rê mép trái · đổi EN/VI · file **không** có dấu trang → "Tài liệu này không có dấu trang." (BI-97) |
| Danh sách Chú thích (`annot-scan.js`, `side-panels.js` phần `annots`, `Editor.listObjects/focusObject`, móc ở `renderLayer`, `#btn-comments`) | `cd desktop ; npm run test:annotscan ; npm run test:side ; npm run test:scope` · mở file **có chú thích của Acrobat/Foxit/PDF-XChange** → nút 💬 → tab Chú thích: đủ mục, đúng trang, đúng tác giả, màu chữ hộp văn bản **không trắng** · lọc loại / người · bấm mục → nháy đúng chỗ (cả trang **xoay**, cả khi **zoom 300%**) · vào **Chú thích**: mục của phần mềm khác viền đứt; **vẽ / xoá / hoàn tác** một hình → danh sách + badge đổi ngay · Xong → danh sách đọc lại từ file, hộp chữ Nabu **không** hiện hai lần · mở file **vài trăm trang** → cửa sổ không khựng khi danh sách đang đọc · EN/VI (BI-98) |
| Ẩn chú thích khi đang sửa (`annot-hide.js`, `renderPageCanvas` nhánh `editing`, `importManaged` → `ed._owned`, `replacedOnBake`, thứ tự `importManaged`/`rerenderChanged` trong `bakePending`, `Editor.ownedAnnots`) | `cd desktop ; npm run test:annothide ; npm test -- bake-repaint bake-split managed-image render-race render-cancel` · mở file **có chú thích của Acrobat/Foxit** + **file có ô form đã điền** → vào **Chú thích** → chữ/hình của đối tác và giá trị form **vẫn trên trang**, cuộn tới trang chưa vẽ cũng thế · vẽ hộp chữ + khung → **Ctrl+S khi vẫn đang sửa** → không có bản thứ hai mờ dưới overlay · Xong → hiện đúng một bản · vào lại → sửa được, không hai bản · **xoá** hộp chữ Nabu → cuộn xa rồi quay lại → không hiện lại · Hủy bỏ → hộp chữ trong file hiện lại · **bôi đen** một vùng trên trang có cả hộp chữ Nabu và chú thích của đối tác → Xong → chú thích của đối tác còn (thành pixel), hộp chữ còn và sửa được; xoá hộp chữ rồi bôi đen → hộp chữ **không** còn dấu · trang **xoay 90°** cũng vậy · in / thumbnail sau khi sửa: đủ mọi chú thích (BI-99) |
| Hình của phần mềm khác trong Chú thích (`foreign-annot.js`, `importForeignAnnot` / `foreignPlan` / `removeForeign` / `applyKeep` ở `editor-bake.js`, `_foreign` trong `editor.js`, `composeItems`) | `cd desktop ; npm run test:foreign ; npm run test:annothide ; npm test -- bake-split side-panels annot-scan` · mở file có hình của **Acrobat / Foxit / PDF-XChange** → Chú thích → hình chữ nhật, mây, mũi tên, đường kẻ, nét vẽ tay **chọn / kéo / đổi màu / xoá** được, nhìn gần giống bản gốc · **không sửa gì → Xong → so file: y nguyên** · sửa một cái → Lưu → mở bằng **Acrobat/Foxit**: còn đúng một bản, **còn tên người tạo + lời bình**, các cái khác y nguyên · xoá một cái có ghi chú bật lên (Popup) → không còn rác · trang **xoay 90/180/270** → sửa xong vẫn đúng chỗ · copy + dán một hình của đối tác → bản gốc yên · Ctrl+Z sau Xong → đúng file cũ · hình **trong suốt / bị khoá / có trả lời** → vẫn viền đứt, không sửa được (đúng) · danh sách không có dòng trùng (BI-100) |
| Sắp xếp trang bằng kéo–thả trong cột trang (`thumbGapAt`, `showThumbGapCue`, `gapToReorderIndex`, `gapIsNoOp`, `.thumb.insert-*`, `reorderPage`, `PageRange.movePageInDoc`) | `npm run test:geom ; npm run test:pages` · file **có dấu trang + form** → kéo một trang → Lưu → mở bằng **Foxit/Acrobat**: dấu trang còn, bấm vào nhảy đúng trang đã dời, form còn (BI-96) · file có trang **xoay / khổ khác** → kéo → trang giữ đúng khổ & hướng · kéo trang 1 xuống **giữa trang 3 và 4** → thấy **hai vạch** ở đúng khe đó, thả ra thì trang nằm đúng giữa 3 và 4 · kéo rồi thả **đúng chỗ cũ** → con trỏ báo “không cho phép”, tài liệu **không** bẩn (không có ●) · kéo–thả **1 PDF từ ngoài** vào giữa dải → vẫn chèn đúng khe (BI-33) · Ctrl+Z sau khi sắp xếp · đang kéo thì cột **không** tự cuộn (BI-39) |
| Chọn nhiều mục / clipboard vật thể (`ed.selMore`, `selIds`, `toggleSelect`, `gripsFor`, `clip`, `copySelected`, `pasteClip`, menu bấm phải trong Chú thích) | `npm run test:cloud` · **giữ Ctrl bấm 3 mục** → cả 3 có viền chọn, **không** hiện tay nắm · kéo một mục trong nhóm → **cả nhóm** đi cùng, Esc giữa lúc kéo → **cả nhóm** về chỗ cũ · đổi Màu / Nét → **cả nhóm** đổi · Delete → mất cả nhóm, **một** Ctrl+Z lấy lại hết · Ctrl+C rồi sang trang khác Ctrl+V → dán đúng vị trí cũ, còn nguyên khoảng cách giữa các mục · dán **lại** trên cùng trang → lệch dần chứ không đè lên nhau · dán vào trang **nhỏ hơn** → cả nhóm bị kéo vào trong trang mà **không rời ra** · **copy → Áp dụng → Ctrl+V** vẫn dán được (BI-46) · bấm phải lên một mục → menu Sao chép/Dán/Xoá · bấm phải lên **giấy trắng** khi chưa copy gì → vẫn ra menu **ảnh** cũ · copy một ảnh từ app khác rồi Ctrl+V → vẫn là đường dán ảnh của `capture.js` (BI-30) |
| Sửa mũi tên (`drag.type === "point"`, `snapLineEnd`, `.handle.h-pt`, `reverseSelectedArrow`) | `npm run test:cloud` · chọn mũi tên → thấy **2 nút tròn** ở hai đầu · kéo một đầu → mũi tên xoay/dài ra, đầu kia **đứng yên** · giữ Shift → khoá góc 15°, **độ dài không đổi** · Esc giữa lúc kéo → về đúng cũ, không để lại bước undo rỗng · "Đảo chiều" → mũi nhọn **và nhãn** sang đầu kia · **Áp dụng → mở lại → Chỉnh sửa** → vẫn kéo/đảo/sửa nhãn được (arrow round-trip qua `/NabuData`) |
| Vẽ tay + Shift (`strokeExtend`, nhánh `drag.type === "draw"`, `drag.lineFrom`) | `npm run test:cloud` · vẽ tay **không** giữ Shift → vẫn ngoằn ngoèo đủ điểm · giữ Shift giữa nét → ra đoạn **thẳng**, rê chuột thì đoạn đó **xoay theo** chứ không dài thêm điểm · **thả** Shift → vẽ tay tiếp từ đúng đầu mút đó · Esc giữa chừng → mất cả nét, không để lại bước undo rỗng · Xong → mở lại file, nét **đúng hình** (BI-42) |
| Dấu ✓ / ✗ (`SYMBOL_KINDS`, `symbolStrokes`, `colorSlotFor`, `drag.type === "symbol"`) | `npm run test:cloud` · **bấm** một cái → ra dấu cỡ mặc định, **kéo** → ra đúng cỡ đã kéo · bấm sát mép phải-dưới trang → dấu vẫn **nằm trọn trong trang** · chọn rồi kéo 4 góc, giữ Shift giữ tỷ lệ · đổi "Nét" → dấu đậm/mảnh theo · đổi màu ✗ rồi chuyển sang bút Tô sáng → **màu tô sáng không bị đổi theo** · phím K/J đổi công cụ, nhưng đang gõ trong ô số thì **không** · Xong → mở lại file: dấu **đúng chỗ, đúng màu**, kể cả trên trang **đã xoay** (BI-42) |
| Thêm nút vào `#ed-tools` hay control vào palette | BI-41: thu cửa sổ về 1366px rồi 1024px, lần lượt chọn **mọi** công cụ → nút "Xong"/"Hủy bỏ" luôn thấy được, thanh **không** phình cao che trang · và BI-9 + BI-10 |
| Tuỳ chọn “Mở file mới trong” (`prefs.js`, `planOpen`, `tabs:open-paths`, `openPathInApp`) | `cd desktop ; npm run test:tabs` · với **cả hai** giá trị, thử **cả ba** đường: nút Mở · kéo–thả PDF vào tab đang có tài liệu · double-click file trong Explorer — kết quả phải **giống nhau** · chọn 3 file cùng lúc + “Cửa sổ mới” → **một** cửa sổ 3 tab · tab trắng + “Cửa sổ mới” → nạp vào chính tab trắng đó · đổi tuỳ chọn rồi khởi động lại app → vẫn nhớ · xoá `%APPDATA%/Nabu PDF/prefs.json` → về “Tab mới” (BI-35, BI-8) |
| Màu chú thích mặc định (`DEFAULT_ANNOT_COLOR`, `savedAnnotColor`, `COLOR_SLOTS`, `colorSlotFor`, `setDefaultColor`, `#set-annot-color`) | `cd desktop ; npm run test:defaults` · xoá key `nabu-annot-color` → vẽ **cả 10** loại dùng màu chung (hộp văn bản, mũi tên, mây, mây vẽ tay, chữ nhật, tròn, bút vẽ, ghi chú, đo) → **tất cả đỏ** · **✓ vẫn xanh, ✗ vẫn đỏ, Tô sáng vẫn vàng, Màu che vẫn đen, Nền vẫn trắng** · Cài đặt đổi màu **khi hộp thoại còn mở** → vật thể mới theo màu mới, **vật thể cũ không đổi** · ô **Màu** trên thanh đổi màu vật thể đang chọn nhưng **không** ghi vào Cài đặt · Ctrl+click 3 mục rồi đổi màu → **cả 3** đổi · khởi động lại app → vẫn nhớ · Áp dụng + Lưu + mở lại → màu trong file đúng · mở file **đã lưu từ bản ≤0.2.59** có mũi tên/ghi chú round-trip → màu **giữ nguyên** · đổi VI↔EN → hàng Cài đặt dịch đúng, ô màu không bị reset (BI-61, BI-10) |
| Kéo–thả nhiều PDF vào cửa sổ (`drop` ở `app.js`, `openDroppedPdfs`, `combineDroppedPdfs`, `droppedPath`, `pathForFile`) | `cd desktop ; npm run test:confirm` · kéo **1** file → mở luôn, **không** hỏi gì · kéo **3** file → hộp thoại 3 lựa chọn; **Enter** = Mở từng file, nút **Gộp thành một file**, **Esc = không làm gì cả** (tài liệu đang đọc phải còn y nguyên) · chọn Gộp → danh sách đúng **thứ tự đã kéo** (không phải thứ tự tên) · chọn Mở từng file khi tab **đã có** tài liệu → ra **tab mới**, tài liệu cũ không bị thay (đây là ca canh gác BI-63: `File.path` đã chết, nếu `webUtils` không chạy thì nó sẽ **đè** tài liệu đang mở) · tab **trắng** + kéo 3 file → file đầu vào chính tab trắng đó · kéo file **không phải PDF** → không hỏi, không làm gì · kéo PDF vào **dải thumbnail** → vẫn là đường **chèn trang** cũ, **không** ra hộp thoại này (BI-63, BI-8, BI-35, BI-26) |
| Verb Explorer “Gộp bằng Nabu PDF” (`shell-combine.js`, `combineBucket`, `openCombineBatch`, `sendCombineToView`, `createTab combinePaths`, `combineFromShell`, `installer.nsh`) | `cd desktop ; npm run test:combine` · **phần còn lại CHỈ test được trên bản ĐÃ ĐÓNG GÓI + ĐÃ CÀI** (dev không đăng ký verb, và `electron .` không dựng được verb): `reg query "HKCU\Software\Classes\SystemFileAssociations\.pdf\shell\NabuCombine" /s` thấy đủ `MUIVerb` (tiếng Việt đúng, không mojibake) + `MultiSelectModel=Player` + `command` · **app đang mở với tài liệu BẨN** → chọn 3 PDF → Gộp → tab **mới**, tài liệu cũ **còn nguyên, vẫn bẩn, không bị hỏi câu nào** · **app CHƯA chạy** → chọn 5 PDF → Gộp → **một** hộp thoại **đủ 5 mục**, lặp **≥10 lần** (đây là ca đua khoá single-instance, xem BI-62) · 20 file · tên tiếng Việt có dấu · đường dẫn có dấu cách · ổ mạng UNC · file có mật khẩu lẫn trong loạt → bị bỏ kèm toast, loạt còn lại vẫn gộp · chọn **1** file → hộp thoại 1 mục, “Gộp & lưu” mờ, “Thêm file PDF…” dùng được · sắp lại thứ tự → Gộp & lưu → mở kết quả kiểm **đúng thứ tự + đủ trang** · huỷ hộp thoại Lưu → kết quả vẫn mở, Ctrl+S lưu được · **double-click MỘT file PDF vẫn mở tài liệu, KHÔNG ra hộp thoại Gộp** (ca canh gác thứ tự hỏi) · gỡ app → khoá registry mất hẳn · Win11: mục nằm trong **“Hiện thêm tùy chọn”** (BI-62, BI-35, BI-8) |
| Chọn font ở `/edit-text` hay `src/pdf/fonts.py` | `test_edit_text_font.py` **và** `test_edit_text_rounds.py` · mở 1 hoá đơn Times New Roman thật, sửa 1 dòng với “Giữ nguyên” → **không** đổi sang DejaVu, **không** ra □ (BI-21) · mở PDF có tên font chung (`CIDFont+F1`, ví dụ `0. TH.pdf`), Ctrl+H thay thành chuỗi chữ hoa có `Ề`/`Ố` → **mọi** chỗ vẫn Times New Roman Bold, cùng cỡ (bậc 2b) |
| Toàn màn hình (`setPresentation`, `_layout`, `.presenting`) | `npm run test:tabs` (10 ca cuối) · F11 vào/ra · Esc ra · thoát bằng nút cửa sổ → thanh công cụ phải quay lại · chuyển tab khi đang toàn màn hình · thử bật lúc đang Chú thích (phải từ chối) — BI-22 |
| `pan.js` hay bất kỳ listener chuột nào trên `#viewer` | `cd desktop ; npm run test:pan` (57 ca) · bật Bàn tay → kéo trang chạy, **không** bôi đen chữ · tắt Bàn tay → bôi đen chữ lại được · giữ Space kéo rồi thả → về đúng công cụ cũ · kéo chuột giữa lúc **đang Chú thích** → trang chạy, **không** vẽ ra hình · lúc **đang Copy ảnh** → trang chạy, **không** ra khung marquee · bấm vào ghi chú (note marker) khi Bàn tay bật → popup vẫn mở (BI-30, BI-31) |
| Toàn màn hình / dải thumbnail (`applyPresentation`, `body.presenting .sidebar`, `#present-rail`) | F11 → trang vẫn vừa trọn màn hình · rê chuột mép trái → dải trượt ra mà trang **không nhúc nhích** · F4 ghim/bỏ ghim · thu sidebar rồi mới F11 → F4 vẫn gọi lại được dải · thoát F11 → sidebar về đúng trạng thái cũ (BI-32, BI-22) |
| Bề rộng sidebar (`--sidebar-w`, `applySidebarWidth`, `#sidebar-resizer`) | Kéo rộng/hẹp → dừng đúng ở 130/300 · **kéo–thả 1 PDF từ ngoài vào giữa dải thumbnail → chèn đúng vị trí** (BI-33) · bấm đúp tay nắm → về 180 · đóng mở app → nhớ bề rộng · thu sidebar (F4) → tay nắm biến mất · F11 → lớp phủ đúng bề rộng đã kéo (BI-34) |
| Tuỳ chọn hiện đường dẫn (`set-breadcrumb`, `breadcrumbEnabled`) | Tắt → dải đường dẫn biến mất **ngay**, mở lại app vẫn tắt · bật lại → hiện · mặc định máy mới = **bật** · đổi VI↔EN → dòng cài đặt đổi theo |
| Đóng hộp thoại (`dismissModal`, `topOpenModal`, `[data-modal-close]`, `.modal-x`, `data-modal-manual`) | BI-48 · probe boot phải báo `dialogs_without_close` **và** `dialogs_without_x` rỗng · thử **cả ba** đường (Esc / bấm nền / ✕) trên: **Cài đặt** (hộp cuộn được — ✕ phải **dính** ở đầu khi cuộn xuống), **Nén**, **Gộp file** · bấm **bên trong** thẻ rồi thả chuột ra nền → hộp thoại **không** đóng · mở PDF có mật khẩu rồi `Esc` → app không treo, mở lại file được · `Esc` khi đang **F11** với 1 hộp thoại mở → chỉ đóng hộp thoại, **vẫn** ở toàn màn hình · `Esc` trong trang **Hướng dẫn** khi ô tìm còn chữ → xoá chữ trước, lần hai mới đóng (BI-47) |
| Route ghi nối + worker + hạn giờ (`/save-incremental-bin`, `_incremental_via_worker_blocking`, `_incremental_worker_cmd`, `WORKER_FLAG`/`EXIT_*`/`INCREMENTAL_TIMEOUT_S`/`worker_main` ở `src/pdf/incremental.py`, cờ `--incremental-worker` ở `sidecar.py`, `expose_headers`) | BI-129 · `.venv\Scripts\python test_incremental_route.py` **và** `test_incremental.py` · **lưới thứ ba, đi qua WORKER THẬT:** `.venv\Scripts\python tools/corpus_sweep_incremental.py` (kỳ vọng **958 ok / 0 lỗi thật / không hồi quy so với mốc** `tools/corpus-baseline-incremental.json`) · **BẮT BUỘC trên BẢN ĐÓNG GÓI** (argv của bản frozen khác bản dev, chỗ BI-54 từng vấp): `.venv\Scripts\python tools/corpus_sweep_incremental.py --exe dist\sidecar\sidecar.exe` · đụng `plan_changes` ⇒ so lại kế hoạch có/không đường tắt trên cả corpus (BI-129: 956/958 giống hệt) · **rebuild sidecar** trước khi đóng gói (đụng `api.py`/`sidecar.py`/`src/pdf/*.py`) · **test tay (chốt 4, chưa có):** chưa gọi từ app |
| "Lưu nối thêm" (`desktop/src/signed-save.js`, nhánh `contentRemoved`/`canAppend` ở `file:write-pdf` và `askSignedOverwrite` trong `main.js`, `state.contentRemoved` ở `app.js`/`editor-bake.js`, tham số thứ ba của `writePdf` ở `preload.js`) | BI-130 · `cd desktop ; npm run test:signedsave ; npm run test:signedscan ; npm run test:ipc` · đụng ánh xạ nút / cờ ⇒ chạy lại bộ đột biến (34 ca, mẫu ở BI-130) · **tự động trên app thật (BI-131):** `cd desktop ; node scripts/probe-signed-save.js` (6 kịch bản, OpenSSL chấm) + `.venv\Scripts\python tools/signed_e2e.py [--exe …]` (12 ca lõi) · **test tay còn lại, BẮT BUỘC (hộp native chưa bấm tay; Acrobat/Foxit chưa mở — mẫu ở `dist/signed-samples/`):** mở file ký (ví dụ `1-goc-da-ky.pdf`) → xoay trang → Ctrl+S → hộp **4 nút**, nút đầu là **"Lưu nối thêm (giữ chữ ký)"** → Enter → toast "Đã lưu nối thêm…" và `qpdf --check` mã 0 · mở lại file: vùng `/ByteRange` y hệt bản gốc · mở bằng Acrobat/Foxit, ghi lại chữ ký hiện **hợp lệ / đã sửa sau khi ký / không hợp lệ** · làm lại sau khi **bôi đen** một vùng (hoặc **ẩn trang**) → hộp chỉ **3 nút**, không có nút nối · tắt sidecar giữa chừng → hộp hỏi lại kèm lý do |
| Ký số (`desktop/src/signing.js` · `routeSigning`/`sign:apply`, `askSignOverSigned` ở `main.js`, `findSignaturesInBuffer` ở `signed-scan.js`, `declined`/`appended` ở `renderer/sign.js`, **`desktop/src/sign-append.js` + `applyAppendSignature` ở `signing-worker.js`** — BI-133) | BI-132/133 · `cd desktop ; npm run test:signingwarn ; npm run test:signedscan ; npm run test:signappend ; npm run test:sigtext ; npm run test:signednew ; npm run test:atomic` · **e2e HTTP thật, nhiều người ký:** `node tools/sign_append_e2e.js [--exe D:\…\sidecar.exe]` · đụng điều phối/hộp ⇒ chạy lại bộ đột biến (41 ca, mẫu ở BI-133) · **app thật:** `node scripts/probe-signed-save.js` (S7/S7b/S8) · **test tay, BẮT BUỘC (hộp native chưa bấm tay; cần token/chứng thư thật):** mở một file đã ký → Ký số → chọn chứng thư → hộp **"Tài liệu này đã có N chữ ký số"** với 2 nút, nút đầu **Huỷ** (Enter/Esc) → Huỷ ⇒ toast **thường** "Đã huỷ ký — tài liệu đã có chữ ký." và **không** hiện hộp PIN · (BI-133) hộp có **3 nút**, nút đầu **Ký nối thêm** → hộp PIN → file ra có **mọi chữ ký cũ + chữ ký mới**; mở bằng Foxit/Acrobat, ghi trạng thái TỪNG chữ ký · làm lại bấm **Vẫn ký** ⇒ hộp PIN hiện, file ra chỉ còn chữ ký MỚI (đúng như cảnh báo) · sửa một trang rồi ký ⇒ **không** hộp |
| Lõi ghi nối (`src/pdf/incremental.py`: `append_revision`, `plan_changes`, `_apply`, `_verify_objects`, `_same_content`, `REASONS`; `tools/corpus_sweep_incremental.py`, `tools/pdflib_rotate.js`) | BI-128 · `.venv\Scripts\python test_incremental.py` **và lưới thứ ba** `.venv\Scripts\python tools/corpus_sweep_incremental.py` (đây là đường ghi PDF — test KHÔNG thấy file hỏng, mất trang hay chết tiến trình) · **kỳ vọng hiện tại: 958 ok, 0 lỗi thật** (chưa có baseline — số `ok` giảm hoặc xuất hiện `output_worse`/`prefix_changed`/`crash` là hồi quy) · **đừng sửa mã trong lúc lưới đang quét** (kết quả thành hỗn hợp) · `pdflib_rotate.js` phải giữ dòng `applyStreamLengthFix` (BI-120) · đụng `_apply` ⇒ chạy lại cả họ `tracemonkey*` (`--only tracemonkey`: kỳ vọng 6 ok, ~780 B mỗi file) và `issue5896` (kỳ vọng `refused:verify_failed`, KHÔNG phải ok) |
| Ghi PDF ra đĩa ở main (`dialog:save-pdf`, `file:write-pdf`, `askSignedOverwrite`, `desktop/src/signed-scan.js`, `saveDoc`/`saveAsDoc`) | BI-127 · `cd desktop ; npm run test:signedscan ; npm run test:ipc` · **test tay, BẮT BUỘC (main không chạy được trong node, hộp thoại chưa từng được bấm thật):** mở `signed_verified.pdf` (corpus pdf.js) → xoay trang → Ctrl+S → hiện hộp **"File này đã được ký số (1 chữ ký)"** với 3 nút, nút đầu (mặc định, Enter) là **"Lưu thành bản sao…"** · bấm nó → mở hộp **Lưu thành**, file gốc **không đổi** · làm lại, bấm **Huỷ** → **không** mở hộp Lưu thành, file gốc **không đổi**, tài liệu vẫn còn dấu ● · làm lại, bấm **Vẫn ghi đè** → file ghi đè, và mở lại thì chữ ký đã mất · **Lưu thành** rồi chọn **đúng đường dẫn của file đã ký** → vẫn hiện hộp; chọn **"Chọn nơi khác…"** → hiện lại hộp Lưu thành · file **không ký** → Ctrl+S ghi **ngay**, không hộp nào · mở file đã ký nhưng **không sửa** rồi Ctrl+S → ghi ngay, không hộp (tiền tố y hệt) · đổi ngôn ngữ sang English → hộp ra tiếng Anh · **đường ghi PDF mới ở main ⇒ phải qua `SignedScan.guardWrite`, và `writeFile` đứng SAU cả hai nhánh cancel/copy** |
| `desktop/src/test-hooks.js` · dòng nạp ở `main.js` · `desktop/e2e/**` · `scripts/run-e2e.js` · `dialog.show*` ở bất kỳ đâu | **BI-141** · `cd desktop ; node test/test-hooks.test.js` (58 ca) · `cd desktop ; npm run e2e` (**cần phiên có giao diện; nền; `-- smoke` trước, nó là điều kiện để tin các e2e khác**) · đừng nới luật móc (đáp án là dữ liệu; hết đáp án = HUỶ; thư mục sai = ném lỗi) · thêm `dialog.show*` mới ở main ⇒ kịch bản e2e phải có đáp án (không thì `unexpected`) |
| `/compress` · `/compress-bin` · `src/pdf/compress.py` · `_compress_anywhere` · `runCompress` · **worker `--compress-worker`** · `compressEta`/`updateCompressEta` | BI-49 + **BI-54** + **BI-121** + **BI-122** + **BI-123** + **BI-126** · `.venv\Scripts\python run_tests.py` **và** `cd desktop ; npm run test:geom ; npm run test:imgfail` · **và lưới thứ ba** `.venv\Scripts\python tools/corpus_sweep_sidecar.py` (đây là đường ghi PDF — hai bộ test trên KHÔNG thấy file hỏng, mất trang hay chết tiến trình) · **test tay dòng ước tính:** mở **Nén** → thấy `Tài liệu … · ước tính khoảng …` · đổi mức sang **Không giảm chất lượng** → con số **tụt hẳn** · mở file **>300MB** → dòng chuyển **màu cảnh báo** và bấm Nén thì **hỏi lại**; bấm **Hủy** → tài liệu **không** bị bẩn (không có ● trên tiêu đề) · đổi ngôn ngữ sang English khi hộp đang mở → dòng này **không** bị đè bằng chữ cũ · **BI-54 test tay, BẮT BUỘC trên bản ĐÓNG GÓI** (argv frozen khác argv dev): nén một file **lớn** (>25MB) → trong lúc chạy, mở **tab khác** và bấm một tính năng engine bất kỳ (Ctrl+F trong Sửa nội dung, OCR) → **phải phản hồi ngay**, không đợi nén xong · **không** nháy cửa sổ console đen · nén file **nhỏ** → vẫn xong nhanh: từ BI-121 nó cũng đi qua tiến trình con, chi phí đo được ~**0,3 s**, không được thành 3 giây khựng · preset sai trên file lớn → câu tiếng Việt **đọc được**, không phải ký tự rác · thoát app giữa lúc nén → **không** còn `sidecar.exe` nào sót trong Task Manager · nén một PDF **>200MB thật** → ra file, **không** báo "PDF quá lớn" · nén PDF **>500 trang** → chạy, không báo "quá nhiều trang" · nén file hỏng/preset sai → hiện **đúng câu lỗi** chứ không lưu ra PDF rác · dòng toast ghi đúng cỡ trước → sau · **BI-122, test tay:** nén `jpx_smaskindata.pdf` hoặc `clippath.pdf` (corpus pdf.js) → **ra file, không báo lỗi**, và toast có thêm câu *"Ảnh trong file này không nén lại được."* màu cảnh báo · nén `blendmode.pdf` → cũng ra file (worker chết rồi tự thử lại ở `lossless`), **sidecar vẫn xanh** sau đó · nén một PDF ảnh bình thường → **không** có câu đó · **BI-123:** `COMPRESS_TIMEOUT_S` **không được hạ xuống dưới 20 phút** — một lần nén hợp lệ 3000 trang mất ~19 phút, hạn chặt hơn là giết việc thật. Test tay nếu có corpus: nén `bomb_giant.pdf` → sau trần phải **báo lỗi và nhả ra**, không quay mãi · **BI-126:** đụng `_compress_via_worker_blocking` / `_compress_job_slot` / `/compress-cancel` / `showOverlay` ⇒ `npm run test:cancel` **và** `.venv\Scripts\python test_pdf_ops.py`, rồi **bấm tay**: mở `bomb_giant.pdf`, bấm Nén → phải thấy nút **Hủy** trên lớp phủ; bấm → toast *"Đã hủy nén."* (trắng, không đỏ), lớp phủ tắt, và **không còn tiến trình nào mang `--compress-worker`**. Chạy sẵn được: `node scripts/probe-compress-cancel.js` · **rebuild sidecar** trước khi đóng gói (đụng `api.py`) |
| `/split` · `_repair_orphan_field_kids` · `src/pdf/split.py` · `_split_via_worker_blocking` · worker `--split-worker` · `/add-page-numbers` · `src/pdf/pagenum.py` · `_pagenum_via_worker_blocking` · worker `--pagenum-worker` · `runPageNumbers` | **BI-124** + **BI-125** + **BI-138** + **BI-139** + **BI-140** · **Đánh số (BI-140):** `.venv\Scripts\python test_pagenum_worker.py` (28 ca, worker thật; có ca trang xoay) · `cd desktop ; npm run test:pagenumcancel` (38 ca) · `node scripts/probe-pagenum-cancel.js` (app thật, `bomb_giant.pdf`, nền) · `plan` do CHA dựng (nhãn/màu/`WRITE_GARBAGE`), worker không import util · `.venv\Scripts\python test_split_worker.py` (27 ca, chạy worker thật) · **Hủy (BI-139):** `cd desktop ; npm run test:splitcancel` (31 ca, CHẠY `runSplit` thật) · `node scripts/probe-split-cancel.js` (app Electron thật; `bug1978317.pdf`; chạy nền, cần corpus) · mã `job` ở `/split` phải trùng mã ở `/compress-cancel` · `.venv\Scripts\python run_tests.py` **và** `.venv\Scripts\python tools/corpus_sweep_sidecar.py` · **luật BI-138:** `/split` KHÔNG BAO GIỜ chạy `insert_pdf` trên event loop; hết giờ / worker chết KHÔNG được rơi về tách tại chỗ · **luật không được phá:** nhánh thử lại của `split_to_zip` (nay ở `src/pdf/split.py`) phải **mở lại tài liệu từ byte gốc** (`fitz.open(stream=pdf_bytes…)`) — bỏ nó đi thì form **mất sạch mà vẫn báo thành công**, và chỉ có ghim nguồn giữ luật này, không ca hành vi nào (xem BI-124) · phép vá chỉ chạy **sau khi** `insert_pdf` hỏng, và chỉ khi nó thật sự chạm vào cái gì · **test tay nếu có corpus:** tách `opt_demo.pdf` → ra **1 file, 9 widget còn nguyên** (0 widget = đã rơi vào đường bẩn); đánh số trang `issue21436.pdf` → câu *"PDF không có trang nào."*, **không** phải `cannot save with zero pages` |
| `_open_pdf_stream` · `nice_pdf_error` (`src/pdf/util.py`) | **BI-125** · `.venv\Scripts\python run_tests.py` · **mọi route đọc PDF phải đi qua `_open_pdf_stream`** — nó là chỗ duy nhất đếm trang ngay sau khi mở, vì `fitz.open` thành công **không** có nghĩa là tài liệu dùng được (MuPDF mở lười) · **đừng nuốt nguyên văn của thư viện**: `nice_pdf_error` luôn giữ nó trong ngoặc, mất đi là mất khả năng tra cứu · thêm route ghi PDF mới ⇒ dùng `nice_pdf_error(e)` chứ không `str(e)` |
| Thanh công cụ hàng 1 (`.brand`, `.brand-text`, `.by`, `icon-only` của `btn-save`/`btn-print`, `#sb-credit`) | Thu cửa sổ **1920 → 1600 → 1366 → 1280**: hàng 1 **không cao hơn** bản trước (đã đo bằng probe: 98 → 91px ở 1600) · nút **Lưu**/**In** rê chuột ra **đúng tooltip**, và `Ctrl+S`/`Ctrl+P` + menu **Tập tin** vẫn chạy · đổi **VI↔EN** → tooltip đổi theo, nút **không** mọc lại chữ (BI-10) · dòng `developed by Nam Ta` thấy được ở **thanh trạng thái** kể cả khi cửa sổ hẹp (dưới 1400px byline trên brand bị ẩn có chủ ý) |
| `renderer/find-replace.js` · `/text-find` · Ctrl+H | BI-50 + **BI-51** · `cd desktop ; npm run test:find` **và** `.venv\Scripts\python run_tests.py` · **BI-51 test tay:** gõ vào ô Tìm → **không** có gì chạy, app không đứng · `Enter` → quét **một** lượt · gõ thêm ký tự → hai nút **Thay** tắt, vệt tô cũ còn nguyên · file **>200MB** → hiện **"PDF quá lớn"**, không phải "không tìm thấy" · file **scan** → nhắc **OCR**, không phải "không tìm thấy" · rồi **test tay trên hợp đồng thật**: tìm một từ có ≥2 lần **trên cùng một dòng** → **Thay tất cả** → mở lại file, **cả hai** đều đổi (bẫy gộp span) · **Thay** từng cái từ trên xuống, bấm ↓ bỏ qua vài chỗ → chỉ đúng chỗ đã bấm Thay bị đổi · thay bằng chuỗi **chứa chính từ khoá** ("hợp đồng" → "phụ lục hợp đồng") → **dừng lại**, không lặp vô hạn · `Ctrl+Z` sau "Thay tất cả" → về nguyên trạng **trong một bước** · tìm xong rồi **xoá một trang** → vệt tô **biến mất** (BI-50) · mở trên **PDF scan** → báo đi OCR, không im lặng · từ khoá **có dấu** ("hợp đồng") tìm ra, gõ **không dấu** thì **không** ra (cố ý) · trang có chữ **in đậm giữa từ** → vệt **vàng nét đứt**, nút **Thay** mờ · **zoom** khi đang mở → vệt bám đúng chữ (BI-36) · đang **Chú thích**/**Sửa nội dung** → bấm Ctrl+H bị từ chối (BI-2) · **BI-53:** tìm một từ **rất phổ biến** trên file vài trăm trang cho tới khi hiện "dừng quét ở trang N" → bấm **Thay tất cả** → hộp xác nhận phải nói **"trong phần tài liệu đã quét"** kèm dòng "phần sau CHƯA được quét", **không** nói "toàn bộ tài liệu" |
| `desktop/src/sidecar.js` · `bootSidecar` trong `main.js` | **BI-53** · `cd desktop ; npm run test:sidecar` (7 ca, boot sidecar dev thật; tự SKIP nếu chưa có `.venv`) · **test tay:** mở app, đợi badge xanh, rồi `taskkill /F /IM sidecar.exe` (hoặc kill tiến trình python lúc dev) → badge phải **đỏ** trong ~1s, mọi nút engine (OCR, Nén, Dịch, Tách, Ctrl+H, Sửa nội dung) **mờ đi**, tooltip badge ghi "Engine đã dừng đột ngột" · **ca ngược, quan trọng hơn:** thoát app bình thường → **không** thấy thông báo lỗi nào chớp lên |
| `i18n.js` | Đổi VI↔EN khi đang mở tài liệu, đang chú thích, đang sửa nội dung |
| `api.py` / `src/pdf/*` | `.venv\Scripts\python run_tests.py` **và** rebuild sidecar trước khi đóng gói |

---

## 6. Checkpoint bắt buộc trước khi phát hành

1. `.venv\Scripts\python run_tests.py` → phải `N/N test files passed`.
2. `cd desktop ; npm run test:tabs` → phải `N pass, 0 fail`
   (lưới cho logic sắp xếp tab + định tuyến phím trong `src/tabs.js`).
2b. `cd desktop ; npm run test:pages` → phải `N pass, 0 fail`
   (lưới cho số học khoảng trang trong `renderer/page-range.js`).
2c. `cd desktop ; npm run test:pan` → phải `N pass, 0 fail`
   (lưới cho logic giành chuột của bàn tay trong `renderer/pan.js`).
2d. `cd desktop ; npm run test:wire` → phải `N pass, 0 fail`
   (lưới cho bộ mã hoá payload trong `renderer/wire.js` — BI-24).
2e. `cd desktop ; npm run test:geom` → phải `N pass, 0 fail`
   (hình học zoom / cột trang **cắt thẳng từ `app.js`**; `resizeRect` `require()` từ
   `annot-geom.js` từ v0.2.48 — BI-36, BI-39).
2f. `cd desktop ; npm run test:managed` → phải `N pass, 0 fail`
   (vòng round-trip của ảnh chèn: ghi → đọc lại → bake lại không phình — BI-37, BI-38.
   Từ v0.2.49 phần lớn là `require("renderer/managed-codec.js")`; chỉ `deserializeManaged`,
   `addManagedAnnot`, `edSnapshot`, `dataUrlToBytes` còn cắt-lúc-chạy vì không rời được khỏi IIFE của editor — nay `deserializeManaged`/`addManagedAnnot` nằm ở `editor-bake.js`, các loader đọc cả hai file).
2g. `cd desktop ; npm run test:text` → phải `N pass, 0 fail`
   (bố cục chữ trong `renderer/annot-text.js` — BI-40).
2h. `cd desktop ; npm run test:cloud` → phải `N pass, 0 fail`
   (mây revision + nhãn mũi tên trong `renderer/annot-geom.js` — BI-40).
2i. `cd desktop ; npm run test:print` → phải `N pass, 0 fail`
   (khoảng trang của hộp thoại In, **cắt thẳng từ `app.js`** + kiểm luôn 7 khoá i18n và
   `SKIP_IDS` — BI-43, BI-44. Nửa CSS "1 trang = 1 tờ" **không** nằm trong lưới này: phải
   probe `printToPDF` và **đếm tờ**).
2j. `cd desktop ; npm run test:rotate` → phải `N pass, 0 fail`
   (bù xoay trang cho **mọi** kind của `drawOneAnnot`, **cắt thẳng từ `editor.js`** và
   chạy trên chính pdf.js + pdf-lib đang ship — BI-45. Có ca canh gác dựng lại đúng lỗi
   mây bị xoay, nên lưới này **không thể** xanh một cách vô nghĩa).
2k1. `.venv\Scripts\python test_text_find.py` → phải `N pass, 0 fail`
   (luật khớp của `/text-find` — BI-52: biên nguyên-từ trên dòng, span khoảng trắng,
   cache khoá bằng toàn bộ bytes, `/text-find-bin` khớp `/text-find` từng hit).
2k. `cd desktop ; npm run test:find` → phải `N pass, 0 fail`
   (số học Tìm & Thay thế trong `renderer/find-replace.js` — BI-50. Lưới này cũng kiểm
   **mọi khoá `tr()` có trong từ điển i18n**, `fr-status` nằm trong `SKIP_IDS`,
   `btn-find-replace` nằm trong `GATED_BTNS`, và `pushUndo` đứng **trước** phép gán
   `state.bytes` — BI-3, BI-9, BI-10).
2k2. `.venv\Scripts\python test_edit_text_rotate.py` → phải `N pass, 0 fail`
   (chiều vẽ lại chữ của `/edit-text` — BI-66. Mỗi nhóm có **ca canh gác** gửi `dir=None`
   để dựng lại đúng lỗi "chữ tự quay 90°" và đòi nó phải SAI, nên lưới này **không thể**
   xanh một cách vô nghĩa. `run_tests.py` đã tự gom, mục này để nhớ khi chỉ chạy lẻ.)
2l. `cd desktop ; npm run test:defaults` → phải `N pass, 0 fail`
   (màu + nét chú thích mặc định — BI-61. Giữ **ba** literal `#e90000` bằng nhau, hai literal nét
   `1` + min/max bằng nhau, canh fallback `a.width || 2`, chặn việc gộp
   4 màu có nghĩa `✓/✗/tô sáng/che`, và canh gác 2 fallback `#ffd54a` của
   `deserializeManaged` — đổi chúng là làm **file đã lưu** đổi màu khi mở lại).
2m. `cd desktop ; npm run test:combine` → phải `N pass, 0 fail`
   (verb Explorer “Gộp bằng Nabu PDF” — BI-62. Có ca canh gác “argv của Open with phải
   trả `null`”, chính sách gom của `createCombineBucket`, và **đối chiếu
   `build/installer.nsh` ↔ `src/shell-combine.js`** vì cờ/khoá registry sống ở hai file
   mà build không kiểm.
   ⚠️ Lưới này **không** chứng minh verb chạy: khoá registry chỉ được ghi lúc **cài**.
   Sau khi đóng gói phải test tay theo §5 — tối thiểu là `reg query` thấy đủ 3 value, và
   **double-click một file PDF vẫn mở tài liệu** chứ không ra hộp thoại Gộp).
3. `node --check` mọi file JS đã sửa (renderer **không** có test tự động).
3b. Nếu đụng `editor.js` / `app.js` / bất kỳ file nào được `<script>` nạp: **probe boot**
   — chạy `index.html` thật bằng Electron của dự án (`BrowserWindow({show:false})`),
   nghe `console-message`, và đòi **0** `ReferenceError` / `SyntaxError` /
   `has already been declared`, **cộng với** một câu hỏi khẳng định (`typeof $`,
   `!!window.Editor`, số key của `window.AnnotGeom`, các `id` nút mới có mặt). Chỉ
   “không có lỗi” là chưa đủ — nó cũng đúng khi script **không hề chạy**. Đây là cửa duy
   nhất bắt được BI-14: node cho mỗi module một scope riêng nên lưới vẫn xanh trong khi
   app trắng. Probe là **file dùng một lần, không commit**.
4. Nếu đụng `*.py` hoặc `sidecar.spec` → **rebuild sidecar**, nếu không OTA giao bản cũ.
5. Chạy `npm start`, test tay các mục ở §5 tương ứng với thứ vừa sửa.
6. Cập nhật `HANDOFF.md` + tài liệu này nếu phát sinh bất biến mới.

**Bài học quy trình đã có tiền lệ tốt:** commit `c75e355` viết lưới test cho `api.py`
**trước** khi refactor `65b38bf`. Với thay đổi lớn, hãy dựng lưới an toàn trước.
