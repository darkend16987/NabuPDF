# Nghiên cứu + kế hoạch — **Thay trang**, **copy ảnh sang file khác**, **chữ ký lưu sẵn**

_Lập 2026-09-26 · nhánh `claude/vietnamese-ocr-ai-iSvwV` · nền v0.2.71. Yêu cầu nguyên văn:_

> - Tính năng replace trang: mở file, chọn 1 trang, chuột phải chọn replace, app mở cửa sổ chọn
>   file, có option replace = tất cả các trang hoặc trang chọn … (học từ pdf24)
> - Copy – paste ảnh (được dán vào): shape, text box copy-paste được, nhưng ảnh khi copy sang
>   1 file khác thì hình như không vào được clipboard, hãy kiểm tra
> - Chữ ký lưu sẵn: user setup trên app (ảnh PNG), sau này chỉ việc mở menu / chuột phải một vị
>   trí → chọn chữ ký có sẵn → gắn → xác nhận OK.

**Quyết định của người dùng (hỏi lại trước khi code):**

| Câu hỏi | Chọn |
|---|---|
| Chọn trang nguồn khi thay | **Ô nhập khoảng + dòng tóm tắt** (không render thumbnail file nguồn) |
| Chọn nhiều trang **rời nhau** rồi Thay | **Chỉ cho khi liền nhau** — rời nhau thì mục menu mờ |
| Copy ảnh | **Sửa cả (a) liên-tab và (b) clipboard Windows cướp Ctrl+V** |
| Chữ ký | **Mã hoá DPAPI** · **tự cắt viền trong suốt** · **xoá nền trắng (ảnh scan/JPG)** — *không* nối vào Ký số |

---

## 1. Thay trang (`replace`)

### 1.1 Hiện trạng (đọc tận nơi)

- Menu chuột phải thumbnail: `openThumbMenu` (`renderer/app.js`). Quy ước BI-26: chuột phải
  **ngoài** vùng chọn → chọn đúng trang đó; **trong** vùng chọn → giữ nhiều trang.
- Đường chèn: `insertFileAt` → `insertBuffersAt` (`pushUndo` → `PDFDocument.load` → `copyPages`
  → `insertPage` → `save` → `renderAll`). Xoá: `deletePages` (xoá từ cao xuống thấp).
- `state` chỉ có `bytes` là nguồn sự thật; mọi trạng thái theo trang (`vaultPages`, thumbnail,
  tìm kiếm) được **tính lại** trong `renderAll` ⇒ một thao tác cấu trúc mới không phải tự dọn gì.
- Parser khoảng trang dùng chung: `PageRange.parseSpec` (BI-27) — "1-3, 5", gạch en, `;`.

### 1.2 Thiết kế

- **Thuần** (DOM-free, `require()` được, có lưới): `renderer/page-range.js` thêm
  - `contiguousRun(indices)` → `{ start, count }` hoặc `null` khi rời / rỗng;
  - `replacePlan(targetSel, targetCount, srcSpec, srcCount)` → `{ start, remove, take[] }` hoặc
    `{ error }`. `take` **tăng dần** (PDF24 cũng vậy), trùng lặp bị gộp.
- **Menu**: `openThumbMenu` thêm "Thay trang này bằng PDF khác…" / "Thay các trang đang chọn
  bằng PDF khác…", **mờ** khi vùng chọn không liền (`contiguousRun === null`).
  Nút **Trang ▾** thêm mục cùng tên (tác động lên vùng đang chọn) để có đường bàn phím.
- **Luồng**: `replaceSelectedFromFile()` → `openPdf({multi:false})` → `PDFDocument.load` nguồn
  (lấy số trang, đồng thời phát hiện file hỏng/khoá **trước** khi mở hộp thoại) → hộp thoại
  `#replace-modal`: `(•) Tất cả N trang` / `( ) Các trang: [____]` + dòng tóm tắt sống
  "Sẽ thay trang 3 bằng 2 trang (1, 4) của abc.pdf" → **Thay trang**.
- **Lõi** `replacePagesWith(srcBytes, plan)`: **một** `pushUndo`, một lần load/save:
  `copyPages(src, take)` → xoá `remove` trang từ `start` (cao→thấp) → `insertPage(start+k)`.
  Chọn lại các trang vừa chèn. Ctrl+Z trả lại nguyên bản.
