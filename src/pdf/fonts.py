"""Font resolution + coverage helpers for the PDF text editor.

Extracted verbatim from api.py (Phase 4 conservative refactor). Self-contained:
no dependency on api. api.py re-imports these names, so every call site there is
unchanged. matplotlib/fitz/sys stay lazily imported inside the functions.
"""

import hashlib
import logging
import os
from collections import OrderedDict
from pathlib import Path

logger = logging.getLogger(__name__)


# Cache the resolved Unicode font path (Vietnamese-capable) across requests.
_FONT_PATH: str | None = None


def _vietnamese_font() -> str | None:
    """Find a TTF that covers Vietnamese diacritics for the invisible text layer.

    Prefers DejaVu Sans (full Vietnamese coverage), which ships with matplotlib —
    already a transitive dependency. P5 packaging should bundle this TTF explicitly.
    """
    global _FONT_PATH
    if _FONT_PATH is not None:
        return _FONT_PATH or None
    candidates: list[str] = []
    # In the frozen (PyInstaller) app matplotlib.get_data_path() can point somewhere
    # the collected fonts didn't land, so the DejaVu lookup silently fails and the
    # editor drops Vietnamese text to a Latin-1 builtin (→ □). Search the bundle root
    # (sys._MEIPASS) and the executable dir FIRST so a rebuild always finds the font.
    import sys as _sys
    frozen_roots: list[Path] = []
    mei = getattr(_sys, "_MEIPASS", None)
    if mei:
        frozen_roots.append(Path(mei))
    frozen_roots.append(Path(_sys.executable).resolve().parent)
    frozen_roots.append(Path(__file__).resolve().parent)
    for root in frozen_roots:
        candidates.append(str(root / "matplotlib" / "mpl-data" / "fonts" / "ttf" / "DejaVuSans.ttf"))
        candidates.append(str(root / "fonts" / "DejaVuSans.ttf"))
        candidates.append(str(root / "DejaVuSans.ttf"))
    try:
        # NB: use the data path (a real str), not font_manager.findfont(), which
        # returns a FontPath object that PyMuPDF rejects as "bad fontfile".
        import matplotlib
        candidates.append(str(Path(matplotlib.get_data_path()) / "fonts" / "ttf" / "DejaVuSans.ttf"))
    except Exception:  # pragma: no cover - matplotlib always present via deps
        pass
    try:
        for site in __import__("site").getsitepackages():
            candidates.append(str(Path(site) / "imgaug" / "DejaVuSans.ttf"))
    except Exception:
        pass
    for c in candidates:
        if c and Path(c).is_file():
            _FONT_PATH = c
            return c
    _FONT_PATH = ""  # cache "not found" to avoid re-searching
    return None


# DejaVu ships style variants beside the regular TTF. Using the real bold/oblique
# file renders far cleaner than faux-bold stroking (the old approach blobbed at
# small sizes). Returns None when the variant file is absent → caller faux-styles.
_DEJAVU_SUFFIX = {
    (False, False): "",
    (True, False): "-Bold",
    (False, True): "-Oblique",
    (True, True): "-BoldOblique",
}


def _dejavu_variant(base_path: str, bold: bool, italic: bool) -> str | None:
    if not base_path:
        return None
    suffix = _DEJAVU_SUFFIX[(bold, italic)]
    if not suffix:
        return base_path
    cand = Path(base_path).with_name(f"DejaVuSans{suffix}.ttf")
    return str(cand) if cand.is_file() else None


# fitz.Font objects, memoised. /edit-text builds one per edit (twice with underline) and
# the cost is the font program being parsed again: 13-22% of a 200-edit batch, ~31% on
# the 1600-edit "Thay tat ca" case (docs/REVIEW-2026-10-01 S7). Callers only READ a Font
# (ascender / descender / text_length / has_glyph), so sharing one is safe.
#   key  file   -> (path, mtime_ns, size)  a replaced font file is not served stale
#        name   -> the Base-14 name
#        buffer -> (length, blake2b)       a subset font lifted out of the document
# Failures are never cached (the caller's `except Exception` still sees every one).
# Bounded and LRU: a buffer-keyed Font keeps its font program alive. Not locked on
# purpose - fitz is only driven from the event loop.
_FONT_OBJ_CACHE: "OrderedDict[tuple, object]" = OrderedDict()
_FONT_OBJ_CACHE_MAX = 16  # 0 disables caching (the equivalence test uses that)


