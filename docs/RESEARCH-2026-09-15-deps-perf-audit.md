# Kiểm toán nguồn ngoài (third-party) & cơ hội tăng hiệu năng

_Soạn: 2026-09-15, trên v0.2.69 (nhánh `claude/vietnamese-ocr-ai-iSvwV`)._
_§0–§8 là **báo cáo khảo sát trước khi sửa**. §9–§10 ghi lại **những gì đã thi công và
đo lại sau đó** — kể cả ba đề xuất trong §2/§3 mà phép đo về sau **bác bỏ**. Khi hai
phần mâu thuẫn, **§9–§10 đúng**; phần cũ được giữ nguyên để thấy vì sao đã nghĩ khác._
_Máy đo: Windows 11 Pro 26200, Python 3.12.10, venv `.venv/`, CPU đa nhân, không GPU._

---

## 0. Cách đo (để bạn tái lập / bác bỏ được)

| Việc | Lệnh / cách làm |
|---|---|
| Thời gian import sidecar | `python -X importtime -c "import api"` và 2 script đo warm (chặn `torch` qua `sys.meta_path` dùng `find_spec`) |
| Kích thước bundle | `Get-ChildItem dist/sidecar -Recurse -File \| Measure-Object Length -Sum` theo từng thư mục con |
| Phiên bản mới nhất | `registry.npmjs.org/<pkg>/latest`, `pypi.org/pypi/<pkg>/json`, `releases.electronjs.org/releases.json` |
| Định dạng build pdf.js | tải tarball `pdfjs-dist@4.10.38` / `@6.3.289`, liệt kê `build/*` |
| OCR det-only vs full | dựng 1 trang hợp đồng tổng hợp 200 dpi (1653×2339) bằng PyMuPDF, chạy `RapidOCR` 3 lần mỗi cấu hình, lấy `best` |

> ⚠️ Mọi số OCR dưới đây đo trên **trang tổng hợp sạch**, không phải scan thật.
> `docs/OCR-OPTIMIZATION.md` đã cảnh báo đúng điều này — cần bộ scan hợp đồng thật
> trước khi chốt bất kỳ thay đổi engine nào.

---

## 1. Bảng kiểm kê nguồn ngoài

### 1.1 Phía Electron (`desktop/package.json`)

| Gói | Đang dùng | Mới nhất | Khoảng cách | Ghi chú |
|---|---|---|---|---|
| `electron` | **33.4.11** (Chromium 130) | **44.3.0** (Chromium 152) | 11 major | ⛔ Electron chỉ vá 3 major mới nhất (42/43/44) → bản đang dùng **không còn nhận vá bảo mật Chromium** |
| `pdfjs-dist` | **3.11.174** (2023) | **6.3.289** | 3 major | ⚠️ Từ v4 chỉ còn ESM, mất global `pdfjsLib`; `renderTextLayer` đã bị gỡ |
| `electron-builder` | 25.1.8 | 26.15.3 | 1 major | Cần bản 26 nếu nâng Electron |
| `electron-updater` | 6.8.9 | 6.8.9 | — | ✅ mới nhất |
| `pdf-lib` | 1.17.1 | 1.17.1 | — | ✅ mới nhất (upstream gần như ngừng phát hành) |
| `@signpdf/*` | 3.3.0 | — | — | không kiểm tra sâu, không nằm trên đường nóng |

### 1.2 Phía Python sidecar

| Gói | Đang cài | Mới nhất | Ghi chú |
|---|---|---|---|
| `rapidocr` | 3.9.0 | 3.9.2 | patch |
| `onnxruntime` | 1.27.0 | 1.30.0 | minor |
| `pymupdf` | 1.27.2.3 | 1.28.2 | minor |
| `google-genai` | 2.9.0 | 2.23.0 | khá xa, nhưng chỉ ảnh hưởng luồng Bóc tách |
| `fastapi` / `uvicorn` | 0.138.0 / 0.49.0 | 0.141.1 / 0.53.0 | minor |
| `torch` / `torchvision` | 2.12.1 / 0.27.1 | 2.14.0 / — | minor |
| `numpy` | 2.3.5 | 2.5.3 | minor |
| `Pillow` | **10.2.0** | 12.3.0 | 🔒 **bị `vietocr` ghim cứng `pillow ==10.2.0`** — không nâng được nếu chưa xử lý vietocr |
| `opencv-python-headless` | 4.10.0.84 | 5.0.0.93 | xem §2.2 — đang có **3 bản OpenCV cài chồng** |
| `vietocr` | 0.3.13 | 0.3.13 | ✅ mới nhất (nhưng xem §2.3) |
| `pyinstaller` | 6.21.0 | 6.22.3 | patch |

**Kết luận nhanh:** phía Python gần như đã cập nhật. **Nợ kỹ thuật thật nằm ở phía
Electron/pdf.js** (§4) và ở **cách đóng gói** (§2).

---

## 2. Phát hiện — Nhóm A: rõ ràng, rủi ro thấp/trung bình

### A1 🔴 `import torch` chạy ở mức module → mọi lần khởi động sidecar **và mọi lần nén file** đều phải nạp torch

**Bằng chứng**

`src/ocr/engine.py:19-21` import `torch` ngay khi nạp module. `api.py:33` import
`src.ocr.engine` → nên `import api` luôn kéo theo torch, kể cả khi người dùng không
bao giờ chạm tới OCR.

```
python -X importtime -c "import api"      (lạnh)
  api          tổng 12.61 s
  └─ torch     tổng  8.42 s   ← 67%

import api (ấm, dev):            1.60 s
import api (ấm, chặn torch):     0.52 s   ← tiết kiệm ~1.1 s
```

Hệ quả thứ hai, ít ai để ý: **worker nén là chính chương trình này chạy lại**
(`sidecar.py` → `from api import app`). Nên **mỗi lần nén một file > 25 MB đều trả
thêm một lần nạp torch**. Chính comment trong `api.py:882-885` đã ghi nhận chi phí
này (*"Starting the worker costs a fresh `import api` (measured 2.1 s in dev, more for
the frozen exe)"*) và phải đặt ngưỡng `_COMPRESS_WORKER_MIN_BYTES = 25 MB` để bù.

**Vì sao lại có `import torch` ở đó** — comment ghi rõ: trên Windows torch phải nạp
DLL **trước** paddle, nếu không torch lỗi `WinError 127 ... shm.dll`.

**Vì sao giờ có thể dời đi an toàn:** paddle đã **bị loại hẳn khỏi bundle**
(`sidecar.spec` `excludes=[... "paddle", "paddleocr", "paddlex", "paddlepaddle"]`) và
chỉ còn là fallback thủ công. Ràng buộc thứ tự chỉ còn ý nghĩa khi paddle thực sự
được nạp — tức bên trong `PaddleOCREngine.ocr`.

**Đề xuất:** bỏ import ở mức module; đặt `import torch  # noqa` làm **dòng đầu tiên**
của property `PaddleOCREngine.ocr`, ngay **trước** `from paddleocr import PaddleOCR`,
và chuyển nguyên khối comment giải thích xuống đó. Ràng buộc thứ tự được giữ **chặt
hơn hiện tại** (hiện tại `HybridOCREngine.recognize()` nạp paddle trước rồi mới nạp
torch qua vietocr — tức thứ tự đang **sai** nếu ai đó thật sự chạy hybrid).

**Lợi:** badge "OCR: sẵn sàng" lên sớm hơn ~1 s (ấm) / vài giây (lạnh); mỗi lần nén
file lớn nhanh hơn ~1,5 s; có thể cân nhắc hạ `_COMPRESS_WORKER_MIN_BYTES` để sidecar
giữ được khả năng đáp ứng trên nhiều job hơn.

**Rủi ro:** thấp. Chạm đúng 1 file, 1 khối import.

---

### A2 🟠 Bundle sidecar 1 155 MB, trong đó ~250–300 MB là rác

Đo trên `dist/sidecar` (PyInstaller onedir) — bản build v0.2.69:

| Thư mục | MB | Có thật sự cần? |
|---|---:|---|
| `torch` | 446,5 | Cần (VietOCR) — **nhưng** trong đó **83,5 MB là `.lib` / `.h`** (9 433 file header + import-lib C++, runtime không bao giờ đọc) |
| `cv2` | 148,2 | Cần — **nhưng** gồm `opencv_videoio_ffmpeg4130_64.dll` (27,3 MB) **+** `opencv_videoio_ffmpeg4100_64.dll` (25,2 MB) = **52,5 MB codec video**, và ~6 MB haarcascade. OCR không giải mã video |
| `scipy` (+`.libs`) | 102,6 | Đến qua `vietocr → albumentations/imgaug`. Cần rà thực tế |
| **`pyarrow`** | **78,0** | ❌ **Không dùng.** Đến từ `streamlit` (web UI, không thuộc desktop). `streamlit` đã bị exclude nhưng pyarrow vẫn lọt |
| `rapidocr` | 46,8 | Cần — nhưng chứa cả `PP-OCRv6_rec_small.onnx` (20,3 MB) + `latin_PP-OCRv5_rec` (7,5 MB) + `latin_PP-OCRv3_rec` (8,6 MB) = **~36 MB recognizer**; xem A2-b |
| `pymupdf` | 46,0 | Cần |
| `onnxruntime` | 37,7 | Cần |
| **`matplotlib`** | **21,3** | ⚠️ Bundle nguyên gói **chỉ để lấy `DejaVuSans.ttf` (~757 KB)** và `font_manager` |
| `skimage` | 21,0 | Đến qua vietocr; cần rà |
| **`pandas`** | **12,6** | ~~❌ khả năng cao không dùng~~ → **§10: GIỮ** |
| **`sklearn`** | **12,5** | ~~❌ khả năng cao không dùng lúc infer~~ → **§10: BẮT BUỘC GIỮ — loại nó là hỏng OCR** |

**Gốc rễ phụ:** venv đang có **ba** bản OpenCV chồng nhau —
`opencv-python 4.13.0.92` (do `rapidocr` yêu cầu `opencv_python`),
`opencv-python-headless 4.10.0.84` (do `requirements.txt` ghim),
`opencv-contrib-python 4.10.0.84`. Cả ba ghi vào **cùng** thư mục `cv2/` → PyInstaller
gom hết. Đây là lý do có hai DLL ffmpeg khác phiên bản nằm cạnh nhau.

**Đề xuất (theo thứ tự an toàn giảm dần):**

1. Thêm `pyarrow`, `pandas`, `sklearn`, `altair` vào `excludes` của `sidecar.spec`.
   → **§10 đã sửa lại: chỉ `pyarrow` + `altair`.** `sklearn` là dep cứng của vietocr,
   loại nó sẽ làm hỏng OCR trong bản đóng gói.
2. Thay `collect_all("matplotlib")` bằng: bundle thẳng `DejaVuSans.ttf` + chỉ những
   submodule `font_manager` thực sự dùng — **hoặc** gỡ hẳn phụ thuộc matplotlib khỏi
   `src/pdf/fonts.py` (nó dùng `font_manager.findfont` để dò font hệ thống — có thể
   thay bằng đọc `%WINDIR%\Fonts` + registry). Cái sau sạch hơn nhưng là một task riêng.
