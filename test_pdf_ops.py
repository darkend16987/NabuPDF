"""Characterization tests for the pure-PDF endpoints in api.py.

These endpoints take a PDF (or images) in and hand a PDF/zip back — no OCR, no
Gemini, no network. Synthetic PyMuPDF documents make every expected outcome
exact (page counts, embedded text, zip members), so the planned refactor can be
checked to change nothing.

Covers: /split, /add-page-numbers, /images-to-pdf, /pdf-to-images,
/extract-images, /encrypt + /decrypt, /compress, /text-spans, /compare.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import io
import json
import sys
import threading
import time
import zipfile

import fitz  # PyMuPDF
from fastapi import HTTPException
from PIL import Image

import api


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #
def _run(coro):
    return asyncio.run(coro)


def _b64(doc) -> str:
    return base64.b64encode(doc.tobytes()).decode("ascii")


def _npage_pdf(n: int) -> str:
    """n-page PDF, each page carrying a short ASCII text line."""
    doc = fitz.open()
    for i in range(n):
        page = doc.new_page(width=300, height=300)
        page.insert_text((72, 72), f"Page {i + 1} content")
    b = _b64(doc)
    doc.close()
    return b


def _img_b64(w: int, h: int) -> str:
    im = Image.new("RGB", (w, h), (10, 20, 30))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _pdf_with_image() -> str:
    doc = fitz.open()
    page = doc.new_page(width=300, height=300)
    im = Image.new("RGB", (40, 40), (200, 50, 50))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    page.insert_image(fitz.Rect(10, 10, 90, 90), stream=buf.getvalue())
    b = _b64(doc)
    doc.close()
    return b


def _zip_names(data_b64: str) -> list[str]:
    zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(data_b64)))
    return zf.namelist()


def _open(data_b64: str):
    return fitz.open(stream=base64.b64decode(data_b64), filetype="pdf")


# --------------------------------------------------------------------------- #
# /split
# --------------------------------------------------------------------------- #
def test_split_ranges():
    r = _run(api.split_pdf(api.SplitRequest(pdf_b64=_npage_pdf(5), mode="ranges", ranges="1-2,4")))
    assert r.success and r.count == 2
    names = _zip_names(r.data_b64)
    assert len(names) == 2
    assert any("p1-2" in n for n in names) and any("p4" in n for n in names)


def test_split_every():
    r = _run(api.split_pdf(api.SplitRequest(pdf_b64=_npage_pdf(5), mode="every", size=2)))
    assert r.success and r.count == 3  # (1-2)(3-4)(5)


def test_split_bad_ranges_400():
    try:
        _run(api.split_pdf(api.SplitRequest(pdf_b64=_npage_pdf(3), mode="ranges", ranges="")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /add-page-numbers
# --------------------------------------------------------------------------- #
def test_add_page_numbers_stamps_label():
    r = _run(api.add_page_numbers(api.PageNumberRequest(pdf_b64=_npage_pdf(3), fmt="n_of_n")))
    assert r.success and r.pages == 3
    doc = _open(r.data_b64)
    try:
        assert "1 / 3" in doc[0].get_text()  # label really landed on the page
    finally:
        doc.close()


def test_add_page_numbers_bad_position_400():
    try:
        _run(api.add_page_numbers(api.PageNumberRequest(pdf_b64=_npage_pdf(1), position="middle")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /images-to-pdf
# --------------------------------------------------------------------------- #
def test_images_to_pdf_fit_matches_image_size():
    r = _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[_img_b64(100, 50), _img_b64(60, 80)], page_size="fit")))
    assert r.success and r.pages == 2
    doc = _open(r.data_b64)
    try:
        assert round(doc[0].rect.width) == 100 and round(doc[0].rect.height) == 50
    finally:
        doc.close()


def test_images_to_pdf_a4_is_a4_page():
    r = _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[_img_b64(100, 50)], page_size="a4")))
    assert r.success
    doc = _open(r.data_b64)
    try:
        assert round(doc[0].rect.width) == 595 and round(doc[0].rect.height) == 842
    finally:
        doc.close()


def test_images_to_pdf_empty_400():
    try:
        _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[])))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /pdf-to-images
# --------------------------------------------------------------------------- #
def test_pdf_to_images_png():
    r = _run(api.pdf_to_images(api.PdfToImagesRequest(pdf_b64=_npage_pdf(2), format="png")))
    assert r.success and r.count == 2
    assert _zip_names(r.data_b64) == ["page_001.png", "page_002.png"]


def test_pdf_to_images_bad_format_400():
    try:
        _run(api.pdf_to_images(api.PdfToImagesRequest(pdf_b64=_npage_pdf(1), format="gif")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /extract-images
# --------------------------------------------------------------------------- #
def test_extract_images_finds_embedded():
    r = _run(api.extract_images(api.ExtractImagesRequest(pdf_b64=_pdf_with_image())))
    assert r.success and r.count == 1


def test_extract_images_text_only_reports_none():
    r = _run(api.extract_images(api.ExtractImagesRequest(pdf_b64=_npage_pdf(1))))
    assert r.success is False and r.error  # no embedded images -> graceful failure


# --------------------------------------------------------------------------- #
# /encrypt + /decrypt  (round-trip)
# --------------------------------------------------------------------------- #
def test_encrypt_decrypt_roundtrip():
    enc = _run(api.encrypt(api.EncryptRequest(pdf_b64=_npage_pdf(3), user_password="secret")))
    assert enc.success and enc.pages == 3
    # wrong password -> 401 so the UI can re-prompt
    try:
        _run(api.decrypt(api.DecryptRequest(pdf_b64=enc.data_b64, password="nope")))
        assert False, "expected 401"
    except HTTPException as e:
        assert e.status_code == 401
    dec = _run(api.decrypt(api.DecryptRequest(pdf_b64=enc.data_b64, password="secret")))
    assert dec.success and dec.pages == 3


def test_encrypt_requires_a_password_400():
    try:
        _run(api.encrypt(api.EncryptRequest(pdf_b64=_npage_pdf(1))))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /compress
# --------------------------------------------------------------------------- #
def test_compress_lossless_returns_valid_pdf():
    r = _run(api.compress(api.CompressRequest(pdf_b64=_npage_pdf(2), preset="lossless")))
    assert r.success and r.original_size > 0 and r.compressed_size > 0
    doc = _open(r.data_b64)
    try:
        assert doc.page_count == 2
    finally:
        doc.close()


def test_compress_bad_preset_400():
    try:
        _run(api.compress(api.CompressRequest(pdf_b64=_npage_pdf(1), preset="ultra")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /compress-bin — the raw-bytes route the desktop app uses for large files.
#
# The point of this route is that no base64 exists anywhere in it, so the checks
# below are about the WIRE SHAPE (binary body in, application/pdf body out, sizes in
# headers) as much as the compression itself: get the shape wrong and the renderer
# silently reads an error page as a PDF.
# --------------------------------------------------------------------------- #
def _bin_request(body: bytes) -> api.Request:
    """Minimal ASGI Request carrying `body` — /compress-bin reads request.body()."""

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {"type": "http", "method": "POST", "path": "/compress-bin", "headers": []}
    return api.Request(scope, receive)


def test_compress_bin_returns_raw_pdf_body():
    src = base64.b64decode(_npage_pdf(2))
    resp = _run(api.compress_bin(_bin_request(src), preset="lossless"))
    assert resp.media_type == "application/pdf", resp.media_type
    assert resp.headers["x-original-size"] == str(len(src))
    assert resp.headers["x-compressed-size"] == str(len(resp.body))
    doc = fitz.open(stream=resp.body, filetype="pdf")
    try:
        assert doc.page_count == 2
        assert "Page 1 content" in doc[0].get_text()
    finally:
        doc.close()


def test_compress_bin_matches_json_route():
    """Both routes must produce the SAME page count/text — they share the compressor,
    and this is the test that fails if someone ever forks the two code paths."""
    b64 = _npage_pdf(3)
    src = base64.b64decode(b64)
    raw = _run(api.compress_bin(_bin_request(src), preset="ebook"))
    js = _run(api.compress(api.CompressRequest(pdf_b64=b64, preset="ebook")))
    assert js.success
    a = fitz.open(stream=raw.body, filetype="pdf")
    b = _open(js.data_b64)
    try:
        assert a.page_count == b.page_count == 3
        assert [p.get_text() for p in a] == [p.get_text() for p in b]
    finally:
        a.close()
        b.close()


def test_compress_bin_empty_body_400():
    try:
        _run(api.compress_bin(_bin_request(b""), preset="ebook"))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


def test_compress_bin_bad_preset_400():
    src = base64.b64decode(_npage_pdf(1))
    try:
        _run(api.compress_bin(_bin_request(src), preset="ultra"))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# The out-of-process compressor.
#
# A big compression runs in a CHILD PROCESS, because PyMuPDF's rewrite_images holds
# the GIL for its whole duration (measured: 98.9% of the wall time, 0.1% left for
# anything else) and the sidecar's single event loop is shared by every tab and
# window. These tests drive _compress_via_worker_blocking directly, so they exercise
# the real subprocess without needing a 25 MB document to cross the threshold.
# --------------------------------------------------------------------------- #
def test_compress_worker_produces_the_same_document():
    """The worker is not a second implementation — it calls the same compressor. If
    these two ever disagree, the process boundary is corrupting something."""
    src = base64.b64decode(_npage_pdf(3))
    # Tra ve CompressResult(data, images_failed) tu BI-122, khong con la bytes tran.
    res = api._compress_via_worker_blocking(src, "ebook")
    assert res.images_failed is False, "tai lieu lanh ma bao la anh gay"
    via_worker = res.data
    in_process = api._compress_pdf_bytes(src, "ebook")
    a = fitz.open(stream=via_worker, filetype="pdf")
    b = fitz.open(stream=in_process, filetype="pdf")
    try:
        assert a.page_count == b.page_count == 3
        assert [p.get_text() for p in a] == [p.get_text() for p in b]
    finally:
        a.close()
        b.close()


def test_compress_worker_reports_caller_errors_as_400():
    """Exit code 3 must come back as the SAME HTTPException the in-process path
    raises, message included — the renderer shows `detail` to the user verbatim."""
    src = base64.b64decode(_npage_pdf(1))
    try:
        api._compress_via_worker_blocking(src, "ultra")
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400
        # The message crosses a process boundary as bytes. It is Vietnamese, and a
        # plain sys.stderr.write in the child encodes it with the console codepage
        # (cp1258/cp1252 on Windows) while the parent decodes UTF-8 — which turned it
        # into mojibake. Both ends are pinned to UTF-8; this is what checks it.
        assert "preset" in e.detail, e.detail
        assert "�" not in e.detail, "message was mangled crossing the process boundary"
        assert e.detail == "preset phải là screen|ebook|printer|lossless", repr(e.detail)


def test_compress_worker_rejects_an_unopenable_file():
    try:
        api._compress_via_worker_blocking(b"definitely not a pdf", "ebook")
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400
        assert e.detail.startswith("Không mở được PDF"), repr(e.detail)


def test_compress_worker_command_shape():
    """Frozen, sys.executable IS sidecar.exe so the flag goes straight to it; in dev
    the script has to be named. Getting this backwards launches the wrong thing."""
    import os
    import sys

    cmd = api._compress_worker_cmd("in.pdf", "out.pdf", "ebook")
    assert cmd[0] == sys.executable
    assert cmd[-3:] == ["in.pdf", "out.pdf", "ebook"]
    assert api._COMPRESS_WORKER_FLAG in cmd
    if getattr(sys, "frozen", False):
        assert cmd[1] == api._COMPRESS_WORKER_FLAG
    else:
        assert os.path.basename(cmd[1]) == "sidecar.py"
        assert os.path.exists(cmd[1]), cmd[1]
        assert cmd[2] == api._COMPRESS_WORKER_FLAG


def test_compress_always_runs_out_of_process():
    """MỌI lần nén phải đi qua tiến trình con — không còn ngưỡng dung lượng (BI-121).

    Vì sao đổi: `doc.rewrite_images()` làm MuPDF segfault trên file thật (đo được:
    blendmode.pdf, bug_jpx.pdf, perf_structure_transfer_functions.pdf, mỗi file chết
    1–2/3 lần). Segfault không bắt được bằng try/except; nó giết cả sidecar và app
    chỉ còn cách bảo người dùng khởi động lại. File nhỏ chạy tại chỗ nghĩa là đúng
    những file đó không được bảo vệ, nên ngưỡng 25 MB cũ đã bị bỏ.
    """
    assert not hasattr(api, "_COMPRESS_WORKER_MIN_BYTES"), "ngưỡng đã bỏ — đừng khôi phục"
    src = base64.b64decode(_npage_pdf(2))

    # Cả hai route phải gọi _compress_anywhere; nếu ai đó nối thẳng lại vào
    # _compress_pdf_bytes thì lần nén đó chạy ngay trong sidecar và segfault trở lại.
    seen = []
    real = api._compress_anywhere

    async def spy(pdf_bytes, preset, job=None):
        seen.append(preset)
        return await real(pdf_bytes, preset, job)

    api._compress_anywhere = spy
    try:
        resp = _run(api.compress_bin(_bin_request(src), preset="lossless"))
        assert resp.media_type == "application/pdf"
        assert bytes(resp.body[:4]) == b"%PDF"
        r = _run(api.compress(api.CompressRequest(pdf_b64=base64.b64encode(src).decode(), preset="lossless")))
        assert r.success and base64.b64decode(r.data_b64)[:4] == b"%PDF"
    finally:
        api._compress_anywhere = real
    assert seen == ["lossless", "lossless"], f"route không đi qua tiến trình con: {seen}"


# --------------------------------------------------------------------------- #
# Nén lại ảnh gãy -> vẫn phải nén được phần còn lại (BI-122)
#
# VÌ SAO LÀ GIẢ LẬP, KHÔNG PHẢI FILE THẬT. Hai lỗi mà lưới quét corpus bắt được đều
# đến từ sâu trong MuPDF trên ảnh JPX/pattern ("Bad PatternType", "pixmap may not
# have alpha to save as JPEG"), và không dựng lại được bằng PyMuPDF: thử insert_image
# với RGBA/LA ở ba cỡ đều KHÔNG làm rewrite_images ném lỗi (nó tách alpha thành
# /SMask nên ảnh nền hết alpha). Repo cũng không giữ file PDF nhị phân trong test.
# Nên ở đây ta thay chính `rewrite_images` bằng một hàm ném lỗi — thứ cần kiểm là
# NHÁNH XỬ LÝ, không phải khả năng dựng lại một file JPX méo. File thật được chấm ở
# lưới thứ ba: tools/corpus_sweep_sidecar.py (6 file, xem docs/CORPUS-SWEEP.md).
# --------------------------------------------------------------------------- #
def _no_image_rewrite(mutate=None):
    """Context manager thay fitz.Document.rewrite_images bằng một hàm luôn ném lỗi.

    `mutate(doc)` chạy TRƯỚC khi ném, để giả lập "đã sửa dở tài liệu rồi mới gãy".
    """
    import contextlib

    @contextlib.contextmanager
    def cm():
        real = fitz.Document.rewrite_images

        def boom(self, *a, **k):
            if mutate:
                mutate(self)
            raise RuntimeError("code=4: pixmap may not have alpha to save as JPEG")

        fitz.Document.rewrite_images = boom
        try:
            yield
        finally:
            fitz.Document.rewrite_images = real

    return cm()


def test_compress_survives_an_image_rewrite_failure():
    """MuPDF từ chối một ảnh => vẫn trả về PDF, không ném lỗi lên người dùng.

    Phần lớn phần thắng của việc nén nằm ở deflate + garbage=4, không cần ảnh. Trước
    bản vá này, một ảnh hỏng làm hỏng cả thao tác và người dùng không nhận được gì.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(3))
    with _no_image_rewrite():
        res = core.compress_pdf_bytes_ex(src, "ebook")
    assert res.images_failed is True, "phải báo lên là ảnh không nén lại được"
    assert res.data[:4] == b"%PDF"
    doc = fitz.open(stream=res.data, filetype="pdf")
    try:
        assert doc.page_count == 3
        assert "Page 1 content" in doc[0].get_text()
    finally:
        doc.close()


