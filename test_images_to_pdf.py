"""/images-to-pdf embeds a JPEG as it is (docs/REVIEW-2026-10-01 S5).

Before, EVERY image was decoded and re-encoded as PNG: a 2.2 MB phone photo became a 34 MB
page after ~7 s of CPU on the event loop, and the "100 phone photos" batch the desktop
anticipates would have produced a multi-GB PDF. Now a JPEG goes in untouched.

The risk is in which images may skip the re-encode, so the rule is narrow and every class
on either side of it is pinned, measured against the OLD path (decode -> PNG -> insert):

  * JPEG / MPO, RGB or gray      embedded as-is. Pixels differ from the old path by ~0.5/255
                                 on average (a different JPEG decoder) - never a colour shift.
  * EXIF orientation / ICC       ignored by BOTH paths: the page must not rotate or change.
  * truncated / corrupt JPEG     refused with 400, exactly as before. MuPDF would swallow a
                                 cut-off JPEG silently, so the route decodes once to check.
  * CMYK JPEG, PNG (any mode), WebP, BMP, TIFF, RGBA, palette
                                 keep the old path - byte for byte the same output as before.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import asyncio
import base64
import io

import fitz  # PyMuPDF
import numpy as np
from fastapi import HTTPException
from PIL import Image

import api


def _run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
def _photo(w=320, h=240, seed=1):
    """Photo-like content: smooth gradients, noise, and hard edges (where decoders differ)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    r = 127 + 100 * np.sin(x / 37.0) * np.cos(y / 53.0)
    g = 127 + 100 * np.sin(x / 71.0 + 1) * np.cos(y / 29.0)
    b = 127 + 100 * np.cos(x / 23.0) * np.sin(y / 61.0)
    a = np.stack([r, g, b], -1) + rng.normal(0, 6, (h, w, 3))
    a[h // 3: h // 3 + 6, :, :] = 255
    a[:, w // 2: w // 2 + 4, :] = 0
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def _enc(im, fmt, **kw):
    buf = io.BytesIO()
    im.save(buf, format=fmt, **kw)
    return buf.getvalue()


def _fixtures():
    p = _photo()
    exif6 = Image.Exif()
    exif6[0x0112] = 6
    rgba = p.copy()
    rgba.putalpha(Image.fromarray(np.linspace(0, 255, p.width).astype(np.uint8)[None, :].repeat(p.height, 0)))
    mpo = io.BytesIO()
    p.save(mpo, "MPO", save_all=True, append_images=[_photo(160, 120, 2)], quality=90)
    return {
        # embedded as-is
        "jpeg-rgb": _enc(p, "JPEG", quality=90),
        "jpeg-420": _enc(p, "JPEG", quality=60, subsampling=2),
        "jpeg-progressive": _enc(p, "JPEG", quality=85, progressive=True),
        "jpeg-gray": _enc(p.convert("L"), "JPEG", quality=90),
        "jpeg-exif-6": _enc(p, "JPEG", quality=90, exif=exif6.tobytes()),
        "mpo": mpo.getvalue(),
        # old path
        "jpeg-cmyk": _enc(p.convert("CMYK"), "JPEG", quality=90),
        "png-rgb": _enc(p, "PNG"),
        "png-gray": _enc(p.convert("L"), "PNG"),
        "png-rgba": _enc(rgba, "PNG"),
        "png-palette": _enc(p.convert("P", palette=Image.ADAPTIVE, colors=64), "PNG"),
        "bmp": _enc(p, "BMP"),
        "tiff": _enc(p, "TIFF"),
        "webp": _enc(p, "WEBP"),
    }


FX = _fixtures()
RAW_EMBEDDED = ("jpeg-rgb", "jpeg-420", "jpeg-progressive", "jpeg-gray", "jpeg-exif-6", "mpo")
OLD_PATH = ("jpeg-cmyk", "png-rgb", "png-gray", "png-rgba", "png-palette", "bmp", "tiff", "webp")


def _b64(raw):
    return base64.b64encode(raw).decode("ascii")


def _route(raws, page_size="fit"):
    r = _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[_b64(x) for x in raws], page_size=page_size)))
    assert r.success, r.error
    return base64.b64decode(r.data_b64)


def _render(pdf, page=0):
    d = fitz.open("pdf", pdf)
    pix = d[page].get_pixmap(dpi=72, alpha=False)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n).astype(np.int16)
    d.close()
    return a


def _old_path_pdf(raw):
    """The code this change replaced, verbatim in effect: decode -> PNG -> insert_image."""
    pil = Image.open(io.BytesIO(raw))
    pil = pil.convert("RGB") if pil.mode not in ("RGB", "L") else pil
    png = io.BytesIO()
    pil.save(png, format="PNG")
    d = fitz.open()
    pg = d.new_page(width=pil.width, height=pil.height)
    pg.insert_image(pg.rect, stream=png.getvalue())
    out = d.tobytes(deflate=True, garbage=api.WRITE_GARBAGE)
    d.close()
    return out


def _embedded_image_bytes(pdf):
    d = fitz.open("pdf", pdf)
    try:
        xref = d.get_page_images(0)[0][0]
        return d.extract_image(xref)
    finally:
        d.close()


# --------------------------------------------------------------------------- #
# the helper's decision, class by class
# --------------------------------------------------------------------------- #
def test_helper_embeds_these_classes_as_is():
    for name in RAW_EMBEDDED:
        raw = FX[name]
        stream, w, h = api._pdf_image_stream(raw)
        assert stream is raw, f"{name}: expected the original bytes to be passed through"
        im = Image.open(io.BytesIO(raw))
        assert (w, h) == (im.width, im.height), name


