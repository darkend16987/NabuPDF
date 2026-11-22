"""Lõi tách PDF — **chỉ phụ thuộc PyMuPDF + stdlib**, không FastAPI, không `api`.

Cùng lý do với `src/pdf/compress.py` (BI-121): mỗi lần tách chạy trong một **tiến trình
con**, và tiến trình con chỉ cần đúng chừng này. `import api`/`import fastapi` là ~0,3 s
khởi động mà worker không dùng. Hệ quả cho người sửa file này: **đừng import fastapi, api,
`src.pdf.util`** (nó kéo fastapi) hay bất cứ thứ gì kéo theo chúng. Câu lỗi đẹp
(`nice_pdf_error`) và mọi phép kiểm yêu cầu (mở file, đếm trang, khoảng trang, trần 1000
file) nằm ở tiến trình CHA — worker nhận `pairs` đã được kiểm.

VÌ SAO TÁCH RA TIẾN TRÌNH CON (BI-138). `insert_pdf` giữ GIL suốt thời gian chạy và route
`/split` là `async def` chạy thẳng nó trên event loop, nên một lần tách chậm làm **cả
sidecar** đứng hình — mọi tab, `/health`, mọi route. Đo 2026-11-22: `bug1978317.pdf`
(1,5 MB, 1 trang) kẹt ở `insert_pdf` vượt 100 s mà không ra kết quả; trong lúc đó sidecar
không trả lời ai. Chỉ một tiến trình riêng mới giết được nó mà không giết sidecar.
"""

from __future__ import annotations

import io
import json
import sys
import zipfile

# Cờ dòng lệnh để `sidecar.py` nhận ra chế độ "tách một file rồi thoát". Nằm ở ĐÂY vì
# sidecar.py phải đọc được nó TRƯỚC khi import api (xem BI-121).
WORKER_FLAG = "--split-worker"

# Mã thoát của worker — hợp đồng với `api._split_via_worker_blocking`. stdout để TRỐNG.
EXIT_OK = 0
EXIT_INTERNAL = 1  # stderr mang nguyên văn lỗi (cha tự dịch sang tiếng Việt)

# Trần thời gian cho MỘT lần tách, tính ở tiến trình CHA. Xem BI-138 về vì sao con số này.
SPLIT_TIMEOUT_S = 10 * 60


class SplitTimeout(RuntimeError):
    """Tiến trình tách vượt `SPLIT_TIMEOUT_S` và đã bị giết.

    Lớp riêng chứ không phải `RuntimeError` trần: lớp trên phải phân biệt "hết giờ" (nói
    thẳng với người dùng, không thử lại) với "worker chết" (lỗi thường).
    """


def repair_orphan_field_kids(doc) -> list[int]:
    """Dựng lại `/Kids` cho những trường form bị thiếu nó. Trả về xref đã vá.

    VÌ SAO CẦN (BI-124). Theo chuẩn PDF, một trường form có widget con phải liệt kê
    chúng trong `/Kids`. `opt_demo.pdf` của corpus pdf.js vi phạm: widget 22 và 23 ghi
    `/Parent 21 0 R`, nhưng trường 21 (`veg`, nhóm radio) **không có `/Kids` nào cả** —
    trong khi hai trường anh em của nó, 5 (`fruit`) và 9 (`shared`), thì có.

    `insert_pdf` của PyMuPDF đi từ `/Fields`, theo `/Parent` lên cha, rồi tìm widget
    trong `/Kids` của cha: `idx = parent["old_kids"].index(xref)` → `ValueError: 22 is
    not in list`, và CẢ thao tác tách hỏng. qpdf vẫn chấm file gốc là **sạch** — đây là
    chỗ PyMuPDF khắt khe hơn trọng tài.

    Phép vá chỉ dựng lại đúng cái chuẩn đòi, từ dữ liệu đã có trong chính tài liệu:
    widget nào trỏ `/Parent` về trường nào thì là con của trường ấy. Đo trên
    `opt_demo.pdf`: chỉ trường 21 bị chạm (5 và 9 đã đúng nên để nguyên), sau đó
    `insert_pdf` chạy và **giữ đủ cả 9 widget**, kể cả nhóm `veg`; qpdf chấm đầu ra là
    sạch. So với cách rẻ hơn là `insert_pdf(..., widgets=False)`: cách đó cũng chạy,
    nhưng ra file **không còn form** — mất trắng 9 trường.

    CHỈ GỌI SAU KHI `insert_pdf` ĐÃ HỎNG. Tài liệu lành không bao giờ đi qua đây, nên
    đường tách file bình thường không chịu thêm một phép đọc xref nào.

    (Chuyển NGUYÊN VĂN từ `api.py` ở BI-138; `api._repair_orphan_field_kids` là bí danh.)
    """
    con = {}
    for x in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(x, "Subtype")[1] != "/Widget":
                continue
            kind, parent = doc.xref_get_key(x, "Parent")
            if kind != "xref":
                continue
            con.setdefault(int(parent.split()[0]), []).append(x)
        except Exception:  # xref lạ/hỏng: bỏ qua, đây là đường chữa cháy
            continue

    da_va = []
    for cha, kids in con.items():
        try:
            kind, val = doc.xref_get_key(cha, "Kids")
            # Đã đủ con thì KHÔNG đụng vào: ta chỉ thêm thứ còn thiếu, không viết lại
            # cấu trúc form của người ta.
            if kind == "array" and all(f"{k} 0 R" in val for k in kids):
                continue
            doc.xref_set_key(cha, "Kids", "[" + " ".join(f"{k} 0 R" for k in kids) + "]")
            da_va.append(cha)
        except Exception:
            continue
    return da_va