def _font_object(
    *,
    fontfile: str | None = None,
    fontname: str | None = None,
    fontbuffer: bytes | None = None,
):
    """`fitz.Font(...)` with the same precedence the call sites always used
    (buffer > file > name), served from a small LRU cache."""
    import fitz

    if fontbuffer:
        key = ("b", len(fontbuffer), hashlib.blake2b(fontbuffer, digest_size=16).digest())
        make = lambda: fitz.Font(fontbuffer=fontbuffer)  # noqa: E731
    elif fontfile:
        st = os.stat(fontfile)  # missing file raises, exactly like fitz.Font would
        key = ("f", str(fontfile), st.st_mtime_ns, st.st_size)
        make = lambda: fitz.Font(fontfile=fontfile)  # noqa: E731
    else:
        key = ("n", fontname)
        make = lambda: fitz.Font(fontname=fontname)  # noqa: E731

    hit = _FONT_OBJ_CACHE.get(key)
    if hit is not None:
        _FONT_OBJ_CACHE.move_to_end(key)
        return hit
    font = make()
    if _FONT_OBJ_CACHE_MAX > 0:
        _FONT_OBJ_CACHE[key] = font
        while len(_FONT_OBJ_CACHE) > _FONT_OBJ_CACHE_MAX:
            _FONT_OBJ_CACHE.popitem(last=False)
    return font


def _font_covers(
    text: str,
    *,
    fontfile: str | None = None,
    fontname: str | None = None,
    fontbuffer: bytes | None = None,
) -> bool:
    """True if the font has a real glyph for every char in `text`.

    Guards the text-edit redraw: a Base-14 builtin (helv/tiro/cour), a mis-resolved
    local TTF, or a SUBSET font program lifted out of the source PDF may lack the
    glyphs we are about to draw, in which case insert_text SILENTLY draws notdef
    boxes (□) instead of raising — so we must check coverage up front and fall back
    to the bundled DejaVu when any glyph is missing.
    """
    try:
        f = _font_object(fontfile=fontfile, fontname=fontname, fontbuffer=fontbuffer)
    except Exception:
        return False
    try:
        for ch in set(text):
            if ch.isspace():
                continue
            if f.has_glyph(ord(ch)) == 0:
                return False
        return True
    except Exception:
        return False


def _fresh_fontname(page, base: str) -> str:
    """A font resource name `page` is not already using.

    Page.insert_font() matches on the RESOURCE name: if the page already has one,
    it returns that font and IGNORES the fontfile we passed. A previous edit round
    leaves its own /vnedit, /loc… behind — and subset_fonts() has since stripped
    them down to just that round's glyphs — so reusing a name silently redraws with
    a subset that can't cover the new text, giving notdef boxes (□) for every char
    the earlier round didn't happen to use. Always embed under an unused name.
    """
    try:
        used = {f[4] for f in page.get_fonts()}
    except Exception:
        return base
    if base not in used:
        return base
    i = 1
    while f"{base}{i}" in used:
        i += 1
    return f"{base}{i}"


# PyMuPDF Base14 names by (bold, italic). Real font variants, no faux needed.
_BUILTIN_VARIANTS = {
    "helv": {(False, False): "helv", (True, False): "hebo", (False, True): "heit", (True, True): "hebi"},
    "tiro": {(False, False): "tiro", (True, False): "tibo", (False, True): "tiit", (True, True): "tibi"},
    "cour": {(False, False): "cour", (True, False): "cobo", (False, True): "coit", (True, True): "cobi"},
}


# ---- local system fonts (text edit) --------------------------------------
# matplotlib's font_manager already indexes the machine's installed fonts
# (C:\Windows\Fonts on Windows). We reuse it both to list families for the UI
# and to resolve a family + style → an actual TTF the editor can embed, so an
# edited span can keep its original font instead of falling back to DejaVu.
import re as _re

_LOCAL_FONT_CACHE: dict[tuple[str, bool, bool], str] = {}


def _clean_font_name(name: str) -> str:
    """Normalise a PDF/PostScript font name to a plain family for lookup.

    Strips the 6-char subset prefix ("ABCDEF+Arial") and common style suffixes
    ("TimesNewRomanPS-BoldMT" → "TimesNewRoman").
    """
    if "+" in name and len(name.split("+", 1)[0]) == 6:
        name = name.split("+", 1)[1]
    name = name.split(",")[0].split("-")[0]
    name = _re.sub(r"(PSMT|PS|MT)$", "", name)
    return name.strip() or name


