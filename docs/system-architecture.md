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
   Redis min-interval throttle          "3200/5000 · 12 lỗi · ~14h"
     (per ad account; 15s on dev tier)          │
              │                          drill in → paged rows, failed-first
        POST act_X/adimages
              │
   X-Business-Use-Case-Usage ──► usage store ──► brake at call_count ≥90
```

- **Enumeration**: the client sends a NAS folder path, not a list of files.
  The server does a WebDAV `PROPFIND` (`Depth: 1`, non-recursive) and filters
  to `.jpg .jpeg .png .gif`. This keeps the create-batch request ~200 bytes
  regardless of folder size and avoids a "select 5000 checkboxes" UI.
- **Execution unit**: one BullMQ job per image (so one corrupt file can't
  stall the other 4999 via retry isolation), plus a batch record for UX
  aggregation. Not BullMQ flows — flows add orchestration this shape doesn't
  need.
- **Pacing**: BUC-header-driven, per ad account. `X-Business-Use-Case-Usage`
  (bucket `ads_management`) is the only usage signal `adimages` returns —
  `X-Ad-Account-Usage` is confirmed absent on this edge (live probe,
  2026-07-16, zero occurrences on `me/adaccounts` and `act_X/adimages`). The
  worker reads `ads_api_access_tier` from inside that header (free, from
  `me/adaccounts` at page load) and paces at a tier-derived interval (15s
  dev-tier / 200ms standard-tier, never faster than
  `UPLOAD_META_REQUEST_INTERVAL_MS`). It also brakes when `call_count`
  approaches the tier ceiling and sleeps exactly
  `estimated_time_to_regain_access` when Meta signals a temporary block.
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
| `media-upload:*` | `lib/media-upload/*`, `workers/*` | Jobs, batch records, per-status SETs, throttle mutex keys. New prefix for the pivot — old `audience-upload:*` job/batch keys (pre-pivot product) are simply left to TTL out, no migration. |

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

4. Measured throughput: dev tier `300 + 40 × active_ads` calls/hr → our 15s
   pacing yields ~240 images/hr → a 5000-image folder takes ~21 hours.
   Standard tier is ~75× faster (~17 minutes for the same folder). `ETA` in
   the UI is always computed from observed throughput, never from this
   formula, because `active_ads` is unknown and not controllable.

## Gate removal (reverses `6e34a33` / `0f8756f`)

The pre-pivot worker limited concurrency to one job per ad account (`act_id`)
at a time, intended to avoid hammering Meta with large concurrent uploads. The
image-upload workload shape is fundamentally different: few large files
running for hours (gate is reasonable) became thousands of small images at
seconds-per-image (the gate becomes a false bottleneck — each account
processes strictly sequentially while request-level throttling already
protects Meta). The gate was removed in favor of the per-account Redis
min-interval throttle described above, proven under concurrent load in
`workers/media-upload-throttle.test.ts` (8 concurrent waiters × 5 acquisitions
each, minimum observed gap ≥ the configured interval floor).
