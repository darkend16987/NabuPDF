"""Lõi lưu INCREMENTAL — nối một revision lên file gốc, giữ nguyên từng byte cũ (BI-128).

**Chỉ phụ thuộc PyMuPDF**, không FastAPI, không `api` — cùng lý do với `compress.py`:
chốt sau sẽ chạy nó trong một tiến trình con (segfault của một file méo không được
giết sidecar, BI-121).

BÀI TOÁN. Mọi đường lưu của app dựng lại TOÀN BỘ file (pdf-lib), nên một file đã ký số
mất chữ ký khi sửa rồi lưu (BI-127 chỉ mới *hỏi trước*). Chữ ký PDF là chữ ký trên các
byte nằm trong `/ByteRange`; nối thêm một revision vào CUỐI file không đụng tới chúng, nên
chữ ký còn nguyên. Hàm ở đây nhận: `original` (file như đang nằm trên đĩa) và `edited`
(file pdf-lib vừa dựng lại sau khi sửa), và tạo ra `original` + một revision chứa đúng những
object khác nhau.

NGUYÊN LÝ "SO RỒI NỐI" — vì sao khả thi: pdf-lib giữ nguyên SỐ HIỆU của mọi object đã có và
cấp số mới từ `max + 1`. Nên object số `x` ở hai file là cùng một vật; khác nhau ⇒ phải nối.
Đo 2026-11-22 trên 7 file ký thật của corpus pdf.js: giữ vùng ký 7/7 (đường cũ: 0/7), qpdf
mã 0 cả 7, chỉ thêm 0,8–17 KB. Spike: memory `incremental-save-spike`.

BA BẪY ĐÃ VẤP (mỗi cái có test ghim, xem `test_incremental.py`):
  1. `Document.update_stream` XOÁ `/Filter` và `/DecodeParms` khỏi từ điển ⇒ stream nén thành rác
     (chữ mới biến mất, MuPDF báo "syntax error in content stream"). Ta ghi stream rồi đặt lại
     NGUYÊN VĂN từ điển bằng `update_object`, và sau đó TỰ KIỂM từng object (`_verify_objects`).
     KHÔNG đặt lại từng khoá bằng `xref_set_key` — bản đầu làm vậy và vỡ ngay ở `tracemonkey.pdf`
     (khoá kiểu `string` mất dấu ngoặc khi đi qua `xref_get_key`); xem `_apply`.
  2. pdf-lib cấp kho object stream MỚI ở các số TRÙNG số kho đang chứa object sống của file
     gốc (160F-2019: 543–546). Chép kho = qpdf báo "supposed object stream … is not a stream".
     Luật: bỏ qua mọi `/ObjStm` và `/XRef` của phía `edited` (object con vẫn lấy riêng nhờ
     `xref_object(x, compressed=False)`); nếu `edited` đặt object THƯỜNG lên số đang là kho
     của `original` ⇒ TỪ CHỐI, không đoán.
  3. Một chữ ký bị ghi đè lặng lẽ còn tệ hơn không có chữ ký ⇒ object chữ ký (`/ByteRange`,
     `/Type /Sig`, `/FT /Sig`) mà khác đi ⇒ TỪ CHỐI.

FAIL-CLOSED. Khác hẳn cổng ở `desktop/src/signed-scan.js` (fail-OPEN: nó chỉ là lời nhắc),
ở đây mọi điều không chắc chắn đều dẫn tới `IncrementalRefused` với một LÝ DO CÓ TÊN. Người gọi
(chốt sau) lùi về đường cũ + cảnh báo. Một file nối sai mà trông như thành công — trên đúng
loại file người ta ký để chứng minh nó không bị sửa — là thứ không được phép xảy ra. Vì vậy
sau khi nối ta còn: (a) kiểm TỪNG object đã ghi giống hệt phía `edited`, (b) kiểm tiền tố
byte y hệt gốc, (c) mở lại kết quả và kiểm nó không phải "sửa chữa" (`is_repaired`), số trang
và hướng từng trang khớp `edited`.

KHÔNG làm: không giải mã (file mã hoá ⇒ từ chối), không nối lên file đã bị MuPDF "sửa chữa"
(xref của nó không đáng tin), không dọn object mồ côi (nối giữ MÃI byte cũ — nên ẩn trang /
redaction, vốn phải xoá thật theo BI-74/BI-91, KHÔNG được đi đường này; chính sách đó là việc
của người gọi, không phải của lõi).
"""

