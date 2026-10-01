"""Compare two PDFs as professional document-diff tools do.

Instead of aligning page N of A against page N of B (which falls apart the moment
one version inserts or removes content and shifts every later page), this treats
each document as a single **word stream** in reading order — every word tagged
with the page and bounding box it came from. The two streams are diffed with an
LCS/Myers-style sequence matcher (``difflib``), exactly like ``git diff`` over
tokens. Each changed run is mapped back to the page + box of its words, so a
change is highlighted on whatever page it actually lands on, in either document.

Text-layer pages take their words from PyMuPDF (real per-word boxes). Scanned
pages are OCR'd; each recognised line is split into words that share the line box
(coarser highlight, still on the right page). The result is robust to page shifts,
reflow, and font/margin changes — the failure modes of naïve per-page line diff.
"""

from __future__ import annotations

import difflib
import io
import logging
from typing import Any, Callable

from src.offload import drive_sync

logger = logging.getLogger(__name__)

# OCR render zoom; boxes are scaled back by this to land in PDF-point space.
_OCR_ZOOM = 2.0
# Bound work: pages per doc and total tokens (SequenceMatcher is ~quadratic worst
# case). Typical contracts are well under these; huge inputs degrade gracefully.
_MAX_PAGES = 1000
_MAX_TOKENS = 300_000


def _text_words(page) -> list[dict[str, Any]]:
    """Words from a page's text layer, in reading order: ``[{t, bbox}]``.

    PyMuPDF ``get_text("words")`` yields ``(x0,y0,x1,y1, word, block, line, wno)``.
    Sorting by (block, line, word-in-line) keeps a stable reading order even for
    multi-block layouts.
    """
    ws = page.get_text("words")
    ws.sort(key=lambda w: (w[5], w[6], w[7]))
    out: list[dict[str, Any]] = []
    for w in ws:
        word = w[4]
        if not word.strip():
            continue
        # "ln" = which text line this word sits on; only the large-document diff reads it.
        out.append({"t": word, "bbox": [w[0], w[1], w[2], w[3]], "ln": (w[5], w[6])})
    return out


# The word-gathering code below is written as GENERATORS (``*_steps``) that ``yield`` each
# OCR call as a zero-argument job instead of making it. PyMuPDF work (rendering the page,
# reading the text layer) stays in the generator, i.e. on whichever thread drives it —
# the event loop for /compare — while the jobs, which never touch fitz, can be run on the
# OCR worker (src/offload.py, REVIEW-2026-10-01 S1). ``compare_pdfs`` drives them inline,
# so calling it directly behaves exactly as before.


def _ocr_words_steps(page, get_ocr: Callable[[], Any]):
    """OCR a scanned page → words. Each word inherits its line's box (upright only)."""
    import fitz  # PyMuPDF
    from PIL import Image

    engine = yield get_ocr  # may load the model: that is part of the stall
    pix = page.get_pixmap(matrix=fitz.Matrix(_OCR_ZOOM, _OCR_ZOOM))
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    upright = int(page.rotation) == 0

    out: list[dict[str, Any]] = []
    try:
        lines = yield lambda: engine.recognize_boxes(img)
    except NotImplementedError:
        # Recognition-only engine: no layout — one box-less token per word.
        text = yield lambda: engine.recognize(img)
        for li, ln in enumerate(text.splitlines()):
            for word in ln.split():
                out.append({"t": word, "bbox": None, "ln": li})
        return out

    for li, (text, box) in enumerate(lines):
        bbox = None
        if upright and box and len(box) == 4:
            bbox = [c / _OCR_ZOOM for c in box]
        for word in text.split():
            if word.strip():
                out.append({"t": word, "bbox": bbox, "ln": li})
    return out


def _page_words_steps(page, mode: str, get_ocr: Callable[[], Any] | None):
    has_text = bool((page.get_text("text") or "").strip())
    if mode == "ocr" or (mode == "auto" and not has_text):
        if get_ocr is None:
            return _text_words(page)
        try:
            return (yield from _ocr_words_steps(page, get_ocr))
        except Exception:
            logger.exception("OCR failed on a page; using text layer instead")
            return _text_words(page)
    return _text_words(page)