def test_compress_discards_a_half_rewritten_document():
    """Gãy giữa chừng => mở LẠI từ byte gốc, không lưu tài liệu đang dở.

    `rewrite_images` không phải thao tác nguyên tử: nó có thể thay vài ảnh rồi mới
    ném. Lưu tiếp tài liệu đó là lưu một trạng thái không ai biết. Ở đây hàm giả lập
    xoá hẳn một trang trước khi ném — nếu ai đó đổi sang "lưu tiếp cho nhanh", test
    này đỏ với 2 trang thay vì 3.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(3))
    with _no_image_rewrite(mutate=lambda d: d.delete_page(0)):
        res = core.compress_pdf_bytes_ex(src, "ebook")
    doc = fitz.open(stream=res.data, filetype="pdf")
    try:
        assert doc.page_count == 3, "tài liệu đã bị sửa dở lọt ra ngoài"
        assert "Page 1 content" in doc[0].get_text()
    finally:
        doc.close()


def test_compress_lossless_never_claims_an_image_failure():
    """"lossless" vốn không nén ảnh — cờ này nói "không làm được việc đã hứa"."""
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    assert core.compress_pdf_bytes_ex(src, "lossless").images_failed is False


def test_compress_route_passes_the_image_failure_to_the_client():
    """Cả hai route phải nói ra, mỗi route theo cách của nó: /compress có trường
    `images_failed`, /compress-bin có header X-Images-Failed — và header đó phải nằm
    trong expose_headers, nếu không renderer đọc ra null mà không báo lỗi ở đâu cả."""
    src = base64.b64decode(_npage_pdf(2))
    with _no_image_rewrite():
        # Ép nén tại chỗ: tiến trình con là một process khác, không thấy bản vá trên.
        real = api._compress_via_worker_blocking

        def unavailable(*a, **k):
            raise OSError("worker tat trong test")

        api._compress_via_worker_blocking = unavailable
        try:
            js = _run(api.compress(api.CompressRequest(
                pdf_b64=base64.b64encode(src).decode(), preset="ebook")))
            raw = _run(api.compress_bin(_bin_request(src), preset="ebook"))
        finally:
            api._compress_via_worker_blocking = real

    assert js.success and js.images_failed is True
    assert raw.headers.get("x-images-failed") == "1", dict(raw.headers)
    exposed = [
        mw.kwargs["expose_headers"]
        for mw in api.app.user_middleware
        if getattr(mw, "kwargs", {}).get("expose_headers")
    ]
    assert exposed, "khong tim thay expose_headers cua CORS"
    assert "X-Images-Failed" in exposed[0], exposed[0]


def test_compress_bin_stays_silent_when_images_were_fine():
    """Header chỉ gửi khi ĐÚNG là đã gãy — renderer chỉ cần hỏi "có header này không"."""
    src = base64.b64decode(_npage_pdf(1))
    raw = _run(api.compress_bin(_bin_request(src), preset="ebook"))
    assert "x-images-failed" not in {k.lower() for k in raw.headers}


def test_compress_retries_without_images_when_the_worker_dies():
    """Worker chết (segfault) => thử lại MỘT lần ở "lossless", vẫn trong tiến trình con.

    Segfault của MuPDF nằm trong `rewrite_images()`, nên bỏ bước đó là đi qua được.
    Đo bằng chính lệnh worker, 10 lần mỗi file mỗi preset, mỗi lần một tiến trình
    sạch: `blendmode.pdf` chết 10/10 ở `ebook` và 0/10 ở `lossless`;
    `perf_structure_transfer_functions.pdf` 8/10 · 0/10; `bug_jpx.pdf` 7/10 · 0/10.
    Cột `ebook` không ổn định giữa các loạt đo (BI-121: segfault phụ thuộc trạng thái
    bộ cấp phát); cột `lossless` thì ổn định 30/30 — đó là chỗ bản vá đứng.
    """
    src = base64.b64decode(_npage_pdf(2))
    real = api._compress_via_worker_blocking
    seen = []

    def flaky(pdf_bytes, preset, job=None):
        seen.append(preset)
        if preset != "lossless":
            raise RuntimeError("Tien trinh nen thoat voi ma 3221225477.")
        return real(pdf_bytes, preset)

    api._compress_via_worker_blocking = flaky
    try:
        res = _run(api._compress_anywhere(src, "ebook"))
    finally:
        api._compress_via_worker_blocking = real

    assert seen == ["ebook", "lossless"], seen
    assert res.images_failed is True
    assert res.data[:4] == b"%PDF"


def test_compress_does_not_retry_a_lossless_worker_death():
    """Không còn gì để bỏ bớt — thử lại chỉ là chết lần nữa, chậm gấp đôi."""
    src = base64.b64decode(_npage_pdf(1))
    real = api._compress_via_worker_blocking
    calls = []

    def dying(pdf_bytes, preset, job=None):
        calls.append(preset)
        raise RuntimeError("Tien trinh nen thoat voi ma 3221225477.")

    api._compress_via_worker_blocking = dying
    try:
        _run(api._compress_anywhere(src, "lossless"))
        assert False, "expected RuntimeError"
    except RuntimeError:
        pass
    finally:
        api._compress_via_worker_blocking = real
    assert calls == ["lossless"], calls


def test_worker_exit_four_is_success_not_death():
    """Mã 4 là THÀNH CÔNG kèm ghi chú, không phải "worker chết".

    Đọc nhầm nó thành chết sẽ khiến mọi file có ảnh gãy đi vào nhánh thử lại — tốn
    thêm một tiến trình cho đúng cái việc worker vừa làm xong. Ở đây ta giả lập lớp
    `subprocess` chứ không phải PyMuPDF: tiến trình con là một process khác nên không
    có cách nào bắt worker thật thoát 4 từ một PDF dựng trong test.
    """
    import subprocess as _sp

    src = base64.b64decode(_npage_pdf(1))
    real_popen = api.subprocess.Popen

    class _Proc:
        returncode = api._WORKER_IMAGES_FAILED

        def communicate(self, timeout=None):
            return (b"", b"")

        def kill(self):
            pass

    def fake_popen(cmd, **kw):
        # argv la [..., src, dst, preset] - worker that ghi vao dst, ta cung vay.
        with open(cmd[-2], "wb") as f:
            f.write(src)
        return _Proc()

    api.subprocess.Popen = fake_popen
    try:
        res = api._compress_via_worker_blocking(src, "ebook")
    finally:
        api.subprocess.Popen = real_popen
    assert res.data == src
    assert res.images_failed is True, "ma 4 phai thanh images_failed, khong phai loi"
    assert _sp is api.subprocess  # da tra lai dung module


def test_compress_core_stays_cheap_to_import():
    """`src/pdf/compress.py` là module LÁ: mỗi lần nén nạp lại nó trong một tiến
    trình mới, nên mọi import ở cấp module bị trả giá mỗi lần.

    Đo được: `import typing` 0,0156 s và `logging` không kéo nó theo — 6% chi phí của
    một tiến trình con, đổi lấy đúng một lớp 2 trường. `collections` thì logging đã
    nạp sẵn nên miễn phí. Ghim theo DANH SÁCH TRẮNG: thêm import mới ở đây là một
    quyết định phải đo, không phải một dòng gõ thêm cho tiện.
    """
    import pathlib
    import re

    from src.pdf import compress as core

    allowed = {"__future__", "collections", "logging"}
    src = pathlib.Path(core.__file__).read_text(encoding="utf8")
    # Bat dau SAU docstring: chinh docstring cua file do co ke "import fitz 0,082 s /
    # import fastapi 0,267 s / import api 0,378 s" — do la so do, khong phai import.
    # (Ghim cua phien truoc da vap dung bay nay mot lan.)
    head = src[src.index("from __future__") : src.index("PRESETS = {")]
    mods = set()
    for line in head.splitlines():
        m = re.match(r"(?:from|import)\s+([\w.]+)", line.strip())
        if m:
            mods.add(m.group(1).split(".")[0])
    extra = mods - allowed
    assert not extra, f"import moi o cap module cua compress.py: {sorted(extra)}"
    # `import fitz` phai nam TRONG ham: no la thu nang nhat va chi can khi nen that.
    assert "import fitz" in src and "import fitz" not in head


def test_worker_exit_code_four_is_the_same_number_on_both_sides():
    """Mã thoát 4 là hợp đồng giữa hai file. Một bên đổi, bên kia đọc thành "worker
    chết" và người dùng mất tính năng — im lặng, không lỗi ở đâu cả. Ghim nguồn."""
    import pathlib
    import re

    assert api._WORKER_IMAGES_FAILED == 4
    src = pathlib.Path(api.__file__).with_name("sidecar.py").read_text(encoding="utf8")
    assert re.search(r"return\s+4\s+if\s+\w+\.images_failed", src), \
        "sidecar.py khong con tra ve 4 khi nen lai anh that bai"


