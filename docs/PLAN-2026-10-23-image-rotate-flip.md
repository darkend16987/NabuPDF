# Xoay / lật ảnh chèn — nghiên cứu + kế hoạch (2026-10-23)

> Trạng thái (2026-10-24): **ĐÃ LÀM xong bước 0–7** (chưa phát hành, chưa push). Kết quả + luật + số đo: `docs/REGRESSION-GUARD.md` **BI-116**.
> Ba câu hỏi ở §6 đã chốt: núm chuột + menu chuột phải (**không** ô nhập góc) · xoay tự do, Shift = 15° · nhiều ảnh ⇒ mỗi ảnh quanh tâm riêng.
> Khác với kế hoạch gốc: (a) ảnh **không** vào `KINDS` của `test:rotate` (KINDS đọc toán tử path, ảnh chỉ phát `Do`) — thay bằng mục **5b**;
> (b) gọi `annot-geom` qua `window.AnnotGeom`, không tên trần mới (BI-14); (c) lớp phủ `.annot-layer` cho núm tràn ra ngoài tờ khi có núm (`:has`).
> Phần dưới là bản kế hoạch ban đầu, giữ nguyên để truy vết. Mọi dòng "đã đọc" dưới đây là đọc trực tiếp trong phiên đó (HEAD `8592907`, v0.2.79).

## 1. Kết luận: ảnh chèn CHƯA xoay / lật được

Đã grep `flip` trong `desktop/renderer` (trừ vendor): không có tính năng lật nào (các khớp chỉ là chữ "flip" trong comment / đảo chiều mũi tên).
Annot `kind: "image"` chỉ có `x, y, w, h, dataUrl, fmt` (+ `sigId`, `_managed`, `_foreign`):

| Chỗ | File | Ghi nhận |
|---|---|---|
| tạo | `editor.js` `placeImage` (~3299) | object `{id,kind,x,y,w,h,dataUrl,fmt[,sigId]}` |
| vẽ overlay | `editor.js` `renderAnnot` (~1390) | `<img>` 100%×100% trong `.an`; có 4 grip resize (`RESIZABLE_KINDS`) |
| lưu thành annot sửa-lại-được | `editor-bake.js` `addManagedAnnot` nhánh image (~539) | `/Stamp`, AP = Form `BBox [0 0 w h]`, nội dung `q w 0 0 h 0 0 cm /NabuImg Do Q`, `/Matrix` chỉ khi trang xoay (BI-59) |
| lưu phẳng (trang `/Rotate` lẻ, bake che) | `editor-bake.js` `drawOneAnnot` (~1362) | `page.drawImage(... rotate: pageRotate(page))` |
| mã hoá | `managed-codec.js` `serializeManaged` (~582) | `{k:"image",x,y,w,h,fmt}` — **danh sách trường cố định** |
| đọc lại | `editor-bake.js` `deserializeManaged` (~447) | tương ứng |
| áp nhiều trang | `editor.js` `applyImgPages` (~3479) | **sao chép từng trường bằng tay** (x,y,w,h,dataUrl,fmt) ⇒ trường mới sẽ rơi mất nếu không thêm |
| menu chuột phải khi chỉnh sửa | `editor.js` (~4097) | Sao chép / Dán / Chữ ký / Thứ tự chồng / Xoá |

**Cái đã có và dùng làm khuôn:** *hộp chữ* đã xoay được (`a.rot`, độ **ngược chiều kim đồng hồ**, `normRot`/`rotatedBox` ở `annot-text.js`; ô "Xoay" + nút "+90°" `#ed-textrot`; BI-110 chốt tâm xoay; bake xoay trong raster). Hộp chữ xoay thì **tắt grip resize** (`isFixedTextBox … !rot`). Ảnh không có gì tương tự. Không có tay nắm xoay bằng chuột cho vật thể nào.

## 2. Luật không được phá (đã đọc)