# Normalised index of installed families: {alnum-lowercased name: real family}.
# A PDF font name like "TimesNewRomanPSMT" cleans to "TimesNewRoman" (no spaces),
# which matplotlib can't match against the installed "Times New Roman". Normalising
# both sides (drop spaces/case) lets us recover the real family so findfont resolves.
_FAM_INDEX: dict[str, str] | None = None


def _norm_fam(s: str) -> str:
    return _re.sub(r"[^a-z0-9]", "", s.lower())


# Style words a PDF font name glues onto its family, with or without a separator:
# "TimesNewRomanBold", "Arial-BoldMT", "SVN-Times New Roman Bold". Stripping them
# is what turns such a name into something the machine's font index can match.
#
# "Roman" is deliberately NOT in this list: it is part of the family name
# "Times New Roman", not a style — stripping it would leave "Times New", which
# matches nothing, and the whole lookup would fall back to DejaVu again.
_STYLE_TOKENS = (
    "BoldItalic|BoldOblique|SemiBold|DemiBold|ExtraBold|UltraBold|Demi|Bold|"
    "Italic|Oblique|Regular|Normal|Book|Light|Medium|Black|Heavy|Thin|"
    "Condensed|Narrow|PSMT|PS|MT|Std|Pro"
)
_STYLE_SUFFIX_RE = _re.compile(rf"[\s_-]*(?:{_STYLE_TOKENS})$", _re.IGNORECASE)


def _strip_style_suffix(name: str) -> str:
    """Drop trailing style words from a font name ("TimesNewRomanBold" → "TimesNewRoman").

    Repeats so compound tails come off too ("...PS-BoldMT" → "..."). Never returns
    an empty string: if a name is nothing but style words, the original is kept.
    """
    cur = name
    while True:
        nxt = _STYLE_SUFFIX_RE.sub("", cur).strip(" -_")
        if not nxt or nxt == cur:
            return cur
        cur = nxt


def _family_candidates(name: str) -> list[str]:
    """Family names to try for a PDF font name, most-trusted first.

    1. `_clean_font_name` — the historical behaviour, so every name that resolved
       before still resolves to exactly the same file.
    2. the same name with its style suffix stripped — this is what rescues
       "TimesNewRomanBold" (style glued on with no separator, so rule 1's
       `split("-")` can't see it).
    3. the raw name minus the subset prefix — for families that legitimately
       contain a hyphen ("SVN-Times New Roman"), which rule 1 truncates to "SVN".
    """
    raw = name or ""
    if "+" in raw and len(raw.split("+", 1)[0]) == 6:
        raw = raw.split("+", 1)[1]
    raw = raw.split(",")[0].strip()
    out: list[str] = []
    for c in (_clean_font_name(name or ""), _strip_style_suffix(raw), raw):
        c = (c or "").strip()
        if c and c not in out:
            out.append(c)
    return out


def _family_index() -> dict[str, str]:
    global _FAM_INDEX
    if _FAM_INDEX is None:
        idx: dict[str, str] = {}
        try:
            from matplotlib import font_manager as fm
            for f in fm.fontManager.ttflist:
                idx.setdefault(_norm_fam(f.name), f.name)
        except Exception as fe:
            logger.debug("build family index failed: %s", fe)
        _FAM_INDEX = idx
    return _FAM_INDEX