3. Lọc bỏ `**/*.lib`, `**/*.h`, `**/*.hpp` trong `torch/` ở bước `COLLECT`.
4. Lọc bỏ `opencv_videoio_ffmpeg*.dll` và `cv2/data/haarcascade_*.xml`.
5. Dọn venv: gỡ `opencv-python-headless` + `opencv-contrib-python`, để `rapidocr`
   quyết định một bản `opencv-python` duy nhất; cập nhật `requirements.txt` cho khớp.

**Rủi ro: TRUNG BÌNH — đây là vùng đã từng gây crash runtime.** `sidecar.spec` có
lịch sử "thiếu metadata → `paddlex DependencyError`". Mỗi bước phải build lại +
smoke-test **toàn bộ** tính năng dùng sidecar (OCR, Searchable, Nén, Sửa chữ gốc,
PDF→Office, So sánh, Bóc tách), không chỉ OCR. Nên làm **từng bước một, mỗi bước một
commit**, không gộp.

**Lợi ước tính:** installer 455 MB → ~350–380 MB; app đã cài 1 482 MB → ~1,2 GB.
Cài nhanh hơn, ít bị antivirus quét lâu hơn, OTA update nhẹ hơn.

---

### A2-b 🟢 RapidViet không dùng recognizer của RapidOCR nhưng vẫn ship 3 model recognizer

`RapidVietHybridOCREngine` chỉ lấy **box**; chữ do VietOCR đọc. Ba file recognizer
(~36 MB) vẫn nằm trong bundle. **Nhưng** — xem B1 — hiện pipeline vẫn *chạy* chúng,
nên chưa thể xoá trước khi B1 được chốt. Ghi lại ở đây để không quên.

---

### A3 🟢 Spellchecker của Electron đang bật (mặc định) → trái D2 "local-first"

`desktop/src/tabs.js` tạo 3 `WebContentsView` (thanh tab, tab tài liệu, khung xem) với
`contextIsolation/sandbox/nodeIntegration` cấu hình rất tốt, **nhưng không có
`spellcheck: false`**. Electron bật spellchecker mặc định và **tải từ điển Hunspell từ
CDN của Google lần đầu**. Các `<input>` trong `index.html` đã đặt `spellcheck="false"`
từng ô, nhưng đó là mức DOM — bản thân spellchecker của Chromium vẫn khởi tạo.

**Đề xuất:** `spellcheck: false` ở cả 3 `webPreferences` (hoặc
`session.defaultSession.setSpellCheckerEnabled(false)` một chỗ trong `main.js`).
**Rủi ro: rất thấp.** Lợi: bớt một lần gọi mạng ngoài ý muốn + chút RAM/khởi động mỗi tab.

---

### A4 ~~🟢 `help.js` (105 KB) nạp đồng bộ trong mọi tab~~ — ❌ **ĐÃ ĐO LẠI: KHÔNG ĐÁNG LÀM**

Xem §9.2. Đo thật: **toàn bộ 1 687 KB JS của renderer chỉ tốn 21,6 ms compile**, riêng
`help.js` là **0,7 ms**. Con số 22,6 ms tôi trích ban đầu là đo bằng `require()` trong
Node — nó gộp cả đọc đĩa + module wrapper, không phải chi phí trong renderer. Đổi sang
nạp động để lấy lại <1 ms mà phải động vào đường mở Hướng dẫn là đánh đổi sai. **Bỏ.**

<details><summary>Nội dung đề xuất cũ (giữ lại để đối chiếu)</summary>

`index.html` nạp ~950 KB JS dạng classic script cho mỗi tab; riêng `help.js` là toàn bộ
nội dung hướng dẫn, chỉ cần khi bấm **F1**. Comment trong `index.html` đã ghi
*"nothing in the renderer depends on window.Help at load time (app.js resolves it lazily
inside the menu handler)"* — tức nó **đã** sẵn sàng để nạp động.

**Đề xuất:** bỏ thẻ `<script src="help.js">`, nạp động bằng cách chèn thẻ script lần
đầu mở Hướng dẫn. **Rủi ro: thấp**; đã có `test:help` (`help-content.test.js`) làm lưới
an toàn. Lợi: mỗi tab bớt parse ~105 KB — nhân theo số tab.

</details>

---

## 3. Phát hiện — Nhóm B: lợi ích lớn, **bắt buộc đo trên scan thật trước**

### B1 🟠 RapidViet chạy **toàn bộ** pipeline RapidOCR rồi **vứt** phần nhận dạng đi

`RapidVietHybridOCREngine._detect_boxes()` gọi `self._detector.engine(...)` — tức
det **+ cls + rec** — rồi chỉ giữ `res.boxes`. Comment giải thích lý do:
*"Detection-only mode over-segments lines into words, which hurts VietOCR's per-line
recognition."*

**Đo hôm nay** (trang hợp đồng tổng hợp 1653×2339, `best of 3`, ấm):

| Cấu hình | Thời gian | Số box |
|---|---:|---:|
| FULL (det + cls + rec) — **đang dùng** | **2,585 s** | 29 |
| DET-only (`Global.use_cls=False`, `Global.use_rec=False`) | **1,485 s** | 29 |

→ **tiết kiệm 1,10 s/trang ≈ 43 % khâu detect**, và trên trang này **số box y hệt** —
tức hiện tượng "over-segment" **không tái hiện**.

**Nhưng phải đặt đúng bối cảnh — đừng bán quá lời.** Đo tách bạch hai khâu trên trang
27 dòng (máy lúc đó đang bận tải file, nên số tuyệt đối cao hơn mốc 2,585 s ở trên;
chỉ dùng để đọc **tỉ lệ**):

| Khâu | Thời gian | Tỉ trọng |
|---|---:|---:|
| Detect (RapidOCR full pipeline) | 3,35–3,50 s | ~26 % |
| Recognize (VietOCR, batch 27 dòng) | 9,54–9,89 s | **~74 %** |
| **Tổng** | 12,9–13,4 s | |

→ **VietOCR mới là nút thắt thật (~3/4 thời gian)**, không phải detection. B1 tiết kiệm
1,1 s trên tổng ~4 s (detect) + ~7–9 s (rec) ⇒ **~8–11 % end-to-end**, không phải 43 %.
Vẫn đáng làm (miễn phí về chất lượng nếu đối chứng đạt), nhưng đừng kỳ vọng đổi đời.

**Đã loại một giả thuyết (ghi lại để không ai đuổi theo nữa):** tôi nghi `predict_batch`
của VietOCR gom lô theo chiều rộng nên sinh ra nhiều lô cỡ 1. **Đo rồi: sai.** 27 dòng
→ **3 lô**, cỡ `[25, 1, 1]` (width 310 / 480 / 512). Gom lô đang hiệu quả; chi phí là
bản chất giải mã tự hồi quy của transformer trên CPU. Muốn cải thiện thật sự phải
export VietOCR sang ONNX — **một dự án riêng**, không nằm trong đợt này.

**Giả thuyết vì sao comment vẫn đúng ở trường hợp khác:** RapidOCR lọc box theo
`text_score = 0.5`, tức **điểm tin cậy của recognizer**. Tắt rec = mất bộ lọc đó → trên
scan nhiễu sẽ giữ lại cả box rác. Đó là một tác dụng phụ **khác** với "over-segment",
và có thể thay bằng bộ lọc hình học rẻ tiền (diện tích tối thiểu, tỉ lệ cạnh, chồng lấn).

**Đề xuất:** coi đây là **thí nghiệm có kiểm soát**, không phải bản vá:
thêm `OCR_RAPID_DET_ONLY=1` (mặc định **tắt**), chạy đối chứng trên bộ scan thật, so
sánh từng ký tự output VietOCR. Chỉ đổi mặc định khi output **giống hệt hoặc tốt hơn**.
Nếu thắng, A2-b (xoá ~36 MB model recognizer) mở khoá theo.

---

### B2 🔴 Model VietOCR **không** nằm trong installer, và cache nằm ở `%TEMP%`

Hai vấn đề riêng biệt, cùng gốc là `vietocr` 0.3.13:

1. **`Cfg.load_config_from_name()` gọi mạng MỖI lần dựng `Predictor`, không cache.**
   `vietocr/tool/utils.py::download_config` = `requests.get("https://vocr.vn/data/vietocr/config/<name>.yml")`,
   không ghi đĩa, không fallback. → **vocr.vn sập ⇒ OCR chết**, kể cả trên máy đã cache
   weights, kể cả khi người dùng tưởng mình đang chạy offline.
2. **Weights cache vào `tempfile.gettempdir()`** = `%TEMP%`, mà Windows Storage
   Sense / Disk Cleanup dọn định kỳ → **tải lại 151,8 MB**.

**Bằng chứng thực nghiệm (hôm nay, trên chính máy này — máy đã từng chạy OCR):**
`%TEMP%` **không còn** `vgg_transformer.pth`; benchmark khởi động lại quá trình tải
151,8 MB từ vocr.vn ở ~250 KB/s. Log của lần đo:

```
rapidocr load:   0.78 s     ← model ONNX nằm sẵn trong bundle ✅
vietocr load:  286.33 s     ← phải tải 151,8 MB từ vocr.vn ❌
```

**286 giây chỉ để sẵn sàng OCR trang đầu tiên** — trên một máy người dùng sẽ tưởng là
"đã cài xong rồi". Badge "OCR: …" treo suốt thời gian đó.

`HUONG-DAN-SU-DUNG.md` §3 đã mô tả "lần đầu cần Internet… các lần sau chạy offline
bình thường" — vế sau **không đúng một cách đáng tin cậy**, vì cả hai lý do trên.
`DESIGN.md` §5 cũng đã liệt "tải weights runtime" là rủi ro đóng gói cao nhất; nó vẫn
chưa được xử lý.

**Đề xuất:**
- Bundle 2 file YAML (`base.yml`, `vgg-transformer.yml`) vào resources; dùng
  `Cfg.load_config_from_file()` thay cho `load_config_from_name()`.
- Bundle `vgg_transformer.pth` (151,8 MB) vào `extraResources`; đặt `config["weights"]`
  = đường dẫn cục bộ (`download_weights` trả thẳng path khi không phải `http`).
- Nếu không muốn installer to thêm: host file `.pth` trên **GitHub Release của mình**
  và tải lần đầu từ đó (nhanh & ổn định hơn vocr.vn nhiều), cache vào
  `app.getPath("userData")` chứ **không** phải `%TEMP%`.

**Đánh đổi:** phương án bundle làm installer +~140 MB (sau nén) — bù lại đúng bằng
phần A2 cắt đi, và đổi lấy **đúng lời hứa D2 local-first**.
**Rủi ro:** trung bình (chạm packaging), nhưng thay đổi có tính "thêm vào", dễ hoàn tác.

---

### B3 🟢 Các việc đã ghi trong tài liệu cũ nhưng **chưa làm**

| Nguồn | Mục | Trạng thái kiểm tra hôm nay |
|---|---|---|
| `docs/OCR-OPTIMIZATION.md` §4.2 | Downscale ảnh đầu vào (~1600 px cạnh dài) | ❌ chưa — `rasterize(scale=2)` vẫn gửi ảnh gốc |
| `docs/OCR-OPTIMIZATION.md` §4.2 | Timeout mỗi trang | ❌ chưa thấy |
| `docs/PERF-MEMORY.md` P2 | Tab nền nhả bitmap | ❌ chưa — `grep visibilitychange\|document.hidden` trong renderer: **0 kết quả** |
| `docs/PERF-MEMORY.md` P5 | Màn So sánh nhả canvas | ❌ chưa — `compare.js` không có hàm free |
| `docs/PERF-MEMORY.md` P1 | Trần dung lượng undo | ✅ **đã làm** (`HISTORY_BYTES_BUDGET`, `trimHistoryToBudget`) |
| `docs/PERF-MEMORY.md` P3 | Autosave co giãn | 🟡 một phần (đã có debounce) |

