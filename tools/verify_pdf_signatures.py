"""Trọng tài MẬT MÃ ĐỘC LẬP cho chữ ký số PDF (BI-131, chốt 5 của "đừng phá chữ ký").

Không dùng bất kỳ mã nào của app: chỉ đọc `/ByteRange` + `/Contents` rồi nhờ **OpenSSL** (`openssl cms -verify`)
kiểm hai điều mà một trình đọc PDF nào cũng kiểm đầu tiên:
  (1) băm của đúng các byte trong ByteRange khớp với `messageDigest` ký trong PKCS#7;
  (2) chữ ký RSA/ECDSA trên các thuộc tính đã ký là đúng với chứng thư đính kèm.
`-noverify` BỎ QUA việc dựng chuỗi tin cậy tới một CA gốc (chứng thư thử nghiệm tự ký sẽ không bao giờ qua), nên kết quả
"hợp lệ" ở đây nghĩa là "tài liệu CHƯA bị sửa trong các byte được ký và chữ ký toán học đúng" — KHÔNG nghĩa là chứng thư đáng tin.
Nó cũng KHÔNG xét phần nối sau vùng ký (DocMDP / khoá trường / "đã sửa sau khi ký" của Acrobat) — cái đó vẫn phải mở bằng Acrobat/Foxit.

Dùng:  python tools/verify_pdf_signatures.py file.pdf [file2.pdf ...]
Thoát 0 nếu MỌI chữ ký tìm được đều hợp lệ (và có ít nhất một), 1 nếu có chữ ký hỏng, 2 nếu không có chữ ký nào.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

BR = re.compile(rb"/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]")


def _der_cut(b: bytes) -> bytes:
    """Cắt đúng một cấu trúc DER ở đầu `b` (bỏ phần đệm 00 của ô /Contents)."""
    if len(b) < 2 or b[0] != 0x30:
        return b
    n = b[1]
    if n < 0x80:
        return b[: 2 + n]
    k = n & 0x7F
    ln = int.from_bytes(b[2 : 2 + k], "big")
    return b[: 2 + k + ln]


def signatures(data: bytes):
    """Danh sách (br, der) cho mọi /ByteRange hợp lệ trong file; br = (a, l1, c, l2)."""
    out = []
    for m in BR.finditer(data):
        a, l1, c, l2 = (int(x) for x in m.groups())
        if a != 0 or c + l2 > len(data) or l1 > c:
            continue
        gap = data[l1:c]
        hexs = re.sub(rb"[<>\s]", b"", gap)
        if not hexs or not re.fullmatch(rb"[0-9A-Fa-f]+", hexs) or len(hexs) % 2:
            continue
        der = bytes.fromhex(hexs.decode("ascii"))
        if not der.strip(b"\x00"):
            continue  # ô giữ chỗ chưa ký
        out.append(((a, l1, c, l2), _der_cut(der)))
    return out


def verify_file(path: str, openssl: str = "openssl"):
    """Trả về list dict: {byte_range, ok, detail}. [] nếu không có chữ ký nào."""
    data = open(path, "rb").read()
    res = []
    tmp = tempfile.mkdtemp(prefix="nabu-sig-")
    try:
        for i, (br, der) in enumerate(signatures(data)):
            a, l1, c, l2 = br
            content = data[a : a + l1] + data[c : c + l2]
            sp, cp = os.path.join(tmp, f"s{i}.der"), os.path.join(tmp, f"c{i}.bin")
            open(sp, "wb").write(der)
            open(cp, "wb").write(content)
            r = subprocess.run(
                [openssl, "cms", "-verify", "-inform", "DER", "-in", sp, "-content", cp, "-binary", "-noverify", "-out", os.devnull],
                capture_output=True,
                text=True,
            )
            err = (r.stderr or "").strip().splitlines()
            res.append({"byte_range": br, "ok": r.returncode == 0, "detail": "" if r.returncode == 0 else (err[-1] if err else f"openssl exit {r.returncode}")})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return res


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    openssl = shutil.which("openssl") or "openssl"
    worst = 2
    for p in argv:
        r = verify_file(p, openssl)
        if not r:
            print(f"{os.path.basename(p)}: KHONG co chu ky nao")
            continue
        for s in r:
            print(f"{os.path.basename(p)}: {s['byte_range']} {'HOP LE' if s['ok'] else 'HONG'} {s['detail']}")
        worst = 0 if worst == 2 and all(s["ok"] for s in r) else (1 if any(not s["ok"] for s in r) else worst)
        if any(not s["ok"] for s in r):
            worst = 1
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
