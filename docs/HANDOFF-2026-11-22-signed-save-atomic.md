# Bàn giao 2026-11-22 — "đừng phá chữ ký số" + ghi nguyên tử (BI-127 … BI-137)

Tài liệu này để một phiên mới nhận việc mà **không cần đọc lại cuộc hội thoại**. Tri thức dài vẫn ở `docs/REGRESSION-GUARD.md`
(tìm theo `Grep "BI-13"`; đừng đọc cả file) — đây chỉ là bản đồ + trạng thái + việc còn lại + các bẫy đã vấp.

> **CẬP NHẬT 2026-11-24:** từ lúc bàn giao đã làm thêm BI-138…BI-144 (hạn giờ + nút Hủy cho `/split`, `/add-page-numbers`; bộ khung e2e; sửa BI-142 và BI-143). **Việc còn mở và câu mở đầu mới nằm ở §4a** — đọc §4a trước, §4 bên dưới giữ nguyên làm lịch sử.

## 0. Câu mở đầu để dán vào phiên mới

> Đọc `docs/HANDOFF-2026-11-22-signed-save-atomic.md` rồi `git fetch` và kiểm `git status -sb`. Nhánh `claude/vietnamese-ocr-ai-iSvwV`,
> HEAD khi bàn giao là `d668292` (đã push, đồng bộ origin). Việc tiếp theo tôi muốn: <chọn từ mục 4>. Làm theo cách đã dùng:
> chốt từng bước nhỏ, test trước và sau, thử cho test đỏ bằng đột biến, ghi sổ BI mới, mỗi việc một commit, hỏi tôi trước khi push.

## 1. Trạng thái khi bàn giao

| | |
|---|---|
| Nhánh | `claude/vietnamese-ocr-ai-iSvwV` |
| HEAD | `d668292` — **đã push**, local = origin, cây sạch (trừ file này nếu chưa commit) |
| `npm test` | **68/68** file (cuối cùng chạy sau BI-137) |
| Python `run_tests.py` | không sửa `.py` của sidecar nào sau `7b38f154` ⇒ chưa chạy lại; chạy trước khi phát hành |
| Sidecar đóng gói | build từ `7b38f154`, `check-sidecar-fresh` **xanh** (mọi thay đổi sau đó chỉ là JS/test/docs) |
| Phát hành | **chưa** — `/deploy` chưa chạy |

## 2. Đã làm (mỗi dòng có sổ BI riêng, có "Vỡ khi" và lưới)

| BI | Việc | File chính | Lưới |
|---|---|---|---|
| 127 | Hỏi trước khi ghi đè file ĐÃ KÝ (cổng chung `guardWrite`) | `src/signed-scan.js` | `test:signedscan` |
| 128 | Lõi **ghi nối** (incremental) giữ nguyên byte gốc | `src/pdf/incremental.py` | `tools/corpus_sweep_incremental.py` (kỳ vọng 958 ok / 0 lỗi thật) |
| 129 | Route `POST /save-incremental-bin` + tiến trình con + hạn giờ 120 s | `api.py`, `sidecar.py --incremental-worker` | `run_tests.py` |
| 130 | **Lưu nối thêm** (nút trong hộp Lưu; cờ `contentRemoved` chặn sau khi bôi đen/ẩn trang) | `src/signed-save.js`, `main.js`, `preload.js`, `app.js` | `test:signedsave` (136 ca) |
| 131 | Trọng tài OpenSSL độc lập + thử đầu-cuối + probe app thật + đo 152 MB | `tools/verify_pdf_signatures.py`, `tools/signed_e2e.py`, `scripts/probe-signed-save.js` | — |
| 132 | Hỏi trước khi **KÝ** lên tài liệu đã có chữ ký | `src/signing.js` (`routeSigning`) | `test:signingwarn` (151 ca) |
| 133 | **Ký nối thêm** — chữ ký thứ N giữ N-1 chữ ký trước (đã kiểm Foxit: 2 và 5 người ký) | `src/sign-append.js`, `signing-worker.js` | `test:signappend` (81+23), `tools/sign_append_e2e.js` |
| 134 | Chữ **tiếng Việt có dấu** trong Reason/Name/Location (`PDFString.of` cắt Unicode về 1 byte) | `src/sig-text.js` | `test:sigtext` (50 ca) |
| 135 | `file:write-new-pdf` (overwrite) đi qua cổng BI-127; nút "Bỏ qua file này" | `main.js`, `renderer/batch-variants.js` | `test:signednew` (42 ca) |
| 136 | **Ghi nguyên tử** (tạm + fsync + đổi tên) cho `dialog:save-pdf`, `file:write-pdf`, `file:write-new-pdf` (đè) | `src/atomic-write.js` | `test:atomic` (47 ca, có ca GIẾT TIẾN TRÌNH THẬT) |
| 137 | **Autosave/khôi phục** ghi nguyên tử; `scrub:true` khi ẩn trang (BI-74); chịu thiếu manifest; sửa `path`→`srcPath` | `main.js` (`recovery:*`), `app.js` | `test:recoveryatomic` (45 ca) |

