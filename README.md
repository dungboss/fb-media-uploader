# fb-media-uploader

Batch-upload images from a NAS folder into a Facebook Ads Media Library
(`POST act_X/adimages`). Pick a folder, the server enumerates it, one BullMQ
job per image, batch progress in the dashboard. **Images only:** `.jpg .jpeg
.png .gif`.

## Getting Started

Four commands from a fresh clone:

```bash
npm install
docker compose up -d   # Redis on :6379 — the one thing npm can't install
npm run setup          # writes .env, generates TOKEN_ENCRYPTION_KEY, checks Redis
npm run dev:all        # web + worker together
```

Then open [http://localhost:3000](http://localhost:3000) and add a Facebook
token from the dashboard (see [Access tokens](#access-tokens)).

`npm run setup` will tell you if anything is still missing. The one thing it
cannot fill in for you is the NAS login — put `WEBDAV_USERNAME` and
`WEBDAV_PASSWORD` in `.env` yourself.

Already have Redis on `:6379` (DBngin, Homebrew, an existing container)? Skip
`docker compose up -d` — `npm run setup` detects it and says so.

### Run it with `dev:all`, not `dev`

This app is **two processes**. `npm run dev` serves the dashboard, which only
*enqueues* jobs; `npm run worker:media` is what actually uploads to Meta. Run
the dashboard alone and your batch sits at "Đang tính ước tính..." forever,
with no error and no hint — the jobs are queued and nobody is working them.

`npm run dev:all` runs both with `[web]`/`[worker]` labels. Prefer it. If you
do run them separately, run **exactly one** worker (see
[Pacing](#pacing--the-single-worker-process-requirement)).

### If something hangs or looks empty

Redis is almost always the answer. It holds your encrypted Facebook tokens and
the job queue, and the app is useless without it. When it is not running, every
API route now fails in about a second with:

> Không kết nối được Redis ở redis://localhost:6379 — Redis chưa chạy? Chạy
> `docker compose up -d` rồi thử lại.

`docker compose down` stops Redis but keeps your data. `docker compose down -v`
also deletes the volume — **that wipes every Facebook token you added**, and
they cannot be recovered.

## Access tokens

Tokens are managed from the dashboard, not hardcoded in `.env`. Use **Thêm
token** in the header to paste a token (with an optional label, and optional
**App ID + App Secret**); it is validated against Meta (`me/adaccounts`) then
stored **encrypted at rest** in Redis (AES-256-GCM). Set `TOKEN_ENCRYPTION_KEY`
in `.env` first — generate one with `openssl rand -base64 32`. Tokens need
`ads_management` or `ads_read` scope.

- **App ID / App Secret are per token** (no longer read from `.env`). When an
  app secret is provided, every Graph call made with that token carries an
  `appsecret_proof` — required if the app enables "Require app secret", harmless
  otherwise. Leave both blank for apps that don't require it. The app secret is
  encrypted alongside the token; the app id is stored as a plain reference.
- Raw tokens and app secrets never round-trip back to the browser; only token
  ids (and the non-secret app id) do.
- The picker remembers the selected token per browser (localStorage stores the
  id, never the secret).
- `FACEBOOK_ACCESS_TOKEN` in `.env` still works as the optional default token.
- Each upload job snapshots the chosen token id so the worker (a separate
  process) resolves the same token from Redis.

## Ad account selection

The dashboard fetches every ad account the **active token** can reach (Graph
`me/adaccounts`) and shows them in a picker in the header — no need to
hardcode the target account. The picked account is remembered per browser and
is snapshotted onto each upload job so the worker uploads images to the right
account. `FACEBOOK_AD_ACCOUNT_ID` is only an optional default. The same
`me/adaccounts` call also returns each account's access tier for free (see
below) — no extra probe call.

## Upload ảnh từ NAS

1. Chọn token + ad account ở header.
2. Bấm **Chọn thư mục NAS**, duyệt tới thư mục ảnh. Server PROPFIND
   (`Depth: 1`, không đệ quy) thư mục đó và lọc còn `.jpg .jpeg .png .gif` —
   file khác không phải ảnh không hiện ra, không tính là "bị bỏ qua".
3. Bấm upload → server tạo **1 batch record + N job** (1 job/ảnh, dùng BullMQ
   `addBulk` — một lần gọi, không phải N request). Batch tối đa
   `UPLOAD_MAX_BATCH_FILES` ảnh (mặc định 10,000); nếu chọn file lẻ thay vì cả
   thư mục thì tối đa 500 file/lần.
4. Dashboard poll batch progress (đếm O(1) qua Redis SET, không quét từng
   job): tổng, đã xong, lỗi, ETA ước lượng từ throughput đo được (không suy
   từ công thức quota — xem phần Access tier bên dưới). Bấm vào một batch để
   xem danh sách job phân trang, **lỗi hiện trước** để review sau khi drain
   xong (batch dev-tier chạy hàng chục giờ — không ai ngồi canh, xem lại danh
   sách lỗi quan trọng hơn progress bar thời gian thực).
5. Job lỗi có thể **retry từng cái** hoặc **retry tất cả lỗi trong batch**
   (một lần bấm). Retry là upload lại toàn bộ file — không có resume theo
   byte offset (xem phần dưới).

**Không có giới hạn kích thước file phía client.** Giới hạn thật của Meta cho
`adimages` không được công bố / không rõ. `UPLOAD_MAX_FILE_BYTES` (mặc định
100MB) chỉ là **chốt chặn OOM** để khỏi đọc nguyên file khổng lồ vào RAM
trước khi upload — **không phải giới hạn của Meta**. File bị Meta từ chối thì
job hiện nguyên văn lỗi của Meta.

Upload là **single-shot multipart → `hash`**. Không chunk, không resume theo
offset — xem "Vì sao bỏ resume theo offset" bên dưới.

## Access tier & throughput

**Đây là đặc điểm hiệu năng quan trọng nhất của sản phẩm, không phải chi
tiết vặt.** Đo thực tế (probe sống, 2026-07-16), không suy từ tài liệu Meta:

| Tier | BUC quota / ad account | Upload mode |
|---|---|---|
| **`development_access`** ← tier hiện tại của mọi ad account | `300 + 40 × active_ads` calls/hr | **Burst + 429 backoff** |
| `standard_access` (Full Access) | `100000 + 40 × active_ads` calls/hr | **Burst + 429 backoff** |

**Burst mode + 429 backoff (2026-07-16 onwards):**
- Worker uploads images as fast as concurrency allows (default 4 jobs in parallel).
- When Meta responds with 429 (rate limited), worker sleeps exactly
  `estimated_time_to_regain_access` from the response header, then retries.
- This maximizes throughput without guessing the tier's true ceiling — the
  ceiling scales with `active_ads` (unknown and unobservable) so fixed-interval
  pacing was always a guess.
- `X-Business-Use-Case-Usage` (bucket `ads_management`) is the only usage signal.
- **ETA in dashboard is computed from observed throughput, never formula.**
  Actual drain time depends on your `active_ads` value, which is unknown.
- The only way to reliably improve throughput is to request **Standard access**
  from Meta (xem [Marketing API rate limiting](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/)).

## Burst upload & the single-worker-process requirement

Không còn "tối đa 1 job/ad account cùng lúc" (gate đó đã bị gỡ).
Thay vào đó: **upload theo kiểu burst** — BullMQ concurrency xử lý N job song
song (default 4). Khi Meta trả 429, worker chờ `estimated_time_to_regain_access`
rồi thử lại. Nhiều ad account tự chạy song song — không chia sẻ cổng chung, không
throttle mutex cũ nữa.

**Chạy đúng một tiến trình worker.** Usage store (đọc header
`X-Business-Use-Case-Usage`) và cache batch đều nằm **in-memory trong tiến
trình worker** — không có điều phối liên-tiến-trình. Chạy 2 tiến trình
`worker:media` song song sẽ âm thầm nhân đôi tốc độ gọi Meta cho cùng một ad
account, vượt ngưỡng quota thật và dễ dính 429 liên tục. Đây là yêu cầu đúng
đắn, không phải khuyến nghị.

`UPLOAD_WORKER_CONCURRENCY` (mặc định 4) chỉ giới hạn số job xử lý song song
trong tiến trình đó. Tốc độ upload hiện tại bị kiểm soát bởi Meta quota +
429 backoff, không phải biến này.

### Vì sao bỏ gate "1 job/ad account"

Bản trước giới hạn worker chạy tối đa 1 job cho mỗi `act_id` cùng lúc, ý định
là tránh spam Meta. Pivot sang upload ảnh đổi hẳn hình dạng khối lượng công
việc: từ vài file lớn chạy hàng giờ (gate hợp lý) sang hàng nghìn ảnh nhỏ
chạy hàng giây/ảnh (gate biến thành nút thắt giả — mỗi ad account chỉ xử lý
tuần tự trong khi throttle theo request đã đủ bảo vệ Meta). Gỡ gate, thay
bằng throttle per-account đã chứng minh giữ khoảng cách ≥ interval cấu hình
dưới tải đồng thời (test `workers/media-upload-throttle.test.ts`, 8 waiter ×
5 lần chiếm, gap tối thiểu đo được ≥ sàn cấu hình).

### Vì sao bỏ resume theo offset

Bản trước upload file lớn theo range 10MB, theo dõi offset đã xác nhận để
resume khi lỗi. Upload ảnh vào Media Library là **single-shot multipart**
(một `image_hash` cho cả file) — không có khái niệm "đã upload được X MB",
retry nghĩa là **upload lại toàn bộ ảnh từ đầu**. Ảnh đủ nhỏ để việc này rẻ
hơn nhiều so với giữ lại cơ chế range-resume.

### Vì sao không chia một batch ra nhiều ad account

BUC limit tính theo từng ad account — trông như 5 ad account = 5× throughput,
nhưng **không đúng cho use case này**:
1. `image_hash` là tài sản **riêng theo account** — hash từ `act_A` không
   dùng được cho creative ở `act_B`.
2. Meta tự thừa nhận điều đó: `adimages` có tham số
   `copy_from{source_account_id, hash}` — API copy chỉ tồn tại vì asset
   không tự chuyển account.
3. `copy_from` cũng không giúp gì: giới hạn của mình là số call/giờ vào
   account **đích**, copy vẫn là một call vào quota đó.
4. Nếu thật sự muốn cùng một thư viện ảnh ở cả 5 account: tạo 5 batch riêng —
   throttle vốn đã theo account nên 5 batch đó tự chạy song song, không cần
   thiết kế thêm gì.

## NAS WebDAV

The dashboard can browse files from a NAS WebDAV endpoint and load them into
the upload flow. Set `WEBDAV_BASE_URL` to your NAS endpoint, and optionally
`WEBDAV_USERNAME` / `WEBDAV_PASSWORD` if basic auth is required. Folder
browsing/enumeration filters to the supported image extensions
(`.jpg .jpeg .png .gif`) — other files are simply not listed as upload
candidates.

## Environment variables

Every variable `lib/media-upload/env.ts` reads. `.env.example` mirrors this
table.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `REDIS_URL` | **yes** | — | Job queue, batches, tokens, throttle state |
| `TOKEN_ENCRYPTION_KEY` | **yes** (to add tokens) | — | `openssl rand -base64 32`. Changing it invalidates all stored tokens |
| `WEBDAV_BASE_URL` | no | — | NAS WebDAV endpoint for folder browsing |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | no | — | Basic auth for the NAS, if required |
| `FACEBOOK_ACCESS_TOKEN` | no | — | Optional default token (fallback only; dashboard tokens take precedence) |
| `FACEBOOK_AD_ACCOUNT_ID` | no | — | Optional default ad account (fallback only) |
| `FACEBOOK_API_VERSION` | no | `v23.0` | Graph API version |
| `UPLOAD_JOB_QUEUE_NAME` | no | `media-upload` | BullMQ queue name |
| `UPLOAD_JOB_TTL_SECONDS` | no | `604800` (7d) | **Must exceed the longest expected drain.** A dev-tier 5000-image batch takes ~21h; queued jobs sit untouched while waiting, so a 24h TTL would expire them mid-drain. Raised from 24h for exactly this reason |
| `UPLOAD_JOB_ATTEMPTS` | no | `10` | Retry attempts per job before it's marked failed |
| `UPLOAD_WORKER_CONCURRENCY` | no | `4` | Jobs processed in parallel **within the one worker process**. No longer tied to ad-account count (the per-account gate is gone) |
| `UPLOAD_WORKER_RATE_LIMIT_MAX` / `UPLOAD_WORKER_RATE_LIMIT_DURATION_MS` | no | `1` / `1000` | BullMQ's own global rate limiter (queue-level safety net, separate from Meta rate limiting via 429 backoff) |
| `UPLOAD_META_RATE_LIMIT_DELAY_MS` | no | `300000` (5m) | **Fallback only** — used when Meta's response carries no usage header to derive a wait from |
| `UPLOAD_MAX_FILE_BYTES` | no | `104857600` (100MB) | **OOM guard, not Meta's image size limit** (Meta's real limit is undocumented/unknown). Rejects a file before fully reading it into memory |
| `UPLOAD_MAX_BATCH_FILES` | no | `10000` | Folder-mode batch cap. Explicit multi-file picks are separately capped at 500 |

## Development

```bash
npx tsc --noEmit   # type check
npm run lint       # eslint
npm test           # vitest — the throttle test needs a real Redis (REDIS_URL)
npm run build      # next build
```

## Security notes

- Tokens and app secrets are encrypted at rest (AES-256-GCM); losing
  `TOKEN_ENCRYPTION_KEY` after a redeploy means every stored token becomes
  undecryptable — keep it somewhere durable.
- **`TOKENS_KEY` and `SCRYPT_SALT` in `lib/media-upload/token-store.ts` must
  never be renamed.** They still carry the old product name
  (`audience-upload:fb-tokens`, `fb-audience-uploader:token-store:v1`) — that
  looks like leftover cruft from the pivot, but it is not: changing either
  string makes every already-stored encrypted token undecryptable, with no
  migration path. Both are commented in the source; this is the second
  warning.