- **BI-59**: ảnh không xoay/không lật + trang 0° ⇒ **byte y hệt** bản trước (không ghi `/Matrix`, không thêm trường). ⇒ mọi thứ mới chỉ xuất hiện khi `rot≠0` hoặc `flip`.
- **BI-45/65/66**: bù xoay trang là việc của primitive; thêm primitive vẽ mới ⇒ thêm kind vào `KINDS` của `test:rotate`.
- **BI-40**: màn hình và PDF đã lưu phải **một bộ số học**, hai đích. Lệch = đúng trên màn hình, sai trong file.
- **BI-3**: mọi sửa đổi model đi qua `pushEdUndo()` (undo của editor; coalesce được bằng key như `"trot:"+id`).
- **BI-9/10/14**: nút mới có chữ động ⇒ `SKIP_IDS` i18n; không khai trùng tên toàn cục; thứ tự `<script>` (`test:scope`).
- **BI-41**: thanh sửa không còn chỗ rộng ⇒ lệnh phụ đặt ở menu chuột phải (như Thứ tự chồng).
- **BI-30/26**: menu chuột phải editor dùng `stopImmediatePropagation`; mục mới vào menu thì không thêm nút có id ⇒ không dính cổng bản quyền hàm.
- Sidecar không liên quan (thuần renderer) ⇒ không cần build lại sidecar.

## 3. Thiết kế đề xuất

**Mô hình:** thêm vào annot image `rot` (độ ngược chiều KĐH, chuẩn hoá `normRot`, mặc định 0), `flipH`, `flipV` (boolean). **Vắng = 0/false** (không ghi khóa khi mặc định) ⇒ JSON/PDF cũ y hệt.
`x,y,w,h` **giữ nghĩa là hộp chưa xoay** (giống hộp chữ, tránh phình mỗi lần xoay). Tâm xoay = tâm hộp `(x+w/2, y+h/2)` — ảnh không có `pad` như chữ nên không có bài toán BI-110.
Thứ tự: **lật trong khung ảnh trước, rồi xoay quanh tâm** (như PowerPoint).

**Overlay:** `rotate(-rot deg)` đặt lên phần tử `.an` (grip + viền chọn xoay theo ảnh); `scale(±1,±1)` đặt **chỉ lên `<img>`** (nếu lật cả `.an` thì grip đảo chỗ). Chọn/kéo vẫn nhờ DOM hit-test.

**Bake (không rasterise lại, không đổi byte ảnh gốc — ảnh vẫn nằm nguyên trong `/NabuSrc`):**
- *Managed AP:* khi `rot||flip`: `BBox = [0 0 bw bh]` với `(bw,bh)=rotatedBox(w,h,rot)`, nội dung `q <ma trận T·R·S·scale(w,h)> cm /NabuImg Do Q`, `/Rect = apRectFor(angle, bw, bh, …)` neo ở góc dưới-trái **hộp bao đã xoay**. Khác ⇒ nhánh cũ nguyên văn.
- *Phẳng:* cùng một hàm thuần sinh ma trận, ghi bằng `pushOperators(concatTransformationMatrix…, drawObject)` (pdf-lib `drawImage` không lật được); nhân thêm `R(pageAngle)` (BI-45 loại 2).
- Một hàm thuần duy nhất `imageMatrix(a, …)` dùng cho cả hai đường ⇒ test được trong node, không cần canvas.

**Mã hoá:** `serializeManaged`/`deserializeManaged` thêm `rot, flipH, flipV` **chỉ khi khác mặc định**. Mở file mới bằng bản cũ: AP vẫn vẽ đúng, nhưng sửa lại + lưu sẽ mất xoay (chấp nhận được, ghi chú).

**Hình học:** `annotBounds` của image trả hộp bao đã xoay (cho `fitShift`/union khi dán, đặt chữ ký). **Resize khi đang xoay:** hàm thuần mới `resizeRotated(dir, orig, dx, dy, ratio, min, rot)` trong `annot-geom.js` (quay `dx,dy` về khung cục bộ, góc đối diện đứng yên **trong không gian trang**, tính lại tâm) — có test thuần như `resizeRect`.

