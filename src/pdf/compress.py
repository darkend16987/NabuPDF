"""Lõi nén PDF — **chỉ phụ thuộc PyMuPDF**, không FastAPI, không `api`.

Vì sao là module lá riêng chứ không nằm trong `api.py`: mỗi lần nén đều chạy trong
một **tiến trình con** (xem khối `_COMPRESS_WORKER_FLAG` trong `api.py` và BI-121),
và tiến trình con chỉ cần đúng chừng này. Đo được (2026-11-22, bản dev):

    import fitz      0,082 s
    import fastapi   0,267 s
    import api       0,378 s

Nghĩa là nếu worker phải `import api` thì ~80 % thời gian khởi động của nó là nạp
những thứ nó không dùng. Trong bản đóng gói PyInstaller tỉ lệ còn tệ hơn vì mỗi
module là một lần đọc đĩa.

Hệ quả cho người sửa file này: **đừng import fastapi, api, hay bất cứ thứ gì kéo
theo chúng.** Lỗi "do yêu cầu sai" được báo bằng `CompressRequestError` để lớp trên
dịch thành HTTP 400 — `test_pdf_ops.py` ghim đúng các thông điệp đó.
"""

from __future__ import annotations

import collections
import logging

logger = logging.getLogger(__name__)

# Image downsample/recompress targets per preset (PyMuPDF rewrite_images).
# "lossless" skips image rewriting (only deflate + garbage-collect + font subset).
PRESETS = {
    "screen": dict(dpi_threshold=110, dpi_target=96, quality=45),
    "ebook": dict(dpi_threshold=170, dpi_target=150, quality=65),
    "printer": dict(dpi_threshold=320, dpi_target=300, quality=85),
}

# Page ceiling for compression. Purpose is to bound RUNTIME (rewrite_images walks
# every image on every page), not memory — so it is deliberately generous: a 200 MB
# scan is routinely 600–1500 pages, and the old 500 turned "nén file lớn" into a
# refusal for exactly the documents worth compressing.
MAX_PAGES = 3000


# Trần thời gian cho MỘT lần nén, tính ở tiến trình CHA (BI-123).
#
# Việc nó làm là chặn "mãi mãi", KHÔNG phải bắt lỗi chậm. Đo được trên corpus:
# `bomb_giant.pdf` (bom giải nén, 123 KB, 1 trang) vượt 100 s ở CẢ `ebook` lẫn
# `lossless` và không có dấu hiệu dừng — hôm nay người dùng bấm Nén rồi chỉ còn cách
# tắt app, vì lớp phủ không bao giờ tắt và không có nút Hủy.
#
# Vì sao 30 phút chứ không phải một con số nhỏ gọn hơn: trần công việc hợp lệ là
# MAX_PAGES = 3000 trang × ~0,377 s/trang ≈ 19 phút (số đo ở khối worker trong
# api.py). Một hạn giờ chặt hơn sẽ GIẾT một lần nén thật. Và không scale được theo
# dung lượng: `bug1978317.pdf` chỉ 1,5 MB / 1 trang mà mất 76–92 s hợp lệ, trong khi
# `bomb_giant.pdf` 123 KB thì không bao giờ xong — dung lượng không nói lên gì.
COMPRESS_TIMEOUT_S = 30 * 60


class CompressTimeout(RuntimeError):
    """Tiến trình nén vượt `COMPRESS_TIMEOUT_S` và đã bị giết.

    Lớp riêng chứ không phải `RuntimeError` trần: `_compress_anywhere` thử lại ở
    `lossless` khi worker CHẾT, nhưng hết giờ thì thử lại là chờ thêm 30 phút nữa —
    đo được `bomb_giant.pdf` vượt hạn ở cả hai preset.
    """


class CompressCancelled(RuntimeError):
    """Người dùng bấm **Hủy**; tiến trình con đã bị giết (BI-126).

    Lớp riêng vì CÙNG MỘT LÝ DO với `CompressTimeout`, và đây là chỗ nguy hiểm hơn
    cả: `RuntimeError` trần nghĩa là "worker chết ⇒ thử lại ở `lossless`" (BI-122).
    Để lọt vào nhánh đó thì bấm Hủy xong máy lại **chạy tiếp một lần nén nữa** —
    đúng thứ người dùng vừa bảo đừng làm.

    Và nó KHÔNG phải lỗi: lớp trên trả về `cancelled` chứ không phải `error`, để
    renderer không bật toast đỏ cho một việc người dùng tự chọn.
    """


# Cờ dòng lệnh mà sidecar.py nhận ra để chạy ở chế độ "nén một file rồi thoát".
# Nằm ở ĐÂY chứ không ở api.py vì sidecar.py phải đọc được nó TRƯỚC khi import api —
# đó là cả mục đích của việc tách module này ra (BI-121).
WORKER_FLAG = "--compress-worker"


