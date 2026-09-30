# Nabu PDF — Hướng dẫn sử dụng

Bộ công cụ PDF chạy trên máy (xem · ghép · tách · xoay · khoanh vùng · mũi tên · ghi chú · watermark ·
redact · **sửa chữ gốc** · nén · so sánh & **chồng lớp bản vẽ** · tạo PDF tìm-kiếm-được · OCR + bóc tách hợp đồng). Toàn bộ xử lý
diễn ra **ngay trên máy bạn** — file PDF không bị gửi lên mạng (trừ tính năng "Bóc tách" dùng AI, xem mục 6).

---

## 1. Cần copy gì vào USB

Chỉ cần **một file duy nhất**:

| Kiểu | File tải về | Dùng khi |
|------|-------------|----------|
| **Bản cài đặt** | `NabuPDF-0.2.63-x64.exe` (~455 MB) | Cài vào máy (tạo shortcut, gỡ qua Control Panel), **tự cập nhật** khi có bản mới. |

> **Từ v0.2.48 không còn bản portable.** Các bản trước có
> `NabuPDF-<ver>-portable.exe`; nó đã bị bỏ khỏi quy trình đóng gói vì bản cài đặt tự
> cập nhật được (OTA) còn portable thì không, nên người dùng portable cứ mắc ở bản cũ.
> Nếu bạn đang dùng portable: tải bản cài đặt ở trên, nó sẽ tự cập nhật từ nay.

**Tải ở đâu:** trang phát hành — <https://github.com/darkend16987/NabuPDF-Releases/releases/latest>
> (từ v0.2.63 các bản phát hành chuyển sang repo riêng `NabuPDF-Releases`; máy đã cài
> bản v0.2.62 trở về trước vẫn tự cập nhật lên v0.2.63 như bình thường, sau đó đi theo
> repo mới)
(kèm `SHA256SUMS.txt` để đối chiếu file tải về nếu cần).

