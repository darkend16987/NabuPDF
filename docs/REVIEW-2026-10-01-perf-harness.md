# Review hiệu năng & harness — Nabu PDF

_Soạn 2026-10-01 trên v0.2.73 + `11643fb` (nhánh `claude/vietnamese-ocr-ai-iSvwV`)._
_**Chỉ đọc — không có dòng code nào bị sửa để viết tài liệu này.**_

## 0. Phương pháp

Theo tinh thần của `alibaba/open-code-review`: **ưu tiên độ chính xác hơn độ phủ**.
Một phát hiện chỉ được ghi khi đã đọc lại đúng đoạn code, và phần lớn đã được **đo**.

1. Đọc tài liệu cũ trước để **không báo lại** việc đã biết, đã sửa, hoặc đã bị phép đo bác bỏ:
   - `PERF-MEMORY.md`
   - `RESEARCH-2026-09-15-deps-perf-audit.md` (§9 ghi 3 giả thuyết đã bị bác bỏ)
   - `REVIEW-caps-2026-08-12.md`
   - hai tài liệu CAD perf
   - tài liệu zoom
   - `REGRESSION-GUARD.md` (BI-*)
2. Chia 3 vùng review song song:
   - sidecar Python
   - main process Electron
   - renderer
3. Tự kiểm chứng lại các phát hiện nặng nhất: đọc lại code, và chạy lại phép đo khi rẻ (đánh dấu ✔︎).
4. Chạy toàn bộ lưới test hiện có:
   - **Python 16/16 PASS** (~155 s)
   - **JS 24/24 PASS** (~29 s)

Mức độ: 🔴 cao · 🟠 trung bình · 🟡 thấp. Số dòng tính theo `11643fb`.

---

## 1. Sidecar Python (`api.py`, `src/`)

