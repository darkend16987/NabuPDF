"""The word diff of /compare goes line-first on big documents (docs/REVIEW-2026-10-01 S4).

difflib.SequenceMatcher is quadratic on real, repetitive text. Measured with Zipf-distributed
words (a few words repeated a lot, like any contract or drawing schedule): 20k tokens 2.5 s,
40k 10.8 s, 60k 28.8 s, and the cap is 300k tokens - minutes with the event loop held.
Two-tier: diff the LINES first (a tenth of the length), then the words only inside changed line
blocks: 60k tokens in 0.02 s.

What is pinned, and why:
  * below the threshold the answer is EXACTLY the plain SequenceMatcher's - every ordinary
    contract keeps byte-for-byte what it always got;
  * the two-tier answer is always a VALID edit script (contiguous, ordered, equal blocks really
    equal, no two adjacent changes left unmerged, applying it to A gives B) - on random
    documents with every kind of edit, including swapped lines;
  * it is not meaningfully WORSE than the plain one (number of changed tokens), and on edits
    that touch single lines it finds the same changes - differences are ties between identical
    repeated words;
  * degenerate inputs (empty, identical, nothing in common, no line keys) behave;
  * big input is fast;
  * end to end through compare_pdfs with real PyMuPDF documents.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252).
"""

import difflib
import random
import time

import fitz  # PyMuPDF

from src.compare import comparator as C


VOCAB = [f"w{i}" for i in range(2000)]
WEIGHTS = [1.0 / (i + 1) for i in range(2000)]  # Zipf


def rw(rng):
    return rng.choices(VOCAB, WEIGHTS)[0]


def make_doc(rng, n_lines):
    return [[rw(rng) for _ in range(rng.randint(5, 13))] for _ in range(n_lines)]


def edit(rng, doc, n_edits, kinds):
    d = [list(line) for line in doc]
    for _ in range(n_edits):
        k = rng.choice(kinds)
        i = rng.randrange(len(d))
        if k == "word" and d[i]:
            d[i][rng.randrange(len(d[i]))] = "X" + rw(rng)
        elif k == "insword":
            d[i].insert(rng.randrange(len(d[i]) + 1), "I" + rw(rng))
        elif k == "delword" and len(d[i]) > 1:
            d[i].pop(rng.randrange(len(d[i])))
        elif k == "delline" and len(d) > 1:
            d.pop(i)
        elif k == "insline":
            d.insert(i, [rw(rng) for _ in range(rng.randint(5, 13))])
        elif k == "swap" and i + 1 < len(d):
            d[i], d[i + 1] = d[i + 1], d[i]
    return d


def flat(doc):
    words, toks = [], []
    for li, line in enumerate(doc):
        for w in line:
            words.append(w)
            toks.append({"t": w, "ln": (0, li)})
    return words, toks


def plain(a, b):
    return difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()


def changed(ops):
    n = 0
    for tag, i1, i2, j1, j2 in ops:
        if tag != "equal":
            n += (i2 - i1) + (j2 - j1)
    return n


def validate(ops, a, b):
    """Raise AssertionError unless `ops` is a valid, tidy edit script from a to b."""
    ai = bj = 0
    prev_nonequal = False
    rebuilt = []
    for tag, i1, i2, j1, j2 in ops:
        assert (i1, j1) == (ai, bj), f"not contiguous at {(i1, j1)} expected {(ai, bj)}"
        assert i2 >= i1 and j2 >= j1
        if tag == "equal":
            assert a[i1:i2] == b[j1:j2], "equal block differs"
            assert (i2 - i1) == (j2 - j1) and i2 > i1
            prev_nonequal = False
        else:
            assert not prev_nonequal, "two adjacent changes were not merged"
            assert (tag == "insert") == (i1 == i2) and (tag == "delete") == (j1 == j2), f"wrong tag {tag}"
            assert i2 > i1 or j2 > j1
            prev_nonequal = True
        rebuilt.extend(b[j1:j2])
        ai, bj = i2, j2
    assert (ai, bj) == (len(a), len(b)), "does not cover both sequences"
    assert rebuilt == list(b), "applying the script to A does not give B"