> Nếu bạn tự build trên máy phát triển thì file nằm ở `desktop\dist-app\` trong thư mục dự án.

> **Không cần** copy thư mục `win-unpacked`, không cần cài Python, không cần `.venv`. Mọi thứ đã
> gói sẵn trong file `.exe`.

---

## 2. Cách chạy

1. Copy `NabuPDF-0.2.63-x64.exe` vào máy đích.
2. Nháy đúp → chọn thư mục cài → Next → Install.
3. Chạy từ Start Menu / shortcut desktop. Gỡ qua **Settings → Apps** như phần mềm thường.
4. Các bản sau app **tự tải và tự cập nhật**, không phải làm lại bước 1–3.

> **Gộp nhiều PDF ngay từ Explorer (từ v0.2.60):** trình cài đặt thêm một mục vào **menu chuột phải**
> của file PDF. Chọn nhiều file PDF trong Explorer → **chuột phải** → **Gộp bằng Nabu PDF** → app mở
> hộp thoại **đã điền sẵn** các file đó; kiểm/sắp lại thứ tự rồi bấm **Gộp & lưu**.
>
> - ⚠️ **Trên Windows 11 mục này nằm trong "Hiện thêm tùy chọn"** (hoặc bấm `Shift+F10` thay vì chuột
>   phải). Menu chuột phải ngắn của Win11 chỉ nhận tiện ích đã **ký số**, mà app đang chưa ký (xem
>   mục 3.1) — nên đây là giới hạn của Windows, không phải lỗi.
> - App **không gộp ngay**: nó luôn hiện danh sách để bạn xác nhận, vì Windows không cho biết bạn đã
>   click các file theo thứ tự nào. Danh sách được **sắp theo tên** (`1, 2, 10` — không phải `1, 10, 2`)
>   và kéo–thả sắp lại được.
> - Đang mở dở tài liệu khác cũng không sao: batch mở trong **tab mới**, tài liệu đang đọc không bị đụng.
> - Giới hạn: Windows **ẩn** mục menu nếu chọn quá **100** file; app nhận tối đa **60** file mỗi lượt và
>   báo rõ nếu phải bỏ bớt. File có mật khẩu bị bỏ qua kèm thông báo, các file còn lại vẫn gộp.
> - Không dùng menu này thì vẫn có nút **Gộp file** trong app như trước.
> - Gỡ app sẽ xoá mục menu này khỏi máy.

> **Hoặc kéo thẳng vào cửa sổ (từ v0.2.60):** chọn vài file PDF trong Explorer rồi **kéo thả vào cửa
> sổ Nabu** → app hỏi **Mở từng file** hay **Gộp thành một file**.
>
> - Cách này **giữ đúng thứ tự bạn vừa kéo** — hơn đường chuột phải, vì Windows không cho biết thứ tự
>   khi gọi qua menu. Vẫn kéo–thả sắp lại được trong hộp thoại.
> - `Enter` = Mở từng file · `Esc` = **không làm gì cả** (tài liệu đang mở không bị đụng).
> - Kéo **một** file thì mở luôn như trước, không hỏi gì.
> - Lưu ý: kéo vào **dải trang** bên trái vẫn là **chèn trang vào tài liệu đang mở** như cũ — muốn gộp
>   thì thả vào **vùng xem** chính giữa.

---

## 3. Lưu ý quan trọng lần chạy đầu trên máy mới

1. **Cảnh báo SmartScreen / Windows Defender** — vì app **chưa ký số** (chưa mua chứng chỉ), Windows
   có thể hiện "Windows protected your PC". Bấm **More info → Run anyway** (Thêm thông tin → Vẫn chạy).
   Đây là cảnh báo bình thường cho phần mềm tự đóng gói, không phải virus.

2. **Engine OCR khởi động ngầm** — góc phải app có badge **"OCR: …"**. App PDF dùng được
   **ngay lập tức**; engine chạy ngầm và thường sẵn sàng trong khoảng **1–2 giây**. Khi badge
   chuyển **"OCR: sẵn sàng"** thì các nút Searchable / Bóc tách mới bật.

3. **OCR chạy offline hoàn toàn — không cần Internet** *(từ bản này trở đi)*
   Model nhận dạng chữ tiếng Việt đã **nằm sẵn trong bộ cài**. Cắm máy không mạng, cài xong là
   OCR / Searchable dùng được ngay từ lần đầu.
   > Trước đây model được **tải về lúc dùng lần đầu** (~152 MB từ một máy chủ ngoài) và cất vào thư
   > mục tạm của Windows — mà Windows dọn thư mục đó định kỳ, nên có máy phải tải lại. Đo thực tế:
   > **286 giây** chỉ để sẵn sàng OCR trang đầu, trên máy đã từng dùng OCR thành công. Nay không còn.

   Chỉ **Bóc tách hợp đồng bằng AI** là vẫn cần mạng, vì nó gọi Gemini (mục 6).

---

## 4. Tính năng nào chạy offline, tính năng nào cần mạng

| Nhóm tính năng | Cần mạng? | Ghi chú |
|----------------|-----------|---------|
| Xem · ghép · tách · chèn · xoay · xóa · sắp xếp · **Lưu** | ❌ Không | Chạy hoàn toàn offline, không cần engine OCR. |
| Chỉnh sửa overlay: chú thích, khoanh vùng, mũi tên (kèm nhãn), ghi chú (kèm bình luận), watermark, redact, điền form | ❌ Không | Offline. |
| **Sửa chữ gốc** · **Nén PDF** | ❌ Không | Offline (dùng thư viện PDF gói sẵn). |
| **Ẩn trang bằng mật khẩu** (mục 5) | ❌ Không | Offline hoàn toàn, **không cần cả engine OCR**: mã hoá chạy ngay trong app. Mật khẩu không rời máy bạn và không được lưu ở đâu cả. |
| **Ký số** bằng USB token (mục 5.1) | ⚠️ Chỉ TSA | Bản thân việc ký chạy offline (token + kho chứng thư Windows). Chỉ **dấu thời gian (TSA)** cần mạng — để trống ô đó thì ký offline hoàn toàn. |
| **So sánh** 2 PDF · **So sánh & Chồng lớp bản vẽ** (CAD/Revit) | ❌ Không | Cần engine bật (badge OCR), nhưng engine chạy offline — model đã nằm trong bộ cài (mục 3.3). |
| **Chuyển đổi**: Khoá file (đặt mật khẩu) · Xuất ảnh trong PDF · Trang PDF → ảnh · Ảnh → PDF | ❌ Không | Offline (thư viện PDF gói sẵn). Gom trong nút **Chuyển đổi** trên thanh công cụ + menu "Chuyển đổi". |
| **Searchable** (PDF tìm-kiếm-được) | ❌ Không | Cần engine OCR, nhưng chạy offline — model đã nằm trong bộ cài (mục 3.3). |
| **Bóc tách** hợp đồng (OCR + AI) | ✅ Có | Phần OCR chạy offline; phần **AI** gọi Gemini nên cần mạng + key AI (mục 6). |

> 💡 **Mẹo kéo–thả ở cột trang (thumbnail):**
> - **Sắp xếp trang:** kéo một trang thả lên trang khác để đổi vị trí.
> - **Chèn file PDF bằng kéo–thả:** kéo file `.pdf` từ Windows thả vào **khe giữa hai trang** ở cột
>   thumbnail — trang sẽ được chèn ngay tại vị trí đó (thả vào nửa trên = chèn phía trước trang, nửa
>   dưới = chèn phía sau). Thả nhiều file cùng lúc cũng được. Không cần mở hộp thoại chọn vị trí.
> - Vẫn dùng được nút **Chèn / Ghép** với hộp thoại chọn vị trí như cũ; kéo–thả chỉ là lối tắt.

> 🔀 **Chuyển trang sang một tài liệu khác đang mở:**
> - **Kéo giữa hai cửa sổ:** mở hai file ở **hai cửa sổ** (`Ctrl+N`, hoặc Cài đặt → mở file mới ở cửa
>   sổ riêng), đặt cạnh nhau, rồi kéo một trang từ cột trang cửa sổ này sang **khe giữa hai trang** ở
>   cột trang cửa sổ kia. Cột bên nhận sáng lên đúng khe sẽ chèn vào.
> - **Mặc định là COPY** — tài liệu gốc **không mất trang**. Giữ `Shift` khi thả để **chuyển** hẳn,
>   hoặc bấm **Xoá khỏi bản gốc** trên thông báo hiện ra sau khi copy.
> - Muốn chuyển **nhiều trang**: tick chọn trước, rồi kéo **một trang trong số đó** — cả tập đi cùng.
> - **Không cần kéo:** chuột phải lên trang → **Chuyển trang này sang tài liệu khác…** → chọn đích.
>   Đường này còn tới được **tab khác trong cùng cửa sổ** (kéo–thả không làm được, vì tab không hiện
>   trên màn hình thì không có gì để thả vào). Trang được **nối vào cuối** tài liệu đích.
> - Cửa sổ đích **đang chú thích dở** hoặc **chưa mở file** thì không nhận trang — Nabu báo lý do ngay
>   ở **cửa sổ bạn đang kéo**. Cột trang bên nhận đang thu gọn thì **giữ con trỏ trên mép tab của nó
>   một nhịp**, cột sẽ tự bung; kéo đi mà không thả thì nó thu lại như cũ.

> ◫ **Chia đôi màn hình — xem hai tài liệu cạnh nhau (từ v0.2.69):**
> - **`Ctrl+\`** (hoặc nút **◫** cạnh dấu **+** trên dải tab) tách cửa sổ làm hai: **khung trái** là
>   tài liệu bạn đang sửa, **khung phải** là một **khung xem chỉ đọc**. Bấm `Ctrl+\` lần nữa để đóng.
> - Đang mở **một** file thì khung xem mở **chính file đó** — đây là ca dùng chính: xem trang 40
>   trong lúc đang sửa trang 5, khỏi phải cuộn qua cuộn lại.
> - Bấm **tên file** trên đầu khung xem để đổi nguồn: *Cùng tài liệu khung chính* · một **tab** đang
>   mở · **Mở file khác…** (chọn bất kỳ PDF nào trên máy).
> - **Kéo rãnh** giữa hai khung để đổi tỷ lệ. Tỷ lệ đó — và cả việc đang chia khung — được **nhớ lại
>   khi mở app lần sau**. **`Ctrl+Shift+\`** thêm khung thứ ba (tối đa 3 khung).
> - **Khung xem không sửa được, và đó là điều làm cho việc mở cùng một file hai lần an toàn:** chỉ
>   một khung ghi được, nên không có chuyện bản lưu này đè mất bản lưu kia. **`Ctrl+S`, In, Hoàn
>   tác luôn thuộc về khung chính**, không bao giờ bắn sang khung xem.
> - Khung xem hiển thị **bản đã lưu trên đĩa** và nói rõ *"bản lưu HH:MM"*. Bấm `Ctrl+S` ở khung
>   chính là nó **tự nạp lại**, và **giữ nguyên trang bạn đang đọc**.
> - Đang xem một file ở khung phải mà muốn sửa nó? Bấm **Sửa file này** — nó chuyển sang khung chính,
>   còn tài liệu đang sửa dời sang khung xem. Hai file vẫn cạnh nhau, không file nào biến mất.
> - Vài điều khung xem **không** làm (đúng thiết kế, không phải lỗi): không nhận trang kéo sang (thả
>   vào **khung chính**) · file **có mật khẩu** phải mở ở khung chính · trang đang **ẩn bằng mật
>   khẩu** hiện ra dạng **trang giữ chỗ**.

> ⌨️ **Menu & phím tắt** (thanh menu trên cùng: Tập tin · Chỉnh sửa · Trang · Chuyển đổi · Hiển thị · Trợ giúp):
> - **Ctrl+O** Mở · **Ctrl+S** Lưu · **Ctrl+Shift+S** Lưu thành…
>   (Ctrl+S ghi đè thẳng vào file đang mở; file kéo–thả/chưa lưu thì hỏi nơi lưu.)
> - **Ctrl+Z** Hoàn tác · **Ctrl+Y** Làm lại.
> - **Ctrl + / Ctrl − / Ctrl 0** Phóng to / Thu nhỏ / Cỡ gốc 100%. Hai nút ± và hai phím này
>   bước **theo tỷ lệ**, nên một cú bấm ở 20% và một cú ở 400% cảm giác như nhau; bấm phóng rồi
>   bấm thu cùng số lần là về đúng tỷ lệ ban đầu.
> - **Ctrl + lăn chuột** phóng to/thu nhỏ **bám theo con trỏ**. Trang bám tay ngay lập tức (hơi mềm
>   một nhịp) rồi **tự làm nét khi bạn dừng lại** — đó là cách Acrobat/Foxit làm, và là lý do zoom
>   không còn giật từng nấc.
> - **Vừa bề ngang / Vừa chiều dọc** (nút cạnh ô zoom) — "Vừa chiều dọc" hợp văn bản khổ ngang (landscape).
> - Gõ thẳng số vào **ô zoom**: nhận **20 đến 500**. Ba nút "Vừa…" vẫn xuống thấp hơn 20% được khi
>   cần, vì trên bản vẽ A0 cả trang không lọt màn hình ở tỷ lệ nào cao hơn.
> - **↑ / ↓** (ở cửa sổ xem trang) nhảy sang trang trước / trang kế.
> - **Delete** Xóa trang đang chọn.
> - **Ctrl+\\** Chia đôi màn hình (bật/tắt khung xem chỉ đọc) · **Ctrl+Shift+\\** thêm một khung xem.
>
> 💡 **Cột trang chạy theo bạn:** cuộn tài liệu tới đâu, thumbnail trang đó **sáng lên** (số trang đổi
> màu) và cột trang **tự trượt** để trang đó luôn nằm trong khung nhìn. Đây chỉ là dấu "bạn đang ở đây"
> — nó **không** đổi các trang bạn đã tick chọn, nên Xoá/Tách trang vẫn nhắm đúng những trang bạn chọn.

> 🖨️ **In tài liệu (Ctrl+P):**
> - **Chọn trang ngay trong hộp thoại của Nabu** — ô **"Trang cần in"**: gõ `1-2`, `1-3, 5, 8-10`…
>   **Để trống là in tất cả.** Dòng chữ ngay dưới ô luôn cho bạn xem trước *"Sẽ in mấy trang, những
>   trang nào"* trước khi bấm In, và nút **In** tự khoá nếu không nhận ra trang nào.
> - **Nên dùng ô này thay vì mở hộp thoại của hệ thống để chọn trang.** Khoảng trang trong hộp thoại
>   của Windows đếm theo **TỜ giấy in ra**, còn ô của Nabu đếm theo **trang tài liệu** — với tài liệu
>   thường thì hai cách ra cùng kết quả, nhưng ô của Nabu luôn đúng ý bạn hơn.
> - **Mỗi trang tài liệu luôn in gọn trong đúng một tờ giấy**, ở mọi khổ (A4 → A0, Letter, Legal) và
>   giữ nguyên tỷ lệ — không bao giờ bị đẩy phần dưới sang tờ sau, không bị cắt, không bị kéo méo.
>   Nếu khổ giấy có tỷ lệ khác trang tài liệu thì phần chênh là **dải trắng** ở hai mép.
> - Tài liệu có **cả trang dọc và trang ngang** vẫn in đúng — mỗi trang một tờ. Trang ngang nằm gọn
>   giữa tờ giấy dọc (nên nhỏ hơn); muốn nó lấp trọn tờ giấy thì chọn **Hướng giấy → Ngang** cho các
>   trang đó, hoặc tách chúng ra in riêng.

Cache model lưu ở: `C:\Users\<tên-bạn>\.paddlex` (và `.cache`). Xóa được nếu cần giải phóng ổ; lần
sau dùng OCR sẽ tải lại.

---

## 5. Sửa chữ, chú thích & ký số

**"Sửa chữ gốc" dùng được với loại PDF nào:**

- ✅ **PDF có chữ thật** (xuất từ Word/Excel, in-ra-PDF): bấm **"Sửa chữ"** → các đoạn chữ hiện viền
  bấm được → sửa trực tiếp (kể cả tiếng Việt có dấu) → **Áp dụng** → **Lưu**. Chữ cũ bị xóa thật,
  chữ mới thay đúng chỗ.
- ❌ **PDF scan (ảnh chụp/scan giấy)**: không có ký tự để sửa. App sẽ báo *"trang này là ảnh scan,
  không có chữ để sửa"* → hãy dùng **Searchable** hoặc **Bóc tách** thay thế.

> **Chọn font khi sửa:** ô **Font** có **"Giữ nguyên (font gốc)"** (mặc định — giữ đúng font của đoạn
> đang sửa) và nhóm **"Font máy"** liệt kê font cài trên máy. Chọn font máy → chữ sửa dùng đúng font đó.

> ↔️ **Di chuyển chữ (từ v0.2.73):** trong **Sửa chữ**, **giữ chuột kéo** một ô chữ sang chỗ mới —
> chữ đã sửa hay chưa sửa đều kéo được. **Bấm** (không kéo) vẫn là mở ô để sửa như cũ.
> - Trước khi **Áp dụng**: chỗ cũ hiện **khung sọc đỏ nét đứt** (chữ ở đó sẽ bị xoá), chỗ mới hiện
>   **bản xem trước** của chữ. Kéo về **sát chỗ cũ** thì ô tự bắt về như chưa di chuyển.
> - Bấm **Áp dụng**: chữ cũ bị **xoá thật** ở chỗ cũ và vẽ lại ở chỗ mới — đúng hướng cả trên bản vẽ
>   xoay ngang. `Ctrl+Z` để hoàn tác.
> - Mỗi lần kéo **một ô**, trong **cùng trang**, không kéo ra ngoài mép trang được. Một dòng có chữ đậm
>   xen chữ thường là **nhiều ô** — kéo từng ô.
> - Chữ bị lỗi font (ô viền vàng nét đứt) phải **bấm vào để OCR lấy lại chữ đúng** trước rồi mới kéo được.
> - Chữ đã di chuyển được **vẽ lại**, nên máy không có font gốc thì dùng font thay thế gần nhất — giống
>   như khi sửa chữ.

Giới hạn đã biết: sửa trong phạm vi từng đoạn (không tự dàn lại dòng); chữ dài hơn ô cũ sẽ tự co nhỏ.

> **Bản vẽ nằm ngang (CAD / hồ sơ thầu):** từ v0.2.62, chữ sửa lại — và chữ thay thế của
> **Tìm & Thay thế** — giữ **đúng chiều của dòng nó thay**: dòng đọc xuôi vẫn đọc xuôi, **nhãn kích
> thước dựng dọc vẫn dựng dọc**, nhãn dẫn viết chéo vẫn đúng góc. Trước đó mọi thứ bị vẽ lại nằm
> ngang nên trên tờ đã xoay trông như **tự quay 90°**.

**Tìm & Thay thế (`Ctrl+H`)** — đổi một từ khoá xuất hiện nhiều chỗ trong cả tài liệu, giống `Ctrl+H`
của Word. Mở bằng `Ctrl+H` hoặc nút **⇄** ở cuối ô *Tìm trong tài liệu* trên thanh công cụ.

- Gõ chữ cần tìm rồi bấm **Tìm** (hoặc `Enter`) → app quét **toàn bộ tài liệu**, tô sáng mọi vị trí
  và hiện số đếm. App **không** quét theo từng ký tự bạn gõ: mỗi lượt quét là một lần đọc hết tài
  liệu, với tệp vài trăm trang có thể mất vài chục giây.
- Đã có kết quả rồi thì `Enter` / `Shift+Enter` (hoặc nút ↑ ↓) đi tới vị trí kế / trước. Đổi từ khoá
  hoặc đổi tuỳ chọn thì kết quả cũ thành **quá hạn** — hai nút **Thay** tạm khoá cho tới khi quét lại.
- **Thay** đổi đúng vị trí đang chọn (viền cam) rồi nhảy sang vị trí kế — duyệt lần lượt từ trên
  xuống, chỗ nào không muốn đổi thì bấm ↓ để bỏ qua.
- **Thay tất cả** đổi hết trong một lần; app hỏi xác nhận kèm số lượng trước khi ghi. Một `Ctrl+Z`
  hoàn tác cả lượt.
- Có **Phân biệt hoa/thường** và **Đúng nguyên từ**. Để trống ô *Thay bằng* thì từ khoá bị **xoá**.

> **Ba giới hạn cần biết.**
> 1. Chỉ chạy trên **PDF có chữ thật** — bản scan phải chạy **OCR văn bản** trước.
> 2. Vị trí tô **vàng nét đứt** là từ khoá bị **chia làm nhiều đoạn định dạng** (ví dụ "Bên **A**" khi
>    chữ A in đậm). App **đếm và chỉ ra** cho bạn nhưng **không tự thay**, vì thay nửa vời sẽ hỏng
>    định dạng — sửa tay bằng **Sửa nội dung**.
> 3. Khác ô `Ctrl+F`, ô này **có phân biệt dấu**: gõ "hop dong" **không** ra "hợp đồng". Cố ý như vậy —
>    thay một kết quả bỏ dấu sẽ làm **mất dấu** trong hợp đồng của bạn.
>
> Tài liệu **rất lớn** vẫn **tìm** được (bộ bản vẽ vài trăm trang, tới ~1GB), và lần tìm thứ hai trở đi
> trên cùng tài liệu nhanh hơn hẳn. Riêng việc **thay** thì tài liệu trên **~200MB** chưa ghi được — app
> báo ngay trên dòng đếm và mờ hai nút **Thay**; hãy **Nén** bớt trước.

> **Chèn chữ ký:** dùng nút **Chèn ảnh / chữ ký** → chọn ảnh chữ ký rồi bấm lên trang để đặt.
> Nên dùng **PNG nền trong** để chữ ký không có hộp trắng đè lên tài liệu (ảnh JPG có nền đặc — app sẽ
> nhắc). Chỉ nhận **PNG / JPG**.
> ⚠️ Đây là **dán ảnh chữ ký** — chỉ là hình ảnh trên trang, **không** có giá trị pháp lý và ai cũng
> xoá/sửa được. Muốn **chữ ký số** thật (có chứng thư CA, kiểm tra được tính toàn vẹn) thì dùng nút
> **Ký số** trên thanh công cụ — xem mục 5.1 ngay dưới. Hai thứ này dùng chung được: chèn ảnh con dấu
> cho đẹp, rồi ký số để có hiệu lực.

> ✍️ **Chữ ký lưu sẵn (từ v0.2.72):** thiết lập một lần, về sau chèn bằng hai cú bấm.
> - **Thiết lập:** **Cài đặt → Chữ ký của tôi → Quản lý… → + Thêm chữ ký…** → chọn ảnh (PNG, JPG, BMP…).
>   Ảnh được xem trước trên **nền caro** (phần caro là trong suốt):
>   - **Xoá nền trắng** — cho ảnh **chụp/scan chữ ký trên giấy**: nền giấy thành trong suốt, mép nét
>     vẫn mềm. App **tự bật** ô này khi ảnh không có nền trong suốt. Thanh **Độ mạnh** chỉnh mức xoá:
>     giấy hơi xám thì kéo sang phải; nét ký bị mất thì kéo sang trái (app báo nếu không còn nét nào).
>   - **Cắt sát nét ký** — bỏ khoảng trống quanh chữ ký để khung ôm sát, đặt dễ canh.
>   - Đặt **tên** (vd *Chữ ký Giám đốc*, *Dấu công ty*) → **Lưu chữ ký**. Đổi tên / xoá ngay trong danh sách.
> - **Chèn:** **chuột phải lên trang** (ở chế độ xem hay khi đang Chú thích đều được) → **Chèn chữ ký:
>   <tên>** → chữ ký nằm **giữa chỗ bạn vừa bấm**. Hoặc khi đang Chú thích, bấm nút **chữ ký** cạnh
>   công cụ Ảnh → chọn → bấm lên trang.
> - Chữ ký chèn vào là một **ảnh bình thường**: kéo để chỉnh chỗ, kéo góc để đổi cỡ, dùng được **Áp nhiều
>   trang**. Bấm **Xong** là **xác nhận** ghi vào file.
> - **App nhớ cỡ:** cỡ bạn để lại lúc bấm Xong sẽ là cỡ mặc định lần chèn sau của chữ ký đó (lần đầu
>   khoảng 5 cm).
> - **Bảo mật:** kho chữ ký chỉ nằm trên máy này và được **mã hoá bằng tài khoản Windows** của bạn —
>   chép file sang máy khác hay tài khoản khác thì không mở được. Nếu app báo **không đọc được kho**,
>   nút **Tạo kho mới** bắt đầu lại và **giữ nguyên file cũ bên cạnh**, không xoá.
> - ⚠️ Vẫn là **ảnh chữ ký**, không phải chữ ký số — xem lưu ý ngay trên.

> **Ảnh vẫn sửa lại được sau khi Lưu:** giống hộp văn bản và ghi chú, ảnh/chữ ký bạn chèn **không bị
> "dán chết"** vào trang. Mở lại file → bấm **Chỉnh sửa** → ảnh lại là một đối tượng riêng: kéo để
> **di chuyển**, kéo **4 góc** để **đổi cỡ**, **Delete** để **xoá**, và vẫn dùng được **"Áp ảnh/chữ ký
> cho nhiều trang"**.
> - **Giữ Shift** khi kéo góc → co giãn **đúng tỷ lệ** (không bị méo). Áp dụng cho cả khoanh vùng
>   chữ nhật/elip, tô sáng và ô che (redact).
> - **Trang đã xoay: từ v0.2.58 cũng sửa lại được.** Trước đó, trên trang có `/Rotate` — bản scan nằm
>   ngang, bản vẽ A3, hoặc bất cứ trang nào bạn vừa bấm **Xoay** — thì ảnh, hộp văn bản và mũi tên
>   đều bị dán chết dù *vị trí và chiều* vẫn đúng. Nay chúng là đối tượng sống ở mọi chiều xoay.
>   (Từ **v0.2.52** thì vị trí/chiều của mọi hình trên trang xoay đều đúng — trước đó **khoanh mây**
>   bị xoay 90° sau khi Áp dụng.)
> - Ảnh chèn ở các bản **trước v0.2.48** đã dán chết rồi thì không lấy lại được thành đối tượng; chỉ
>   ảnh chèn từ bản này trở đi mới sửa lại được.

> **Mũi tên kèm nhãn:** chọn công cụ **Mũi tên**, kéo để vẽ — thả ra là hiện ô nhập chữ ngay ở **đầu mũi tên**
> (gõ nhãn rồi Enter, bỏ trống/Esc nếu không cần). Muốn sửa nhãn sau: **bấm đúp** vào mũi tên.
> - **Xoay / đổi độ dài (từ v0.2.52):** chọn mũi tên → hiện **2 nút tròn** ở hai đầu. Kéo một đầu thì
>   đầu kia **đứng yên**, nên mũi tên xoay quanh nó. **Giữ Shift** để khoá góc theo bước **15°** mà
>   **không đổi độ dài** — tiện khi cần đường dẫn ngang/dọc/chéo cho thẳng thớm.
> - **Đảo chiều:** nút **Đảo chiều** trên thanh chú thích (chỉ hiện khi đang chọn một mũi tên) lật
>   mũi nhọn sang đầu kia; **nhãn đi theo mũi nhọn**.
> - Tất cả những thao tác trên **vẫn làm được sau khi Áp dụng / Lưu rồi mở lại** — mũi tên là đối
>   tượng sống lại được, như hộp văn bản, ghi chú và ảnh.

> **Vẽ tay thành đoạn thẳng (giữ Shift):** chọn công cụ **Vẽ tay** (phím `D`), giữ chuột kéo như thường.
> Muốn một đoạn **thẳng** thì **giữ thêm Shift** — đoạn đang vẽ duỗi thẳng từ chỗ bạn nhấn Shift tới con
> trỏ, rê chuột để chỉnh hướng và độ dài. **Thả Shift ra là vẽ tay tiếp** từ đúng đầu mút đó, nên một nét
> có thể vừa có đoạn thẳng vừa có đoạn nguệch ngoạc. Tiện để gạch chân một dòng hợp đồng hay kẻ một đường
> dẫn thẳng mà không phải đổi công cụ.

> **Tô sáng theo đoạn chữ được chọn (từ v0.2.71, phím `B`):** chọn công cụ **Tô sáng theo chữ** rồi
> **bôi đen bằng chuột** đúng như trong Word. Thả ra là vệt vàng bám **sát từng dòng chữ**, kể cả khi
> đoạn chọn bắt đầu và kết thúc giữa dòng — khác với **Tô sáng** (`H`) là kéo một ô chữ nhật áng chừng.
> - Chỉ dùng được trên **trang có chữ thật** (PDF xuất từ Word/CAD, hoặc bản scan đã OCR). Trang ảnh
>   thuần thì không có chữ để chọn — dùng **Tô sáng** (`H`) kéo theo vùng như cũ.
> - Đoạn chọn vắt qua **hai trang** thành **hai vệt**, mỗi trang một; một `Ctrl+Z` gỡ cả hai.
> - **Trong lúc dùng công cụ này không chọn/kéo được vật thể khác** — chuột đang thuộc về lớp chữ.
>   Chuyển về **Chọn** (`V`) để sửa hay xoá vệt đã tô.
> - Vệt tô **đi theo file**: Áp dụng → Lưu → mở lại vẫn chọn và xoá được, và Foxit/Acrobat liệt kê nó
>   trong danh sách chú thích kèm đoạn chữ đã tô.
> - **Sửa kèm ở bản này:** vệt tô sáng sau khi Áp dụng từng **làm chữ bên dưới bạc đi** trong file đã
>   lưu (trên màn hình thì không) — nay hai nơi giống hệt nhau. Áp cho **cả hai** kiểu tô sáng.

> **Hình tự do — đa giác nhiều cạnh (từ v0.2.71, phím `P`):** cho những thứ chữ nhật và elip không ôm
> được — một khu đất, một mảng trần, một đoạn ống đi chéo.
> - **Bấm từng điểm** để đặt đỉnh, hoặc **giữ chuột kéo** để vẽ tự do.
> - **Đóng kín:** bấm vào **điểm đầu**, `Enter`, hoặc **bấm đúp**. **Chỉ hình đóng kín mới tô được nền.**
> - **Để hở:** `Esc` — ra một đường gấp khúc nhiều đoạn, chỉ có nét.
> - Màu, **Nét** (độ dày), **Nền / Không nền / Mờ nền**, copy–dán (kể cả sang tab hay file khác) dùng
>   chung luật với khung chữ nhật. Lưu xong mở lại **sửa tiếp được**; nét lưu dạng vector nên phóng to
>   hay in ra vẫn sắc.

> **Kéo giãn và sửa đỉnh cho nét vẽ tay / mây tự do / hình tự do (từ v0.2.71):** chọn hình bằng công cụ
> **Chọn** (`V`) → hiện **4 nút vuông ở góc**. Kéo một góc để phóng to / thu nhỏ **toàn bộ hình**, góc
> đối diện **đứng yên**; giữ `Shift` để giữ tỷ lệ. Trước bản này ba loại đó vẽ xong là cố định cỡ.
> - **Độ dày nét không mảnh đi theo** khi thu nhỏ — nét là thuộc tính của bút, không phải của hình, nên
>   ghi chú thu nhỏ vẫn đủ đậm để nhìn và để in. Cỡ vỏ sò của mây cũng giữ nguyên.
> - **Mây tự do và hình tự do** còn hiện **một chấm tròn ở mỗi đỉnh**: kéo chấm để nắn lại **đúng một góc**.
>   **Nét vẽ tay không có** — điểm của nó là vết chuột chứ không phải góc ai đặt ra, và chúng được thưa
>   hoá khi lưu nên đỉnh vừa kéo chưa chắc sống sót qua một vòng lưu.

> **Màu mặc định của chú thích là ĐỎ (từ v0.2.60; từ v0.2.73 là đỏ tươi RGB 233, 0, 0 = `#e90000`):**
> hộp văn bản, mũi tên, khoanh mây, chữ nhật, tròn, hình tự do, vẽ tay, ghi chú và đoạn đo đều lấy màu
> này cho vật thể **mới**. Đổi ở **Cài đặt → Màu chú thích mặc định** — app nhớ lựa chọn cho các lần sau
> (máy nào đã tự chọn màu từ trước thì vẫn giữ màu đã chọn).
> - Trước v0.2.60 màu này là **vàng**, mà chữ vàng trên giấy trắng gần như không đọc được — đó là lý do
>   đổi sang đỏ.
> - **Nét mặc định là 1 pt (từ v0.2.73, trước là 2)** cho mọi công cụ có ô **Nét**: vẽ tay, chữ nhật,
>   tròn, mây, hình tự do, mũi tên, đo, dấu ✓ ✗. Đổi ở **Cài đặt → Nét mặc định** (1–24) — app nhớ cho
>   các lần sau. Ô **Nét** trên thanh chú thích chỉ đổi cho phiên đang làm, **không** ghi vào Cài đặt.
> - **Bốn thứ giữ màu riêng** vì màu của chúng có nghĩa: dấu **✓ xanh** (đúng), dấu **✗ đỏ** (sai),
>   **Tô sáng vàng** (bút highlight), **Màu che đen**. Đổi màu mặc định **không** đụng tới chúng.
> - Đổi màu ở Cài đặt chỉ áp cho vật thể **vẽ tiếp sau đó** — **vật thể đã vẽ không tự đổi màu**. Muốn
>   đổi cái đã vẽ thì chọn nó rồi dùng ô **Màu** trên thanh chú thích (ô đó **không** ghi vào Cài đặt).
> - File đã lưu từ bản cũ mở lại vẫn **giữ nguyên màu cũ** của nó.

