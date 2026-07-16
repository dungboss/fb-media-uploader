# System Architecture

Batch-upload images from a NAS folder into a Facebook Ads Media Library
(`POST act_X/adimages`). Scale target: thousands of images per folder,
drained reliably over minutes-to-hours depending on Meta access tier.

## Flow

```
NAS folder ──PROPFIND(Depth:1)──► server enumerates + filters to images
                                          │
                                   batch record + N job hashes (one pipeline)
                                          │
                                   BullMQ addBulk (N jobs, 1 per image)
                                          │
              ┌───────────────────────────┴─────────────────────┐
      worker × concurrency 4          UI polls batches (O(1) counts)
              │                                  │
        429 retry with backoff             "3200/5000 · 12 lỗi · ~14h"
     (wait per estimated_time_to_regain_access)          │
              │                          drill in → paged rows, failed-first
        POST act_X/adimages
              │
   X-Business-Use-Case-Usage ──► usage store ──► monitor call_count
```

- **Enumeration**: the client sends a NAS folder path, not a list of files.
  The server does a WebDAV `PROPFIND` (`Depth: 1`, non-recursive) and filters
  to `.jpg .jpeg .png .gif`. This keeps the create-batch request ~200 bytes
  regardless of folder size and avoids a "select 5000 checkboxes" UI.
- **Execution unit**: one BullMQ job per image (so one corrupt file can't
  stall the other 4999 via retry isolation), plus a batch record for UX
  aggregation. Not BullMQ flows — flows add orchestration this shape doesn't
  need.
- **Rate limiting (2026-07-16 onwards)**: Removed fixed-interval pacing in favor
  of burst mode. Worker submits images as fast as BullMQ concurrency allows
  (4 jobs in parallel). When Meta responds with 429, worker sleeps exactly
  `estimated_time_to_regain_access` from the response header, then retries.
  This maximizes throughput under quota without guessing the tier's true ceiling.
  The ceiling scales with `active_ads` (unknown) — fixed pacing never achieved
  it anyway; burst + react-to-429 is more honest. `X-Business-Use-Case-Usage`
  (bucket `ads_management`) remains the usage signal; `call_count` is monitored
  in logs only.
- **Why not spread one batch across ad accounts**: BUC limits are per ad
  account, so 5 accounts looks like 5× throughput — it is not, for this use
  case. `image_hash` values are per-account assets (an `act_A` hash is
  unusable in `act_B`'s creatives); Meta's own `copy_from
  {source_account_id, hash}` parameter on `adimages` exists only because
  assets don't cross accounts, and `copy_from` doesn't help the quota problem
  anyway since a copy is still a call against the destination account's
  quota. The legitimate multi-account case (same library in all 5 accounts)
  is just 5 separate batches, which already drain in parallel because the
  throttle is per-account.

## Redis key map

| Prefix | Owner | Notes |
|---|---|---|
| `audience-upload:fb-tokens` | `lib/media-upload/token-store.ts` (`TOKENS_KEY`) | **Deliberately not renamed** during the audience→media pivot. Tokens are encrypted with a key derived via `scryptSync(key, SCRYPT_SALT)` where `SCRYPT_SALT = "fb-audience-uploader:token-store:v1"`. Renaming either constant changes the derived encryption key and makes every already-stored token undecryptable, with no migration path. Both carry code comments; see also README "Security notes." |
| `media-upload:*` | `lib/media-upload/*`, `workers/*` | Jobs, batch records, per-status SETs. New prefix for the pivot — old `audience-upload:*` job/batch keys (pre-pivot product) are simply left to TTL out, no migration. |

## Batch progress model

Per-status Redis SETs (`media-upload:batch:<id>:status:<status>`). Progress
counts are `SCARD` (O(1), no scanning). Set membership is idempotent, so a
job retried after a crash or requeue cannot double-count or corrupt a
counter — an `HINCRBY` delta scheme could. Batch list/detail endpoints
pipeline the `SCARD` calls across all requested batches/statuses in one
Redis round trip.

## Single-worker-process constraint

The BUC usage store (`lib/media-upload/meta-usage.ts`) and the worker's batch
cache are **in-memory within the worker process** — there is no
inter-process coordination. Running two `worker:media` processes silently
doubles the effective request rate against any ad account both workers touch,
defeating the per-account throttle and risking 429s. This is a correctness
constraint, not a performance tip: run exactly one worker process per
deployment.

## Rate-limit ground truth (measured, not derived)

Probe against the real token, 2026-07-16, overrides doc-derived assumptions:

1. All ad accounts on the probed token were `development_access`.
2. `X-Ad-Account-Usage` is absent from `me/adaccounts` and `act_X/adimages`
   responses — the `acc_id_util_pct` / 300s-decay-score model has no
   observable input on these edges and is not used for pacing.
3. `X-Business-Use-Case-Usage` is present on both edges, keyed by the **bare
   ad account id** (no `act_` prefix — a parsing trap). Example payload from
   `GET act_X/adimages`:

   ```json
   {"<bare_id>":[{"type":"ads_management","call_count":0,"total_cputime":0,
     "total_time":0,"estimated_time_to_regain_access":0,
     "ads_api_access_tier":"development_access"}]}
   ```

4. **Note (2026-07-16):** The original 15s fixed-interval pacing was removed in
   favor of burst mode. Fixed pacing never reached the tier's true quota because
   quota includes `40 × active_ads` (unknown) and `active_ads` is not observable.
   Pacing at a sàn-tier interval (15s) was overly conservative and wasted the
   variable portion. Burst mode + react-to-429 is simpler and more efficient.
   **ETA in the UI remains computed from observed throughput, never formula.**

## Gate removal (reverses `6e34a33` / `0f8756f`)

The pre-pivot worker limited concurrency to one job per ad account (`act_id`)
at a time, intended to avoid hammering Meta with large concurrent uploads. The
image-upload workload shape is fundamentally different: few large files
running for hours (gate is reasonable) became thousands of small images at
seconds-per-image (the gate becomes a false bottleneck — each account
processes strictly sequentially while request-level throttling already
protects Meta). The gate was removed in favor of burst concurrency (up to 4
jobs in parallel per worker process), with 429-driven backoff supplying
automatic rate limiting. Meta's `estimated_time_to_regain_access` header
provides the authoritative wait time on each block.