# --------------------------------------------------------------------------- #
def test_below_threshold_is_exactly_the_plain_diff():
    rng = random.Random(1)
    for _ in range(25):
        da = make_doc(rng, rng.randint(1, 80))
        db = edit(rng, da, rng.randint(0, 15), ["word", "insword", "delword", "insline", "delline", "swap"])
        wa, ta = flat(da)
        wb, tb = flat(db)
        assert C._diff_opcodes(wa, ta, wb, tb) == plain(wa, wb)  # default threshold 30k


def test_threshold_is_where_the_plain_diff_gets_slow():
    assert 20_000 <= C._TWO_TIER_MIN_TOKENS <= 50_000, C._TWO_TIER_MIN_TOKENS


def test_two_tier_is_always_a_valid_edit_script():
    rng = random.Random(3)
    kinds = ["word", "insword", "delword", "insline", "delline", "swap"]
    for n in range(60):
        da = make_doc(rng, rng.randint(2, 120))
        db = edit(rng, da, rng.randint(0, 40), kinds)
        wa, ta = flat(da)
        wb, tb = flat(db)
        ops = C._diff_opcodes(wa, ta, wb, tb, min_tokens=1)
        validate(ops, wa, wb)


def test_not_meaningfully_worse_than_plain_and_same_on_single_line_edits():
    rng = random.Random(4)
    same = total = 0
    for _ in range(30):
        da = make_doc(rng, 200)
        db = edit(rng, da, 12, ["word", "insword", "delword", "insline", "delline"])
        wa, ta = flat(da)
        wb, tb = flat(db)
        p, q = plain(wa, wb), C._diff_opcodes(wa, ta, wb, tb, min_tokens=1)
        validate(q, wa, wb)
        assert changed(q) <= changed(p) * 1.25 + 6, (changed(p), changed(q))
        total += 1
        same += changed(p) == changed(q)
    assert same >= total * 0.8, f"same size of change in only {same}/{total} typical-edit documents"
    # with swaps the plain diff may find a smaller script; the bound still holds
    da = make_doc(rng, 300)
    db = edit(rng, da, 30, ["swap", "word", "delline", "insline"])
    wa, ta = flat(da)
    wb, tb = flat(db)
    q = C._diff_opcodes(wa, ta, wb, tb, min_tokens=1)
    validate(q, wa, wb)
    assert changed(q) <= changed(plain(wa, wb)) * 1.25 + 6


def test_degenerate_inputs():
    wa, ta = flat([["a", "b"], ["c"]])
    for a, ta_, b, tb_ in (
        ([], [], [], []),
        ([], [], wa, ta),
        (wa, ta, [], []),
        (wa, ta, wa, ta),
        (wa, ta, *flat([["x", "y"], ["z"]])),
        (["solo"], [{"t": "solo", "ln": (0, 0)}], ["solo"], [{"t": "solo", "ln": (0, 0)}]),
    ):
        ops = C._diff_opcodes(a, ta_, b, tb_, min_tokens=0)
        validate(ops, a, b) if (a or b) else None
        assert ops == ([] if not (a or b) else ops)
    same = C._diff_opcodes(wa, ta, wa, ta, min_tokens=0)
    assert [o[0] for o in same] == ["equal"], "identical documents must report no change"
    assert all(o[0] == "equal" for o in C._diff_opcodes(["a"], [{"t": "a", "ln": 1}], ["a"], [{"t": "a", "ln": 1}], min_tokens=0))


def test_tokens_without_line_keys_still_give_the_plain_answer():
    # no key = one big line: the line pass sees one differing "line", the word pass does the
    # whole job - correct, merely not fast.
    a, b = ["a", "b", "c"], ["a", "x", "c"]
    ta = [{"t": w} for w in a]
    tb = [{"t": w} for w in b]
    assert C._diff_opcodes(a, ta, b, tb, min_tokens=0) == plain(a, b)


def test_big_input_is_fast():
    rng = random.Random(5)
    da = make_doc(rng, 6000)  # ~57k tokens: 28.8 s with the plain diff
    db = edit(rng, da, 150, ["word", "insword", "delword", "insline", "delline"])
    wa, ta = flat(da)
    wb, tb = flat(db)
    assert max(len(wa), len(wb)) >= C._TWO_TIER_MIN_TOKENS
    t = time.perf_counter()
    ops = C._diff_opcodes(wa, ta, wb, tb)  # default threshold: must take the two-tier path
    dt = time.perf_counter() - t
    validate(ops, wa, wb)
    assert dt < 3.0, f"{len(wa)} tokens took {dt:.2f}s"
    assert changed(ops) > 0


