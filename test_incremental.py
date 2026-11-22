"""BI-128 — lõi ghi nối `src/pdf/incremental.py`.

BA TẦNG, vì mỗi tầng bắt một loại lỗi khác:

  1. TÀI LIỆU GIẢ (`FakeDoc`) — dựng CHÍNH XÁC những tình huống mà không file thật nào cho ta chọn:
     kho object stream trùng số, ô trống bị tái dùng, chữ ký đổi, một object lỗi theo cách không
     phải "ô trống"… `plan_changes` chỉ dùng vài phương thức đọc nên giả được, và nhanh.
  2. FILE THẬT TỰ DỰNG bằng PyMuPDF — chứng minh các bẫy ghi: stream mất `/Filter` (chữ mới biến mất,
     ảnh JPEG thành rác), file nối phải bắt đầu bằng đúng byte của gốc, từ chối không để lại file dở.
  3. FILE KÝ THẬT từ corpus pdf.js qua pdf-lib (bỏ qua nếu máy không có corpus/node) — vì file tự
     dựng chỉ chứng minh ta nhất quán với chính mình. Tầng này đã bắt: `/Length` gián tiếp làm 348/350
     object bị coi là "đã đổi" (+778 KB cho một lần xoay trang), và `xref_set_key` làm rơi dấu ngoặc
     của khoá kiểu chuỗi.

Plain-runner style (no pytest). ASCII-only console output (Windows cp1252) — assertion messages
below are ASCII on purpose.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

from src.pdf import incremental as inc

ROOT = Path(__file__).resolve().parent
CORPUS = Path(os.environ.get("NABU_CORPUS", r"D:\GitHub\_refs\pdfjs-corpus\test\pdfs"))
QPDF = os.environ.get("NABU_QPDF", r"D:\GitHub\_refs\tools\qpdf\qpdf-12.4.2-msvc64\bin\qpdf.exe")


# --------------------------------------------------------------------------- #
# tầng 1: tài liệu giả
# --------------------------------------------------------------------------- #
class FakeDoc:
    """Chỉ đủ phương thức mà `plan_changes` đọc. Ô không có trong `objs` = ô TRỐNG, báo đúng thông điệp
    mà PyMuPDF thật báo (đo): `RuntimeError("code=7: cannot find object in xref (N 0 R)")`."""

    def __init__(self, objs, root=1, length=None):
        self.objs = objs
        self.root = root
        self._len = length if length is not None else (max(objs) + 1 if objs else 1)

    def pdf_catalog(self):
        return self.root

    def xref_length(self):
        return self._len

    def _get(self, x):
        o = self.objs.get(x)
        if o is None:
            raise RuntimeError(f"code=7: cannot find object in xref ({x} 0 R)")
        if "error" in o:
            raise RuntimeError(o["error"])
        return o

    def xref_object(self, x, compressed=False):
        return self._get(x)["text"]

    def xref_get_key(self, x, key):
        return self._get(x)["keys"].get(key, ("null", "null"))

    def xref_get_keys(self, x):
        return list(self._get(x)["keys"])

    def xref_is_stream(self, x):
        return self._get(x)["stream"] is not None

    def xref_stream_raw(self, x):
        return self._get(x)["stream"]


def mk(text=None, keys=None, stream=None, typ=None, error=None):
    """Một object giả. `text` mặc định được sinh ra từ `keys` (xác định, nên hai object cùng khoá ⇒ cùng văn bản)."""
    if error:
        return {"error": error}
    keys = dict(keys or {})
    if typ:
        keys["Type"] = ("name", typ)
    if text is None:
        text = "<<" + "".join(f" /{k} {v[1]}" for k, v in sorted(keys.items())) + " >>"
    return {"text": text, "keys": keys, "stream": stream}


I = lambda n: ("int", str(n))  # noqa: E731


def refusal_of(fn, *a):
    try:
        fn(*a)
    except inc.IncrementalRefused as e:
        return e.reason
    return None


def test_unchanged_documents_plan_nothing():
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)})})
    p = inc.plan_changes(o, FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)})}))
    assert p == ([], [], []), p


def test_changed_and_new_objects_are_planned():
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)})})
    n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(2)}), 3: mk(keys={"B": I(1)})})
    p = inc.plan_changes(o, n)
    assert p.changed == [2] and p.added == [3] and p.reused == [], p


def test_root_must_be_the_same_object():
    o = FakeDoc({1: mk(typ="/Catalog")}, root=1)
    n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(typ="/Catalog")}, root=2)
    assert refusal_of(inc.plan_changes, o, n) == "root_changed"


def test_container_collision_is_refused():
    """pdf-lib cap kho MOI o so trung so kho dang chua object song cua file goc (160F-2019: 543-546)."""
    o = FakeDoc({1: mk(typ="/Catalog"), 5: mk(typ="/ObjStm", stream=b"x")})
    n = FakeDoc({1: mk(typ="/Catalog"), 5: mk(keys={"Foo": I(1)})})  # object THUONG tren so dang la kho cua goc
    assert refusal_of(inc.plan_changes, o, n) == "container_collision"
    # ... va ca kho XRef (file dung xref stream).
    o2 = FakeDoc({1: mk(typ="/Catalog"), 5: mk(typ="/XRef", stream=b"x")})
    assert refusal_of(inc.plan_changes, o2, n) == "container_collision"


def test_containers_on_the_edited_side_are_skipped_not_copied():
    """Kho cua pdf-lib phia `edited` KHONG duoc chep (bay so 2) — chi object con."""
    o = FakeDoc({1: mk(typ="/Catalog"), 5: mk(typ="/ObjStm", stream=b"old"), 6: mk(keys={"A": I(1)})})
    n = FakeDoc({
        1: mk(typ="/Catalog"),
        5: mk(typ="/ObjStm", stream=b"DIFFERENT-NEW-CONTAINER"),  # cung so, khac noi dung — van la kho
        6: mk(keys={"A": I(2)}),
        7: mk(typ="/ObjStm", stream=b"another new container"),  # kho moi o so moi
        8: mk(typ="/XRef", stream=b"xref"),
    })
    p = inc.plan_changes(o, n)
    assert p.changed == [6] and p.added == [], p


def test_empty_slot_reuse_is_allowed_and_counted():
    """Ban dau TU CHOI ca nay (slot_mismatch) va chan nham file ky that prefilled_f1040 (1/7). Do: PyMuPDF
    ghi object moi o o trong voi gen 0, tham chieu `N 0 R` van toi duoc, qpdf ma 0."""
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)}), 4: mk(keys={"B": I(1)})}, length=6)
    n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)}), 3: mk(keys={"New": I(1)}), 5: mk(keys={"New": I(2)})},
                length=7)
    p = inc.plan_changes(o, n)
    # 3 va 5 la o trong o goc (< xref_length), 6 khong ton tai o ca hai.
    assert p.added == [3, 5] and p.reused == [3, 5] and p.changed == [], p
    n2 = FakeDoc({1: mk(typ="/Catalog"), 7: mk(keys={"New": I(1)})}, length=8)
    p2 = inc.plan_changes(FakeDoc({1: mk(typ="/Catalog")}, length=3), n2)
    assert p2.added == [7] and p2.reused == [], p2  # vuot bang xref cua goc: moi, khong phai tai dung


def test_objects_dropped_by_the_edit_are_left_alone():
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)}), 3: mk(keys={"B": I(1)})})
    n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)})}, length=4)  # object 3 bi bo
    assert inc.plan_changes(o, n) == ([], [], [])


def test_stream_length_only_difference_is_not_a_change():
    """tracemonkey: goc ghi /Length 674 0 R, pdf-lib ghi /Length 1013 — cung du lieu tho. Coi la 'da doi' thi
    xoay mot trang tao +778 KB (348/350 object)."""
    data = b"\x78\x9c" + b"A" * 50
    o = FakeDoc({1: mk(typ="/Catalog"),
                 2: mk(keys={"Filter": ("name", "/FlateDecode"), "Length": ("xref", "9 0 R")}, stream=data)})
    n = FakeDoc({1: mk(typ="/Catalog"),
                 2: mk(keys={"Filter": ("name", "/FlateDecode"), "Length": I(52)}, stream=data)})
    assert inc.plan_changes(o, n).changed == []


def test_stream_real_differences_are_changes():
    base = {"Filter": ("name", "/FlateDecode"), "Length": I(52)}
    data = b"\x78\x9c" + b"A" * 50
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=base, stream=data)})
    # du lieu tho khac
    assert inc.plan_changes(o, FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=base, stream=data[:-1] + b"B")})).changed == [2]
    # khoa khac Length khac
    k2 = dict(base, Filter=("name", "/DCTDecode"))
    assert inc.plan_changes(o, FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=k2, stream=data)})).changed == [2]
    # khoa them vao
    k3 = dict(base, DecodeParms=("dict", "<</Predictor 12>>"))
    assert inc.plan_changes(o, FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=k3, stream=data)})).changed == [2]
    # stream -> khong phai stream
    assert inc.plan_changes(o, FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=base)})).changed == [2]


def test_value_type_matters_not_just_the_printed_value():
    """So 5 va chuoi (5) in ra cung la '5' qua xref_get_key — chi so gia tri thi khoa doi kieu bi bo sot."""
    data = b"zz"
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"K": ("int", "5")}, stream=data)})
    n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"K": ("string", "5")}, stream=data)})
    assert inc.plan_changes(o, n).changed == [2]


def test_signature_objects_are_never_overwritten():
    """Ba kieu object chu ky: /ByteRange, /Type /Sig, /FT /Sig. Doi bat ky cai nao ⇒ tu choi."""
    flavours = {
        "ByteRange": {"ByteRange": ("array", "[0 1 2 3]"), "Contents": ("string", "00")},
        "Type Sig": {"Type": ("name", "/Sig"), "Reason": ("string", "a")},
        "FT Sig": {"FT": ("name", "/Sig"), "T": ("string", "Signature1")},
    }
    for name, keys in flavours.items():
        o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=keys)})
        changed = dict(keys)
        changed["Extra"] = I(1)
        n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=changed)})
        assert refusal_of(inc.plan_changes, o, n) == "signature_object_changed", name
        # khong doi ⇒ binh thuong, khong tu choi, khong nam trong ke hoach
        assert inc.plan_changes(o, FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=keys)})) == ([], [], []), name


def test_signature_comparison_ignores_whitespace_but_not_content():
    keys = {"ByteRange": ("array", "[0 1 2 3]"), "Contents": ("string", "DEADBEEF")}
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys=keys, text="<< /ByteRange [0 1 2 3] /Contents <DEADBEEF> >>")})
    same = FakeDoc({1: mk(typ="/Catalog"),
                    2: mk(keys=keys, text="<<\n  /Contents <DEADBEEF>\n  /ByteRange [ 0 1 2 3 ]\n>>")})
    assert inc.plan_changes(o, same) == ([], [], [])  # cach viet khac khong phai "chu ky bi doi"
    diff = FakeDoc({1: mk(typ="/Catalog"),
                    2: mk(keys=dict(keys, Contents=("string", "DEADBEEE")))})
    assert refusal_of(inc.plan_changes, o, diff) == "signature_object_changed"


def test_unreadable_object_is_refused_not_swallowed():
    """Chi hai thong diep 'o trong' la 'vang mat'. Loi khac la object hong that — nuot no la bo roi mot
    object dang duoc tham chieu."""
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)})})
    n = FakeDoc({1: mk(typ="/Catalog"), 2: mk(error="code=8: syntax error: unexpected token")})
    assert refusal_of(inc.plan_changes, o, n) == "unreadable_object"
    # ... con o trong that su (khong co trong objs) thi bo qua nhe nhang
    n2 = FakeDoc({1: mk(typ="/Catalog")}, length=3)
    assert inc.plan_changes(o, n2) == ([], [], [])
    # object loi o phia GOC cung phai tu choi, khong coi la "o trong ⇒ tai dung"
    o3 = FakeDoc({1: mk(typ="/Catalog"), 2: mk(error="code=8: syntax error")})
    n3 = FakeDoc({1: mk(typ="/Catalog"), 2: mk(keys={"A": I(1)})})
    assert refusal_of(inc.plan_changes, o3, n3) == "unreadable_object"


def test_non_dictionary_objects_are_compared_by_text():
    """Mang, so, chuoi: `xref_get_keys` tra rong, nen so theo khoa luon 'bang nhau' va bo lot MOI khac biet.
    Rieng chung phai so van ban — ca mot mang /Contents hay /Kids bi doi cung phai duoc noi."""
    o = FakeDoc({1: mk(typ="/Catalog"), 2: mk(text="[ 1 2 3 ]", keys={}), 3: mk(text="42", keys={})})
    same = FakeDoc({1: mk(typ="/Catalog"), 2: mk(text="[ 1 2 3 ]", keys={}), 3: mk(text="42", keys={})})
    diff = FakeDoc({1: mk(typ="/Catalog"), 2: mk(text="[ 1 2 4 ]", keys={}), 3: mk(text="43", keys={})})
    assert inc.plan_changes(o, same).changed == []
    assert inc.plan_changes(o, diff).changed == [2, 3], inc.plan_changes(o, diff)


def test_verify_objects_catches_each_kind_of_mismatch():
    """`_verify_objects` la chot chan cuoi: phai bat tung loai lech, va tra DUNG ly do duoc yeu cau
    (`apply_failed` sau khi ghi trong bo nho, `verify_failed` sau khi mo lai tu dia)."""
    k = {"Filter": ("name", "/FlateDecode"), "Length": I(3)}
    good = FakeDoc({2: mk(keys=k, stream=b"abc")})
    inc._verify_objects(good, FakeDoc({2: mk(keys=k, stream=b"abc")}), [2])  # giong het: khong ne

    # Tu dien giong, DU LIEU STREAM THO KHAC (chi viec nay moi lot qua phep so khoa)
    assert refusal_of(inc._verify_objects, good, FakeDoc({2: mk(keys=k, stream=b"abX")}), [2]) == "apply_failed"
    # Tu dien khac
    assert refusal_of(inc._verify_objects, good, FakeDoc({2: mk(keys=dict(k, Extra=I(1)), stream=b"abc")}), [2]) == "apply_failed"
    # Object khong doc lai duoc (o trong sau khi ghi)
    assert refusal_of(inc._verify_objects, FakeDoc({}, length=3), FakeDoc({2: mk(keys=k, stream=b"abc")}), [2]) == "apply_failed"
    # Object khong phai tu dien: so van ban
    assert refusal_of(inc._verify_objects, FakeDoc({2: mk(text="[ 1 ]", keys={})}),
                      FakeDoc({2: mk(text="[ 2 ]", keys={})}), [2]) == "apply_failed"
    # Ly do truyen vao duoc dung (lan kiem sau khi mo lai tu dia phai la verify_failed, khong phai apply_failed)
    assert refusal_of(inc._verify_objects, good, FakeDoc({2: mk(keys=k, stream=b"abX")}), [2], "verify_failed") == "verify_failed"


def test_every_listed_reason_is_actually_raised():
    """REASONS khong duoc chua ly do ma khong cho nao raise (slot_mismatch tung nhu vay sau khi duoc go)."""
    src = (ROOT / "src" / "pdf" / "incremental.py").read_text(encoding="utf-8")
    for reason in inc.REASONS:
        raised = len(re.findall(r'IncrementalRefused\(\s*"%s"' % re.escape(reason), src))
        assert raised >= 1, f"reason {reason!r} is listed but never raised"
    raised_all = set(re.findall(r'IncrementalRefused\(\s*"(\w+)"', src))
    assert raised_all <= set(inc.REASONS), f"raised but not listed: {raised_all - set(inc.REASONS)}"


# --------------------------------------------------------------------------- #
# tầng 2: file thật tự dựng
# --------------------------------------------------------------------------- #
def _base_pdf(path: Path, with_sig=False, objstms=False, encrypt=False):
    doc = fitz.open()
    for i in range(3):
        doc.new_page(width=300, height=300).insert_text((40, 80), f"page {i + 1} body", fontsize=14)
    if with_sig:
        x = doc.get_new_xref()
        doc.update_object(x, "<< /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <00112233> >>")
    kw = dict(garbage=0, use_objstms=1 if objstms else 0)
    if encrypt:
        kw.update(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o")
    doc.save(str(path), **kw)
    doc.close()


def _edit(src: Path, dst: Path, text="NEW TEXT", rotate=True, jpeg=None):
    """Bản 'đã sửa': như app làm — mở file gốc, sửa, lưu lại TOÀN BỘ."""
    doc = fitz.open(str(src))
    if rotate:
        doc[0].set_rotation(90)
    if text:
        doc[1].insert_text((40, 200), text, fontsize=12)
    if jpeg:
        doc[2].insert_image(fitz.Rect(40, 40, 140, 140), stream=jpeg)
    doc.save(str(dst), garbage=0, use_objstms=0)
    doc.close()


def _tmp():
    return tempfile.TemporaryDirectory(prefix="nabu-test-incr-")


def test_append_keeps_every_original_byte_and_applies_the_edit():
    """Cot loi: ket qua = file goc + mot revision. Chu moi phai doc duoc (bay so 1: stream mat /Filter)."""
    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        _base_pdf(o, with_sig=True)
        _edit(o, e)
        r = inc.append_revision(str(o), str(e), str(out))
        ob, rb = o.read_bytes(), out.read_bytes()
        assert rb[: len(ob)] == ob, "original bytes must be a byte-identical prefix"
        assert len(rb) > len(ob) and not r.unchanged_input and r.changed >= 1, r
        with fitz.open(str(out)) as res:  # `with`: Windows khoa file dang mo, TemporaryDirectory khong xoa duoc
            assert not res.is_repaired
            assert res.page_count == 3
            assert res[0].rotation == 90, "rotation edit lost"
            assert "NEW TEXT" in res[1].get_text(), "new text lost: a stream lost its /Filter (trap 1)"
            assert "page 2 body" in res[1].get_text(), "old text lost"
        # Object chu ky khong bi dong den NHUNG cung khong bi viet lai trong phan noi: dung mot lan.
        # (Khong so chuoi chinh xac: MuPDF ghi `/ByteRange[0 10 20 30]`, khong co dau cach.)
        assert ob.count(b"ByteRange") == 1 and rb.count(b"ByteRange") == 1, "signature object was rewritten"


def test_non_flate_filter_survives():
    """update_stream xoa /Filter. Voi Flate, hong la 'chu bien mat'; voi JPEG (DCTDecode), hong la anh thanh rac.
    Anh phai ra y het byte JPEG da chen."""
    px = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 40), False)
    px.clear_with(180)
    jpeg = px.tobytes("jpg")
    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        _base_pdf(o)
        _edit(o, e, text=None, rotate=False, jpeg=jpeg)
        inc.append_revision(str(o), str(e), str(out))
        with fitz.open(str(out)) as res:
            imgs = res[2].get_images(full=True)
            assert len(imgs) == 1, imgs
            info = res.extract_image(imgs[0][0])
            assert info["ext"] == "jpeg" and info["image"] == jpeg, "JPEG bytes changed or /Filter was lost"


def test_identical_input_makes_no_revision():
    with _tmp() as d:
        d = Path(d)
        o, out = d / "o.pdf", d / "out.pdf"
        _base_pdf(o)
        r = inc.append_revision(str(o), str(o), str(out))
        assert r.unchanged_input and (r.changed, r.added, r.reused) == (0, 0, 0), r
        assert out.read_bytes() == o.read_bytes(), "no-op must be a verbatim copy, not an empty revision"


def test_refusal_leaves_no_output_and_no_part_file():
    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        _base_pdf(o, encrypt=True)
        _base_pdf(e)
        assert refusal_of(inc.append_revision, str(o), str(e), str(out)) == "encrypted"
        assert refusal_of(inc.append_revision, str(e), str(o), str(out)) == "encrypted", "edited side too"
        assert not out.exists() and not Path(str(out) + ".part").exists(), sorted(p.name for p in d.iterdir())


def test_not_a_pdf_is_refused():
    with _tmp() as d:
        d = Path(d)
        junk, ok, out = d / "junk.pdf", d / "ok.pdf", d / "out.pdf"
        junk.write_bytes(b"this is not a pdf at all " * 20)
        _base_pdf(ok)
        assert refusal_of(inc.append_revision, str(junk), str(ok), str(out)) == "not_pdf"
        assert refusal_of(inc.append_revision, str(ok), str(junk), str(out)) == "not_pdf"
        assert not out.exists()


def test_changed_signature_object_aborts_the_whole_append():
    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        _base_pdf(o, with_sig=True)
        with fitz.open(str(o)) as doc:
            sig = next(x for x in range(1, doc.xref_length()) if doc.xref_get_key(x, "ByteRange")[0] != "null")
            doc.xref_set_key(sig, "Reason", "(tampered)")  # sua dung object chu ky
            doc[0].set_rotation(90)
            doc.save(str(e), garbage=0, use_objstms=0)
        assert refusal_of(inc.append_revision, str(o), str(e), str(out)) == "signature_object_changed"
        assert not out.exists()


def test_post_write_checks_can_refuse(monkeypatch=None):
    """Hai chot chan cuoi (tien to byte, mo lai ket qua) khong duoc la mã chet: ep chung that bai."""
    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        _base_pdf(o)
        _edit(o, e)
        real_prefix, real_verify = inc._prefix_equal, inc._verify_objects
        try:
            inc._prefix_equal = lambda *a, **k: False
            assert refusal_of(inc.append_revision, str(o), str(e), str(out)) == "prefix_changed"
            assert not out.exists() and not Path(str(out) + ".part").exists()
            inc._prefix_equal = real_prefix
            def bad_verify(work, edited, xrefs):
                raise inc.IncrementalRefused("apply_failed", "forced")
            inc._verify_objects = bad_verify
            assert refusal_of(inc.append_revision, str(o), str(e), str(out)) == "apply_failed"
            assert not out.exists()
        finally:
            inc._prefix_equal, inc._verify_objects = real_prefix, real_verify
        # va khi het ep thi lai chay duoc
        inc.append_revision(str(o), str(e), str(out))
        assert out.exists()


def test_empty_name_key_is_refused_not_silently_corrupted():
    """issue5896 (corpus pdf.js): mot tu dien font co khoa la TEN ROONG (`/ 15 0 R`). Trong bo nho no khop hoan toan
    voi ban da sua, nhung MuPDF ghi ra dia thanh `/15 0 R` — doc lai la ten "15" — va qpdf keu "expected dictionary
    key". Chi viec MO LAI ket qua va kiem tung object tu dia moi thay. File gia dung bang va byte (cung do dai,
    nen offset xref khong lech) vi `update_object` khong dung duoc ten rong tu van ban."""
    def make(path, extra):
        _base_pdf(path)
        with fitz.open(str(path)) as doc:
            y = doc.get_new_xref()
            doc.update_object(y, "<< /AA 1 0 R /Keep 7 " + extra + ">>")
            doc.save(str(path.with_suffix(".tmp")), garbage=0, use_objstms=0)
        raw = path.with_suffix(".tmp").read_bytes()
        assert raw.count(b"/AA 1") == 1
        path.write_bytes(raw.replace(b"/AA 1", b"/   1"))  # cung do dai ⇒ khoa TEN ROONG
        return y

    with _tmp() as d:
        d = Path(d)
        o, e, out = d / "o.pdf", d / "e.pdf", d / "out.pdf"
        y = make(o, "")
        make(e, "/Added 1 ")
        with fitz.open(str(o)) as chk:
            assert "" in chk.xref_get_keys(y), "fixture must really contain an empty-name key"
        assert refusal_of(inc.append_revision, str(o), str(e), str(out)) == "verify_failed"
        assert not out.exists() and not Path(str(out) + ".part").exists()


def test_prefix_equal_is_exact():
    with _tmp() as d:
        d = Path(d)
        a, b = d / "a", d / "b"
        data = bytes(range(256)) * 40000  # ~10 MB: vuot mot khuc 4 MiB
        a.write_bytes(data)
        b.write_bytes(data + b"tail")
        assert inc._prefix_equal(str(a), str(b), len(data))
        for pos in (0, len(data) - 1, 4 * 1024 * 1024 - 1, 4 * 1024 * 1024):  # dau, cuoi, hai ben ranh gioi khuc
            mutated = bytearray(data + b"tail")
            mutated[pos] ^= 1
            b.write_bytes(bytes(mutated))
            assert not inc._prefix_equal(str(a), str(b), len(data)), f"missed a flipped byte at {pos}"
        b.write_bytes(data[:-1])  # ngan hon
        assert not inc._prefix_equal(str(a), str(b), len(data))


def test_bytes_wrapper_round_trips():
    with _tmp() as d:
        d = Path(d)
        o, e = d / "o.pdf", d / "e.pdf"
        _base_pdf(o)
        _edit(o, e)
        out = inc.append_revision_bytes(o.read_bytes(), e.read_bytes())
        assert out.startswith(o.read_bytes())
        with fitz.open(stream=out, filetype="pdf") as r:
            assert r[0].rotation == 90


# --------------------------------------------------------------------------- #
# tầng 3: file ký thật từ corpus pdf.js, qua pdf-lib
# --------------------------------------------------------------------------- #
def _pdflib_rotate(src: Path, dst: Path) -> bool:
    node = shutil.which("node")
    if not node:
        return False
    r = subprocess.run([node, str(ROOT / "tools" / "pdflib_rotate.js"), str(src), str(dst)],
                       capture_output=True, text=True, timeout=90)
    return r.returncode == 0 and dst.exists()


def _qpdf_level(path: Path):
    if not Path(QPDF).is_file():
        return None
    rc = subprocess.run([QPDF, "--check", str(path)], capture_output=True, timeout=60).returncode
    return {0: 0, 3: 1}.get(rc, 2)


def test_real_signed_files_keep_every_signed_byte():
    """Bay file chu ky THAT trong corpus (7 file pdf-lib mo duoc): duong luu cu pha 7/7 (do), ghi noi giu 7/7."""
    names = ["160F-2019", "bug854315", "issue16553", "issue6127", "prefilled_f1040", "signed_verified",
             "xfa_filled_imm1344e"]
    if not CORPUS.is_dir():
        print("SKIP real-signed (no corpus at", CORPUS, ")")
        return
    with _tmp() as d:
        d = Path(d)
        done = 0
        for n in names:
            src, e, out = CORPUS / f"{n}.pdf", d / f"{n}.edited.pdf", d / f"{n}.out.pdf"
            if not src.exists():
                continue
            if not _pdflib_rotate(src, e):
                print("SKIP", n, "(node/pdf-lib unavailable)")
                continue
            inc.append_revision(str(src), str(e), str(out))
            ob, rb = src.read_bytes(), out.read_bytes()
            assert rb[: len(ob)] == ob, f"{n}: signed bytes changed"
            with fitz.open(str(src)) as before, fitz.open(str(out)) as res:
                assert not res.is_repaired and res[0].rotation == (before[0].rotation + 90) % 360, n
            lvl = _qpdf_level(out)
            assert lvl in (None, 0), f"{n}: qpdf level {lvl} on the appended file"
            done += 1
        assert done >= 1, "no real signed file could be exercised"


def test_rotating_one_page_appends_almost_nothing():
    """tracemonkey: xoay 1 trang. Coi object stream co /Length gian tiep la 'da doi' → +778 KB (348/350 object).
    Dung ra chi la /Rotate cua trang + ModDate/Producer: vai tram byte."""
    src = CORPUS / "tracemonkey.pdf"
    if not src.exists():
        print("SKIP tracemonkey (no corpus)")
        return
    with _tmp() as d:
        d = Path(d)
        e, out = d / "e.pdf", d / "out.pdf"
        if not _pdflib_rotate(src, e):
            print("SKIP tracemonkey (node/pdf-lib unavailable)")
            return
        r = inc.append_revision(str(src), str(e), str(out))
        grown = out.stat().st_size - src.stat().st_size
        assert r.changed <= 5, f"{r.changed} objects planned for a one-page rotation (Length-only rule broken?)"
        assert grown < 5000, f"appended {grown} bytes for a rotation (Length-only rule broken?)"
        assert _qpdf_level(out) in (None, 0)


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except AssertionError as e:
            failed += 1
            print("FAIL", name, "-", e)
        except Exception as e:  # noqa: BLE001 — a crash is a failure too, and must not hide the rest
            failed += 1
            print("CRASH", name, "-", type(e).__name__, str(e).encode("ascii", "replace").decode())
    print("All incremental tests passed." if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)
