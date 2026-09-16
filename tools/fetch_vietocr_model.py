"""Fetch the VietOCR recognition model into models/vietocr/ so the app ships offline.

WHY THIS EXISTS
---------------
`vietocr` 0.3.13 resolves its model at RUNTIME, from the network, twice over:

  * `Cfg.load_config_from_name()` GETs two YAMLs from https://vocr.vn on EVERY
    `Predictor` construction and caches nothing — so vocr.vn being down broke OCR
    even on a machine that had already used it.
  * `Predictor.__init__` downloads `vgg_transformer.pth` (151.8 MB) into
    `tempfile.gettempdir()` — i.e. %TEMP%, which Windows Storage Sense and Disk
    Cleanup delete on a schedule, so it silently re-downloads.

Measured on a machine that had already run OCR successfully: the engine needed
**286 s** to become ready because %TEMP% had been swept. That is the opposite of
DESIGN.md D2 ("local-first"), and HUONG-DAN-SU-DUNG.md's promise that later runs
work offline was not reliably true.

So the model is now fetched HERE, at build time, and bundled by sidecar.spec.
src/ocr/engine.py prefers the bundled copy and only falls back to the network when
it is absent (a dev checkout that has not run this script).

WHAT IS AND IS NOT IN GIT
-------------------------
The two YAMLs are small and are committed verbatim as fetched from upstream.
The 151.8 MB .pth is NOT in git (see .gitignore) — run this script to get it.

Usage:
    .venv\\Scripts\\python tools/fetch_vietocr_model.py          # weights only if missing
    .venv\\Scripts\\python tools/fetch_vietocr_model.py --force   # re-download
    .venv\\Scripts\\python tools/fetch_vietocr_model.py --configs # also refresh the YAMLs

Exit code 0 = models/vietocr/ holds a verified model. Non-zero = do not ship.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "models" / "vietocr"

WEIGHTS_URL = "https://vocr.vn/data/vietocr/vgg_transformer.pth"
WEIGHTS_NAME = "vgg_transformer.pth"
# Pinned so a truncated download, a proxy error page, or an upstream swap cannot be
# packaged by accident. If upstream legitimately republishes the model, update these
# two lines DELIBERATELY and re-run the OCR accuracy checks.
WEIGHTS_SHA256 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
WEIGHTS_SIZE = 151_815_373

CONFIG_BASE_URL = "https://vocr.vn/data/vietocr/config/"
CONFIG_NAMES = ("base.yml", "vgg-transformer.yml")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, expect_size: int | None = None) -> None:
    """Download to a .part file, then rename — never leave a half file in place."""
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as r:
        total = int(r.headers.get("Content-Length") or 0)
        if expect_size and total and total != expect_size:
            raise SystemExit(
                f"ERROR: {url} is {total} bytes, expected {expect_size}. "
                "Upstream changed — verify before updating the pins in this script."
            )
        done = 0
        with tmp.open("wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = 100 * done / total
                    print(f"\r  {done / 1048576:7.1f} / {total / 1048576:.1f} MB ({pct:5.1f}%)",
                          end="", flush=True)
        print()
    tmp.replace(dest)


def fetch_weights(force: bool) -> int:
    dest = DEST / WEIGHTS_NAME
    if dest.exists() and not force:
        if dest.stat().st_size == WEIGHTS_SIZE and sha256(dest) == WEIGHTS_SHA256:
            print(f"  {WEIGHTS_NAME}: already present and verified")
            return 0
        print(f"  {WEIGHTS_NAME}: present but does NOT match the pinned checksum — refetching")
    download(WEIGHTS_URL, dest, expect_size=WEIGHTS_SIZE)
    got = sha256(dest)
    if got != WEIGHTS_SHA256:
        print(f"ERROR: checksum mismatch\n  expected {WEIGHTS_SHA256}\n  got      {got}")
        return 1
    print(f"  {WEIGHTS_NAME}: verified ({dest.stat().st_size / 1048576:.1f} MB)")
    return 0


def fetch_configs() -> int:
    for name in CONFIG_NAMES:
        download(CONFIG_BASE_URL + name, DEST / name)
        print(f"  {name}: {(DEST / name).stat().st_size} bytes")
    print("  NOTE: these are committed to git — review `git diff` before keeping them.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="re-download the weights")
    ap.add_argument("--configs", action="store_true", help="also re-download the YAMLs")
    args = ap.parse_args()

    DEST.mkdir(parents=True, exist_ok=True)
    print(f"VietOCR model -> {DEST}")

    rc = 0
    if args.configs:
        rc |= fetch_configs()
    missing = [n for n in CONFIG_NAMES if not (DEST / n).is_file()]
    if missing:
        print(f"  configs missing ({', '.join(missing)}) — fetching")
        rc |= fetch_configs()
    rc |= fetch_weights(args.force)
    print("OK" if rc == 0 else "FAILED")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