def _resolve_local_font(name: str, bold: bool, italic: bool) -> str | None:
    """Resolve a font family name + style to a local TTF path, or None.

    Uses matplotlib.font_manager.findfont with fallback disabled so a missing
    family raises (→ None) instead of silently returning DejaVu — the caller
    then applies its own DejaVu fallback for Vietnamese safety.
    """
    key = (name, bold, italic)
    if key in _LOCAL_FONT_CACHE:
        return _LOCAL_FONT_CACHE[key] or None
    path = ""
    try:
        from matplotlib import font_manager as fm

        index = _family_index()
        # Map each candidate onto a real installed family (handles space-collapsed
        # PDF names like "TimesNewRoman" -> "Times New Roman"). Candidate order is
        # what keeps this backwards-compatible: the historical cleaned name is
        # tried first, so names that already resolved are unaffected.
        cands = _family_candidates(name)
        families = []
        for c in cands:
            fam = index.get(_norm_fam(c))
            if fam and fam not in families:
                families.append(fam)
        # Last resort: hand the cleaned name to findfont as-is (fontconfig aliases
        # on Linux, generic families). Same call the old code made.
        if cands and cands[0] not in families:
            families.append(cands[0])
        for family in families:
            try:
                fp = fm.FontProperties(
                    family=family,
                    weight="bold" if bold else "normal",
                    style="italic" if italic else "normal",
                )
                found = fm.findfont(fp, fallback_to_default=False)
            except Exception:  # ValueError when no family matches
                continue
            # findfont returns a FontPath (a str subclass carrying a face index) that
            # PyMuPDF's insert_font rejects as "bad fontfile" — coerce to a plain str.
            if found and Path(found).is_file():
                path = str(found)
                break
    except Exception as fe:
        logger.debug("resolve local font '%s' failed: %s", name, fe)
        path = ""
    _LOCAL_FONT_CACHE[key] = path
    return path or None


def _page_font_buffers(doc, page) -> dict[str, bytes]:
    """The font programs a page already embeds, keyed by normalised family name.

    Used by /edit-text as the second-choice way to "keep the original font": when
    the family isn't installed on this machine (corporate/CAD faces, SVN-*, .Vn*),
    the PDF itself is carrying the only copy that exists.

    MUST be called BEFORE Page.apply_redactions(): removing the last glyphs drawn
    with a font can take its resource off the page, and then there is nothing left
    to extract.

    The buffers are almost always SUBSETS — they hold only the glyphs the document
    happened to use — so every caller has to verify coverage (`_font_covers`) before
    drawing with one, or it redraws notdef boxes (□). Best-effort throughout: any
    font that won't extract is simply absent from the result.
    """
    out: dict[str, bytes] = {}
    try:
        fonts = page.get_fonts(full=False)
    except Exception as fe:
        logger.debug("get_fonts failed: %s", fe)
        return out
    for f in fonts:
        try:
            xref = int(f[0])
            basefont = str(f[3])
        except Exception:
            continue
        key = _norm_fam(_clean_font_name(basefont))
        if not key or key in out:
            continue
        try:
            _name, ext, _subtype, buf = doc.extract_font(xref)
        except Exception as fe:
            logger.debug("extract_font %s failed: %s", basefont, fe)
            continue
        # "n/a" = a Base-14 font with no embedded program (nothing to reuse).
        if buf and len(buf) > 4 and str(ext).lower() in ("ttf", "otf", "cff", "ttc"):
            out[key] = bytes(buf)
    return out


def _strip_subset_prefix(name: str) -> str:
    """"ABCDEF+Arial-BoldMT" → "Arial-BoldMT"; anything else unchanged."""
    if "+" in name and len(name.split("+", 1)[0]) == 6:
        return name.split("+", 1)[1]
    return name


_REGULAR_SUFFIX_RE = _re.compile(r"(book|regular|normal)$")


def _font_program_key(name: str) -> str:
    """Matching key for `_page_font_programs_exact`: subset prefix dropped, case and
    punctuation folded, and a trailing REGULAR-weight word removed.

    The span's font name and the font's /BaseFont need not be spelled alike: PyMuPDF
    names a font it embeds "DejaVu Sans Book" in /BaseFont while text extraction
    reports the PostScript name "DejaVuSans" (measured). Only words that mean
    "regular" are dropped — never Bold/Italic — so a bold run can still never be
    matched to its regular sibling, which is the collision this function exists to
    avoid. "Roman" is not one of them (Times New Roman, see _STYLE_TOKENS)."""
    k = _norm_fam(_strip_subset_prefix(str(name or "")))
    return _REGULAR_SUFFIX_RE.sub("", k) or k


