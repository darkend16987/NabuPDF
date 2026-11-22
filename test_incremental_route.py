"""BI-129 — route `/save-incremental-bin`, tiến trình con `--incremental-worker`, hạn giờ.

Lõi (`src/pdf/incremental.py`) có test riêng ở `test_incremental.py`. File này chỉ test PHẦN BỌC — và nó chạy tiến
trình con THẬT (`sidecar.py --incremental-worker`) ở mọi chỗ có thể, vì cái cần chứng minh là hợp đồng giữa cha và con
(mã thoát, stderr, file meta) chứ không phải logic Python thuần.

CÁC LUẬT ĐƯỢC GHIM (mỗi luật có ít nhất một test sẽ ĐỎ nếu nó vỡ):
  · mọi thất bại có chủ đích là MỘT dạng JSON `refused` (HTTP 200) — chỉ yêu cầu SAI mới là 400;
  · hết giờ ⇒ tiến trình con bị GIẾT (không mồ côi) và route trả `timeout`;
  · worker chết ⇒ `worker_failed`, sidecar VẪN trả lời yêu cầu kế tiếp (đó là cả mục đích của tiến trình con);
  · không khởi động nổi worker ⇒ `worker_unavailable`, và KHÔNG chạy lõi tại chỗ (segfault sẽ giết sidecar);
  · sidecar KHÔNG BAO GIỜ ghi vào file gốc của người dùng;
  · thư mục tạm luôn được dọn, kể cả khi từ chối / hết giờ;
  · kết quả của route đi qua cổng BI-127 ở phía JS (`signed-scan.js`) mà không bị hỏi — và bản dựng lại thì bị.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import fitz  # PyMuPDF

import api
from src.pdf import incremental as inc

ROOT = Path(__file__).resolve().parent
CORPUS = Path(os.environ.get("NABU_CORPUS", r"D:\GitHub\_refs\pdfjs-corpus\test\pdfs"))


# --------------------------------------------------------------------------- #
# dựng đồ
# --------------------------------------------------------------------------- #
def _run(coro):
    return asyncio.run(coro)


def _req(body: bytes) -> api.Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return api.Request({"type": "http", "method": "POST", "path": "/save-incremental-bin", "headers": []}, receive)


def _call(original: Path, edited: bytes, path_param=None):
    return _run(api.save_incremental_bin(_req(edited), original_path=str(original) if path_param is None else path_param))


def _tmp():
    return tempfile.TemporaryDirectory(prefix="nabu-test-route-")


def _base(path: Path, with_sig=True, encrypt=False):
    doc = fitz.open()
    for i in range(3):
        doc.new_page(width=300, height=300).insert_text((40, 80), f"page {i + 1} body", fontsize=14)
    if with_sig:
        x = doc.get_new_xref()
        doc.update_object(x, "<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <00112233> >>")
    kw = dict(garbage=0, use_objstms=0)
    if encrypt:
        kw.update(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o")
    doc.save(str(path), **kw)
    doc.close()


def _edited_bytes(src: Path, rotate=True, text="NEW TEXT") -> bytes:
    with tempfile.TemporaryDirectory(prefix="nabu-test-route-e-") as d:
        e = Path(d) / "e.pdf"
        with fitz.open(str(src)) as doc:
            if rotate:
                doc[0].set_rotation(90)
            if text:
                doc[1].insert_text((40, 200), text, fontsize=12)
            doc.save(str(e), garbage=0, use_objstms=0)
        return e.read_bytes()


def _incr_dirs():
    t = Path(tempfile.gettempdir())
    return {p.name for p in t.glob("nabu-incr-*")}


def _json(resp):
    import json

    assert resp.status_code == 200, resp.status_code
    assert resp.media_type in (None, "application/json") or "json" in (resp.media_type or ""), resp.media_type
    return json.loads(resp.body)


def _pid_alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype = wintypes.HANDLE
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False  # khong mo duoc ⇒ khong con
    try:
        code = wintypes.DWORD()
        k.GetExitCodeProcess(h, ctypes.byref(code))
        return code.value == 259  # STILL_ACTIVE
    finally:
        k.CloseHandle(h)


class _FakeWorker:
    """Doi `_incremental_worker_cmd` bang mot lenh python tuy y trong luc test, roi tra lai."""

    def __init__(self, code: str):
        self.code = code

    def __enter__(self):
        self.real = api._incremental_worker_cmd
        api._incremental_worker_cmd = lambda o, e, out: [sys.executable, "-c", self.code]
        return self

    def __exit__(self, *a):
        api._incremental_worker_cmd = self.real


# --------------------------------------------------------------------------- #
# route: thành công, và hình dạng của nó
# --------------------------------------------------------------------------- #
def test_route_returns_merged_pdf_with_original_bytes_as_prefix():
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        edited = _edited_bytes(o)
        r = _call(o, edited)
        ob = o.read_bytes()
        assert r.status_code == 200 and r.media_type == "application/pdf", (r.status_code, r.media_type)
        assert r.body[: len(ob)] == ob, "original bytes must be a byte-identical prefix of the response"
        h = r.headers
        assert h["x-original-size"] == str(len(ob)) and h["x-result-size"] == str(len(r.body)), dict(h)
        assert int(h["x-changed"]) >= 1 and "x-unchanged" not in h, dict(h)
        with fitz.open(stream=r.body, filetype="pdf") as res:
            assert res[0].rotation == 90 and "NEW TEXT" in res[1].get_text()


def test_route_flags_an_identical_edit_and_returns_the_original():
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        r = _call(o, o.read_bytes())
        assert r.headers.get("x-unchanged") == "1", dict(r.headers)
        assert r.body == o.read_bytes(), "unchanged input must come back verbatim"


def test_route_never_touches_the_original_file():
    """Sidecar chi DOC file goc; ghi la viec cua main (sau cong BI-127). Byte va mtime deu khong doi."""
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        before_bytes, before_mtime = o.read_bytes(), o.stat().st_mtime_ns
        _call(o, _edited_bytes(o))
        _json(_call(o, b"%PDF-1.4 definitely not what the original is"))  # ca tu choi cung khong duoc cham toi
        assert o.read_bytes() == before_bytes and o.stat().st_mtime_ns == before_mtime
        assert not list(Path(d).glob("*.part")) and not list(Path(d).glob("*.meta.json")), sorted(p.name for p in Path(d).iterdir())


# --------------------------------------------------------------------------- #
# route: mọi thất bại có chủ đích là MỘT dạng JSON
# --------------------------------------------------------------------------- #
def test_every_refusal_is_one_json_shape_with_http_200():
    with _tmp() as d:
        d = Path(d)
        enc, plain = d / "enc.pdf", d / "plain.pdf"
        _base(enc, encrypt=True)
        _base(plain)
        junk = d / "junk.pdf"
        junk.write_bytes(b"not a pdf " * 50)
        edited = _edited_bytes(plain)
        cases = {
            "encrypted": _call(enc, edited),
            "original_missing": _call(d / "gone.pdf", edited),
            "not_pdf": _call(junk, edited),
        }
        for want, resp in cases.items():
            j = _json(resp)
            assert j["success"] is False and j["refused"] is True, (want, j)
            assert j["reason"] == want, (want, j)
            assert isinstance(j["detail"], str) and j["detail"], (want, j)


def test_malformed_requests_are_400_not_refusals():
    """Yeu cau SAI la loi cua nguoi goi; chi 'khong the lam' moi la refused."""
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        edited = _edited_bytes(o)
        bad = [
            ("", edited),                       # thieu duong dan
            ("relative/o.pdf", edited),         # khong tuyet doi
            (str(Path(d) / "o.txt"), edited),   # duoi khong phai .pdf
            (str(o), b""),                      # than rong
        ]
        for path_param, body in bad:
            try:
                _run(api.save_incremental_bin(_req(body), original_path=path_param))
            except api.HTTPException as e:
                assert e.status_code == 400, (path_param, e.status_code)
            else:
                assert False, f"expected HTTP 400 for path={path_param!r} body={len(body)}B"


# --------------------------------------------------------------------------- #
# tiến trình con THẬT: hợp đồng mã thoát
# --------------------------------------------------------------------------- #
def _worker(*argv):
    return subprocess.run(
        [sys.executable, str(ROOT / "sidecar.py"), inc.WORKER_FLAG, *argv], capture_output=True, timeout=120
    )


def test_worker_exit_code_contract():
    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        _base(o)
        e.write_bytes(_edited_bytes(o))
        r = _worker(str(o), str(e), str(out))
        assert r.returncode == inc.EXIT_OK and r.stdout == b"", (r.returncode, r.stdout, r.stderr)
        assert out.exists() and Path(inc.meta_path(str(out))).exists()
        import json

        meta = json.loads(Path(inc.meta_path(str(out))).read_text(encoding="utf-8"))
        assert set(meta) == {"changed", "added", "reused", "unchanged"} and meta["changed"] >= 1, meta

        # Tu choi co chu dich: ma 5, stderr = "ly_do<TAB>chi_tiet", stdout van trong, KHONG co file ket qua.
        enc = d / "enc.pdf"
        _base(enc, encrypt=True)
        out2 = d / "out2.pdf"
        r = _worker(str(enc), str(e), str(out2))
        assert r.returncode == inc.EXIT_REFUSED and r.stdout == b"", (r.returncode, r.stdout)
        reason, _, detail = r.stderr.decode("utf-8").partition("\t")
        assert reason == "encrypted" and detail.strip(), r.stderr
        assert not out2.exists() and not Path(inc.meta_path(str(out2))).exists()

        # Sai tham so: ma 1 (loi lap trinh), khong phai 5 — VA phai la thong diep co chu dich, khong phai traceback. Ma 1 mot
        # minh KHONG phan biet duoc: mot loi Python khong bat cung thoat ma 1 (mutation W5 da lot qua phep kiem chi-ma-thoat).
        r = _worker(str(o), str(e))
        assert r.returncode == inc.EXIT_INTERNAL and r.stdout == b"", r.returncode
        err = r.stderr.decode("utf-8", "replace")
        assert "Traceback" not in err and "ValueError" not in err, f"uncaught exception instead of a usage message: {err[:200]}"
        assert "--incremental-worker" in err, f"no usage message on stderr: {err[:200]}"


def test_worker_codes_are_distinct_and_in_one_place():
    codes = {inc.EXIT_OK, inc.EXIT_INTERNAL, inc.EXIT_REFUSED}
    assert len(codes) == 3, codes
    # Cha va con dung CUNG MOT nguon: api.py khong duoc tu dat lai so nao.
    src = (ROOT / "api.py").read_text(encoding="utf-8")
    seg = src[src.index("def _incremental_via_worker_blocking"):src.index('@app.post("/save-incremental-bin")')]
    assert "_incremental_core.EXIT_REFUSED" in seg and "_incremental_core.EXIT_OK" in seg
    assert not any(f"returncode == {n}" in seg or f"returncode != {n}" in seg for n in range(0, 10)), \
        "api.py must compare against inc.EXIT_*, not literals"


def test_worker_command_shape():
    cmd = api._incremental_worker_cmd("o.pdf", "e.pdf", "out.pdf")
    assert cmd[0] == sys.executable and cmd[-3:] == ["o.pdf", "e.pdf", "out.pdf"], cmd
    assert inc.WORKER_FLAG in cmd
    if getattr(sys, "frozen", False):
        assert cmd[1] == inc.WORKER_FLAG
    else:
        assert os.path.basename(cmd[1]) == "sidecar.py" and os.path.exists(cmd[1]), cmd[1]
        assert cmd[2] == inc.WORKER_FLAG


# --------------------------------------------------------------------------- #
# hạn giờ, chết, không khởi động được
# --------------------------------------------------------------------------- #
def test_timeout_kills_the_worker_and_refuses():
    with _tmp() as d:
        d = Path(d)
        o, pidfile = d / "o.pdf", d / "pid.txt"
        _base(o)
        edited = _edited_bytes(o)
        code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(25)"
        real_t = inc.INCREMENTAL_TIMEOUT_S
        inc.INCREMENTAL_TIMEOUT_S = 1
        try:
            with _FakeWorker(code):
                t0 = time.time()
                j = _json(_call(o, edited))
                dt = time.time() - t0
        finally:
            inc.INCREMENTAL_TIMEOUT_S = real_t
        assert j["refused"] and j["reason"] == "timeout", j
        assert dt < 15, f"returned after {dt:.1f}s - the timeout did not cut the worker off"
        pid = int(pidfile.read_text())
        time.sleep(0.3)
        assert not _pid_alive(pid), f"worker pid {pid} is still alive after the timeout (orphan)"


def test_worker_crash_is_a_refusal_and_the_server_survives():
    """Segfault cua MuPDF = ma thoat la (0xC0000005). Phai thanh `worker_failed`, KHONG phai 500, va yeu cau ke tiep
    van chay duoc — do la ca muc dich cua viec co tien trinh con."""
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        edited = _edited_bytes(o)
        with _FakeWorker("import sys;sys.stderr.write('simulated crash');sys.exit(3221225477 & 0x7fffffff)"):
            j = _json(_call(o, edited))
        assert j["refused"] and j["reason"] == "worker_failed" and "simulated crash" in j["detail"], j
        ok = _call(o, edited)  # server van song, worker that van chay
        assert ok.media_type == "application/pdf"


def test_worker_that_exits_zero_without_output_is_refused():
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        with _FakeWorker("pass"):
            j = _json(_call(o, _edited_bytes(o)))
        assert j["reason"] == "worker_failed" and "file" in j["detail"].lower(), j


def test_unlaunchable_worker_never_falls_back_to_running_the_core_in_process():
    """Khac /compress (mat tinh nang nen te hon mot rui ro hiem): o day mat ghi noi chi la lui ve duong cu, con segfault
    tai cho thi giet sidecar. Bay mot cai bay: neu ai them nhanh 'chay tai cho', no se cham vao day."""
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        edited = _edited_bytes(o)
        real_cmd, real_core = api._incremental_worker_cmd, inc.append_revision
        api._incremental_worker_cmd = lambda *a: [str(Path(d) / "no-such-executable.exe")]

        def trap(*a, **k):
            raise AssertionError("core ran IN-PROCESS - a segfault here kills the sidecar")

        inc.append_revision = trap
        try:
            j = _json(_call(o, edited))
        finally:
            api._incremental_worker_cmd, inc.append_revision = real_cmd, real_core
        assert j["refused"] and j["reason"] == "worker_unavailable", j


def test_an_unexpected_exception_in_the_route_is_a_refusal_not_a_500():
    """Nhanh `except Exception` chung la luoi an toan cuoi: bat ky loi bat ngo nao (het dia, loi lap trinh) cung chi nghia la
    'lui ve duong luu cu', khong duoc thanh HTTP 500 lam renderer khong biet lam gi. Khong test nao di vao day cho toi khi
    mutation R9 (thay bang `raise`) lot qua."""
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        edited = _edited_bytes(o)
        real = api._incremental_via_worker_blocking

        def boom(*a, **k):
            raise RuntimeError("disk exploded")

        api._incremental_via_worker_blocking = boom
        try:
            j = _json(_call(o, edited))
        finally:
            api._incremental_via_worker_blocking = real
        assert j["refused"] is True and j["reason"] == "worker_failed", j
        ok = _call(o, edited)  # server van song
        assert ok.media_type == "application/pdf"


def test_an_unknown_reason_from_the_worker_is_coerced_to_worker_failed():
    """Tu vung ma renderer nhin thay phai dong kin: mot ly do la tren stderr khong duoc di thang len."""
    with _tmp() as d:
        o = Path(d) / "o.pdf"
        _base(o)
        code = "import sys;sys.stderr.write('surprise_reason\\tsome detail');sys.exit(%d)" % inc.EXIT_REFUSED
        with _FakeWorker(code):
            j = _json(_call(o, _edited_bytes(o)))
        assert j["reason"] == "worker_failed", j
        # ... con mot ly do HOP LE thi giu nguyen.
        code = "import sys;sys.stderr.write('signature_object_changed\\tobject 9');sys.exit(%d)" % inc.EXIT_REFUSED
        with _FakeWorker(code):
            j = _json(_call(o, _edited_bytes(o)))
        assert j["reason"] == "signature_object_changed" and j["detail"] == "object 9", j


def test_timeout_is_generous_enough_for_the_worst_measured_case():
    """Han gio chan 'mai mai', khong bat loi cham (BI-123, BI-129). Do 2026-11-22: file 256 MB = 2,0 s; 300.000 object
    = 8,1 s; tran 1 GB ~ 8 s theo byte. Ha han gio xuong sat cac con so do ⇒ giet mot lan luu hop le (may cham gap
    ba, o dia bi quet virus). Gioi han duoi 60 s la ~7 lan ca te nhat da do; con so hien tai (120 s) la ~15 lan."""
    assert inc.INCREMENTAL_TIMEOUT_S >= 60, inc.INCREMENTAL_TIMEOUT_S
    assert inc.INCREMENTAL_TIMEOUT_S <= 600, "a save that waits >10 min is unusable; falling back is better"


def test_temp_dirs_are_always_cleaned_up():
    before = _incr_dirs()
    with _tmp() as d:
        d = Path(d)
        o, enc = d / "o.pdf", d / "enc.pdf"
        _base(o)
        _base(enc, encrypt=True)
        edited = _edited_bytes(o)
        _call(o, edited)                      # thanh cong
        _call(enc, edited)                    # worker tu choi
        with _FakeWorker("import sys;sys.exit(9)"):
            _call(o, edited)                  # worker chet
        real_t, inc.INCREMENTAL_TIMEOUT_S = inc.INCREMENTAL_TIMEOUT_S, 1
        try:
            with _FakeWorker("import time;time.sleep(60)"):
                _call(o, edited)              # het gio
        finally:
            inc.INCREMENTAL_TIMEOUT_S = real_t
    leaked = _incr_dirs() - before
    assert not leaked, f"temp dirs leaked: {sorted(leaked)}"


# --------------------------------------------------------------------------- #
# ghim cấu trúc
# --------------------------------------------------------------------------- #
def test_new_headers_are_exposed_to_the_renderer():
    """Thieu ten nao trong expose_headers thi renderer doc ra null ma khong bao loi (xem X-Images-Failed)."""
    exposed = [
        mw.kwargs["expose_headers"]
        for mw in api.app.user_middleware
        if getattr(mw, "kwargs", {}).get("expose_headers")
    ]
    assert exposed, "no CORS expose_headers found"
    for h in ("X-Result-Size", "X-Changed", "X-Added", "X-Reused", "X-Unchanged", "X-Original-Size"):
        assert h in exposed[0], f"{h} missing from expose_headers: {exposed[0]}"


def test_sidecar_dispatches_the_worker_flag_before_importing_api():
    """Moi lan ghi noi deu qua tien trinh con nay; neu no phai `import api` truoc, ~80% thoi gian khoi dong la nap thu
    no khong dung (BI-121). Va co phai duoc xu ly TRUOC argparse, neu khong argparse exit(2) tren no."""
    src = (ROOT / "sidecar.py").read_text(encoding="utf-8")
    head = src[: src.index("def main()")]
    assert "from src.pdf.incremental import WORKER_FLAG as INCREMENTAL_WORKER_FLAG" in head
    assert not any(line.startswith(("import api", "from api")) for line in head.splitlines()), "sidecar imported api at module level"
    body = src[src.index("def main()"):]
    flag_at = body.index("INCREMENTAL_WORKER_FLAG")
    assert flag_at < body.index("import argparse") < body.index("from api import app"), "worker flag must be handled first"


def test_every_worker_reason_is_raised_by_the_route_layer_and_none_overlap_the_core():
    assert not set(inc.WORKER_REASONS) & set(inc.REASONS), set(inc.WORKER_REASONS) & set(inc.REASONS)
    src = (ROOT / "api.py").read_text(encoding="utf-8")
    for reason in inc.WORKER_REASONS:
        assert f'"{reason}"' in src, f"worker reason {reason!r} is declared but api.py never produces it"


# --------------------------------------------------------------------------- #
# nối với cổng BI-127 ở phía JS — chốt 4 sẽ dựa vào điều này
# --------------------------------------------------------------------------- #
def _js_loss(original: Path, candidate: Path):
    """Chay `checkOverwrite` that cua desktop/src/signed-scan.js (BI-127) tren (file goc, ung vien)."""
    node = shutil.which("node")
    if not node:
        return None
    script = (
        "const S=require(process.argv[1]);const fs=require('fs');"
        "S.checkOverwrite(process.argv[2],fs.readFileSync(process.argv[3])).then(r=>console.log(JSON.stringify(r)));"
    )
    r = subprocess.run(
        [node, "-e", script, str(ROOT / "desktop" / "src" / "signed-scan.js"), str(original), str(candidate)],
        capture_output=True, text=True, timeout=60,
    )
    import json

    return json.loads(r.stdout.strip().splitlines()[-1])


def test_route_result_passes_the_js_signature_gate_but_a_rewrite_does_not():
    """Hai nua cua 'dung pha chu ky' phai KHOP NHAU: ket qua cua route phai di qua cong BI-127 ma khong bi hoi (khong thi
    chot 4 se hoi nguoi dung oan), con ban pdf-lib dung lai thi phai bi hoi. File ky THAT cua corpus (skip neu khong co)."""
    src = CORPUS / "signed_verified.pdf"
    if not src.exists() or not shutil.which("node"):
        print("SKIP js-gate (no corpus or node)")
        return
    lib_rotate = ROOT / "tools" / "pdflib_rotate.js"
    with _tmp() as d:
        d = Path(d)
        orig = d / "signed.pdf"
        shutil.copyfile(src, orig)
        rewritten = d / "rewritten.pdf"
        rc = subprocess.run([shutil.which("node"), str(lib_rotate), str(orig), str(rewritten)], capture_output=True).returncode
        assert rc == 0, "pdf-lib could not produce the rewritten file"
        resp = _call(orig, rewritten.read_bytes())
        assert resp.media_type == "application/pdf", resp.body[:200]
        merged = d / "merged.pdf"
        merged.write_bytes(resp.body)
        gate_merged = _js_loss(orig, merged)
        gate_rewritten = _js_loss(orig, rewritten)
        assert gate_merged == {"signed": True, "loss": False, "count": 1}, f"route result trips the gate: {gate_merged}"
        assert gate_rewritten == {"signed": True, "loss": True, "count": 1}, f"rewrite slipped past the gate: {gate_rewritten}"


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
    print("All incremental-route tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