def test_helper_keeps_the_old_path_for_everything_else():
    for name in OLD_PATH:
        raw = FX[name]
        stream, w, h = api._pdf_image_stream(raw)
        assert stream is not raw and stream[:8] == b"\x89PNG\r\n\x1a\n", f"{name}: expected a re-encoded PNG"
        im = Image.open(io.BytesIO(raw))
        assert (w, h) == (im.width, im.height), name


# --------------------------------------------------------------------------- #
# through the route
# --------------------------------------------------------------------------- #
def test_jpeg_survives_byte_for_byte_inside_the_pdf():
    for name in RAW_EMBEDDED:
        pdf = _route([FX[name]])
        info = _embedded_image_bytes(pdf)
        assert info["image"] == FX[name], f"{name}: the embedded stream is not the original JPEG"


def test_jpeg_pdf_is_about_the_size_of_the_jpeg():
    for name in ("jpeg-rgb", "jpeg-420", "jpeg-gray"):
        raw = FX[name]
        pdf = _route([raw])
        assert len(pdf) < len(raw) + 4000, f"{name}: {len(raw)} B image -> {len(pdf)} B PDF"
        # and it really is much smaller than the old path (the point of S5)
        assert len(pdf) * 3 < len(_old_path_pdf(raw)), name


def test_a_large_photo_does_not_balloon():
    big = _photo(3000, 2000, 3)
    raw = _enc(big, "JPEG", quality=88)
    pdf = _route([raw])
    assert len(pdf) < len(raw) * 1.05, f"{len(raw)} B JPEG -> {len(pdf)} B PDF"


def test_jpeg_page_looks_like_the_old_path():
    for name in RAW_EMBEDDED:
        raw = FX[name]
        new, old = _render(_route([raw])), _render(_old_path_pdf(raw))
        assert new.shape == old.shape, f"{name}: page geometry changed {new.shape} vs {old.shape}"
        d = np.abs(new - old)
        # a different decoder: tiny average difference, and never a colour shift
        assert d.mean() < 1.0, f"{name}: mean pixel difference {d.mean():.3f}"
        assert np.abs(new.mean((0, 1)) - old.mean((0, 1))).max() < 0.5, f"{name}: colour cast"


def test_exif_orientation_is_ignored_exactly_as_before():
    # Behaviour kept, not endorsed: the old path never applied EXIF rotation, and neither
    # does MuPDF, so a phone photo tagged "rotate 90" keeps its sensor-orientation page.
    raw = FX["jpeg-exif-6"]
    im = Image.open(io.BytesIO(raw))
    pdf = _route([raw])
    d = fitz.open("pdf", pdf)
    try:
        assert (round(d[0].rect.width), round(d[0].rect.height)) == (im.width, im.height)
    finally:
        d.close()
    old = _render(_old_path_pdf(raw))
    assert _render(pdf).shape == old.shape


def test_old_path_classes_produce_the_same_pixels_as_before():
    for name in OLD_PATH:
        raw = FX[name]
        new, old = _render(_route([raw])), _render(_old_path_pdf(raw))
        assert new.shape == old.shape and int(np.abs(new - old).max()) == 0, name


def test_a4_mode_places_a_jpeg_inside_the_margins():
    pdf = _route([FX["jpeg-rgb"]], page_size="a4")
    d = fitz.open("pdf", pdf)
    try:
        assert (round(d[0].rect.width), round(d[0].rect.height)) == (595, 842)
        r = d[0].get_image_rects(d[0].get_images()[0][0])[0]
        assert r.x0 >= 27.9 and r.y0 >= 27.9 and r.x1 <= 595 - 27.9 and r.y1 <= 842 - 27.9, r
        assert abs((r.x0 + r.x1) / 2 - 297.5) < 1 and abs((r.y0 + r.y1) / 2 - 421) < 1  # centred
    finally:
        d.close()


def test_mixed_batch_keeps_order_and_page_count():
    raws = [FX["jpeg-rgb"], FX["png-rgb"], FX["jpeg-gray"], FX["webp"], FX["mpo"]]
    pdf = _route(raws)
    d = fitz.open("pdf", pdf)
    try:
        assert d.page_count == 5
        for i, raw in enumerate(raws):
            im = Image.open(io.BytesIO(raw))
            assert (round(d[i].rect.width), round(d[i].rect.height)) == (im.width, im.height), i
    finally:
        d.close()


def test_truncated_or_corrupt_images_are_still_400():
    cases = {
        "truncated jpeg": FX["jpeg-rgb"][: len(FX["jpeg-rgb"]) // 2],
        "truncated mpo": FX["mpo"][: len(FX["mpo"]) // 2],
        "truncated png": FX["png-rgb"][: len(FX["png-rgb"]) // 2],
        "garbage": b"\x00\x01not an image at all" * 20,
    }
    for label, raw in cases.items():
        try:
            _run(api.images_to_pdf(api.ImagesToPdfRequest(images=[_b64(raw)], page_size="fit")))
            assert False, f"{label}: expected HTTPException 400"
        except HTTPException as e:
            assert e.status_code == 400, f"{label}: {e.status_code}"


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
    print(f"\n{len(tests) - failed}/{len(tests)} images-to-pdf tests passed.")
    raise SystemExit(1 if failed else 0)
