"""BI-138 — `/split` chạy trong TIẾN TRÌNH CON, có hạn giờ.

Lõi tách (`src/pdf/split.py`) và hành vi nghiệp vụ của route (tên file, form thiếu `/Kids`, các câu 400) đã có test ở
`test_pdf_ops.py` — và vẫn chạy nguyên văn, giờ đi qua worker. File này chỉ test PHẦN BỌC, và chạy tiến trình con
THẬT (`sidecar.py --split-worker`) ở mọi chỗ có thể, vì cái cần chứng minh là hợp đồng cha ⇄ con.

CÁC LUẬT ĐƯỢC GHIM (mỗi luật có ít nhất một test sẽ ĐỎ nếu nó vỡ):
  · event loop KHÔNG bị chặn trong lúc tách (đây là lý do tồn tại của cả thay đổi);
  · hết giờ ⇒ tiến trình con bị GIẾT (không mồ côi), route trả `success:false` với câu nói rõ hết giờ;
  · hết giờ / worker chết ⇒ KHÔNG chạy lõi tại chỗ (làm thế là tự đứng hình đúng như cũ);
  · không khởi động nổi worker ⇒ lùi về tách tại chỗ (cùng đánh đổi với /compress);
  · worker chết ⇒ lỗi đọc được và yêu cầu kế tiếp vẫn chạy;
  · thư mục tạm luôn được dọn;
  · `split.py` là module lá (không fastapi/api/util), `sidecar.py` nhận cờ.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import fitz  # PyMuPDF

import api
from src.pdf import split as core

ROOT = Path(__file__).resolve().parent
CORPUS = Path(os.environ.get("NABU_CORPUS", r"D:\GitHub\_refs\pdfjs-corpus\test\pdfs"))


# --------------------------------------------------------------------------- #
# dựng đồ
# --------------------------------------------------------------------------- #
def _run(coro):
    return asyncio.run(coro)


def _pdf(n: int) -> bytes:
    d = fitz.open()
    for i in range(n):
        d.new_page().insert_text((72, 72), f"page {i + 1}")
    b = d.tobytes()
    d.close()
    return b


def _req(raw: bytes, **kw) -> "api.SplitRequest":
    return api.SplitRequest(pdf_b64=base64.b64encode(raw).decode(), **kw)


def _split(raw: bytes, **kw):
    return _run(api.split_pdf(_req(raw, **kw)))


def _names(resp) -> list[str]:
    return zipfile.ZipFile(io.BytesIO(base64.b64decode(resp.data_b64))).namelist()


def _split_dirs() -> set[str]:
    t = Path(tempfile.gettempdir())
    return {p.name for p in t.glob("nabu-split-*")}


class _FakeWorker:
    """Đổi `_split_worker_cmd` bằng một lệnh python tùy ý trong lúc test, rồi trả lại."""

    def __init__(self, code: str):
        self.code = code

    def __enter__(self):
        self.real = api._split_worker_cmd
        api._split_worker_cmd = lambda s, d, p: [sys.executable, "-c", self.code]
        return self

    def __exit__(self, *a):
        api._split_worker_cmd = self.real


class _Timeout:
    """Hạ `SPLIT_TIMEOUT_S` trong lúc test."""

    def __init__(self, s: int):
        self.s = s

    def __enter__(self):
        self.real = core.SPLIT_TIMEOUT_S
        core.SPLIT_TIMEOUT_S = self.s

    def __exit__(self, *a):
        core.SPLIT_TIMEOUT_S = self.real


class _NoInProcess:
    """Cấm lõi chạy TẠI CHỖ: nếu ai gọi `split_to_zip` trong tiến trình sidecar, test sẽ biết."""

    def __enter__(self):
        self.real = core.split_to_zip
        self.calls = 0

        def boom(*a, **k):
            self.calls += 1
            raise AssertionError("split_to_zip chay TAI CHO trong tien trinh sidecar")

        core.split_to_zip = boom
        return self

    def __exit__(self, *a):
        core.split_to_zip = self.real


def _pid_alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in out


# --------------------------------------------------------------------------- #
# đường thật: route + worker thật
# --------------------------------------------------------------------------- #
def test_route_splits_through_the_real_worker():
    r = _split(_pdf(5), mode="every", size=2)
    assert r.success, r.error
    assert r.count == 3 and len(_names(r)) == 3, (r.count, _names(r))
    assert _names(r) == ["part_001_p1-2.pdf", "part_002_p3-4.pdf", "part_003_p5.pdf"], _names(r)
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(r.data_b64)))
    pages = [fitz.open(stream=z.read(n), filetype="pdf").page_count for n in z.namelist()]
    assert pages == [2, 2, 1], pages


def test_route_ranges_mode_goes_through_the_worker_too():
    r = _split(_pdf(6), mode="ranges", ranges="1-2,4,6")
    assert r.success, r.error
    assert _names(r) == ["part_001_p1-2.pdf", "part_002_p4.pdf", "part_003_p6.pdf"], _names(r)


def test_worker_cli_end_to_end():
    """`sidecar.py --split-worker` chạy như một chương trình thật: file vào, zip ra, mã thoát 0."""
    import json

    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "in.pdf").write_bytes(_pdf(4))
        (d / "pairs.json").write_text(json.dumps([[0, 1], [2, 3]]))
        p = subprocess.run(
            [sys.executable, str(ROOT / "sidecar.py"), core.WORKER_FLAG, str(d / "in.pdf"), str(d / "out.zip"), str(d / "pairs.json")],
            capture_output=True,
            timeout=120,
        )
        assert p.returncode == core.EXIT_OK, (p.returncode, p.stderr[:300])
        assert p.stdout == b"", "stdout cua worker phai TRONG"
        assert zipfile.ZipFile(d / "out.zip").namelist() == ["part_001_p1-2.pdf", "part_002_p3-4.pdf"]


def test_worker_cli_failure_exits_one_with_the_library_text_on_stderr():
    import json

    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "in.pdf").write_bytes(b"not a pdf at all")
        (d / "pairs.json").write_text(json.dumps([[0, 0]]))
        p = subprocess.run(
            [sys.executable, str(ROOT / "sidecar.py"), core.WORKER_FLAG, str(d / "in.pdf"), str(d / "out.zip"), str(d / "pairs.json")],
            capture_output=True,
            timeout=120,
        )
        assert p.returncode == core.EXIT_INTERNAL, p.returncode
        assert p.stderr.strip(), "loi phai co noi dung tren stderr"
        assert not (d / "out.zip").exists()
        # thieu tham so => cung ma thoat, khong ne
        q = subprocess.run([sys.executable, str(ROOT / "sidecar.py"), core.WORKER_FLAG], capture_output=True, timeout=60)
        assert q.returncode == core.EXIT_INTERNAL and q.stderr.strip()


def test_worker_command_shape():
    cmd = api._split_worker_cmd("a.pdf", "b.zip", "p.json")
    assert cmd[0] == sys.executable and cmd[-3:] == ["a.pdf", "b.zip", "p.json"], cmd
    assert core.WORKER_FLAG in cmd
    if getattr(sys, "frozen", False):
        assert cmd[1] == core.WORKER_FLAG
    else:
        assert os.path.basename(cmd[1]) == "sidecar.py" and os.path.exists(cmd[1]), cmd[1]
        assert cmd[2] == core.WORKER_FLAG


# --------------------------------------------------------------------------- #
# luật cốt lõi: không chặn event loop
# --------------------------------------------------------------------------- #
def test_event_loop_keeps_running_while_the_worker_works():
    """Lý do tồn tại của BI-138: trước đây `insert_pdf` chạy thẳng trên event loop nên một lần tách chậm làm đứng cả
    sidecar. Ở đây worker (giả) ngủ 2 s; trong lúc ấy một coroutine khác phải tick đều."""
    ticks = []

    async def ticker():
        t_end = time.time() + 1.8
        while time.time() < t_end:
            ticks.append(time.time())
            await asyncio.sleep(0.05)

    async def both():
        with _FakeWorker("import time;time.sleep(2)"):
            return await asyncio.gather(api.split_pdf(_req(_pdf(3))), ticker())

    r, _ = _run(both())
    assert not r.success  # worker giả không tạo file: đúng, ta chỉ đo vòng lặp
    # Nếu route chặn loop trong 2 s, ticker chỉ tick được ~1 lần. Chạy tự do cho ~30 lần.
    assert len(ticks) >= 15, f"event loop bi chan: chi {len(ticks)} tick trong 1,8 s"
    gaps = [b - a for a, b in zip(ticks, ticks[1:])]
    assert max(gaps) < 0.5, f"event loop dung hinh {max(gaps):.2f}s"


# --------------------------------------------------------------------------- #
# hết giờ, chết, không khởi động được
# --------------------------------------------------------------------------- #
def test_timeout_kills_the_worker_and_reports_it():
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(25)"
        with _FakeWorker(code), _Timeout(1), _NoInProcess() as guard:
            t0 = time.time()
            r = _split(_pdf(3))
            dt = time.time() - t0
        assert not r.success and "nên đã dừng" in r.error and "giây" in r.error, r.error
        assert dt < 15, f"tra loi sau {dt:.1f}s - han gio khong cat duoc worker"
        assert guard.calls == 0, "het gio roi van chay lai tai cho"
        pid = int(pidfile.read_text())
        time.sleep(0.3)
        assert not _pid_alive(pid), f"worker pid {pid} van song sau han gio (mo coi)"


def test_timeout_message_speaks_minutes_when_the_limit_is_minutes():
    with _FakeWorker("import time;time.sleep(30)"), _Timeout(60):
        # Khong cho het 60 s: chi kiem cau chu bang cach goi thang ham voi han 60 va giet som.
        real_popen = api.subprocess.Popen
        try:
            def quick(*a, **k):
                p = real_popen(*a, **k)
                real_comm = p.communicate

                def comm(timeout=None):
                    return real_comm(timeout=0.5)  # ep het gio ngay, con so 60 van la cai in ra

                p.communicate = comm
                return p

            api.subprocess.Popen = quick
            r = _split(_pdf(2))
        finally:
            api.subprocess.Popen = real_popen
    assert not r.success and "1 phút" in r.error, r.error


def test_worker_crash_is_a_readable_error_and_the_server_survives():
    """Segfault của MuPDF = mã thoát lạ. Phải thành lỗi đọc được, KHÔNG phải 500, KHÔNG chạy tại chỗ, và yêu cầu kế
    tiếp vẫn chạy — đó là cả mục đích của tiến trình con."""
    with _FakeWorker("import sys;sys.stderr.write('simulated crash');sys.exit(3221225477 & 0x7fffffff)"), _NoInProcess() as g:
        r = _split(_pdf(3))
    assert not r.success and "simulated crash" in r.error, r.error
    assert g.calls == 0
    ok = _split(_pdf(3))  # worker that
    assert ok.success, ok.error


def test_library_message_from_the_worker_still_gets_the_vietnamese_translation():
    """Cha dịch stderr của con bằng `nice_pdf_error` — cùng câu người dùng đã đọc trước BI-138 (BI-125)."""
    with _FakeWorker("import sys;sys.stderr.write('22 is not in list');sys.exit(1)"):
        r = _split(_pdf(2))
    assert not r.success and r.error.startswith("Biểu mẫu (form)"), r.error
    assert "22 is not in list" in r.error, "mat nguyen van => het tra cuu duoc"


def test_worker_that_exits_zero_without_output_is_an_error():
    with _FakeWorker("pass"), _NoInProcess():
        r = _split(_pdf(2))
    assert not r.success and "không tạo ra file kết quả" in r.error, r.error


def test_unlaunchable_worker_falls_back_to_in_process_splitting():
    """Không sinh nổi tiến trình con ⇒ vẫn tách được (mất tính năng tệ hơn một rủi ro hiếm)."""
    real = api._split_worker_cmd
    api._split_worker_cmd = lambda s, d, p: [str(ROOT / "this-binary-does-not-exist.exe")]
    try:
        r = _split(_pdf(4), mode="every", size=2)
    finally:
        api._split_worker_cmd = real
    assert r.success, r.error
    assert r.count == 2, r.count


def test_temp_dirs_are_always_cleaned_up():
    before = _split_dirs()
    _split(_pdf(3))  # thanh cong
    with _FakeWorker("import sys;sys.exit(9)"):
        _split(_pdf(3))  # worker chet
    with _FakeWorker("import time;time.sleep(60)"), _Timeout(1):
        _split(_pdf(3))  # het gio
    api._split_worker_cmd, real = (lambda s, d, p: [str(ROOT / "no-such.exe")]), api._split_worker_cmd
    try:
        _split(_pdf(3))  # khong khoi dong duoc
    finally:
        api._split_worker_cmd = real
    leaked = _split_dirs() - before
    assert not leaked, f"temp dirs leaked: {sorted(leaked)}"


# --------------------------------------------------------------------------- #
# BI-139: nút HỦY — dùng chung sổ việc và /compress-cancel với nén (BI-126)
# --------------------------------------------------------------------------- #
def _jobs_snapshot() -> set[str]:
    return set(api._compress_jobs)


def test_cancel_mid_run_kills_the_worker_and_reports_cancelled_not_error():
    """Bấm Hủy giữa lúc worker đang chạy: giết ĐÚNG tiến trình con, route trả `cancelled` (không phải lỗi), KHÔNG
    chạy lõi tại chỗ, sidecar tiếp tục phục vụ (/compress-cancel được phục vụ NGAY trong lúc route còn chờ)."""
    before = _jobs_snapshot()
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(25)"

        async def both():
            with _FakeWorker(code), _NoInProcess() as guard:
                task = asyncio.create_task(api.split_pdf(_req(_pdf(3), job="job-cancel-1")))
                for _ in range(100):  # chờ worker thật sự chạy rồi mới hủy
                    if pidfile.exists() and pidfile.read_text():
                        break
                    await asyncio.sleep(0.1)
                t0 = time.time()
                huy = await api.compress_cancel(job="job-cancel-1")
                return await task, huy, time.time() - t0, guard.calls

        r, huy, dt, calls = _run(both())
        assert huy == {"success": True, "running": True}, huy
        assert not r.success and r.cancelled is True, (r.success, r.cancelled, r.error)
        assert r.error == "Đã hủy tách.", r.error
        assert dt < 10, f"huy mat {dt:.1f}s - tien trinh con khong bi giet"
        assert calls == 0, "huy xong lai chay tai cho"
        pid = int(pidfile.read_text())
        time.sleep(0.3)
        assert not _pid_alive(pid), f"worker pid {pid} van song sau khi huy (mo coi)"
    assert _jobs_snapshot() == before, "so viec bi ro o sau khi huy"


def test_cancel_arriving_before_the_route_registers_still_wins():
    """Cuộc đua số 2 của BI-126: Hủy tới TRƯỚC khi route kịp ghi sổ (thân request còn đang truyền) để lại 'bia mộ';
    route thấy nó và bỏ cuộc NGAY — không sinh worker nào, không động tới PDF."""
    before = _jobs_snapshot()
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        code = f"import os;open({str(pidfile)!r},'w').write(str(os.getpid()))"
        huy = _run(api.compress_cancel(job="job-tombstone"))
        assert huy["running"] is False, huy
        with _FakeWorker(code), _NoInProcess() as guard:
            r = _split(_pdf(3), job="job-tombstone")
        assert r.cancelled is True and not r.success and r.error == "Đã hủy tách.", r
        assert not pidfile.exists(), "bia mo van de worker chay"
        assert guard.calls == 0
    assert _jobs_snapshot() == before, "bia mo khong duoc don sau khi dung"


def test_cancel_set_before_popen_kills_the_worker_that_was_about_to_start():
    """Cuộc đua số 1: cờ đã bật lúc ta còn đang ghi file tạm. Worker THẬT, và kết quả KHÔNG được trả dù worker kịp
    chạy — cờ thắng cả mã thoát."""
    job = api._CompressJob()
    job.cancelled = True
    before = _split_dirs()
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        # Worker giả NGỦ LÂU: nếu cờ không giết nó ngay sau Popen thì phải chờ cả 25 s (rồi mới thấy cờ).
        code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(25)"
        with _FakeWorker(code):
            t0 = time.time()
            try:
                api._split_via_worker_blocking(_pdf(30), [(0, 14), (15, 29)], job)
                assert False, "expected CompressCancelled"
            except api._compress_core.CompressCancelled:
                pass
            dt = time.time() - t0
        assert dt < 10, f"co huy bat tu truoc nhung worker song them {dt:.1f}s - khong bi giet ngay sau Popen"
        if pidfile.exists() and pidfile.read_text():
            time.sleep(0.3)
            assert not _pid_alive(int(pidfile.read_text())), "worker mo coi sau khi huy"
    assert job.proc is None, "con tro tien trinh khong duoc de lai trong o so viec"
    assert not (_split_dirs() - before), "thu muc tam ro sau khi huy"


def test_cancel_wins_even_if_the_worker_finished_cleanly():
    """Worker thoát 0 và có file kết quả, nhưng cờ hủy đã bật ⇒ vẫn là HỦY (người dùng bảo dừng; không trả file)."""
    job = api._CompressJob()
    with _FakeWorker("import sys;sys.exit(0)"):
        # Giả lập: hủy tới SAU khi Popen nhưng cờ được đọc khi tiến trình đã dừng.
        real_popen = api.subprocess.Popen

        def popen(*a, **k):
            p = real_popen(*a, **k)
            job.cancelled = True  # bật ngay sau khi sinh tiến trình
            return p

        api.subprocess.Popen = popen
        try:
            api._split_via_worker_blocking(_pdf(2), [(0, 1)], job)
            assert False, "expected CompressCancelled"
        except api._compress_core.CompressCancelled:
            pass
        finally:
            api.subprocess.Popen = real_popen


def test_cancelling_another_job_does_not_touch_this_one():
    """Mã khác ⇒ hủy hư không. (Mã lệch một chữ giữa renderer và route cũng chỉ cho kết quả này — im lặng — nên
    ghim mã đi nguyên vẹn ở test JS.)"""
    before = _jobs_snapshot()

    async def both():
        with _FakeWorker("import time;time.sleep(1.5)"):
            task = asyncio.create_task(api.split_pdf(_req(_pdf(3), job="job-mine")))
            await asyncio.sleep(0.5)
            await api.compress_cancel(job="job-someone-else")
            return await task

    r = _run(both())
    assert r.cancelled is False, "huy nham viec cua nguoi khac"
    assert not r.success and "không tạo ra file kết quả" in r.error, r.error  # worker gia khong tao file: loi that
    # Dọn "bia mộ" của mã kia: nó nằm trong sổ cho tới khi có người dùng hoặc sổ đầy — không phải rò rỉ của route này.
    api._compress_jobs.pop("job-someone-else", None)
    assert _jobs_snapshot() == before


def test_split_without_a_job_id_is_unchanged_and_not_cancellable_by_empty_id():
    """Hợp đồng cũ: không có `job` thì không vào sổ, và một lệnh hủy với mã rỗng bị từ chối (400) chứ không hủy nhầm."""
    r = _split(_pdf(4), mode="every", size=2)
    assert r.success and r.cancelled is False and r.count == 2, (r.success, r.cancelled, r.count)
    try:
        _run(api.compress_cancel(job=""))
        assert False, "expected HTTPException"
    except api.HTTPException as e:
        assert e.status_code == 400, e.status_code


def test_cancel_contract_pins():
    """Ghim nguồn: hai nửa của hợp đồng (trường `job` ở request, `cancelled` ở response) và thứ tự bắt ngoại lệ."""
    import re

    assert api.SplitRequest(pdf_b64="").job == "", "SplitRequest.job phai mac dinh rong (hop dong cu)"
    assert api.ZipResponse(success=True).cancelled is False, "cac route dung chung ZipResponse khong duoc doi"
    src = Path(api.__file__).read_text(encoding="utf8")
    i = src.index('@app.post("/split"')
    khoi = src[i : src.index("# ---- P6: native text editing", i)]
    assert "_compress_job_slot(req.job)" in khoi, "route /split khong ghi so viec"
    assert "_split_via_worker_blocking, pdf_bytes, pairs, job" in khoi, "job khong toi duoc worker"
    # Hủy phải được bắt TRƯỚC `except Exception` (nếu không nó thành toast đỏ "Tách lỗi").
    m = re.search(r"except\s+Exception\b", khoi)
    assert khoi.index("except _compress_core.CompressCancelled") < m.start()
    assert "cancelled=True" in khoi


# --------------------------------------------------------------------------- #
# các câu 400 vẫn do CHA quyết (worker không bao giờ thấy yêu cầu sai)
# --------------------------------------------------------------------------- #
def test_bad_requests_are_still_400_and_never_reach_a_worker():
    called = []
    real = api._split_via_worker_blocking
    api._split_via_worker_blocking = lambda *a, **k: called.append(1)
    try:
        for kw, raw in (
            (dict(mode="ranges", ranges=""), _pdf(3)),  # khoang rong
            (dict(mode="every", size=1), _pdf(1001)),  # 1001 file > tran 1000
        ):
            try:
                _split(raw, **kw)
                assert False, "expected HTTPException"
            except api.HTTPException as e:
                assert e.status_code == 400, e.status_code
    finally:
        api._split_via_worker_blocking = real
    assert not called, "yeu cau sai da di toi worker"


# --------------------------------------------------------------------------- #
# ghim cấu trúc
# --------------------------------------------------------------------------- #
def test_split_core_is_a_leaf_module():
    """Worker chỉ được cần PyMuPDF. `src.pdf.util` kéo fastapi (0,27 s) nên cũng bị cấm. Ghim theo DANH SÁCH TRẮNG."""
    import re

    src = Path(core.__file__).read_text(encoding="utf8")
    head = src[src.index("from __future__") : src.index("WORKER_FLAG =")]
    mods = set()
    for line in head.splitlines():
        m = re.match(r"(?:from|import)\s+([\w.]+)", line.strip())
        if m:
            mods.add(m.group(1).split(".")[0])
    extra = mods - {"__future__", "io", "json", "sys", "zipfile"}
    assert not extra, f"import moi o cap module cua split.py: {sorted(extra)}"
    assert "import fitz" in src and "import fitz" not in head, "fitz phai nap luoi, trong ham"


def test_sidecar_dispatches_the_split_flag_before_importing_the_server():
    src = (ROOT / "sidecar.py").read_text(encoding="utf8")
    assert "from src.pdf.split import WORKER_FLAG as SPLIT_WORKER_FLAG" in src
    main = src[src.index("def main("):]
    i = main.index("SPLIT_WORKER_FLAG")
    assert i < main.index("import uvicorn"), "co split phai duoc xu ly TRUOC khi nap server"
    assert "_run_split_worker(sys.argv[2:])" in main


def test_route_no_longer_runs_insert_pdf_on_the_event_loop():
    """Ghim nguồn: khối route `/split` không được gọi lõi tách trực tiếp trên đường chính — chỉ qua worker, và chỉ
    gọi `split_to_zip` trong nhánh `except OSError` (không khởi động nổi worker)."""
    src = Path(api.__file__).read_text(encoding="utf8")
    i = src.index('@app.post("/split"')
    khoi = src[i : src.index("# ---- P6: native text editing", i)]
    assert "run_in_threadpool(_split_via_worker_blocking" in khoi
    assert "insert_pdf" not in khoi
    j = khoi.index("split_to_zip")
    assert "except OSError" in khoi[:j], "split_to_zip chay ngoai nhanh OSError => dung hinh tro lai"
    assert khoi.count("split_to_zip(") == 1


def test_timeout_is_a_ceiling_not_a_slow_detector():
    """Hạn giờ chặn 'mãi mãi', không bắt lỗi chậm (BI-123/BI-138). Xem số đo trong BI-138 về vì sao con số này."""
    assert 60 <= core.SPLIT_TIMEOUT_S <= 30 * 60, core.SPLIT_TIMEOUT_S


def test_split_timeout_is_not_a_plain_runtime_error_path():
    """`SplitTimeout` là lớp RIÊNG và route bắt nó TRƯỚC `Exception` chung — để câu hết giờ không bị `nice_pdf_error`
    nhào nặn và không bao giờ rơi vào đường 'worker chết'."""
    assert issubclass(core.SplitTimeout, RuntimeError) and core.SplitTimeout is not RuntimeError
    src = Path(api.__file__).read_text(encoding="utf8")
    i = src.index('@app.post("/split"')
    khoi = src[i : src.index("# ---- P6: native text editing", i)]
    # Bắt MỌI dạng `except Exception` (tên biến nào cũng vậy): một mutant đặt tên `e0` từng lọt qua ghim chỉ tìm
    # đúng chuỗi `except Exception as e:`. Hành vi của mutant đó TƯƠNG ĐƯƠNG (nice_pdf_error trả nguyên câu hết giờ),
    # nên chỉ có ghim nguồn này bắt được nó.
    import re

    m = re.search(r"except\s+Exception\b", khoi)
    assert m, "route /split khong con nhanh except Exception"
    assert khoi.index("except _split_core.SplitTimeout") < m.start(), (
        "SplitTimeout phai duoc bat TRUOC moi except Exception"
    )


# --------------------------------------------------------------------------- #
# file thật từ corpus (chỉ chạy nếu corpus có sẵn — nó nằm ngoài repo)
# --------------------------------------------------------------------------- #
def test_real_stuck_file_is_cut_off_and_the_loop_survives():
    """`bug1978317.pdf` kẹt ở `insert_pdf` (đo ≥100 s). Với hạn giờ 5 s, route phải trả lời gọn và event loop vẫn sống."""
    f = CORPUS / "bug1978317.pdf"
    if not f.exists():
        print("  (skip: khong co corpus)")
        return
    ticks = []

    async def ticker(stop):
        while not stop.is_set():
            ticks.append(time.time())
            await asyncio.sleep(0.1)

    async def both():
        stop = asyncio.Event()
        t = asyncio.create_task(ticker(stop))
        try:
            return await api.split_pdf(_req(f.read_bytes()))
        finally:
            stop.set()
            await t

    t0 = time.time()
    with _Timeout(5):
        r = _run(both())
    dt = time.time() - t0
    assert not r.success and "nên đã dừng" in r.error, r.error
    assert dt < 20, f"mat {dt:.1f}s"
    assert len(ticks) >= 30, f"event loop bi chan: {len(ticks)} tick"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except AssertionError as e:
            failed += 1
            print("FAIL", name, "-", str(e).encode("ascii", "replace").decode())
        except Exception as e:  # noqa: BLE001 - a crash is a failure too, and must not hide the rest
            failed += 1
            print("CRASH", name, "-", type(e).__name__, str(e).encode("ascii", "replace").decode())
    print("All split-worker tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