Chuẩn kiểm chứng đã dùng cho mọi mục: test chạy mã thật (cắt nguyên văn khối ở `main.js` rồi `eval`, hoặc server HTTP thật), **đột biến tạm thời trên mã thật
phải làm test đỏ** (21/21, 15/15, 11/11, 41/41… — ghi trong từng BI), `npm test` toàn bộ, và probe Electron thật (`node scripts/probe-signed-save.js`, kịch bản S1–S10).

## 3. Bằng chứng từ trình đọc thật (Foxit PDF Reader 2026.2.1.39815; **Acrobat CHƯA mở**)

- **Ký nối thêm** (file 8: 2 chữ ký, 9: 5 chữ ký, 10: 5 chữ ký tiếng Việt): mọi chữ ký "chưa bị thay đổi kể từ khi ký". Reason/Location tiếng Việt hiện đúng dấu.
- **Lưu nối thêm khi SỬA TRANG** (xoay, thêm chữ, xoá trang): Foxit báo chữ ký **KHÔNG HỢP LỆ** ("N Page(s) Modified"). OpenSSL vẫn nói hợp lệ ⇒ **trọng tài toán học ≠ trình đọc thật**.
  Ghi nối chỉ giữ *bản đã ký gốc xem lại được*. Nhãn/hộp thoại đã sửa cho nói thật chuyện này.
- **Chỉ điền form** (file 4): "unknown", **không** invalid ⇒ điền form là thay đổi được phép.
- **Đường lưu cũ** (file 7): "Error during signature verification" — chữ ký bị phá hẳn.
- File 3 (chỉ thêm chữ) chưa Validate ⇒ chưa kết luận (đoán: giống xoay). Mẫu ở `dist/signed-samples/` (git-ignored) kèm `README.txt`.

## 4. Còn mở — theo thứ tự đề xuất

1. **Hạn giờ (±Hủy) cho `/split` và `/add-page-numbers`** — chạy *trong* tiến trình sidecar nên `bomb_giant.pdf` treo vô hạn. Khuôn 3 lớp đã có ở `/compress` (BI-121/123/126).
   Đo chi phí ~0,3 s/lần ra tiến trình con trước; với đánh số trang "chỉ thêm trần giờ" cũng là kết luận hợp lệ. Sửa `*.py` ⇒ phải build lại sidecar.
