"""BI-140 — `/add-page-numbers` chạy trong TIẾN TRÌNH CON, có trần giờ và nút Hủy.

Hành vi nghiệp vụ (đánh số đúng góc, trang xoay, garbage) đã có test ở `test_pdf_ops.py` / `test_write_garbage.py` — và vẫn
chạy nguyên văn, giờ đi qua worker. File này chỉ test PHẦN BỌC, và chạy tiến trình con THẬT (`sidecar.py --pagenum-worker`)
ở mọi chỗ có thể, vì cái cần chứng minh là hợp đồng cha ⇄ con.

CÁC LUẬT ĐƯỢC GHIM (mỗi luật có ít nhất một test sẽ ĐỎ nếu nó vỡ):
  · event loop KHÔNG bị chặn trong lúc đánh số (lý do tồn tại của cả thay đổi);
  · hết giờ ⇒ tiến trình con bị GIẾT (không mồ côi), route trả `success:false` với câu nói rõ hết giờ;
  · hết giờ / worker chết KHÔNG rơi về đánh số tại chỗ; chỉ khi không khởi động nổi worker mới lùi;
  · Hủy ⇒ giết tiến trình con, trả `cancelled` (không phải lỗi); cờ thắng cả mã thoát; bia mộ khi Hủy tới trước;
  · mọi thứ phụ thuộc `util` (nhãn, màu, `WRITE_GARBAGE`) do CHA dựng và gửi xuống — worker không import util;
  · đầu ra qua worker KHỚP đầu ra của hàm tại chỗ (cùng content stream từng trang, kể cả trang xoay);
  · thư mục tạm luôn được dọn; `pagenum.py` là module lá; `sidecar.py` nhận cờ.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import fitz  # PyMuPDF

import api
from src.pdf import pagenum as core

ROOT = Path(__file__).resolve().parent
CORPUS = Path(os.environ.get("NABU_CORPUS", r"D:\GitHub\_refs\pdfjs-corpus\test\pdfs"))


# --------------------------------------------------------------------------- #
# dựng đồ
# --------------------------------------------------------------------------- #
def _run(coro):
    return asyncio.run(coro)


def _pdf(n: int, rots=()) -> bytes:
    d = fitz.open()
    for i in range(n):
        d.new_page(width=400, height=300).insert_text((50, 80), f"content {i + 1}")
    for i, r in enumerate(rots):
        d[i].set_rotation(r)
    b = d.tobytes()
    d.close()
    return b


def _req(raw: bytes, **kw) -> "api.PageNumberRequest":
    return api.PageNumberRequest(pdf_b64=base64.b64encode(raw).decode(), **kw)


def _stamp(raw: bytes, **kw):
    return _run(api.add_page_numbers(_req(raw, **kw)))


def _out(resp) -> "fitz.Document":
    return fitz.open(stream=base64.b64decode(resp.data_b64), filetype="pdf")


def _fingerprint(doc) -> list:
    return [[p.rotation, [round(v, 3) for v in p.rect], hashlib.sha256(p.read_contents()).hexdigest()] for p in doc]


def _dirs() -> set[str]:
    return {p.name for p in Path(tempfile.gettempdir()).glob("nabu-pagenum-*")}


class _FakeWorker:
    """Đổi `_pagenum_worker_cmd` bằng một lệnh python tùy ý trong lúc test, rồi trả lại."""

    def __init__(self, code: str):
        self.code = code

    def __enter__(self):
        self.real = api._pagenum_worker_cmd
        api._pagenum_worker_cmd = lambda s, d, p: [sys.executable, "-c", self.code]
        return self

    def __exit__(self, *a):
        api._pagenum_worker_cmd = self.real


class _Timeout:
    def __init__(self, s: int):
        self.s = s

    def __enter__(self):
        self.real = core.PAGENUM_TIMEOUT_S
        core.PAGENUM_TIMEOUT_S = self.s

    def __exit__(self, *a):
        core.PAGENUM_TIMEOUT_S = self.real


class _NoInProcess:
    """Cấm lõi chạy TẠI CHỖ: nếu ai gọi `stamp_page_numbers` trong tiến trình sidecar, test sẽ biết."""

    def __enter__(self):
        self.real = core.stamp_page_numbers
        self.calls = 0

        def boom(*a, **k):
            self.calls += 1
            raise AssertionError("stamp_page_numbers chay TAI CHO trong tien trinh sidecar")

        core.stamp_page_numbers = boom
        return self

    def __exit__(self, *a):
        core.stamp_page_numbers = self.real


def _pid_alive(pid: int) -> bool:
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in out


def _jobs() -> set[str]:
    return set(api._compress_jobs)


# --------------------------------------------------------------------------- #
# đường thật: route + worker thật
# --------------------------------------------------------------------------- #
def test_route_numbers_through_the_real_worker():
    r = _stamp(_pdf(4), fmt="n_of_n", start_at=5, skip_first=1)
    assert r.success, r.error
    assert r.pages == 4, r.pages
    d = _out(r)
    try:
        txt = [d[i].get_text() for i in range(4)]
    finally:
        d.close()
    assert "/" not in txt[0] and "content 1" in txt[0], "trang bia (skip_first=1) bi danh so"
    # start_at=5, 3 trang duoc danh => 5,6,7 ; mau so cuoi "x / 7"
    assert "5 / 7" in txt[1] and "6 / 7" in txt[2] and "7 / 7" in txt[3], txt


def test_worker_output_equals_the_in_process_core_on_rotated_pages():
    """Hai đường dùng chung `stamp_page_numbers` nhưng đi qua JSON + tiến trình: số float, nhãn, màu không được lệch.
    So từng content stream (trang xoay 90/180/270 là chỗ dễ lệch nhất — BI-45/BI-65)."""
    raw = _pdf(6, rots=(90, 180, 270, 0, 90, 270))
    plan = {
        "skip": 1,
        "labels": [f"Trang {i} / 5" for i in range(1, 6)],
        "fs": 13.5,
        "margin": 17.25,
        "col": [0.1, 0.2 + 1 / 3, 0.9],
        "vpos": "top",
        "hpos": "right",
        "garbage": 2,
    }
    inproc, _ = core.stamp_page_numbers(raw, plan)
    via_worker, pages = api._pagenum_via_worker_blocking(raw, plan, 6)
    assert pages == 6
    a = fitz.open(stream=inproc, filetype="pdf")
    b = fitz.open(stream=via_worker, filetype="pdf")
    try:
        assert _fingerprint(a) == _fingerprint(b), "dau ra qua worker khac dau ra tai cho"
    finally:
        a.close()
        b.close()


def test_numbers_are_upright_and_in_the_visible_corner_on_rotated_pages():
    """Hành vi nghiệp vụ mà test so-với-hàm-tại-chỗ KHÔNG thấy (cả hai dùng chung một hàm nên sai cùng nhau): trên
    trang có /Rotate 90/180/270 số phải NẰM THẲNG (hướng đọc ngang trong khung hiển thị) và ở đúng góc NHÌN THẤY
    (BI-45/BI-65). Đột biến `rotate=0` làm số nằm nghiêng ở trang xoay mà không test nào khác đỏ."""
    raw = _pdf(4, rots=(0, 90, 180, 270))
    r = _stamp(raw, fmt="n", position="bottom-center", margin=28.0, font_size=12.0, color="#000000")
    assert r.success, r.error
    d = _out(r)
    try:
        for i in range(4):
            page = d[i]
            want = str(i + 1)
            spans = []
            for blk in page.get_text("dict")["blocks"]:
                for ln in blk.get("lines", []):
                    for sp in ln["spans"]:
                        if sp["text"].strip() == want:
                            spans.append((ln["dir"], sp["bbox"]))
            assert spans, f"khong thay so {want} tren trang {i + 1} (xoay {page.rotation})"
            (dx0, dy0), bbox0 = spans[-1]
            # `get_text` tra toa do VA huong trong khong gian trang CHUA xoay; anh xa sang khung HIEN THI roi moi so.
            # (Lan dau toi so thang va thay "nghieng" o chinh ma dung: huong (0,-1) o trang xoay 90 la so NAM THANG.)
            rm = page.rotation_matrix
            dx, dy = tuple(fitz.Point(dx0, dy0) * fitz.Matrix(rm.a, rm.b, rm.c, rm.d, 0, 0))
            bbox = tuple(fitz.Rect(bbox0) * rm)
            rect = page.rect  # khung HIEN THI (da ap /Rotate)
            assert abs(dx - 1.0) < 1e-3 and abs(dy) < 1e-3, f"trang {i + 1} xoay {page.rotation}: so nam nghieng dir={dx, dy}"
            cx = (bbox[0] + bbox[2]) / 2
            assert abs(cx - rect.width / 2) < 3, f"trang {i + 1}: so khong o giua duoi (cx={cx:.1f}, giua={rect.width / 2:.1f})"
            assert rect.height - bbox[3] < 40 and bbox[3] <= rect.height, f"trang {i + 1}: so khong sat day (y1={bbox[3]:.1f}, cao={rect.height:.1f})"
    finally:
        d.close()


def test_route_builds_the_plan_in_the_parent_including_write_garbage():
    """Cha dựng nhãn/màu/mức garbage và GỬI XUỐNG — worker không import util. `WRITE_GARBAGE` phải là giá trị của util
    (BI-23 ghim nó), không phải số cứng ở worker."""
    from src.pdf.util import WRITE_GARBAGE

    seen = {}
    real = api._pagenum_via_worker_blocking

    def spy(pdf_bytes, plan, n_pages, job=None):
        seen.update(plan=plan, n=n_pages)
        return real(pdf_bytes, plan, n_pages, job)

    api._pagenum_via_worker_blocking = spy
    try:
        r = _stamp(_pdf(3), fmt="dash_n", position="top-left", color="#ff0000", font_size=20.0, margin=10.0, skip_first=1)
    finally:
        api._pagenum_via_worker_blocking = real
    assert r.success, r.error
    p = seen["plan"]
    assert seen["n"] == 3
    assert p["garbage"] == WRITE_GARBAGE
    assert p["labels"] == ["- 1 -", "- 2 -"], p["labels"]
    assert p["col"] == [1.0, 0.0, 0.0] and (p["vpos"], p["hpos"]) == ("top", "left"), p
    assert (p["fs"], p["margin"], p["skip"]) == (20.0, 10.0, 1), p


def test_skip_beyond_page_count_stamps_nothing_and_still_succeeds():
    r = _stamp(_pdf(2), skip_first=5)
    assert r.success and r.pages == 2, (r.success, r.error)
    d = _out(r)
    try:
        assert all(re.fullmatch(r"content \d\s*", d[i].get_text()) for i in range(2)), "co trang bi danh so"
    finally:
        d.close()


def test_mismatched_label_count_is_an_error_not_a_silent_misnumbering():
    """Cha và con nhìn hai tài liệu khác nhau (số nhãn ≠ số trang cần đánh) ⇒ lỗi, không đóng dấu sai im lặng."""
    try:
        core.stamp_page_numbers(_pdf(3), dict(skip=0, labels=["1", "2"], fs=11.0, margin=28.0, col=[0, 0, 0],
                                              vpos="bottom", hpos="center", garbage=2))
        assert False, "expected ValueError"
    except ValueError as e:
        assert "không khớp" in str(e), str(e)


def test_worker_cli_end_to_end_and_failure_codes():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "in.pdf").write_bytes(_pdf(3))
        plan = dict(skip=0, labels=["1", "2", "3"], fs=11.0, margin=28.0, col=[0, 0, 0], vpos="bottom", hpos="center", garbage=2)
        (d / "plan.json").write_text(json.dumps(plan))
        cmd = [sys.executable, str(ROOT / "sidecar.py"), core.WORKER_FLAG, str(d / "in.pdf"), str(d / "out.pdf"), str(d / "plan.json")]
        p = subprocess.run(cmd, capture_output=True, timeout=120)
        assert p.returncode == core.EXIT_OK and p.stdout == b"", (p.returncode, p.stdout[:100], p.stderr[:300])
        o = fitz.open(str(d / "out.pdf"))
        try:
            assert o.page_count == 3 and "3" in o[2].get_text()
        finally:
            o.close()
        # file hong -> ma 1 + stderr co noi dung + khong ghi ket qua
        (d / "in.pdf").write_bytes(b"not a pdf")
        (d / "out.pdf").unlink()
        q = subprocess.run(cmd, capture_output=True, timeout=120)
        assert q.returncode == core.EXIT_INTERNAL and q.stderr.strip() and not (d / "out.pdf").exists()
        # thieu tham so
        z = subprocess.run([sys.executable, str(ROOT / "sidecar.py"), core.WORKER_FLAG], capture_output=True, timeout=60)
        assert z.returncode == core.EXIT_INTERNAL and z.stderr.strip()


def test_worker_command_shape():
    cmd = api._pagenum_worker_cmd("a.pdf", "b.pdf", "p.json")
    assert cmd[0] == sys.executable and cmd[-3:] == ["a.pdf", "b.pdf", "p.json"], cmd
    assert core.WORKER_FLAG in cmd
    if getattr(sys, "frozen", False):
        assert cmd[1] == core.WORKER_FLAG
    else:
        assert os.path.basename(cmd[1]) == "sidecar.py" and os.path.exists(cmd[1]), cmd[1]


# --------------------------------------------------------------------------- #
# luật cốt lõi: không chặn event loop
# --------------------------------------------------------------------------- #
def test_event_loop_keeps_running_while_the_worker_works():
    ticks = []

    async def ticker():
        t_end = time.time() + 1.8
        while time.time() < t_end:
            ticks.append(time.time())
            await asyncio.sleep(0.05)

    async def both():
        with _FakeWorker("import time;time.sleep(2)"):
            return await asyncio.gather(api.add_page_numbers(_req(_pdf(3))), ticker())

    r, _ = _run(both())
    assert not r.success  # worker giả không tạo file: đúng, ta chỉ đo vòng lặp
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
            r = _stamp(_pdf(3))
            dt = time.time() - t0
        assert not r.success and "nên đã dừng" in r.error and "giây" in r.error, r.error
        assert r.cancelled is False
        assert dt < 15, f"tra loi sau {dt:.1f}s - han gio khong cat duoc worker"
        assert guard.calls == 0, "het gio roi van chay lai tai cho"
        pid = int(pidfile.read_text())
        time.sleep(0.3)
        assert not _pid_alive(pid), f"worker pid {pid} van song sau han gio (mo coi)"


def test_worker_crash_is_a_readable_error_and_the_server_survives():
    with _FakeWorker("import sys;sys.stderr.write('simulated crash');sys.exit(3221225477 & 0x7fffffff)"), _NoInProcess() as g:
        r = _stamp(_pdf(3))
    assert not r.success and "simulated crash" in r.error, r.error
    assert g.calls == 0
    assert _stamp(_pdf(3)).success, "yeu cau ke tiep khong chay duoc"


def test_library_message_from_the_worker_still_gets_the_vietnamese_translation():
    with _FakeWorker("import sys;sys.stderr.write('cannot save with zero pages');sys.exit(1)"):
        r = _stamp(_pdf(2))
    assert not r.success and r.error.startswith("PDF này không có trang nào."), r.error
    assert "cannot save with zero pages" in r.error, "mat nguyen van => het tra cuu duoc"


def test_worker_that_exits_zero_without_output_is_an_error():
    with _FakeWorker("pass"), _NoInProcess():
        r = _stamp(_pdf(2))
    assert not r.success and "không tạo ra file kết quả" in r.error, r.error


def test_unlaunchable_worker_falls_back_to_in_process_stamping():
    real = api._pagenum_worker_cmd
    api._pagenum_worker_cmd = lambda s, d, p: [str(ROOT / "this-binary-does-not-exist.exe")]
    try:
        r = _stamp(_pdf(3), skip_first=1)
    finally:
        api._pagenum_worker_cmd = real
    assert r.success, r.error
    d = _out(r)
    try:
        assert d.page_count == 3 and "3" in d[2].get_text()
    finally:
        d.close()


def test_temp_dirs_are_always_cleaned_up():
    before = _dirs()
    _stamp(_pdf(3))
    with _FakeWorker("import sys;sys.exit(9)"):
        _stamp(_pdf(3))
    with _FakeWorker("import time;time.sleep(60)"), _Timeout(1):
        _stamp(_pdf(3))
    real = api._pagenum_worker_cmd
    api._pagenum_worker_cmd = lambda s, d, p: [str(ROOT / "no-such.exe")]
    try:
        _stamp(_pdf(3))
    finally:
        api._pagenum_worker_cmd = real
    leaked = _dirs() - before
    assert not leaked, f"temp dirs leaked: {sorted(leaked)}"


# --------------------------------------------------------------------------- #
# các câu 400 vẫn do CHA quyết (worker không bao giờ thấy yêu cầu sai)
# --------------------------------------------------------------------------- #
def test_bad_requests_are_still_400_and_never_reach_a_worker():
    called = []
    real = api._pagenum_via_worker_blocking
    api._pagenum_via_worker_blocking = lambda *a, **k: called.append(1)
    zero = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
            b"trailer<</Root 1 0 R/Size 3>>\n%%EOF\n")
    try:
        for kw, raw, detail in (
            (dict(position="middle"), _pdf(2), "position không hợp lệ"),
            (dict(fmt="roman"), _pdf(2), "fmt không hợp lệ"),
            (dict(), zero, "PDF không có trang nào."),
        ):
            try:
                _stamp(raw, **kw)
                assert False, "expected HTTPException"
            except api.HTTPException as e:
                assert e.status_code == 400 and e.detail == detail, (e.status_code, e.detail)
    finally:
        api._pagenum_via_worker_blocking = real
    assert not called, "yeu cau sai da di toi worker"


# --------------------------------------------------------------------------- #
# nút HỦY — dùng chung sổ việc và /compress-cancel với nén (BI-126) và tách (BI-139)
# --------------------------------------------------------------------------- #
def test_cancel_mid_run_kills_the_worker_and_reports_cancelled_not_error():
    before = _jobs()
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(25)"

        async def both():
            with _FakeWorker(code), _NoInProcess() as guard:
                task = asyncio.create_task(api.add_page_numbers(_req(_pdf(3), job="pn-cancel-1")))
                for _ in range(100):
                    if pidfile.exists() and pidfile.read_text():
                        break
                    await asyncio.sleep(0.1)
                t0 = time.time()
                huy = await api.compress_cancel(job="pn-cancel-1")
                return await task, huy, time.time() - t0, guard.calls

        r, huy, dt, calls = _run(both())
        assert huy == {"success": True, "running": True}, huy
        assert not r.success and r.cancelled is True and r.error == "Đã hủy đánh số.", (r.success, r.cancelled, r.error)
        assert dt < 10, f"huy mat {dt:.1f}s - tien trinh con khong bi giet"
        assert calls == 0, "huy xong lai chay tai cho"
        pid = int(pidfile.read_text())
        time.sleep(0.3)
        assert not _pid_alive(pid), f"worker pid {pid} van song sau khi huy (mo coi)"
    assert _jobs() == before, "so viec bi ro o sau khi huy"


def test_cancel_arriving_before_the_route_registers_still_wins():
    before = _jobs()
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        code = f"import os;open({str(pidfile)!r},'w').write(str(os.getpid()))"
        assert _run(api.compress_cancel(job="pn-tombstone"))["running"] is False
        with _FakeWorker(code), _NoInProcess() as guard:
            r = _stamp(_pdf(3), job="pn-tombstone")
        assert r.cancelled is True and not r.success and r.error == "Đã hủy đánh số.", r
        assert not pidfile.exists(), "bia mo van de worker chay"
        assert guard.calls == 0
    assert _jobs() == before, "bia mo khong duoc don sau khi dung"


def test_cancel_set_before_popen_kills_the_worker_that_was_about_to_start():
    job = api._CompressJob()
    job.cancelled = True
    before = _dirs()
    with tempfile.TemporaryDirectory() as d:
        pidfile = Path(d) / "pid.txt"
        code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(25)"
        with _FakeWorker(code):
            t0 = time.time()
            try:
                api._pagenum_via_worker_blocking(_pdf(3), dict(skip=0, labels=["1", "2", "3"], fs=11.0, margin=28.0,
                                                               col=[0, 0, 0], vpos="bottom", hpos="center", garbage=2), 3, job)
                assert False, "expected CompressCancelled"
            except api._compress_core.CompressCancelled:
                pass
            dt = time.time() - t0
        assert dt < 10, f"co huy bat tu truoc nhung worker song them {dt:.1f}s - khong bi giet ngay sau Popen"
        if pidfile.exists() and pidfile.read_text():
            time.sleep(0.3)
            assert not _pid_alive(int(pidfile.read_text())), "worker mo coi sau khi huy"
    assert job.proc is None, "con tro tien trinh khong duoc de lai trong o so viec"
    assert not (_dirs() - before), "thu muc tam ro sau khi huy"


def test_cancel_wins_even_if_the_worker_finished_cleanly():
    job = api._CompressJob()
    real_popen = api.subprocess.Popen

    def popen(*a, **k):
        p = real_popen(*a, **k)
        job.cancelled = True  # bat ngay sau khi sinh tien trinh
        return p

    with _FakeWorker("import sys;sys.exit(0)"):
        api.subprocess.Popen = popen
        try:
            api._pagenum_via_worker_blocking(_pdf(2), {}, 2, job)
            assert False, "expected CompressCancelled"
        except api._compress_core.CompressCancelled:
            pass
        finally:
            api.subprocess.Popen = real_popen


def test_cancelling_another_job_does_not_touch_this_one():
    before = _jobs()

    async def both():
        with _FakeWorker("import time;time.sleep(1.5)"):
            task = asyncio.create_task(api.add_page_numbers(_req(_pdf(3), job="pn-mine")))
            await asyncio.sleep(0.5)
            await api.compress_cancel(job="pn-someone-else")
            return await task

    r = _run(both())
    assert r.cancelled is False, "huy nham viec cua nguoi khac"
    assert not r.success and "không tạo ra file kết quả" in r.error, r.error
    api._compress_jobs.pop("pn-someone-else", None)  # bia mo cua ma kia: khong phai ro ri cua route nay
    assert _jobs() == before


def test_no_job_id_keeps_the_old_contract():
    r = _stamp(_pdf(3))
    assert r.success and r.cancelled is False and r.pages == 3, (r.success, r.cancelled, r.pages)
    assert api.PageNumberRequest(pdf_b64="").job == "", "PageNumberRequest.job phai mac dinh rong"
    assert api.PdfBytesResponse(success=True).cancelled is False, "cac route dung chung PdfBytesResponse khong duoc doi"


# --------------------------------------------------------------------------- #
# ghim cấu trúc
# --------------------------------------------------------------------------- #
def _route_src() -> str:
    src = Path(api.__file__).read_text(encoding="utf8")
    i = src.index('@app.post("/add-page-numbers"')
    return src[i : src.index("# ---- P7: render PDF pages to images", i)]


def test_pagenum_core_is_a_leaf_module():
    """Worker chỉ được cần PyMuPDF. `src.pdf.util` kéo fastapi (0,27 s) nên cũng bị cấm. Ghim theo DANH SÁCH TRẮNG."""
    src = Path(core.__file__).read_text(encoding="utf8")
    head = src[src.index("from __future__") : src.index("WORKER_FLAG =")]
    mods = set()
    for line in head.splitlines():
        m = re.match(r"(?:from|import)\s+([\w.]+)", line.strip())
        if m:
            mods.add(m.group(1).split(".")[0])
    extra = mods - {"__future__", "json", "sys"}
    assert not extra, f"import moi o cap module cua pagenum.py: {sorted(extra)}"
    assert "import fitz" in src and "import fitz" not in head, "fitz phai nap luoi, trong ham"
    assert "src.pdf.util" not in src.replace("`src.pdf.util`", ""), "pagenum.py khong duoc import util"


def test_sidecar_dispatches_the_pagenum_flag_before_importing_the_server():
    src = (ROOT / "sidecar.py").read_text(encoding="utf8")
    assert "from src.pdf.pagenum import WORKER_FLAG as PAGENUM_WORKER_FLAG" in src
    main = src[src.index("def main("):]
    assert main.index("PAGENUM_WORKER_FLAG") < main.index("import uvicorn"), "co pagenum phai duoc xu ly TRUOC khi nap server"
    assert "_run_pagenum_worker(sys.argv[2:])" in main


def test_route_no_longer_runs_insert_text_on_the_event_loop():
    khoi = _route_src()
    assert "run_in_threadpool(" in khoi and "_pagenum_via_worker_blocking" in khoi
    assert "insert_text" not in khoi
    j = khoi.index("stamp_page_numbers")
    assert "except OSError" in khoi[:j], "stamp_page_numbers chay ngoai nhanh OSError => dung hinh tro lai"
    assert khoi.count("stamp_page_numbers(") == 1


def test_exceptions_are_caught_in_the_right_order():
    """`PageNumberTimeout` và `CompressCancelled` được bắt TRƯỚC `except Exception` cuối (không thì thành 'lỗi' đỏ)."""
    khoi = _route_src()
    tail = khoi[khoi.index("with _compress_job_slot(req.job)") :]
    m = re.search(r"except\s+Exception\b", tail)
    assert m, "route khong con nhanh except Exception"
    assert tail.index("except _pagenum_core.PageNumberTimeout") < m.start()
    assert tail.index("except _compress_core.CompressCancelled") < m.start()
    assert "cancelled=True" in tail
    assert issubclass(core.PageNumberTimeout, RuntimeError) and core.PageNumberTimeout is not RuntimeError
    assert re.search(r"_pagenum_via_worker_blocking,\s*pdf_bytes,\s*plan,\s*n_pages,\s*job\b", khoi), \
        "job khong toi duoc worker"


def test_timeout_is_a_ceiling_not_a_slow_detector():
    """Hạn giờ chặn 'mãi mãi', không bắt lỗi chậm (BI-123/BI-138/BI-140). Xem số đo trong BI-140."""
    assert 60 <= core.PAGENUM_TIMEOUT_S <= 30 * 60, core.PAGENUM_TIMEOUT_S


# --------------------------------------------------------------------------- #
# file thật từ corpus (chỉ chạy nếu corpus có sẵn — nó nằm ngoài repo)
# --------------------------------------------------------------------------- #
def test_real_hanging_file_is_cut_off_and_the_loop_survives():
    """`bomb_giant.pdf` treo trong `insert_text` của trang đầu (đo > 60 s). Với hạn giờ 5 s, route trả lời gọn và event
    loop vẫn sống; và Hủy cũng cắt được nó."""
    f = CORPUS / "bomb_giant.pdf"
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
            return await api.add_page_numbers(_req(f.read_bytes()))
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
    print("All pagenum-worker tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