- **Trang ẩn có khoá** (`/NabuVault`) trong vùng thay: hỏi xác nhận riêng — thay là **mất vĩnh
  viễn** trang gốc đã mã hoá (chỉ còn Ctrl+Z trong phiên). `deletePages` hiện không hỏi; thay
  trang hỏi vì người dùng dễ tưởng "thay" giữ lại cái cũ ở đâu đó.
- Giữ nguyên kích thước / xoay của trang nguồn (PDF24 cũng thế). Cổng bản quyền `gateProFeature`
  như `insertFileAt`. Bị chặn khi đang Chú thích/Sửa chữ (`openThumbMenu` đã chặn sẵn).

### 1.3 Không đụng

`insertBuffersAt`, `deletePages`, `reorderPage`, `PageMove`, `page-vault.js`, sidecar.

---

## 2. Copy ảnh sang file khác — **đã xác nhận là lỗi, hai nguyên nhân chồng nhau**

### 2.1 (a) Ảnh bị loại khỏi clipboard liên-tab **có chủ đích**

`editor.js` `SHARE_EXCLUDED = new Set(["image"])` + `main.js` `annots:clip-write`: copy một ảnh
⇒ `shareClip` gửi `[]` ⇒ main **xoá** `objClip` và phát `null` ⇒ tab B không có gì để dán.
Lý do cũ: base64 vài MB mỗi lần Ctrl+C, nhân với **mọi** tab đang mở.

### 2.2 (b) Ảnh cũ trong clipboard Windows **cướp** Ctrl+V — kể cả trong cùng file

Listener `paste` của `editor.js` nhường cho `capture.js` hễ `clipboardData` có `image/*`
(luật bàn giao BI-77). Nhưng copy một **đối tượng** trong app **không đụng** clipboard Windows.
Luồng của chính người dùng: chụp màn hình → Ctrl+V vào trang (ảnh vẫn nằm trong clipboard
Windows) → chỉnh cỡ → Ctrl+C đối tượng → Ctrl+V ⇒ clipboard Windows **vẫn còn ảnh chụp gốc**
⇒ `capture.js` thắng ⇒ dán lại **ảnh chụp gốc, cỡ mặc định**, không phải bản đã chỉnh. Không
chỉ ảnh: **mọi** đối tượng (khung, chữ…) đều bị cướp như vậy khi clipboard Windows có ảnh.

Luật đúng phải là **"lần copy gần nhất thắng"**, không phải "ảnh OS luôn thắng".

### 2.3 Sửa (a) — ảnh qua tab bằng **bản nhẹ + nạp khi dán**, không phá BI-77

- `main.js`: `objClip = { id, items (ĐẦY ĐỦ), srcPage }`. Phát sang tab khác **bản nhẹ**
  `lightClip()` — `dataUrl` của ảnh bị bỏ, item gắn `_pending: true`, clip gắn `heavy: true`.
  Kênh mới `annots:clip-fetch (id)` → items đầy đủ **chỉ khi id còn khớp**.
  `annots:clip-read` (khởi động) cũng trả bản nhẹ.
- `editor.js`: bỏ `image` khỏi `SHARE_EXCLUDED`. `adoptSharedClip` giữ `id` + `heavy`.
  **Quyết định** dán vẫn đọc `clip` đồng bộ (không đổi một chữ ở listener). `requestPaste`
  — nơi duy nhất được `await` cho **việc** — gọi `hydrateClip()` **sau** `enter()`, kiểm lại
  clip có bị thay trong lúc chờ không. `pasteClip` **từ chối** clip còn `heavy` (lưới canh).
- Chi phí: một lần IPC renderer→main mỗi Ctrl+C có ảnh; phát cho N tab chỉ là JSON vài trăm
  byte; dữ liệu ảnh chỉ đi tiếp **khi và chỉ khi** có tab thật sự dán. Trần an toàn
  `SHARE_IMAGE_CAP` (tổng `dataUrl`) — vượt thì giữ ảnh lại trong tab như cũ + toast nói rõ.

### 2.4 Sửa (b) — Ctrl+C đối tượng **chiếm** clipboard Windows bằng một dấu nhận diện

- Listener `copy`: sau `copySelected()` ghi `e.clipboardData.setData(NABU_CLIP_MIME, …)`. Chromium
  **làm rỗng** clipboard Windows trước khi ghi ⇒ ảnh cũ biến mất (đúng ngữ nghĩa Copy ở mọi app).