> **Dấu ✓ và ✗:** hai công cụ riêng trên thanh chú thích (phím `K` cho ✓, `J` cho ✗) — chỉ là **ký hiệu**,
> không kèm ô vuông, nên tích thẳng vào ô checkbox có sẵn trong hợp đồng được.
> - **Bấm một cái** → ra dấu **cỡ mặc định** ngay tại chỗ bấm (bấm sát mép trang thì dấu tự lùi vào cho
>   nằm trọn trong trang). **Kéo** → tự chọn cỡ.
> - Đổi **Màu** và **Nét** (độ dày) như các công cụ vẽ khác. Mỗi loại **nhớ màu riêng** — mặc định ✓ xanh
>   lá, ✗ đỏ — nên đổi màu dấu ✗ không làm đổi màu bút tô sáng hay vẽ tay.
> - Đã đặt rồi vẫn **chọn / kéo di chuyển / kéo 4 góc đổi cỡ** được (giữ Shift để giữ đúng tỷ lệ), và
>   **Ctrl+Z** hoàn tác được.
> - **Copy sang file khác (từ v0.2.69):** đánh dấu một lần cho vừa cỡ, vừa màu, rồi **Ctrl+C** /
>   **Ctrl+V** sang trang khác, **tab khác** hoặc **file PDF khác** — y như hộp văn bản. Tiện khi phải
>   tick cùng một ô trên hàng chục bộ hồ sơ.
> - **Từ v0.2.73, dấu ✓/✗ là đối tượng sống:** bấm **Xong** / **Lưu** rồi mở lại file → bấm **Chú thích**
>   là chúng lại chọn được — kéo, đổi cỡ, đổi màu / nét, `Delete`, và **Ctrl+C / Ctrl+V** (kể cả sang
>   file khác). Trước v0.2.73 chúng bị **dán chết** vào trang khi bấm Xong nên chỉ copy được lúc còn
>   trong Chú thích; file lưu bằng bản cũ vẫn giữ dấu dán chết đó (không tự "sống lại").

