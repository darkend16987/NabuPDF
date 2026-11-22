"""Chốt 5 (BI-131) — thử ĐẦU-CUỐI "Lưu nối thêm" trên file ký THẬT, với trọng tài mật mã độc lập.

Đường đi đúng như đời thật, trừ cái hộp thoại:
    file đã ký (ký bằng đường của app, chứng thư tự ký)           [tools/signed_fixture.js]
      → pdf-lib của renderer sửa + lưu lại (bản "đã sửa")          [tools/signed_fixture.js]
      → WORKER ghi nối (dev: sidecar.py; --exe: sidecar.exe đóng gói)
      → kết quả. Kiểm bằng:
          · OpenSSL: chữ ký còn đúng trên ByteRange cũ?             [tools/verify_pdf_signatures.py]
          · kết quả bắt đầu bằng ĐÚNG mọi byte file đã ký?
          · qpdf --check; số trang, góc xoay, chữ, giá trị form, tiêu đề == bản đã sửa (PyMuPDF)
      và ĐỐI CHỨNG: đường lưu HIỆN TẠI (ghi cả bản pdf-lib đè lên) phải làm chữ ký HỎNG — nếu nó vẫn hợp lệ thì phép thử
      này không chứng minh được gì.
Cộng thêm: lưu LẦN HAI lên chính kết quả đã nối (Ctrl+S hai lần).

Dùng:  .venv\\Scripts\\python tools/signed_e2e.py [--exe D:\\...\\sidecar.exe] [--keep]
`--exe` PHẢI là đường tuyệt đối. Thoát 0 nếu mọi ca đạt kỳ vọng, 1 nếu có ca sai.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

import fitz  # noqa: E402

import verify_pdf_signatures as vs  # noqa: E402
from src.pdf import incremental as inc  # noqa: E402

QPDF = os.environ.get("QPDF", r"D:\GitHub\_refs\tools\qpdf\qpdf-12.4.2-msvc64\bin\qpdf.exe")


def worker_cmd(exe, original, edited, out):
    if exe:
        return [exe, inc.WORKER_FLAG, str(original), str(edited), str(out)]
    return [sys.executable, str(ROOT / "sidecar.py"), inc.WORKER_FLAG, str(original), str(edited), str(out)]


def run_worker(exe, original, edited, out):
    r = subprocess.run(worker_cmd(exe, original, edited, out), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    meta = {}
    mp = inc.meta_path(str(out))
    if r.returncode == 0 and os.path.exists(mp):
        meta = json.load(open(mp, encoding="utf-8"))
    return r.returncode, (r.stderr or "").strip().splitlines()[-1:] or [""], meta


def qpdf_check(p):
    r = subprocess.run([QPDF, "--check", str(p)], capture_output=True, text=True, errors="replace")
    return r.returncode  # 0 sạch, 3 chỉ cảnh báo, 2 lỗi


def snapshot(p):
    """Thứ người dùng THẤY ở một file: trang, góc xoay, chữ, giá trị form, tiêu đề."""
    d = fitz.open(str(p))
    try:
        pages = [(pg.rotation, pg.get_text("text").split()) for pg in d]
        fields = {}
        for pg in d:
            for w in pg.widgets() or []:
                fields[w.field_name] = w.field_value
        return {"n": d.page_count, "pages": pages, "fields": fields, "title": (d.metadata or {}).get("title", "")}
    finally:
        d.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default="")
    ap.add_argument("--keep", action="store_true", help="giữ thư mục làm việc để mở bằng Acrobat/Foxit")
    args = ap.parse_args()
    if args.exe and not Path(args.exe).is_absolute():
        print("--exe phải là đường dẫn TUYỆT ĐỐI", file=sys.stderr)
        return 2
    if args.exe and not Path(args.exe).is_file():
        print("Không thấy --exe:", args.exe, file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="nabu-e2e-"))
    try:
        fx = subprocess.run(["node", str(ROOT / "tools" / "signed_fixture.js"), str(work / "fx")], capture_output=True, text=True, encoding="utf-8")
        if fx.returncode != 0:
            print("Dựng fixture lỗi:\n", fx.stderr)
            return 2
        files = json.loads(fx.stdout.strip().splitlines()[-1])
        signed = Path(files["signed"])
        orig_bytes = signed.read_bytes()

        print(f"worker : {args.exe or 'sidecar.py (dev)'}")
        base = vs.verify_file(str(signed))
        assert base and all(s["ok"] for s in base), f"file ký gốc KHÔNG hợp lệ theo OpenSSL: {base}"
        print(f"file ký: {len(orig_bytes):,} B, {len(base)} chữ ký, OpenSSL: HỢP LỆ\n")

        bad = 0
        rows = []

        def row(name, status, note=""):
            nonlocal bad
            rows.append((name, status, note))
            if status.startswith("SAI"):
                bad += 1

        results = {}
        for name, edit in files["edits"].items():
            edit = Path(edit)
            out = work / f"out_{name}.pdf"
            # ĐỐI CHỨNG: đường lưu hiện tại = chính bản pdf-lib đè lên → phải HỎNG
            cur = vs.verify_file(str(edit))
            cur_state = "chữ ký HỎNG" if cur and not all(s["ok"] for s in cur) else ("file không còn chữ ký nào" if not cur else "VẪN HỢP LỆ?!")
            code, err, meta = run_worker(args.exe, signed, edit, out)
            if code != 0:
                row(name, "TỪ CHỐI" if code == 5 else "SAI(worker lỗi)", f"exit {code}: {err[0][:90]} | đường cũ: {cur_state}")
                continue
            data = out.read_bytes()
            res = vs.verify_file(str(out))
            checks = []
            sig_ok = bool(res) and len(res) == len(base) and all(s["ok"] for s in res)
            if not sig_ok:
                checks.append("chữ ký KHÔNG hợp lệ")
            if not data.startswith(orig_bytes):
                checks.append("không bắt đầu bằng byte gốc")
            qc = qpdf_check(out)
            if qc == 2:
                checks.append("qpdf lỗi")
            if cur_state == "VẪN HỢP LỆ?!":
                checks.append("đối chứng vô giá trị")
            a, b = snapshot(out), snapshot(edit)
            if a != b:
                diff = [k for k in a if a[k] != b[k]]
                checks.append("khác bản đã sửa ở: " + ",".join(diff))
            note = f"+{len(data) - len(orig_bytes):,} B · changed={meta.get('changed')} added={meta.get('added')} · qpdf {qc} · đường cũ: {cur_state}"
            row(name, "SAI(" + "; ".join(checks) + ")" if checks else "ĐẠT", note)
            results[name] = out

        # Lưu LẦN HAI: đĩa = kết quả đã nối của 'text'; người dùng sửa thêm ('multi' làm lại từ file ký) rồi Ctrl+S
        if "text" in results and "multi" in files["edits"]:
            r1 = work / "r1.pdf"
            shutil.copy(results["text"], r1)
            out2 = work / "out_second.pdf"
            code, err, meta = run_worker(args.exe, r1, files["edits"]["multi"], out2)
            if code != 0:
                row("lưu lần hai", "TỪ CHỐI" if code == 5 else "SAI(worker lỗi)", f"exit {code}: {err[0][:90]}")
            else:
                d2, r1b = out2.read_bytes(), r1.read_bytes()
                res = vs.verify_file(str(out2))
                checks = []
                if not (res and all(s["ok"] for s in res)):
                    checks.append("chữ ký KHÔNG hợp lệ")
                if not d2.startswith(r1b):
                    checks.append("không bắt đầu bằng byte của lần lưu trước")
                if not d2.startswith(orig_bytes):
                    checks.append("không bắt đầu bằng byte file ký gốc")
                if qpdf_check(out2) == 2:
                    checks.append("qpdf lỗi")
                if snapshot(out2) != snapshot(files["edits"]["multi"]):
                    checks.append("khác bản đã sửa")
                row("lưu lần hai", "SAI(" + "; ".join(checks) + ")" if checks else "ĐẠT", f"+{len(d2) - len(r1b):,} B so với lần một")

            # Lưu lần hai KHÔNG đổi gì (bản đã sửa y như lần một) → không được phình thêm vô ích
            out3 = work / "out_again.pdf"
            code, err, meta = run_worker(args.exe, r1, files["edits"]["text"], out3)
            if code == 0:
                grow = out3.stat().st_size - r1.stat().st_size
                row("lưu lại y hệt", "ĐẠT" if grow <= 2048 and vs.verify_file(str(out3)) and all(s["ok"] for s in vs.verify_file(str(out3))) else "SAI(phình/hỏng)",
                    f"+{grow:,} B, unchanged={meta.get('unchanged')}")
            else:
                row("lưu lại y hệt", "TỪ CHỐI" if code == 5 else "SAI(worker lỗi)", f"exit {code}: {err[0][:90]}")

        # Nội dung đã xoá VẪN nằm trong file (điều hộp thoại nói thật): trang 4 bị xoá nhưng chữ của nó còn trong byte
        if "delpage" in results:
            still = b"SECRET-4" in results["delpage"].read_bytes() or b"SECRET-4" in orig_bytes
            # Chữ trong stream nén: kiểm bằng cách mở revision CŨ (mọi byte gốc) — luôn còn vì ta giữ nguyên byte cũ
            row("xoá trang → nội dung cũ còn trong lịch sử", "ĐẠT" if results["delpage"].read_bytes().startswith(orig_bytes) else "SAI",
                "đúng như cảnh báo trong hộp thoại: byte gốc (có trang 4) nằm nguyên trong file")

        w = max(len(r[0]) for r in rows)
        for name, st, note in rows:
            print(f"  {name:{w}s}  {st:10s}  {note}")
        n_ok = sum(1 for r in rows if r[1] == "ĐẠT")
        n_ref = sum(1 for r in rows if r[1] == "TỪ CHỐI")
        print(f"\n{n_ok} đạt · {n_ref} từ chối có chủ đích · {bad} SAI  (tổng {len(rows)})")
        if args.keep:
            print("Giữ thư mục:", work)
        return 1 if bad else 0
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.exit(main())
