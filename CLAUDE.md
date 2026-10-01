# Nabu PDF — hướng dẫn cho agent làm việc trong repo này

Bộ PDF desktop (Windows): **Electron** (`desktop/`) + **sidecar Python FastAPI** (`api.py`, `src/`) đóng gói bằng PyInstaller.
Ngôn ngữ giao tiếp & tài liệu: **tiếng Việt**. Mã nguồn có nhiều comment "vì sao" — đọc chúng trước khi sửa, chúng thường ghi lại một lỗi đã từng xảy ra.

> File này cố ý ngắn. Tri thức dài nằm ở `docs/REGRESSION-GUARD.md` (282 KB, **đừng đọc cả** — `Grep "BI-<số>"`) và `HANDOFF.md` (267 KB, lịch sử theo bản phát hành — **đừng đọc cả**).

## Bản đồ repo

| Thư mục / file | Là gì |
|---|---|
| `desktop/src/` | main process: `main.js` (cửa sổ, IPC, in, clipboard), `tabs.js` (logic tab thuần, có test), `session/prefs/signatures/license/updater/sidecar.js`, 3 preload |
| `desktop/renderer/` | UI. **Classic `<script>`, không module, không bundler** — xem "Kiến trúc" |
| `desktop/test/` | bộ test JS (`*.test.js`, node thuần, không framework) |
| `api.py`, `src/` | sidecar: route FastAPI (`api.py`), nghiệp vụ PDF (`src/pdf/`), OCR (`src/ocr/`), so sánh bản vẽ (`src/compare/`) |
| `test_*.py`, `run_tests.py` (gốc repo) | bộ test Python |
| `docs/` | `REGRESSION-GUARD.md` (sổ bất biến + ma trận test), `PERF-MEMORY.md`, các `RESEARCH-*`/`SPEC-*`/`REVIEW-*` |
| `web/`, `site/`, `supabase/` | **không thuộc app desktop** (trang web / landing / backend giấy phép) |
| `.agent/` | skill bên thứ ba, không liên quan app |

## Chạy test (làm TRƯỚC và SAU mỗi thay đổi)

```bash
.venv\Scripts\python run_tests.py          # toàn bộ test Python (mỗi file một tiến trình)
cd desktop && npm test                       # toàn bộ test JS (~30 s); là cổng của /deploy
npm test -- tabs wire                        # chỉ vài bộ (khớp theo tên file)
npm run test:geom                            # một bộ cụ thể (xem "scripts" trong desktop/package.json)
```

Xanh = `N/N test files passed`. `/deploy` chạy cả hai; **bất kỳ đỏ nào → dừng**.
Bộ test JS **không** chạy được `app.js`/`editor.js` (DOM). Chúng hoặc `require()` file thuần, hoặc **cắt hàm ra khỏi file đang ship rồi `eval`**, hoặc **ghim regex lên mã nguồn**. Ghim regex đỏ sau khi bạn đổi tên/di chuyển hàm là **tín hiệu để hiểu**, không phải để sửa cho xanh.

Ba bộ canh *cấu trúc* (không đổi hành vi, đừng làm chúng im đi):
- `test:scope` — không file nào khai trùng tên toàn cục; thứ tự `<script>` đúng luật (BI-14). Thêm script có phụ thuộc lúc nạp ⇒ thêm luật vào test.
- `test:ipc` — kênh `preload ⇄ ipcMain` khớp nhau; pane chỉ-đọc không mọc kênh ghi (BI-55).
- `test:bytes` — mọi chỗ ghi `state.bytes =` phải `pushUndo()` **trước** (BI-3). Chỗ ghi mới ⇒ test đỏ kèm luật phải theo.

## Kiến trúc cần nhớ

1. **Renderer = một scope toàn cục chung.** `state`, `$`, `toast`, `sidecarFetch`, `renderAll`… là biến trần dùng chéo giữa các file. Đổi tên một hàm của `app.js` có thể làm file khác chết **ở runtime** mà `node --check` không thấy. Trước khi đổi tên/di chuyển: `Grep` tên đó trong **toàn bộ** `desktop/renderer/`.
2. **Tài liệu chính là `state.bytes`** (pdf-lib sửa, pdf.js vẽ). Mọi thao tác sửa file: `pushUndo()` → đổi bytes → render. Quên `pushUndo` = mất Ctrl+Z hoặc đóng cửa sổ không hỏi lưu (BI-3).
3. **`editor.js`** là một IIFE khép kín quanh object `ed` (~460 chỗ đọc/ghi); chỉ lộ ra `window.Editor` (14 thành viên). Cấu trúc bên trong theo các banner `// ---- tên ----` (model, geometry, overlay rendering, selection, clipboard, pointer, text editor, mode wiring, listeners, Format panel). **Nửa "baking" (PNG rasterisation, round-trip chú thích sửa-lại-được, `drawOneAnnot`, `bakeInPlace`/`bakeWithRedaction`, `bakePending`) nằm ở `renderer/editor-bake.js`** — đã chuyển nguyên văn, nhận 10 tên từ `editor.js` qua `window.EditorBake.create({...})` và trả lại `bakePending`, `importManaged`; giao diện được ghim bởi `test/bake-split.test.js` và `scripts/prove-bake-move.js`. Dùng `Grep "// ----"` làm mục lục; **không** dựa vào số dòng.
4. **Thêm một loại chú thích (kind)** chạm ~6 nơi: tạo (pointer), `renderAnnot`, `drawOneAnnot` (bake), `addManagedAnnot`/`deserializeManaged` (cả hai trong `editor-bake.js`), `managed-codec.js`, `annot-geom.js`. Lệch giữa render và bake = chú thích đúng trên màn hình nhưng sai trong file đã lưu (BI-40, BI-45). Có lưới: `test:rotate` — thêm kind vào `KINDS` của nó.
5. **IPC** đi qua preload (`contextIsolation`); renderer không có `require`. Kênh dạng `namespace:action`.
6. **Sidecar** nói chuyện qua HTTP có token; PDF lớn đi đường nhị phân (BI-49), **không bao giờ** dựng payload PDF thành một chuỗi JS (BI-24). Sửa `*.py` ⇒ phải **build lại sidecar** trước khi đóng gói (`desktop/scripts/check-sidecar-fresh.js` sẽ chặn; `test_*.py`/`run_tests.py` không tính).
7. **Hiệu năng:** đo trước khi kết luận. Nhiều "tối ưu hiển nhiên" đã được đo và **bác bỏ** — xem `docs/RESEARCH-2026-09-15-deps-perf-audit.md` §9 và `docs/PERF-MEMORY.md` trước khi đề xuất lại. Trạng thái review mới nhất: `docs/REVIEW-2026-10-01-perf-harness.md`.

