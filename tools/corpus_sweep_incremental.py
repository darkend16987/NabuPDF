"""Lưới quét corpus cho LÕI GHI NỐI (`src/pdf/incremental.py`, BI-128).

    .venv\\Scripts\\python tools/corpus_sweep_incremental.py            # cả corpus
    .venv\\Scripts\\python tools/corpus_sweep_incremental.py --only tracemonkey
    .venv\\Scripts\\python tools/corpus_sweep_incremental.py --jobs 8

Mỗi file đi đúng đường mà app thật sẽ đi sau chốt 4: pdf-lib mở file gốc, xoay trang 1, lưu
(= "bản đã sửa", `tools/pdflib_rotate.js`) → **tiến trình con thật** `sidecar.py --incremental-worker gốc đã_sửa ra`
(BI-129; KHÔNG gọi lõi tại chỗ, để hợp đồng mã thoát/stderr/meta cũng được quét) → qpdf chấm kết quả.
`--exe <sidecar.exe>` chạy cùng lưới trên BẢN ĐÓNG GÓI (argv của bản frozen khác bản dev).

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

MỐC: `tools/corpus-baseline-incremental.json` (có commit). `--update-baseline` ghi lại các file KHÔNG sạch; file
nào ra kết quả KHÁC mốc là hồi quy (thoát 1) — kể cả `ok → refused:*` (mất khả năng ghi nối) lẫn đổi lý do từ chối. File
tốt lên so với mốc (`refused:* → ok`) được báo và gợi ý cập nhật mốc. Ngoài ra thoát 1 nếu có dòng "lỗi thật".
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
BASELINE = ROOT / "tools" / "corpus-baseline-incremental.json"


def corpus_commit(corpus: Path):
    """Commit của repo corpus (để biết số có so thẳng được với mốc không). None nếu không phải repo git."""
    try:
        r = subprocess.run(["git", "-C", str(corpus), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=15)
        return r.stdout.strip() or None if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


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
def worker_cmd(exe: str, original: Path, edited: Path, out: Path) -> list[str]:
    from src.pdf import incremental as inc

    if exe:  # bản đóng gói: sidecar.exe CHÍNH LÀ worker, cờ đi thẳng vào nó
        return [exe, inc.WORKER_FLAG, str(original), str(edited), str(out)]
    return [sys.executable, str(ROOT / "sidecar.py"), inc.WORKER_FLAG, str(original), str(edited), str(out)]


def run_one(pdf: Path, qpdf: str, exe: str = "") -> dict:
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
        kw = {"creationflags": 0x08000000} if os.name == "nt" else {}
        t0 = time.perf_counter()
        try:
            w = subprocess.run(
                worker_cmd(exe, pdf, edited, result), capture_output=True,
                timeout=inc.INCREMENTAL_TIMEOUT_S + 30, **kw,
            )
        except subprocess.TimeoutExpired:
            out["outcome"] = "timeout"  # cha còn có hạn giờ riêng: worker mà treo qua cả hạn của route là lỗi thật
            return out
        out["worker_s"] = round(time.perf_counter() - t0, 2)
        err = (w.stderr or b"").decode("utf-8", "replace").strip()
        if w.returncode == inc.EXIT_REFUSED:
            reason, _, detail = err.partition("	")
            out["outcome"] = f"refused:{reason}"
            out["detail"] = detail[:120]
            return out
        if w.returncode != inc.EXIT_OK:
            out["outcome"] = f"error:worker_exit_{w.returncode}"  # gồm cả segfault: lỗi thật của lõi/PyMuPDF
            out["detail"] = err[:120]
            return out
        try:
            meta = json.loads(Path(inc.meta_path(str(result))).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            out["outcome"] = "error:no_meta"
            return out

        out.update(changed=meta["changed"], added=meta["added"], reused=meta["reused"])
        if meta["unchanged"]:
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
def spawn(pdf: Path, qpdf: str, exe: str = "") -> dict:
    try:
        p = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--one", str(pdf), "--qpdf", qpdf, "--exe", exe],
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
    ap.add_argument("--exe", default="", help="chạy worker bằng sidecar.exe ĐÃ ĐÓNG GÓI thay vì sidecar.py")
    ap.add_argument("--update-baseline", action="store_true", help="ghi lại mốc từ lần quét này")
    args = ap.parse_args()

    # Console Windows mặc định là cp1252: in tiếng Việt thẳng sẽ làm CHẾT chính lưới này ở dòng đầu tiên (đã vấp ở
    # `corpus_sweep_sidecar.py`, xem docs/CORPUS-SWEEP.md). `replace` = chữ có dấu thành `?`, không bao giờ ném.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.one:
        print(json.dumps(run_one(Path(args.one), args.qpdf, args.exe), ensure_ascii=True))
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

    if args.exe and not Path(args.exe).is_file():
        print(f"Khong thay --exe: {args.exe}", file=sys.stderr)
        return 2
    print(f"corpus : {args.corpus}  ({len(files)} file, {args.jobs} luong)\nqpdf   : {args.qpdf}"
          f"\nworker : {args.exe or 'sidecar.py (dev)'}", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        results = list(ex.map(lambda p: spawn(p, args.qpdf, args.exe), files))
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
    timed = sorted((r for r in results if "worker_s" in r), key=lambda r: -r["worker_s"])
    if timed:
        print("\nWorker chậm nhất: " + " · ".join(f"{r['file']} {r['worker_s']}s" for r in timed[:4]))
    if args.report:
        Path(args.report).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- mốc ----------------------------------------------------------------------------------------------
    known = {r["file"]: r["outcome"] for r in results if r["outcome"] not in ("ok", "unchanged")}
    if args.update_baseline:
        if args.only or args.limit:
            print("\nKhong ghi moc tu mot lan quet MOT PHAN (--only/--limit): se xoa het cac file con lai khoi moc.")
            return 2
        BASELINE.write_text(
            json.dumps(
                {
                    "note": "Moc cua luoi quet ghi noi (tools/corpus_sweep_incremental.py, BI-128/129). 'known' chi liet ke "
                            "file KHONG ok/unchanged; file ra ket qua KHAC moc la hoi quy.",
                    "corpus": {"dir": args.corpus, "files": len(files), "commit": corpus_commit(Path(args.corpus))},
                    "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "summary": {k: len(v) for k, v in sorted(by.items())},
                    "known": dict(sorted(known.items())),
                },
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\nDa ghi moc: {BASELINE} ({len(known)} file khong ok)")
        return 1 if bad else 0

    if not BASELINE.is_file():
        print("\nChua co moc. Tao bang:  .venv\\Scripts\\python tools/corpus_sweep_incremental.py --update-baseline")
        return 1 if bad else 0
    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    seen = {r["file"] for r in results}
    worse = [f"{f}: {base['known'].get(f, 'ok')} -> {v}" for f, v in sorted(known.items()) if base["known"].get(f) != v]
    better = [f"{f}: {v} -> ok" for f, v in sorted(base["known"].items()) if f in seen and f not in known]
    if better:
        print(f"\n--- tot hon moc ({len(better)}) ---")
        for line in better[:15]:
            print("  " + line)
        print("  Cap nhat moc:  .venv\\Scripts\\python tools/corpus_sweep_incremental.py --update-baseline")
    if worse:
        print(f"\n*** HOI QUY so voi moc ({len(worse)}) ***")
        for line in worse[:25]:
            print("  " + line)
    if not worse and not bad:
        print("\nKhong co file nao xau di so voi moc.")
    return 1 if (worse or bad) else 0


if __name__ == "__main__":
    sys.exit(main())
