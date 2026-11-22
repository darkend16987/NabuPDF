"""Lưới quét corpus cho LÕI GHI NỐI (`src/pdf/incremental.py`, BI-128).

    .venv\\Scripts\\python tools/corpus_sweep_incremental.py            # cả corpus
    .venv\\Scripts\\python tools/corpus_sweep_incremental.py --only tracemonkey
    .venv\\Scripts\\python tools/corpus_sweep_incremental.py --jobs 8

Mỗi file đi đúng đường mà app thật sẽ đi sau chốt 4: pdf-lib mở file gốc, xoay trang 1, lưu
(= "bản đã sửa", `tools/pdflib_rotate.js`) → `append_revision(gốc, đã sửa)` → qpdf chấm kết quả.

Mỗi file một TIẾN TRÌNH riêng (chính script này với `--one`), cùng lý do với hai lưới kia: PyMuPDF
là thư viện C, file méo có thể làm nó chết cả tiến trình; cha giết được và quy đúng tội cho đúng file.
Trọng tài là qpdf, và luôn chấm bản GỐC trước — corpus pdf.js cố tình chứa file hỏng, không có bước
đó thì mọi lỗi đều đổ oan cho lõi. Xem docs/CORPUS-SWEEP.md.

Mỗi file được xếp vào MỘT từ:
  ok               nối được, tiền tố byte y hệt gốc, qpdf không tệ hơn bản gốc
  unchanged        pdf-lib trả về object y hệt gốc ⇒ không có revision nào (hợp lệ)
  refused:<lý do>  lõi TỪ CHỐI có chủ đích (fail-closed) — không phải lỗi, nhưng phải đếm và đọc
  output_worse     nối được NHƯNG qpdf thấy kết quả tệ hơn gốc  ← lỗi thật của lõi
  prefix_changed   kết quả không bắt đầu bằng byte của gốc      ← lỗi thật (phá chữ ký)
  broken_input     qpdf nói chính file gốc đã hỏng — bỏ qua
  pdflib_fail      pdf-lib không mở/lưu nổi (không có "bản đã sửa" để nối) — bỏ qua
  error:<tên>      lõi ném ngoại lệ KHÔNG phải IncrementalRefused  ← lỗi thật
  crash / timeout  tiến trình con chết / treo                      ← lỗi thật

CHƯA có mốc (baseline) và chưa so hồi quy: lõi mới có hàm, chưa có route (chốt 3). Khi có route sẽ
thêm mốc như hai lưới kia; hiện tại script in bảng và thoát 1 nếu có dòng "lỗi thật".
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DEFAULT_CORPUS = r"D:\GitHub\_refs\pdfjs-corpus\test\pdfs"
DEFAULT_QPDF = r"D:\GitHub\_refs\tools\qpdf\qpdf-12.4.2-msvc64\bin\qpdf.exe"
ONE_TIMEOUT_S = 180
ROTATE_TIMEOUT_S = 90

REAL_FAILS = ("output_worse", "prefix_changed", "crash", "timeout")


def qpdf_level(qpdf: str, path: Path) -> int:
    """0 sạch, 1 cảnh báo, 2 lỗi/crash/treo."""
    try:
        r = subprocess.run([qpdf, "--check", str(path)], capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        return 2
    return {0: 0, 3: 1}.get(r.returncode, 2)


# --------------------------------------------------------------------------- #
# tiến trình con: MỘT file
# --------------------------------------------------------------------------- #
def run_one(pdf: Path, qpdf: str) -> dict:
    from src.pdf import incremental as inc

    out: dict = {"file": pdf.name, "size": pdf.stat().st_size}
    with tempfile.TemporaryDirectory(prefix="nabu-incsweep-") as td:
        td = Path(td)
        lvl_orig = qpdf_level(qpdf, pdf)
        out["orig_level"] = lvl_orig
        if lvl_orig == 2:
            out["outcome"] = "broken_input"
            return out

        edited = td / "edited.pdf"
        try:
            r = subprocess.run(
                ["node", str(ROOT / "tools" / "pdflib_rotate.js"), str(pdf), str(edited)],
                capture_output=True, text=True, timeout=ROTATE_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            out["outcome"] = "pdflib_fail"
            out["detail"] = "pdf-lib treo"
            return out
        if r.returncode != 0 or not edited.exists():
            out["outcome"] = "pdflib_fail"
            out["detail"] = (r.stdout or r.stderr).strip()[:80]
            return out

        result = td / "result.pdf"
        try:
            res = inc.append_revision(str(pdf), str(edited), str(result))
        except inc.IncrementalRefused as e:
            out["outcome"] = f"refused:{e.reason}"
            out["detail"] = e.detail[:120]
            return out
        except Exception as e:  # noqa: BLE001 — chính là thứ lưới này đi tìm
            out["outcome"] = f"error:{type(e).__name__}"
            out["detail"] = str(e)[:120]
            return out

        out.update(changed=res.changed, added=res.added, reused=res.reused)
        if res.unchanged_input:
            out["outcome"] = "unchanged"
            return out

        # Tiền tố y hệt gốc — lõi đã tự kiểm, nhưng lưới KHÔNG tin lời tự khai của thứ nó đang chấm.
        n = pdf.stat().st_size
        with open(pdf, "rb") as a, open(result, "rb") as b:
            same = a.read(n) == b.read(n)
        out["grown"] = result.stat().st_size - n
        if not same:
            out["outcome"] = "prefix_changed"
            return out
        lvl = qpdf_level(qpdf, result)
        out["result_level"] = lvl
        out["outcome"] = "ok" if lvl <= lvl_orig else "output_worse"
        return out


# --------------------------------------------------------------------------- #
# tiến trình cha
# --------------------------------------------------------------------------- #
def spawn(pdf: Path, qpdf: str) -> dict:
    try:
        p = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--one", str(pdf), "--qpdf", qpdf],
            capture_output=True, text=True, timeout=ONE_TIMEOUT_S, cwd=str(ROOT),
        )
    except subprocess.TimeoutExpired:
        return {"file": pdf.name, "outcome": "timeout"}
    line = next((l for l in reversed(p.stdout.splitlines()) if l.startswith("{")), None)
    if p.returncode != 0 or not line:
        return {"file": pdf.name, "outcome": "crash", "detail": f"exit {p.returncode}: {(p.stderr or '').strip()[-100:]}"}
    return json.loads(line)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--one", help="(nội bộ) quét một file, in một dòng JSON")
    ap.add_argument("--corpus", default=os.environ.get("NABU_CORPUS", DEFAULT_CORPUS))
    ap.add_argument("--qpdf", default=os.environ.get("NABU_QPDF", DEFAULT_QPDF))
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--only", default="", help="chỉ file có tên chứa chuỗi này")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--report", default="", help="ghi báo cáo JSON đầy đủ ra file này")
    args = ap.parse_args()

    if args.one:
        print(json.dumps(run_one(Path(args.one), args.qpdf), ensure_ascii=True))
        return 0

    if not Path(args.qpdf).is_file():
        print(f"Khong thay qpdf: {args.qpdf}\nXem docs/CORPUS-SWEEP.md.", file=sys.stderr)
        return 2
    files = sorted(p for p in Path(args.corpus).glob("*.pdf") if args.only in p.name)
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("Khong co file nao.", file=sys.stderr)
        return 2

    print(f"corpus : {args.corpus}  ({len(files)} file, {args.jobs} luong)\nqpdf   : {args.qpdf}", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        results = list(ex.map(lambda p: spawn(p, args.qpdf), files))
    dt = time.time() - t0

    by = collections.defaultdict(list)
    for r in results:
        by[r["outcome"]].append(r)
    print(f"\nxong sau {dt:.0f} s\n")
    for k in sorted(by, key=lambda k: (-len(by[k]), k)):
        print(f"  {len(by[k]):5d}  {k}")

    ok = by.get("ok", [])
    reused = [r for r in ok if r.get("reused")]
    print(f"\nTrong {len(ok)} file ok: {len(reused)} có tái dùng ô trống; "
          f"{sum(1 for r in ok if r.get('result_level') == 1)} file qpdf chỉ cảnh báo (gốc cũng cảnh báo: "
          f"{sum(1 for r in ok if r.get('orig_level') == 1)}).")
    if ok:
        g = sorted(r["grown"] for r in ok)
        print(f"Dung lượng thêm: trung vị {g[len(g)//2]:,} B · lớn nhất {g[-1]:,} B ({[r['file'] for r in ok if r['grown']==g[-1]][0]})")

    bad = [r for r in results if r["outcome"] in REAL_FAILS or r["outcome"].startswith("error:")]
    refused = [r for r in results if r["outcome"].startswith("refused:")]
    for title, rows in (("LỖI THẬT", bad), ("TỪ CHỐI (đọc từng cái)", refused)):
        if rows:
            print(f"\n--- {title}: {len(rows)} ---")
            for r in rows[:40]:
                print(f"  {r['file']:42s} {r['outcome']:34s} {r.get('detail','')}")
    if args.report:
        Path(args.report).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