> Sự thật nền: **cả 31 route đều là `async def`**. Mọi việc CPU trong route chạy
> **trên event loop**, nên một request nặng làm treo cả `/health` lẫn mọi tab khác.
> REVIEW-caps F1 đã biết điều này cho **compress**, và kết luận "đưa sang thread không giúp gì"
> vì fitz giữ GIL. Kết luận đó **không áp dụng cho OCR và Gemini** (xem S1, S2).

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| S1 | 🔴 | **OCR chạy trên event loop.** Các route: `/ocr` `api.py:340`, `/extract` `:426`, `/searchable` `:687`, `/ocr-span` `:2293`, `_ocr_words` trong compare. Model nạp lazy trong `_get_ocr` cũng chạy trên loop. | `/health` lúc rảnh **1,3 ms**. Trong lúc chạy `/searchable` 2 trang: **58 s** (cold) và **24 s** (warm). Onnxruntime/torch **có nhả GIL**: chạy `recognize()` ở thread phụ thì main tick đều, khe hở tối đa 10 ms. |
| S2 | 🔴 | **Gemini gọi đồng bộ trong `async def`** và **không có timeout HTTP**. Client tạo ở `gemini_agent.py:54` mà không truyền `http_options`, và google-genai mặc định `timeout=None`. `/translate-pdf` gọi tuần tự từng trang. | ✔︎ Đã đọc lại `:54`. Hệ quả: Wi-Fi rớt giữa chừng thì sidecar **treo vĩnh viễn**, vì `/health` chỉ được poll lúc khởi động. Chỉ còn cách tắt app. |
| S3 | 🔴 | **`doc.tobytes(garbage=3)` tăng chi phí xấp xỉ bậc hai theo số object**, và chạy ở **mọi route ghi**: `api.py:741, 1095, 1172, 1325, 1417, 2781 (/edit-text), 3154` và `drawing.py:535`. | ✔︎ **Đo lại độc lập**: 150/300/600 trang mất `garbage=2` 0,10/0,19/0,31 s, `garbage=3` 0,32/1,29/**5,2 s**. Agent đo được 1200 trang (45k object) mất **46,9 s**. Một lần sửa 1 span trên tài liệu 300 trang tốn 3,2 s, trong đó 2,9 s nằm ở bước ghi. |
| S4 | 🟠 | **Diff văn bản của `/compare` tăng bậc hai**: `comparator.py:145` dùng `SequenceMatcher(..., autojunk=False)`, trần token là 300k. | 10k token mất 1 s; 60k mất 24 s; 100k mất **69,5 s**. Ngoại suy tới trần 300k: khoảng 10 phút trên loop. Prototype diff 2 tầng (dòng trước, rồi mới tới từ) giảm từ 25,9 s xuống **4,3 s**, tập token thay đổi **giống hệt**. |
| S5 | 🟠 | **`/images-to-pdf` encode lại mọi ảnh thành PNG**, kể cả JPEG: `api.py:1303-1307`. | ✔︎ Đã đọc lại code. Ảnh JPEG 12 MP (2,2 MB) cho ra trang **34 MB** trong 7 s. Nhét thẳng JPEG thì trang **2,2 MB** trong 0,2 s. Lô "100 ảnh điện thoại" mà `wire.js` dự liệu sẽ cho ra PDF cỡ vài GB. |
| S6 | 🟠 | **Cache Tìm & Thay bị xoá sau mỗi lần Thay**: key là hash bytes (`api.py:2012-2026`). Sau khi ghi, bytes mới luôn trượt cache, nên phải dựng lại index cho cả tài liệu. | Code comment ước tính "hàng chục giây" cho bộ A1 480 trang. |
| S7 | 🟡 | `/edit-text` đọc lại file font từ đĩa ở mỗi lần sửa: `:2589, :2639, :2750`. | Thay tất cả 1600 chỗ: 31% thời gian nằm ở `fz_new_font_from_file`. |
| S8 | 🟡 | File ZIP nén deflate lại ảnh vốn đã nén: `api.py:1224, :1465`. | JPEG: 2,12 s so với 0,18 s nếu dùng `ZIP_STORED`, dung lượng như nhau. |
| S9 | 🟡 | `/overlay-drawings` render cả hai bản ở 3000 px chỉ để tính độ lệch: `drawing.py:452`. | 2,19 s ở 3000 px, so với 0,40 s ở 256 px. |
| S10 | 🟡 | `/text-spans` và `/ocr-span` gửi lại **toàn bộ** PDF dạng base64 ở mỗi lần gọi. | 150 MB: khoảng 0,64 s phía server cho mỗi lần gọi. |

## 2. Main process Electron (`desktop/src`)

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| M1 | 🔴 | **Mở tài liệu dùng `fs.readFileSync` trên main thread**: `main.js:153-167` `sendFileToView` và `:178-206` `sendFileToPane`. Các đường đi qua đây: Open, Open with, khôi phục phiên, đánh thức tab hoãn, và **mỗi lần Ctrl+S khi đang chia đôi màn hình** (đọc lại file vừa ghi). | ✔︎ Đã đọc lại. Đọc 400 MB khi đã có cache: loop đứng **614 ms**. Đọc từ NAS hoặc HDD thì **mọi cửa sổ** đứng "Not Responding". |
| M2 | 🟠 | Các hộp chọn nhiều file và tính năng Gộp từ Explorer đọc đồng bộ **tất cả** file rồi trả về trong **một** IPC: `main.js:864, 903, 216-230`. | Gộp 10 × 100 MB nghĩa là 1 GB đọc đồng bộ, rồi 1 GB structured clone. |
| M3 | 🟠 | Gọi `existsSync`/`statSync` trên đường dẫn có thể là ổ mạng. `openDefault`/`saveDefault` chạy **trước mọi hộp thoại file**, và `restoreSession` cũng gọi. | Đường UNC tới máy chủ không phản hồi chặn **21 s**. Ví dụ: laptop rời VPN, bấm Ctrl+O lần đầu là app treo 21 s. |
| M4 | 🟠 | `Buffer.from(data)` **sao chép** cả tài liệu ở mỗi lần lưu và **mỗi lần autosave**: `main.js:918, 928, 950, 1820`. | ✔︎ Đã đọc lại. Renderer gửi lên `Uint8Array`, và `Buffer.from(Uint8Array)` sao chép (192 ms cho 400 MB). Cách sửa là truyền thẳng vào `writeFile`. |
| M5 | 🟠 | **Tab hoãn khi khôi phục phiên vẫn chạy `loadFile(index.html)` đầy đủ** (`tabs.js:596`). `deferred` chỉ hoãn việc đọc file. | ✔︎ Đã đọc lại. Phiên 10 tab = 10 renderer đầy đủ ngay lúc mở app, ngược với SESSION-RESTORE §1. |
| M6 | 🟠 | `wire.js` giữ **toàn bộ** chuỗi base64 trong mảng `parts` cho tới `new Blob(parts)`. Comment ở `:37-39` ("chỉ một chunk 48 KB còn sống") là **sai**. | ✔︎ Đã đọc lại `:56-81`. Payload 120 MB chiếm khoảng 160 MB heap. Tính năng Sửa nội dung gửi kiểu này ở mỗi lần sửa. |
| M7 | 🟡 | Sidecar không qua được health check trong 180 s thì **bị bỏ mồ côi**: `sidecar.js:131`, `waitForHealth` reject mà không ai kill child. | ✔︎ Đã đọc lại. `sidecar.exe` còn chạy sau khi thoát app, có thể là nguồn của lỗi EBUSY khi rebuild. |
| M8 | 🟡 | Ghi file **đè tại chỗ**, không qua temp + rename: `recovery:save` `:1820` và `file:write-pdf` `:928`. | Đây là an toàn dữ liệu, không phải hiệu năng. Mất điện giữa lúc ghi thì hỏng bản gốc hoặc bản khôi phục. |
| M9 | 🟡 | `license:get` không gộp các request trùng: N tab cùng gọi refresh một lúc. Kho chữ ký được broadcast toàn bộ cho mọi tab. | Không đáng kể ở quy mô hiện tại. |

## 3. Renderer (`desktop/renderer`)

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| R1 | 🔴 | **Zoom đúng lúc trang đang render thì trang mờ mãi, và bitmap bị rò.** `renderPageCanvas` (`app.js:916`) chụp `vp` **trước** `await` nhưng gán `m.paintScale = state.scale` **sau** đó. `commitScale` (`:3093`) gặp trang đang render thì set `rendered="0"`, và `renderPageCanvas` thoát sớm vì `m.rendering`. Kết quả: bitmap ở scale cũ bị dán nhãn scale mới, `rendered="0"`, nên `freePageCanvas` không bao giờ nhả nó. | ✔︎ Đã đọc lại cả hai hàm. Đây là **BI-36 quay lại theo đường mới**. |
| R2 | 🔴 | **Không bao giờ huỷ render khi cuộn nhanh**: cả renderer không có chỗ nào gọi `.cancel()`, `RenderTask` không được giữ lại. | ✔︎ Grep: 0 lần gọi. Kéo thanh cuộn bản A1 86 trang: mỗi trang đi qua dải được render đủ 1,1–2,6 s, cộng lại hàng chục giây trước khi tới trang đích. |
| R3 | 🔴 | **Watermark hoặc bake hàng loạt làm lại thumbnail của MỌI trang, tuần tự, sau overlay modal**: `app.js:1408` gọi `await refreshThumb(i)` **nằm ngoài** nhánh `if (wasRendered)`. | ✔︎ Đã đọc lại. Comment "không rasterise mọi trang" chỉ đúng cho canvas trang. Bản A1 86 trang mất khoảng 15–80 s. |
| R4 | 🟠 | Zoom ở màn Chồng lớp **không chống gọi chồng**: nhiều `page.render` cùng vẽ lên một canvas, pdf.js reject mà không ai bắt lỗi, và hai lớp lệch scale. Mỗi nấc zoom còn chạy `getImageData` 128 MB hai lần: `compare.js:890-962`. | Đọc code + chuỗi lỗi có trong `pdf.min.js`. |
| R5 | 🟠 | Màn So sánh dựng lại toàn bộ pane ở **mỗi nấc** zoom (`innerHTML=""`). Các render đang chạy trên slot đã tách khỏi DOM không được nhả: `compare.js:323-339, 438`. | Chính kiểu lỗi BI-36 đã gỡ khỏi viewer chính. |
| R6 | 🟠 | `ensureSearchIndex` (`app.js:1233`) **không ghi nhớ promise đang chạy**: gõ chậm khi Ctrl+F là chạy nhiều lượt `getTextContent` toàn tài liệu chồng lên nhau. `runSearch` không có số thứ tự, nên kết quả cũ có thể đè kết quả mới. | ✔︎ Đã đọc lại. |
| R7 | 🟠 | Quét marker trang ẩn (vault) bằng vòng lặp JS từng byte ở **mỗi** `renderAll`: `page-vault.js:229`. | 128 MB: 345–372 ms; Boyer–Moore–Horspool: 63–68 ms, cùng kết quả. |
| R8 | 🟠 | Ctrl+S giữa phiên chú thích **vẽ lại các trang trong dải giữ hai lần** và parse pdf-lib lần thứ hai: `editor.js:4135-4140`. | |
| R9 | 🟠 | Khung xem chia đôi nhận bitmap scale cũ sau khi zoom, và mờ mãi: `view.js:246-310`. | Cùng kiểu lỗi với R1. |
| R10 | 🟡 | Hàng đợi thumbnail theo FIFO, không bỏ các mục đã cuộn qua: `thumb-queue.js:46`. | |
| R11 | 🟡 | Canvas bị bỏ mà không `width=height=0` (`off` canvas, teardown, compare). Repo tự đặt luật này ở `view.js:freeCanvas`. | Đỉnh RAM cao gấp đôi khi render. |
| R12 | 🟡 | `snapshot()` sao chép **cả tài liệu** ở mỗi lần undo/redo/push (`app.js:181…`). Không có chỗ nào sửa `state.bytes` tại chỗ, nên giữ tham chiếu là đủ. | Đụng BI-3, cần cẩn thận. |
| R13 | 🟡 | `getTextContent` được lấy lại ở mỗi lần repaint và mỗi lần tìm. Mỗi nấc Ctrl+lăn dựng lại toàn bộ annotation của mọi trang. | Chưa đo với 300 markup. |

**Trạng thái PERF-MEMORY:**
- P1 (trần undo 512 MB) **chạy đúng** (đã mô phỏng).
- P5 đã làm.
- **P2, P3, P4 vẫn chưa làm.**
- M5 (thumbnail không bao giờ nhả) vẫn đúng.

---

## 4. Harness (lưới test, quy trình phát hành, môi trường cho agent)

"Harness" ở đây hiểu theo hai nghĩa: (a) **lưới test + cổng phát hành**, (b) **ngữ cảnh mà AI agent nhận được** khi làm việc trên repo.

| # | Mức | Vấn đề | Bằng chứng |
|---|---|---|---|
| H1 | 🔴 | **`/deploy` không chạy bộ test JS nào.** Bước 1 chỉ chạy `run_tests.py` cộng `node --check` cho 3 file. 24 bộ `desktop/test/*.test.js` (hơn 3 000 assertion) **không nằm trong cổng phát hành**. Không có script `npm test` tổng hợp, không có CI (`.github/` không tồn tại). | ✔︎ `deploy.md` §1. Chạy thử: 24/24 PASS trong ~29 s, nên đưa vào cổng gần như miễn phí. |
| H2 | 🟠 | **Không có `CLAUDE.md`/`AGENTS.md`**: mỗi phiên agent bắt đầu mà không biết luật dự án. Tri thức nằm trong `HANDOFF.md` (**267 KB**) và `REGRESSION-GUARD.md` (**282 KB**), mỗi file cỡ 70k token trở lên, quá lớn để nạp cả. `/deploy` còn **thêm** một mục vào HANDOFF mỗi lần phát hành. | ✔︎ `wc -c`. Bản đồ "đụng gì → test gì" (§5) nằm sâu trong file 282 KB. |
| H3 | 🟠 | **Không có harness đo hiệu năng.** Mọi con số trong docs đến từ script tạm trong scratch. Lần review này phải viết lại hơn 10 probe (loop_probe, g3_scale, difflib…). Probe CDP cho GUI (ghi trong memory) cũng không có trong repo. Các lỗi đua (race) R1/R2/R4/R9 đúng là loại mà unit test thuần **không bắt được**. | |
| H4 | 🟠 | **Một test chiếm nửa thời gian của cả bộ Python**: `test_edit_text_metrics.py:105` `_ink()` duyệt từng pixel bằng Python ở zoom 8. | ✔︎ **Đo**: 50,5 s mỗi lần gọi; bản numpy **0,56 s**, kết quả **giống hệt**. Cả file mất 78,6 s trên tổng ~155 s. |
| H5 | 🟡 | Tài liệu harness cũ: `REGRESSION-GUARD.md:38` ghi "Renderer gần như không có test tự động" (nay đã có 24 bộ). `deploy.md` trỏ tới `[memory] sidecar-stale-build-guard`, nhưng memory này không tồn tại. | ✔︎ |
| H6 | 🟡 | `.claude/settings.local.json` cho phép **không cần hỏi** `gh release *` (kể cả `delete`), `git commit *`, `winget install *`, kèm nhiều mục dùng một lần đã cũ (đường dẫn task của phiên khác, `Bash(break)`). | Là file cục bộ của bạn; chỉ nêu ra, không sửa. |
| H7 | 🟡 | Nhiều test là **assertion trên mã nguồn** (regex trên `app.js`/`editor.js`, hoặc cắt hàm bằng `new Function`). Đã có lý do (DOM không test được), nhưng dễ vỡ khi refactor, và pass không có nghĩa là hành vi đúng. | |

---

## 5. Kế hoạch đề xuất (chưa thi công — chờ bạn chốt)

Thứ tự theo **giá trị ÷ rủi ro**. Mỗi đợt đi theo quy trình: lưới test xanh **trước** → sửa → lưới xanh **sau** → thêm test canh giữ.

**Đợt 0 — harness (làm trước, để các đợt sau có lưới):**
- H1: thêm `desktop/scripts/run-tests.js` cùng `npm test`, rồi đưa nó vào bước 1 của `/deploy`.
- H4: thay vòng lặp từng pixel bằng numpy (đã chứng minh kết quả giống hệt).
- H2: thêm `CLAUDE.md` ngắn (dưới 150 dòng): cách chạy test, 10 BI quan trọng nhất, và trỏ tới §5 của REGRESSION-GUARD.
- H5: sửa hai chỗ tài liệu cũ.
- G1, G2, G3, G5, G6 (§6.4): hàng rào cấu trúc — test scope toàn cục, test hợp đồng IPC, ratchet `state.bytes =`, bản đồ trong `CLAUDE.md`, bỏ theo dõi 2 file build/cục bộ. Không đổi hành vi.

**Đợt A — rủi ro thấp, diff nhỏ, lợi lớn:**
- S3 `garbage=3→2`, giữ nguyên cho Nén.
  - Đánh đổi: file có thể lớn hơn khoảng 1–2% (đo được 1,5%).
  - Canh giữ: test thời gian + dung lượng.
- S2 thêm timeout HTTP cho Gemini.
- M4 bỏ `Buffer.from` thừa.
- M7 kill sidecar khi health check timeout.
- R3 thumbnail đi qua `thumbQueue`/observer.
- R6 ghi nhớ promise index, thêm số thứ tự cho `runSearch`.
- R7 quét vault bằng BMH.
- S7, S8.

**Đợt B — rủi ro trung bình:**
- S1 + S2 đưa OCR/Gemini sang `ThreadPoolExecutor(max_workers=1)`, giữ fitz trên loop.
- M1 + M3 đọc file async, đặt trần thời gian cho đường UNC.
- R1 chụp scale trước `await`.
- S5 nhét thẳng JPEG/PNG (cần kiểm EXIF và CMYK).

**Đợt C — cần probe CDP trong repo trước (H3):**
- R2 huỷ render.
- R4, R5 compare/overlay.
- M5 tab hoãn không `loadFile`.
- R9 view.js.
- R8.

**Đợt D — thuật toán, cần fixture:**
- S4 diff 2 tầng.
- S6 index tìm kiếm tăng dần.
- M6 gộp `parts` của wire.js thành Blob con.

**Đợt E — cấu trúc (sau khi A–C ship và test tay xanh; chi tiết §6.3–6.4):** G4 `commitBytes` cho code mới rồi chuyển dần; tách khối `baking` khỏi `editor.js` theo luật byte-identical. Việc kiểm kê trạng thái dùng chung của `api.py` (A6) đi **cùng Đợt B**, không để sau.

**Không đề xuất:** những gì deps-perf-audit §9 và các tài liệu CAD đã đo và bác bỏ: gom `getPage`, nạp động `help.js`, `toBlob`, `page.cleanup()`, MuPDF, nâng pdf.js 6.

---

## 6. Cấu trúc codebase & khả năng bảo trì (bổ sung theo yêu cầu, cùng ngày)

Phạm vi: file lớn, ranh giới module, độ ghép nối, vùng không có lưới test, vệ sinh repo — xem chúng gây rủi ro gì khi **bảo trì, thêm tính năng, sửa lỗi**. **Không sửa dòng code nào.**

### 6.0 Phương pháp & giới hạn của phép đo
- Cỡ file/hàm: tự viết bộ quét ngoặc `{}` (không có parser JS trong repo) cho JS; `ast` cho `api.py`. **Giới hạn đã biết:** bộ quét JS chỉ bắt `function x(` và `const x = (…) =>`, bỏ sót method trong object literal và callback `ipcMain.handle(..., async () => {…})` ⇒ với `main.js`/`tabs.js` con số hàm là **cận dưới**. Số dòng "code" = trừ dòng trống và dòng comment đứng riêng.
- Ghép nối: quét regex tên cấp-0 của `app.js` (268 tên) trong các file renderer còn lại. Là xấp xỉ (có thể đếm nhầm tên trùng chữ trong chuỗi/comment).
- Churn: `git log --numstat` theo tháng. Số token của file: **ước lượng**, không đo.
- **Đã đọc `docs/REGRESSION-GUARD.md:46-129`** — tài liệu này ĐÃ phân tích việc tách `editor.js` (v0.2.48) và **bác bỏ module hoá toàn bộ** với 4 lý do đo được. Mục này không lật lại quyết định đó mà **cập nhật số đo** và chỉ ra điều nào còn đúng / đã đổi (§6.3).

### 6.1 Bản đồ kích thước

| File | Dòng | Code thực ≈ | Ghi chú đo được |
|---|---:|---:|---|
| `desktop/renderer/app.js` | 5 864 | 4 400 | 268 tên cấp-0 trong **một scope chung**; 218 hàm, hàm lớn nhất 113 dòng (không có "hàm khổng lồ", vấn đề là **bề rộng**) |
| `desktop/renderer/editor.js` | 5 459 | 3 670 | **một IIFE**; 144 hàm; **`renderAnnot` 483 dòng, `onDown` 276, `drawOneAnnot` 261, `addManagedAnnot` 220**; 463 chỗ chạm `ed.*` |
| `api.py` | 3 382 | 2 450 | 29 route + 45 model pydantic + helper trong một file; **`edit_text` 436 dòng, `translate_pdf` 276** |
| `desktop/src/main.js` | 1 897 | 1 280 | **57** `ipcMain` handler, **13** biến `let` mức module (clipboard đối tượng, kéo trang, máy in, chữ ký…); menu + in + clipboard + kéo trang + split trong một file |
| `desktop/renderer/index.html` | 1 575 | | 496 `id`, 30 `style=` inline; toàn bộ UI một trang; **thứ tự `<script>` mã hoá bằng comment HTML** |
| `HANDOFF.md` / `REGRESSION-GUARD.md` | 267 KB / 282 KB | | xem H2 |

Tăng trưởng (dòng cộng ròng theo `numstat`, từ 2026-06): `editor.js` **3 641 → 5 459 (+50%)** kể từ lúc REGRESSION-GUARD đo ở v0.2.48; `app.js` ~+6 000 trong 4 tháng; `api.py` ~+3 500. Tháng 9 chậm lại (editor +871, app +380, api +41) nhưng chưa dừng.

**Phần tốt cần giữ nguyên (đo được):**
- `tabs.js` (1 510 dòng) toàn hàm ≤39 dòng, thuần logic, có 725 dòng test. Trong `desktop/src/`: **54%** số dòng nằm trong file `require()` được từ node (`renderer/`: chỉ **24%**).
- `editor.js` có **bề mặt công khai rất hẹp**: `window.Editor` chỉ 14 thành viên (`editor.js:5433`). Ranh giới ngoài sạch; chỉ bên trong là một cục lớn.
- Tiền lệ tách đã chứng minh an toàn: `wire / annot-text / annot-geom / managed-codec / page-vault` (UMD + tên trần + chứng minh byte-identical). Quy trình này **dùng lại được**.
- `api.py` đã từng được rút `src/pdf/*` ra (commit `65b38bf`) với lưới test chạy trước/sau. Lưới Python là mạnh nhất repo: trong 29 route chỉ **5** không có test nào nhắc tới (`/config` POST, `/pdf-to-office`, 3 route `compare-drawings`).

### 6.2 Phát hiện (xếp theo rủi ro bảo trì)

| # | Mức | Phát hiện | Bằng chứng | Hậu quả khi bảo trì |
|---|---|---|---|---|
| A1 | 🔴 | **"Giao thức ghi bytes" nằm ở quy ước, không ở code.** Mọi thao tác phải theo đúng thứ tự: `pushUndo()` **trước** khi `state.bytes` đổi (BI-3) → `markDirty` (nằm trong `pushUndo`) → đôi khi `resetHistory`/`scrubRecoverySnapshot` → render. Không có hàm `commitBytes()` duy nhất. | `state.bytes =` được **ghi ở 17 chỗ trong 4 file** (`app.js` ×13, `editor.js` ×2, `find-replace.js`, `text-edit.js`); `app.js` có ≥10 khối `PDFDocument.load → sửa → save → renderAll` viết tay, mỗi khối khác nhau chút ít. `app.js:2033-2040` phải dùng **comment** giải thích "NOT pushUndo()". `find-replace.js:606` và `text-edit.js:692` mỗi nơi tự nhắc "pushUndo trước". Đoạn parse lỗi sidecar `ct.includes("json")` được chép ở 3 file. | Thêm một tính năng sửa-file mới mà quên một bước ⇒ **mất Ctrl+Z, hoặc không bật cờ dirty ⇒ đóng cửa sổ không hỏi lưu / không có snapshot phục hồi ⇒ mất dữ liệu**, và **không test nào bắt** (không có test chạy `app.js`). Đây là rủi ro bảo trì lớn nhất — **không phải kích thước file**. |
| A2 | 🔴 | **Một scope toàn cục chung, không có kiểm tra lúc build.** 22 classic script; `editor.js` dùng **24** tên trần của `app.js`, `page-move.js` 20, `view.js` 19, `find-replace.js` 18, `compare.js` 15… Thứ tự nạp chỉ được ghi bằng comment trong `index.html` (≥8 chỗ "phải nạp TRƯỚC/SAU"). | Đã ghi sẵn trong REGRESSION-GUARD §2 và BI-14 (đã **hai lần** làm "app trắng": khai trùng binding cấp-0; commit `54b319e`). `node --check` **không** bắt được lỗi này (cú pháp hợp lệ). | Đổi tên/di chuyển một hàm trong `app.js` ⇒ file khác chết **ở runtime**, thường chỉ lộ khi người dùng bấm đúng tính năng. Mọi việc "tách file" hay "đổi tên" đều chạm vào đây. |
| A3 | 🟠 | **`editor.js`: thêm một loại chú thích = sửa ~6 nơi tách rời, và danh sách loại viết tay bị lặp.** | `kind === "cloud"` ở `editor.js` dòng 1000, 1776, 3886, 5136…; mảng literal `["draw","box","ellipse","cloud","cloudpen","poly","arrow","check","cross"]` lặp tại **1774 và 5107**, trong khi đã có `FILLABLE_KINDS` ở dòng 103 (không dùng thống nhất). Loại còn xuất hiện ở `annot-geom.js`, `managed-codec.js`, `compare.js`. `renderAnnot` 483 dòng là một chuỗi if theo `kind`. | Quên một nơi ⇒ chú thích **hiện đúng trên màn hình nhưng lệch/mất khi lưu** (render ≠ bake): "sai im lặng", đúng loại REGRESSION-GUARD coi là nguy hiểm nhất. |
| A4 | 🟠 | **~76% code renderer không `require()` được ⇒ chỉ có test đọc mã nguồn hoặc probe tay.** | 24% / 54% ở §6.1. 4 bộ test ghim bằng regex trên `editor.js`/`app.js`: `annot-defaults` **37** assertion, `annot-clip` 17, `managed-image` 17, `annot-rotate` 4. | (1) **Hai lưới mâu thuẫn khi refactor**: tách/đổi tên hàm làm ~75 assertion đỏ giả, người sửa dễ "sửa test cho xanh" thay vì hiểu. (2) Pass ≠ hành vi đúng (H7). |
| A5 | 🟠 | **`main.js`: 13 biến trạng thái mức module + 57 handler IPC + 68 kênh ở preload, không có hợp đồng kiểm được.** | Đã quét tự động: **0 lệch** giữa kênh `preload` ⇄ `ipcMain` (các kênh `license/sign/update` nằm ở module khác, `view:clear` có người nghe) — hiện **sạch**, nhưng không test nào giữ cho nó sạch. | Gõ sai tên kênh ⇒ nút chết, không báo lỗi. Trạng thái `objClip`, `pageDrag`, `_pageReqSeq`, `_defPrinter` dùng chéo trong 1 900 dòng. |
| A6 | 🟠 | **`api.py`: nghiệp vụ nằm trong handler; trạng thái toàn cục sửa được.** | `edit_text` 436 dòng gộp nhóm theo trang + redact + chèn lại chữ; `global ocr_engine / gemini_agent` (3 chỗ: `api.py:153,212,290`), `_FIND_CACHE` (`:1926`). Test import thẳng handler (`from api import edit_text, …`) ⇒ **tách file sẽ vỡ import của test** trừ khi re-export. | **Liên quan trực tiếp tới kế hoạch perf Đợt B (S1/S2)**: chuyển OCR/Gemini sang threadpool biến `ocr_engine`, `gemini_agent`, `_FIND_CACHE` thành **dữ liệu dùng chung giữa luồng** — hiện không có lock. Phải xử lý cùng lúc, không phải việc riêng. |
| A7 | 🟡 | **Tri thức dự án mục theo dòng số → mục dần.** | `REGRESSION-GUARD.md` có **18** tham chiếu dạng `app.js:3446`; sổ có **92** mã BI nhưng code chỉ nhắc **47** mã. Mỗi release thêm một mục vào HANDOFF (88 commit chạm file này, nhiều thứ hai sau `package.json`). | Người/agent đọc tin vào dòng số sai. (H2 đã nêu phần "quá lớn"; đây là phần "mục".) |
| A8 | 🟡 | **Vệ sinh repo.** | **Đã theo dõi (tracked) nhưng không nên**: `.claude/settings.local.json` (32 KB, 287 luật cho phép, 5 commit — **đã kiểm: không có token/secret literal**, chỉ có `$env:GH_TOKEN = (gh auth token)`), `web/tsconfig.tsbuildinfo` (artifact build), `.agent/skills/ui-ux-pro-max/` (28 file của bên thứ ba). Gốc repo trộn 16 file `test_*.py` + `app.py/cli.py/api.py/sidecar.py/run_tests.py/check_outputs.py` với `web/`, `site/`, `supabase/`, `desktop/` (nhiều sản phẩm một repo, chưa có bản đồ thư mục). 14 file `build-*.log` ở gốc chỉ nhờ `.gitignore` mới không bị commit. | Nhiễu diff, khó định hướng cho người/agent mới; `settings.local.json` theo quy ước là file **cục bộ**, đưa lên remote là sai chỗ (không rò rỉ, nhưng sẽ ghi đè lẫn nhau giữa các máy). |

### 6.3 Đánh giá: có nên "tách file lớn"?

**Kết luận: KHÔNG làm một đợt tách lớn. Nhưng "không tách" ≠ "không làm gì".** Đối chiếu với 4 rào cản của REGRESSION-GUARD:

| Rào cản cũ (v0.2.48) | Hiện nay | Ý nghĩa |
|---|---|---|
| 1. ESM bị chặn bởi `file://` + CSP + `sandbox` | **Chưa kiểm lại** (lấy từ doc cũ; `tabs.js` vẫn dùng `loadFile` nên nhiều khả năng còn đúng) | Không có module thật ⇒ tách file chỉ thêm một mảnh vào scope chung (A2 nặng thêm, không nhẹ đi) |
| 2. Bundler phá "cái được test chính là cái chạy" | Còn đúng — các bộ test vẫn cắt hàm khỏi file đang ship | Không dùng bundler |
| 3. `ed` là điểm dính | **Đã nặng hơn:** 345 → **463** chỗ `ed.*` | Tách phần bám `ed` = viết lại ngữ nghĩa trên file nguy hiểm nhất |
| 4. Không có áp lực cộng tác (1 người, ~20 commit) | **Đổi một nửa:** vẫn 1 người viết (154/163 commit), nhưng `editor.js` nay **40 commit trong 4 tháng**, và "cộng tác viên" mới là **AI agent** — hạn chế thật của agent là cửa sổ ngữ cảnh: đọc cả `editor.js` ≈ 265 KB (ước tính vài chục nghìn token) | Kích thước **có tốn kém** nhưng chủ yếu cho agent, không phải con người; giải bằng **bản đồ + điều hướng** rẻ hơn là tách |

**Nhưng đo theo từng khối cho thấy có đường tách *rẻ* và có thật** (cột `ed.`/DOM đo trên từng mục banner của `editor.js`):

| Khối trong `editor.js` | Dòng | `ed.*` | DOM | Nhận xét |
|---|---:|---:|---:|---|
| `baking` (`3292-4153`) | **861** | 32 | **1** | **Gần như DOM-free.** Là nơi "sai im lặng" nhất (chú thích lệch/mất trong file đã lưu) và đã ship ⇒ đủ điều kiện luật "code đã ship thì refactor rẻ, có bản gốc để so byte". |
| `PNG rasterisation` | 226 | 2 | 12 | Đi kèm baking. |
| `default colour` + `default pen width` | 170 | 9 | 0 | Đã "single-owner" (comment ở `Editor` nói rõ). Nhỏ, dễ. |
| `pointer interaction` | 706 | **104** | 8 | **Không đụng** — dính `ed` nặng nhất. |
| `overlay rendering` | 607 | 11 | **150** | Không tách: thuần DOM, tách không làm nó test được (kết luận cũ vẫn đúng). |

⚠️ **Luật rút ra từ tài liệu cũ, giữ nguyên:** (a) chỉ tách code **đã ship và đã test tay**; (b) **không gộp "đổi chỗ ở" với "đổi hành vi"** trong cùng một đợt ⇒ việc tách `baking` **không được** làm cùng lúc với bất kỳ sửa perf nào ở Đợt A–C; (c) chứng minh **byte-identical** bằng script so từng dòng trước khi move.

### 6.4 Đề xuất cho phần cấu trúc (đưa vào Đợt 0 — tất cả **không đổi hành vi**)

Ý tưởng chung: thay vì đổi cấu trúc, **dựng hàng rào tự động** quanh A1/A2/A5 để cấu trúc hiện tại an toàn khi sửa. Chi phí thấp, không thêm dependency.

| ID | Việc | Đã thử sơ bộ? | Rủi ro |
|---|---|---|---|
| G1 | **Test "hợp đồng scope toàn cục"**: đọc thứ tự `<script>` từ từng HTML (`index/shell/view`), thu thập tên cấp-0 mỗi file, **fail nếu trùng tên giữa hai file** (BI-14) hoặc file renderer không được HTML nào nạp. | ✔︎ Chạy thử trên cây hiện tại: **0 trùng**, 21 script nạp ở `index.html`; `shell.js`/`view.js` thuộc HTML khác ⇒ **xanh ngay ngày đầu**. | Thấp. Thêm 1 file test. |
| G2 | **Test hợp đồng IPC**: mọi `ipcRenderer.invoke/send` ở 3 preload phải có `ipcMain` tương ứng (quét **toàn bộ `src/*.js`**) và ngược lại. | ✔︎ Chạy thử: **0 lệch** (7 "thiếu" ban đầu là false positive vì nằm ở `license.js/signing.js/updater.js`). | Thấp. |
| G3 | **Ratchet cho `state.bytes =`**: test đếm các chỗ ghi thô, khoá ở danh sách 17 chỗ hiện có (file + hàm). Thêm chỗ mới ⇒ test đỏ kèm thông báo "dùng đường chuẩn hoặc thêm vào whitelist có lý do". **Chưa** đổi 17 chỗ cũ. | Chưa — cần chốt định dạng whitelist. | Thấp; chỉ phát hiện, không đổi hành vi. |
| G4 | **`commitBytes(bytes, {undo, pages})`** ở `app.js` làm **đường chuẩn cho code MỚI**; 17 chỗ cũ chuyển **dần**, mỗi chỗ một commit + probe. | — | **Trung bình** (động vào đường dữ liệu người dùng). **Không làm trong Đợt 0**, chỉ lên kế hoạch. |
| G5 | **Bản đồ định hướng** trong `CLAUDE.md` (H2): mỗi file lớn có bảng "mục → hàm → test nào canh" lấy từ chính các banner `// ---- … ----` đã có, **không dùng số dòng** (tránh A7). | — | Không. Chỉ tài liệu. |
| G6 | **Vệ sinh repo (A8)**: `git rm --cached` + `.gitignore` cho `.claude/settings.local.json` và `web/tsconfig.tsbuildinfo`. **Không** xoá `.agent/` và **không** di chuyển file Python ở gốc (động vào đường dẫn PyInstaller / `/deploy`) — chỉ ghi vào `CLAUDE.md`. | — | Thấp. Cần bạn đồng ý riêng vì đụng `settings.local.json` của bạn (nội dung trên đĩa giữ nguyên). |

**Tách `baking` (§6.3) = Đợt E riêng**, sau khi Đợt A–C đã ship và test tay xanh — để không vi phạm luật (b). Trước khi quyết, tôi sẽ viết **đề xuất tách có số đo** (script so byte, danh sách tên bị tham chiếu từ ngoài khối, thứ tự nạp trong `index.html`).

**Trước khi động `api.py` (A6):** làm Đợt B (S1/S2) **cùng phiên** với việc kiểm kê trạng thái dùng chung (`ocr_engine`, `gemini_agent`, `_FIND_CACHE`) và bọc lock / chạy một luồng; **không tách `api.py` thành router** ở đợt này (cơ học nhưng làm vỡ `from api import …` ở **11 file test** trừ khi `api.py` re-export).

### 6.5 Cái tôi KHÔNG đo (để khỏi tưởng đã kiểm)
- **CSS** (`app.css` 1 551 dòng): không xem độ trùng / specificity.
- **i18n**: không đếm chuỗi tiếng Việt viết cứng chưa qua `tr()`.
- **`web/`, `site/`, `supabase/`**: không thuộc ứng dụng desktop, chỉ xem về vệ sinh repo.
- **Độ phủ test theo dòng**: không có công cụ coverage; 24% / 54% là *tỉ lệ dòng nằm trong file có `module.exports`*, **không phải** coverage thật.
- ESM có còn bị chặn không (rào cản 1): chưa thử lại.

---

## 7. Trạng thái thi công (cập nhật cuối ngày 2026-10-01)

Quyết định của chủ dự án: Đợt 0 và Đợt A theo thứ tự đã đề xuất, mỗi việc một commit; chấp nhận đánh đổi `garbage=2` (+~1,5% dung lượng); G1/G2/G3/G5 làm cùng Đợt 0; **G6 giữ nguyên** (không bỏ theo dõi `.claude/settings.local.json`); đề xuất tách `baking` viết trước rồi mới quyết.

**Đợt 0 — XONG** (lưới trước & sau: JS 24/24 → **27/27**, Python 16/16; Python từ ~155 s → **~55 s**):

| Việc | Commit | Kết quả |
|---|---|---|
| Memo này | `964654e` | |
| H1 `npm test` + cổng `/deploy` | `f6e7471` | 24 bộ JS vào cổng phát hành; file đỏ giả → exit 1 |
| H4 `_ink()` bằng numpy | `f902d9b` | 38,9 s → 0,45 s/lần, kết quả **giống hệt** (4 fixture × zoom 2 / 3,7 / 8); file test 78 s → 3,5 s |
| G1 `test:scope` | `9e22d2a` | 33 ca, **đột biến trên file thật** (đảo wire/app, thêm `const toast`, file mồ côi, destructure `PDFDocument` lần nữa) đều đỏ đúng chỗ |
| G2 `test:ipc` | `759e21a` | 14 ca; 64 ⇄ 64 kênh; đột biến (typo kênh, handler mồ côi, thêm `file:write-pdf` vào pane chỉ-đọc, send gián tiếp mới) đều đỏ |
| G3 `test:bytes` | `d7bad7a` | 14 ca; khoá 17 chỗ ghi + **kiểm thật** luật BI-3 (pushUndo trước khi ghi) cho 13 writer; đột biến đều đỏ |
| **Lỗi phát hiện thêm: cổng sidecar-tươi** | `9b7da20` | `check-sidecar-fresh.js` coi `test_*.py` là đầu vào sidecar ⇒ commit H4 làm `npm run build` đòi build lại ~30 phút vô lý. Đã loại trừ `test_*.py`, `run_tests.py`; kiểm 5 tình huống (sửa `api.py` / `src/pdf/util.py` vẫn đỏ) |
| H5 sửa 2 chỗ tài liệu cũ | `1844635` | con trỏ memory không tồn tại; "renderer không có test" |
| H2/G5 `CLAUDE.md` | `2acb1c8` | 75 dòng, không dùng số dòng |

Lưu ý nhỏ: sau Đợt 0, `HANDOFF.md` chưa được thêm mục (mục này thuộc về `/deploy` khi có bản phát hành).

**Đợt A — XONG** (cùng ngày; lưới cuối: JS **31/31**, Python **20/20**; mỗi mục một commit, mỗi test canh giữ đều qua đột biến trên file thật):

| Mục | Commit | Số đo (trước → sau) | Ghi chú |
|---|---|---|---|
| S3 `garbage=3→2` | `95dda4c` | đánh số trang 600 trang 1,42 → **0,39 s**; sửa 1 span 1,02 → **0,15 s** | 8 chỗ gom về một hằng `WRITE_GARBAGE`; `/compress` giữ `garbage=4`. **Giá:** file lớn hơn +3,1–3,3% (tài liệu giả lập nhiều trang giống hệt), +0,6% (PDF thật `matplotlib.pdf`) — số memo (1,5%) nằm giữa; trần test 10%. Mức ≥1 là bắt buộc (BI-23). |
| S2 timeout Gemini | `07cfdf9` | server giả im lặng: treo vô hạn → `ReadTimeout` sau **1,51 s** (timeout thử 1,5 s); mặc định **120 s** | Đơn vị SDK là **mili giây**. Chỉ là timeout — **chưa** đưa lời gọi ra khỏi event loop (Đợt B). |
| S7 cache `fitz.Font` | `35e5f0d` | lô 200 chỗ sửa: dựng font 400 → **1** lần; 1,02 → **0,74 s** (có gạch chân) | 13–22% thời gian là dựng font. Đầu ra **giống hệt từng pixel** có/không cache. |
| S8 ZIP STORED cho ảnh | `1216877` | JPEG 12 MP: 0,269 → **0,007 s**, zip +0,2% | `split` giữ deflate (PDF con). |
| M4 bỏ `Buffer.from` thừa | `4068567` | 256 MB: bỏ 79 ms + 1 vùng nhớ 256 MB | `asWritable()`: view đi thẳng, kiểu khác vẫn qua `Buffer.from` — vì ~20 chỗ gọi chưa chắc đều gửi typed array. Probe thật: Uint8Array **và** ArrayBuffer qua IPC đều ghi đúng byte (sha256). |
| M7 kill sidecar khi quá hạn | `619f15c` | child chết thật sau reject (test với tiến trình thật); `onExit` không bị gọi | Thêm guard: không `taskkill` child đã chết (PID có thể đã được cấp cho tiến trình khác). |
| R7 BMH cho vault | `8ca7860` | 128 MB: ~300 → **~45 ms**; trong Chromium thật 64 MB: 75 → 20 ms | Đã đo 3 cách; `indexOf` trên byte hiếm bị loại vì 2,4 s ở ca toàn-'V'. +10 ca đối chiếu `Buffer#includes` (1590 đầu vào). |
| R6 index tìm kiếm | `9c89b43` | 3 lượt tìm đồng thời: `getTextContent` **120 → 40** lần (probe thật) | **Lỗi thứ hai tìm thấy khi làm (không có trong memo):** nhãn index lấy từ `state.pdf` *sau* vòng lặp ⇒ đổi tài liệu giữa chừng thì chữ tài liệu cũ nằm dưới nhãn tài liệu mới. Thêm `seq` cho `runSearch`/`closeFind`. |
| R3 thumbnail qua hàng đợi | `04ce6b6` | probe thật, 40 trang / 15 thumbnail đã vẽ, `rerenderChanged(null)`: 763 → **199 ms**; thumbnail vẽ 40 → **15** (chỉ cái đã từng vẽ; cả 15 có nội dung, không cái nào vẽ hai lần) | 1 thumbnail vẽ *trong* lúc gọi là một lát idle của hàng đợi chen vào, không phải vẽ inline. |

**Probe Electron thật (CDP, `--user-data-dir`, có baseline = 4 file về `384b45b`)** — làm vì unit test không thấy được kiểu IPC thật, thời gian thật, và việc app có boot được: 40/40 trang vẽ, sidecar Python thật lên `ready`, thoát bằng `Browser.close` không để lại sidecar dev nào. Kết quả: R3/R6/R7/M4 như bảng trên.
- ⚠️ **Một điều chưa giải thích:** lần chạy *lạnh đầu tiên* của bản mới có 2 lỗi console (`sandboxed_renderer.bundle.js script failed to run` / `Cannot destructure property 'preloadScripts' of 'binding.startupData'` — lỗi nội bộ Electron lúc dựng renderer sandbox, không liên quan code của repo). **Ba lần chạy lại: 0 lỗi; baseline 3 lần: 0 lỗi.** Không có thay đổi nào của Đợt A đụng tới preload hay khởi động, nhưng 1/4 so với 0/3 là mẫu quá nhỏ để khẳng định. Nếu thấy lại: ghi lại có app đã cài đang chạy song song hay không (lần đó có).
- Probe là file dùng một lần, **không commit** (cần `ws`, không thêm vào `desktop/package.json`). Đây chính là H3 trong §4 — vẫn chưa có harness đo trong repo.

**Khi phát hành:** Đợt A **đổi `*.py`** ⇒ `/deploy` sẽ yêu cầu build lại sidecar (cổng "tươi" đã không còn đòi vì file test). Chưa bump version, chưa viết mục HANDOFF — việc của `/deploy`.

**Còn lại:** Đợt B–D (§5), trong đó S1/S2 (đưa OCR/Gemini ra khỏi event loop) **phải kiểm kê trạng thái dùng chung** (`ocr_engine`, `gemini_agent`, `_FIND_CACHE`) cùng phiên; Đợt E (tách `baking`, chưa quyết GO).