**Tương tác:**
1. **Tay nắm xoay bằng chuột:** vòng tròn nhỏ trên cuống phía trên-giữa ảnh (nằm trong khung xoay nên xoay theo). Kéo ⇒ góc = `atan2` từ tâm tới con trỏ; **Shift = bước 15°**; undo đẩy lười ở lần di chuyển thật đầu tiên (như move/resize); `Esc` huỷ về góc cũ (`cancelDrag`).
2. **Menu chuột phải** (chỉ khi chọn ảnh): *Xoay trái 90°*, *Xoay phải 90°*, *Lật ngang*, *Lật dọc*, *Đặt lại xoay/lật* (xám khi không đổi gì, như Thứ tự chồng).
3. (tuỳ chọn, §6-Q1) ô số "Xoay ảnh" trên thanh sửa.

**Ngoài phạm vi v1 (ghi để khỏi hiểu nhầm):** ảnh nằm sẵn trong nội dung trang của PDF gốc (không phải annot do Nabu chèn) không phải vật thể ⇒ không xoay được; stamp của phần mềm khác (`_foreign`) tạm khoá menu xoay vì `planForeign` so sánh dạng serialize.

## 4. Các bước (mỗi bước một commit, lưới xanh trước và sau)

0. Baseline: `run_tests.py`, `npm test` (ghi số), chụp byte PDF mẫu (ảnh + chữ ký, trang 0° và `/Rotate 90`) **trước khi sửa** làm đối chứng BI-59. → verify: lưu hash.
1. **Hình học thuần** (`annot-geom.js`): `imageBox` / `annotBounds` image, `resizeRotated`, `imageMatrix`. Test thuần mới + đột biến. → verify: `test:geom`/`viewer-geom` xanh, N/N đột biến đỏ.
2. **Mã hoá** (`managed-codec.js`, `deserializeManaged`, `applyImgPages` copy trường mới): round-trip test; ảnh không xoay ⇒ JSON y hệt. → verify: `test:managed`.
3. **Bake** (AP + phẳng) dùng `imageMatrix`; thêm `image` (có rot/flip) vào `KINDS` của `test:rotate` (4 góc trang × vài rot/flip); ca bảo vệ: bỏ nhân `R(pageAngle)` phải đỏ. → verify: `test:rotate`, hash 0° không đổi.
4. **Overlay + tay nắm xoay + resize khi xoay** (`editor.js`, `app.css`, `test:bytes`/`test:scope`). → verify: probe thật (Electron + CDP, `--user-data-dir`): kéo tay nắm, Shift 15°, resize ảnh đã xoay, `Esc`.
5. **Menu chuột phải** + `help.js`/i18n (`SKIP_IDS` nếu cần). → verify: probe thật bấm từng mục + Ctrl+Z từng bước.
6. **Probe end-to-end:** chèn ảnh → xoay 30° + lật ngang → Xong → render file bằng pdf.js 2× đối chiếu pixel với overlay (≤ ~0,6 pt như BI-110) → mở lại editor ⇒ còn sửa được → xoay tiếp → lưu; thêm ca trang `/Rotate 90`, ảnh JPEG, ảnh áp nhiều trang, sao chép-dán.
7. Sổ: BI-116 trong `REGRESSION-GUARD.md` (+ dòng ma trận §5), cập nhật `HANDOFF.md`, memory.

## 5. Rủi ro đã nhìn thấy

- Quên một chỗ sao chép trường (`applyImgPages`, `copySelected` đã an toàn vì JSON clone) ⇒ xoay mất khi áp nhiều trang. Có test chốt.
- Cursor 4 góc (`nwse-resize`) sai khi ảnh xoay — chỉ thẩm mỹ, chấp nhận (hoặc đổi `cursor` theo góc).
- Ảnh xoay vươn ra ngoài trang: dùng hộp bao để kéo về (như `fitShift`).
- Chưa kiểm: có rubber-band chọn vùng không, `updateFmtPanel` có đọc kind image không — **đọc nốt trước bước 4**.

## 6. Câu hỏi cho chủ dự án

1. Có muốn thêm ô nhập góc "Xoay ảnh" trên thanh sửa (như hộp chữ), hay chỉ tay nắm chuột + menu chuột phải?
2. Xoay tự do mọi góc (Shift = 15°) hay chỉ bội 90°? (đề xuất: tự do)
3. Chọn nhiều ảnh cùng lúc rồi xoay/lật: mỗi ảnh quanh tâm riêng (đề xuất), hay chỉ cho phép khi chọn đúng một ảnh?
