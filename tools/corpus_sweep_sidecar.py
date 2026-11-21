"""Lưới quét corpus cho SIDECAR: chạy các endpoint ghi file của ``api.py`` trên
hàng nghìn PDF thật rồi để một trọng tài độc lập (qpdf) chấm.

Đây là bản song sinh của ``desktop/scripts/corpus-sweep.js`` cho nửa Python —
xem docs/CORPUS-SWEEP.md. Hai lưới dùng chung corpus, chung trọng tài, chung
cách đọc kết quả, nhưng mốc riêng vì chúng chạy đường khác nhau.

    .venv\\Scripts\\python tools/corpus_sweep_sidecar.py
    .venv\\Scripts\\python tools/corpus_sweep_sidecar.py --limit 40 --jobs 6
    .venv\\Scripts\\python tools/corpus_sweep_sidecar.py --filter rotate
    .venv\\Scripts\\python tools/corpus_sweep_sidecar.py --update-baseline

KHÔNG phải cổng của /deploy: cần corpus (153 MB) và qpdf đặt NGOÀI repo, và mất
vài phút. Chạy tay khi đụng vào bất kỳ endpoint nào ghi PDF, khi nâng PyMuPDF,
hoặc trước một bản phát hành.

Cài đặt một lần (đường dẫn mặc định, đổi bằng biến môi trường hoặc tham số):
  corpus : D:\\GitHub\\_refs\\pdfjs-corpus\\test\\pdfs   (NABU_CORPUS_DIR)
  qpdf   : D:\\GitHub\\_refs\\tools\\qpdf\\...\\qpdf.exe (NABU_QPDF)
Hướng dẫn tải đầy đủ ở docs/CORPUS-SWEEP.md.

Thoát 1 KHI VÀ CHỈ KHI có file xấu đi so với mốc — tức "thay đổi vừa rồi làm
hỏng thêm", không phải "corpus có file hỏng".

Mọi thứ in ra màn hình là ASCII: console Windows của dự án là cp1252 (cùng lý do
đã ghi ở đầu test_endpoints_stubbed.py).
"""

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = Path(__file__).resolve().parent / "corpus_sweep_sidecar_one.py"
BASELINE = ROOT / "tools" / "corpus-baseline-sidecar.json"
DEFAULT_CORPUS = r"D:\GitHub\_refs\pdfjs-corpus\test\pdfs"
DEFAULT_QPDF = r"D:\GitHub\_refs\tools\qpdf\qpdf-12.4.2-msvc64\bin\qpdf.exe"

# Thu tu in: nang truoc. Bon trang thai dau la trang thai BINH THUONG cua corpus.
BENIGN_PREFIXES = ("ok", "encrypted", "broken_input")


def is_benign(verdict: str) -> bool:
    return verdict.split(":")[0] in BENIGN_PREFIXES


def severity(verdict: str) -> int:
    head = verdict.split(":")[0]
    order = ["crash", "timeout", "harness_error", "op_fail", "pagecount",
             "output_error", "output_warn", "open_fail", "broken_input",
             "encrypted", "ok"]
    return order.index(head) if head in order else 0


def sweep_one(args, name: str) -> dict:
    path = Path(args.corpus) / name
    env = dict(os.environ, NABU_QPDF=args.qpdf)
    try:
        p = subprocess.run(
            [sys.executable, str(WORKER), str(path)],
            capture_output=True, text=True, timeout=args.timeout, env=env, cwd=str(ROOT),
        )
    except subprocess.TimeoutExpired:
        return {"file": name, "verdict": "timeout", "note": f"{args.timeout}s", "ms": args.timeout * 1000}
    line = (p.stdout or "").strip().splitlines()
    if line:
        try:
            return json.loads(line[-1])
        except Exception:
            pass
    # Khong co dong JSON nao = tien trinh chet giua chung (PyMuPDF la thu vien C:
    # file meo lam no chet ca tien trinh chu khong nem exception).
    note = (p.stderr or p.stdout or f"exit {p.returncode}").strip()[:300]
    return {"file": name, "verdict": "crash", "note": note, "exit": p.returncode}


