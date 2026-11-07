# ⚡ Cloud Drive Copier (Sao chép Google Drive Chạy Ngầm 24/7)

Ứng dụng web giúp bạn sao chép toàn bộ thư mục và tập tin từ một liên kết Google Drive được chia sẻ (kể cả link của người khác) sang trực tiếp Google Drive cá nhân của bạn.

> 🌟 **Đặc điểm nổi bật quan trọng nhất:**
> - **Tắt máy tính / đóng trình duyệt vẫn tự động chạy:** Vì quá trình sao chép diễn ra trực tiếp qua Google Drive API hoặc trên máy chủ Cloud, bạn chỉ cần bấm "Bắt đầu" rồi có thể tắt máy tính đi ngủ!
> - **Server-side Copy (Không tốn băng thông):** Google tự nhân bản file trực tiếp giữa các máy chủ của Google, không cần tải về máy tính rồi upload lại, tốc độ cực nhanh.
> - **Giữ nguyên cấu trúc thư mục:** Duyệt đệ quy tất cả các thư mục con và tạo chính xác cấu trúc trên Drive đích.
> - **Theo dõi tiến trình thời gian thực:** Giao diện hiển thị số files đã copy, dung lượng, lỗi và nhật ký chi tiết (realtime console).

---

## 🚀 Hai giải pháp sao chép (Chọn 1 trong 2):

### 🌟 Giải pháp 1: Chạy trực tiếp trên Google Apps Script (Đơn giản nhất, 100% Google Cloud, Không cần cài đặt)

Giải pháp này hoàn toàn miễn phí, không cần mua server, không cần cấu hình OAuth API:

1. Mở trình duyệt và truy cập [Google Apps Script](https://script.google.com).
2. Nhấn nút **New project** (Dự án mới).
3. Đổi tên dự án thành `Drive Cloud Copier`.
4. Mở file [Code.gs](./google-apps-script/Code.gs), copy toàn bộ nội dung và dán thay thế vào file `Code.gs` trên màn hình soạn thảo.
5. Bên trái, nhấn dấu `+` cạnh mục **Files** > Chọn **HTML** > Đặt tên là `Index`.
6. Mở file [Index.html](./google-apps-script/Index.html), copy toàn bộ nội dung và dán vào file `Index.html` trên Google Apps Script.
7. Nhấn nút **Deploy** (ở góc trên bên phải) > Chọn **New deployment**.
8. Nhấn biểu tượng bánh răng ⚙️ cạnh "Select type" > Chọn **Web app**.
   - **Description**: `Drive Copier`
   - **Execute as**: `Me (email của bạn)`
   - **Who has access**: `Anyone` (hoặc `Only myself`)
9. Nhấn **Deploy** > Chọn **Authorize access** để cấp quyền truy cập Drive cho chính tài khoản của bạn.
10. Bạn sẽ nhận được 1 đường link Web App (dạng `https://script.google.com/macros/s/.../exec`). 
    👉 Mở đường link đó, bấm **"Bắt đầu Sao chép"** rồi **tắt máy tính đi ngủ**, Google sẽ tự động sao chép toàn bộ!

---

### 💻 Giải pháp 2: Chạy Web App Fullstack (Node.js + Dashboard Chuyên Nghiệp)

#### 1. Khởi chạy thử nghiệm trên máy cục bộ (Localhost):

```bash
# Cài đặt thư viện (nếu chưa cài)
npm install

# Khởi động server
node server.js
```
Truy cập: `http://localhost:3000`

#### 2. Cấu hình Google Drive OAuth (chỉ cần làm 1 lần):
- Vào giao diện web `http://localhost:3000`, bấm nút **"⚙️ Cấu hình API"**.
- Tạo OAuth Client ID trên [Google Cloud Console](https://console.cloud.google.com/apis/credentials) với redirect URI: `http://localhost:3000/api/auth/google/callback` (hoặc URL cloud của bạn).
- Bấm **"Đăng nhập Google"** để cấp quyền.
- Link thư mục nguồn `https://drive.google.com/drive/u/0/folders/1eEWmqXZZmDXx4QsmsTsnjkgUMp7pe6EH` đã được điền sẵn, chỉ cần bấm **🚀 Bắt đầu Sao Chép Ngay**.

#### 3. Triển khai lên Cloud Miễn Phí (Để tắt máy vẫn chạy 24/7):
Bạn có thể deploy ứng dụng này lên **Render.com** hoặc **Railway.app** hoàn toàn miễn phí:
1. Đẩy mã nguồn thư mục này lên một repository GitHub cá nhân.
2. Đăng ký tài khoản tại [Render.com](https://render.com).
3. Bấm **New** > **Web Service** > Chọn repo GitHub vừa tạo.
4. Render sẽ tự động nhận diện file `render.yaml` và `Dockerfile` để build.
5. Cập nhật redirect URI trong Google Cloud Console theo domain Render (ví dụ: `https://ten-app-cua-ban.onrender.com/api/auth/google/callback`).
6. Giờ đây bạn có một trang web riêng trên internet, có thể truy cập bằng điện thoại hoặc máy tính bất kỳ lúc nào để bắt đầu copy và theo dõi tiến trình!

---

## 📁 Cấu trúc thư mục

```text
copy drive to drive/
├── data/                      # Lưu trữ config và tiến trình job (tự sinh)
├── google-apps-script/        # Mã nguồn chạy 100% trên Google Cloud Apps Script
│   ├── Code.gs                # Xử lý đệ quy copy trên cloud Google
│   └── Index.html             # Giao diện web app gọn nhẹ
├── public/                    # Giao diện Web App chuyên nghiệp
│   ├── index.html             # HTML dashboard
│   ├── style.css              # Giao diện hiện đại
│   └── app.js                 # Xử lý tương tác, realtime log & SSE
├── Dockerfile                 # Docker container cho Cloud deploy
├── render.yaml                # Cấu hình 1-click deploy Render
├── server.js                  # Node.js Express server + Drive API v3
├── package.json
└── README.md
```
