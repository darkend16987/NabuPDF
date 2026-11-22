"""Lõi đánh số trang — **chỉ phụ thuộc PyMuPDF + stdlib**, không FastAPI, không `api`, không `src.pdf.util`.

Cùng lý do và cùng khuôn với `src/pdf/split.py` (BI-138) và `src/pdf/compress.py` (BI-121): mỗi lần
đánh số chạy trong một **tiến trình con**, và tiến trình con chỉ cần đúng chừng này. `src.pdf.util`
kéo fastapi (~0,27 s) nên bị cấm ở đây — thay vì import `_fmt_page_label` / `_hex_rgb01` /
`WRITE_GARBAGE` (nhân đôi mã hay đụng util), **cha tính sẵn** mọi thứ phụ thuộc chúng (nhãn từng
trang, màu RGB, mức garbage) rồi gửi xuống dưới dạng dữ liệu thuần.

VÌ SAO TÁCH RA TIẾN TRÌNH CON (BI-140). Route `/add-page-numbers` là `async def` chạy `insert_text`
thẳng trên event loop; PyMuPDF giữ GIL nên một lần chậm làm **đứng cả sidecar**. Đo 2026-11-22:
`bomb_giant.pdf` (123 KB, 1 trang) treo ngay trong `insert_text` của TRANG ĐẦU (sau cảnh báo
"syntax error in content stream") và không xong sau 60 s; trong lúc đó sidecar không trả lời ai.
(`bug1978317.pdf`, file làm `/split` kẹt, ở đây chỉ mất 1,8 s — hai thao tác, hai file khác nhau.)
"""

from __future__ import annotations

import json
import sys

# Cờ dòng lệnh để `sidecar.py` nhận ra chế độ "đánh số một file rồi thoát". Nằm ở ĐÂY vì sidecar.py
# phải đọc được nó TRƯỚC khi import api (xem BI-121).
WORKER_FLAG = "--pagenum-worker"

# Mã thoát của worker — hợp đồng với `api._pagenum_via_worker_blocking`. stdout để TRỐNG.
EXIT_OK = 0
EXIT_INTERNAL = 1  # stderr mang nguyên văn lỗi (cha tự dịch sang tiếng Việt)

# Trần thời gian cho MỘT lần đánh số, tính ở tiến trình CHA. Xem BI-140 về vì sao con số này.
PAGENUM_TIMEOUT_S = 10 * 60


class PageNumberTimeout(RuntimeError):
    """Tiến trình đánh số vượt `PAGENUM_TIMEOUT_S` và đã bị giết.

    Lớp riêng chứ không phải `RuntimeError` trần: lớp trên phải phân biệt "hết giờ" (nói thẳng với
    người dùng, không thử lại) với "worker chết" (lỗi thường).
    """


def stamp_page_numbers(pdf_bytes: bytes, plan: dict) -> tuple[bytes, int]:
    """Đóng dấu số trang lên `pdf_bytes` theo `plan`. Trả `(pdf_mới, số_trang)`.

    `plan` do cha dựng và ĐÃ được kiểm/kẹp: `skip` (số trang đầu bỏ qua), `labels` (nhãn của các trang
    còn lại, theo thứ tự), `fs`, `margin`, `col` (r,g,b trong 0..1), `vpos` (top|bottom), `hpos`
    (left|center|right), `garbage`. Hàm này KHÔNG kiểm lại giá trị — chỉ kiểm rằng số nhãn khớp số trang,
    vì lệch nghĩa là cha và con đang nhìn hai tài liệu khác nhau.

    Nội dung là khối cũ của route `/add-page-numbers`, chuyển NGUYÊN VĂN phần dựng toạ độ (BI-45/BI-65:
    đặt trong khung HIỂN THỊ rồi ánh xạ ngược về không gian trang chưa xoay và xoay glyph theo `/Rotate`,
    nên số nằm đúng góc nhìn thấy trên trang xoay). Hai đường (worker và nhánh tại chỗ) dùng chung hàm
    này nên không thể lệch nhau.
    """
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        n_pages = doc.page_count
        skip = plan["skip"]
        labels = plan["labels"]
        if len(labels) != max(0, n_pages - skip):
            raise ValueError(f"số nhãn ({len(labels)}) không khớp số trang cần đánh ({max(0, n_pages - skip)})")
        fs = plan["fs"]
        margin = plan["margin"]
        col = tuple(plan["col"])
        vpos, hpos = plan["vpos"], plan["hpos"]
        font = fitz.Font("helv")  # Base-14, ASCII labels — nothing to embed

        for pno in range(n_pages):
            if pno < skip:
                continue
            page = doc[pno]
            text = labels[pno - skip]
            tw = font.text_length(text, fontsize=fs)
            # Place in the *displayed* rect (rotation-aware), then map the baseline
            # point back to unrotated page space and rotate the glyphs by the page's
            # rotation so they read upright after the viewer re-applies it. This keeps
            # numbers at the right visible corner on /Rotate scans (90/180/270).
            disp = page.rect  # displayed dimensions, origin top-left, y grows down
            if hpos == "left":
                dx = disp.x0 + margin
            elif hpos == "right":
                dx = disp.x1 - margin - tw
            else:
                dx = disp.x0 + (disp.width - tw) / 2
            dy = disp.y0 + margin + fs if vpos == "top" else disp.y1 - margin
            pt = fitz.Point(dx, dy) * page.derotation_matrix
            page.insert_text(pt, text, fontsize=fs, fontname="helv", color=col, rotate=page.rotation)

        out_bytes = doc.tobytes(deflate=True, garbage=plan["garbage"])
        return out_bytes, doc.page_count
    finally:
        doc.close()


def _err(msg: str) -> None:
    """Ghi `msg` ra stderr bằng UTF-8, bất kể locale của tiến trình con (xem `sidecar._err`)."""
    data = msg.encode("utf-8", "replace")
    buf = getattr(sys.stderr, "buffer", None)
    if buf is not None:
        buf.write(data)
        buf.flush()
    else:
        sys.stderr.write(msg)
        sys.stderr.flush()


def worker_main(argv: list[str]) -> int:
    """`--pagenum-worker <in.pdf> <out.pdf> <plan.json>` — đánh số một file rồi thoát.

    Số trang của kết quả không cần kênh riêng: cha đã biết nó (đánh số không đổi số trang). Mã thoát là
    hợp đồng với `api._pagenum_via_worker_blocking` (`EXIT_*`); lỗi mang nguyên văn của thư viện trong
    stderr. stdout cố ý để TRỐNG.
    """
    if len(argv) != 3:
        _err("Thiếu tham số cho --pagenum-worker (cần: in.pdf, out.pdf, plan.json)")
        return EXIT_INTERNAL
    src, dst, plan_path = argv
    try:
        with open(src, "rb") as f:
            data = f.read()
        with open(plan_path, encoding="utf-8") as f:
            plan = json.load(f)
        out, _ = stamp_page_numbers(data, plan)
        with open(dst, "wb") as f:
            f.write(out)
        return EXIT_OK
    except Exception as e:  # noqa: BLE001 — cha biến nó thành câu lỗi cho người dùng, không phải 500
        _err(str(e) or type(e).__name__)
        return EXIT_INTERNAL
