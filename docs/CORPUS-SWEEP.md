# Lưới quét corpus (mở → sửa → lưu → qpdf)

Lưới test thứ ba của repo, bên cạnh `run_tests.py` (Python) và `npm test` (JS):
**chạy đường ghi file thật của app trên hơn một nghìn file PDF đời thật, rồi để một trọng tài
độc lập chấm.** Mượn cách làm của PdfCraft — xem
[RESEARCH-2026-11-21-pdfcraft-learnings.md](RESEARCH-2026-11-21-pdfcraft-learnings.md) §2.4.

- Chạy: `cd desktop && npm run sweep:corpus`
- Mã: [`desktop/scripts/corpus-sweep.js`](../desktop/scripts/corpus-sweep.js) (điều phối) +
  [`corpus-sweep-one.js`](../desktop/scripts/corpus-sweep-one.js) (một file / một tiến trình)
- Mốc so sánh: `desktop/test/corpus-baseline.json` (**có commit**)
- Báo cáo: `desktop/.sweep/report.json` (**không commit**)

## Vì sao cần nó

`npm test` không chạm được `app.js`/`editor.js` (DOM) và **không hề chạy đường ghi file** trên
tài liệu thật: mọi test JS đều `require()` file thuần, cắt hàm ra `eval`, hoặc ghim regex. Nghĩa
là loại lỗi "lưu ra xong thì file hỏng / mất trang / mất góc xoay / pdf-lib treo" **không lưới nào
bắt** — chỉ người dùng mở file ở Acrobat mới thấy.

Lưới này bịt đúng khe đó, và nó rẻ: không viết thêm test đơn vị nào, chỉ cần 1.100 file có sẵn.

## Nó làm gì với mỗi file

1. `qpdf --check` trên **file gốc** — corpus pdf.js **cố tình** chứa file hỏng; không có bước này
   thì mọi lỗi đều đổ oan cho mình.
2. pdf-lib `load()` → `save()` **không sửa gì** → `qpdf --check` kết quả.
3. pdf-lib `load()` → **xoay trang 1 thêm 90°** → `save()` → `qpdf --check`, rồi **mở lại** kết quả
   để xác nhận góc xoay còn đó và số trang không đổi (BI-59 / BI-65).

Mỗi file chạy trong **một tiến trình con riêng, có hạn giờ** (mặc định 60 s): file méo làm pdf-lib
treo hoặc nổ heap thì bị giết riêng, cả vòng quét vẫn đi tiếp. Đây là "watchdog bỏ qua trang bệnh
lý" của PdfCraft.

## Đọc kết quả

Mỗi file được xếp thành **một từ**. Bốn từ đầu là trạng thái bình thường của corpus, **không**
tính là lỗi của Nabu:

| Từ | Nghĩa |
|---|---|
| `ok` | gốc sạch, lưu ra vẫn sạch, sửa đổi sống sót |
| `encrypted` | tài liệu mã hoá — Nabu giải mã qua sidecar trước, pdf-lib không phải đường đi |
| `broken_input` | gốc đã hỏng sẵn theo qpdf |
| `load_fail_broken_input` | pdf-lib không mở nổi, mà qpdf cũng nói file hỏng |
| **`load_fail`** | **qpdf đọc được, pdf-lib không** — lỗ hổng của ta |
| **`edit_fail`** | mở được nhưng không sửa nổi (cây trang hỏng) |
| **`save_fail`** | `save()` ném lỗi |
| **`output_error`** | gốc không hỏng mà **file ta ghi ra thì hỏng** — nặng nhất |
| **`output_warn`** | gốc sạch, file ta ghi ra bị qpdf cảnh báo |
| **`rotate_lost`** | lưu xong mở lại thì góc xoay biến mất |
| **`pagecount_changed`** | số trang đổi sau một lần xoay |
| **`reopen_fail`** | chính pdf-lib không mở lại nổi file nó vừa ghi |
| **`timeout` / `crash`** | treo hoặc chết trên file đó |

Lệnh thoát `1` **chỉ khi có file xấu đi so với mốc** — tức "thay đổi vừa rồi làm hỏng thêm", chứ
không phải "corpus có file hỏng".

