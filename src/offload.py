"""Run blocking OCR / LLM work OFF the asyncio event loop (docs/REVIEW-2026-10-01 S1, S2).

Every sidecar route is ``async def``, so a CPU- or network-bound call made directly in
one freezes the whole process: ``/health`` and every other tab's request wait behind
it (measured: 58 s for a 2-page ``/searchable`` cold, 24 s warm). ONNX Runtime and
torch release the GIL while they run, so moving ``engine.recognize*`` to a worker
thread keeps the loop ticking (gaps of ~10 ms in the measurement).

Two rules this module exists to enforce:

1. **PyMuPDF (fitz) never leaves the loop thread.** fitz is not thread-safe. Only the
   pure-OCR / pure-network call goes to the worker; rendering the page, reading text,
   building the output PDF stay in the route, on the loop. A job handed to
   :func:`call_ocr` must therefore never touch a ``fitz`` object — give it a PIL image
   or bytes, not a page.
2. **One worker per pool.** ``max_workers=1`` means the OCR engine (lazy-loaded, holds
   model sessions) and the Gemini agent are never called concurrently — exactly the
   guarantee the old "everything runs on the loop" code gave them for free, so no
   thread-safety audit of those libraries is needed. The two kinds of work have
   SEPARATE pools: a 120 s Gemini call must not queue OCR behind it.

For code that interleaves fitz and OCR in one synchronous flow (``compare_pdfs``) the
flow is written as a generator that ``yield``s each OCR job; :func:`drive_sync` runs
it inline (identical to the old behaviour — used by tests / scripts) and
:func:`drive_async` runs it from a route, awaiting each job on the worker.
"""

from __future__ import annotations

import asyncio
import functools
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Generator

_OCR_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nabu-ocr")
_LLM_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nabu-llm")


async def _run_in(pool: ThreadPoolExecutor, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(pool, functools.partial(fn, *args, **kwargs))


async def call_ocr(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Call ``fn(*args, **kwargs)`` on the OCR worker and await it.

    Exceptions (including ``HTTPException`` and ``NotImplementedError``) propagate to
    the awaiting route unchanged, so its existing ``except`` clauses still work.
    ``fn`` must not touch any fitz object.
    """
    return await _run_in(_OCR_POOL, fn, *args, **kwargs)


async def call_llm(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Same as :func:`call_ocr`, for blocking Gemini calls (own worker)."""
    return await _run_in(_LLM_POOL, fn, *args, **kwargs)


def shutdown() -> None:
    """Stop accepting work (called on app shutdown). A job already running finishes."""
    _OCR_POOL.shutdown(wait=False, cancel_futures=True)
    _LLM_POOL.shutdown(wait=False, cancel_futures=True)


# A "step" generator yields zero-argument callables (jobs) and is sent each job's result;
# if a job raises, the exception is thrown INTO the generator at the same ``yield``, so a
# ``try/except`` around the ``yield`` behaves exactly as it did around a direct call.
Steps = Generator[Callable[[], Any], Any, Any]


def drive_sync(steps: Steps) -> Any:
    """Run a step generator to completion, executing each job inline. Returns its value."""
    try:
        job = next(steps)
        while True:
            try:
                result = job()
            except Exception as exc:  # forwarded to the generator, like a direct call
                job = steps.throw(exc)
            else:
                job = steps.send(result)
    except StopIteration as done:
        return done.value


async def drive_async(steps: Steps, runner: Callable[..., Any] = call_ocr) -> Any:
    """Run a step generator, awaiting each job on ``runner`` (the OCR worker by default).

    If this coroutine is cancelled mid-job (client gone) the generator is closed so its
    ``finally`` blocks — which close the PDF documents — still run, then the
    cancellation propagates.
    """
    try:
        job = next(steps)
        while True:
            try:
                result = await runner(job)
            except Exception as exc:
                job = steps.throw(exc)
            else:
                job = steps.send(result)
    except StopIteration as done:
        return done.value
    except BaseException:
        steps.close()
        raise