- Listener `paste`: có `NABU_CLIP_MIME` ⇒ của mình (dù có gì khác). Không có dấu mà có ảnh ⇒
  ảnh được copy **sau** ⇒ `capture.js` như cũ. Luật BI-77 vẫn đúng nguyên văn cho ca
  "copy ảnh từ app khác **sau** khi copy đối tượng".
- Nút **Sao chép** / menu chuột phải (không có sự kiện `copy`): gọi `document.execCommand("copy")`
  để đi **cùng một** đường; nếu vì lý do gì listener không chạy thì rơi về `copySelected()`.

### 2.5 Không kiểm được bằng máy

Clipboard Windows không truy cập được từ shell này (memory `electron-probe-stdout-windows` §12).
Phần (a) kiểm bằng lưới (handler main **chạy thật** trên stub, `adoptSharedClip`/`hydrateClip`
cắt từ mã ship). Phần (b) chỉ kiểm được **cấu trúc**; vòng thật phải test tay (§5).

---

## 3. Chữ ký lưu sẵn

### 3.1 Nền có sẵn

Công cụ **Ảnh** (`ed.pendingImage` → `placeImage`), "Áp nhiều trang", menu chuột phải trang
(`capture.js` `onContextMenu`, `editor.js` menu đối tượng), `Capture.showMenu` (có `header`).
`managed-codec` ghi ảnh bằng **danh sách trường cố định** (`x,y,w,h,fmt`) ⇒ trường phụ trên
annotation (`sigId`) **không** lọt vào file.

### 3.2 Lưu trữ (main) — `src/signatures.js`

- **Một** file `userData/signatures.bin` = `safeStorage.encryptString(JSON)` (DPAPI, gắn với tài
  khoản Windows). Một file ⇒ một đơn vị nhất quán, không có file mồ côi; ghi `tmp` + `rename`.
- Nội dung `{ v:1, items:[{ id, name, png (dataUrl), wPt, at }] }`. Kiểm hợp lệ **lúc vào** (từ
  đĩa và từ IPC): PNG thật (`sniff` + `nativeImage` decode ở main), ≤ `MAX_BYTES`, ≤ `MAX_ITEMS`.
- `safeStorage.isEncryptionAvailable() === false` ⇒ **từ chối lưu** (người dùng đã chọn mã hoá;
  không âm thầm ghi thường). Đọc hỏng/giải mã hỏng ⇒ danh sách rỗng + cờ `unreadable`, **không**
  ghi đè file (luật page-vault §4: đọc hỏng không bao giờ xoá).
- Module nhận `fs`/`crypto` bằng tiêm phụ thuộc ⇒ `require()` được từ node, có lưới.
- IPC: `sig:list` · `sig:add` · `sig:rename` · `sig:remove` · `sig:set-width`; đổi ⇒ phát
  `sig:changed` cho mọi tab (danh sách trong menu luôn mới).

### 3.3 Xử lý ảnh (renderer, thuần) — `renderer/sig-image.js`

`removeWhiteBg(rgba, w, h, level)` (nền gần trắng → trong suốt, dải chuyển mềm giữ khử răng cưa)
· `trimBounds(rgba, w, h)` (hộp bao alpha > ngưỡng, đệm 2px) · `fitScale(w, h, max)`. DOM-free, có
lưới. Canvas chỉ dùng ở lớp mỏng bên ngoài.

### 3.4 Luồng người dùng

1. **Thiết lập**: Cài đặt → **Chữ ký của tôi…** (hoặc từ nút Chữ ký) → **Thêm** → chọn PNG/JPG
   → xem trước trên nền caro; **Xoá nền trắng** (bật sẵn khi ảnh không có trong suốt) + thanh
   **độ nhạy**; **Cắt viền** (bật sẵn) → đặt tên → **Lưu**. Đổi tên / xoá trong danh sách.
2. **Dùng — đường 1**: thanh Chú thích → nút **Chữ ký ▾** (cạnh Ảnh) → chọn → bấm lên trang.
3. **Dùng — đường 2**: **chuột phải lên trang** (xem hoặc Chú thích) → "Chèn chữ ký: <tên>" →
   chữ ký đặt **giữa điểm bấm** ngay lập tức (tự bật Chú thích).