def _page_font_programs_exact(doc, page, names) -> dict[str, bytes]:
    """The embedded font program of each font in `names`, keyed by
    `_font_program_key` — the exact face, not the family.

    Why not `_page_font_buffers`: that one keys by FAMILY, so "ArialMT" and
    "Arial-BoldMT" collide on "arial" and the first one wins. Fine for its job (a
    face to draw with, coverage-checked), wrong for measuring: /edit-text uses this
    to read the ORIGINAL run's glyph advances (BI-25, the descriptor-fallback case),
    and a bold run measured with the regular program is ~5–8 % off.

    Same contract as `_page_font_buffers`: call BEFORE apply_redactions, and treat a
    missing entry as "not available" — best-effort, never raises.
    """
    want = {_font_program_key(n) for n in names if n} - {""}
    out: dict[str, bytes] = {}
    if not want:
        return out
    try:
        fonts = page.get_fonts(full=False)
    except Exception as fe:
        logger.debug("get_fonts failed: %s", fe)
        return out
    for f in fonts:
        try:
            xref = int(f[0])
            key = _font_program_key(str(f[3]))
        except Exception:
            continue
        if key not in want or key in out:
            continue
        try:
            _name, ext, _subtype, buf = doc.extract_font(xref)
        except Exception as fe:
            logger.debug("extract_font %s failed: %s", key, fe)
            continue
        if buf and len(buf) > 4 and str(ext).lower() in ("ttf", "otf", "cff", "ttc"):
            out[key] = bytes(buf)
    return out


# ---- the text layer of what /edit-text draws ----------------------------------
#
# insert_text on an embedded TrueType writes a ToUnicode CMap built by REVERSING the
# font's whole cmap. Where two code points share one glyph the reversal has to pick
# one, and PyMuPDF 1.27.2 picks the wrong one for the two that matter most: Windows
# Arial maps U+002D and U+00AD (soft hyphen) to glyph 16, U+0020 and U+00A0 to glyph
# 3, and the CMap says <0010> <00AD>, <0003> <00A0>. The page LOOKS right; its text
# says "I2_BD\xadS\xad5.001\xa0…" — so the word cannot be found again, and a copy
# carries invisible soft hyphens into Excel. Measured on the customer's drawing set
# after a Thay tất cả; DejaVu (separate glyphs) does not show it, which is why the
# test grid never did.
#
# The fix is exact for what /edit-text drew: every glyph it drew maps to the character
# it was drawn FOR. It is MERGED into the existing CMap, never substituted for it:
# PyMuPDF shares ONE font object across every page that inserts the same font file
# (measured — a per-page rewrite left page 2 with page 13's digits), so the stream is
# shared state, and anything already in it stays exactly as it was.

_HEX = r"<([0-9A-Fa-f]+)>"
_BFCHAR_RE = _re.compile(r"beginbfchar(.*?)endbfchar", _re.S)
_BFRANGE_RE = _re.compile(r"beginbfrange(.*?)endbfrange", _re.S)
_PAIR_RE = _re.compile(_HEX + r"\s*" + _HEX)
_RANGE_RE = _re.compile(_HEX + r"\s*" + _HEX + r"\s*(?:" + _HEX + r"|\[([^\]]*)\])")


def _utf16_hex_to_str(h: str) -> str:
    # PyMuPDF writes code points above the BMP as the bare number — "<10780>", five
    # digits — instead of a UTF-16 surrogate pair (measured, Arial's own CMap). Not
    # valid UTF-16, so read it as the code point it obviously means; the CMap written
    # back encodes it properly.
    if len(h) % 4:
        return chr(int(h, 16))
    return bytes.fromhex(h).decode("utf-16-be", errors="strict")


def _parse_tounicode(data: bytes) -> dict[int, str] | None:
    """code → text for a ToUnicode CMap of 2-byte codes; None if anything in it is
    not understood (then the caller must leave the stream alone)."""
    try:
        txt = data.decode("latin-1")
        out: dict[int, str] = {}
        for block in _BFCHAR_RE.findall(txt):
            for src, dst in _PAIR_RE.findall(block):
                out[int(src, 16)] = _utf16_hex_to_str(dst)
        for block in _BFRANGE_RE.findall(txt):
            for lo, hi, dst, arr in _RANGE_RE.findall(block):
                a, b = int(lo, 16), int(hi, 16)
                if b < a or b - a > 0xFFFF:
                    return None
                if arr:
                    items = _re.findall(_HEX, arr)
                    for k, h in enumerate(items[: b - a + 1]):
                        out[a + k] = _utf16_hex_to_str(h)
                elif len(dst) % 4:
                    # The bare-code-point form above, as a range start.
                    for k in range(b - a + 1):
                        out[a + k] = chr(int(dst, 16) + k)
                else:
                    base = bytes.fromhex(dst)
                    # Only the LAST byte of the destination increments (the CMap rule).
                    for k in range(b - a + 1):
                        cur = base[:-1] + bytes([(base[-1] + k) & 0xFF])
                        out[a + k] = cur.decode("utf-16-be", errors="strict")
        return out
    except Exception:
        return None


