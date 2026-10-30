# PLAN 2026-10-30 — Xoay hộp chữ bằng chuột + sửa định dạng nhiều hộp chữ cùng lúc

Trạng thái (2026-10-30): **Đợt A (BI-117) và Đợt B + C (BI-118, sửa style nhiều hộp) XONG — làm B và C một lượt, không tách commit refactor B0.** Luật + số đo ở `REGRESSION-GUARD.md`. Ghi chú thực hiện Đợt A: khác kế hoạch ở chỗ khối knob ảnh được **để nguyên** (thêm khối `text` riêng) vì `test:imgxf` ghim nó; hai ghim
`onDown`/`onMove` của `test:imgxf` đã sửa có chủ đích. Bước khảo sát ban đầu: **chờ chủ dự án duyệt.** Mức quy trình: **L** (chạm nhiều handler của
editor, vùng có BI-75/76/107/109/110/116). Chỉ renderer — **không đổi `*.py`, sidecar không build lại**.

## 0. Yêu cầu (viết lại bằng lời mình)
1. Hộp chữ xoay được bằng **núm xoay chuột** như ảnh vừa làm (BI-116).
2. **Chọn nhiều hộp chữ** (Ctrl+click) rồi sửa **style** chung: đậm / nghiêng / gạch chân, cỡ chữ, phông, màu, nền, căn lề,
   giãn dòng/chữ, viền khung… — **trừ nội dung**.
- Không làm: sửa nội dung nhiều hộp; đổi mô hình lưu (`/NabuData`); thay đổi bake; kéo khung chọn (marquee); căn thẳng hàng giữa các hộp.
- Thất bại dù đúng kỹ thuật: màn hình khác file đã lưu (BI-40); hộp chưa chạm ra byte khác (BI-59); một thao tác nhóm mà cần N lần Ctrl+Z.

## 1. Sự thật đã đọc trong mã (không suy đoán)
**Hộp chữ ĐÃ có xoay từ v0.2.63** — chỉ thiếu cửa chuột:
- Mô hình `a.rot` (độ, ngược chiều kim đồng hồ, `normRot` ở `annot-text.js`); `serializeManaged` **luôn** ghi `rot: s.rot` cho chữ
  (`managed-codec.js:491`) ⇒ khác ảnh, chữ **không** theo luật "vắng mặt = mặc định" (ghi `rot = 0` vô hại, nhưng vẫn nên `delete` cho gọn).
- Màn hình: `renderAnnot` (khối `if (st.rot)`) xoay quanh **tâm raster** `textRotationPivot` (BI-110), KHÔNG phải tâm phần tử. Bake: xoay trong
  PNG (`renderTextPng`), khung `/AP` vẫn thẳng ⇒ **không cần đổi bake / codec**.
- Cửa vào hiện tại: ô `#ed-textrot` (số, −180…180, step 1) + nút `+90°`, hàm `setTextRot` — **chỉ áp lên `ed.sel` (hộp chính)**.
- Núm xoay ảnh (BI-116) đã có đủ đồ nghề dùng lại: `.handle.h-rot` (`data-rot`), nhánh `rotate` của `onDown`/`onMove`/`cancelDrag`,
  `layerPointRaw` (con trỏ không kẹp), `AnnotGeom.rotateDragAngle(center, from, to, rot0, snap)`, Shift = 15°, undo đẩy lười, Esc trả góc.
  Hiện bị khoá bằng `kind === "image"` ở 2 chỗ: tạo núm (`renderAnnot`, cuối hàm) và `onDown` (`if (!hitR || hitR.a.kind !== "image") return`).
- Hộp chữ đã xoay **mất 4 tay nắm đổi bề rộng** (`isFixedTextBox` có `!rot`, BI-104) — không đổi; ô **Bề rộng khung** là đường thay thế.

**Chọn nhiều ĐÃ có**: Ctrl/Cmd+click (`toggleSelect`, cùng trang), `ed.sel` + `ed.selMore`, `selAnnots()` (đúng thứ tự z), kéo cả nhóm, Sao chép,
Xoá, Thứ tự chồng, **Dán định dạng** (`pasteTextFmt` — đã lặp trên mọi hộp chữ đang chọn, 1 bước undo), màu / nét / kiểu nét / cỡ nhãn.
Chưa có: kéo khung chọn (marquee), Ctrl+A.