def test_compress_worker_does_not_import_the_whole_server():
    """Worker chỉ được cần PyMuPDF.

    Đo được: `import api` tốn 0,378 s ở bản dev và ~3,4 s ở bản đóng gói, trong khi
    việc nén thật chỉ tốn 0,31 s — nên nếu sidecar.py nạp `api` ở cấp module thì mỗi
    lần nén trả giá đó. Ghim nguồn, vì sai lầm này im lặng: mọi thứ vẫn CHẠY, chỉ
    chậm hẳn đi.
    """
    import pathlib

    src = pathlib.Path(api.__file__).with_name("sidecar.py").read_text(encoding="utf8")
    head = src[: src.index("def main(")]
    # Chỉ nhìn lệnh import THẬT: docstring và comment của chính file đó có nhắc tên
    # `api` (đúng là nó phải nhắc, để giải thích luật này).
    lines = [ln for ln in head.splitlines() if ln.strip().startswith(("import ", "from "))]
    offenders = [ln for ln in lines if ln.strip().startswith(("import api", "from api "))]
    assert not offenders, f"sidecar.py nap `api` o cap module: {offenders}"
    assert any("from src.pdf.compress import" in ln for ln in lines), "co worker phai lay tu module la"


# --------------------------------------------------------------------------- #
# /text-find — the read half of Find & Replace.
#
# What matters here is not "does str.find work" but the two things the FEATURE can
# get silently wrong: offsets that no longer point at the text the renderer will
# splice, and a match count that quietly hides the occurrences the app cannot
# safely replace.
# --------------------------------------------------------------------------- #
def _find(pdf_b64: str, query: str, **kw):
    return _run(api.text_find(api.TextFindRequest(pdf_b64=pdf_b64, query=query, **kw)))