def known_of(results: list) -> dict:
    return {r["file"]: r["verdict"] for r in results if not is_benign(r["verdict"])}


def corpus_commit(corpus: Path):
    """Corpus duoc ghim theo commit: hai ban corpus khac nhau thi so khong so duoc."""
    try:
        git = corpus.parent.parent / ".git"
        head = (git / "HEAD").read_text(encoding="utf-8").strip()
        if head.startswith("ref: "):
            return (git / head[5:]).read_text(encoding="utf-8").strip()
        return head
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--corpus", default=os.environ.get("NABU_CORPUS_DIR", DEFAULT_CORPUS))
    ap.add_argument("--qpdf", default=os.environ.get("NABU_QPDF", DEFAULT_QPDF))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=max(2, min(8, (os.cpu_count() or 4) - 1)))
    ap.add_argument("--timeout", type=int, default=120, help="giay cho moi file")
    ap.add_argument("--filter", default="")
    ap.add_argument("--out", default=str(ROOT / ".sweep" / "sidecar-report.json"))
    ap.add_argument("--update-baseline", action="store_true")
    args = ap.parse_args()

    corpus = Path(args.corpus)
    if not corpus.is_dir():
        print(f"\nKhong thay corpus: {corpus}\nXem docs/CORPUS-SWEEP.md.\n", file=sys.stderr)
        return 2
    if not Path(args.qpdf).is_file():
        print(f"\nKhong thay qpdf: {args.qpdf}\nXem docs/CORPUS-SWEEP.md.\n", file=sys.stderr)
        return 2

    files = sorted(p.name for p in corpus.glob("*.pdf"))
    if args.filter:
        files = [f for f in files if args.filter.lower() in f.lower()]
    if args.limit:
        files = files[: args.limit]
    if not files:
        print("Khong co file .pdf nao khop.", file=sys.stderr)
        return 2

    print(f"corpus : {corpus}  ({len(files)} file)")
    print(f"qpdf   : {args.qpdf}")
    print(f"jobs   : {args.jobs}, timeout {args.timeout}s/file\n", flush=True)

    t0 = time.perf_counter()
    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for r in ex.map(lambda n: sweep_one(args, n), files):
            results.append(r)
            done += 1
            if done % 25 == 0 or done == len(files):
                print(f"  {done}/{len(files)}", flush=True)
    # --- chạy lại những verdict KHÔNG TẤT ĐỊNH ---------------------------------------------
    # Đo được (2026-11-22): hai lần quét liên tiếp cho 2 rồi 4 file `crash`. Segfault của
    # PyMuPDF phụ thuộc trạng thái bộ cấp phát, nên nó đến và đi theo tải. Chạy lại riêng từng
    # file, TUẦN TỰ (không tải song song) để biết nó chết chắc hay chết theo may rủi; verdict
    # vẫn giữ nguyên "crash" — đã chết một lần là một phát hiện thật — nhưng `attempts` ghi lại
    # đủ ba lần để người đọc tự thấy.
    # CHỈ chạy lại `crash`. `timeout` thì bỏ qua: nó tất định (bom giải nén vẫn là bom) và mỗi
    # lần chạy lại tốn trọn hạn giờ — đo được: chạy lại 2 timeout đẩy vòng quét từ ~3 phút lên
    # hơn 11 phút mà không thêm một thông tin nào.
    unstable = [r for r in results if r["verdict"].split(":")[0] == "crash"]
    if unstable:
        print(f"\nChay lai tuan tu {len(unstable)} file 'crash', toi da 2 lan nua...", flush=True)
        for r in unstable:
            attempts = [r["verdict"]]
            for _ in range(2):
                attempts.append(sweep_one(args, r["file"])["verdict"])
            r["attempts"] = attempts
            hits = sum(1 for a in attempts if a.split(":")[0] == "crash")
            print(f"  {r['file']:<40}{hits}/3 lan chet  {attempts}", flush=True)

    results.sort(key=lambda r: r["file"])
    seconds = round(time.perf_counter() - t0, 1)

    summary = {}
    for r in results:
        summary[r["verdict"]] = summary.get(r["verdict"], 0) + 1

    report = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "corpus": {"dir": str(corpus), "files": len(files), "commit": corpus_commit(corpus)},
        "qpdf": args.qpdf,
        "seconds": seconds,
        "summary": summary,
        "results": results,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")

    print(f"\n=== Quet corpus (sidecar): {len(files)} file trong {seconds} s ===\n")
    for name in sorted(summary, key=severity):
        flag = "   " if is_benign(name) else " ! "
        print(f"{flag}{name:<28}{summary[name]:>5}")

    bad = [r for r in results if not is_benign(r["verdict"])]
    if bad:
        print("\n--- file dang nhin (toi da 25) ---")
        for r in bad[:25]:
            op = r["verdict"].split(":")[-1]
            d = r.get("note") or (r.get("ops", {}).get(op, {}) or {}).get("text", "")
            # Thong diep loi den TU SIDECAR va la tieng Viet; console Windows la cp1252
            # nen in thang se lam CHET chinh luoi nay o dong cuoi cung (da vap that).
            d = d.encode("ascii", "replace").decode("ascii")
            print(f"  {r['verdict']:<26}{r['file']}" + (f"  - {d[:90]}" if d else ""))
        if len(bad) > 25:
            print(f"  ... con {len(bad) - 25} file nua, xem {out}")
    print(f"\nbao cao day du: {out}")

    if args.update_baseline:
        BASELINE.write_text(
            json.dumps(
                {
                    "note": "Moc cua luoi quet sidecar (tools/corpus_sweep_sidecar.py). "
                            "'known' chi liet ke file KHONG sach; file xau di so voi day la hoi quy.",
                    "corpus": report["corpus"],
                    "generated": report["generated"],
                    "summary": summary,
                    "known": known_of(results),
                },
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\nDa ghi moc: {BASELINE} ({len(known_of(results))} file khong sach)")
        return 0

    if not BASELINE.is_file():
        print("\nChua co moc. Tao bang:  .venv\\Scripts\\python tools/corpus_sweep_sidecar.py --update-baseline")
        return 0

    base = json.loads(BASELINE.read_text(encoding="utf-8"))
    bc, rc = (base.get("corpus") or {}).get("commit"), report["corpus"]["commit"]
    if bc and rc and bc != rc:
        print(f"\nCANH BAO: corpus khac commit voi moc ({bc[:10]} != {rc[:10]}) - so khong so thang duoc.")

    now = known_of(results)
    seen = {r["file"] for r in results}
    worse = [f"{f}: {base['known'].get(f, 'ok')} -> {v}" for f, v in now.items() if base["known"].get(f) != v]
    better = [f"{f}: {v} -> ok" for f, v in base["known"].items() if f in seen and f not in now]

    if better:
        print(f"\n--- da sach hon moc ({len(better)}) ---")
        for line in better[:15]:
            print("  " + line)
        print("  Cap nhat moc:  .venv\\Scripts\\python tools/corpus_sweep_sidecar.py --update-baseline")
    if worse:
        print(f"\n*** HOI QUY so voi moc ({len(worse)}) ***")
        for line in worse[:25]:
            print("  " + line)
        if any("crash" in line or "timeout" in line for line in worse):
            print("\n  Luu y: 'crash' cua PyMuPDF KHONG tat dinh (xem docs/CORPUS-SWEEP.md).")
            print("  Chay lai rieng file do truoc khi ket luan:  --filter <ten-file>")
        return 1
    print("\nKhong co file nao xau di so voi moc.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