2. **Kênh điều khiển (`--control`: loopback + token) để tự động hoá ma trận test tay** ở REGRESSION-GUARD §5. Đòn bẩy lớn nhất; probe CDP hiện là bản dùng một lần.
3. **Cảnh báo lúc BẮT ĐẦU sửa file đã ký** (hiện chỉ hỏi lúc Lưu/Ký; mỗi Ctrl+S lại hiện hộp thoại).
4. **`dialog:save-file`** (xuất xlsx/csv/json) vẫn `writeFile` thô — cùng lỗi cắt cụt, mức độ thấp hơn.
5. Lưới quét corpus chưa phủ `/edit-text`, `/translate`; command registry + ⌘K (refactor, làm khi chạm menu); worker nén thường trú (tuỳ chọn).
6. **Chưa kiểm:** Acrobat Reader; DocMDP P=2/3 trong trình đọc; token/chứng thư/TSA/LTV thật; hộp thoại native (probe thay bằng bản giả); bản cài `electron-builder`;
   ghi nguyên tử trên ổ mạng/SMB/OneDrive đang đồng bộ/có diệt virus; luồng ẩn trang bằng UI thật (S10 chỉ gọi thẳng `scrubRecoverySnapshot`); file ≥ 400 MB; sập thật khi autosave tài liệu lớn.
7. **Hạn chế không sửa được:** sửa trang trên file đã ký ⇒ chữ ký báo không hợp lệ ở Foxit (bản chất); file đã ký TRƯỚC BI-134 mang chữ hỏng; bản phục hồi tạo trước BI-137 có thể là PDF cụt.
8. **Phát hành:** `/deploy` (chạy `run_tests.py` + `npm test`, build, release). Sidecar đã mới nên không cần build lại trừ khi sửa `.py`.

Nguồn việc 1–2 và mục 5: `docs/RESEARCH-2026-11-21-pdfcraft-learnings.md` (xếp theo thứ tự nên làm; mục "quét corpus + qpdf" đã xong từ trước).

## 4a. Cập nhật 2026-11-24 — đã làm gì từ bản bàn giao, và việc để lại cho một phiên khác

**HEAD `ddae44e`, đã push, đồng bộ origin** (nhánh `claude/vietnamese-ocr-ai-iSvwV`). `npm test` 72/72; `npm run e2e` 14/14 (cần phiên có giao diện, ~2 phút).

### Đã làm (so với §4 ở trên)
- **§4 mục 1 — XONG:** hạn giờ + nút Hủy cho `/split` (BI-139) và `/add-page-numbers` (BI-140), cùng khuôn BI-121/126; `/split` bị đổ oan về `bomb_giant.pdf` (đo lại: 0,0 s; ca treo thật là `bug1978317`).
- **§4 mục 2 — LÀM HƯỚNG KHÁC, không phải `--control`:** móc hộp thoại `src/test-hooks.js` (nạp khi có `NABU_TEST_HOOKS`, một dòng ở `main.js`) + bộ e2e CDP `desktop/e2e/` (BI-141). Đã tự động hoá phần lớn ma trận §5 qua hai đợt (14 kịch bản). Chi tiết, đột biến, giới hạn: REGRESSION-GUARD **BI-141**.
- **Lỗi thật do e2e bắt được và đã sửa:** BI-142 (đóng cửa sổ để lại khe phục hồi 18/18 lần) và BI-143 (ẩn trang có khoá để bản rõ của trang gốc nằm trong file như đối tượng mồ côi).
- **Quan sát đã ghi, CHƯA xử lý:** BI-144 (5 mục: chuyển trang sang tab đang ẩn không có phản hồi; ✕ cửa sổ rồi Huỷ vẫn đóng tab sạch đứng trước; ghép/chèn file hỏng ném lỗi không bắt; luật "chừa một trang" không đếm trang đã ẩn; hoàn tác không tắt chấm ●).