from __future__ import annotations

import collections
import logging
import os
import shutil
import tempfile

logger = logging.getLogger(__name__)

# Lý do từ chối — ổn định, để lớp trên dịch ra câu cho người dùng và để test ghim từng cái.
REASONS = (
    "not_pdf",            # một trong hai file không phải PDF / không mở được
    "encrypted",          # file mã hoá: ta không giải mã ở đây
    "repaired",           # MuPDF phải dựng lại xref của file gốc ⇒ không đáng tin để nối
    "root_changed",       # /Root của hai bên khác số hiệu: không phải cùng một tài liệu
    "container_collision",  # `edited` đặt object thường lên số đang là kho (ObjStm/XRef) của `original`
    "signature_object_changed",  # object chữ ký bị đổi — không bao giờ ghi đè chữ ký
    "unreadable_object",  # một object lỗi theo cách KHÔNG phải "ô trống" — không đoán nó là gì
    "apply_failed",       # một object ghi xong không giống hệt phía `edited`
    "prefix_changed",     # kết quả không bắt đầu bằng đúng byte của file gốc
    "verify_failed",      # mở lại kết quả thì thấy sai (phải sửa chữa, lệch trang/hướng trang)
)

# Kho chứa: bỏ qua phía `edited`, và là nguồn của bẫy số 2.
_CONTAINERS = ("/ObjStm", "/XRef")

# Kết quả: `changed` = object đã có mà đổi, `added` = object mới (kể cả `reused`), `reused` = bao
# nhiêu trong số `added` nằm ở một số mà file gốc có mà TRỐNG (xem `plan_changes`), `unchanged_input`
# = hai file giống hệt nhau nên KHÔNG tạo revision nào (kết quả là bản sao nguyên văn của file gốc).
IncrementalResult = collections.namedtuple("IncrementalResult", "path changed added reused unchanged_input")

# Kế hoạch nối: ba danh sách số hiệu object. `added` đã gồm `reused`.
Plan = collections.namedtuple("Plan", "changed added reused")


class IncrementalRefused(Exception):
    """Không nối được một cách an toàn. `reason` thuộc `REASONS`; `detail` là câu cho người sửa lỗi.

    Lớp riêng, KHÔNG phải `ValueError`/`RuntimeError` trần: người gọi phải phân biệt được "từ chối
    có chủ đích — lùi về đường cũ" với "lỗi thật" (đĩa đầy, hết RAM), và hai thứ đó không được
    chung một `except`.
    """

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


# --------------------------------------------------------------------------- #
# đọc cấu trúc
# --------------------------------------------------------------------------- #
# PyMuPDF báo một ô xref TRỐNG bằng hai thông điệp (đo 2026-11-22): "bad xref" cho số ngoài phạm vi
# (ValueError ở `xref_get_*`, RuntimeError ở `xref_object`) và "cannot find object in xref (N 0 R)"
# cho ô đã giải phóng. Chỉ hai thông điệp đó là "vắng mặt". MỌI lỗi khác là một object hỏng thật —
# nuốt nó thành "vắng mặt" sẽ lặng lẽ bỏ rơi một object đang được tham chiếu, nên ta từ chối.
_ABSENT_MESSAGES = ("bad xref", "cannot find object in xref")


def _read(fn, x: int, default):
    """Gọi `fn(x)`; ô trống ⇒ `default`; lỗi khác ⇒ `IncrementalRefused("unreadable_object")`."""
    try:
        return fn(x)
    except (ValueError, RuntimeError) as e:
        if isinstance(e, ValueError) or any(m in str(e) for m in _ABSENT_MESSAGES):
            return default
        raise IncrementalRefused("unreadable_object", f"object {x}: {e}") from e


def _type_of(doc, x: int) -> str:
    kind, val = _read(lambda i: doc.xref_get_key(i, "Type"), x, ("null", "null"))
    return val if kind == "name" else ""