```
npm run sweep:corpus                       # quét đủ, so với mốc
npm run sweep:corpus -- --limit 40         # thử nhanh
npm run sweep:corpus -- --filter rotate    # chỉ file có 'rotate' trong tên
npm run sweep:corpus -- --update-baseline  # ghim lại mốc (khi đã sửa xong, hoặc đổi corpus)
```

## Cài đặt một lần

Corpus và qpdf **nằm ngoài repo** (153 MB + 27 MB). Đường dẫn mặc định là
`D:\GitHub\_refs\…`; đổi bằng `NABU_CORPUS_DIR` / `NABU_QPDF` hoặc `--corpus` / `--qpdf`.

```powershell
cd D:\GitHub\_refs
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/mozilla/pdf.js.git pdfjs-corpus
cd pdfjs-corpus; git sparse-checkout init --cone; git sparse-checkout set test/pdfs; git checkout
```

qpdf: tải bản `qpdf-<ver>-msvc64.zip` ở <https://github.com/qpdf/qpdf/releases>, giải nén vào
`D:\GitHub\_refs\tools\qpdf\` (không cần cài, chạy thẳng `bin\qpdf.exe`).

Corpus được **ghim theo commit** trong mốc; quét trên commit khác thì script cảnh báo, vì hai bộ
file khác nhau thì con số không so thẳng được với nhau.

## Khi nào chạy

- **Bắt buộc** khi đụng vào bất cứ chỗ nào đọc/ghi PDF: `state.bytes`, `commitBytes`, `editor-bake.js`,
  `page-vault.js`, `page-move.js`, đường lưu/xuất ở `main.js`, hoặc nâng cấp **pdf-lib**.
- Trước một bản phát hành.
- **Không** phải cổng của `/deploy`: cần dữ liệu ngoài repo, và mất vài phút.

## Việc đầu tiên lưới này tìm ra, và đã sửa (2026-11-21)

**9 trong 10 ca `output_warn` là MỘT lỗi**, trong pdf-lib: stream có `/Length` là **tham chiếu
gián tiếp** (`/Length 674 0 R`) bị **cắt cụt mất byte cuối**. `parseDictOrStream` chỉ tin
`/Length` khi nó là một số; gặp tham chiếu thì nó dò tới từ khoá `endstream` và coi byte ngay
trước đó là dấu xuống dòng ngăn cách — kể cả khi byte đó là **dữ liệu thật**.

`tracemonkey.pdf` là đúng ca đó: ảnh ở object 483 dài **1013** byte, byte cuối tình cờ là `0x0D`,
và nhà sản xuất viết `endstream` dính liền dữ liệu, không chèn xuống dòng. pdf-lib cắt còn 1012
⇒ luồng deflate mất byte cuối ⇒ **ảnh giải nén ra rác**, `/Length` ghi ra cũng sai theo. Người
dùng chỉ mở ra rồi lưu lại, không sửa gì, là mất dữ liệu — im lặng.

Đã vá ở [`desktop/renderer/pdflib-stream-length.js`](../desktop/renderer/pdflib-stream-length.js)
(hai lượt: ghi nhận lúc phân tích, cắt lại sau khi cả tài liệu đã phân tích xong, qua ba cửa
kiểm chứng nên không thể động vào file đang đọc đúng). Nạp ở renderer qua `<script>` ngay sau
`vendor/pdf-lib.min.js`, ở main qua `require` trong `src/signing-worker.js` — nơi hậu quả còn
nặng hơn, vì tài liệu sẽ được **ký** trên phần byte đã hỏng.

Lưới riêng: `npm run test:streamlen` (đã thử cho đỏ bằng cách vô hiệu hoá bản vá).
Kết quả quét sau khi sửa: **1.043 → 1.052 `ok`**, 9 file hết lỗi, **không file nào xấu đi**.

Còn lại 9 file chưa sửa (đã ghim mốc): 5 `load_fail`, 2 `output_error`, 1 `edit_fail`,
1 `output_warn` (`doc_actions.pdf` — nguyên nhân khác, "file is damaged").

## Kết quả lần quét đầu tiên (2026-11-21, TRƯỚC khi sửa)

Corpus pdf.js ghim ở commit `57dead10694e`, **1.104 file**, 8 tiến trình song song, **~60 giây**.

| | |
|---|---|
| `ok` | 1.043 |
| `encrypted` (bỏ qua) | 26 |
| gốc đã hỏng sẵn (`broken_input` + `load_fail_broken_input`) | 17 |
| **ta làm xấu đi** | **18** |

18 file đó đã được ghim vào mốc — chúng **không** làm lưới đỏ, nhưng là danh sách việc có thật:

- **5 × `load_fail`** — qpdf đọc được, pdf-lib thì không:
  `bug1250079` (`Expected next byte to be 62`), `bug1606566` (không có header PDF),
  `issue6069` (parse số rỗng), và hai file làm pdf-lib **ném lỗi kiểu JS** khi đi qua cây trang:
  `issue5334` (`_this.catalog.Pages is not a function`), `issue21436` (`…Pages(...).traverse is not
  a function`). Với Nabu đây là "mở file ra thì app báo lỗi lạ" — qpdf chứng minh file **đọc được**.
- **2 × `output_error`** — gốc chỉ bị cảnh báo mà **file ta ghi ra thì qpdf báo lỗi**:
  `bug1980958`, `issue15716`.
- **10 × `output_warn`** — gốc **sạch**, file ta ghi ra bị cảnh báo. Đáng chú ý nhất: cả họ
  **`tracemonkey*.pdf`** (4 biến thể — đây là PDF mẫu kinh điển của pdf.js, một bài báo 14 trang
  hoàn toàn bình thường) cùng `images.pdf`, `doc_actions.pdf`, `issue12337`, `issue18911`,
  `issue19239`, `bug1992868`. Gần hết đều cùng một thông điệp, cùng một chỗ:
  *"(offset 774940): input stream is complete but output continues beyond expected length"* —
  tức **pdf-lib ghi lại một stream với `/Length` không khớp dữ liệu**. Người dùng lưu một file
  như vậy xong mở ở Acrobat có thể bị kêu là file hỏng.
- **1 × `edit_fail`** — `filled-background.pdf`: `setRotation` ném `Parent.ascend is not a function`.

Cả 18 đều đến từ **pdf-lib**, không phải từ mã của Nabu — nhưng pdf-lib **là** đường lưu của Nabu,
nên đó vẫn là lỗi người dùng nhìn thấy. Đây cũng chính là lập luận cho việc **lưu incremental**
(RESEARCH §2.1): nối thêm một revision thì không phải ghi lại stream, và cả nhóm `output_warn` này
biến mất theo.

Lưới đã được **thử cho đỏ**: bỏ `tracemonkey.pdf` khỏi mốc rồi chạy lại → báo
`*** HỒI QUY so với mốc (1) *** tracemonkey.pdf: ok → output_warn`, thoát 1.

## Giới hạn đã biết

- Chỉ phủ **pdf-lib** — nửa ghi file của renderer. Nửa sidecar (`/compress`, `/split`, `/edit-text`,
  `/searchable`…) **chưa** có lưới tương đương; đó là bước tiếp theo đáng làm, cùng cách, bằng Python.
- Chỉ một loại sửa đổi (xoay trang). Thêm chú thích, ẩn trang, chèn chữ ký… chưa nằm trong vòng quét.
- Tài liệu mã hoá bị bỏ qua.
- qpdf chấm **cấu trúc**, không chấm **hình ảnh**: file có thể hợp lệ mà vẫn vẽ sai. Đối chiếu
  pixel là một lưới khác (xem RESEARCH §2.4, phần oracle render).
- **Lưới này báo THIẾU, không báo thừa.** Đo 2026-11-22: bản vá BI-120 làm đổi byte đầu ra của
  **13** file, nhưng qpdf chỉ từng kêu **9** — 4 file kia (`bug1727053`, `issue10572`,
  `issue19517`, `issue9243`) mất byte trong stream mà vẫn giải nén được, nên `--check` không
  thấy. Muốn bắt lớp này phải so **byte đầu ra** giữa hai phiên bản mã, không chỉ chấm cấu trúc.
