"""Desktop sidecar entry point: runs the FastAPI OCR server on a given port.

Reuses the existing FastAPI `app` from api.py — no OCR logic is duplicated here.

Dev:    python sidecar.py --port 8000
Frozen: sidecar.exe --port 8000   (built via PyInstaller, see sidecar.spec)

It has a SECOND mode, used by the server itself:

    sidecar.exe --compress-worker <in.pdf> <out.pdf> <preset>

and a THIRD, `sidecar.exe --incremental-worker <original.pdf> <edited.pdf> <out.pdf>`
(BI-129: append one revision to a signed file; contract in src/pdf/incremental.py), which
likewise does one job and exits, and a FOURTH, `sidecar.exe --split-worker <in.pdf> <out.zip> <pairs.json>` (BI-138: split one
file into many; contract in src/pdf/split.py) and a FIFTH, `sidecar.exe --pagenum-worker <in.pdf> <out.pdf> <plan.json>` (BI-140:
stamp page numbers; contract in src/pdf/pagenum.py).

The compress worker compresses one file and exits. See the block above `_COMPRESS_WORKER_FLAG` in
api.py for why compression has to leave the server process at all; the short version
is that PyMuPDF's `rewrite_images` holds the GIL for its whole run, so a thread frees
nothing and only a separate process keeps the sidecar answering. Re-launching THIS
program means there is no second binary to build, sign or ship.
"""

from __future__ import annotations

import sys

# CHU Y THU TU IMPORT (BI-121). O day CHI duoc import nhung gi tien trinh worker can.
# `api`, `uvicorn` va `argparse` duoc import BEN TRONG main(), sau khi co worker da
# duoc xu ly, vi moi lan nen deu chay qua tien trinh con nay: do duoc, worker phai
# `import api` ton 0,378 s o ban dev, trong khi lam viec that chi ton 0,29 s. Dung dua
# `from api import ...` tro lai cap module nay. (Con so "3,72 s o ban dong goi" tung
# ghi o day la do lan chay DAU khi anh exe chua vao cache; xem khoi so do trong api.py.)
#
# Co duoc lay tu module la (chi can PyMuPDF), khong re-declare: mot ban sao thu hai
# o day se de hai noi lech nhau - co ngung duoc nhan ra va cha chi thay "exited with
# code 2".
from src.pdf.compress import WORKER_FLAG as COMPRESS_WORKER_FLAG

# Worker thứ hai (BI-129): ghi nối một revision lên file đã ký. Cùng nguyên tắc: cờ VÀ hàm chạy nằm ở module lá
# `src/pdf/incremental.py` (chỉ nạp collections/logging/os/shutil/tempfile — `fitz` nạp lười, `import api` không có),
# nên thêm worker này không làm chậm worker nén một mili-giây nào.
from src.pdf.incremental import WORKER_FLAG as INCREMENTAL_WORKER_FLAG
from src.pdf.incremental import worker_main as _run_incremental_worker

# Worker thứ ba (BI-138): tách một file ra nhiều file. Cùng nguyên tắc — cờ VÀ hàm chạy nằm ở module lá `src/pdf/split.py`
# (chỉ nạp stdlib; `fitz` nạp lười trong hàm), nên không làm chậm hai worker kia.
from src.pdf.split import WORKER_FLAG as SPLIT_WORKER_FLAG
from src.pdf.split import worker_main as _run_split_worker

# Worker thứ tư (BI-140): đánh số trang. Cùng nguyên tắc — cờ VÀ hàm chạy nằm ở module lá `src/pdf/pagenum.py` (chỉ nạp
# json/sys; `fitz` nạp lười trong hàm).
from src.pdf.pagenum import WORKER_FLAG as PAGENUM_WORKER_FLAG
from src.pdf.pagenum import worker_main as _run_pagenum_worker


def _err(msg: str) -> None:
    """Write `msg` to stderr as UTF-8, whatever the child's locale is.

    Not cosmetic. Every message this worker can emit is Vietnamese, and a plain
    `sys.stderr.write` encodes with the console codepage (cp1258/cp1252 on Windows)
    while the parent decodes UTF-8 — so "preset phải là screen|ebook|printer|lossless"
    reached the user as mojibake. Writing bytes pins both ends to one encoding.
    """
    data = msg.encode("utf-8", "replace")
    buf = getattr(sys.stderr, "buffer", None)
    if buf is not None:
        buf.write(data)
        buf.flush()
    else:  # stderr replaced by something without a binary layer
        sys.stderr.write(msg)
        sys.stderr.flush()


def _run_compress_worker(argv: list[str]) -> int:
    """`--compress-worker <src> <dst> <preset>` — compress one file, then exit.

    Exit codes are the contract with api.py `_compress_via_worker_blocking`:
      0 = done, `dst` holds the PDF
      4 = done, `dst` holds the PDF, NHUNG buoc nen lai anh da gay (BI-122) — cha
          bao len cho nguoi dung biet file chi duoc deflate + gom rac
      3 = the request was wrong (bad preset, unopenable PDF, too many pages); stderr
          carries the Vietnamese message the user should see
      1 = anything else; stderr carries the detail for the log
    stdout is deliberately left empty so nothing can be mistaken for data.
    """
    if len(argv) < 3:
        _err("Thiếu tham số cho --compress-worker")
        return 1
    src, dst, preset = argv[0], argv[1], argv[2]
    try:
        from src.pdf.compress import CompressRequestError, compress_pdf_bytes_ex

        with open(src, "rb") as f:
            data = f.read()
        try:
            res = compress_pdf_bytes_ex(data, preset)
        except CompressRequestError as e:
            _err(str(e))
            return 3
        with open(dst, "wb") as f:
            f.write(res.data)
        return 4 if res.images_failed else 0
    except Exception as e:  # noqa: BLE001 — the parent turns this into a user-visible error
        _err(f"{type(e).__name__}: {e}")
        return 1


def main() -> None:
    # Checked before argparse: the worker flag is not a declared server option, so
    # argparse would exit(2) on it before this branch ever ran.
    if len(sys.argv) > 1 and sys.argv[1] == COMPRESS_WORKER_FLAG:
        raise SystemExit(_run_compress_worker(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == INCREMENTAL_WORKER_FLAG:
        raise SystemExit(_run_incremental_worker(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == SPLIT_WORKER_FLAG:
        raise SystemExit(_run_split_worker(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == PAGENUM_WORKER_FLAG:
        raise SystemExit(_run_pagenum_worker(sys.argv[2:]))

    # Nap muon: chi tien trinh SERVER moi can nhung thu nay (xem khoi import o dau file).
    import argparse

    import uvicorn

    from api import app  # the existing FastAPI app (OCR endpoints, lifespan, CORS)

    parser = argparse.ArgumentParser(description="Nabu PDF desktop sidecar")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (local-only)")
    args = parser.parse_args()

    # Pass the app object (not an import string) so it works inside a frozen binary.
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