def _is_signature(doc, x: int) -> bool:
    """Object `x` là một đối tượng chữ ký: có `/ByteRange`, hoặc `/Type /Sig`, hoặc `/FT /Sig`."""
    if _read(lambda i: doc.xref_get_key(i, "ByteRange"), x, ("null", "null"))[0] != "null":
        return True
    if _read(lambda i: doc.xref_get_key(i, "Type"), x, ("null", "null"))[1] == "/Sig":
        return True
    return _read(lambda i: doc.xref_get_key(i, "FT"), x, ("null", "null"))[1] == "/Sig"


def _live_object(doc, x: int):
    """Văn bản object `x`, hoặc None nếu ô đó trống / là `null` (đã giải phóng)."""
    text = _read(lambda i: doc.xref_object(i, compressed=False), x, None)
    return None if text is None or text.strip() == "null" else text


def _stream_raw(doc, x: int):
    return doc.xref_stream_raw(x) if doc.xref_is_stream(x) else None


def _keywise(doc, x: int):
    """Từ điển của object `x` dưới dạng {khoá: giá trị-PyMuPDF-in-ra}, hoặc None nếu ô trống. So theo
    KHOÁ chứ không theo văn bản: hai cách viết khoảng trắng khác nhau của cùng một từ điển vẫn là một
    object — quan trọng với object chữ ký, nơi một cách viết khác không được biến thành "chữ ký bị đổi"."""
    keys = _read(doc.xref_get_keys, x, None)
    if keys is None:
        return None
    # Giữ CẢ KIỂU (`int`, `string`, `name`, `xref`…), không chỉ giá trị: nếu chỉ so giá trị thì số 5 và chuỗi (5)
    # là một, và một khoá đổi kiểu sẽ bị bỏ sót.
    return {k: doc.xref_get_key(x, k) for k in keys}


def _same_object(a_doc, b_doc, x: int) -> bool:
    """Object `x` ở hai tài liệu có là một không? Từ điển + (nếu có) dữ liệu stream thô.

    STREAM: bỏ qua `/Length`. Đo trên `tracemonkey.pdf`: xoay một trang làm lõi coi **348/350** object là
    "đã đổi" — tất cả đều là stream có dữ liệu thô y hệt, chỉ khác ở chỗ gốc ghi `/Length 674 0 R` (gián
    tiếp) còn pdf-lib ghi `/Length 1013` (số thẳng). Nối cả 348 object đó là +778 KB cho một lần xoay trang,
    tức là mất đúng lợi ích của việc ghi nối. Cùng dữ liệu thô + cùng mọi khoá khác thì `/Length` chỉ là cách
    viết; giữ nguyên object cũ (và object độ dài của nó) là đúng. Dữ liệu thô khác ⇒ luôn là đã đổi."""
    if _stream_raw(a_doc, x) != _stream_raw(b_doc, x):
        return False
    return _same_content(a_doc, b_doc, x, ignore=("Length",) if a_doc.xref_is_stream(x) else ())


def _same_content(a_doc, b_doc, x: int, ignore=()) -> bool:
    """Từ điển của object `x` có cùng khoá và cùng (kiểu, giá trị) ở hai tài liệu không?

    THỨ TỰ KHOÁ KHÔNG CÓ NGHĨA trong PDF, và văn bản thì có thứ tự: MuPDF ghi `/Type /Page` lên ĐẦU từ điển
    còn pdf-lib để nó ở cuối. So văn bản làm 5/7 file ký thật bị từ chối oan ở phép kiểm sau-khi-ghi, và làm
    object giống hệt bị nối thừa ở bước lập kế hoạch. Nên so theo khoá.

    Nhưng so theo khoá cũng có điểm yếu riêng: với giá trị LỒNG (từ điển con) `xref_get_key` giữ nguyên cách viết
    gốc của file, nên hai file khác định dạng là "khác" (đo: `160F-2019` từ 2 lên 5 object đổi). Hai cách so
    sai theo hai hướng KHÔNG liên quan nhau, và cả hai chỉ khẳng định "bằng" khi thật sự giống — nên bằng nhau nếu
    MỘT trong hai nói bằng nhau. Không thể bằng nhầm; chỉ có thể nối thừa, và nối thừa là vô hại.

    Object KHÔNG phải từ điển (mảng, số, chuỗi…): `xref_get_keys` trả rỗng — so theo khoá sẽ luôn "bằng nhau" và
    bỏ lọt mọi khác biệt. Với chúng, và chỉ chúng, so văn bản."""
    ka, kb = _keywise(a_doc, x), _keywise(b_doc, x)
    if ka is None or kb is None:
        return False
    if not ka and not kb:
        return _live_object(a_doc, x) == _live_object(b_doc, x)
    if not ignore and _live_object(a_doc, x) == _live_object(b_doc, x):
        return True  # y hệt từng chữ (cách so này miễn nhiễm với khác biệt định dạng lồng nhau)
    for k in ignore:
        ka.pop(k, None)
        kb.pop(k, None)
    return ka == kb  # cùng khoá, cùng (kiểu, giá trị) (cách so này miễn nhiễm với thứ tự khoá)


