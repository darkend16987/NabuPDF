"""Quét MỘT file PDF qua các endpoint GHI FILE của sidecar — tiến trình con của
``corpus_sweep_sidecar.py``.

    .venv\\Scripts\\python tools/corpus_sweep_sidecar_one.py <file.pdf>

Mỗi file một tiến trình riêng là CỐ Ý: PyMuPDF là thư viện C, file méo có thể làm
nó **chết cả tiến trình** (không phải ném exception). Tiến trình cha cần giết được
nó và quy đúng tội cho đúng file — xem docs/CORPUS-SWEEP.md.

In ra stdout ĐÚNG MỘT dòng JSON (ASCII, vì console Windows là cp1252).

Bốn nhóm thao tác, tất cả chạy trên CÙNG một file nguồn, đều là đường mà app thật
gọi qua HTTP (ở đây gọi thẳng hàm async nên không cần dựng server):

  1. ``/add-page-numbers`` — chạm MỌI trang, bài kiểm tra rẻ nhất cho đường ghi;
  2. ``/split``            — sao chép trang sang tài liệu mới, kiểm từng file con
                             trong .zip và tổng số trang phải bằng bản gốc;
  3. ``/compress``         — giải/nén lại ảnh nhúng + gom rác (preset ebook);
  4. ``/encrypt`` → ``/decrypt`` — vòng tròn mã hoá, chấm trên bản đã giải mã.

Trọng tài là ``qpdf --check``, GIỐNG hệt lưới JS: luôn chấm bản GỐC trước, vì
corpus pdf.js cố tình chứa file hỏng — không có bước đó thì mọi lỗi đều đổ oan
cho sidecar.
"""

import base64
import io
import json
import math
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

QPDF = os.environ.get("NABU_QPDF", "")
ENC_PASSWORD = "nabu-sweep"


# --------------------------------------------------------------------------- #
# trọng tài
# --------------------------------------------------------------------------- #
def qpdf_check(data: bytes, tmp: Path, name: str) -> dict:
    """qpdf: 0 = sach, 3 = chi canh bao, 2 = loi. Ma khac (crash) coi nhu loi."""
    if not QPDF:
        return {"level": "skipped", "text": ""}
    p = tmp / name
    p.write_bytes(data)
    try:
        out = subprocess.run(
            [QPDF, "--check", str(p)],
            capture_output=True, text=True, timeout=60,
        )
        status, text = out.returncode, (out.stdout or "") + (out.stderr or "")
    except subprocess.TimeoutExpired:
        return {"level": "error", "text": "qpdf timeout"}
    level = "ok" if status == 0 else ("warn" if status == 3 else "error")
    # qpdf noi ve ma hoa bang "R = <revision>" + "encryption method:", KHONG phai
    # "File is encrypted" (file khong ma hoa thi in "File is not encrypted").
    enc = ("encryption method:" in text) or any(
        ln.strip().startswith("R = ") for ln in text.splitlines()
    )
    return {"level": level, "text": first_problem(text), "encrypted": enc}


def first_problem(out: str) -> str:
    for ln in out.splitlines():
        t = ln.strip()
        if not t:
            continue
        if "no syntax or stream encoding errors found" in t:
            continue
        if t.startswith(("WARNING", "ERROR", "qpdf:")):
            return t[:300]
    return ""