~~Thêm một mục mới cùng loại: gom `getPage` theo lô.~~ ❌ **ĐÃ ĐO LẠI: KHÔNG ĐÁNG LÀM** —
xem §9.1.

---

## 4. Phát hiện — Nhóm C: nợ nền tảng, phải lên kế hoạch riêng

### C1 🔴 Electron 33 đã hết hỗ trợ

- Đang dùng: **33.4.11** → Chromium **130**, Node 20.x.
- Stable hiện tại: **44.3.0** → Chromium **152**, Node 24.20.
- Electron chỉ vá **3 major mới nhất** (42 / 43 / 44).

→ App đang chạy trên một Chromium **không còn được vá lỗi bảo mật**. Đây là vấn đề
**bảo mật trước, hiệu năng sau** — dù 22 phiên bản Chromium cũng mang theo cải tiến
V8/GC/canvas đáng kể cho đúng loại công việc app này làm.

**Chi phí:** nâng Electron kéo theo `electron-builder` 25 → 26, rà lại toàn bộ API
`WebContentsView` / `BaseWindow` (tabs.js là vùng nhạy nhất), rà `session`/CSP, ký số,
và luồng `electron-updater`. **Phải là một PR riêng, có smoke-test đầy đủ theo
`REGRESSION-GUARD.md`.** Không gộp chung với bất kỳ mục nào ở trên.

⚠️ Lưu ý build: nâng electron-builder có thể chạm lại lỗi giải nén symlink
`winCodeSign` đã gặp trước đây (xem memory `electron-builder-wincodesign-symlink`).

### C2 🟠 pdf.js 3.11.174 (2023) → 6.3.289 — nhưng là **breaking change về định dạng module**

Kiểm chứng bằng cách tải tarball thật:

| | v3.11.174 | v4.10.38 | v6.3.289 |
|---|---|---|---|
| Build phát hành | UMD `.js` (global `pdfjsLib`) | **chỉ `.mjs`** (kể cả `legacy/`) | **chỉ `.mjs`** |
| `renderTextLayer` | có | **không còn** (thay bằng `class TextLayer`) | **không còn** |
| `isEvalSupported` | có | có | **không còn** |

Renderer hiện tại nạp `vendor/pdf.min.js` bằng thẻ `<script>` cổ điển và chia sẻ một
phạm vi từ vựng chung giữa `app.js` / `editor.js` / `capture.js` / `compare.js` /
`view.js` (`const pdfjsLib = window.pdfjsLib;`). Module ESM **defer** theo mặc định →
đổi sang `.mjs` sẽ làm `window.pdfjsLib` chưa tồn tại lúc `app.js` chạy.

**Vì vậy nâng pdf.js = refactor bootstrap của renderer, không phải đổi số phiên bản.**
Phải sửa ít nhất: cách nạp (bootstrap async hoặc bundler), `addTextLayer()`
(`app.js:955-980`), các chỗ gọi `getDocument({ isEvalSupported: false })` (3 chỗ),
và rà lại API `page.render()`.

**Khuyến nghị: KHÔNG làm chung đợt này.** Đây là ứng viên cho một nhánh riêng, có
lưới test GUI đầy đủ. Lợi ích hiệu năng là thật nhưng không cấp bách bằng C1.

### C3 🟡 `Pillow` bị khoá ở 10.2.0

`vietocr` ghim `pillow ==10.2.0`. Muốn lên Pillow 11/12 (decode/resize nhanh hơn, vá
bảo mật) thì phải: fork/patch vietocr, hoặc cài `--no-deps` rồi tự quản dependency, hoặc
bỏ vietocr. Không khuyến nghị đụng vào lúc này — ghi nhận để biết.

---

## 5. Lộ trình đề xuất

> **Trạng thái tính đến 2026-09-16** — bảng gốc giữ nguyên để đối chiếu, cột cuối là
> kết quả thật. Số đợt trong các mục §9–§14 bám theo thứ tự thi công thực tế, không hoàn
> toàn trùng bảng này.

| Đợt | Gồm | Rủi ro | Trạng thái |
|---|---|---|---|
| **1** | A1 (torch lazy) · A3 (spellcheck) · A4 (help.js động) · B3-mới (gom `getPage` theo lô) | Thấp | ✅ xong — A4 + getPage bị **đo và bác bỏ** (§9.1–9.3) |
| **2** | A2 bước 1–2 (pyarrow/pandas/sklearn + matplotlib) | Trung bình | ✅ xong — sklearn/matplotlib **phải giữ** (§10) |
| **3** | A2 bước 3–5 (lọc `.lib`/`.h`, ffmpeg, dọn venv OpenCV) | Trung bình | ✅ xong (§10.1) |
| **4** | B2 (bundle model + config VietOCR, bỏ phụ thuộc vocr.vn) | Trung bình | ✅ xong (§11) |
| **5** | B1 (thí nghiệm det-only, cần scan thật) + A2-b | Cần dữ liệu | ✅ B1 xong trên scan thật (§13); **A2-b bất khả thi** (§13.6) |
| **6** | B3 tồn đọng (downscale OCR, timeout/trang, P2, P5) | Thấp–TB | ⏳ P5 + BI-78 màn So sánh xong (§12); downscale/timeout/P2 **chưa** |
| **7** | C1 (Electron 44 + electron-builder 26) — **PR riêng** | Cao | ✅ xong (§14), A/B với Electron 33 đều 18/18 |
| **8** | C2 (pdf.js ESM) — **PR riêng, sau C1** | Cao | ⏳ chưa |

**Còn lại, theo thứ tự tôi đề nghị:** C2 (pdf.js 3.11 → 6.x, breaking về module) ·
B3 tồn đọng (downscale ảnh đầu vào OCR, timeout mỗi trang, P2 nhả bitmap tab nền) ·
xuất VietOCR sang ONNX — §13.4 cho thấy đó là chỗ **duy nhất** còn đáng tối ưu trong OCR.

---

## 6. Lưới test cho mỗi đợt

**Luôn chạy trước & sau mọi đợt:**

```bash
.venv/Scripts/python run_tests.py
```
```bash
cd desktop && node test/tabs-logic.test.js && node test/sidecar-lifecycle.test.js && node test/help-content.test.js && node test/raster-cap.test.js && node test/wire-codec.test.js
```

| Đợt | Kiểm chứng riêng |
|---|---|
| 1 (A1) | `python -X importtime -c "import api"` trước/sau; `OCR_ENGINE=rapidviet` OCR 1 trang ra đúng dấu; `OCR_ENGINE=hybrid` (máy có paddle) **không** lỗi `WinError 127`; nén 1 file > 25 MB đo thời gian tổng |
| 1 (A3/A4) | Mở 3 tab, F1 mở Hướng dẫn, tìm trong hướng dẫn; kiểm tra không còn request ra CDN từ điển |
| 1 (getPage) | Mở PDF 1 trang / 50 trang / 500 trang; so thời gian tới lúc trang 1 hiện; kéo thumbnail; đảo trang; undo |
| 2–3 | Build `sidecar.exe`, chạy **từng** tính năng: OCR · Searchable · Nén (cả < 25 MB và > 25 MB) · Sửa chữ gốc · Tìm & Thay thế · PDF→Office (docx + xlsx) · So sánh bản vẽ · Bóc tách (Gemini) |
| 4 | **Ngắt mạng hoàn toàn**, cài mới trên máy sạch, chạy OCR ngay lần đầu → phải chạy được |
| 5 | Bộ scan hợp đồng thật; diff từng ký tự output VietOCR giữa full-pipeline và det-only |
| 7 | Toàn bộ `docs/REGRESSION-GUARD.md` + `docs/TABS-TEST-L1.md` |

---

## 7. Điều tôi cần bạn quyết — ~~đang mở~~ **đã trả lời hết**

1. ~~**Đợt 1 — làm ngay?**~~ → làm, xong (§9).
2. ~~**B2 — chọn hướng nào?**~~ → **bundle thẳng**, xong (§11).
3. ~~**B1 — có scan thật không?**~~ → có: `HĐC - Nazare - 2 dấu.pdf`, 78 trang scan. Đo
   xong, det-only thành mặc định (§13).
4. ~~**C1 xếp lịch vào đâu?**~~ → làm luôn, xong (§14).
5. ~~**A2 từng bước hay gộp?**~~ → từng bước có kiểm chứng bằng `sys.meta_path` (§10).

---

## 8. Những gì tôi **không** đề xuất

- ❌ Đổi engine OCR mặc định. `docs/OCR-OPTIMIZATION.md` §3c đã chứng minh dứt điểm:
  không recognizer PP-OCR nào (latin/en/vi/v6) có đủ ký tự dấu chồng tiếng Việt trong
  dict. RapidOCR 3.9 vẫn **chưa có** `LangRec` tiếng Việt (đã kiểm tra hôm nay:
  `CH, CH_DOC, EN, ARABIC, CHINESE_CHT, CYRILLIC, DEVANAGARI, JAPAN, KOREAN, KA, LATIN,
  TA, TE, ESLAV, TH, EL`). VietOCR + torch vẫn là lựa chọn đúng.
- ❌ Bỏ Electron. `docs/PERF-MEMORY.md` §4 đã kết luận (chỉ giảm 15–30%). Tôi đồng ý.
- ❌ Bật DirectML cho onnxruntime lúc này. RapidOCR có hỗ trợ `use_dml`, nhưng phải đổi
  sang gói `onnxruntime-directml`, tăng dung lượng, và khâu detect chỉ chiếm ~1,5 s —
  không đáng đánh đổi độ ổn định. Ghi lại để cân nhắc sau nếu khâu detect thành nút thắt.
- ❌ Đụng `Pillow` (bị vietocr ghim) hoặc nâng pdf.js chung đợt với việc khác.

---

## 9. ĐỢT 1 — đã thi công & đo lại (2026-09-15)

### 9.0 Kết quả

| Mục | Trạng thái | Số đo |
|---|---|---|
| **A1** torch nạp lười | ✅ xong | xem bảng A/B ngay dưới |
| **A3** tắt spellcheck | ✅ xong | 3 `WebContentsView` + ghi chú lý do ngay trên `class TabbedWindow` |
| **A5** nhịp poll `/health` | ✅ xong | mới, phát sinh TỪ A1 — xem §9.5 |
| **A4** `help.js` nạp động | ❌ **bỏ** | xem §9.2 — lợi ích thật chỉ 0,7 ms |
| gom `getPage` theo lô | ❌ **bỏ** | xem §9.1 — lợi ích thật 7–26 ms cho 300 trang |
| đổi `toDataURL` → `toBlob` khi in | ❌ **bỏ** | xem §9.3 — `toBlob` **chậm hơn 10×** |

#### A1 — đo A/B thật (không suy diễn)

"OLD" không phải con số cũ chép lại: nó được đo lại **sau** thay đổi, bằng một
`sitecustomize.py` chỉ chứa `import torch` đặt trên `PYTHONPATH` — tái lập đúng hành vi
nạp sớm của bản cũ, cùng máy, cùng phiên, xen kẽ với "NEW".