def split_to_zip(pdf_bytes: bytes, pairs: list[tuple[int, int]]) -> tuple[bytes, int]:
    """Tách `pdf_bytes` theo `pairs` (0-based, đóng hai đầu) thành một .zip. Trả `(zip, số_file)`.

    `pairs` đã được cha kiểm (không rỗng, trong khoảng, ≤ 1000) — hàm này KHÔNG kiểm lại.
    Ném nguyên lỗi của PyMuPDF; cha là bên dịch nó sang câu cho người dùng.

    Thuần additive: chỉ đọc nguồn, ghi PDF mới, không bao giờ sửa đầu vào. Nội dung là
    khối cũ của route `/split` (BI-124), chỉ bọc thành hàm để worker và nhánh tại chỗ
    dùng chung — hai đường không thể lệch nhau về việc "tách" làm gì.
    """
    import fitz

    def _tach_vao(src, zf) -> int:
        n_file = 0
        for start, end in pairs:
            part = fitz.open()
            try:
                part.insert_pdf(src, from_page=start, to_page=end)
                data = part.tobytes()
            finally:
                part.close()
            n_file += 1
            label = f"{start + 1}" if start == end else f"{start + 1}-{end + 1}"
            zf.writestr(f"{src_name}_{n_file:03d}_p{label}.pdf", data)
        return n_file

    src_name = "part"
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    buf = io.BytesIO()
    count = 0
    try:
        try:
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                count = _tach_vao(doc, zf)
        except ValueError as e:
            # `insert_pdf` vấp một trường form thiếu `/Kids` (BI-124). Vá rồi thử LẠI
            # MỘT lần — và chỉ khi phép vá thật sự chạm vào cái gì, nếu không thì lỗi
            # này là chuyện khác và cứ để nó nổi lên như cũ.
            #
            # MỞ LẠI TỪ BYTE GỐC, đừng dùng lại `doc`. `insert_pdf` hỏng giữa chừng để
            # lại sổ sách nội bộ đã bị sửa dở: đo được, thử lại trên chính `doc` ra file
            # 1.619 byte **không còn widget nào** — đúng bằng đường `widgets=False`, tức
            # mất trắng cả form mà vẫn báo thành công. Mở lại thì ra 5.663 byte, đủ 9
            # widget. Cùng một bài học với BI-122.
            doc.close()
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            da_va = repair_orphan_field_kids(doc)
            if not da_va:
                raise
            _log_va(da_va, e)
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                count = _tach_vao(doc, zf)
    finally:
        doc.close()
    return buf.getvalue(), count


def _log_va(da_va, e) -> None:
    # `logging` nạp lười: worker không cần nó trên đường thường.
    import logging

    logging.getLogger(__name__).warning("split: va /Kids cho truong form %s roi thu lai (%s)", da_va, e)


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
    """`--split-worker <in.pdf> <out.zip> <pairs.json>` — tách một file rồi thoát.

    `pairs.json` là danh sách `[start, end]` (0-based) đã được cha kiểm. Số file = số mục
    trong zip, nên không cần kênh riêng để trả số đếm. Mã thoát là hợp đồng với
    `api._split_via_worker_blocking` (`EXIT_*`); lỗi mang nguyên văn của thư viện trong
    stderr. stdout cố ý để TRỐNG.
    """
    if len(argv) != 3:
        _err("Thiếu tham số cho --split-worker (cần: in.pdf, out.zip, pairs.json)")
        return EXIT_INTERNAL
    src, dst, pairs_path = argv
    try:
        with open(src, "rb") as f:
            data = f.read()
        with open(pairs_path, encoding="utf-8") as f:
            pairs = [(int(a), int(b)) for a, b in json.load(f)]
        out, _ = split_to_zip(data, pairs)
        with open(dst, "wb") as f:
            f.write(out)
        return EXIT_OK
    except Exception as e:  # noqa: BLE001 — cha biến nó thành câu lỗi cho người dùng, không phải 500
        _err(str(e) or type(e).__name__)
        return EXIT_INTERNAL