**Chỗ còn "chỉ hộp chính" (đây là toàn bộ phạm vi của tính năng 2):**
| Nhóm | Handler (editor.js) | Hiện tại |
|---|---|---|
| Thanh sửa | `ed-fontsize.oninput`, `ed-font.onchange`, B/I/U (`[["ed-bold",…]]`), `setTextRot` / `ed-textrot-90` | `findAnnot(ed.sel)` — 1 hộp |
| Panel Định dạng | `applyTextFmt` (align, indent, listType, strike, lineHeight, paraSpacing, letterSpacing, wordSpacing, charScale, opacity), `fmt-wrap`, `applyBoxW`, `writeBorder`, `fmt-clear` | 1 hộp |
| Nền | `applyFillToSel` ← `fillTargetAnnot()` (trả `ed.sel` hoặc hộp đang gõ `ed._taAnnot`) | 1 vật thể, có chốt `a.kind !== kind` (BI-75) |
| Hiện/ẩn điều khiển | `syncCtlVisibility("select")` dùng `KIND_CTLS[kind của hộp chính]`; `updateFmtPanel` (`selText` đọc hộp chính) | hộp chính là chữ nhật ⇒ ẩn hết điều khiển chữ dù có hộp chữ trong nhóm |
| Hiển thị giá trị | `syncControls`, `syncFmtPanel` | đọc hộp chính (chấp nhận được — kiểu Word: bấm B = đặt cho cả nhóm theo trạng thái nút) |
| Không đổi nghĩa khi nhiều | `arrangeSelected` (căn giữa/cạnh trang), "Đặt làm mặc định", "Sao chép định dạng" | giữ hộp chính / xám khi nhiều hộp |

## 2. Phán quyết khả thi
- **(1) Núm xoay chữ: RẤT KHẢ THI, rủi ro thấp.** Không đổi mô hình / bake / codec / sidecar. Phần mới thật sự chỉ là: (a) **tâm xoay = pivot raster**
  (`a.x + pv.x, a.y + pv.y`) thay vì tâm hộp — nếu quên, hộp nhảy một đoạn ~`pad` khi bắt đầu kéo và lệch file khi lưu (BI-110);
  (b) đồng bộ ô `#ed-textrot` sau khi kéo; (c) loại `_foreign` (FreeText của phần mềm khác, BI-100); (d) vài chi tiết hiển thị (§3.A).
- **(2) Sửa style nhiều hộp: KHẢ THI, rủi ro trung bình** — không khó về thuật toán, khó ở **số handler** (~20) và ba điểm nhạy:
  nền (BI-75/76), hoàn tác (một bước cho nhóm), hiện/ẩn điều khiển theo kind. Đề xuất làm qua **một helper** `textTargets()` thay vì sửa lẻ từng chỗ.

## 3. Thiết kế
### A. Núm xoay hộp chữ (Đợt A)
1. Thuần (`annot-text.js`, có test): `textRotateCenter(a)` = `{ x: a.x + pv.x, y: a.y + pv.y }` với `pv = textRotationPivot(a.text, normTextStyle(a), a.fontSize)`.
   Pivot **không phụ thuộc `rot`** (layout là của hộp thẳng) ⇒ tính một lần ở `onDown`, đứng yên cả cú kéo.
2. `renderAnnot`: điều kiện núm `(image || text) && gripsFor && !_foreign` (dùng lại class `h-rot`, CSS không đổi). Với hộp có `charScale ≠ 1` phần tử bị
   `scaleX` ⇒ núm méo ngang: chữa bằng `transform: scaleX(1/charScale)` riêng cho núm (chỉ cosmetic; hộp có `opacity` < 1 thì núm cũng mờ — chấp nhận / ghi chú).
3. `onDown` nhánh `data-rot`: cho `text`; `center` = ảnh ? tâm hộp : `textRotateCenter`. `orig.rot` đọc bằng `normRot`
   (`normImgRot` đã được test ghim bằng `normRot` ⇒ dùng chung được).
