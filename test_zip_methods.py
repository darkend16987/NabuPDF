"""ZIP methods for /extract-images and /pdf-to-images.

Entries that hold an already-compressed image (JPEG/PNG/JPX/...) are written STORED:
deflate cannot shrink them but burns CPU on the event loop (12 MP JPEG: 2.12 s vs 0.18 s,
docs/REVIEW-2026-10-01 S8). Raw/other formats still deflate, and /split (PDF parts) keeps
deflating. Pinned here:

  - which extensions get which method (`_zip_method`), including case and a leading dot;
  - the real routes produce STORED members for JPEG/PNG and the bytes round-trip EXACTLY;
  - the archive stays openable by the stdlib reader (`testzip()` clean);
  - the saving is real: a stored JPEG member's compressed size == its raw size, and the
    archive is not larger than before by more than the zip headers.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import io
import random
import zipfile

import fitz  # PyMuPDF
from PIL import Image

import api


def _noise_jpeg(w=400, h=300, seed=1) -> bytes:
    rnd = random.Random(seed)
    im = Image.frombytes("RGB", (w, h), bytes(rnd.randrange(256) for _ in range(w * h * 3)))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _pdf_with_jpeg(jpeg: bytes) -> str:
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_image(fitz.Rect(0, 0, 400, 300), stream=jpeg)
    b64 = base64.b64encode(doc.tobytes()).decode("ascii")
    doc.close()
    return b64


def _unzip(resp):
    assert resp.success, resp.error
    return zipfile.ZipFile(io.BytesIO(base64.b64decode(resp.data_b64)))


def test_method_by_extension():
    for ext in ("jpg", "JPG", ".jpeg", "png", "PNG", "jp2", "jpx", "webp", "gif"):
        assert api._zip_method(ext) == zipfile.ZIP_STORED, f"{ext} should be stored"
    for ext in ("bmp", "tiff", "tif", "ppm", "pdf", "txt", ""):
        assert api._zip_method(ext) == zipfile.ZIP_DEFLATED, f"{ext!r} should still deflate"


def test_extract_images_stores_the_jpeg_and_roundtrips_it():
    jpeg = _noise_jpeg()
    zf = _unzip(asyncio.run(api.extract_images(api.ExtractImagesRequest(pdf_b64=_pdf_with_jpeg(jpeg)))))
    infos = zf.infolist()
    assert len(infos) == 1 and infos[0].filename.endswith(".jpeg") or infos[0].filename.endswith(".jpg")
    info = infos[0]
    assert info.compress_type == zipfile.ZIP_STORED, f"JPEG member was compressed with method {info.compress_type}"
    assert info.compress_size == info.file_size, "stored member must not change size"
    assert zf.read(info.filename) == jpeg, "extracted bytes differ from the embedded JPEG"
    assert zf.testzip() is None


def test_pdf_to_images_stores_both_formats_and_stays_valid():
    doc = fitz.open()
    for _ in range(2):
        p = doc.new_page(width=200, height=200)
        p.insert_text((20, 100), "hello")
    b64 = base64.b64encode(doc.tobytes()).decode("ascii")
    doc.close()
    for fmt in ("png", "jpg"):
        zf = _unzip(asyncio.run(api.pdf_to_images(api.PdfToImagesRequest(pdf_b64=b64, dpi=72, format=fmt))))
        infos = zf.infolist()
        assert len(infos) == 2, f"{fmt}: expected 2 pages"
        for info in infos:
            assert info.compress_type == zipfile.ZIP_STORED, f"{fmt}: {info.filename} was deflated"
            data = zf.read(info.filename)
            Image.open(io.BytesIO(data)).verify()  # each member is still a valid image
        assert zf.testzip() is None


def test_split_still_deflates_its_pdf_parts():
    doc = fitz.open()
    for i in range(4):
        p = doc.new_page(width=300, height=300)
        p.insert_text((50, 100), f"Page {i + 1} " + "lorem ipsum " * 40)
    b64 = base64.b64encode(doc.tobytes()).decode("ascii")
    doc.close()
    zf = _unzip(asyncio.run(api.split_pdf(api.SplitRequest(pdf_b64=b64, mode="every", size=1))))
    methods = {i.compress_type for i in zf.infolist()}
    assert methods == {zipfile.ZIP_DEFLATED}, f"split members should deflate, got {methods}"


def test_stored_is_not_bigger_than_deflated_for_a_jpeg():
    """The point of the change: no size penalty, only saved CPU."""
    jpeg = _noise_jpeg(seed=7)

    def size(method):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", method) as z:
            z.writestr("a.jpg", jpeg)
        return len(buf.getvalue())

    stored, deflated = size(zipfile.ZIP_STORED), size(zipfile.ZIP_DEFLATED)
    assert stored <= deflated * 1.01, f"stored {stored} vs deflated {deflated}"


if __name__ == "__main__":
    import sys

    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as e:  # AssertionError or anything unexpected: both are a failure
            failed += 1
            print("FAIL", name, "-", type(e).__name__, e)
    print("All zip-method tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