def page_count(data: bytes):
    """So trang theo PyMuPDF; None neu khong mo duoc."""
    try:
        import fitz

        with fitz.open(stream=data, filetype="pdf") as doc:
            return doc.page_count
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# chạy một endpoint
# --------------------------------------------------------------------------- #
def call(coro):
    import asyncio

    return asyncio.run(coro)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def run_ops(api, src: bytes, pages, tmp: Path) -> dict:
    """Tra ve {ten_thao_tac: {level, text, pages, ...}} cho tung thao tac."""
    ops = {}

    # --- 1. danh so trang: cham MOI trang ---
    try:
        r = call(api.add_page_numbers(api.PageNumberRequest(pdf_b64=b64(src))))
        if not r.success:
            ops["pagenum"] = {"level": "op_fail", "text": str(r.error)[:200]}
        else:
            out = base64.b64decode(r.data_b64)
            ops["pagenum"] = qpdf_check(out, tmp, "pagenum.pdf")
            ops["pagenum"]["pages"] = page_count(out)
    except Exception as e:
        ops["pagenum"] = {"level": "op_fail", "text": f"{type(e).__name__}: {e}"[:200]}

    # --- 2. tach file ---
    # size chon sao cho ra toi da 4 file: file 500 trang ma size=1 se sinh 500 PDF
    # va mot .zip khong lien quan gi den thuc te nguoi dung.
    size = 1 if (pages or 1) <= 8 else max(1, math.ceil((pages or 1) / 4))
    try:
        r = call(api.split_pdf(api.SplitRequest(pdf_b64=b64(src), mode="every", size=size)))
        if not r.success:
            ops["split"] = {"level": "op_fail", "text": str(r.error)[:200]}
        else:
            zdata = base64.b64decode(r.data_b64)
            worst, total, note = "ok", 0, ""
            with zipfile.ZipFile(io.BytesIO(zdata)) as z:
                names = [n for n in z.namelist() if n.lower().endswith(".pdf")]
                for i, n in enumerate(names):
                    part = z.read(n)
                    c = qpdf_check(part, tmp, f"split{i}.pdf")
                    pc = page_count(part)
                    total += pc or 0
                    if c["level"] == "error":
                        worst, note = "error", c["text"]
                    elif c["level"] == "warn" and worst == "ok":
                        worst, note = "warn", c["text"]
            ops["split"] = {"level": worst, "text": note, "pages": total, "files": len(names), "size": size}
    except Exception as e:
        ops["split"] = {"level": "op_fail", "text": f"{type(e).__name__}: {e}"[:200]}

    # --- 3. nen ---
    try:
        r = call(api.compress(api.CompressRequest(pdf_b64=b64(src), preset="ebook")))
        if not r.success:
            ops["compress"] = {"level": "op_fail", "text": str(r.error)[:200]}
        else:
            out = base64.b64decode(r.data_b64)
            ops["compress"] = qpdf_check(out, tmp, "compress.pdf")
            ops["compress"]["pages"] = page_count(out)
            ops["compress"]["ratio"] = round(len(out) / len(src), 3) if src else None
    except Exception as e:
        ops["compress"] = {"level": "op_fail", "text": f"{type(e).__name__}: {e}"[:200]}

    # --- 4. ma hoa roi giai ma lai ---
    try:
        r = call(api.encrypt(api.EncryptRequest(pdf_b64=b64(src), user_password=ENC_PASSWORD)))
        if not r.success:
            ops["cryptroundtrip"] = {"level": "op_fail", "text": "encrypt: " + str(r.error)[:180]}
        else:
            d = call(api.decrypt(api.DecryptRequest(pdf_b64=r.data_b64, password=ENC_PASSWORD)))
            if not d.success:
                ops["cryptroundtrip"] = {"level": "op_fail", "text": "decrypt: " + str(d.error)[:180]}
            else:
                out = base64.b64decode(d.data_b64)
                ops["cryptroundtrip"] = qpdf_check(out, tmp, "decrypted.pdf")
                ops["cryptroundtrip"]["pages"] = page_count(out)
    except Exception as e:
        ops["cryptroundtrip"] = {"level": "op_fail", "text": f"{type(e).__name__}: {e}"[:200]}

    return ops


# --------------------------------------------------------------------------- #
# xếp hạng
# --------------------------------------------------------------------------- #
def verdict_of(orig_level: str, pages, ops: dict) -> str:
    """MOT tu cho ca file. Thu tu duoi day la thu tu nghiem trong giam dan."""
    for name, o in ops.items():
        if o.get("level") == "op_fail":
            return ("broken_input" if orig_level == "error" else "op_fail") + ":" + name
    for name, o in ops.items():
        if pages is not None and o.get("pages") is not None and o["pages"] != pages:
            return "pagecount:" + name
    if orig_level != "error":
        for name, o in ops.items():
            if o.get("level") == "error":
                return "output_error:" + name
        if orig_level == "ok":
            for name, o in ops.items():
                if o.get("level") == "warn":
                    return "output_warn:" + name
    else:
        for name, o in ops.items():
            if o.get("level") == "error":
                return "broken_input:" + name
    return "ok"


def main() -> None:
    import tempfile
    import time

    path = Path(sys.argv[1])
    res = {"file": path.name, "bytes": 0, "orig": None, "pages": None,
           "ops": {}, "verdict": "ok", "note": "", "ms": 0}
    t0 = time.perf_counter()
    tmp = Path(tempfile.mkdtemp(prefix="nabu-sidecar-sweep-"))
    try:
        src = path.read_bytes()
        res["bytes"] = len(src)
        res["orig"] = qpdf_check(src, tmp, "orig.pdf")
        if res["orig"].get("encrypted"):
            # Tai lieu ma hoa: app bat nguoi dung giai ma truoc, sidecar khong phai
            # duong di. Ghi nhan roi dung, dung tinh la loi cua minh.
            res["verdict"] = "encrypted"
        else:
            res["pages"] = page_count(src)
            if res["pages"] is None:
                res["verdict"] = ("broken_input" if res["orig"]["level"] == "error" else "open_fail")
            else:
                res["ops"] = run_ops(__import__("api"), src, res["pages"], tmp)
                res["verdict"] = verdict_of(res["orig"]["level"], res["pages"], res["ops"])
    except Exception as e:
        res["verdict"] = "harness_error"
        res["note"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)

    res["ms"] = int((time.perf_counter() - t0) * 1000)
    sys.stdout.write(json.dumps(res) + "\n")


if __name__ == "__main__":
    main()