4. `onMove`/`cancelDrag`: đã chung. Chỉ thêm: sau mỗi lần đổi, `$("ed-textrot").value` theo `a.rot` (không đụng `ed.textRot` — kéo chuột là "hộp này", không phải mặc định cho hộp mới; **quyết định của tôi, ghi rõ**).
5. Làm tròn góc 0,1° (tránh `33.714285…` trong ô và trong `/NabuData`); Shift = 15° giữ nguyên.
6. Không đụng: `isFixedTextBox`, `setTextRot`, bake, codec, `KINDS` của `test:rotate` (đã có `text`).

### B. Sửa style nhiều hộp (Đợt B, C)
- **B0 — refactor KHÔNG đổi hành vi** (commit riêng, theo CLAUDE.md): thêm `textTargets()` = `selAnnots().filter(kind === "text")`, và helper
  `forTextTargets(undoKey, fn, {remeasure})` làm đúng 4 việc cũ: `pushEdUndo(key + ":" + sigChọn)` → `fn(a)` từng hộp → (tuỳ chọn) `measureText` → `syncOverlays`.
  Với 1 hộp chọn, mọi handler phải ra kết quả **y hệt** (lưới `test:defaults` / `test:fmtpanel` / `test:teformat` / `test:text` xanh trước và sau).
  `sigChọn` = các id đã sắp xếp nối lại (thay cho `ed.sel`) để gộp undo theo burst không dính sang nhóm khác.
- **B1 — đổi hành vi, thanh sửa**: cỡ chữ, phông, B/I/U, `Xoay`/`+90°` (mỗi hộp quanh **tâm riêng**, `+90` cộng vào góc riêng — như ảnh BI-116).
  Bấm B = đặt `bold` của **cả nhóm** theo trạng thái nút của hộp chính (kiểu Word). Một bước undo cho cả nhóm.
- **B2 — hiện/ẩn điều khiển**: `syncCtlVisibility("select")` lấy **hợp** `KIND_CTLS` của mọi kind đang chọn; `updateFmtPanel` hiện khi **có ít nhất một hộp chữ** trong nhóm.
  Chú ý BI-41: không thêm hàng vào thanh sửa.
- **C1 — panel Định dạng**: align, indent, list, strike, lineHeight, paraSpacing, letterSpacing, wordSpacing, charScale, opacity, `fmt-clear`, `fmt-wrap` (mỗi hộp bắt đầu bằng bề rộng tự nhiên của nó),
  `fmt-boxw` (cùng một bề rộng cho các hộp **đang là hộp cố định**; hộp điểm bị bỏ qua), viền (`writeBorder` — bỏ `_foreign`, như `pasteTextFmt`).
  `arrangeSelected` / "Đặt làm mặc định" / "Sao chép định dạng": **xám khi chọn ≥ 2 hộp** (nghĩa không rõ).
- **C2 — Nền**: `fillTargetAnnot` → danh sách; khi **không** mở ô gõ: mọi vật thể đang chọn **cùng kind với `fillCtlKind()`** (giữ chốt BI-75: "công cụ đang cầm quyết định mục tiêu").
  Khi ô gõ đang mở: giữ nguyên (đúng một hộp, `ed._taAnnot`). Nguyên tắc BI-76 giữ: điều khiển là nguồn sự thật, ghi `fill` + `fillOpacity` cùng lúc từ `fillFromCtls()`.
- Loại ra: nội dung `text`, vị trí `x/y`, `w/h` (do đo lại), `_foreign` cho viền.

### Giả định mặc định (tôi sẽ làm theo nếu bạn không phản đối)
G1. Chỉ Ctrl+click (đã có), **không** làm marquee/Ctrl+A đợt này (đụng chuột-trống đang là "bỏ chọn" + lớp chữ pdf.js; để thành việc riêng).
G2. Núm xoay chỉ khi chọn **một** hộp; nhiều hộp xoay bằng ô `Xoay`/`+90°` (mỗi hộp quanh tâm riêng).
G3. Giá trị hiển thị lấy từ **hộp chính**; không có trạng thái "hỗn hợp" (làm sau nếu cần).
G4. Chọn lẫn loại (chữ + ảnh + chữ nhật): điều khiển chữ chỉ tác động hộp chữ; màu / nét như cũ.
G5. Không thêm mục "Xoay" cho hộp chữ vào menu chuột phải đợt này.