4. Chữ ký là **ảnh sống**: kéo, đổi cỡ, "Áp nhiều trang". Bấm **Xong** = xác nhận ghi vào file.
5. **Nhớ cỡ**: lúc Xong, bề rộng của từng chữ ký đã đặt được lưu lại (`sig:set-width`) ⇒ lần
   sau chữ ký ra đúng cỡ quen dùng. Mặc định lần đầu 140 pt (~4,9 cm).

---

## 4. Bước thực hiện

| # | Bước | Test |
|---|---|---|
| S1 | `page-range.js`: `contiguousRun`, `replacePlan` | `test:pages` mở rộng |
| S2 | `app.js` + `index.html`: menu, hộp thoại, `replacePagesWith` | lưới S1 + pdf-lib thật trong node (`test:pages`) |
| S3 | `main.js`/`preload.js`: `lightClip`, `annots:clip-fetch`, id | `test:clip` §4–§5 chạy handler thật |
| S4 | `editor.js`: bỏ `image` khỏi loại trừ, `hydrateClip`, cờ `heavy`, dấu clipboard | `test:clip` §1–§3 + ca mới |
| S5 | `src/signatures.js` + IPC + preload | `test:sig` mới (fs/crypto tiêm) |
| S6 | `renderer/sig-image.js` | `test:sig` |
| S7 | UI chữ ký: modal quản lý, nút Chữ ký, menu chuột phải, nhớ cỡ | probe CDP nếu môi trường cho phép |
| S8 | i18n EN, `help.js`, REGRESSION-GUARD (BI mới + ma trận), HANDOFF | `test:help`, cả 24 lưới |

## 5. Kiểm tay bắt buộc (máy không thay được)

1. Chụp màn hình → Ctrl+V vào file A → chỉnh cỡ ảnh → Ctrl+C → Ctrl+V **trong A** → ra **bản đã
   chỉnh**, không phải ảnh chụp gốc.
2. Như trên nhưng Ctrl+V ở **tab B** và ở **cửa sổ khác** → ảnh sang, đúng cỡ, đúng vị trí.
3. Copy đối tượng trong app → copy một ảnh ở **app khác** → Ctrl+V trong Nabu → dán **ảnh mới**
   (luồng đặt ảnh), không dán đối tượng (BI-77 vẫn đúng).
4. Copy ảnh ở A → **mở tab C mới** → Ctrl+V → sang được (đường khởi động).
5. Thay trang: chuột phải trang 3 → Thay… → chọn file 5 trang → "Các trang: 2-3" → file còn đủ,
   trang 3 cũ biến mất, 2 trang mới ở vị trí 3–4 → Ctrl+Z trả nguyên.
6. Chữ ký: thêm ảnh scan JPG → xoá nền trắng → lưu → đóng app → mở lại → còn; copy
   `signatures.bin` sang tài khoản Windows khác → **không** đọc được (DPAPI).

---

## 6. Nhật ký thực hiện + kết quả (2026-09-26)

### 6.1 Lưới node — 24/24 bộ xanh

| Bộ | Trước | Sau | Ghi chú |
|---|---|---|---|
| `test:pages` | 50 | **77** | `contiguousRun`/`replacePlan` + `replaceInDoc` trên **pdf-lib thật** (5 ca: giữa, 2–4, **toàn bộ**, trang đầu, trang cuối) |
| `test:clip` | 59 | **102** | ảnh qua tab; `lightClip` chạy thật trên stub; `hydrateClip` chạy thật (6 ca, kể cả bị thay giữa lúc chờ, IPC hỏng); dấu `NABU_CLIP_MIME` trên cả 3 đường copy |
| `test:sig` | — | **71** | mới: kho mã hoá (fake DPAPI theo tài khoản), từ chối ghi thường, file không đọc được, kiểm hợp lệ, `sig-image.js`, nối dây |
| `test:help` | 287 | **290** chuỗi | 3 mục hướng dẫn mới, đủ VI/EN |
| 20 bộ còn lại | | | không đổi, xanh |

**Mutation test** (đổi mã → lưới phải đỏ → khôi phục): chèn cùng một chỉ số trong
`replaceInDoc` ⇒ 3 đỏ · phát `objClip` đầy đủ thay `lightClip` ⇒ 4 đỏ · bỏ `c.items = full`
⇒ 1 đỏ.

