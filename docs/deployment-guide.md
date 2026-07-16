# Hướng Dẫn Deploy Lên VPS

> **Chưa được kiểm chứng thực tế.** Guide này viết từ cấu hình đã biết của app,
> chưa ai chạy hết một lượt trên VPS thật. Các lệnh dưới đây là điểm khởi đầu
> đáng tin, không phải bản ghi của một lần deploy thành công. Gặp chỗ lệch,
> sửa file này.

## Vì sao VPS, không phải Render

App này là **3 tiến trình**: web (Next.js), worker (upload lên Meta), Redis
(token + hàng đợi). Render tính tiền **theo từng service** → 3 hoá đơn. VPS
tính tiền **theo cái máy** → cả 3 chạy chung, worker không tốn thêm đồng nào.

Khảo giá 2026-07-17 (xem `plans/reports/researcher-260717-0012-cheapest-hosting.md`):

| Phương án | $/tháng @ 1GB upload | Cảnh báo |
|---|---|---|
| Chạy local | **$0** | Máy phải bật lúc upload |
| Oracle Cloud Always Free | **$0** | 2 OCPU/12GB, 10TB egress; thường hết chỗ, xin máy khó |
| Contabo VPS (Singapore) | **~$6** | Băng thông không giới hạn; **khoá 24 tháng**, giá gia hạn KHÔNG công bố |
| Vultr / DigitalOcean | $10–12 | Minh bạch, nhưng không có region Singapore |
| Render (3 service) | $24,50 | Gấp 4 lần VPS rẻ nhất |

**Băng thông là chi phí ẩn.** App tải ảnh từ NAS xuống rồi đẩy lên Facebook.
Batch 10.000 ảnh ≈ 50GB egress. Trên VPS gần như miễn phí; trên PaaS thì tính
tiền (Render ước tính ~$54/tháng ở mức đó — **con số này chưa xác minh được**,
giá egress vượt mức không có nguồn chính thức).

**Rẻ nhất vẫn là không deploy.** Nếu bạn không cần truy cập khi máy tắt, chạy
local là $0 và không phải vá OS, không phải lo backup.

---

## 1. Chuẩn bị

**Máy:** tối thiểu 2GB RAM. Worker đọc nguyên tấm ảnh vào RAM để POST multipart
(`UPLOAD_MAX_FILE_BYTES` mặc định 100MB × `UPLOAD_WORKER_CONCURRENCY` 4 = tới
400MB lúc cao điểm), cộng Next.js và Redis.

**Sinh 2 khoá, lưu vào password manager:**

```bash
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY — sinh 1 lần, KHÔNG BAO GIỜ đổi
openssl rand -base64 24   # BASIC_AUTH_PASSWORD
```

> `TOKEN_ENCRYPTION_KEY` đổi là **mọi token đã lưu thành rác không giải mã
> được**, không có đường khôi phục. Web và worker phải dùng **cùng một giá trị**.

---

## 2. Cài đặt trên VPS (Ubuntu 24.04)

```bash
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs redis-server git

# Code
sudo adduser --system --group --home /opt/fbmedia fbmedia
sudo -u fbmedia git clone https://github.com/dungboss/fb-media-uploader.git /opt/fbmedia/app
cd /opt/fbmedia/app
sudo -u fbmedia npm ci
```

### Redis — hai thiết lập bắt buộc

Sửa `/etc/redis/redis.conf`:

```
bind 127.0.0.1 ::1          # KHÔNG mở ra ngoài — Redis này giữ token Facebook
maxmemory-policy noeviction # KHÔNG dùng allkeys-lru
appendonly yes              # token phải sống sót qua restart
```

`noeviction` là mặc định của Redis — đừng đổi. Đây là **kho token + hàng đợi**,
không phải cache: `allkeys-lru` sẽ **âm thầm xoá** token và job đang chờ khi hết
bộ nhớ. `appendonly` bật lên thì restart không mất token.

```bash
sudo systemctl restart redis-server
redis-cli CONFIG GET maxmemory-policy appendonly   # xác nhận
```

### .env

```bash
sudo -u fbmedia cp .env.example /opt/fbmedia/app/.env
sudo -u fbmedia nano /opt/fbmedia/app/.env
```

Phải điền: `TOKEN_ENCRYPTION_KEY`, `BASIC_AUTH_PASSWORD`, `WEBDAV_USERNAME`,
`WEBDAV_PASSWORD`. Thêm `NODE_ENV=production`.