| Việc người dùng cảm nhận được | OLD (torch nạp sớm) | NEW (torch nạp lười) | Lợi |
|---|---:|---:|---|
| **Sidecar lên `/health`** — chính là lúc badge "OCR: sẵn sàng" bật (`sidecar.js waitForHealth`) | 2 183 · 2 184 · 2 191 ms | **1 126 · 1 129 · 1 153 ms** | **−1,05 s (1,9×)** |
| **Worker nén một file** (`sidecar.py --compress-worker`, chạy mỗi lần nén > 25 MB) | 2 225 · 2 228 · 2 353 ms | **700 · 726 · 729 ms** | **−1,5 s (3,1×)** |
| `import api` (ấm) | 1,60 s | **0,48 s** | −1,12 s |
| `torch` trong `sys.modules` sau `import api` | có | **không** | — |

Con số OLD của worker (~2,2 s) khớp gần như chính xác với ghi chú đã có sẵn trong
`api.py:882` (*"measured 2.1 s in dev"*) — một xác nhận chéo tốt.

Lạnh (lần chạy đầu sau khi bật máy) chênh lệch còn lớn hơn nhiều: `-X importtime` cho
thấy torch chiếm **8,42 s trên 12,61 s** của `import api`.

**Tác dụng phụ đo được:** chính bộ test Python nhanh lên vì không còn nạp torch —
`test_edit_text_font` 12,1 s → **1,5 s**, `test_compare_drawings` 7,1 s → **3,6 s**,
`test_pdf_office` 2,8 s → **1,0 s**; tổng bộ ~128 s → **~98 s**.

**Lưới test sau thay đổi:** Python **13/13 PASS**, Node **21/21 PASS**,
`node --check` sạch trên `tabs.js` + `main.js`, OCR smoke đọc đúng dấu tiếng Việt và
vẫn tự chọn `RapidViet`.

### 9.1 ❌ Gom `getPage` theo lô — giả thuyết SAI

Tôi cho rằng `renderViewer()`/`renderThumbs()` lặp `await pdf.getPage(i+1)` tuần tự là
nút thắt khi mở tài liệu lớn. Dựng probe chạy qua http với **chính bản pdf.js đang
vendor** và PDF **300 trang** thật:

| | lần 1 | lần 2 |
|---|---:|---:|
| tuần tự (như code hiện tại) | 38,5 ms | 19,8 ms |
| gom lô 64 | 13,1 ms | 12,3 ms |
| gom một lần tất cả | 11,5 ms | 11,5 ms |

Đo tiếp từng pha của `renderAll` trên cùng tài liệu 300 trang:

```
renderThumbs (getPage + dựng DOM 300 thumb)   23,5 ms
renderViewer (getPage + dựng DOM 300 trang)    0,7 ms   ← pdf.js đã cache page proxy
observe x2 (2 IntersectionObserver × 300)      0,1 ms
```

→ **Toàn bộ khâu này ~24 ms cho 300 trang.** Không phải nút thắt. Thêm concurrency +
giữ 300 page proxy sống cùng lúc để đổi lấy ~15 ms là **lỗ**. Không sửa.

### 9.2 ❌ Nạp động `help.js` — giả thuyết SAI

Đo compile **eager** (`new Function(src)`, tắt lazy compilation) toàn bộ script renderer:

```
   7,6 ms  513 KB  vendor/pdf-lib.min.js
   4,9 ms  312 KB  vendor/pdf.min.js
   2,3 ms  224 KB  app.js
   1,8 ms  223 KB  editor.js
   0,7 ms   93 KB  help.js      ← mục tiêu định tối ưu
   …
  21,6 ms 1687 KB  TOTAL
```

→ **Cả 1,7 MB JS của renderer chỉ tốn 21,6 ms.** Không có gì để cứu ở đây. Không sửa.

### 9.3 ❌ `canvas.toBlob()` thay `toDataURL()` khi in — giả thuyết SAI

Giả thuyết: chuỗi base64 giữ trong DOM là gánh nặng bộ nhớ khi in nhiều tờ khổ lớn.
Đo trên Chromium (chính engine của app):

| Ảnh | `toDataURL` | `toBlob` |
|---|---:|---:|
| A4 150 dpi (2,2 MP) | **32 ms** / 0,4 MiB | 33 ms / 0,3 MiB |
| A1 chạm trần 12 MP | **112 ms** / 1,1 MiB | **1 102 ms** / 0,8 MiB |
| A0 chạm trần 12 MP | **101 ms** / 1,1 MiB | **1 097 ms** / 0,8 MiB |

→ `toBlob` **chậm gấp ~10 lần** để tiết kiệm ~0,3 MiB/tờ. Đường in hiện tại đã đúng.
Không sửa.

### 9.5 ✅ A5 — nhịp poll `/health` (việc A1 đẻ ra)

A1 làm lộ một chỗ trước đây vô hại. `sidecar.js waitForHealth()` hỏi `/health` mỗi
**600 ms**. Khi sidecar cần ~2,2 s để trả lời thì 600 ms đó chìm trong thời gian boot.
Giờ boot chỉ còn ~1,13 s, nên **độ hạt của nhịp poll trở thành phần trễ đáng kể**:
badge "OCR: sẵn sàng" sáng theo lưới 600 ms, tức trung bình **muộn ~300 ms chỉ vì
không ai hỏi sớm hơn**.

**Một cái bẫy tôi đã sập rồi rút ra.** Phản xạ đầu tiên là backoff nhân
(`wait *= 1.6`, từ 60 ms lên trần 600 ms). Viết xong, in lịch ra kiểm tra thì thấy:

```
backoff nhân:  0, 60, 156, 310, 556, 950, 1550 ms
600 ms phẳng:  0, 600, 1200, 1800 ms
```

Backoff nhân mở một **khoảng trống 600 ms vắt ngang đúng mốc ~1,13 s** mà sidecar cần
→ nó trả lời ở **1 550 ms**, trong khi lưới 600 ms cũ trả lời ở **1 200 ms**. Tức là
"tối ưu" đó **chậm hơn bản gốc**. Ramp chỉ thắng khi thứ ta chờ chậm hơn hẳn bước đầu;
ở đây thì không.

**Cái đã làm:** hai pha phẳng — **100 ms trong 15 giây đầu**, sau đó về đúng 600 ms cũ.
Kiểm tra lại toàn dải:

| Sidecar sẵn sàng ở | Trễ thêm — CŨ (600 phẳng) | Trễ thêm — MỚI |
|---:|---:|---:|
| 800 ms | 400 ms | **0 ms** |
| 1 000 ms | 200 ms | **0 ms** |
| 1 130 ms | 70 ms | 70 ms |
| 1 500 ms | 300 ms | **0 ms** |
| 2 200 ms | 200 ms | **0 ms** |
| 5 000 ms | 400 ms | **0 ms** |
| 16 000 ms (đã qua cửa sổ nhanh) | 200 ms | 200 ms |

→ **không mốc nào tệ hơn bản cũ**, phần lớn về 0.

Thêm poll **không tốn gì**: trước khi uvicorn listen thì kết nối fail tức thì bằng
`ECONNREFUSED` (không giữ timer, không ghi log), và `/health` trả 200 ngay khi lên
(model nạp lười — xem `lifespan` trong `api.py`), nên **đúng một** request vào access
log, y như trước.

`node test/sidecar-lifecycle.test.js` — bộ này khởi động **sidecar thật** chứ không
stub `child_process` — **7 pass, 0 fail**.

### 9.4 Kết luận quan trọng về phía renderer

Ba phép đo trên cùng nói một điều: **phía Electron/renderer đã được tối ưu tốt rồi.**
Mở tài liệu 300 trang tốn ~24 ms dựng DOM, nạp toàn bộ JS tốn ~22 ms. Cơ chế lười đã
có (thumbnail lười, raster lười, nhả bitmap khi cuộn xa, trần byte cho undo) là phần
việc nặng và nó đã xong.

**Mọi chi phí còn đáng kể đều nằm ở sidecar Python và ở khâu đóng gói** — đúng thứ tự
ưu tiên mà §5 đã xếp. Đừng mất thời gian vi-tối-ưu renderer nữa.

---

## 10. ĐỢT 2 — dọn bundle: cách kiểm chứng KHÔNG cần build 30 phút

Trước khi đụng `sidecar.spec`, mọi gói định loại bỏ được thử bằng cách **giả vờ nó
không tồn tại**: một `sitecustomize.py` đặt trên `PYTHONPATH` cắm `_Blocker` vào
`sys.meta_path` (dùng `find_spec`, **không** phải `find_module` — API đó đã bị gỡ ở
Python 3.12), rồi chạy lại bộ test + OCR smoke. Nếu vẫn xanh thì thêm vào `excludes`
không thể làm hỏng bản đóng gói.

**Cách này đã cứu một lỗi thật:**

| Gói | Phán đoán ban đầu | Kết quả probe |
|---|---|---|
| `pyarrow` (78 MB) | rác | ✅ **đúng là rác** — loại được |
| `altair` | rác | ✅ loại được |
| `scikit-learn` (12,5 MB) | "khả năng cao không dùng" | ❌ **SAI — BẮT BUỘC GIỮ.** `albumentations` `import sklearn` ngay khi nạp module, mà `albumentations` là dep cứng của `vietocr` → `from vietocr.tool.predictor import Predictor` chết. Với sklearn bị chặn, engine rơi hết xuống nhánh paddle. **Nếu loại nó, OCR của bản đóng gói sẽ hỏng.** |
| `pandas` (12,6 MB) | "khả năng cao không dùng" | ⚠️ chỉ tới được qua `paddlex` (vốn đã exclude) → giữ nguyên: 12,6 MB không đáng để đánh cược |

### Đã áp dụng vào `sidecar.spec`

1. `excludes` thêm `pyarrow`, `altair`.
2. Lọc payload chỉ-dùng-lúc-build ngay trước `COLLECT` (hàm `_is_dead_weight`):
   - `torch/include/**` — 37,8 MB header C++
   - `torch/**/*.lib` — 45,7 MB import library MSVC
   - `opencv_videoio_ffmpeg*.dll` — 52,5 MB (**hai** bản, vì 3 wheel OpenCV cài chồng lên cùng `cv2/`)
   - `cv2/data/haarcascade_*.xml` — 6 MB

   `opencv_videoio_ffmpeg` được kiểm chứng bằng thực nghiệm: chạy **đúng** mọi lệnh cv2
   mà `src/compare/drawing.py` dùng (`resize`, `warpAffine`, `createHanningWindow`,
   `phaseCorrelate`, `absdiff`, `dilate`, `morphologyEx`, `connectedComponentsWithStats`)
   rồi soi `tasklist /m` → **không có** module ffmpeg/videoio nào được nạp vào tiến trình.

3. Chạy thử predicate trên chính cây `dist/sidecar` cũ:
   `DROP 9 444 file / 144,8 MB`, `KEEP 8 786 file`, và guard khẳng định
   `torch_cpu.dll` · `c10.dll` · `torch_python.dll` · `libiomp5md.dll` · `shm.dll` ·
   `cv2.pyd` đều **sống sót**.

→ Tổng dự kiến cắt: **~223 MB** trên 1 155 MB. **Phải xác nhận bằng build thật + smoke
từng tính năng** trước khi coi là xong.

