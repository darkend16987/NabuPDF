# Setup trên máy mới (dev)

Hướng dẫn dựng lại môi trường dev đã được kiểm chứng (Windows). Xem kiến trúc ở
[DESIGN.md](DESIGN.md), tiến độ ở [ROADMAP.md](ROADMAP.md).

> ⚠️ Các phiên bản dưới đây KHÔNG tùy tiện đổi — chúng là bộ đã giải xong "dependency hell"
> (xem mục Gotcha). Đặc biệt: **Python 3.12** (không phải 3.13) và **paddle 3.x** (không phải 2.x).

## Yêu cầu máy

- **Python 3.12** (bắt buộc — 3.13 không cài được vietocr; 3.11 cũng chạy được nếu cần)
- **Node.js ≥ 20** + **pnpm ≥ 10**
- Git
- (Tùy chọn) Docker — không cần cho dev native

## 1. Python sidecar (OCR engine)

```powershell
# từ thư mục gốc repo
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-build.txt
```

Tải ~3GB (torch + paddlepaddle + paddlex).

### 1b. Model OCR (bắt buộc trước khi đóng gói)

```powershell
.\.venv\Scripts\python.exe tools/fetch_vietocr_model.py
```

Tải `vgg_transformer.pth` (151,8 MB, có kiểm checksum) về `models/vietocr/`. Hai file
`.yml` cạnh nó đã nằm trong git.

Vì sao phải có: `vietocr` 0.3.13 lấy model **lúc chạy** — GET hai file YAML từ vocr.vn
mỗi lần dựng `Predictor` (không cache gì cả) rồi tải 151,8 MB vào `%TEMP%`, mà Windows
dọn `%TEMP%` định kỳ. Đo được **286 giây** để sẵn sàng OCR trên máy đã từng chạy OCR
thành công. `sidecar.spec` nay đóng gói thư mục này vào app và `src/ocr/engine.py` ưu
tiên dùng nó → OCR offline thật (DESIGN.md D2).

Bỏ qua bước này thì app **vẫn chạy** (engine tự rơi về đường tải mạng như cũ), nhưng
bản đóng gói sẽ mang đúng vấn đề vừa sửa. `pnpm run build:sidecar` đã tự gọi script này.

Tạo file `.env` ở gốc repo (xem `.env.example`), tối thiểu:

```
GEMINI_API_KEY=...        # cho bóc tách field (OCR thuần không cần)
OCR_ENGINE=hybrid
```

### Kiểm tra sidecar chạy

```powershell
.\.venv\Scripts\python.exe sidecar.py --port 8123
# mở tab khác: GET http://127.0.0.1:8123/health  -> {"status":"ok","engine":"hybrid"}
```

## 2. Electron desktop shell

```powershell
cd desktop
pnpm install          # pdf-lib/pdfjs-dist + postinstall vendor libs vào renderer/vendor/
node node_modules/electron/install.js   # tải binary Electron (xem ghi chú bên dưới)
pnpm start            # mở app: UI PDF hiện ngay; sidecar OCR boot ở nền (badge starting->ready)
```

> **Từ Electron 42, `pnpm install` KHÔNG còn tải binary Electron nữa.** Upstream bỏ
> bước `postinstall` vì đó là đường tấn công chuỗi cung ứng phổ biến; binary giờ tải
> khi lần đầu chạy `electron`. Nghĩa là sau `pnpm install` thư mục
> `node_modules/electron/dist/` **chưa tồn tại**. `pnpm start` vẫn chạy được (nó tự tải
> lần đầu, mất một lúc và trông như treo); chạy sẵn `install.js` ở trên cho rõ ràng.
> Khâu `pnpm run build` không bị ảnh hưởng — electron-builder tải bản riêng vào cache
> của nó.

Từ P1, **UI PDF (xem/ghép/tách/chèn/xoay/xóa/sắp xếp/lưu) chạy không cần Python** — sidecar OCR
là lazy. Máy chỉ có Python 3.13 (không có `.venv` 3.12): PDF vẫn chạy đủ, badge OCR sẽ báo `lỗi`.
Muốn dùng OCR thì dựng `.venv` 3.12 ở mục 1.

Nếu thiếu file trong `renderer/vendor/` (pdf-lib.min.js, pdf.min.js, pdf.worker.min.js), chạy lại
`pnpm run vendor`.

**Không chạy được bản dev khi app đã cài đang mở.** `app.getName()` lấy từ `name` trong
`package.json`, mà electron-builder ship nguyên field đó — nên bản dev và bản cài dùng
chung `%APPDATA%
abu-pdf-desktop`, tức chung luôn khoá single-instance: bản dev sẽ
đưa argv cho bản đang chạy rồi **thoát với mã 0**, trông y như khởi động sạch. Đóng app
đã cài, hoặc chạy dev trong buồng riêng:
`pnpm start -- --user-data-dir=%TEMP%
abu-dev`.

## 3. Đóng gói portable .exe (Phase 0 — T0.9/T0.10)

```powershell
cd desktop
pnpm run build:sidecar   # PyInstaller -> ../dist/sidecar/sidecar.exe (onedir)
#   iterate: chạy ../dist/sidecar/sidecar.exe --port 8000; nếu ModuleNotFoundError
#   thì thêm tên module vào extra_hiddenimports trong ../sidecar.spec rồi build lại
pnpm run build           # electron-builder -> desktop/dist-app/*-portable.exe
# test bản portable trên máy Windows sạch (không cài Python)
```

## Gotcha đã giải (đừng "sửa lại cho mới")

| Vấn đề | Nguyên nhân | Cách giải (đã áp dụng) |
|--------|------------|----------------------|
| Python 3.13 cài fail | vietocr ghim dep cũ thiếu wheel cp313 | Dùng **Python 3.12** |
| pnpm bỏ qua build Electron | pnpm 11 chặn script | `desktop/pnpm-workspace.yaml` (`allowBuilds`) |
| `import paddle 2.x` lỗi numpy ABI | paddle 2.x cần numpy 1.x ⟂ vietocr cần numpy 2.x | Dùng **paddle/paddleocr 3.x** (numpy 2.x) |
| torch `WinError 127 shm.dll` | paddle nạp DLL trước torch | `import torch` đầu `src/ocr/engine.py` |
| paddleocr API vỡ | 2.x→3.x đổi `predict()`, `dt_polys`, bỏ `show_log` | `engine.py` đã migrate |
| paddle 3.3 `ConvertPirAttribute...` | bug PIR+oneDNN | `enable_mkldnn=False` |

Tất cả fix code nằm trong `src/ocr/engine.py` và pin trong `requirements.txt`.
