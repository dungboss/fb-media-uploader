# Hướng Dẫn Deploy Lên VPS

> **Đã chạy thật.** Bản này là ghi chép của một lần deploy thành công lên
> Ubuntu 22.04 (2 core / 1.9GB RAM / 16GB đĩa) ngày 2026-07-17, kết thúc bằng
> HTTPS hợp lệ + Basic Auth trả 401 + NAS gọi được. Ba chỗ trong bản nháp
> trước **sai**, đã sửa: Redis của Ubuntu quá cũ cho BullMQ, systemd không cần
> `EnvironmentFile`, và không có tên miền vẫn lấy được chứng chỉ thật.

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

**Máy:** 2GB RAM là sàn, và ở sàn thì phải hạ `UPLOAD_WORKER_CONCURRENCY`.
Worker đọc nguyên tấm ảnh vào RAM để POST multipart, nên RAM cao điểm ≈
`UPLOAD_MAX_FILE_BYTES` × concurrency, cộng Next.js và Redis. Mặc định
(100MB × 4 = 400MB) quá tay cho máy 1.9GB — bản deploy thật đặt **concurrency=2**.

**Đĩa:** `npm ci` + build ăn ~1GB. Cần ít nhất 3GB trống.

**Sinh 2 khoá, lưu vào password manager:**

```bash
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY — sinh 1 lần, KHÔNG BAO GIỜ đổi
openssl rand -base64 24   # BASIC_AUTH_PASSWORD
```

> `TOKEN_ENCRYPTION_KEY` đổi là **mọi token đã lưu thành rác không giải mã
> được**, không có đường khôi phục. Web và worker phải dùng **cùng một giá trị**.

---

## 2. Cài đặt (Ubuntu 22.04)

### Siết bảo mật TRƯỚC

Máy có IP public thì làm hai việc này trước khi đặt mật khẩu NAS lên đó:

```bash
# Firewall — mở 22 TRƯỚC khi bật, nếu không là tự khoá mình ra ngoài
sudo apt-get install -y ufw
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable

# Chỉ cho đăng nhập bằng key (đẩy key lên trước: ssh-copy-id root@<ip>)
sudo tee /etc/ssh/sshd_config.d/zz-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sudo sshd -t && sudo systemctl reload ssh
```

Kiểm tra key còn vào được **trước khi đóng phiên đang mở**.

### Node + Redis

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

> **Đừng dùng `apt-get install redis-server` của Ubuntu.** Ubuntu 22.04 mang
> Redis **6.0.16**, còn BullMQ yêu cầu **"Redis `6.2.0` or newer"**
> (docs.bullmq.io). Cài bản của Ubuntu thì app dựng lên vẫn chạy rồi hỏng lúc
> chạy thật với lỗi khó lần. Dùng repo chính thức của Redis:

```bash
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt-get update && sudo apt-get install -y redis
redis-server --version   # phải >= 6.2
```

### Redis — ba thiết lập bắt buộc

Thêm vào cuối `/etc/redis/redis.conf` (cuối file thắng mọi giá trị phía trên):

```
bind 127.0.0.1 -::1         # KHÔNG mở ra ngoài — Redis này giữ token Facebook
protected-mode yes
maxmemory-policy noeviction # KHÔNG dùng allkeys-lru
appendonly yes              # token phải sống sót qua restart
```

Đây là **kho token + hàng đợi**, không phải cache: `allkeys-lru` sẽ **âm thầm
xoá** token và job đang chờ khi chạm `maxmemory`.

```bash
sudo systemctl restart redis-server
redis-cli CONFIG GET maxmemory-policy   # đọc từ Redis đang chạy, không phải từ file
redis-cli CONFIG GET appendonly
ss -tlnp | grep 6379                    # phải chỉ thấy 127.0.0.1 và ::1
```

### Code

```bash
sudo adduser --system --group --home /opt/fbmedia fbmedia
sudo -u fbmedia git clone --depth 1 https://github.com/dungboss/fb-media-uploader.git /opt/fbmedia/app
cd /opt/fbmedia/app && sudo -u fbmedia npm ci
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

**Không dùng `EnvironmentFile`.** Next tự nạp `.env` lúc chạy và worker dùng
`tsx --env-file-if-exists=.env`, nên app tự lo — giống hệt môi trường dev, và
tránh chuyện systemd parse `.env` khác dotenv (dấu `#`, khoảng trắng, quote
trong mật khẩu NAS). Chỉ `NODE_ENV` cần đặt tường minh, vì `proxy.ts` fail-closed
dựa vào nó.

`/etc/systemd/system/fbmedia-web.service`:

```ini
[Unit]
Description=fb-media-uploader web (Next.js)
After=network.target redis-server.service
Requires=redis-server.service

[Service]
User=fbmedia
Group=fbmedia
WorkingDirectory=/opt/fbmedia/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/fbmedia-worker.service`: giống hệt, chỉ đổi
`Description` và `ExecStart=/usr/bin/npm run worker:media`.

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

## 4. HTTPS

**TLS là bắt buộc, không phải tuỳ chọn.** Bảo vệ duy nhất của app là HTTP Basic
Auth, mà Basic Auth qua HTTP thường gửi mật khẩu **dạng chữ thường** qua mạng.

Không có tên miền vẫn lấy được chứng chỉ Let's Encrypt thật: `nip.io` phân giải
`<ip>.nip.io` về chính IP đó.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
180.93.232.154.nip.io {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl restart caddy
journalctl -u caddy -n 20 --no-pager | grep -i certificate   # "certificate obtained successfully"
```

Có tên miền riêng thì trỏ A record về IP rồi thay dòng đầu — Caddy tự xin
chứng chỉ mới, không cần làm gì thêm.

Firewall chỉ mở 22/80/443. Cổng **3000 và 6379 không được** ra Internet — Caddy
nói chuyện với app qua `localhost`.

---

## 5. Kiểm tra sau deploy — đừng bỏ bước này

```bash
curl -o /dev/null -w "%{http_code}\n" https://<host>/api/webdav/entries
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