> **Chọn nhiều mục & sao chép sang trang khác (từ v0.2.52):** dưới công cụ **Chọn**:
> - **Giữ Ctrl bấm** để thêm/bớt mục vào vùng chọn (bấm lại lần nữa là bỏ mục đó ra). Chọn nhiều
>   mục thì **kéo một mục là cả nhóm đi theo**, đổi **Màu** hoặc **Nét** áp cho cả nhóm, và **Delete**
>   xoá cả nhóm bằng **một** bước hoàn tác. (Tay nắm đổi cỡ chỉ hiện khi chọn **một** mục — muốn đổi
>   cỡ một mục trong nhóm thì bấm riêng nó trước.)
> - **Ctrl+C** để sao chép, sang trang khác rồi **Ctrl+V** để dán — hoặc **bấm chuột phải** lên mục
>   để có menu **Sao chép / Dán vào trang này / Xoá mục**. Dán sang trang khác thì mục nằm **đúng vị
>   trí cũ** (tiện để lặp lại một khoanh mây hay một hộp chữ ở cùng chỗ trên nhiều trang); dán lại
>   trên **cùng** trang thì mỗi bản lệch xuống một chút cho khỏi đè nhau. Dán vào trang **nhỏ hơn**
>   thì cả nhóm tự lùi vào trong trang, **không** bị rời ra.
> - **Sang hẳn file PDF khác (từ v0.2.67; thêm dấu ✓/✗ từ v0.2.69):** copy ở file này rồi **Ctrl+V** ở **tab khác** hoặc
>   **cửa sổ khác** — kể cả tab bạn mới mở **sau** khi đã copy. Bản dán giữ nguyên vị trí, cỡ chữ,
>   phông, màu và nền; dán vào file có khổ giấy nhỏ hơn thì cả nhóm tự lùi vào trong tờ. Tab đích
>   chưa bật **Chỉnh sửa** thì app tự bật giúp.
> - **Ảnh cũng sang được file khác (từ v0.2.72)** — kể cả ảnh bạn vừa dán vào từ ảnh chụp màn hình —
>   đúng cỡ và đúng chỗ bạn đã chỉnh. Trước bản này ảnh chỉ dán được trong cùng một tab.
> - **Lần copy gần nhất luôn thắng (từ v0.2.72).** Trước đây, nếu clipboard Windows còn giữ một ảnh chụp
>   (chẳng hạn chính ảnh bạn vừa dán vào trang), thì **Ctrl+V** sau khi copy một mục lại dán **ảnh chụp
>   cũ ở cỡ mặc định** thay vì mục vừa copy. Nay copy một mục trong Nabu là **thay** nội dung clipboard
>   Windows (như lệnh Copy ở mọi phần mềm), nên Ctrl+V dán đúng mục đó; còn nếu **sau đó** bạn copy một
>   ảnh ở phần mềm khác thì Ctrl+V dán ảnh mới. Vì vậy copy một mục trong Nabu rồi sang Word dán sẽ
>   không ra gì — đó là đúng như thiết kế.
> - Vệt tô sáng / gạch chân / gạch ngang, ô che và đoạn đo vẫn chỉ dán được **trong cùng file** (chúng
>   bám vào chữ hoặc nội dung của chính file đó) — copy một nhóm có lẫn chúng thì app báo rõ bao nhiêu
>   mục ở lại.
> - **Clipboard không mất khi bấm "Áp dụng"**: sao chép → Áp dụng → vẫn dán được. Lưu ý ngược lại:
>   sau khi Áp dụng thì **tô sáng theo vùng, ô che và đoạn đo đã dán chết** thành hình trên trang nên
>   **không chọn lại được để copy** — hãy **copy trước khi Áp dụng**. Hộp văn bản, ghi chú, mũi tên,
>   ảnh, **chữ nhật, elip, khoanh mây, nét vẽ tay** (từ v0.2.61/v0.2.63) và **dấu ✓/✗** (từ v0.2.73) thì
>   vẫn là đối tượng sống nên copy được cả sau khi Lưu và mở lại.
> - Nếu clipboard hệ điều hành đang có **ảnh** (copy từ app khác) thì Ctrl+V vẫn là **dán ảnh vào
>   trang** như trước — hai đường không lẫn nhau.

