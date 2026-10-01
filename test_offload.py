"""OCR / Gemini run OFF the event loop (docs/REVIEW-2026-10-01 S1, S2).

Before: every route was `async def` and called `engine.recognize*` / Gemini inline, so one
OCR page froze `/health` and every other tab (58 s cold for a 2-page /searchable). Now the
blocking call goes to a worker (src/offload.py) and everything fitz stays on the loop.

What is pinned here, and why each piece:
  * the loop keeps ticking while a job blocks (with a CONTROL that blocks inline, to prove
    the measurement can see a stall at all);
  * ONE worker per pool, so the OCR engine / Gemini agent are never called concurrently -
    the guarantee the old code got for free and that lets us skip a thread-safety audit;
  * the two pools are independent (a slow Gemini call must not queue OCR);
  * exceptions cross the thread boundary unchanged (the routes' `except HTTPException`,
    `except NotImplementedError`, ... depend on it);
  * `drive_sync` / `drive_async` give the step-generator the same semantics as direct calls,
    and a cancelled request still closes the generator (so its PDF documents get closed);
  * EVERY route that does OCR/Gemini really calls it on the worker, not on the loop thread
    (a route reverted to an inline call turns this red) and never hands a fitz object over;
  * /compare gives the same report whichever driver runs it;
  * api.py has no top-level name rebound by a later def/class/assignment - the first cut of
    this very change shadowed the `/ocr` route with an imported helper called `run_ocr`.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import ast
import asyncio
import base64
import contextlib
import io
import json
import threading
import time
from pathlib import Path

import fitz  # PyMuPDF
from fastapi import HTTPException
from PIL import Image

import api
from src import offload


def _run(coro):
    return asyncio.run(coro)


MAIN = threading.main_thread().name


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _max_loop_gap(work, tick=0.005):
    """Run `work()` (a coroutine factory) while a ticker measures the longest time the
    event loop went without getting control back. Returns (result, max_gap_seconds)."""
    gaps = []
    stop = asyncio.Event()

    async def ticker():
        last = time.perf_counter()
        while not stop.is_set():
            await asyncio.sleep(tick)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    t = asyncio.create_task(ticker())
    await asyncio.sleep(0.05)  # let it warm up
    try:
        result = await work()
    finally:
        stop.set()
        await t
    return result, max(gaps)


def _png_b64(w=50, h=20):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (255, 255, 255)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _text_pdf_b64(lines):
    d = fitz.open()
    p = d.new_page(width=300, height=300)
    for k, ln in enumerate(lines):
        p.insert_text((40, 60 + 20 * k), ln, fontsize=11)
    b = base64.b64encode(d.tobytes()).decode("ascii")
    d.close()
    return b


def _scan_pdf_b64(n=1):
    d = fitz.open()
    for i in range(n):
        buf = io.BytesIO()
        Image.new("RGB", (200, 200), (250, 250, 250)).save(buf, format="PNG")
        p = d.new_page(width=200, height=200)
        p.insert_image(p.rect, stream=buf.getvalue())
    b = base64.b64encode(d.tobytes()).decode("ascii")
    d.close()
    return b


class _RecEngine:
    """Records the thread every call ran on, and the type of what it was handed."""

    def __init__(self, delay=0.0):
        self.delay = delay
        self.threads = []
        self.arg_types = set()

    def _note(self, image):
        self.threads.append(threading.current_thread().name)
        self.arg_types.add(type(image).__name__)
        if self.delay:
            time.sleep(self.delay)

    def recognize(self, image):
        self._note(image)
        return "alpha beta"

    def recognize_boxes(self, image):
        self._note(image)
        return [("alpha", (10, 10, 80, 30)), ("beta", (10, 40, 80, 60))]


class _RecGemini:
    def __init__(self, delay=0.0):
        self.delay = delay
        self.threads = []

    def _note(self):
        self.threads.append(threading.current_thread().name)
        if self.delay:
            time.sleep(self.delay)

    def extract_fields(self, text, fields):
        self._note()
        return {k: "v" for k in fields}

    def classify_document(self, text):
        self._note()
        return {"loai": "hop_dong"}

    def _generate(self, prompt, system_instruction=""):
        self._note()
        items = json.loads(prompt)
        return json.dumps([{"i": it["i"], "t": "X " + it["t"]} for it in items])


@contextlib.contextmanager
def _patched(**attrs):
    saved = {k: getattr(api, k) for k in attrs}
    for k, v in attrs.items():
        setattr(api, k, v)
    try:
        yield
    finally:
        for k, v in saved.items():
            setattr(api, k, v)


@contextlib.contextmanager
def _worker_probe_get_ocr(engine):
    """Replace api._get_ocr by one that records its thread (the model load is part of the
    stall, so it must be on the worker too) and hands back `engine`."""
    seen = []

    def get():
        seen.append(threading.current_thread().name)
        return engine

    with _patched(_get_ocr=get):
        yield seen


# --------------------------------------------------------------------------- #
# offload module
# --------------------------------------------------------------------------- #
def test_loop_keeps_ticking_while_a_job_blocks():
    async def go():
        _, gap = await _max_loop_gap(lambda: offload.call_ocr(time.sleep, 0.5))
        return gap

    gap = _run(go())
    assert gap < 0.2, f"the loop stalled {gap:.3f}s while the job ran off-loop"


def test_control_an_inline_block_IS_visible_to_the_measurement():
    # Same ticker, same 0.5 s of blocking - but inline. If this did not show a stall, the
    # test above would prove nothing.
    async def inline():
        time.sleep(0.5)

    async def go():
        _, gap = await _max_loop_gap(inline)
        return gap

    gap = _run(go())
    assert gap >= 0.45, f"control did not register the stall (gap {gap:.3f}s)"


def test_job_runs_on_a_worker_thread_not_the_loop_thread():
    async def go():
        return (
            await offload.call_ocr(lambda: threading.current_thread().name),
            await offload.call_llm(lambda: threading.current_thread().name),
        )

    ocr_t, llm_t = _run(go())
    assert ocr_t.startswith("nabu-ocr") and llm_t.startswith("nabu-llm"), (ocr_t, llm_t)
    assert MAIN not in (ocr_t, llm_t)


def test_each_pool_runs_one_job_at_a_time():
    # The engine/agent are not audited for thread safety; max_workers=1 is what makes
    # that unnecessary. Eight jobs submitted at once must never overlap.
    for call in (offload.call_ocr, offload.call_llm):
        active = [0]
        peak = [0]
        lock = threading.Lock()

        def job():
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.02)
            with lock:
                active[0] -= 1

        async def go():
            await asyncio.gather(*(call(job) for _ in range(8)))

        _run(go())
        assert peak[0] == 1, f"{call.__name__}: {peak[0]} jobs ran concurrently"


def test_ocr_and_llm_pools_do_not_queue_behind_each_other():
    # The OCR job blocks until the LLM job releases it. With ONE shared worker this would
    # deadlock; the timeout turns that into a failure instead of a hang.
    release = threading.Event()

    def ocr_job():
        return release.wait(timeout=5)

    def llm_job():
        release.set()
        return "llm done"

    async def go():
        return await asyncio.gather(offload.call_ocr(ocr_job), offload.call_llm(llm_job))

    ocr_ok, llm_res = _run(go())
    assert ocr_ok is True and llm_res == "llm done"


def test_exceptions_cross_the_thread_boundary_unchanged():
    http = HTTPException(status_code=503, detail="no engine")

    def raise_http():
        raise http

    def raise_nie():
        raise NotImplementedError

    async def go():
        out = []
        for fn in (raise_http, raise_nie):
            try:
                await offload.call_ocr(fn)
            except BaseException as e:  # noqa: BLE001
                out.append(e)
        return out

    got = _run(go())
    assert got[0] is http, "HTTPException must arrive as the very same object"
    assert type(got[1]) is NotImplementedError


def test_drive_sync_semantics():
    log = []

    def steps():
        a = yield (lambda: 1)
        log.append(("got", a))
        try:
            yield (lambda: (_ for _ in ()).throw(KeyError("k")))
        except KeyError as e:  # a failing job surfaces at its own yield
            log.append(("caught", e.args[0]))
        b = yield (lambda: 10)
        return a + b

    assert offload.drive_sync(steps()) == 11
    assert log == [("got", 1), ("caught", "k")]

    def uncaught():
        yield (lambda: 1 / 0)

    try:
        offload.drive_sync(uncaught())
        assert False, "an exception the generator does not catch must propagate"
    except ZeroDivisionError:
        pass

    def no_jobs():
        return "done"
        yield  # pragma: no cover - makes it a generator

    assert offload.drive_sync(no_jobs()) == "done"


def test_drive_async_matches_drive_sync_and_runs_jobs_off_loop():
    threads = []

    def make():
        def job(n):
            return lambda: (threads.append(threading.current_thread().name), n * 2)[1]

        def steps():
            total = 0
            for n in (1, 2, 3):
                total += yield job(n)
            try:
                yield (lambda: (_ for _ in ()).throw(ValueError("x")))
            except ValueError:
                total += 100
            return total

        return steps()

    sync_result = offload.drive_sync(make())
    threads.clear()
    async_result = _run(offload.drive_async(make()))
    assert sync_result == async_result == 112
    assert threads and all(t.startswith("nabu-ocr") for t in threads), threads


def test_cancelling_drive_async_closes_the_generator():
    closed = []

    def steps():
        try:
            yield (lambda: time.sleep(0.5))
            yield (lambda: None)
        finally:
            closed.append(True)  # in the real code: doc_a.close() / doc_b.close()

    gen = steps()  # held here: otherwise CPython would close it by refcount and hide a missing close()

    async def go():
        t = asyncio.create_task(offload.drive_async(gen))
        await asyncio.sleep(0.1)
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            return "cancelled"
        return "finished"

    assert _run(go()) == "cancelled"
    assert closed == [True], "generator was not closed on cancellation - documents would leak"


# --------------------------------------------------------------------------- #
# routes: every OCR / Gemini call is on the worker, fitz objects never cross
# --------------------------------------------------------------------------- #
def test_route_ocr_runs_on_the_worker():
    eng = _RecEngine()
    with _worker_probe_get_ocr(eng) as gets:
        r = _run(api.run_ocr(api.OCRRequest(images=[_png_b64(), _png_b64()])))
    assert r.success and len(r.pages) == 2
    assert gets and all(t.startswith("nabu-ocr") for t in gets), gets
    assert len(eng.threads) == 2 and all(t.startswith("nabu-ocr") for t in eng.threads), eng.threads
    assert eng.arg_types == {"Image"}


def test_route_extract_ocr_and_gemini_run_on_their_workers():
    eng, gem = _RecEngine(), _RecGemini()
    with _worker_probe_get_ocr(eng), _patched(_get_gemini=lambda: gem):
        r = _run(api.extract(api.ExtractRequest(images=[_png_b64()], template="default")))
    assert r.success, r.error
    assert eng.threads and all(t.startswith("nabu-ocr") for t in eng.threads), eng.threads
    assert len(gem.threads) == 2 and all(t.startswith("nabu-llm") for t in gem.threads), gem.threads


def test_route_ocr_span_runs_on_the_worker():
    eng = _RecEngine()
    with _worker_probe_get_ocr(eng) as gets:
        r = _run(api.ocr_span(api.OcrSpanRequest(pdf_b64=_text_pdf_b64(["x"]), page=0, bbox=[30, 40, 200, 80])))
    assert r.success and r.text == "alpha beta"
    assert gets[0].startswith("nabu-ocr") and eng.threads[0].startswith("nabu-ocr")
    assert eng.arg_types == {"Image"}


def test_route_searchable_runs_on_the_worker():
    if not api._vietnamese_font():
        print("SKIP test_route_searchable_runs_on_the_worker (no DejaVu on this box)")
        return
    eng = _RecEngine()
    with _worker_probe_get_ocr(eng) as gets:
        r = _run(api.searchable(api.SearchableRequest(pdf_b64=_scan_pdf_b64(2), force_ocr=True)))
    assert r.success and r.ocr_pages == 2 and r.words == 4, (r.error, r.ocr_pages, r.words)
    assert gets[0].startswith("nabu-ocr")
    assert len(eng.threads) == 2 and all(t.startswith("nabu-ocr") for t in eng.threads), eng.threads
    assert eng.arg_types == {"Image"}


def test_route_translate_gemini_runs_on_the_llm_worker():
    gem = _RecGemini()
    with _patched(_get_gemini=lambda: gem):
        r = _run(api.translate_pdf(api.TranslateRequest(
            pdf_b64=_text_pdf_b64(["Dieu khoan thanh toan", "Ben A va ben B"]), target_lang="en")))
    assert r.success, r.error
    assert gem.threads and all(t.startswith("nabu-llm") for t in gem.threads), gem.threads


def test_route_compare_ocr_runs_on_the_worker_and_matches_the_sync_driver():
    from src.compare import compare_pdfs

    a, b = _scan_pdf_b64(2), _scan_pdf_b64(1)
    eng = _RecEngine()
    with _worker_probe_get_ocr(eng) as gets:
        r = _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=b, mode="ocr")))
    assert r.success, r.error
    assert gets and all(t.startswith("nabu-ocr") for t in gets), gets
    assert eng.threads and all(t.startswith("nabu-ocr") for t in eng.threads), eng.threads
    assert eng.arg_types == {"Image"}

    # same inputs through the synchronous entry point -> byte-identical report
    sync_report = compare_pdfs(base64.b64decode(a), base64.b64decode(b), mode="ocr", get_ocr=lambda: _RecEngine())
    assert json.dumps(r.a_boxes, sort_keys=True) == json.dumps(sync_report["a_boxes"], sort_keys=True)
    assert json.dumps(r.b_boxes, sort_keys=True) == json.dumps(sync_report["b_boxes"], sort_keys=True)
    assert r.changes == sync_report["changes"] and r.summary == sync_report["summary"]


def test_route_ocr_engine_failure_still_503_not_a_hang():
    def boom():
        raise HTTPException(status_code=503, detail="Khong khoi tao duoc engine OCR")

    with _patched(_get_ocr=boom):
        try:
            _run(api.run_ocr(api.OCRRequest(images=[_png_b64()])))
            assert False, "expected HTTPException 503"
        except HTTPException as e:
            assert e.status_code == 503


def test_health_answers_while_ocr_is_running():
    eng = _RecEngine(delay=0.4)

    async def go():
        async def work():
            return await api.run_ocr(api.OCRRequest(images=[_png_b64(), _png_b64()]))

        async def health_probe():
            # what the desktop does when the user clicks anything while OCR runs
            t0 = time.perf_counter()
            await api.health()
            return time.perf_counter() - t0

        async def both():
            ocr_task = asyncio.create_task(work())
            await asyncio.sleep(0.1)  # OCR is now inside the engine
            latency = await health_probe()
            return latency, await ocr_task

        return await _max_loop_gap(both)

    with _worker_probe_get_ocr(eng):
        (latency, resp), gap = _run(go())
    assert resp.success
    assert latency < 0.1, f"/health took {latency:.3f}s while OCR ran"
    assert gap < 0.2, f"loop stalled {gap:.3f}s during a 0.8 s OCR job"


def test_gemini_call_does_not_stall_the_loop():
    gem = _RecGemini(delay=0.5)

    async def go():
        async def work():
            return await api.extract(api.ExtractRequest(ocr_texts=["noi dung hop dong"], template="default"))

        return await _max_loop_gap(work)

    with _patched(_get_gemini=lambda: gem):
        resp, gap = _run(go())
    assert resp.success, resp.error
    assert gap < 0.2, f"loop stalled {gap:.3f}s during two 0.5 s Gemini calls"


# --------------------------------------------------------------------------- #
# static: no top-level name in api.py is bound twice
# --------------------------------------------------------------------------- #
def test_api_has_no_rebound_top_level_names():
    # `from src.offload import run_ocr` + the existing `async def run_ocr(request)` route:
    # the later def silently replaced the import and /ocr recursed into itself. Imports,
    # defs, classes and plain assignments at module level must each bind a name once.
    tree = ast.parse(Path(api.__file__).read_text(encoding="utf-8"))
    seen = {}
    dup = []
    for node in tree.body:
        names = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names = [node.name]
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [(a.asname or a.name).split(".")[0] for a in node.names]
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
        for n in names:
            if n in seen:
                dup.append((n, seen[n], node.lineno))
            seen[n] = node.lineno
    # `global x` re-assignment inside functions is not a top-level rebind; only module level counts.
    assert not dup, "top-level names bound more than once (name, first line, later line): %s" % dup


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001 - report any failure, not just AssertionError
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} offload tests passed.")
    raise SystemExit(1 if failed else 0)