def _doc_tokens_steps(doc, mode: str, get_ocr: Callable[[], Any] | None):
    """Flatten a whole document into one word stream: ``[{t, page, bbox}]``."""
    tokens: list[dict[str, Any]] = []
    n = min(doc.page_count, _MAX_PAGES)
    for i in range(n):
        if len(tokens) >= _MAX_TOKENS:
            break
        for w in (yield from _page_words_steps(doc[i], mode, get_ocr)):
            tokens.append({"t": w["t"], "page": i, "bbox": w["bbox"], "ln": (i, w.get("ln"))})
    return tokens


def _open(pdf_bytes: bytes):
    import fitz  # PyMuPDF

    return fitz.open(stream=pdf_bytes, filetype="pdf")


def _snippet(tokens: list[dict[str, Any]], limit: int = 60) -> str:
    """Readable text for a run of tokens (trimmed for the change list)."""
    s = " ".join(t["t"] for t in tokens)
    return s if len(s) <= limit else s[: limit - 1] + "…"


# Past this many tokens (on the larger side) the word diff goes line-first. difflib's
# SequenceMatcher is quadratic on real, repetitive text: measured here with Zipf-distributed
# words, 20k tokens take 2.5 s, 40k 10.8 s, 60k 28.8 s - and the cap above is 300k, i.e.
# minutes on the event loop (docs/REVIEW-2026-10-01 S4). Below the threshold the plain
# algorithm runs unchanged, so every ordinary contract gets byte-for-byte the answer it
# always got; the two-tier path is only for documents where the plain one is already slow.
_TWO_TIER_MIN_TOKENS = 30_000


def _line_spans(toks: list[dict[str, Any]]) -> list[tuple[int, int]]:
    """(start, end) token index of each run of consecutive tokens that share a line key."""
    spans: list[tuple[int, int]] = []
    start = 0
    for k in range(1, len(toks) + 1):
        if k == len(toks) or toks[k].get("ln") != toks[start].get("ln"):
            spans.append((start, k))
            start = k
    return spans


def _diff_opcodes(
    words_a: list[str],
    toks_a: list[dict[str, Any]],
    words_b: list[str],
    toks_b: list[dict[str, Any]],
    min_tokens: int | None = None,
) -> list[tuple[str, int, int, int, int]]:
    """Opcodes (``difflib`` format, over WORD indices) turning ``words_a`` into ``words_b``.

    Small inputs: exactly ``SequenceMatcher(autojunk=False).get_opcodes()``. Large ones: diff
    the sequences of LINES first (about a tenth of the length, so ~100x cheaper), then diff the
    words only inside the line blocks that changed. Both give a valid edit script; on repetitive
    text they can differ only in WHICH of several identical words is reported as the changed
    one (same number of changes in every measurement). A token with no line key counts as
    part of one big line, which degrades to the plain diff - correct, just not fast.

    No merging of adjacent changes is needed: the line-level diff never yields two non-equal
    pieces in a row (difflib folds them into one ``replace``), and the word-level pieces live
    strictly inside such a block, flanked by ``equal`` line pieces.
    """
    limit = _TWO_TIER_MIN_TOKENS if min_tokens is None else min_tokens
    plain = lambda: difflib.SequenceMatcher(None, words_a, words_b, autojunk=False).get_opcodes()  # noqa: E731
    if max(len(words_a), len(words_b)) < limit:
        return plain()

    spans_a = _line_spans(toks_a)
    spans_b = _line_spans(toks_b)
    keys_a = [" ".join(words_a[s:e]) for s, e in spans_a]
    keys_b = [" ".join(words_b[s:e]) for s, e in spans_b]

    out: list[tuple[str, int, int, int, int]] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, keys_a, keys_b, autojunk=False).get_opcodes():
        wi1 = spans_a[i1][0] if i1 < len(spans_a) else len(words_a)
        wi2 = spans_a[i2 - 1][1] if i2 > i1 else wi1
        wj1 = spans_b[j1][0] if j1 < len(spans_b) else len(words_b)
        wj2 = spans_b[j2 - 1][1] if j2 > j1 else wj1
        if tag == "replace":
            inner = difflib.SequenceMatcher(None, words_a[wi1:wi2], words_b[wj1:wj2], autojunk=False)
            for t2, a1, a2, b1, b2 in inner.get_opcodes():
                out.append((t2, wi1 + a1, wi1 + a2, wj1 + b1, wj1 + b2))
        else:
            out.append((tag, wi1, wi2, wj1, wj2))
    return out


