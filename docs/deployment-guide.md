# Hướng Dẫn Deploy Lên Render

## ⚠️ Cảnh Báo Bảo Mật — ĐỌC TRƯỚC KHI BẮT ĐẦU

App **không có xác thực nào ngoài HTTP Basic Auth** (`proxy.ts`). Điều này có nghĩa:
- Nếu không đặt mật khẩu Basic Auth, **bất cứ ai biết URL đều có thể**:
  - Duyệt và tải toàn bộ thư mục NAS công ty (`/api/webdav/entries`, `/api/webdav/file`)
  - Xem danh sách Facebook token đã lưu trong Redis
  - Xóa token hoặc upload vào tài khoản quảng cáo

- NAS (`nas-api.batmedia.info`) đã **công khai qua Cloudflare** — không che giấu được IP. Bảo vệ CHỈNH là mật khẩu Basic Auth.

- **Basic Auth là MỨC BẢO VỆ TỐI THIỂU**: một mật khẩu dùng chung, không phân quyền, không chống brute-force. Đủ để không phơi NAS ra Internet, **không đủ** nếu cần xác thực cho nhiều người dùng hay audit log.

---

## 1. Chuẩn Bị Trước Deploy

### 1.1 Sinh Các Khóa Bảo Mật

Mở terminal và chạy lệnh này 2 lần để tạo 2 khóa:

```bash
# Khóa mã hoá token Facebook (AES-256-GCM)
openssl rand -base64 32

# Mật khẩu HTTP Basic Auth
openssl rand -base64 24
```

Lưu kết quả vào 1 file tạm (không push lên git).

**⚠️ QUAN TRỌNG:** `TOKEN_ENCRYPTION_KEY` phải **GIỐNG HỆT** trên web và worker. Nếu:
- Web mã hoá token với key A
- Worker giải mã với key B
→ App crash lúc upload, không khôi phục được. Giá trị phải được sinh 1 lần, không bao giờ đổi, nếu đổi → mất tất cả token đã lưu.

### 1.2 Chuẩn Bị Thông Tin WebDAV

Cần 2 thông tin từ admin NAS:
- `WEBDAV_USERNAME` (tên đăng nhập)
- `WEBDAV_PASSWORD` (mật khẩu)

Thông tin này không lưu ở `.env.example` — phải nhập thủ công khi deploy vì nó là credentials của NAS.

### 1.3 Kiểm Tra Git

Push code lên GitHub với branch `main`:

```bash
git push origin main
```

Render sẽ đọc `render.yaml` từ repo này.

---

## 2. Deploy Trên Render Dashboard

### 2.1 Tạo Blueprint

