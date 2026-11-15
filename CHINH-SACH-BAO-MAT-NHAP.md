# Chính sách bảo mật thông tin

Áp dụng cho phần mềm quản trị nội bộ của Lodeza EOP. Phiên bản 1.0, hiệu lực từ 01/11/2026.

Trang này cho biết phần mềm lưu những dữ liệu nào về bạn, dùng vào việc gì, ai xem được và bạn có những quyền gì. Căn cứ: Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.

## 1. Dữ liệu phần mềm lưu về bạn

| Nhóm dữ liệu | Gồm những gì | Dùng để |
|---|---|---|
| Hồ sơ nhân sự | Họ tên, email, chức danh, phòng ban, ngày vào làm, ngày sinh, ảnh đại diện | Quản lý nhân sự, hiển thị danh bạ, chúc mừng sinh nhật |
| Hợp đồng và lương | Loại và thời hạn hợp đồng, mức lương, phụ cấp | Tính lương, làm chế độ |
| Chấm công | Giờ vào, giờ ra, vị trí GPS tại thời điểm bạn bấm chấm công, đơn nghỉ phép, đơn giải trình | Tính ngày công, quản lý nghỉ phép |
| Công việc và đề nghị | Việc được giao, ý kiến trao đổi, phiếu trình ký, đề nghị thanh toán, đăng ký xe và phòng họp | Điều phối và phê duyệt công việc |
| Cuộc họp | Bản ghi âm, văn bản chuyển từ giọng nói, biên bản, mẫu giọng nếu bạn tự tải lên | Lập biên bản và phân công sau họp |
| Hồ sơ ứng viên | CV và kết quả phỏng vấn của người ứng tuyển | Tuyển dụng |
| Nhật ký sử dụng | Thời điểm bạn đăng nhập và các trang bạn mở | Đo mức độ sử dụng phần mềm, tìm và sửa lỗi |

## 2. Ai xem được dữ liệu của bạn

- Lương và hợp đồng: chỉ Quản trị hệ thống, Trưởng phòng Hành chính Nhân sự và nhân viên C&B. Bạn cũng không xem được lương của chính mình trên phần mềm, ngoại trừ ô loại hợp đồng.
- Biên bản và bản ghi âm cuộc họp: chỉ chủ tài khoản đã tạo và Quản trị hệ thống. Mẫu giọng dùng chung để nhận diện người nói thì mọi tài khoản đều đọc được.
- Phiếu trình ký, đề nghị thanh toán: người tạo, người nằm trong luồng duyệt và bộ phận xử lý. Nhân viên phòng khác chỉ thấy phiếu do chính mình tạo.
- Chấm công và đơn nghỉ: bạn, quản lý trực tiếp và bộ phận Hành chính Nhân sự. Người được cấp quyền xem giải trình công thì xem được toàn công ty.
- Hồ sơ ứng viên: bộ phận tuyển dụng được cấp quyền.
- Nhật ký sử dụng: chỉ Quản trị hệ thống.

Quyền xem được cấp theo phòng ban và theo từng người. Việc cấp thêm quyền do Quản trị hệ thống thực hiện.

## 3. Dữ liệu nhạy cảm: vị trí GPS và mẫu giọng

**Vị trí GPS.** Phần mềm ghi vị trí để xác nhận đúng vị trí nhân sự đang làm việc. Phần mềm chỉ ghi vào đúng lúc bạn bấm chấm công, không theo dõi vị trí liên tục.

**Mẫu giọng.** Việc tải mẫu giọng lên là không bắt buộc. Mẫu giọng chỉ giúp AI xác định người nói trong cuộc họp để trích xuất nội dung đúng người. Bạn không tải lên thì vẫn dùng phần mềm bình thường, và có thể xoá mẫu giọng bất cứ lúc nào.

## 4. Dùng trí tuệ nhân tạo

Một số chức năng gửi nội dung sang dịch vụ của OpenAI để xử lý: chuyển giọng nói thành văn bản, tóm tắt và phân công từ cuộc họp, chấm điểm CV, đọc hồ sơ thanh toán, tìm kiếm bằng AI. Nội dung gửi đi chỉ gồm phần cần cho tác vụ đó.

Tìm kiếm bằng AI chỉ dành cho Quản trị hệ thống và Ban lãnh đạo. Công cụ này không trả về dữ liệu lương và hợp đồng cho người không có quyền.

Kết quả của AI chỉ để tham khảo. Quyết định về nhân sự và tài chính do người có thẩm quyền đưa ra.

## 5. Nơi lưu và bên xử lý dữ liệu

- Cơ sở dữ liệu và tệp đính kèm: Supabase.
- Máy chủ chạy ứng dụng: Vercel.
- Email thông báo: tài khoản email hệ thống của công ty.
- Đăng nhập: bằng tài khoản Google cá nhân. Phần mềm không lưu mật khẩu của bạn.

Máy chủ của Supabase, Vercel và OpenAI đặt ngoài lãnh thổ Việt Nam, nên dữ liệu của bạn được lưu và xử lý ở nước ngoài. Phần mềm do công ty tự xây dựng để dùng nội bộ, không kinh doanh. Dữ liệu không được bán hoặc chia sẻ cho bên ngoài vì mục đích thương mại.

## 6. Thời gian lưu

- Bản ghi âm cuộc họp: 30 ngày kể từ ngày ghi âm.
- Hồ sơ ứng viên không trúng tuyển: 12 tháng.
- Hồ sơ nhân sự, hợp đồng, lương và chấm công: trong thời gian bạn làm việc và thêm thời hạn pháp luật yêu cầu.

## 7. Quyền của bạn

Bạn có quyền:
- Biết dữ liệu nào của mình đang được lưu.
- Yêu cầu sửa dữ liệu sai.
- Yêu cầu xoá dữ liệu không còn cần thiết. Dữ liệu mà pháp luật bắt buộc phải lưu thì công ty chưa xoá được.
- Rút lại sự đồng ý đối với dữ liệu xử lý dựa trên đồng ý của bạn, như ảnh đại diện và mẫu giọng.
- Khiếu nại nếu cho rằng dữ liệu bị dùng sai mục đích.

Bạn gửi yêu cầu cho Phòng Hành chính Nhân sự, phòng sẽ trả lời các thông tin cần thiết.

## 8. Trách nhiệm của người dùng

- Chỉ đăng nhập bằng tài khoản của mình và không cho người khác dùng.
- Không chụp, sao chép hay chuyển dữ liệu của người khác ra ngoài khi không có phần việc liên quan.
- Báo ngay cho Quản trị hệ thống khi thấy tài khoản bị dùng lạ hoặc nhìn thấy dữ liệu không thuộc quyền của mình.

## 9. Sự cố lộ dữ liệu

Khi phát hiện dữ liệu bị lộ hoặc bị truy cập trái phép, công ty xử lý và thông báo cho người bị ảnh hưởng. Với sự cố nghiêm trọng, công ty báo cơ quan có thẩm quyền theo quy định.

## 10. Thay đổi chính sách

Mỗi lần sửa nội dung, công ty đổi số phiên bản và ngày hiệu lực ở đầu trang.