## Luật không được phá (tóm tắt — chi tiết ở REGRESSION-GUARD §3)

- **BI-3** `pushUndo()` trước khi `state.bytes` đổi. **BI-14** không gọi chéo module bằng "tên trần" mới, không khai trùng binding cấp 0 (đã hai lần làm app trắng).
- **BI-4** không đọc **pixel** canvas của viewer. **BI-36 / BI-78** zoom: đổi hình học ngay, raster sau, không dựng lại `.page-wrap`; bitmap trang có **hạn mức pixel** (quá ~268 MP ⇒ trang trắng, không lỗi).
- **BI-9 / BI-10** nút tính năng trả phí phải vào `GATED_BTNS`; phần tử có chữ động phải vào `SKIP_IDS` của i18n. **BI-26** cổng bản quyền ở tầng **hàm** (menu chuột phải không có id nút).
- **BI-55** một renderer không được biết định danh renderer khác. **BI-35** mọi đường mở file hỏi cùng một chỗ ở main.
- **BI-59** trang 0° phải ra **byte y hệt** — `/Matrix` chỉ ghi khi trang thật sự xoay. **BI-45 / BI-65 / BI-66** bù xoay là việc của primitive; mỗi trang dùng viewport của chính nó.
- **BI-74 / BI-91** an toàn dữ liệu: ẩn trang phải xoá lịch sử hoàn tác và ghi đè bản phục hồi; kho chữ ký mã hoá hoặc không lưu.
- **BI-63** `File.path` đã chết ở Electron 33 — dùng `webUtils.getPathForFile`.

## "Đụng gì → test gì"

Ma trận đầy đủ ở **`docs/REGRESSION-GUARD.md` §5** (tìm theo tên hàm/file bạn sửa). Phần lớn tính năng renderer **chỉ test tay/probe được** — ma trận ghi từng ca phải bấm. Đừng báo "xong" cho một thay đổi renderer chỉ vì `npm test` xanh: nói rõ phần nào đã probe, phần nào chưa.

## Cách làm việc ở repo này

- **Không gộp "tính năng/sửa hành vi" với "đổi chỗ ở/refactor" vào cùng một đợt** — lúc test tay không quy được lỗi. Chỉ tách code **đã ship và đã test tay**, chứng minh **byte-identical** (script so từng dòng) trước khi move.
- Sửa một hàm có `BI-xx` trong comment ⇒ đọc mục đó trong REGRESSION-GUARD trước.
- Mỗi việc một commit; thông điệp commit tiếng Việt, nêu số đo/kiểm chứng. Lưới test xanh trước **và** sau.
- Test mới nên **thử cho nó đỏ** (đột biến tạm trên file thật rồi `git checkout`) — một test không thể fail thì vô giá trị.

## Môi trường Windows — những cái đã vấp (ghi từ các phiên trước)

- **Build dài phải chạy nền** (`run_in_background`): sidecar + `electron-builder` đều vượt trần 10 phút; build bị kill để lại `.exe` ~325 KB trông như thành công.
- `/deploy` build lỗi ở giải nén `winCodeSign` (symlink) ⇒ bật Developer Mode hoặc seed sẵn cache.
- Heredoc trong Bash **ăn backslash** (`\b` thành ký tự 0x08 vô hình): chuỗi có `\` hoặc backtick ⇒ ghi script ra file bằng công cụ Write rồi chạy.
- Probe trình duyệt: preview pane của IDE là **snapshot tĩnh, script không chạy** — probe phải chạy qua `http://`, hoặc dùng chính Electron của dự án (`./node_modules/.bin/electron`, `BrowserWindow({show:false})`, CDP + `ws`; cần `--user-data-dir`).
- Sidecar: `sklearn`/`matplotlib` **bắt buộc giữ** trong bundle; model VietOCR đã nằm sẵn trong bộ cài (chạy offline).