1. Vào [render.com](https://render.com) → login
2. Chọn **New** → **Blueprint**
3. Chọn repository: `dungboss/fb-media-uploader`
4. Chọn branch: `main`
5. Nhấn **Deploy from Blueprint**

Render sẽ đọc `render.yaml` và hiển thị 3 service:
- `fb-media-uploader-web` (web service, gói starter)
- `fb-media-uploader-worker` (worker service, gói starter — không có free)
- `fb-media-uploader-redis` (Key Value, gói starter)

### 2.2 Nhập Biến Môi Trường

Render sẽ hỏi các biến với `sync: false` (không đồng bộ với group). **Phải nhập đúng tên và giá trị**:

| Biến | Giá Trị | Ghi Chú |
|------|---------|--------|
| `TOKEN_ENCRYPTION_KEY` | Kết quả `openssl rand -base64 32` | Sinh 1 lần, không bao giờ đổi |
| `WEBDAV_USERNAME` | Tên đăng nhập NAS | Từ admin |
| `WEBDAV_PASSWORD` | Mật khẩu NAS | Từ admin |
| `BASIC_AUTH_PASSWORD` | Kết quả `openssl rand -base64 24` | Mật khẩu để login vào dashboard |

**Dừng ở đây, đừng nhấn Deploy ngay** — phải kiểm tra Redis config trước.

### 2.3 Kiểm Tra Cấu Hình Redis (CHÍNH XÁC)

Trong Render dashboard, tìm service `fb-media-uploader-redis` → mở settings:

**PHẢI đúng:**
- **Memory Policy**: `noeviction` (**KHÔNG phải** `allkeys-lru`)
  - Nếu chọn `allkeys-lru`: Redis sẽ xóa token Facebook và job đang chờ khi hết bộ nhớ, âm thầm, không cảnh báo.

- **Plan**: `starter` (**KHÔNG phải free**)
  - Free Key Value **không lưu dữ liệu khi restart** (nguyên văn Render: "Data persistence is not available for free Key Value instances")
  - Token Facebook sẽ mất sau mỗi lần restart

- **Region**: `singapore` (phải giống web và worker)

### 2.3b ĐỪNG Tự Sửa `UPLOAD_WORKER_RATE_LIMIT_MAX`

`render.yaml` đặt biến này bằng **`10000`** — nghĩa là *không giới hạn*. Đó là cố ý (burst mode: upload hết tốc lực, để Meta tự báo khi chạm trần bằng 429).

**Đặt bằng `1` là bóp tốc độ xuống 1 ảnh/giây (3600/giờ)** — âm thầm, không lỗi, không cảnh báo. Nó chỉ trông như một dòng cấu hình vô hại.

Đây là bẫy có thật: giá trị `1` là mặc định cũ, đúng hồi app còn giãn cách 15s mỗi ảnh. Khi bỏ throttle, giá trị đó bị bỏ quên trong `.env.example` và suýt được copy thẳng lên Render. Nếu bạn thấy ở đâu đó ghi `UPLOAD_WORKER_RATE_LIMIT_MAX=1`, đó là tàn dư — đừng dùng.

### 2.4 Kiểm Tra Region (CẢ 3 SERVICE)

Mỗi service phải ở region **`singapore`**:

```yaml
fb-media-uploader-web:
  region: singapore

fb-media-uploader-worker:
  region: singapore

fb-media-uploader-redis:
  region: singapore
```

**Tại sao:** Nếu khác region, worker không thể kết nối tới Redis bằng connection string bên trong → chỉ có IP public (chậm + mất lợi thế).

### 2.5 Nhấn Deploy

Sau khi tất cả đều đúng, nhấn **Deploy**. Quá trình mất 5-10 phút.

---

## 3. Sau Khi Deploy Thành Công

### 3.1 Lấy URL Web Service

Render sẽ tạo URL dạng: `https://fb-media-uploader-web-xxxx.onrender.com`

### 3.2 Kiểm Tra Basic Auth Hoạt Động

Mở URL trong curl:

```bash
curl -o /dev/null -w "%{http_code}\n" https://fb-media-uploader-web-xxxx.onrender.com/api/webdav/entries
```

**Kết quả mong muốn: `401`** (cần đăng nhập)

Nếu trả `200`: ⚠️ **NGUY HIỂM** — app không bảo vệ được, phải dừng ngay và kiểm tra `BASIC_AUTH_PASSWORD`.

### 3.3 Đăng Nhập Lần Đầu

Mở `https://fb-media-uploader-web-xxxx.onrender.com` trong trình duyệt → sẽ hỏi:
- **Username**: `admin` (mặc định từ `render.yaml`)
- **Password**: Giá trị của `BASIC_AUTH_PASSWORD` vừa sinh

Sau khi login, trình duyệt sẽ lưu credential → không cần nhập lại.

### 3.4 Nhập Token Facebook

Mở dashboard → mục **Tokens** → nhấn **Add Token** → dán token Facebook.

⚠️ **Điều này phải làm thủ công** — không có migration từ DBngin Redis tới Render.

Chỉnh sửa các token thì chọn một làm mặc định nếu cần.

### 3.5 Kiểm Tra Worker Chạy

Mở dashboard Render, chọn service `fb-media-uploader-worker` → **Logs**:

Nên thấy dòng:
```
[media-upload-worker] listening queue=media-upload concurrency=4
```

Nếu không thấy hay thấy error, worker không chạy → upload bị treo.

---

## 4. Những Cái Bẫy Thường Gặp

### 4.1 "Tất cả trả 503"

**Nguyên nhân:** Thiếu `BASIC_AUTH_PASSWORD` hoặc để trống.

**Lý do:** `proxy.ts` được viết cẩn thận:
- Dev: không yêu cầu password (localhost không cần bảo vệ)
- Production: nếu `NODE_ENV=production` mà không có password → trả 503 cho **mọi request** thay vì phơi NAS

**Fix:**
1. Render dashboard → service web → **Environment** → kiểm tra `BASIC_AUTH_PASSWORD` có giá trị không
2. Nếu trống, thêm giá trị vào
3. Chọn **Trigger Deploy** để restart service

### 4.2 "Worker không chạy, batch đứng ở 'Đang tính ước tính...'"

**Nguyên nhân:** Thường là worker crash lúc khởi động.

**Kiểm tra:**
1. Render dashboard → service worker → **Logs**
2. Nếu thấy error, đọc log để diagnose

**Lỗi phổ biến:** `node: .env: not found`
- Đã sửa trong `package.json` script: `npm run worker:media` dùng `tsx --env-file-if-exists=.env`
- Nếu vẫn gặp, kiểm tra script hoặc push code mới

**Mất Token Sau Mỗi Restart**

**Nguyên nhân:** Redis dùng gói free (không persistence).

**Fix:** Render dashboard → service redis → chuyển sang gói **starter** (có trả phí).

### 4.3 Worker Crash Với "Connection Refused"

**Nguyên nhân:** Redis ở region khác hoặc connection string sai.

**Fix:**
- Kiểm tra `REDIS_URL` tự động do Render inject từ `redis.connectionString`
- Kiểm tra region: web, worker, redis phải cùng `singapore`

---

## 5. Các Lệnh Hữu Ích

### Deploy lại (nếu cần)
```bash
# Trên Render dashboard, service web → Trigger Deploy
# Hoặc push code mới lên main, Render tự động deploy
```

### Kiểm tra logs trực tuyến
```bash
# Render dashboard → chọn service → Logs tab
```

### SSH vào service (nếu cần debug)
```bash
# Render dashboard → service → mục Console
# Hoặc không có — Render không cho SSH trực tiếp
```

---

## 6. Kiến Trúc 3 Service

```
┌─────────────────────────────────────────┐
│ Browser                                 │
│ (Basic Auth login)                      │
└───────────┬─────────────────────────────┘
            │ HTTPS
            ▼
┌─────────────────────────────────────────┐
│ Web Service (Next.js)                   │
│ - Dashboard UI                          │
│ - Token management                      │
│ - Enqueue upload job → Redis            │
│ - Return file list from NAS             │
│ Runtime: Node 22                        │
│ Plan: starter (trả phí)                 │
└───────────┬─────────────────────────────┘
            │
            ├─────────────────────────────┐
            │                             │
            │ REDIS_URL (internal)        │ HTTP (none)
            │                             │
            ▼                             ▼
    ┌───────────────────┐      ┌──────────────────────┐
    │ Redis Key Value   │      │ Worker Service       │
    │ - Job queue       │      │ - Listen queue       │
    │ - Tokens (enc)    │      │ - Call Meta API      │
    │ Plan: starter     │      │ - Update job status  │
    │ MaxMemory: noev   │      │ Plan: starter (paid) │
    └───────────────────┘      │ Runtime: Node 22     │
                               └──────────────────────┘
```

**Luồng dữ liệu:**
1. User upload folder → Web enqueue job → Redis
2. Worker poll queue → lấy job → POST file → Meta → update job status
3. Web poll job status → hiển thị progress

**Tất cả đều bắt đầu với Basic Auth** — nếu login fail, không thể gì cả.

---

## 7. Giá Cả Render

Vì không có giá cụ thể (Render hay đổi), hãy xem [render.com/pricing](https://render.com/pricing).

**Nguyên tắc (theo tài liệu Render, không phải giá):**

| Service | Gói free có không? | Vì sao `render.yaml` chọn `starter` (trả phí) |
|---|---|---|
| Web | **Có** | Gói free **ngủ sau 15 phút** không có traffic, dậy mất ~1 phút. `starter` không ngủ. Đây là service duy nhất bạn *có thể* hạ xuống free nếu chấp nhận chờ. |
| Worker | **Không** | Render chỉ cho free với Web, Static site, Postgres và Key Value. Worker là thứ upload → buộc phải trả phí, không có đường vòng. |
| Key Value (Redis) | **Có, nhưng vô dụng ở đây** | Free **không lưu bền dữ liệu** → mất sạch token Facebook mỗi lần restart. |

Chỉ có Web là hạ được xuống free. Worker thì không có lựa chọn, còn Redis free thì mất token.

---

## 8. Checklist Deploy

- [ ] Sinh `TOKEN_ENCRYPTION_KEY` bằng `openssl rand -base64 32`
- [ ] Sinh `BASIC_AUTH_PASSWORD` bằng `openssl rand -base64 24`
- [ ] Lấy `WEBDAV_USERNAME` và `WEBDAV_PASSWORD` từ admin
- [ ] Push code lên `main` branch
- [ ] Tạo Blueprint trên Render dashboard
- [ ] Nhập đúng 4 biến env: `TOKEN_ENCRYPTION_KEY`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD`, `BASIC_AUTH_PASSWORD`
- [ ] Kiểm tra Redis: `maxmemoryPolicy = noeviction`, `plan = starter`, `region = singapore`
- [ ] Kiểm tra web: `region = singapore`
- [ ] Kiểm tra worker: `region = singapore`
- [ ] Nhấn Deploy, chờ 5-10 phút
- [ ] Test curl: `curl ... /api/webdav/entries` phải trả 401
- [ ] Login vào dashboard (user=admin, password=...)
- [ ] Nhập lại token Facebook
- [ ] Kiểm tra worker log: phải thấy "listening queue=media-upload concurrency=4"

---

## 9. Troubleshooting Nhanh

| Triệu Chứng | Nguyên Nhân | Fix |
|---|---|---|
| Tất cả trả 503 | Thiếu BASIC_AUTH_PASSWORD | Thêm biến env, trigger deploy |
| Batch "Đang tính..." mãi | Worker không chạy | Check worker logs, restart |
| Mất token sau restart | Redis free không persistence | Upgrade redis sang starter |
| Worker crash "refused" | Redis region khác | Kiểm tra REDIS_URL, region |
| 401 khi curl | OK! | Đăng nhập bằng admin + password |
| 200 khi curl | ⚠️ NGUY HIỂM | Dừng deploy, kiểm tra proxy.ts |
| Web sleep lâu | Free plan ngủ sau 15' | Normal, dậy ~1 phút, upgrade nếu cần |

---

## 10. Bảo Mật Sau Deploy

- Basic Auth bảo vệ toàn bộ app
- Token Facebook được mã hoá lúc lưu vào Redis (AES-256-GCM)
- Redis chỉ tiếp nhận connection từ bên trong Render (không public)
- Worker không phục vụ HTTP, chỉ listen job queue
- Mỗi upload phải có valid token Facebook

**Không có:**
- Rate limit chống brute-force (chỉ chống Meta 429)
- Audit log (không log ai upload cái gì)
- Multi-user (1 password dùng chung)
- Permission (ai biết password đều có toàn quyền)

→ Đủ cho "không phơi NAS", **không đủ** cho "enterprise auth".

---

**Hỏi gì thêm, xem:**
- `render.yaml` — cấu hình chi tiết tất cả 3 service
- `proxy.ts` — logic Basic Auth fail-closed
- `.env.example` — tất cả env vars được mô tả