### 10.1 Kết quả build thật + smoke toàn tính năng

`pyinstaller sidecar.spec --noconfirm` → **EXIT=0**, log xác nhận bộ lọc chạy đúng:

```
[sidecar.spec] pruned 2 entries from binaries
[sidecar.spec] pruned 9442 entries from datas
```

| | CŨ (v0.2.69) | MỚI | |
|---|---:|---:|---|
| `dist/sidecar` | **1 155 MB** | **931 MB** | **−224 MB (−19 %)** |
| số file | 18 230 | 8 138 | −10 092 |
| `torch` | 446,5 MB | 363,4 MB | −83,1 |
| `cv2` | 148,2 MB | 86,5 MB | −61,7 |
| `pyarrow` | 78,0 MB | **0** | −78,0 |

Kiểm tra nội dung sau build:

```
CÒN (bắt buộc):  torch_cpu.dll · c10.dll · shm.dll · libiomp5md.dll · cv2.pyd
                 onnxruntime_pybind11_state.pyd · sklearn · rapidocr/models
                 matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf
ĐÃ BỎ:           torch/include · pyarrow · opencv_videoio_ffmpeg*.dll
                 cv2/data/haarcascade_*.xml  (cv2/data/__init__.py giữ lại — là module)
```

**Smoke chạy trên chính `sidecar.exe` đã đóng gói** (khởi động thật, gọi qua HTTP như
renderer vẫn gọi) — **18/18 PASS**:

```
frozen sidecar answered /health in 1.03s
PASS health · config (google-genai) · templates
PASS fonts                1102 families      ← matplotlib.font_manager còn sống
PASS compress             791108 -> 35032 B
PASS split · pdf-to-images
PASS pdf-to-office docx   python-docx + lxml
PASS pdf-to-office xlsx   openpyxl
PASS text-spans 14 · text-find 28 hits
PASS edit-text            ghi "ộ ử ấ ề ị" bằng DejaVu
PASS add-page-numbers · encrypt+decrypt · compare (text)
PASS compare-drawings     cv2 + scipy
PASS searchable           OCR 1 trang, 6 hộp text   ← RapidOCR + VietOCR + torch
PASS ocr                  "HOP DONG MUA BAN trang 1 dong 1..."
```

### 10.2 A/B trên **binary đã đóng gói**, không phải dev

Bản cũ vẫn còn nguyên tại `C:\…\Programs\Nabu PDF\resources\sidecar\sidecar.exe`
(v0.2.69, torch nạp sớm). Chạy bản sao của nó ở cổng khác — **không đụng app đang
mở của người dùng** — và đo xen kẽ với bản mới:

| | lần 1 | lần 2 | lần 3 | tốt nhất |
|---|---:|---:|---:|---:|
| CŨ (frozen, torch sớm) | 2,62 s | 2,10 s | 2,10 s | **2,10 s** |
| MỚI (frozen, torch lười) | 1,03 s | 1,55 s | 1,04 s | **1,03 s** |

→ **Badge "OCR: sẵn sàng" lên nhanh gấp ~2× trong bản đóng gói thật** (2,10 s → 1,03 s),
chưa tính phần A5 cắt thêm ~300 ms trễ do nhịp poll.

### 10.3 Việc còn lại của Đợt 2/3 — CỐ Ý CHƯA LÀM

| Việc | Vì sao dừng |
|---|---|
| Gỡ matplotlib (21,3 MB) | **Không an toàn.** Ngoài `DejaVuSans.ttf`, `font_manager` còn là thứ liệt kê + khớp font hệ thống cho **trình sửa chữ gốc** (`_list_local_font_families`, `_resolve_local_font`). Smoke đếm được **1 102 font family** đi qua đường này. Viết lại bằng cách đọc `%WINDIR%\Fonts` + registry là đổi luật khớp font — task riêng, cần lưới test riêng. |
| Dọn 3 bản OpenCV trong venv | Tác động lớn nhất (2 DLL ffmpeg) **đã xử lý bằng bộ lọc**. Gỡ wheel trong venv sẽ đổi phiên bản `cv2` mà `src/compare/drawing.py` đang chạy — rủi ro không tương xứng phần còn lại. |
| Hạ `_COMPRESS_WORKER_MIN_BYTES` | A1 hạ chi phí khởi động worker 2,2 s → 0,7 s, nên điểm hoà vốn tụt từ ~25 MB xuống ~8–10 MB. **Nhưng** đổi nó làm job 10 MB chậm đi ~50 % để đánh đổi lấy việc sidecar không bị khoá 1,4 s — đó là một **đánh đổi về hành vi**, không phải tối ưu thuần. Cần bạn quyết, không tự đổi. |
| A2-b bỏ 36 MB model recognizer của RapidOCR | Phụ thuộc B1 (§3). Hiện pipeline vẫn *chạy* chúng. |

---

## 11. ĐỢT 4 (B2) — model VietOCR vào thẳng bộ cài (2026-09-16)

Quyết định của chủ dự án: **bundle thẳng**, không tự host trên GitHub Release.

### 11.1 Vấn đề, nói chính xác

`vietocr` 0.3.13 lấy model **lúc chạy**, ở **hai** chỗ, và cả hai đều ra mạng:

| | Hàm | Hành vi |
|---|---|---|
| Config | `Cfg.load_config_from_name()` | `requests.get` **hai** file YAML từ `vocr.vn` **mỗi lần** dựng `Predictor`. **Không cache gì cả** → vocr.vn sập là OCR chết, kể cả máy đã có weights. |
| Weights | `Predictor.__init__` → `download_weights()` | Tải `vgg_transformer.pth` **151,8 MB** vào `tempfile.gettempdir()` = `%TEMP%` — nơi Windows Storage Sense / Disk Cleanup dọn định kỳ. |

Đo trên máy **đã từng chạy OCR thành công**: `rapidocr load 0,78 s` nhưng
`vietocr load **286,33 s**`.

### 11.2 Cách sửa

1. `models/vietocr/` — hai YAML **commit vào git** (2 KB, là config; đổi `vocab` hay
   `image_max_width` là đổi kết quả OCR nên phải nằm trong review), `.pth` **không**
   (`.gitignore` sửa để cho phép đúng `*.yml` trong thư mục này).
2. `tools/fetch_vietocr_model.py` — tải `.pth`, **ghim SHA256 + kích thước**, ghi qua
   file `.part` rồi mới đổi tên (không bao giờ để lại file tải dở).
3. `sidecar.spec` — bundle 3 file vào `_internal/models/vietocr/`; nếu thiếu `.pth` thì
   **in cảnh báo to** chứ không fail build (app vẫn chạy, chỉ là rơi về đường cũ).
4. `src/ocr/engine.py::_vietocr_local_config()` — dựng config từ file local, trỏ
   `weights` vào `.pth` cạnh nó. **Đây là chỗ mạng biến mất theo cấu trúc, không phải
   theo may mắn**: `download_weights()` trả thẳng chuỗi khi nó không bắt đầu bằng
   `http`, nên không còn code path nào gọi ra ngoài được.
5. `desktop/package.json` — `build:sidecar` gọi script tải trước khi chạy PyInstaller.

**Hai cái bẫy đã tránh:**

- `Cfg.load_config_from_file()` **KHÔNG** đọc `base.yml` (tự xem mã: nó khởi tạo
  `base_config = {}`). Dùng nó là mất toàn bộ `vocab` + `transformer` + `dataset`.
  Phải tự merge base **dưới** model yaml, đúng như `load_config_from_name` làm.
- Tên file yaml lấy từ `url_config` **của chính vietocr**, không chép lại bảng đó sang
  đây — model nào không ship thì đơn giản là không tìm thấy file và rơi về đường mạng.

### 11.3 Chứng minh, không phải tin lời

**`test_vietocr_offline.py`** (mới, đã vào `run_tests.py`) — **7/7 PASS**. Phép thử
quan trọng nhất chặn thẳng `socket.socket.connect`, nên **bất kỳ** lần gọi ra ngoài
nào — requests, urllib, hay torchvision đi lấy weights ImageNet — đều làm test đỏ
thay vì âm thầm chạy được nhờ mạng của người đang code:

```
PASS test_bundle_dirs_include_repo_root
PASS test_config_yamls_are_committed
PASS test_local_config_matches_the_yaml_merge
PASS test_unknown_model_falls_back_to_none
PASS test_weights_resolve_to_a_local_file
PASS test_predictor_loads_with_the_network_blocked
PASS test_recognition_still_reads_vietnamese_with_network_blocked
```

**Kiểm tra tương đương config** — so từng key giữa config dựng-local và config
tải-từ-vocr.vn:

```
keys online: 15 | keys local: 15
DIFF weights:
   online: 'https://vocr.vn/data/vietocr/vgg_transformer.pth'
   local : 'D:\GitHub\ContractOCR\models\vietocr\vgg_transformer.pth'
=> số key khác nhau: 1  → CHỈ khác đúng key 'weights'
```

### 11.4 Một chi tiết suýt bỏ sót

`config["cnn"]["pretrained"] = False` trong `predictor` **là thứ chịu lực**, không phải
dòng thừa: `vgg-transformer.yml` ghi `cnn.pretrained: True`, và nếu để True thì
torchvision đi tải weights ImageNet `vgg19_bn` từ `download.pytorch.org` — **một lần
gọi mạng thứ hai, còn lớn hơn**, mà file `.pth` đã fine-tune ghi đè lên ngay sau đó.
Đã thêm comment tại chỗ để không ai "dọn" nó đi.

### 11.5 Kết quả build + kiểm chứng trên bản đóng gói

Build lại: **EXIT=0**, bộ lọc rác vẫn chạy (`pruned 2 binaries / 9442 datas`), và model
nằm đúng chỗ:

```
dist/sidecar/_internal/models/vietocr/
    base.yml               1 809 B
    vgg-transformer.yml      505 B
    vgg_transformer.pth  151 815 373 B
```

**`frozen_offline_check.py` — chứng minh 3 lớp, không chỉ tin vào log:**

1. Ba file có mặt vật lý trong bundle.
2. **Dời `%TEMP%\vgg_transformer.pth` sang chỗ khác trước khi chạy** — đó là *chỗ duy
   nhất* trình tải của vietocr cache weights. Nếu app còn đi đường cũ thì nó buộc phải
   tải lại 151,8 MB.
3. Sau khi chạy xong, `%TEMP%` **vẫn không có** file `.pth` nào ⇒ không có gì được tải.

```
PASS  bundled base.yml / vgg-transformer.yml / vgg_transformer.pth
parked %TEMP%\vgg_transformer.pth  (để ép đường tải cũ phải lộ ra)
PASS  sidecar boots                      /health in 2.71s   (lần chạy đầu của exe mới)
PASS  OCR works                          10.7s -> 'CỘNG H\nHÒA XÃ\nHỘI'
PASS  OCR was not gated on a download    10.7s   (tải 152 MB thì phải tính bằng phút)
PASS  log says bundled + offline         "VietOCR: bundled config + weights (...) — fully offline"
PASS  no fallback warning in log
PASS  nothing was downloaded to %TEMP%
=> ALL CHECKS PASSED
```

### 11.6 Dung lượng — offline mà vẫn **nhẹ hơn** bản cũ

| | MB | file |
|---|---:|---:|
| v0.2.69 (gốc) | 1 155 | 18 230 |
| sau khi dọn rác (§10) | 931 | 8 138 |
| **+ model VietOCR (bản này)** | **1 076** | **8 142** |

