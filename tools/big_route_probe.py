r"""Đo route /save-incremental-bin ở cỡ thật qua HTTP (BI-131): thời gian, RAM đỉnh của CẢ CÂY tiến trình sidecar (cha + worker),
và kết quả có bắt đầu bằng đúng byte file ký + hợp lệ theo OpenSSL không.
Dùng: python tools/big_route_probe.py <thư mục có big_signed.pdf + big_edited.pdf> [--exe D:\...\sidecar.exe] [--port N]
Đo 2026-11-22 (152 MB, 19 trang): 1,7 s dev / 1,9 s đóng gói, RAM đỉnh 272 / 292 MB, OpenSSL hợp lệ.
"""
import argparse, ctypes, os, subprocess, sys, threading, time, urllib.request
from ctypes import wintypes
from pathlib import Path

ROOT = Path("D:/GitHub/ContractOCR")
sys.path.insert(0, str(ROOT / "tools"))
import verify_pdf_signatures as vs  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--exe", default="")
ap.add_argument("--port", type=int, default=8791)
a = ap.parse_args()
d = Path(a.dir)
signed, edited = d / "big_signed.pdf", d / "big_edited.pdf"
orig = signed.read_bytes()
body = edited.read_bytes()
print(f"gốc {len(orig)/1048576:.1f} MB · bản sửa {len(body)/1048576:.1f} MB")

cmd = [a.exe, "--port", str(a.port)] if a.exe else [sys.executable, str(ROOT / "sidecar.py"), "--port", str(a.port)]
env = {k: v for k, v in os.environ.items() if k != "SIDECAR_TOKEN"}
p = subprocess.Popen(cmd, cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# --- đo RAM đỉnh của cả cây tiến trình bằng PowerShell định kỳ (PeakWorkingSet không có cho tiến trình đã chết) ---
peak = {"total": 0, "n": 0}
stop = threading.Event()

def sample():
    ps = ("$ids=@(" + str(p.pid) + "); do { $n=$ids.Count; $ids=@($ids) + @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId } | "
          "ForEach-Object { $_.ProcessId }) | Select-Object -Unique } while ($ids.Count -ne $n); "
          "$t=0; foreach($i in $ids){ $pr=Get-Process -Id $i -ErrorAction SilentlyContinue; if($pr){ $t+=$pr.WorkingSet64 } }; \"$t $($ids.Count)\"")
    while not stop.is_set():
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=20).stdout.split()
            if len(out) == 2:
                t, n = int(out[0]), int(out[1])
                if t > peak["total"]:
                    peak["total"], peak["n"] = t, n
        except Exception:
            pass
        time.sleep(0.4)

try:
    for _ in range(240):
        try:
            if urllib.request.urlopen(f"http://127.0.0.1:{a.port}/health", timeout=2).status == 200:
                break
        except Exception:
            time.sleep(1)
    else:
        raise SystemExit("sidecar không lên")
    th = threading.Thread(target=sample, daemon=True)
    th.start()
    time.sleep(1.5)
    base = peak["total"]
    t0 = time.time()
    q = "http://127.0.0.1:%d/save-incremental-bin?original_path=%s" % (a.port, urllib.request.quote(str(signed.resolve())))
    req = urllib.request.Request(q, data=body, method="POST", headers={"Content-Type": "application/pdf"})
    try:
        r = urllib.request.urlopen(req, timeout=600)
        out = r.read()
        hdr = {k: v for k, v in r.headers.items()}
        ct = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        out, ct, hdr = e.read(), "HTTP %d" % e.code, {}
    dt = time.time() - t0
    stop.set()
    print(f"HTTP xong sau {dt:.1f} s · Content-Type {ct} · {len(out)/1048576:.1f} MB")
    print(f"RAM đỉnh cả cây tiến trình sidecar: {peak['total']/1048576:.0f} MB (lúc rảnh {base/1048576:.0f} MB; tối đa {peak['n']} tiến trình)")
    if "pdf" in ct:
        print({k: hdr[k] for k in hdr if k.lower().startswith("x-")})
        print("bắt đầu bằng đúng byte file ký:", out[: len(orig)] == orig)
        tmpf = d / "big_result.pdf"
        tmpf.write_bytes(out)
        t1 = time.time()
        res = vs.verify_file(str(tmpf))
        print(f"OpenSSL: {[('HOP LE' if s['ok'] else 'HONG') for s in res]} ({time.time()-t1:.1f} s)")
        tmpf.unlink()
    else:
        print(out[:300])
finally:
    stop.set()
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