def _same_signature_object(a_doc, b_doc, x: int) -> bool:
    """Như `_same_object` nhưng KHÔNG bỏ qua `/Length` nào — một object chữ ký phải y hệt."""
    return _stream_raw(a_doc, x) == _stream_raw(b_doc, x) and _same_content(a_doc, b_doc, x)


# --------------------------------------------------------------------------- #
# lập kế hoạch
# --------------------------------------------------------------------------- #
def plan_changes(original, edited):
    """So hai tài liệu đã mở. Trả `Plan(changed, added, reused)` — số hiệu object cần nối.

    Ném `IncrementalRefused` khi gặp bất kỳ điều gì không chắc chắn. Thuần đọc: không sửa gì.

    TÁI DÙNG Ô TRỐNG ĐƯỢC PHÉP (`reused`). pdf-lib cấp số mới ngay trong phạm vi bảng xref của file gốc
    ở những ô gốc để trống, và bản đầu của hàm này TỪ CHỐI ca đó (`slot_mismatch`) — nó chặn nhầm file ký
    thật `prefilled_f1040` (1/7). Đo thay vì đoán: dựng tay file có ô được LIỆT KÊ là trống với gen=1 (kiểu
    Acrobat để lại sau khi xoá object), bản đã sửa tái dùng số đó ⇒ PyMuPDF ghi object mới với gen 0,
    tham chiếu `3 0 R` vẫn tới được, qpdf mã 0. Nên ta cho qua và chỉ ĐẾM, để lưới quét theo dõi.
    Phép tự kiểm sau khi ghi (`_verify_objects`, mở lại kết quả) vẫn là chốt chặn nếu một ca lạ nào đó sai.
    """
    if original.pdf_catalog() != edited.pdf_catalog():
        raise IncrementalRefused(
            "root_changed", f"/Root {original.pdf_catalog()} (gốc) ≠ {edited.pdf_catalog()} (đã sửa)"
        )

    n_orig, n_edit = original.xref_length(), edited.xref_length()
    changed, added, reused = [], [], []
    for x in range(1, n_edit):
        edited_text = _live_object(edited, x)
        if edited_text is None:
            continue  # ô trống phía đã sửa (kể cả object cũ bị bỏ): để mồ côi, không xoá
        if _type_of(edited, x) in _CONTAINERS:
            continue  # bẫy số 2: kho của pdf-lib — object con được lấy riêng

        if x >= n_orig:
            added.append(x)
            continue

        # x < n_orig: cùng một vật ở hai file.
        if _type_of(original, x) in _CONTAINERS:
            raise IncrementalRefused(
                "container_collision", f"object {x} là kho {_type_of(original, x)} ở file gốc nhưng là object thường ở bản đã sửa"
            )
        if _live_object(original, x) is None:
            added.append(x)  # ô trống ở gốc, sống ở bản đã sửa: object mới ở một số cũ
            reused.append(x)
            continue
        if _is_signature(original, x):
            if not _same_signature_object(original, edited, x):
                raise IncrementalRefused("signature_object_changed", f"object {x} (chữ ký) khác giữa gốc và bản đã sửa")
            continue
        if not _same_object(original, edited, x):
            changed.append(x)
    return Plan(changed, added, reused)