## 4. Kế hoạch & kiểm chứng (mỗi đợt một commit — hoặc hai nếu có B0)
| Bước | Việc | → verify |
|---|---|---|
| 0 | Baseline: `cd desktop && npm test`; `.venv\Scripts\python run_tests.py` | N/N xanh, ghi số |
| A1 | `textRotateCenter` + test thuần trong `test:text` | khớp tay: 3 cỡ chữ × charScale; **đột biến** "tâm hộp" ⇒ đỏ |
| A2 | Núm + onDown/onMove/ô Xoay + loại `_foreign` | test cắt-từ-mã-ship (kiểu `fmt-panel.test.js`) + `test:imgxf` & `test:rotate` **vẫn xanh** (ảnh không đổi) |
| A3 | Probe app thật (CDP, chuột thật): kéo núm +90°, tâm không dời < 0,6 pt; Shift 15°; Esc trả góc & undo lùi đúng 1 bước; trang `/Rotate 90`; hộp charScale 60%; hộp cố định `boxW`; Áp dụng → render `state.bytes` bằng pdf.js ⇒ **cùng pixel** với overlay; mở lại file giữ `rot`; hộp 0° ra **byte y hệt** bản trước (harness BI-59) | số đo ghi vào BI-117 |
| B0 | Refactor `textTargets` / `forTextTargets` | lưới xanh trước & sau; 1 hộp ⇒ snapshot undo y hệt |
| B1–B2 | Thanh sửa + hiện/ẩn | test: 3 hộp chữ + 1 chữ nhật + 1 ảnh: chỉ hộp chữ đổi; **1** bước undo; nhóm lẫn loại hiện đúng điều khiển; đột biến "chỉ phần tử đầu" ⇒ đỏ |
| C1–C2 | Panel + Nền | `test:defaults` mở rộng (BI-75/76 vẫn đúng); probe: nền/viền nhiều hộp → file lưu **khớp pixel** từng hộp; hộp đang gõ không bị ảnh hưởng nhóm |
| Cuối | Ghi sổ BI-117 (xoay chữ) + BI-118 (sửa nhiều hộp) + dòng ma trận §5; `help.js` VI+EN; `i18n.js` nếu có nhãn mới; handoff | review độc lập bằng agent mới trước merge |

Đọc trước khi sửa: BI-71, BI-75, BI-76, BI-104, BI-107, BI-109, BI-110, BI-116, BI-100 (REGRESSION-GUARD — `Grep "BI-<số>"`).
Bẫy riêng: BI-14 (không thêm tên trần toàn cục); `test:scope`; BI-3 không liên quan (chỉ mức annot, `pushEdUndo` của editor); BI-9/10 nếu thêm nút trả phí (không có).

## 5. Rủi ro đã nhận diện
- Quên pivot raster ⇒ hộp nhảy / lệch file (BI-110). Có test A1 + probe A3.
- Gộp undo theo burst dính giữa hai nhóm (`"fmt:key:" + ed.sel`) ⇒ khoá theo chữ ký nhóm.
- Nền: slot riêng theo kind (BI-75) ⇒ nhóm lẫn loại chỉ ghi vào kind của hộp chính.
- Ô gõ đang mở + chọn nhiều: `onDown` đã commit ô gõ trước khi đổi chọn; giữ nguyên.
- `remeasure` N hộp = N lần `layoutTextBox` ở 3× mỗi lần kéo thanh trượt (spacing/opacity): hộp ít nên ổn; nếu nhóm lớn (vài chục) thì cần đo (chưa đo).

## 6. Phát hiện ngoài phạm vi (chưa kiểm, chỉ báo)
- `setTextRot` **không chặn `_foreign`**: xoay một FreeText của phần mềm khác bằng ô `Xoay` — `writeFreeText` truyền `a` (có `rot`) vào `renderTextPng`
  nhưng không ghi lại `rot` vào dict, nên mở lại sẽ mất xoay. **Chưa tái hiện.** Núm mới sẽ loại `_foreign`; ô cũ để nguyên.

## 7. Chưa kiểm được / sẽ báo rõ khi xong
Acrobat / Foxit (chỉ pdf.js), `/Rotate` 180/270 e2e, tiếng Anh của nhãn mới, hiệu năng nhóm lớn.