### Để lại cho MỘT PHIÊN KHÁC (người dùng chốt 2026-11-24: ghi lại, làm sau)
1. **Kênh điều khiển `--control` (loopback + token) trong app — CHƯA làm.** Hướng A (móc + CDP) đã phủ phần lớn, nên đây chỉ còn đáng làm nếu cần điều khiển thứ CDP **không** chạm được: menu native (Thoát, Ctrl+Q), kéo-thả (tab/trang/file), hộp thoại in. Việc lớn, chạm `main.js`, nên làm riêng và **đo trước** xem có thật sự mở khoá được các ca đó không (khảo sát cũ: Chromium bỏ qua input tổng hợp trong đường kéo-thả — TABS-2B-DESIGN §2.2 — một kênh trong app cũng không đổi điều đó nếu kéo-thả vẫn đi qua trình duyệt).
2. **Cảnh báo lúc BẮT ĐẦU sửa file đã ký — CHƯA làm.** Hiện chỉ hỏi lúc Lưu/Ký (`askSignedOverwrite` ở `main.js`), nên mỗi Ctrl+S lại hiện hộp thoại. Chạm renderer ⇒ phải test tay; lưới tự động liên quan: `e2e/signed-save.e2e.js` (hộp thoại lúc lưu), `npm run test:signedsave`.
3. **`dialog:save-file` (xuất xlsx/csv/json) vẫn `writeFile` thô — CHƯA làm.** `src/main.js` ~dòng 1343: `fs.promises.writeFile(res.filePath, asWritable(data))`; `AtomicWrite` (`src/atomic-write.js`, BI-136) đã được `require` sẵn ở đầu file. Việc nhỏ, mức thấp. Cách làm đề xuất: thay bằng `AtomicWrite`, thêm test hợp đồng cắt-và-eval như `recovery-atomic` (chú ý: handler đổi phụ thuộc ⇒ thêm tham số cho `new Function(...)` ở các test cắt-và-eval), và một ca e2e xuất file bằng móc `showSaveDialog`.

### Việc mở khác (không nằm trong 3 mục trên)
- **`check-sidecar-fresh` đang ĐỎ** (`src/pdf/split.py`, `pagenum.py`… mới): phải `cd desktop && npm run build:sidecar` (chạy nền, vượt 10 phút) trước `/deploy`, rồi thử bản đóng gói (worker `--split-worker`/`--pagenum-worker` chưa được thử trong bản đóng gói).
- **Chủ dự án quyết:** có đưa `src/test-hooks.js` vào gói phát hành không (`!src/test-hooks.js`; hiện nó chỉ chạy khi có `NABU_TEST_HOOKS`, có banner stderr); xoá các probe cũ `scripts/probe-*.js` (đã được e2e thay); xử lý từng mục BI-144.
- **Giới hạn còn lại của BI-143:** giá trị ô biểu mẫu trên trang ẩn vẫn nằm trong `/AcroForm`; PDF tagged chưa đo; file đã ẩn bằng bản app cũ vẫn mang bản rõ.
- **Không tự động hoá được (đã đo/đã lý giải):** kéo tab/trang, menu native, **in** (cần chặn máy in thật trong `test-hooks.js`), cảm giác lăn/zoom, bản vẽ CAD thật. Chưa đo: PDF rất lớn so với trần 10 phút của các worker.
- Bẫy mới của phiên này: heredoc **và cả `sed`** làm hỏng `\n`/`\r` trong script ⇒ ghi script vá bằng Write/Edit (có `assert` khớp, giữ CRLF/LF của file); `Page.eval` của driver chờ hộp thoại của app thì treo ⇒ gọi hàm không `await` rồi đợi modal hiện; tab ẩn thì pdf.js không vẽ ⇒ `activateTab` trước khi thao tác.

### Câu mở đầu để dán vào phiên mới (thay §0)

> Đọc `docs/HANDOFF-2026-11-22-signed-save-atomic.md` mục **4a**, rồi `git fetch` và kiểm `git status -sb` (HEAD khi ghi là `ddae44e`). Việc tôi muốn làm: <một trong ba mục "Để lại cho một phiên khác">. Làm theo cách đã dùng: đo trước, test trước và sau, thử cho test đỏ bằng đột biến trên mã thật, ghi sổ BI mới, mỗi việc một commit, hỏi tôi trước khi push.

## 5. Bẫy công cụ đã vấp (đỡ mất thời gian)