# --------------------------------------------------------------------------- #
# ghi
# --------------------------------------------------------------------------- #
def _apply(work, edited, xrefs) -> None:
    """Chép object `xrefs` từ `edited` vào `work` (bản sao của file gốc, mở để sửa)."""
    for x in xrefs:
        while work.xref_length() <= x:
            work.get_new_xref()  # nới bảng xref tới đúng số hiệu x
        text = edited.xref_object(x, compressed=False)
        work.update_object(x, text)
        if edited.xref_is_stream(x):
            # Bẫy số 1: update_stream XOÁ /Filter và /DecodeParms khỏi từ điển (mupdf coi dữ liệu ta đưa là
            # CHƯA nén). Ghi stream rồi đặt lại NGUYÊN VĂN từ điển bằng update_object — đã đo: giữ nguyên
            # stream, trả lại đúng từ điển (tracemonkey: 348 stream, 0 lệch).
            # ĐỪNG đặt lại từng khoá bằng xref_set_key: với khoá kiểu `string`, xref_get_key trả nội dung
            # KHÔNG có dấu ngoặc (`./states.pdf`) nên đặt ngược lại hoặc ném "invalid key in dict"
            # (tracemonkey, PTEX.FileName) hoặc — tệ hơn — ghi sai lặng lẽ khi chuỗi có ký tự đặc biệt.
            work.update_stream(x, edited.xref_stream_raw(x), new=0, compress=0)
            work.update_object(x, text)


def _verify_objects(work, edited, xrefs, reason: str = "apply_failed") -> None:
    """Mỗi object vừa ghi phải TƯƠNG ĐƯƠNG với phía `edited`: cùng khoá, cùng (kiểu, giá trị) — gồm cả `/Length`,
    `/Filter`, `/DecodeParms` — và cùng dữ liệu stream thô. "Tương đương" chứ không "giống từng chữ": xem
    `_same_content` (thứ tự khoá). Nếu PyMuPDF đổi ý ở phiên bản sau, đây là chỗ nó lộ ra — thành một lần TỪ
    CHỐI có tên, không phải một file nối sai mà trông như thành công.

    Gọi HAI lần: sau `_apply` (đọc từ bộ nhớ, reason `apply_failed`) và sau khi MỞ LẠI file kết quả (đọc từ đĩa,
    reason `verify_failed`). Lần sau mới là lần quan trọng — xem chú thích ở `append_revision`."""
    for x in xrefs:
        if _keywise(work, x) is None:
            raise IncrementalRefused(reason, f"object {x} không đọc lại được sau khi ghi")
        if not _same_content(work, edited, x):
            a, b = _keywise(work, x) or {}, _keywise(edited, x) or {}
            diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
            raise IncrementalRefused(reason, f"object {x}: từ điển lệch (khoá {diff or 'không phải từ điển'})")
        if _stream_raw(work, x) != _stream_raw(edited, x):
            raise IncrementalRefused(reason, f"object {x}: dữ liệu stream lệch")


def _prefix_equal(path_a: str, path_b: str, n: int) -> bool:
    """`n` byte đầu của hai file có y hệt không? So theo khúc, không nạp cả file."""
    chunk = 4 * 1024 * 1024
    with open(path_a, "rb") as fa, open(path_b, "rb") as fb:
        done = 0
        while done < n:
            want = min(chunk, n - done)
            a, b = fa.read(want), fb.read(want)
            if a != b or len(a) != want:
                return False
            done += want
    return True


def _open(fitz, path: str, what: str):
    try:
        doc = fitz.open(path, filetype="pdf")
    except Exception as e:  # noqa: BLE001 — PyMuPDF ném đủ loại; ta chỉ cần biết "không mở được"
        raise IncrementalRefused("not_pdf", f"{what}: {e}") from e
    if not doc.is_pdf:
        doc.close()
        raise IncrementalRefused("not_pdf", f"{what} không phải PDF")
    if doc.needs_pass or doc.is_encrypted:
        doc.close()
        raise IncrementalRefused("encrypted", f"{what} được mã hoá")
    return doc