> **Nền cho hộp văn bản (từ v0.2.64):** hộp văn bản vốn **trong suốt**, nên đặt lên ảnh scan hay bản
> vẽ nhiều nét thì chữ lẫn vào hình. Chọn công cụ **Hộp văn bản** (hoặc chọn một hộp đã có) → trên
> thanh chú thích bỏ tick **Không nền**, chọn **Nền** và kéo **Mờ nền**:
> - **100%** = che kín phần dưới; khoảng **70–85%** = vẫn thấy mờ mờ nội dung bên dưới, đủ để chữ nổi lên.
> - Nền **ôm sát chữ**, **quay theo** khi bạn xoay hộp, và **đi theo file** — mở lại vẫn sửa được.
> - **Hộp văn bản và hình khoanh vùng nhớ riêng hai bộ màu nền**, nên đặt nền trắng cho chữ không làm
>   khung chữ nhật bạn vẽ sau đó cũng trắng.
> - **Đổi nền ngay trong lúc đang gõ.** Bấm lên trang, gõ chữ, rồi vẫn kéo được **Nền** / **Mờ nền** —
>   khung đang gõ đổi màu theo từng bước, và hộp gõ **không bị đóng**. Thả chuột là con trỏ về đúng chỗ
>   bạn đang gõ. Cỡ chữ, phông, **B** / *I* / U và canh lề cũng vậy.
> - **Ô vuông nhỏ cạnh thanh Mờ nền** là bản xem trước thật: nó đặt màu bạn chọn ở đúng độ mờ bạn đặt
>   lên một ô kẻ caro, nên **trắng 30% trông ra trắng 30%** chứ không giống trắng đặc — thứ mà ô chọn
>   màu không nói được (ô đó chỉ hiện màu, không hiện độ mờ). Thấy ô caro = đang **Không nền**.
> - **Ô “Không nền” là công tắc tắt/bật, không phải một mức của Mờ nền.** Tick là tắt hẳn lớp nền;
>   bỏ tick là bật lại **đúng màu và đúng độ mờ đang hiện trên thanh**, nên dùng nó để thử có/không
>   nền mà không mất giá trị đã chọn. Kéo **Mờ nền** về 0% cũng là tắt nền, và ô **Không nền** tự
>   tick theo. (Ô này ở các bản trước ghi là *Trong suốt*.)