def _tounicode_cmap(code_to_text: dict[int, str]) -> bytes:
    """A ToUnicode CMap (2-byte codes) for `code_to_text`, runs folded into bfrange.

    A run is folded only where the CMap rule allows it: codes that differ in the last
    byte alone, and single BMP destinations that also differ in the last byte alone."""
    items = sorted((c, t) for c, t in code_to_text.items() if 0 <= c <= 0xFFFF and t)
    ranges: list[tuple[int, int, str]] = []
    singles: list[tuple[int, str]] = []
    i = 0
    while i < len(items):
        c0, t0 = items[i]
        j = i
        if len(t0) == 1 and ord(t0) <= 0xFFFF:
            while (
                j + 1 < len(items)
                and items[j + 1][0] == items[j][0] + 1
                and items[j + 1][0] >> 8 == c0 >> 8
                and len(items[j + 1][1]) == 1
                and ord(items[j + 1][1]) == ord(items[j][1]) + 1
                and ord(items[j + 1][1]) >> 8 == ord(t0) >> 8
            ):
                j += 1
        if j > i:
            ranges.append((c0, items[j][0], t0))
        else:
            singles.append((c0, t0))
        i = j + 1

    def hx(t: str) -> str:
        return t.encode("utf-16-be").hex().upper()

    out = [
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo <</Registry(Adobe)/Ordering(UCS)/Supplement 0>> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
    ]
    for k in range(0, len(ranges), 100):  # the CMap format caps a block at 100
        chunk = ranges[k:k + 100]
        out.append(f"{len(chunk)} beginbfrange\n")
        out.extend(f"<{a:04X}> <{b:04X}> <{hx(t)}>\n" for a, b, t in chunk)
        out.append("endbfrange\n")
    for k in range(0, len(singles), 100):
        chunk = singles[k:k + 100]
        out.append(f"{len(chunk)} beginbfchar\n")
        out.extend(f"<{c:04X}> <{hx(t)}>\n" for c, t in chunk)
        out.append("endbfchar\n")
    out.append("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")
    return "".join(out).encode("ascii")


def _drawn_glyph_map(font, chars) -> dict[int, str]:
    """glyph id → the character drawn with it, for the characters in `chars`.

    Two characters on one glyph (the user really typed both '-' and a soft hyphen)
    cannot both be right; the LOWER code point wins, so ASCII beats its look-alike —
    the deterministic choice, and the one every reader expects for a hyphen."""
    out: dict[int, str] = {}
    for ch in sorted(set(chars)):
        if ch in "\n\r\t":
            continue
        try:
            gid = int(font.has_glyph(ord(ch)))
        except Exception:
            continue
        if gid > 0 and gid not in out:
            out[gid] = ch
    return out


def _font_xref_for_resource(page, fontname: str) -> int:
    """xref of the font `page` knows as resource `fontname`; 0 if none."""
    try:
        return next((int(f[0]) for f in page.get_fonts(full=True) if f[4] == fontname), 0)
    except Exception:
        return 0


def _merge_tounicode(doc, font_xref: int, gid_to_text: dict[int, str]) -> bool:
    """Override `gid_to_text` in the ToUnicode of Type0 font `font_xref`, keeping
    every other entry. False (and nothing changed) when there is no ToUnicode or it
    cannot be parsed — the drawn text is right either way; only its text layer stays
    as PyMuPDF wrote it."""
    if not gid_to_text or not font_xref:
        return False
    try:
        kind, val = doc.xref_get_key(font_xref, "ToUnicode")
        if kind != "xref":
            return False
        tu_xref = int(val.split()[0])
        cur = _parse_tounicode(doc.xref_stream(tu_xref) or b"")
        if cur is None:
            return False
        changed = {g: t for g, t in gid_to_text.items() if cur.get(g) != t}
        if not changed:
            return True
        cur.update(changed)
        doc.update_stream(tu_xref, _tounicode_cmap(cur))
        return True
    except Exception as fe:
        logger.debug("ToUnicode merge for xref %s failed: %s", font_xref, fe)
        return False


def _list_local_font_families() -> list[str]:
    try:
        from matplotlib import font_manager as fm

        return sorted({f.name for f in fm.fontManager.ttflist})
    except Exception as fe:
        logger.debug("list local fonts failed: %s", fe)
        return []