→ Tuy **thêm hẳn 145 MB model** vào trong app, `dist/sidecar` vẫn **nhỏ hơn bản gốc
79 MB**, vì phần dọn rác ở §10 bù nhiều hơn. Đổi được: OCR offline thật, không còn phụ
thuộc `vocr.vn`, không còn 286 s chờ tải.

### 11.7 Tài liệu đã sửa theo (nếu không sửa thì thành nói sai)

- `HUONG-DAN-SU-DUNG.md` §3.2/§3.3 — "lần OCR đầu tiên cần Internet" đã **sai**; bảng
  offline ở §4 đổi 2 dòng từ ⚠️ sang ❌ (Searchable, So sánh bản vẽ); 3 dòng khắc phục
  sự cố ở §7 không còn đổ lỗi cho mạng.
- `SETUP.md` — thêm mục **1b** (bước tải model) kèm lý do.
- `DESIGN.md` §5 — rủi ro "tải weights runtime" đánh dấu **đã xử lý**.
- `desktop/scripts/check-sidecar-fresh.js` — gác thêm `models/vietocr/*.yml`: sửa
  `vocab` hay `image_max_width` trong đó là **đổi kết quả OCR** mà không đụng file `.py`
  nào, nên bộ gác cũ sẽ không thấy.

---

## 12. ĐỢT 5 — màn So sánh: một lỗi BI-78 còn sống, và P5 (2026-09-16)

Vào đây để làm **P5** của `docs/PERF-MEMORY.md` (màn So sánh không nhả canvas). Đọc mã
thì thấy có **hai** vấn đề, và cái thứ hai nặng hơn cái định sửa.

### 12.1 🔴 BI-78 vẫn sống trong màn So sánh — trang lớn ra **trắng**, không báo lỗi

`renderer/raster-cap.js` tự viết trong header của nó rằng nó được tách riêng ra để
BI-78 không "chết theo từng nửa", và kể tên **hai** nơi rasterise trang: `app.js` và
`view.js`. **Nó đếm thiếu.** `compare.js` là nơi thứ ba — và là nơi *dành riêng* cho
bản vẽ khổ lớn ("So sánh & **Chồng lớp bản vẽ** (CAD/Revit)"). Nó sizing canvas thẳng
từ `devicePixelRatio`, **không** qua `RasterCap`:

| Chỗ | Trần zoom | A0 (3370×2384 pt) ở trần, dpr 2 | Hậu quả |
|---|---:|---:|---|
| `renderPage` (khung so sánh) | 400 % | **~514 MP** | quá vách ~268 MP → Chromium nhận `canvas.width`, trả về context, resolve `page.render`, rồi **không vẽ gì cả** |
| `ovRenderPage` (chồng lớp) | 400 % | **~514 MP × 2 canvas** | như trên, mà còn xếp chồng hai lớp |

Đúng cái triệu chứng raster-cap.js mô tả: **không exception nào để bắt**, bản vẽ chỉ
đơn giản là trắng. Đã sửa: cả hai đi qua `window.RasterCap.viewRasterDpr`. Hàm đó
**không bao giờ phóng to**, nên mọi trang thường vẫn y nguyên từng pixel; chỉ khổ lớn
mới bị hạ độ phân giải bitmap *bên trong cùng một khung CSS*.

**Và thêm một lưới gác cấu trúc** vào `desktop/test/raster-cap.test.js`: mọi renderer
sizing canvas trang để hiển thị **phải** nhắc tới `RasterCap.viewRasterDpr`, và không
được có `canvas.width = Math.floor(vp.width * dpr)`. Lưới này **đã bắt được** chỗ thứ
hai (`ovRenderPage`) mà đọc mã tôi đã bỏ sót. `editor.js` cố ý **không** nằm trong danh
sách: `rasterRedacted()` của nó nung pixel **vào file PDF người dùng giữ lại**, ở
`RS = 2` cố định (~144 dpi → A0 là 32 MP, cách vách rất xa) — hạ độ phân giải một raster
**đầu ra** là làm hỏng file, không phải tiết kiệm bộ nhớ.

### 12.2 🟠 P5 — nhả bitmap (đúng việc định làm)

`buildPane` gọi `obs.unobserve(w)` ngay sau khi vẽ: "vẽ rồi thì thôi, không nghĩ tới
trang này nữa". Đó cũng chính là thứ khiến **mọi trang từng cuộn qua giữ bitmap suốt
phiên làm việc, ở CẢ HAI khung**. Ở scale của màn này một trang A4 ≈ 10 MB, nên cuộn hết
một so sánh 300 trang giữ khoảng **6 GB**.

Đã sửa theo đúng khuôn `app.js` (cơ chế đã chạy ổn định trong khung xem chính):

- bỏ `unobserve` → trang được giải phóng vẫn vẽ lại được khi quay lại;
- thêm **keep band** rộng hơn (1 200 px, so với dải vẽ 400 px — khoảng chênh là
  hysteresis để cuộn qua lại quanh mép không bị thrash render↔free);
- `freeCmpPage()` chỉ bỏ **pixel**: `canvas.style.*`, nhãn trang và mọi ô `.cmp-box`
  ở nguyên → hình học cuộn và `jumpToChange` không đổi;
- `reset()` ngắt luôn hai observer mới (bỏ sót là chúng bắn `freeCmpPage` vào slot đã
  tháo của lần so sánh trước).

**Một tình huống hiếm mà `app.js` có xử lý còn bản đầu của tôi thì chưa:** `freeCmpPage`
có thể bắn *trong lúc* `renderPage` còn đang `await page.render` — lúc đó slot chưa có
canvas nên free là no-op, ta vẽ xong, và trang nằm **ngoài** keep band mà không còn sự
kiện nào tới dọn (IntersectionObserver chỉ bắn khi **đổi** trạng thái). Đã thêm cờ
`data-rendering` + khối `finally` thu hồi, y như `m.rendering` +
`pageFarFromViewport()` của `app.js`.

### 12.3 Kiểm chứng

| | |
|---|---|
| `desktop/test/raster-cap.test.js` | **30 pass, 0 fail** (thêm 6 assertion cấu trúc) |
| Bộ Node | **21/21 PASS** |
| Bộ Python | **14/14 PASS** (thêm `test_vietocr_offline.py`) |
| Smoke trên `sidecar.exe` | **18/18 PASS**, boot ấm 1,03 s |

⚠️ **Giới hạn phải nói rõ:** đường vẽ của màn So sánh **không có test tự động** (nó cần
DOM thật + một báo cáo `/compare` thật). Tôi đã kiểm bằng: đọc đối chiếu với `app.js`,
lưới gác cấu trúc ở trên, và chạy tay máy trạng thái của các cờ `rendered`/`rendering`.
**Vẫn cần bạn thử tay**: mở So sánh một tài liệu dài, cuộn xuống cuối rồi cuộn ngược
lên — trang phải hiện lại đầy đủ, không trắng, các ô đánh dấu khác biệt phải còn đúng
chỗ; và mở Chồng lớp một bản vẽ A0/A1 rồi zoom lên hết cỡ.

---

## 13. ĐỢT 6 (B1) — đo trên scan thật, và comment 3 năm nay là SAI (2026-09-16)

Bạn đưa bộ đối chứng: **`HĐC - Nazare - 2 dấu.pdf`, 78 trang A4 scan, ảnh JPEG
3508×2480 (300 dpi), không trang nào có lớp text**. Đúng loại tài liệu B1 cần.
Render ở **200 dpi** — đúng mặc định của `/searchable` — nên số đo dưới đây là số
người dùng thật sự chịu, không phải số phòng thí nghiệm.

### 13.1 Trước hết: đọc mã `rapidocr` 3.9, không đoán

Hai chi tiết quyết định cách đặt thí nghiệm, cả hai chỉ thấy khi mở mã ra:

1. **`use_det/use_cls/use_rec` là cờ DÍNH, không phải tham số của một lần gọi.**
   `RapidOCR.__call__` gọi `update_params()`, và hàm đó `setattr` thẳng lên
   *instance* (`main.py:255-279`). Truyền `use_rec=False` một lần là instance đó
   **det-only vĩnh viễn**. Vì vậy `_detect_boxes` nêu tên **cả ba cờ mỗi lần gọi** —
   để chế độ không bao giờ bị lần gọi trước để lại. Có test riêng gác điều này.

2. **Tắt `rec` là tắt luôn HAI bộ lọc**, nằm trong `build_final_output`:
   bỏ box có `txts` rỗng, rồi `filter_by_text_score` (`text_score = 0.5`).
   **Cả hai điểm số đều do recogniser PP-OCR *Latin* chấm** — đúng cái thành phần mà
   `RapidVietHybridOCREngine` sinh ra để tránh, vì nó không đọc được dấu tiếng Việt.

3. Còn `cls` thì **chưa bao giờ ảnh hưởng** đầu ra của lớp này: nó chỉ xoay các crop
   đưa sang `rec`, mà ta tự cắt lại từ ảnh PIL gốc. Tắt nó là miễn phí tuyệt đối.

### 13.2 Đợt đo 1 — toàn bộ 78 trang, chỉ khâu detect

Chạy xen kẽ thứ tự hai chế độ theo từng trang để nhiễu nhiệt/cache không thiên vị bên nào.

| | FULL (det+cls+rec) | DET-only |
|---|---:|---:|
| Tổng khâu detect, 78 trang | **325,3 s** | **107,3 s** |
| Trung bình mỗi trang | 4,17 s | **1,38 s** |
| Tổng số box | 3 685 | 3 699 |
| Trang bị **mất** box | — | **0 / 78** |
| Trang có box **thêm** | — | 8 / 78 (+14 box) |

→ **−67 % khâu detect. Và không mất một box nào trên bất kỳ trang nào.**
Hiện tượng "over-segments lines into words" mà comment cũ viện dẫn **không tái hiện**
lấy một lần trên 78 trang scan thật.

### 13.3 Đợt đo 2 — 14 box "thêm" đó là cái gì?

Đây mới là chỗ quyết định, nên đọc to từng cái bằng chính VietOCR:

```
p  2   17x 23px  'k'          p 53   14x 17px  '0'      p 54   15x 16px  '0'
p  9   29x 36px  'Ộ'          p 53   18x 21px  'e'      p 54   15x 16px  'Q'
p  9   34x 36px  '/1'         p 53   14x 15px  '0'      p 66   65x 49px  '04'
p 50  104x 67px  '(m'         p 53   16x 16px  '6'      p 76   17x 24px  '%'
p 50  273x192px  'Qw'
p 71  385x 94px  'THS. Đoàn Văn Động'   <-- CHỮ THẬT
```

13 cái là mảnh vụn dưới cỡ một ký tự, bắn ra từ **hai con dấu tròn** (p50 chính là cái
dấu: 104×67 và 273×192). Cái thứ 14 thì không.

**Nói cho thật chính xác — phiên bản đầu tôi viết đã hơi quá tay và chính phép kiểm
bác lại.** Trang 72 là trang xác nhận/ký, và tên người ký **đã có sẵn** trên đó hai lần
(`Mr. Đoàn Văn Động` / `Ông. Đoàn Văn Động`) — cả hai chế độ đều đọc được. Nên "mất tên
người ký" là sai. In cả hai đầu ra ra rồi so từng dòng thì thấy thứ thật sự bị mất là:

```
FULL (21 dòng)                        DET-ONLY (22 dòng)
  19 'Signature/ Chữ ký:'               19 'Signature/ Chữ ký:'
                                        20 'THS. Đoàn Văn Động'   <-- chỉ det-only có
  20 'Date/ Ngày:'                      21 'Date/ Ngày:'
```

Tức **đúng dòng nằm giữa "Chữ ký:" và "Ngày:" — chính dòng ký**. Ở bản cũ, khối chữ ký
của trang trả về **rỗng**. Không phải vì nó không phải chữ, mà vì bộ lọc `text_score`
hỏi nhầm câu hỏi: nó hỏi *"recogniser tiếng Anh có đọc nổi không"*.

Đổi 13 ký tự lạc trên 78 trang lấy **dòng ký** + 2/3 thời gian detect: **đáng**.

### 13.4 Đợt đo 3 — end-to-end, và chỗ nút thắt thật

8 trang lấy mẫu trải đều, chạy **cả VietOCR**:

| | FULL | DET-only |
|---|---:|---:|
| Tổng | 173,7 s | **152,2 s** |
| — khâu detect | 32,7 s | **11,2 s** |
| — khâu VietOCR | 141,1 s | 141,0 s |
| **Tiết kiệm end-to-end** | | **12,4 %** |

Và **chữ ở các box chung giống hệt nhau trên 8/8 trang** — đúng như suy luận: cùng tập
box → cùng thứ tự sắp → cùng crop → cùng đầu ra. Đã kiểm chứ không tin suông.

Đọc bảng này cho đúng: **VietOCR chiếm 81 % công việc**, detect chỉ 19 %. Ước tính
8–11 % ở §B1 là gần đúng; con số thật là 12,4 %. Ai muốn cải thiện tiếp **phải nhằm vào
recogniser** (export VietOCR sang ONNX — một dự án riêng), không phải detect nữa.

### 13.5 Đã làm gì

- `_detect_boxes` gọi `use_det=True, use_cls=False, use_rec=False`; `OCR_RAPID_DET_ONLY=0`
  trả lại hành vi cũ nguyên vẹn.
- **Cố ý KHÔNG thêm bộ lọc hình học** để dọn 13 mảnh vụn. Một bộ lọc mới là một
  heuristic mới chưa có dữ liệu bảo chứng, và rủi ro của nó là **xoá nhầm chữ thật** —
  đúng cái lỗi vừa sửa xong. 13 ký tự / 78 trang không đáng đổi lấy rủi ro đó. Có
  assertion trong `test_ocr_det_only.py` để nếu ai thêm bộ lọc thì test đỏ, chứ không
  lặng lẽ làm sai các con số ở trên.
- Docstring của `RapidVietHybridOCREngine` thay "~3–4 s/trang" (số của trang đồ chơi)
  bằng số thật: detect 1,38 s + VietOCR 5–26 s tuỳ số dòng.

### 13.6 A2-b — ước tính cũ SAI, ghi lại để không ai đuổi theo

§A2-b nói B1 thắng thì mở khoá việc xoá ~36 MB model recogniser. **Không.**
`RapidOCR._initialize` dựng `TextRecognizer(cfg.Rec)` **vô điều kiện**, bất kể
`use_rec`, và `TextRecognizer.__init__` tạo ONNX session ngay (`ch_ppocr_rec/main.py:39`).
Xoá file model là app **không khởi tạo được engine**, kể cả ở det-only. Chỉ có thể bỏ
các model *lang khác* không dùng tới, không bỏ được cái đang trỏ (`Rec.lang_type=EN`).

### 13.7 Kiểm chứng

Mọi số ở §13.2–13.4 đo trên `.venv`. Thứ người dùng chạy là bản PyInstaller, nên phải
hỏi lại trên chính nó — `frozen_det_only.py` khởi động `sidecar.exe` **hai lần** (engine
dựng một lần mỗi tiến trình) và OCR đúng trang 72 qua HTTP:

| | |
|---|---|
| `test_ocr_det_only.py` (mới, không cần model) | **15 pass, 0 fail** |
| Bộ Python | **15/15 file PASS** |
| Bộ Node | **21/21 PASS** |
| **Frozen: det-only nhanh hơn** ⇒ env var tới được engine sau khi đóng băng | ✅ 7,9–8,9 s → **6,6 s** (−17…26 %) |
| **Frozen: không mất dòng nào** | ✅ 21 → 22 dòng, `dropped = none` |
| **Frozen: khối chữ ký không còn rỗng** | ✅ `['THS. Đoàn Văn Động']` vs `[]` |
| Smoke toàn tính năng trên `sidecar.exe` | **18/18 PASS**, boot ấm **1,05 s** |
| Kiểm offline (dời `%TEMP%gg_transformer.pth` đi) | **ALL CHECKS PASSED** |
| Bundle | **1 092 MB / 8 142 file** (prune 9 442 mục) |

---

## 14. ĐỢT 7 (C1) — Electron 33 → 44 (2026-09-16)

`electron 33.4.11` (Chromium 130, Node 20) → **`44.4.1` (Chromium 152, Node 24.21)**,
`electron-builder 25.1.8` → **`26.15.3`**. 11 major, 22 phiên bản Chromium.

### 14.1 Cách rà, để không sót và không bịa

Không đọc changelog rồi đoán. Ba bước, bước nào cũng đối chiếu được:

1. Tải `docs/breaking-changes.md` **thật** của Electron, đọc từng mục cho 34 → 44.
2. Cài `electron@44.4.1` vào một thư mục scratchpad rồi đọc **`electron.d.ts` của chính
   nó** — nguồn sự thật về chữ ký API, không phải bản tóm tắt.
3. **Quét máy, không quét bằng mắt:** rút toàn bộ token `<module>.<method>(` trong
   `desktop/src/*.js`, rồi kiểm từng tên phương thức có còn trong typings 44 không.

Bước 3 trả về đúng **3** cái không còn: `net.createServer` (là `net` của Node, không phải
của Electron — dương tính giả), `clipboard.readImage`, `clipboard.writeImage`. Không có
cái thứ tư. Đó là điều mà đọc changelog bằng mắt không bao giờ dám khẳng định.

### 14.2 Ba thứ thật sự vỡ, và vì sao hai trong số đó **vỡ trong im lặng**

**(a) 🔴 `clipboard` bị viết lại theo chuẩn W3C (E44).** `writeImage`/`readImage`
**biến mất**; còn lại `read`/`write` bất đồng bộ, nói bằng `ClipboardItem` + `Blob`.
`main.js` dùng cả hai hàm đã mất (copy ảnh/vùng ra, và "Dán ảnh vào trang").
Đây là cái duy nhất **ném lỗi ngay**, tức là cái dễ nhất trong ba cái.

**(b) 🔴 `PrinterInfo.isDefault` bị xoá (E36).** Hộp thoại In của app chọn sẵn máy in mặc
định đúng bằng cờ này (`app.js`). Mất cờ ⇒ **không báo lỗi gì**, chỉ là combo box rơi vào
máy in đầu danh sách. Và theo ghi chú `nabu-print-sheet-fit`, máy mặc định ở đây là
**driver A3** ⇒ "máy in đầu danh sách" có thể là in ra sai khổ giấy.

**(c) 🟠 Hộp thoại file mặc định về Downloads (E43).** Thiếu `defaultPath` giờ nghĩa là
Downloads, **và HĐH thôi tự nhớ thư mục lần trước**. Với app mà PDF nằm trong thư mục
từng dự án, đó là **mỗi lần "Mở PDF" đều bắt đầu ở sai chỗ**, mãi mãi. Cũng im lặng.

### 14.3 Cách sửa — vá **trước**, nâng **sau**

Cả ba bản vá được viết và chạy **khi vẫn còn ở Electron 33**, nhánh cũ vẫn là mã sống.
Như vậy mỗi bản vá kiểm được ngay hôm đó, đối chứng với hành vi thật đang có, chứ không
phải đối chứng với phỏng đoán; và nếu dừng lại ở đó thì **không có gì đổi hành vi**.

- **clipboard**: rẽ nhánh theo `typeof clipboard.writeImage === "function"`, tức theo
  *cái runtime thật sự có*, không theo số phiên bản. Nhánh 44 dựng
  `ClipboardItem({'image/png': Blob})`. Giữ nguyên chốt `nativeImage.isEmpty()` đứng
  trước, để payload hỏng vẫn chết tại chỗ với `decode-failed` thay vì trôi ra clipboard.
  Hai handler thành `async` — không tốn gì, preload vốn đã `ipcRenderer.invoke`.
- **isDefault**: sửa **ở main**, không đụng renderer, nên hợp đồng `p.isDefault` y nguyên.
  Nếu runtime đã điền cờ (≤43) thì **không làm gì cả**; nếu không, đọc
  `HKCU\...\Windows\Device` — đúng chỗ Windows ghi máy in mặc định của người dùng — rồi
  gắn cờ. Một lần `reg` ~30 ms, có cache 30 s.
- **hộp thoại**: `prefs.js` nhớ thư mục cuối, **mỗi hộp thoại một ngăn riêng**
  (`open-pdf` / `save-pdf` / `open-files` / `save-file`) để lưu export không kéo theo nơi
  mở PDF. Chỉ nhận đường dẫn **tuyệt đối**, ngăn lạ bị từ chối — giá trị này đi thẳng vào
  một hộp thoại native nên phải lọc như mọi input không tin được. 17 assertion mới.

Một chi tiết đáng nói: thêm `lastDirs` làm **test `tabs-logic` đỏ ngay** (nó chốt hình
dạng `prefs.json` đúng bằng `{v:1, openIn:"window"}`). Đó là lưới gác làm đúng việc, nên
sửa theo hướng **giữ file y nguyên** — không ghi `lastDirs` khi rỗng — chứ không phải nới
assertion. Người chưa từng mở hộp thoại nào thì `prefs.json` của họ không đổi một byte.

### 14.4 Những thứ đã rà và **không** phải sửa

| Đổi ở E34–44 | Vì sao app không dính |
|---|---|
| `window.open` popup luôn resizable (E39) | `setWindowOpenHandler` trả `{action:"deny"}` |
| `WebRequestFilter.urls` rỗng ≠ mọi URL (E35) | `onHeadersReceived` gọi **không có** filter |
| `session.setPreloads` bỏ dần (E35) | dùng `webPreferences.preload`, không dùng API kia |
| `clearStorageData` bỏ `quotas`/`syncable` | app không gọi |
| PDF thôi tạo WebContents riêng (E41) | app render bằng pdf.js, không dùng viewer của Chromium |
| `plugin-crashed`, `webFrame.routingId`, `isAeroGlassEnabled`, extension API | không dùng |
| utilityProcess: unhandledRejection chỉ cảnh báo (E37) | `signing-worker.js` đã `try/catch` quanh handler, `signing.js` resolve ở cả `message` lẫn `exit` |
| Bỏ Windows 32-bit (E44) | chỉ build x64 |
| `pageSize`/`duplexMode`/`copies`/`pageRanges` | tra typings 44: **danh sách không đổi** |
| `webUtils.getPathForFile` (BI-63) | còn nguyên ở 44 |