# Kết quả nén: byte ra, kèm một lá cờ nói phần nén lại ảnh có chạy được không.
#
# `images_failed` CHỈ đúng khi preset có yêu cầu nén lại ảnh mà `rewrite_images` ném
# lỗi — tức người dùng chọn "ebook" nhưng nhận về một file chỉ được deflate + gom rác.
# Preset "lossless" vốn không nén ảnh nên nó luôn là False: lá cờ này nói "không làm
# được việc đã hứa", không phải "đã bỏ qua ảnh".
#
# `collections.namedtuple` chứ không phải `typing.NamedTuple`: đo được, `import typing`
# tốn 0,0156 s và `logging` KHÔNG kéo nó theo, trong khi `collections` thì logging đã
# nạp sẵn (thêm 0,0000 s) và dựng lớp tốn 0,00007 s. 15 ms trên ~300 ms chi phí của mỗi
# tiến trình con là 6% — đúng loại mỡ mà commit trước đã cất công cắt (BI-121).
CompressResult = collections.namedtuple("CompressResult", "data images_failed", defaults=(False,))


class CompressRequestError(ValueError):
    """Yêu cầu sai (preset lạ, file không mở được, quá nhiều trang).

    Lớp trên dịch thành HTTP 400 và `str(e)` chính là câu người dùng đọc, nên đừng
    đổi lời văn mà không sửa luôn lưới đang ghim chúng.
    """


def compress_pdf_bytes(pdf_bytes: bytes, preset: str) -> bytes:
    """Chỉ lấy byte kết quả — hợp đồng cũ, nhiều chỗ gọi và nhiều lưới đang ghim.

    Cần biết ảnh có nén lại được hay không thì gọi `compress_pdf_bytes_ex`.
    """
    return compress_pdf_bytes_ex(pdf_bytes, preset).data


def compress_pdf_bytes_ex(pdf_bytes: bytes, preset: str) -> CompressResult:
    """Shrink `pdf_bytes` per `preset`; returns the ORIGINAL bytes if that is smaller.

    Dùng chung bởi /compress (base64 JSON), /compress-bin (nhị phân) và tiến trình
    worker, nên ba đường không thể lệch nhau về việc "nén" thật sự làm gì.

    Ném `CompressRequestError` cho lỗi của người gọi (preset sai, PDF không mở được,
    quá nhiều trang); mọi lỗi khác để nguyên cho lớp trên báo cáo.

    NÉN LẠI ẢNH LÀ VIỆC "CỐ GẮNG", KHÔNG PHẢI ĐIỀU KIỆN SỐNG CÒN (BI-122). Lưới quét
    corpus bắt được `rewrite_images()` ném lỗi trên 6 file thật — hai kiểu, cả hai
    đều từ sâu trong MuPDF chứ không phải từ mã của ta:

        FzErrorFormat   code=7: Bad PatternType                     (2 file)
        FzErrorArgument code=4: pixmap may not have alpha to save as JPEG (4 file)

    Trước đây lỗi đó nổi thẳng lên và cả thao tác nén hỏng — người dùng không nhận
    được gì. Nhưng phần lớn phần thắng của việc nén nằm ở `tobytes(deflate, garbage=4,
    clean)`, không cần ảnh: đo được trên đúng 6 file ấy, bỏ bước ảnh vẫn ra file hợp
    lệ (qpdf sạch 5/6, file thứ sáu đã cảnh báo sẵn từ bản gốc). Nên khi bước ảnh gãy,
    ta **bỏ tài liệu đã bị sửa dở, mở lại từ byte gốc** rồi lưu — và báo lên bằng
    `images_failed` để lớp trên nói thật với người dùng.

    Vì sao mở lại chứ không lưu tiếp tài liệu đang có: `rewrite_images` ném lỗi ở
    giữa chừng thì tài liệu có thể đã thay một phần ảnh. Đo trên 6 file này hai cách
    cho ra file dài bằng nhau, nhưng đó là 6 file — không phải một lời hứa. Mở lại
    tốn thêm một lần `fitz.open` trên một nhánh hiếm, đổi lấy việc không bao giờ phải
    tự hỏi "tài liệu này đang ở trạng thái nào".
    """
    import fitz  # PyMuPDF

    if preset != "lossless" and preset not in PRESETS:
        raise CompressRequestError("preset phải là screen|ebook|printer|lossless")

    def _open():
        try:
            return fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as e:
            raise CompressRequestError(f"Không mở được PDF: {e}")

    doc = _open()
    if doc.page_count > MAX_PAGES:
        doc.close()
        raise CompressRequestError(f"PDF quá nhiều trang (tối đa {MAX_PAGES}).")

    images_failed = False
    if preset != "lossless":
        p = PRESETS[preset]
        try:
            doc.rewrite_images(
                dpi_threshold=p["dpi_threshold"],
                dpi_target=p["dpi_target"],
                quality=p["quality"],
                lossy=True,
                lossless=True,
            )
        except Exception as e:  # MuPDF từ chối một ảnh -> nén phần còn lại, đừng bỏ cuộc
            logger.warning("rewrite_images failed (%s) - saving without image rewriting", e)
            images_failed = True
            doc.close()
            doc = _open()

    try:
        try:
            doc.subset_fonts()
        except Exception as e:  # font subsetting is best-effort
            logger.debug("subset_fonts skipped: %s", e)
        out_bytes = doc.tobytes(
            deflate=True, garbage=4, clean=True, deflate_images=True, deflate_fonts=True
        )
    finally:
        doc.close()

    # If compression somehow grew the file, hand back the original instead.
    smaller = pdf_bytes if len(out_bytes) >= len(pdf_bytes) else out_bytes
    return CompressResult(smaller, images_failed)