def append_revision(original_path: str, edited_path: str, out_path: str) -> IncrementalResult:
    """Tạo `out_path` = nội dung `original_path` + một revision chứa những object `edited_path` đã đổi.

    Ghi qua file `.part` rồi `os.replace`: `out_path` hoặc là kết quả ĐÃ kiểm xong, hoặc không tồn tại
    (không bao giờ là một file nối dở). Ném `IncrementalRefused` — xem module docstring.
    """
    import fitz  # PyMuPDF — lazy, cùng kiểu các module lá khác (xem compress.py)

    part = out_path + ".part"
    original = edited = work = result = None
    try:
        original = _open(fitz, original_path, "file gốc")
        edited = _open(fitz, edited_path, "bản đã sửa")
        if original.is_repaired:
            raise IncrementalRefused("repaired", "MuPDF phải dựng lại xref của file gốc")

        plan = plan_changes(original, edited)
        todo = plan.changed + plan.added

        if not todo:
            # Hai file giống hệt: KHÔNG tạo revision rỗng (PyMuPDF còn từ chối nối khi không có gì đổi).
            shutil.copyfile(original_path, part)
            os.replace(part, out_path)
            return IncrementalResult(out_path, 0, 0, 0, True)

        shutil.copyfile(original_path, part)
        work = fitz.open(part, filetype="pdf")
        _apply(work, edited, todo)
        _verify_objects(work, edited, todo)
        try:
            work.saveIncr()
        except Exception as e:  # noqa: BLE001
            raise IncrementalRefused("apply_failed", f"saveIncr: {e}") from e
        work.close()
        work = None

        # (b) tiền tố byte y hệt gốc — chính điều làm chữ ký còn nguyên.
        if not _prefix_equal(original_path, part, os.path.getsize(original_path)):
            raise IncrementalRefused("prefix_changed", "kết quả không bắt đầu bằng đúng byte của file gốc")

        # (c) mở lại kết quả như một người đọc xa lạ sẽ làm.
        result = _open(fitz, part, "kết quả")
        if result.is_repaired:
            raise IncrementalRefused("verify_failed", "kết quả phải được MuPDF sửa chữa khi mở lại")
        if result.page_count != edited.page_count:
            raise IncrementalRefused("verify_failed", f"số trang {result.page_count} ≠ {edited.page_count}")
        for i in range(result.page_count):
            if result[i].rotation != edited[i].rotation:
                raise IncrementalRefused("verify_failed", f"trang {i + 1}: hướng {result[i].rotation} ≠ {edited[i].rotation}")
        # Kiểm TỪNG object đã ghi, đọc lại TỪ ĐĨA. Phép kiểm `_verify_objects(work, …)` ở trên chỉ thấy bộ nhớ,
        # mà lỗi có thể nằm ở bước SERIALIZE: một từ điển font có khoá là TÊN RỖNG (`/ 15 0 R`, issue5896 của
        # corpus pdf.js) khớp hoàn toàn trong bộ nhớ nhưng MuPDF ghi ra đĩa thành `/15 0 R` — đọc lại là
        # tên "15" — và qpdf kêu "expected dictionary key". Chỉ có đọc lại từ đĩa mới thấy.
        _verify_objects(result, edited, todo, "verify_failed")
        result.close()
        result = None

        os.replace(part, out_path)
        return IncrementalResult(out_path, len(plan.changed), len(plan.added), len(plan.reused), False)
    finally:
        for d in (result, work, edited, original):
            if d is not None:
                try:
                    d.close()
                except Exception:  # noqa: BLE001
                    pass
        if os.path.exists(part):  # thất bại / từ chối: không để lại file dở
            try:
                os.remove(part)
            except OSError:
                logger.warning("không xoá được %s", part)


def append_revision_bytes(original: bytes, edited: bytes) -> bytes:
    """Tiện ích cho test và file nhỏ: như `append_revision` nhưng nhận/trả bytes (đi qua thư mục tạm,
    vì `saveIncr` của PyMuPDF chỉ ghi được lên một FILE)."""
    with tempfile.TemporaryDirectory(prefix="nabu-incr-") as d:
        o, e, out = (os.path.join(d, n) for n in ("o.pdf", "e.pdf", "out.pdf"))
        with open(o, "wb") as f:
            f.write(original)
        with open(e, "wb") as f:
            f.write(edited)
        append_revision(o, e, out)
        with open(out, "rb") as f:
            return f.read()