def _contract_pdf() -> str:
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_text((50, 80), "Ben A ky hop dong")
    page.insert_text((50, 110), "Ben B ky hop dong")
    page.insert_text((50, 140), "Phu luc hop dong so 2")
    b = _b64(doc)
    doc.close()
    return b


def test_text_find_reports_every_occurrence():
    r = _find(_contract_pdf(), "hop dong")
    assert r.success and r.has_text
    assert len(r.hits) == 3, [h.span_text for h in r.hits]
    assert all(h.replaceable for h in r.hits)
    # offsets must index the span text the renderer is handed, or the splice lands
    # in the wrong place
    for h in r.hits:
        assert h.span_text[h.start : h.end] == "hop dong"


def test_text_find_hits_are_in_reading_order():
    """"Tìm tiếp" walks this list. PyMuPDF yields blocks in draw order, which is not
    always top-to-bottom, so the endpoint sorts — this guards that sort."""
    r = _find(_contract_pdf(), "hop dong")
    tops = [round(h.bbox_view[1], 1) for h in r.hits]
    assert tops == sorted(tops), tops
    assert [h.id for h in r.hits] == [0, 1, 2]


def test_text_find_case_and_whole_word():
    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.insert_text((40, 60), "Ben ben BENH ben.")
    b = _b64(doc)
    doc.close()
    assert len(_find(b, "ben").hits) == 4  # case-insensitive, substring of BENH
    assert len(_find(b, "ben", match_case=True).hits) == 2
    assert len(_find(b, "ben", whole_word=True).hits) == 3  # BENH excluded
    assert len(_find(b, "ben", match_case=True, whole_word=True).hits) == 2


def test_text_find_no_match_is_success_not_error():
    r = _find(_contract_pdf(), "khong co chuoi nay")
    assert r.success and r.has_text and r.hits == []


def test_text_find_scan_reports_has_text_false():
    """A scanned page has no characters. The UI needs to tell "0 kết quả" apart from
    "this document has no text at all" so it can point the user at OCR."""
    doc = fitz.open()
    doc.new_page(width=300, height=300)  # blank: no text layer
    b = _b64(doc)
    doc.close()
    r = _find(b, "bat ky")
    assert r.success and r.has_text is False and r.hits == []