> 🔁 **Thay trang bằng trang của PDF khác (từ v0.2.72):** chuột phải một trang trong **cột trang** →
> **Thay trang này bằng PDF khác…** → chọn file → chọn:
> - **Tất cả N trang** của file đó, hoặc
> - **Chỉ các trang được chọn** — gõ khoảng trang như `1-3, 5` (bấm vào ô là tự chọn mục này).
>
> Dòng tóm tắt cho biết **trước** sẽ thay bằng những trang nào và tài liệu còn bao nhiêu trang. Bấm
> **Thay trang** → trang cũ biến mất, các trang mới nằm **đúng vị trí đó**, theo thứ tự tăng dần.
> - Muốn thay **nhiều trang một lúc**: tick chọn các trang **liền nhau** (vd 3–5) rồi chuột phải. Chọn
>   các trang **rời nhau** (vd 2 và 5) thì lệnh này mờ đi — vì không rõ trang mới nên nằm ở đâu.
> - `Ctrl+Z` trả lại nguyên bản. Cũng có trong nút **Trang ▾** và menu **Trang**.
> - Trang mới giữ nguyên **khổ giấy và chiều xoay** của file nguồn.
> - File nguồn có mật khẩu → mở nó, bỏ mật khẩu trước. Thay một **trang đang ẩn** (🔒) thì app hỏi lại,
>   vì nội dung đã ẩn sẽ mất cùng trang đó.