def _pdf(lines_per_page):
    d = fitz.open()
    for lines in lines_per_page:
        p = d.new_page(width=600, height=800)
        for k, ln in enumerate(lines):
            p.insert_text((30, 40 + 12 * k), ln, fontsize=8)
    b = d.tobytes()
    d.close()
    return b


def test_ocr_tokens_carry_their_line():
    # A scanned page: the engine's lines become the keys. The no-box fallback (recognition-only
    # engine) splits its text into lines the same way.
    import io
    import numpy as np
    from PIL import Image
    from src.offload import drive_sync

    buf = io.BytesIO()
    Image.fromarray(np.full((120, 200, 3), 250, np.uint8)).save(buf, format="PNG")
    d = fitz.open()
    pg = d.new_page(width=200, height=120)
    pg.insert_image(pg.rect, stream=buf.getvalue())

    class Boxes:
        def recognize_boxes(self, img):
            return [("one two", (0, 0, 50, 10)), ("three", (0, 20, 50, 30)), ("four five six", (0, 40, 50, 50))]

    class NoBoxes:
        def recognize_boxes(self, img):
            raise NotImplementedError

        def recognize(self, img):
            return "one two\nthree\nfour five six"

    for eng in (Boxes(), NoBoxes()):
        words = drive_sync(C._ocr_words_steps(pg, lambda e=eng: e))
        assert [w["t"] for w in words] == ["one", "two", "three", "four", "five", "six"]
        assert [w["ln"] for w in words] == [0, 0, 1, 2, 2, 2], [w["ln"] for w in words]
    d.close()


def test_tokens_carry_distinct_line_keys():
    # Without the keys everything is "one line" and the large-document path silently degrades
    # to the plain diff - same answers, no speed-up - so only this test can see it go missing.
    from src.offload import drive_sync

    doc = fitz.open("pdf", _pdf([["alpha beta gamma", "delta epsilon", "zeta"], ["eta theta"]]))
    toks = drive_sync(C._doc_tokens_steps(doc, "text", None))
    doc.close()
    keys = [t["ln"] for t in toks]
    assert all(k is not None for k in keys)
    by_line = {}
    for t in toks:
        by_line.setdefault(t["ln"], []).append(t["t"])
    # 3 lines on page 0 + 1 on page 1; the words of a line share one key
    assert sorted(len(v) for v in by_line.values()) == [1, 2, 2, 3], by_line
    assert {k[0] for k in keys} == {0, 1}, "the page number is part of the key"


def test_end_to_end_through_compare_pdfs_both_paths():
    rng = random.Random(6)
    pages_a = [[" ".join(rw(rng) for _ in range(9)) for _ in range(55)] for _ in range(6)]
    pages_b = [list(p) for p in pages_a]
    pages_b[1][10] = pages_b[1][10] + " ZZZ"
    del pages_b[3][20]
    pages_b[5].insert(5, "totally new line here")
    a, b = _pdf(pages_a), _pdf(pages_b)

    ref = C.compare_pdfs(a, b)  # plain path (well under the threshold)
    saved = C._TWO_TIER_MIN_TOKENS
    C._TWO_TIER_MIN_TOKENS = 1
    try:
        two = C.compare_pdfs(a, b)  # forced two-tier
    finally:
        C._TWO_TIER_MIN_TOKENS = saved
    assert ref["success"] and two["success"]
    assert ref["summary"]["changes"] == two["summary"]["changes"] >= 3
    assert ref["summary"]["changed_pages_a"] == two["summary"]["changed_pages_a"]
    assert ref["summary"]["changed_pages_b"] == two["summary"]["changed_pages_b"]
    assert ref["a_boxes"].keys() == two["a_boxes"].keys() and ref["b_boxes"].keys() == two["b_boxes"].keys()
    assert [c["type"] for c in ref["changes"]] == [c["type"] for c in two["changes"]]
    ident = C.compare_pdfs(a, a)
    C._TWO_TIER_MIN_TOKENS = 1
    try:
        ident2 = C.compare_pdfs(a, a)
    finally:
        C._TWO_TIER_MIN_TOKENS = saved
    assert ident["summary"]["identical"] and ident2["summary"]["identical"]


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
    print(f"\n{len(tests) - failed}/{len(tests)} compare-diff tests passed.")
    raise SystemExit(1 if failed else 0)