def test_text_find_flags_cross_span_matches_instead_of_replacing_them():
    """"Ben A" where the A is drawn as its own run: reported so the count is honest,
    but replaceable=False so the renderer never rewrites half of it."""
    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.insert_text((40, 60), "Ben ", fontname="helv", fontsize=11)
    page.insert_text((62, 60), "A ky", fontname="hebo", fontsize=11)
    b = _b64(doc)
    doc.close()
    r = _find(b, "Ben A")
    assert r.success
    assert len(r.hits) == 1, [(h.span_text, h.replaceable) for h in r.hits]
    assert r.hits[0].replaceable is False
    assert r.crossing == 1


def test_text_find_empty_query_400():
    try:
        _find(_contract_pdf(), "")
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


def test_text_find_max_hits_truncates_and_says_so():
    r = _find(_contract_pdf(), "hop dong", max_hits=2)
    assert r.truncated is True and len(r.hits) == 2


def test_find_occurrences_case_fold_cannot_shift_offsets():
    """U+0130 lowercases to TWO characters in Python. Folding then indexing into the
    original would slide every later offset and splice into the wrong place, so the
    matcher must fall back to exact matching instead."""
    hay = "İstanbul hop"
    got = api._find_occurrences(hay, "hop", match_case=False, whole_word=False)
    assert got and all(hay[s:e] == "hop" for s, e in got), got


# --------------------------------------------------------------------------- #
# BI-123: tiến trình nén phải có TRẦN thời gian
# --------------------------------------------------------------------------- #
def test_compress_has_a_ceiling_and_it_is_generous():
    """Trần tồn tại, và đủ rộng để không giết một lần nén thật.

    Số dưới đây không phải gu thẩm mỹ: trần công việc hợp lệ là MAX_PAGES = 3000
    trang × ~0,377 s/trang ≈ 19 phút (số đo ở khối worker trong api.py). Hạ trần
    xuống dưới mức đó là bắt đầu giết những lần nén đúng đắn.
    """
    from src.pdf import compress as core

    assert core.COMPRESS_TIMEOUT_S >= 20 * 60, (
        f"tran {core.COMPRESS_TIMEOUT_S}s < 19 phut cua mot lan nen 3000 trang hop le"
    )
    assert core.COMPRESS_TIMEOUT_S <= 2 * 60 * 60, "tran rong den the thi khong con la tran"
    assert issubclass(core.CompressTimeout, RuntimeError)


def test_compress_kills_a_worker_that_runs_too_long():
    """Hết giờ => giết tiến trình con và báo bằng tiếng Việt, không treo mãi.

    Đo được: `bomb_giant.pdf` (123 KB, 1 trang) vượt 100 s ở cả `ebook` lẫn
    `lossless`. Hôm nay người dùng bấm Nén rồi chỉ còn cách tắt app.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    cu = core.COMPRESS_TIMEOUT_S
    real_popen = api.subprocess.Popen

    hanh_vi = {}

    class ChamProc:
        """Tiến trình con giả: chờ mãi, và ghi lại là nó CÓ bị giết."""

        returncode = -1

        def communicate(self, timeout=None):
            if hanh_vi.get("da_giet"):
                return (b"", b"")
            # Kiểm luôn rằng hạn giờ THẬT SỰ được truyền xuống. Thiếu dòng này thì
            # xoá `timeout=` khỏi `communicate` vẫn xanh — lưới xanh trên một bản vá
            # đã bị gỡ (đúng cái bẫy redproof bắt được lần trước).
            assert timeout == core.COMPRESS_TIMEOUT_S, (
                f"communicate khong nhan han gio: timeout={timeout!r}"
            )
            raise api.subprocess.TimeoutExpired("cmd", timeout)

        def kill(self):
            hanh_vi["da_giet"] = True

    core.COMPRESS_TIMEOUT_S = 1
    api.subprocess.Popen = lambda *a, **kw: ChamProc()
    try:
        api._compress_via_worker_blocking(src, "ebook")
        assert False, "expected CompressTimeout"
    except core.CompressTimeout as e:
        assert "phút" in str(e), repr(str(e))
    finally:
        api.subprocess.Popen = real_popen
        core.COMPRESS_TIMEOUT_S = cu
    # `subprocess.run` dọn xác hộ, `Popen` thì không (BI-126 đổi sang Popen để còn
    # giết được). Quên `kill()` ở nhánh hết giờ là để lại một tiến trình nén chạy
    # mãi mà không ai cầm handle nữa — đúng thứ BI-123 sinh ra để chặn.
    assert hanh_vi.get("da_giet"), "het gio ma khong giet tien trinh con"


def test_compress_does_not_retry_after_a_timeout():
    """Hết giờ thì KHÔNG thử lại ở `lossless`.

    `CompressTimeout` là lớp riêng chính vì việc này: nó là con của RuntimeError,
    mà RuntimeError là tín hiệu "worker chết -> thử lại không nén ảnh" (BI-122).
    Đo được `bomb_giant.pdf` vượt hạn ở CẢ hai preset, nên thử lại chỉ là bắt người
    dùng chờ thêm một trần nữa.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    real = api._compress_via_worker_blocking
    goi = []

    def het_gio(pdf_bytes, preset, job=None):
        goi.append(preset)
        raise core.CompressTimeout("Nén quá 30 phút nên đã dừng.")

    api._compress_via_worker_blocking = het_gio
    try:
        _run(api._compress_anywhere(src, "ebook"))
        assert False, "expected CompressTimeout"
    except core.CompressTimeout:
        pass
    finally:
        api._compress_via_worker_blocking = real
    assert goi == ["ebook"], f"da thu lai sau khi het gio: {goi}"


# --------------------------------------------------------------------------- #
# BI-126: nút Hủy cho nén
#
# Hủy chỉ đúng khi nó THẮNG MỌI CUỘC ĐUA. Ba cái dưới đây là ba thời điểm khác nhau
# mà người dùng có thể bấm, và cả ba từng có khả năng lọt:
#   1. đang chạy                    -> giết tiến trình con
#   2. trước khi có tiến trình con  -> giết ngay sau khi sinh
#   3. trước cả khi route ghi sổ    -> bia mộ, lần nén ấy chết lúc chào đời
# Cộng thêm cái bẫy lặng lẽ nhất: tiến trình bị giết thoát với mã lạ, mà mã lạ nghĩa
# là "worker chết => thử lại ở lossless" (BI-122) — bấm Hủy xong lại nén thêm lần nữa.
# --------------------------------------------------------------------------- #
def _worker_ngu(giay: int):
    """Thay lệnh worker bằng một tiến trình python chỉ ngủ — cần một việc chậm ỔN
    ĐỊNH, mà không PDF tổng hợp nào chậm một cách ổn định."""
    return lambda s, d, p: [sys.executable, "-c", f"import time;time.sleep({giay})"]


