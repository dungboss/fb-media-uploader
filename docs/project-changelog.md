# Project Changelog

## 2026-07-16 — Pivot: NAS CSV audiences → NAS images to Ads Media Library

Replaced the entire Custom Audience product with folder-scale image upload
from NAS WebDAV into the Facebook Ads Media Library (`POST act_X/adimages`).
Plan: `plans/260716-0010-nas-images-to-fb-media-library/`. Rationale and the
measured rate-limit findings driving this pivot: `plan.md` in that directory.

### Removed

- Custom Audience creation flow end-to-end: hashed-user CSV upload,
  `app/api/audiences/**`, the legacy `app/api/facebook/route.ts` compat
  route, and all associated UI. Removed entirely — git history only, no
  migration.
- Byte-offset resume for large uploads (`Bắt đầu từ offset (MB)` UI, the
  "confirmed-uploaded bytes" tracking, `UPLOAD_JOB_NAS_TEMP_DIR`,
  `UPLOAD_PRESIGN_TTL_SECONDS`). Ad-image uploads are single-shot multipart —
  there is no concept of a partial upload to resume from.
- **Breaking:** per-ad-account worker concurrency gate ("at most one job per
  ad account at a time"), reversing `6e34a33` / `0f8756f`. See
  `docs/system-architecture.md` → "Gate removal" for the workload-shape
  rationale. Replaced by a per-account Redis min-interval throttle, adaptive
  to the detected Meta access tier.
- Dead dependencies (zero importers, verified by grep across
  `app lib workers components hooks` before removal): `papaparse`,
  `@types/papaparse` (CSV parsing — audience-only), `react-dropzone`,
  `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (S3/R2 staging,
  unused pre-pivot).
- Dead env vars: `UPLOAD_JOB_S3_PREFIX`, `UPLOAD_PRESIGN_TTL_SECONDS`,
  `UPLOAD_META_BATCH_SIZE`, `UPLOAD_META_MAX_PER_SEC`,
  `UPLOAD_META_PROACTIVE_PAUSE_BYTES`, `UPLOAD_JOB_NAS_TEMP_DIR`, and the
  R2/S3 staging vars (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_REGION`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`).

### Breaking

- **Old audience jobs/batches dropped, no migration.** New Redis prefix
  (`media-upload:*`) replaces the old job/batch keys; pre-pivot jobs are left
  to TTL out on their own.
- **Job TTL raised 24h → 7 days** (`UPLOAD_JOB_TTL_SECONDS`). A dev-tier
  drain of 5000 images takes ~21h and queued jobs are never touched while
  waiting in queue — a 24h TTL would silently expire them mid-drain.
- `npm run worker:audiences` → `npm run worker:media`.
- `package.json` `"name"` → `fb-media-uploader` (repo directory was already
  renamed; this was inconsistent).

### Added

- Meta ad-image client (`lib/media-upload/meta-images.ts`,
  `meta-ad-accounts.ts`, `meta-usage.ts`, `meta-graph.ts`): upload, tolerant
  response parsing (nested `images.<fieldName>` shape, verified against a
  real POST), and `X-Business-Use-Case-Usage` header parsing for tier
  detection + pacing input.
- Folder-scale API: `POST/GET /api/upload-batches`, folder PROPFIND
  enumeration, paged failed-first job listing, per-batch and per-job retry.
- Batch-centric dashboard: folder picker, batch cards with O(1) progress
  counts, dev-tier throughput callout with a link to request Standard
  access, paged job drill-in.
- `npm test` (vitest): response parser, usage-header parsing, media-type
  filter, retry/error-routing logic, and a real-Redis proof that the
  per-account throttle holds its interval under concurrent load. The
  throttle test requires a running Redis.

### Kept unchanged

- Access-token store: encrypted at rest (AES-256-GCM), per-token App
  ID/Secret, `appsecret_proof`, `TOKEN_ENCRYPTION_KEY`. Redis key
  (`audience-upload:fb-tokens`) and salt (`fb-audience-uploader:token-store:v1`)
  **deliberately not renamed** — see `docs/system-architecture.md` → "Redis
  key map."
- Ad account selection UX and NAS WebDAV configuration.