### 6.2 Nghiệm thu GUI trên app thật — 40/40

Probe CDP (`--remote-debugging-port` + `--user-data-dir` tạm + bộ switch chống đình chỉ frame,
memory `electron-probe-stdout-windows` §9–11), 2 tab, chuyển tab bằng chính thanh tab
(`shellBridge.activate`). Đo được:

- **Thay trang**: menu đúng nhãn / mờ khi chọn rời · hộp thoại ghi "Thay trang 3 bằng trang của:
  source.pdf (3 trang)" · `3, 1` ⇒ cây trang `[400,401,600,602,403,404]` · Ctrl+Z ⇒ `[400…404]` ·
  Esc không đổi gì · file hỏng ⇒ toast, không mở hộp thoại.
- **Chữ ký**: DPAPI sẵn sàng · ảnh scan 400×200 nền (245,244,240) ⇒ "Xoá nền trắng" tự tick,
  cắt còn **304×73**, góc α=0, nét α=255, bỏ tick cắt ⇒ về 400×200 (không mất mát) ·
  `signatures.bin` không chứa tên hay `IHDR` dạng rõ · tab kia thấy ngay · chuột phải ⇒
  "Chèn chữ ký: Probe GĐ" có ảnh nhỏ ⇒ chữ ký tâm (100.5, 200) so với điểm bấm (100, 200) pt,
  rộng 140pt · Xong ⇒ `/NabuData` = `{"k":"image",x,y,w,h,"fmt":"png"}` — **không có** `sigId`.
- **Clipboard**: copy ⇒ `defaultPrevented` + DataTransfer mang `application/x-nabu-annots` ·
  toast "Đã sao chép 1 ảnh…" (hết câu "chỉ dán được trong tab này") · tab B nhận `paste` đồng
  bộ, dán xong, ảnh có `data:image/png;base64,…` (đã nạp pixel) · ảnh **không** kèm dấu ⇒
  "Bấm lên trang để dán ảnh." (luồng cũ nguyên vẹn) · có dấu + ảnh ⇒ clip thắng.

### 6.3 Probe bắt được lỗi của chính bản đầu

Ô khoảng trang được `disabled` cho tới khi chọn radio — mà phần tử disabled **không nhận focus**,
nên mẹo "bấm vào ô là tự chọn *Chỉ các trang*" là mã chết và người dùng không bấm vào ô được.
Sửa: ô luôn mở, focus/gõ ⇒ tự chọn radio (BI-90 luật 4).

Hai ca đỏ khác của probe là lỗi **probe**, đã chẩn đoán trước khi sửa: (a) tâm chữ ký lệch 41px
**trên màn hình** vì thanh Chú thích hiện ra đẩy trang xuống — đo lại trong không gian trang thì
khớp; (b) menu chuột phải "không hiện" vì `scrollIntoView()` của probe phát sự kiện scroll **sau**
khi menu mở, mà menu vốn tự đóng khi cuộn.

### 6.4 Đo `execCommand("copy")` (Browser pane, Chromium hiện hành)

Không có vùng chọn chữ nào: `execCommand("copy")` trả `true`, phát **1** sự kiện `copy`,
`setData("application/x-nabu-annots")` ghi được (`types` chứa nó) — có hay không có
`preventDefault` ở `beforecopy` đều vậy. Phím **giả lập** Ctrl+C/Ctrl+V trong pane **không**
kích hoạt lệnh sửa (0 sự kiện), nên đường phím thật chưa đo được ⇒ lý do mọi đường copy đều
đi qua `copyGesture()`.

### 6.5 Còn phải test tay (máy không làm được)

1. Vòng **clipboard Windows thật**: chụp màn hình → dán → chỉnh cỡ → Ctrl+C → Ctrl+V (§5 mục 1–3).
   Probe dùng `DataTransfer` tổng hợp, không đi qua clipboard OS.
2. **Phím Ctrl+C thật** (menu role `copy` + keydown dự phòng) ghi được dấu.
3. `signatures.bin` chép sang **tài khoản Windows khác** ⇒ "không đọc được" (lưới dùng DPAPI giả).
4. Nhìn tận mắt: nút chữ ký trên thanh Chú thích, hộp thoại Chữ ký ở theme **Sáng**, EN.