- **Bash tool nuốt backslash, kể cả `<<'EOF'`** (`\n`, `\(`, `\"` đều hỏng, không báo lỗi). Nội dung có `\` ⇒ dùng công cụ **Write/Edit**, hoặc script vá có `assert` khớp đúng một chỗ. Working tree là **CRLF** (autocrlf) — script vá phải chuẩn hoá `\r\n`.
- **Mọi handler `main.js` mới/đổi phụ thuộc** ⇒ các test cắt-và-eval (`signed-save`, `signed-newfile`, `recovery-atomic`) phải thêm tham số cho `new Function(...)`; pin tìm chuỗi `fs.promises.writeFile(` đổi tên là **tín hiệu để hiểu**, không phải để sửa cho xanh (CLAUDE.md).
- **Probe Electron:** đừng bọc bằng `timeout` (giết node nhưng để lại cây Electron giữ cổng 9345/9346). Kẹt thì `taskkill /PID <electron> /T /F` rồi chạy lại. Có một lần kẹt ngẫu nhiên ở S1 (không rõ nguyên nhân), chạy lại thì đạt. Chạy nền `run_in_background`.
- **`tools/signed_e2e.py --exe` phải là đường dẫn TUYỆT ĐỐI**; Python console cần `PYTHONIOENCODING=utf-8`.
- **Đột biến:** không sửa nguồn khi đang chạy; khôi phục từ buffer gốc; coi chừng **đột biến tương đương** (chỉ dời dòng khai báo) — nó lọt và báo "test yếu" oan.
- **`check-sidecar-fresh.js`** đã loại `tools/*` (pathspec `*.py` khớp mọi thư mục); JS không bao giờ cần build lại sidecar.
- **Không bao giờ `cancelId: keys.length - 1`** khi nút Huỷ không ở cuối (đã gây Esc = "Vẫn ký"); ánh xạ nút → hành động đi qua mảng khoá.
- **Chưa từng push/release không được hỏi** — luôn hỏi người dùng trước (đã làm đúng cho cả 4 lần push trong phiên).

## 6. Quyết định thiết kế đã chốt — đừng đảo mà chưa đọc BI tương ứng

- Ghi nối **chỉ** khi `contentRemoved === false` (BI-74/91: ghi nối giữ MÃI byte cũ, không được đề nghị sau bôi đen/ẩn trang).
- Mọi lỗi ở đường ghi nối ⇒ **fail-closed** (không ghi gì, hoặc hỏi lại); nút lạ/Esc ⇒ Huỷ, không bao giờ thành ghi đè/ký.
- Ghi nguyên tử: đổi tên lỗi ⇒ **không** rơi về ghi thẳng; chỉ rơi về ghi thẳng khi không tạo được file tạm vì **quyền**. Nhánh file mới giữ cờ `wx`.
- Autosave: PDF trước manifest; `scrub:true` (ẩn trang) **xoá bản cũ trước khi ghi** — thà khe trống còn hơn khe còn bản rõ.
- Sidecar không bao giờ ghi file của người dùng; main kiểm lại tiền tố byte trước khi ghi kết quả nối.

## 7. Lệnh hay dùng

```powershell
cd desktop; npm test                                   # 68/68
cd desktop; npm run test:signedscan; npm run test:signedsave; npm run test:signingwarn; npm run test:signappend; npm run test:sigtext; npm run test:signednew; npm run test:atomic; npm run test:recoveryatomic
cd desktop; node scripts/probe-signed-save.js          # Electron thật, S1–S10 (chạy nền)
.venv\Scripts\python run_tests.py                      # Python (chạy trước khi phát hành)
.venv\Scripts\python tools/signed_e2e.py               # 12 ca, thêm --exe <tuyệt đối> cho bản đóng gói
node tools/sign_append_e2e.js                          # ký nối thêm qua HTTP thật, OpenSSL chấm
cd desktop; node scripts/check-sidecar-fresh.js        # sidecar còn mới?
```