> 🔒 **Ẩn trang bằng mật khẩu (từ v0.2.64):** chuột phải một trang trong **cột trang** →
> **Ẩn trang này bằng mật khẩu…** (chọn nhiều trang trước thì ẩn cả loạt bằng một mật khẩu).
> - Nội dung trang được **mã hoá AES-256** và thay bằng một **trang giữ chỗ** in dòng "🔒 TRANG ĐÃ ẨN".
>   Thumbnail của nó mang dấu 🔒, và thanh trạng thái dưới cùng đếm "🔒 N trang đang ẩn".
> - **Mở lại:** chuột phải trang có 🔒 → **Bỏ ẩn trang…** → nhập mật khẩu. Trang gốc quay lại **đúng
>   vị trí cũ**, nguyên vẹn cả chú thích lẫn chiều xoay.
> - **Số trang không đổi.** Ẩn trang 7 của 12 thì tài liệu vẫn 12 trang và trang 7 vẫn là trang 7 — mục
>   lục, tham chiếu chéo và số trang đã đánh không lệch. Trang ẩn cũng **đi theo trang của nó** khi bạn
>   sắp xếp lại, ghép thêm file, tách file hay chuyển trang sang tài liệu khác.
> - **Gửi ra ngoài:** chuột phải → **Xuất bản sao KHÔNG kèm trang ẩn…** — bản sao bỏ hẳn những trang
>   đó, kể cả phần đã mã hoá; file đang mở không đổi.
> - ⚠️ **Phải biết trước khi dùng:**
>   - **Mất mật khẩu là mất trang.** Không có đường khôi phục, kể cả với nhà phát triển.
>   - **Chỉ Nabu PDF mở lại được.** Phần mềm khác (Acrobat, Foxit, Chrome…) chỉ thấy trang giữ chỗ.
>   - **File không nhỏ đi** — bản mã hoá của trang vẫn nằm trong đó.
>   - **Ẩn xong `Ctrl+Z` không hoàn tác được.** Đó là chủ ý: lịch sử hoàn tác và file tự-lưu-phục-hồi
>     đều giữ một bản **trước khi ẩn**, để nguyên thì bản gốc của trang vừa ẩn vẫn nằm đó. Nabu xoá cả
>     hai ngay sau khi ẩn. Muốn trang trở lại, dùng chính mật khẩu vừa đặt.

> **Ghi chú dạng chuỗi (thêm bình luận vào ghi chú):** bấm đúp một ghi chú 💬 để mở bảng — phần trên là
> nội dung gốc + các bình luận đã có (chỉ đọc), ô dưới để **Thêm bình luận** (không xoá nội dung cũ). Nút
> **Sửa gốc** để chỉnh nội dung gốc. Marker hiện **số bình luận**. Khi Lưu, cả chuỗi được gộp vào ghi chú
> của PDF (mọi trình xem đọc được).