def test_compress_cancel_kills_a_running_worker():
    """Bấm Hủy giữa chừng => tiến trình con chết ngay, không chờ hết việc.

    Đây là ca ĐỦ THẬT: tiến trình con thật, `/compress-cancel` thật, giết thật. Worker
    giả ngủ 60 s; nếu Hủy không ăn thì test này treo tới timeout của lưới chứ không
    lặng lẽ xanh.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    real_cmd = api._compress_worker_cmd
    api._compress_worker_cmd = _worker_ngu(60)
    ket = {}

    def chay():
        try:
            with api._compress_job_slot("j-dang-chay") as slot:
                api._compress_via_worker_blocking(src, "ebook", slot)
            ket["r"] = "xong"
        except BaseException as e:  # noqa: BLE001 — test muốn biết CHÍNH XÁC cái gì nổi lên
            ket["r"] = e

    try:
        t0 = time.time()
        th = threading.Thread(target=chay)
        th.start()
        # Chờ tới khi tiến trình con thật sự có mặt trong sổ — ngủ cứng là mầm mống
        # test chập chờn trên máy chậm.
        for _ in range(200):
            with api._compress_jobs_lock:
                j = api._compress_jobs.get("j-dang-chay")
                if j is not None and j.proc is not None:
                    break
            time.sleep(0.02)
        else:
            assert False, "worker khong bao gio xuat hien trong so"

        r = _run(api.compress_cancel(job="j-dang-chay"))
        assert r == {"success": True, "running": True}, r
        th.join(timeout=20)
        dt = time.time() - t0
    finally:
        api._compress_worker_cmd = real_cmd

    assert not th.is_alive(), "huy roi ma van con cho worker"
    assert isinstance(ket.get("r"), core.CompressCancelled), repr(ket.get("r"))
    assert dt < 20, f"giet xong ma van cho het 60s: {dt:.1f}s"
    # Và sổ phải sạch: ô việc nén chỉ sống trong một request.
    assert "j-dang-chay" not in api._compress_jobs, api._compress_jobs


def test_cancel_that_arrives_before_the_worker_exists_still_kills_it():
    """Cuộc đua 2: Hủy tới lúc ta còn đang ghi file tạm.

    Lúc đó `job.proc` là None nên `/compress-cancel` không giết được gì. Nếu
    `_compress_via_worker_blocking` không đọc lại cờ ngay sau `Popen` thì nó vừa sinh
    ra một tiến trình nén mồ côi, chạy tiếp tới 30 phút sau lưng người dùng.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    real_popen = api.subprocess.Popen
    dau_vet = {}

    class Proc:
        returncode = 0

        def communicate(self, timeout=None):
            return (b"", b"")

        def kill(self):
            dau_vet["da_giet"] = True

    job = api._CompressJob()
    job.cancelled = True  # Hủy đã tới TRƯỚC khi có tiến trình
    api.subprocess.Popen = lambda *a, **kw: Proc()
    try:
        api._compress_via_worker_blocking(src, "ebook", job)
        assert False, "expected CompressCancelled"
    except core.CompressCancelled:
        pass
    finally:
        api.subprocess.Popen = real_popen
    assert dau_vet.get("da_giet"), "sinh worker ra roi bo mac no chay"


def test_cancel_that_arrives_before_the_request_is_booked_still_wins():
    """Cuộc đua 3: Hủy tới trước cả khi route kịp ghi sổ.

    Xảy ra thật: nút Hủy hiện ra TRƯỚC khi `fetch` được gọi, và thân một PDF vài
    trăm MB mất một lúc mới truyền xong. Không có bia mộ thì Hủy báo "không tìm thấy"
    rồi máy nén tiếp — người dùng không có cách nào biết.
    """
    from src.pdf import compress as core

    r = _run(api.compress_cancel(job="j-chua-co"))
    assert r == {"success": True, "running": False}, r
    try:
        with api._compress_job_slot("j-chua-co"):
            assert False, "bia mo khong an - lan nen nay da chay"
    except core.CompressCancelled:
        pass
    # Bia mộ dùng xong là xoá, không tích lại.
    assert "j-chua-co" not in api._compress_jobs, api._compress_jobs