> **Đừng đặt `UPLOAD_WORKER_RATE_LIMIT_MAX=1`.** Đó là mặc định cũ từ thời app
> còn giãn 15s mỗi ảnh; giá trị `1` bóp tốc độ xuống 1 ảnh/giây (3600/giờ) —
> âm thầm, không lỗi, không cảnh báo. `.env.example` để `10000` là cố ý.

```bash
sudo -u fbmedia npm run build
```

---

## 3. Hai tiến trình = hai systemd unit

`/etc/systemd/system/fbmedia-web.service`:

```ini
[Unit]
Description=fb-media-uploader web
After=network.target redis-server.service

[Service]
User=fbmedia
WorkingDirectory=/opt/fbmedia/app
ExecStart=/usr/bin/npm start
Restart=always
EnvironmentFile=/opt/fbmedia/app/.env

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/fbmedia-worker.service`:

```ini
[Unit]
Description=fb-media-uploader worker
After=network.target redis-server.service

[Service]
User=fbmedia
WorkingDirectory=/opt/fbmedia/app
ExecStart=/usr/bin/npm run worker:media
Restart=always
EnvironmentFile=/opt/fbmedia/app/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fbmedia-web fbmedia-worker
sudo journalctl -u fbmedia-worker -f    # phải thấy: listening queue=media-upload concurrency=4
```

**Chạy đúng MỘT tiến trình worker.** Usage store (đọc header
`X-Business-Use-Case-Usage`) và cache batch nằm **in-memory trong tiến trình
worker** — không có điều phối liên-tiến-trình. Hai worker song song sẽ âm thầm
nhân đôi tốc độ gọi Meta cho cùng một ad account. Đừng thêm `fbmedia-worker@2`.

---

## 4. HTTPS + tên miền

Caddy tự xin chứng chỉ, ít cấu hình nhất. `/etc/caddy/Caddyfile`:

```
fbmedia.example.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo apt-get install -y caddy && sudo systemctl restart caddy
```

Mở firewall **chỉ** 80/443 và SSH. Cổng 3000 và 6379 **không được** ra Internet.

---

## 5. Kiểm tra sau deploy — đừng bỏ bước này

```bash
curl -o /dev/null -w "%{http_code}\n" https://fbmedia.example.com/api/webdav/entries
```

**Phải ra `401`.** Nếu ra `200` thì **NAS công ty đang phơi ra Internet cho bất
kỳ ai có URL** — dừng ngay, kiểm tra `BASIC_AUTH_PASSWORD`.

Nếu ra `503`: `proxy.ts` fail-closed vì `NODE_ENV=production` mà thiếu
`BASIC_AUTH_PASSWORD`. Đó là **cố ý** — thiếu mật khẩu là sự cố, không phải cửa mở.

Đăng nhập bằng `admin` + `BASIC_AUTH_PASSWORD`, rồi **nhập lại token Facebook**
(không có migration từ Redis local).

---

## 6. Backup — thứ duy nhất không thể tạo lại

Mất Redis là mất token; mất `TOKEN_ENCRYPTION_KEY` là token còn cũng vô dụng.
**Cần cả hai mới khôi phục được.**

```bash
# Redis AOF/RDB
sudo tar czf /root/redis-$(date +%F).tgz /var/lib/redis
```

`TOKEN_ENCRYPTION_KEY` cất ở password manager, **không** cất chung chỗ với backup Redis.

---

## 7. Bảo mật — app này có gì và không có gì

**Có:** Basic Auth chặn toàn bộ app (`proxy.ts`, không matcher); token + app
secret mã hoá AES-256-GCM khi lưu; Redis chỉ nghe localhost; worker không phục
vụ HTTP.

**Không có:** chống brute-force, audit log, phân quyền, multi-user (một mật khẩu
dùng chung — ai biết là có toàn quyền).

→ Đủ để "không phơi NAS ra Internet", **không đủ** cho "enterprise auth".

---

## 8. Cập nhật code

```bash
cd /opt/fbmedia/app
sudo -u fbmedia git pull && sudo -u fbmedia npm ci && sudo -u fbmedia npm run build
sudo systemctl restart fbmedia-web fbmedia-worker
```

---

## Xem thêm

- `proxy.ts` — logic Basic Auth fail-closed
- `.env.example` — mô tả mọi biến môi trường
- `README.md` — mục "Access tier & throughput": vì sao không có giới hạn tốc độ cố định
- `plans/reports/researcher-260717-0012-cheapest-hosting.md` — khảo giá đầy đủ, kèm các con số chưa xác minh