def compare_pdfs_steps(
    pdf_a: bytes,
    pdf_b: bytes,
    mode: str = "auto",
    get_ocr: Callable[[], Any] | None = None,
):
    """Compare two PDFs via whole-document word-stream diff (generator form).

    Yields each OCR call as a job (see the note above ``_ocr_words_steps``) and returns
    the report; ``compare_pdfs`` is the plain synchronous entry point.

    Returns a JSON-serialisable report:

    - ``a_boxes`` / ``b_boxes``: ``{page_index: [[x0,y0,x1,y1, kind], ...]}`` where
      kind is ``"del"`` (removed, red on A), ``"ins"`` (added, green on B), or
      ``"rep"`` (changed, yellow on both). Boxes are in scale-1 PDF-point space.
    - ``changes``: ordered runs ``[{type, a_text, b_text, a_page, b_page}]`` for the
      change list / navigation. ``type`` is ``delete|insert|replace``; ``a_page`` /
      ``b_page`` is the first page of that run in each doc (null if absent there).
    - ``summary``: page counts, changed-page lists per side, change count, identical.
    """
    doc_a = _open(pdf_a)
    doc_b = _open(pdf_b)
    try:
        toks_a = yield from _doc_tokens_steps(doc_a, mode, get_ocr)
        toks_b = yield from _doc_tokens_steps(doc_b, mode, get_ocr)
        words_a = [t["t"] for t in toks_a]
        words_b = [t["t"] for t in toks_b]


        a_boxes: dict[int, list] = {}
        b_boxes: dict[int, list] = {}
        changes: list[dict[str, Any]] = []

        def add_boxes(store: dict[int, list], tokens: list[dict[str, Any]], kind: str):
            for tk in tokens:
                if not tk["bbox"]:
                    continue
                x0, y0, x1, y1 = tk["bbox"]
                store.setdefault(tk["page"], []).append([x0, y0, x1, y1, kind])

        for tag, i1, i2, j1, j2 in _diff_opcodes(words_a, toks_a, words_b, toks_b):
            if tag == "equal":
                continue
            at = toks_a[i1:i2]
            bt = toks_b[j1:j2]
            if tag == "delete":
                add_boxes(a_boxes, at, "del")
            elif tag == "insert":
                add_boxes(b_boxes, bt, "ins")
            else:  # replace
                add_boxes(a_boxes, at, "rep")
                add_boxes(b_boxes, bt, "rep")
            changes.append(
                {
                    "type": tag,
                    "a_text": _snippet(at),
                    "b_text": _snippet(bt),
                    "a_page": at[0]["page"] if at else None,
                    "b_page": bt[0]["page"] if bt else None,
                }
            )

        return {
            "success": True,
            "a_boxes": {str(k): v for k, v in a_boxes.items()},
            "b_boxes": {str(k): v for k, v in b_boxes.items()},
            "changes": changes,
            "summary": {
                "pages_a": doc_a.page_count,
                "pages_b": doc_b.page_count,
                "changes": len(changes),
                "changed_pages_a": sorted(a_boxes.keys()),
                "changed_pages_b": sorted(b_boxes.keys()),
                "identical": not changes,
                "truncated": len(toks_a) >= _MAX_TOKENS or len(toks_b) >= _MAX_TOKENS,
            },
        }
    finally:
        doc_a.close()
        doc_b.close()


def compare_pdfs(
    pdf_a: bytes,
    pdf_b: bytes,
    mode: str = "auto",
    get_ocr: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Synchronous :func:`compare_pdfs_steps`: every OCR job runs inline, on this thread."""
    return drive_sync(compare_pdfs_steps(pdf_a, pdf_b, mode=mode, get_ocr=get_ocr))