> **So sánh & Chồng lớp 2 bản vẽ:** nút **So sánh** → chọn 2 file → chế độ:
> - **Bản vẽ**: đặt cạnh nhau, khoanh vùng thêm/xoá/sửa (xuất được bản đánh dấu).
>   Danh sách thay đổi bên trái có **ô tick từng vùng** (mặc định **chọn tất**) — bỏ tick vùng nào thì
>   vùng đó **mờ đi trên cả 2 bản** và **không được khoanh mây** khi xuất bản B. Nút xuất hiện số đã chọn.
> - **Chồng lớp**: xếp 2 bản vẽ lên nhau, tự căn chỉnh + **tô màu khác biệt** (đỏ = chỉ có ở bản A,
>   xanh = chỉ có ở bản B, đen = trùng). Chỉnh **độ mờ** lớp trên, **nudge** (phím mũi tên) để căn tay,
>   PageUp/PageDown đổi cặp trang. Dùng để soi thay đổi giữa 2 phiên bản bản vẽ.

### 5.1. Ký số (chữ ký số pháp lý, USB token)

Nút **Ký số** ở cuối thanh công cụ. Ký PKI bằng chứng thư số trên **USB token** — VNPT-CA,
Viettel-CA, FPT-CA, BKAV… — đọc qua kho chứng thư của Windows, giống cách Foxit/Acrobat làm.
Khác hẳn "Chèn ảnh / chữ ký" ở trên: cái đó là **hình ảnh**, cái này là **niêm phong mã hoá** —
người nhận mở bằng Foxit/Acrobat sẽ thấy chữ ký được xác thực và biết file có bị sửa sau khi ký không.

1. **Cắm token trước khi ký**, rồi bấm **Ký số**. Ô **Chứng thư số** tự liệt kê chứng thư tìm được
   (cắm token muộn thì bấm **Làm mới** để quét lại).
2. Điền **Lý do ký** / **Nơi ký** nếu cần, chọn thêm **Ảnh chữ ký / con dấu** (tuỳ chọn) để chữ ký
   nhìn thấy có hình con dấu.
3. **Dấu thời gian (TSA)** — tuỳ chọn, dán URL dịch vụ TSA của nhà cung cấp chữ ký số của bạn. Nó
   chứng minh **thời điểm** ký nên tăng giá trị pháp lý; để trống nếu bạn chưa có (đây là ô **duy
   nhất** trong luồng ký cần mạng).
4. Bấm **Tiếp: kéo khung trên trang** → kéo một khung ở chỗ muốn hiện chữ ký. Bỏ tick *"Hiển thị chữ
   ký trên trang"* nếu chỉ cần ký ngầm, không hiện gì trên giấy.
5. **Token tự hỏi mã PIN của nó** — Nabu không bao giờ thấy mã PIN, và **khoá bí mật không rời
   token**. Xong, app hỏi nơi lưu và ghi ra **một file MỚI**.

> 🔴 **Ký số là bước CUỐI CÙNG.** Ký xong rồi mà còn chỉnh sửa và lưu đè lên file đã ký thì **chữ ký
> mất hiệu lực** — chữ ký số niêm phong đúng chuỗi byte tại thời điểm ký, đổi một byte là niêm phong
> vỡ. Vậy nên: làm xong mọi việc (chú thích, sửa chữ, ghép/tách trang, đóng dấu ảnh, đánh số trang…)
> **trước**, ký sau cùng. Cần sửa thì sửa trên **bản chưa ký** rồi ký lại, đừng sửa bản đã ký. App
> cũng nhắc đúng điều này ngay sau khi ký xong.

---

## 6. Tính năng "Bóc tách" (OCR + AI) — nhập API key trong app

"Bóc tách" tự đọc hợp đồng và rút các trường (số HĐ, ngày, bên A/B…) bằng AI Google Gemini, nên cần
**API key**. Đây là tính năng **duy nhất** gửi nội dung lên dịch vụ ngoài.

Nhập key **ngay trong app**, không cần đụng tới file hay biến môi trường:

1. Mở app → bấm nút **⚙** (góc phải, cạnh badge OCR).
2. **Dán** API key vào ô → bấm **Lưu**.
3. Xong. Key được lưu an toàn trên máy này (`%LOCALAPPDATA%\Nabu PDF\settings.json`), **lần sau
   không phải nhập lại**. Đổi key thì mở lại ⚙ và dán key mới.

> Chưa có key? Lấy miễn phí tại **aistudio.google.com/apikey**.
> Không nhập key thì các tính năng PDF + OCR + Searchable vẫn chạy bình thường; chỉ "Bóc tách" mới cần.

---

## 7. Khắc phục sự cố thường gặp

| Hiện tượng | Cách xử lý |
|-----------|-----------|
| Badge kẹt ở "OCR: …" mãi không sẵn sàng | Bình thường chỉ 1–2 giây. Kẹt lâu → máy thiếu RAM, hoặc phần mềm diệt virus đang quét engine lần đầu. Thử ⚙ → Khởi động lại engine. |
| "OCR: lỗi" | Thường do thiếu RAM, hoặc engine bị diệt virus chặn. Đóng bớt ứng dụng rồi mở lại app. Không liên quan đến mạng — OCR chạy offline. |
| SmartScreen chặn | More info → Run anyway (mục 3.1). |
| Bóc tách báo thiếu key | Bấm ⚙ → dán API key → Lưu (mục 6). |
| App mở chậm lần đầu | Bình thường — Windows/diệt virus quét file lần đầu. Lần sau nhanh hơn. |
| Máy yếu, OCR chậm | Engine chạy trên CPU. Đo trên một hợp đồng scan A4 thật: **khoảng 7–27 giây mỗi trang**, tuỳ trang có bao nhiêu dòng chữ — một bộ 78 trang mất cỡ **20–25 phút**. Đó là bình thường, không phải treo. Các thao tác PDF thường (xem/ghép/sửa chữ) vẫn nhanh và **dùng được song song** ở thẻ khác. |
| Nén file lớn chạy lâu | Bình thường. Hộp thoại **Nén** hiện **ước tính thời gian** ngay khi mở — thời gian phụ thuộc **dung lượng file**, gần như không phụ thuộc số trang. Trong lúc nén **không dừng lại được**, nhưng **các thẻ khác vẫn dùng được bình thường**. |
| Nén file rất lớn thì máy ì | Lúc nén, file được giữ đồng thời ở vài nơi nên cần khoảng **gấp 4 lần dung lượng file** bộ nhớ trống. Từ ~**300MB** app sẽ hỏi lại trước khi chạy. Nếu máy 8GB RAM: nên dừng ở khoảng 300–400MB. |

---

## 8. Yêu cầu máy đích

- Windows 10/11 **64-bit**.
- ~2 GB trống cho app + ~1 GB cho cache model (lần đầu OCR).
- Khuyến nghị ≥ 8 GB RAM để OCR mượt.
- **Tài liệu lớn:** app nhận file tới ~1GB, nhưng đó là giới hạn của định dạng chứ không
  phải của máy. Cần khoảng **gấp 4 lần dung lượng file** RAM trống khi **Nén**. Thực tế:
  máy **8 GB** thoải mái tới ~300–400MB; máy **16 GB trở lên** xử lý được file lớn hơn
  nhiều. Việc **tìm** chữ nhẹ hơn nhiều so với **nén** hay **thay** chữ.
- Internet cho **lần đầu** dùng OCR (và mỗi lần dùng "Bóc tách").

---

*Phiên bản: 0.2.57 · Installer (NSIS, tự cập nhật) cho Windows x64.*
