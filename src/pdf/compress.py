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


class CompressRequestError(ValueError):
    """Yêu cầu sai (preset lạ, file không mở được, quá nhiều trang).

    Lớp trên dịch thành HTTP 400 và `str(e)` chính là câu người dùng đọc, nên đừng
    đổi lời văn mà không sửa luôn lưới đang ghim chúng.
    """


def compress_pdf_bytes(pdf_bytes: bytes, preset: str) -> bytes:
    """Shrink `pdf_bytes` per `preset`; returns the ORIGINAL bytes if that is smaller.

    Dùng chung bởi /compress (base64 JSON), /compress-bin (nhị phân) và tiến trình
    worker, nên ba đường không thể lệch nhau về việc "nén" thật sự làm gì.

    Ném `CompressRequestError` cho lỗi của người gọi (preset sai, PDF không mở được,
    quá nhiều trang); mọi lỗi khác để nguyên cho lớp trên báo cáo.
    """
    import fitz  # PyMuPDF

    if preset != "lossless" and preset not in PRESETS:
        raise CompressRequestError("preset phải là screen|ebook|printer|lossless")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise CompressRequestError(f"Không mở được PDF: {e}")

    if doc.page_count > MAX_PAGES:
        doc.close()
        raise CompressRequestError(f"PDF quá nhiều trang (tối đa {MAX_PAGES}).")

    try:
        if preset != "lossless":
            p = PRESETS[preset]
            doc.rewrite_images(
                dpi_threshold=p["dpi_threshold"],
                dpi_target=p["dpi_target"],
                quality=p["quality"],
                lossy=True,
                lossless=True,
            )
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
    return pdf_bytes if len(out_bytes) >= len(pdf_bytes) else out_bytes