def test_cancel_does_not_trigger_the_lossless_retry():
    """Bẫy lặng lẽ nhất: tiến trình bị giết thoát với mã lạ, và mã lạ = "thử lại".

    `CompressCancelled` là lớp riêng đúng vì việc này — y như `CompressTimeout`
    (BI-123). Để nó rơi vào `except RuntimeError` thì bấm Hủy xong máy chạy thêm
    một lần nén `lossless` nữa.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    real = api._compress_via_worker_blocking
    goi = []

    def bi_huy(pdf_bytes, preset, job=None):
        goi.append(preset)
        raise core.CompressCancelled("Đã hủy nén.")

    api._compress_via_worker_blocking = bi_huy
    try:
        _run(api._compress_anywhere(src, "ebook"))
        assert False, "expected CompressCancelled"
    except core.CompressCancelled:
        pass
    finally:
        api._compress_via_worker_blocking = real
    assert goi == ["ebook"], f"da nen them mot lan sau khi bi huy: {goi}"


def test_both_routes_report_a_cancel_as_cancelled_not_an_error():
    """Hủy không phải lỗi. Mỗi route nói theo cách của nó, và cả hai phải nói.

    Nếu nó về tới renderer như một lỗi thường thì người dùng bấm Hủy xong nhận một
    toast đỏ "Nén lỗi: …" cho việc chính họ vừa yêu cầu.
    """
    from src.pdf import compress as core

    src = base64.b64decode(_npage_pdf(1))
    real = api._compress_via_worker_blocking

    def bi_huy(pdf_bytes, preset, job=None):
        raise core.CompressCancelled("Đã hủy nén.")

    api._compress_via_worker_blocking = bi_huy
    try:
        js = _run(api.compress(api.CompressRequest(
            pdf_b64=base64.b64encode(src).decode(), preset="ebook", job="j1")))
        raw = _run(api.compress_bin(_bin_request(src), preset="ebook", job="j2"))
    finally:
        api._compress_via_worker_blocking = real

    assert js.success is False and js.cancelled is True, js
    assert js.error, "huy van phai co cau noi cho nguoi dung"
    assert raw.status_code == 200, raw.status_code
    body = json.loads(bytes(raw.body))
    assert body["success"] is False and body["cancelled"] is True, body


def test_compress_cancel_needs_a_job_id():
    """Hủy mà không nói hủy cái gì là lỗi của phía gọi, không phải "hủy tất"."""
    try:
        _run(api.compress_cancel(job=""))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400, e.status_code


def test_cancel_tombstones_do_not_pile_up():
    """Sổ việc nén có trần. Bia mộ là thứ client tự đặt tên, nên nó cũng là thứ một
    client hỏng (hoặc một vòng lặp lỗi) bơm vào mãi."""
    cu = dict(api._compress_jobs)
    try:
        api._compress_jobs.clear()
        for i in range(200):
            _run(api.compress_cancel(job=f"rac-{i}"))
        assert len(api._compress_jobs) <= api._MAX_COMPRESS_JOBS + 1, len(api._compress_jobs)
    finally:
        api._compress_jobs.clear()
        api._compress_jobs.update(cu)


def test_the_job_slot_is_cleaned_up_even_when_the_compression_blows_up():
    """Ô trong sổ sống đúng một request. Rò một ô là rò luôn cái tay nắm tiến
    trình con nằm trong nó."""
    try:
        with api._compress_job_slot("j-no"):
            raise ValueError("no giua chung")
    except ValueError:
        pass
    assert "j-no" not in api._compress_jobs, api._compress_jobs
    # Không mã việc = hợp đồng cũ, không ghi sổ gì cả.
    with api._compress_job_slot("") as slot:
        assert slot is None
    assert api._compress_jobs == {}, api._compress_jobs


# --------------------------------------------------------------------------- #
# BI-124: trường form thiếu /Kids
# --------------------------------------------------------------------------- #
def _form_with_orphan_parent():
    """PDF một trang: nhóm radio mà trường cha KHÔNG có /Kids — đúng kiểu hỏng của
    `opt_demo.pdf` trong corpus pdf.js (widget ghi /Parent, cha thì không nhận con).
    """
    doc = fitz.open()
    page = doc.new_page(width=200, height=200)
    page.insert_text((20, 20), "form")
    cha = doc.get_new_xref()
    doc.update_object(cha, "<</FT/Btn/Ff 49152/T(nhom)/V/0/Opt[(A)(B)]>>")
    con = []
    for i in range(2):
        w = doc.get_new_xref()
        doc.update_object(
            w,
            f"<</Type/Annot/Subtype/Widget/Parent {cha} 0 R"
            f"/Rect[20 {60 + 30 * i} 40 {80 + 30 * i}]/AS/Off>>",
        )
        con.append(w)
    doc.xref_set_key(page.xref, "Annots", "[" + " ".join(f"{c} 0 R" for c in con) + "]")
    doc.xref_set_key(
        doc.pdf_catalog(), "AcroForm",
        "<</Fields[" + " ".join(f"{c} 0 R" for c in con) + "]>>",
    )
    out = doc.tobytes()
    doc.close()
    return out, cha, con


def test_repair_only_touches_fields_that_are_actually_missing_kids():
    """Phép vá chỉ thêm thứ còn thiếu, KHÔNG viết lại form của người ta.

    Đây là nửa nguy hiểm: một hàm sửa cấu trúc form mà đụng cả trường lành thì nó
    tự trở thành nguồn lỗi mới.
    """
    src, cha, con = _form_with_orphan_parent()
    doc = fitz.open(stream=src, filetype="pdf")
    try:
        assert doc.xref_get_key(cha, "Kids")[0] == "null", "control: cha phai dang thieu /Kids"
        da_va = api._repair_orphan_field_kids(doc)
        assert da_va == [cha], f"va nham truong: {da_va}"
        kind, val = doc.xref_get_key(cha, "Kids")
        assert kind == "array" and all(f"{c} 0 R" in val for c in con), val
        # Chạy lại lần nữa: giờ không còn gì thiếu nên KHÔNG được chạm vào ai.
        assert api._repair_orphan_field_kids(doc) == [], "va lai mot tai lieu da lanh"
    finally:
        doc.close()


def test_split_recovers_from_a_form_missing_kids():
    """`insert_pdf` gãy vì form hỏng => vá rồi tách lại, KHÔNG bỏ cuộc."""
    src, cha, con = _form_with_orphan_parent()
    # control: chưa vá thì PyMuPDF thật sự gãy — nếu không, test này vô nghĩa.
    doc = fitz.open(stream=src, filetype="pdf")
    try:
        part = fitz.open()
        try:
            part.insert_pdf(doc, from_page=0, to_page=0)
            assert False, "control that bai: insert_pdf khong he gay tren file nay"
        except ValueError:
            pass
        finally:
            part.close()
    finally:
        doc.close()

    r = _run(api.split_pdf(api.SplitRequest(
        pdf_b64=base64.b64encode(src).decode(), mode="every", size=1)))
    assert r.success, r.error
    z = zipfile.ZipFile(io.BytesIO(base64.b64decode(r.data_b64)))
    names = [n for n in z.namelist() if n.lower().endswith(".pdf")]
    assert len(names) == 1, names
    out = fitz.open(stream=z.read(names[0]), filetype="pdf")
    try:
        assert out.page_count == 1
        # Và form phải CÒN. Đường rẻ tiền `insert_pdf(widgets=False)` cũng chạy được
        # nhưng ra file không còn trường nào — đo trên opt_demo.pdf: 1.619 byte / 0
        # widget, so với 5.663 byte / 9 widget khi vá đúng.
        assert len(list(out[0].widgets())) == 2, "tach xong mat trang form"
    finally:
        out.close()


# --------------------------------------------------------------------------- #
# BI-125: câu lỗi của thư viện không phải câu cho người dùng
# --------------------------------------------------------------------------- #
def test_split_retry_reopens_the_document_from_the_original_bytes():
    """Thử lại phải MỞ LẠI tài liệu, không dùng tiếp bản `insert_pdf` đã làm dở.

    VÌ SAO LÀ GHIM NGUỒN. Đo trên `opt_demo.pdf` (corpus pdf.js): thử lại trên chính
    `doc` cũ ra file 1.619 byte **không còn widget nào** — mất trắng cả form mà vẫn
    báo thành công; mở lại từ byte gốc ra 5.663 byte, đủ 9 widget. Nhưng tài liệu
    dựng tay trong file này KHÔNG tái hiện được chỗ đó: đo được, cả hai đường đều ra
    1.302 byte / 2 widget. Cấu trúc làm `insert_pdf` để lại sổ sách bẩn chỉ xuất hiện
    trên form nhiều nhánh như `opt_demo.pdf`, mà `test_*.py` thì không được phụ thuộc
    corpus đặt ngoài repo (nó là cổng của /deploy).

    Lưới quét corpus cũng KHÔNG đỡ được: nó chấm qpdf + số trang, không đếm widget.
    Nên luật này chỉ còn ghim nguồn giữ. Đổi khối thử lại ⇒ đọc lại BI-124 trước.
    """
    import pathlib
    import re

    # BI-138: khối thử lại đã chuyển NGUYÊN VĂN từ api.py sang src/pdf/split.py (`split_to_zip`)
    # để worker dùng được mà không import api. Ghim theo nó; ý ghim không đổi.
    src = (pathlib.Path(api.__file__).parent / "src" / "pdf" / "split.py").read_text(encoding="utf8")
    i = src.index("def split_to_zip")
    khoi = src[i : src.index("def _log_va", i)]
    assert "repair_orphan_field_kids" in khoi, "split_to_zip khong con goi phep va"
    # Giữa `except ValueError` và lời gọi phép vá phải có một lần mở lại tài liệu.
    m = re.search(r"except ValueError.*?repair_orphan_field_kids", khoi, re.S)
    assert m, "khong thay nhanh thu lai"
    assert "fitz.open(stream=pdf_bytes" in m.group(0), (
        "nhanh thu lai khong mo lai tai lieu tu byte goc - xem BI-124"
    )


def test_library_errors_become_vietnamese_but_keep_the_original():
    from src.pdf.util import nice_pdf_error

    cau = nice_pdf_error(ValueError("cannot save with zero pages"))
    assert cau.startswith("PDF này không có trang nào."), cau
    assert "cannot save with zero pages" in cau, "mat nguyen van => het tra cuu duoc"
    # Không khớp thì trả lại nguyên văn, không bịa thêm.
    assert nice_pdf_error(ValueError("chuyen la chua tung gap")) == "chuyen la chua tung gap"


def test_a_pdf_with_no_pages_is_a_400_not_a_library_message():
    """3 file corpus (issue21436, poppler-91414-0-53, -54) đi hết đường rồi mới chết
    ở `tobytes` với "cannot save with zero pages". Chốt sớm như /split vẫn chốt."""
    # Dung bang TAY: PyMuPDF tu choi LUU mot tai lieu 0 trang (dung cai loi dang
    # ban o day), nen khong tao duoc file mau bang chinh no.
    src = (
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
        b"trailer<</Root 1 0 R/Size 3>>\n%%EOF\n"
    )
    kiem = fitz.open(stream=src, filetype="pdf")
    try:
        assert kiem.page_count == 0, "control: file mau phai la 0 trang"
    finally:
        kiem.close()
    for goi in (
        lambda: api.add_page_numbers(api.PageNumberRequest(pdf_b64=base64.b64encode(src).decode())),
        lambda: api.split_pdf(api.SplitRequest(pdf_b64=base64.b64encode(src).decode())),
    ):
        try:
            _run(goi())
            assert False, "expected HTTPException"
        except HTTPException as e:
            assert e.status_code == 400
            assert e.detail == "PDF không có trang nào.", repr(e.detail)


def test_open_checks_the_page_tree_not_just_the_header():
    """`fitz.open` thành công không có nghĩa là tài liệu dùng được.

    MuPDF mở lười: cây trang chỉ đọc khi có người hỏi. `poppler-67295-0.pdf` mở
    bình thường rồi `page_count` mới ném — và vì mỗi route đọc số trang một chỗ
    khác nhau, lỗi ấy thoát ra thành 500 thay vì một câu 400 đọc được.
    """
    import pymupdf

    from src.pdf.util import _open_pdf_stream

    real = pymupdf.Document.page_count

    class Hong:
        def __get__(self, obj, owner=None):
            raise RuntimeError("code=7: Invalid number of pages")

    doc = fitz.open()
    doc.new_page()
    src = doc.tobytes()
    doc.close()

    pymupdf.Document.page_count = Hong()
    try:
        _open_pdf_stream(src)
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400, e.status_code
        assert "không đọc được số trang" in e.detail, repr(e.detail)
        assert "Invalid number of pages" in e.detail, "mat nguyen van"
    finally:
        pymupdf.Document.page_count = real


def test_compress_page_cap_is_generous():
    """The old cap was 500 pages, which refused most 200 MB documents outright —
    exactly the files "nén" exists for. Guard the intent, not just the number."""
    assert api._COMPRESS_MAX_PAGES >= 2000
    assert api._MAX_PDF_BIN >= 500_000_000


# --------------------------------------------------------------------------- #
# /text-spans
# --------------------------------------------------------------------------- #
def test_text_spans_reads_page_text():
    r = _run(api.text_spans(api.TextSpansRequest(pdf_b64=_npage_pdf(1), page=0)))
    assert r.success and r.has_text
    assert any("Page 1 content" in s.text for s in r.spans)


def test_text_spans_bad_page_400():
    try:
        _run(api.text_spans(api.TextSpansRequest(pdf_b64=_npage_pdf(1), page=9)))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


# --------------------------------------------------------------------------- #
# /compare
# --------------------------------------------------------------------------- #
def _text_pdf(lines: list[str]) -> str:
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    for ln in lines:
        page.insert_text((72, y), ln)
        y += 20
    b = _b64(doc)
    doc.close()
    return b


def test_compare_identical_reports_no_changes():
    a = _text_pdf(["Line one", "Line two", "Line three"])
    r = _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=a, mode="text")))
    assert r.success and len(r.changes) == 0 and r.summary.get("identical") is True


def test_compare_diff_reports_changes():
    a = _text_pdf(["Line one", "Line two", "Line three"])
    b = _text_pdf(["Line one", "Line two CHANGED", "Line three"])
    r = _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=b, mode="text")))
    assert r.success and len(r.changes) >= 1 and r.summary.get("identical") is False


def test_compare_bad_mode_400():
    a = _text_pdf(["x"])
    try:
        _run(api.compare(api.CompareRequest(pdf_a_b64=a, pdf_b_b64=a, mode="bogus")))
        assert False, "expected HTTPException"
    except HTTPException as e:
        assert e.status_code == 400


if __name__ == "__main__":
    # No pytest in the project venv - plain runner, same style as test_export.py.
    for fn in (
        test_split_ranges,
        test_split_every,
        test_split_bad_ranges_400,
        test_add_page_numbers_stamps_label,
        test_add_page_numbers_bad_position_400,
        test_images_to_pdf_fit_matches_image_size,
        test_images_to_pdf_a4_is_a4_page,
        test_images_to_pdf_empty_400,
        test_pdf_to_images_png,
        test_pdf_to_images_bad_format_400,
        test_extract_images_finds_embedded,
        test_extract_images_text_only_reports_none,
        test_encrypt_decrypt_roundtrip,
        test_encrypt_requires_a_password_400,
        test_compress_lossless_returns_valid_pdf,
        test_compress_bad_preset_400,
        test_compress_bin_returns_raw_pdf_body,
        test_compress_bin_matches_json_route,
        test_compress_bin_empty_body_400,
        test_compress_bin_bad_preset_400,
        test_compress_worker_produces_the_same_document,
        test_compress_worker_reports_caller_errors_as_400,
        test_compress_worker_rejects_an_unopenable_file,
        test_compress_worker_command_shape,
        test_compress_always_runs_out_of_process,
        test_compress_worker_does_not_import_the_whole_server,
        test_compress_survives_an_image_rewrite_failure,
        test_compress_discards_a_half_rewritten_document,
        test_compress_lossless_never_claims_an_image_failure,
        test_compress_route_passes_the_image_failure_to_the_client,
        test_compress_bin_stays_silent_when_images_were_fine,
        test_compress_retries_without_images_when_the_worker_dies,
        test_compress_does_not_retry_a_lossless_worker_death,
        test_worker_exit_code_four_is_the_same_number_on_both_sides,
        test_compress_core_stays_cheap_to_import,
        test_worker_exit_four_is_success_not_death,
        test_compress_page_cap_is_generous,
        test_compress_has_a_ceiling_and_it_is_generous,
        test_compress_kills_a_worker_that_runs_too_long,
        test_compress_does_not_retry_after_a_timeout,
        test_compress_cancel_kills_a_running_worker,
        test_cancel_that_arrives_before_the_worker_exists_still_kills_it,
        test_cancel_that_arrives_before_the_request_is_booked_still_wins,
        test_cancel_does_not_trigger_the_lossless_retry,
        test_both_routes_report_a_cancel_as_cancelled_not_an_error,
        test_compress_cancel_needs_a_job_id,
        test_cancel_tombstones_do_not_pile_up,
        test_the_job_slot_is_cleaned_up_even_when_the_compression_blows_up,
        test_repair_only_touches_fields_that_are_actually_missing_kids,
        test_split_recovers_from_a_form_missing_kids,
        test_split_retry_reopens_the_document_from_the_original_bytes,
        test_library_errors_become_vietnamese_but_keep_the_original,
        test_a_pdf_with_no_pages_is_a_400_not_a_library_message,
        test_open_checks_the_page_tree_not_just_the_header,
        test_text_find_reports_every_occurrence,
        test_text_find_hits_are_in_reading_order,
        test_text_find_case_and_whole_word,
        test_text_find_no_match_is_success_not_error,
        test_text_find_scan_reports_has_text_false,
        test_text_find_flags_cross_span_matches_instead_of_replacing_them,
        test_text_find_empty_query_400,
        test_text_find_max_hits_truncates_and_says_so,
        test_find_occurrences_case_fold_cannot_shift_offsets,
        test_text_spans_reads_page_text,
        test_text_spans_bad_page_400,
        test_compare_identical_reports_no_changes,
        test_compare_diff_reports_changes,
        test_compare_bad_mode_400,
    ):
        fn()
        print(f"PASS {fn.__name__}")
    print("All pdf-op tests passed.")