**Đổi quy trình, cần biết:** từ **E42 `pnpm install` KHÔNG còn tải binary Electron**
(upstream bỏ `postinstall` vì đó là đường tấn công chuỗi cung ứng). Sau khi cài,
`node_modules/electron/dist/` **chưa tồn tại**. `pnpm start` tự tải lần đầu; SETUP.md §2
đã ghi lại. `pnpm run build` không ảnh hưởng — electron-builder tải bản riêng.

`electron-builder` 25 → 26 thì phần đụng tới dự án này gần như không có: nhóm thay đổi
lớn nằm ở macOS (notarize, HFS+) và Linux (`desktop`), còn Windows chỉ gom cấu hình ký số
vào `win.signtoolOptions` — mà file `electron-builder.yml` **vốn đã** viết theo tên đó.

### 14.5 Kiểm chứng — probe CDP trên app THẬT

Bộ test Node/Python là logic thuần, chúng sẽ xanh dù Electron có chết hẳn. Nên phải chạy
app thật. Probe dựng bằng Chrome DevTools Protocol (`/json/list` + `Runtime.evaluate`),
**không sửa một dòng mã app nào**, gọi thẳng `window.desktop.*` tức là test IPC thật.

18 phép kiểm, gộp lại thành bảng dưới:

| Kiểm | Kết quả |
|---|---|
| main process boot (3 WebContentsView) | ✅ |
| renderer nạp `index.html`, `window.desktop` có | ✅ |
| pdf.js nạp được, `RasterCap` có | ✅ |
| mở PDF 78 trang từ argv → dựng đủ 78 khung | ✅ |
| **pdf.js vẽ trang thật trên Chromium 152** | ✅ canvas **595×841**, 0,5 MP, trong hạn mức BI-78 |
| `print:printers` trả danh sách | ✅ 2 máy in |
| **đúng 1 máy in được gắn `isDefault`** | ✅ và đúng là máy HP thật |
| `clipboard:read-image` không ném | ✅ |
| rác byte bị chặn trước clipboard | ✅ `{ok:false, reason:"decode-failed"}` |
| PNG thật đi qua đường ClipboardItem của E44 | ✅ không ném |
| **CSP vẫn được tiêm** (chèn `<script>` inline phải bị chặn) | ✅ `BLOCKED` |
| không exception/console error nào | ✅ |
| **thoát sạch qua đúng đường quit** (không cần kill) | ✅ |

**Và quan trọng nhất: chạy ĐÚNG probe đó trên Electron 33 cũng ra 18/18.** Đó mới là câu
trả lời cho "có regression không" — không phải 18 dấu tích trên bản mới, mà là **hai cột
giống hệt nhau**. Cài `electron@33.4.11` vào scratchpad riêng, probe nhận đường dẫn
binary qua biến môi trường, chạy cả hai.

Ba cái bẫy mất thời gian nhất, ghi lại vì lần sau sẽ gặp lại:

- Lần chạy đầu app **thoát mã 0 ngay**, trông y như "boot sạch rồi tự tắt". Thật ra
  `app.getName()` lấy từ `name` trong `package.json` mà electron-builder ship nguyên
  field đó ⇒ bản dev và **bản đã cài đang mở** dùng chung `%APPDATA%\nabu-pdf-desktop`,
  tức chung khoá single-instance. Phải `--user-data-dir` riêng.
- Rồi **0 trang nào vẽ**. Không phải pdf.js hỏng: `document.visibilityState === "hidden"`
  (bố cục vẫn đúng: 1344×801, `#viewer` 1160×609, `.page-wrap` 595×841), Chromium đình
  chỉ vòng frame ⇒ IntersectionObserver không kích ⇒ bộ dựng trang lười không chạy. Chữa
  bằng `--disable-backgrounding-occluded-windows` + `--disable-renderer-backgrounding` +
  `--disable-background-timer-throttling`, cộng `Page.setWebLifecycleState {state:active}`.
  Và một assertion của chính tôi lúc đầu **quá lỏng**: `<canvas>` chưa đụng tới đã là
  300×150, nên `width > 100` đếm cả khung rỗng thành "đã vẽ". Đã siết thành `height > 400`.
- Phép thử CSP đầu tiên của tôi **sai**, và sai theo kiểu nguy hiểm: `eval()` chạy được
  ⇒ tôi kết luận "CSP không còn được áp". Thật ra **`Runtime.evaluate` của DevTools được
  MIỄN TRỪ CSP của trang** — nên phép thử đó luôn báo "ALLOWED" dù chính sách có chặt đến
  đâu. Bắt được là nhờ chạy app **không có cổng debug** với `--enable-logging=file` rồi
  đọc log thật: CSP có áp, và nó đang chặn một script inline. Đã đổi sang **chèn một
  `<script>` inline vào DOM**, thứ đi qua đúng chính sách của trang → `BLOCKED` ✅.

  → Luật rút ra: **`Runtime.evaluate` không kiểm được chính sách bảo mật của trang.**
  Muốn kiểm thì phải làm điều mà chính trang làm.

### 14.6 ✅ Một lỗi CÓ SẴN phát hiện trong lúc rà — và đã sửa

Log runtime cho thấy CSP đang chặn script chống nháy theme:

```
"Executing inline script violates ... 'script-src 'self' 'wasm-unsafe-eval''.
 ... The action has been blocked."  source: renderer/index.html (7)
```

Đó là đoạn đặt `data-theme` từ `localStorage` **trước lần vẽ đầu**. Bị chặn ⇒ theme chỉ
được áp muộn, từ `app.js` ⇒ **người dùng nền tối thấy nháy trắng mỗi lần mở tab/cửa sổ**.

**Không phải regression của đợt nâng cấp** — đo trên Electron 33 cũng đúng 1 vi phạm ấy.

**Khảo sát thì rộng hơn cái log nói.** Log chỉ thấy 1 trang vì nó chỉ nạp `index.html`.
Quét cả `renderer/*.html`:

| File | Inline script | Kết luận |
|---|---|---|
| `index.html` | 1 (theme) | ✅ cần hash |
| `view.html` | 1 (theme) — **trùng từng byte** với trên | ✅ **cũng dính**, chưa từng lộ ra vì nó chỉ nạp khi mở khung xem |
| `shell.html` | 0 | — |
| `error.html` | 1 | **file chết** — `grep` cả repo không có chỗ nào tham chiếu |
| `loading.html` | 0 | **file chết** |

Vì hai script theme trùng byte nên **một hash phủ cả hai**. Cố ý **không** cấp hash cho
`error.html`: cấp quyền chạy cho script của một trang không bao giờ nạp là mở rộng bề mặt
chính sách để đổi lấy số không.

**Hash tự tính, không chép từ log.** Viết lại đúng cách Chromium làm (sha256 trên text
của phần tử, xuống dòng đã chuẩn hoá về LF) rồi đối chiếu: ra **đúng** chuỗi Chromium in
ra ⇒ cách trích đúng ⇒ hash của các file khác cũng tin được.

Hash được viết **thẳng vào chuỗi CSP**, không giấu sau hằng số có tên — lưới gác đọc
`main.js` như **văn bản**, nên một lớp gián tiếp sẽ khiến nó xanh mà chẳng chứng minh gì.
Lần đầu tôi làm đúng như vậy và **lưới bắt được ngay**.

#### Kiểm chứng

A/B trên **cùng trang, cùng cửa sổ, chỉ khác chính sách** — và chuỗi CSP được **trích từ
`main.js` lúc chạy**, không chép lại (probe kiểm bản sao của chính nó thì chứng minh
được gì?):

| | `index.html` | `view.html` |
|---|---|---|
| **CÓ** hash | 0 vi phạm · `data-theme="dark"` | 0 vi phạm · `data-theme="dark"` |
| **KHÔNG** hash | 1 vi phạm · `data-theme=null` | 1 vi phạm · `data-theme=null` |

Bảng này cũng **tự chốt luôn việc quy trách nhiệm**: cửa sổ probe giống hệt nhau ở cả hai
cột, nên nếu `app.js` là thứ đặt theme thì cột dưới cũng phải ra `"dark"`. Nó ra `null`.
Vậy thứ duy nhất đặt được `data-theme` chính là inline script.

Và trên **app thật**, chạy không cổng debug với `--enable-logging=file`:

| | Trước | Sau |
|---|---|---|
| Electron 44 | 1 vi phạm | **0** |
| Electron 33 | 1 vi phạm | **0** |

**Cái KHÔNG đo được, nói thẳng:** `performance.getEntriesByType('paint')` **rỗng** trong
cửa sổ `show:false` — cửa sổ ẩn không bao giờ vẽ — nên không có phép so "theme đặt lúc
t1 < first-paint lúc t2" nào nếu không bật cửa sổ lên màn hình người dùng. Tôi đã thử và
bỏ. "Trước lần vẽ đầu" ở đây là **tính chất vị trí**, không phải phép đo: thẻ `<script>`
là con đầu của `<head>`, đứng trước `<link rel=stylesheet>`, không `async`/`defer` ⇒
parser dừng chạy nó khi trang chưa có nội dung nào để vẽ. Nên tôi gác nó bằng **assertion
tĩnh** thay vì giả vờ đã đo.

#### Lưới gác (`npm run test:tabs`)

Hash gắn với **từng byte** của script: sửa một dấu cách là nó bị chặn lại, không lỗi,
không log. Nên test **tự tính lại hash từ HTML** rồi đòi `main.js` phải có đúng nó —
không hard-code chuỗi hash ở hai nơi rồi hy vọng chúng trùng. Cộng với vị trí thẻ.
Đã kiểm lưới bằng **đột biến** (chạy trên bản sao trong bộ nhớ, không đụng repo):

| Đột biến | Lưới |
|---|---|
| bỏ hash khỏi CSP | 🔴 `index.html + view.html: hash missing` |
| đổi **một** dấu cách trong script | 🔴 `index.html: hash missing` |
| thêm `defer` vào thẻ | 🔴 `view.html: has async/defer` |
| dời thẻ xuống dưới CSS | 🔴 `index.html: not before stylesheet` |
| không đổi gì | 🟢 GREEN |

### 14.7 Đóng gói

`electron-builder 26.15.3` đóng gói `electron 44.4.1` thành NSIS x64. **Không** vấp lại
lỗi giải nén symlink `winCodeSign` trong memory (cache đã có sẵn `winCodeSign-2.6.0`).

### 14.8 ⚠️ Phần KHÔNG kiểm được ở đây — phải test tay

| Việc | Vì sao máy này không kiểm được |
|---|---|
| **Copy ảnh / Dán ảnh vào trang** | Shell này không có quyền window station tương tác: `clip.exe` trả "Access is denied", `Set-Clipboard` của PowerShell (kể cả trên thread STA) cũng hỏng. Vòng ghi–đọc clipboard **không pass được ở đây trên bất kỳ Electron nào**. Đã kiểm phần kiểm được (hàm chạy hết, guard giải mã còn chặn rác); phần OS thì chưa. |
| **In (khổ giấy, 1 trang → 1 tờ)** | Ghi chú `nabu-print-sheet-fit` đo trên **Chromium 130**; giờ là **152**. Đường fit-to-width có thể đã đổi. Đây là vùng rủi ro cao nhất còn lại. |
| Ký số PDF | Cần chứng thư thật + tương tác |
| Tự cập nhật (`electron-updater`) | Cần một release thật trên GitHub |
| Explorer "Mở bằng" / "Gộp bằng Nabu PDF" | Cần bản đã cài + shell thật |
