# Phase 03 — Worker: gate removal + adaptive pacing

## Context Links

- Overview: [plan.md](plan.md) — the tier table drives every number here
- Depends on [phase 02](phase-02-meta-image-client.md) (needs `meta-usage.ts`)
- Parallel with [phase 04](phase-04-api-routes.md) — disjoint files
- Source: `workers/audience-upload-worker.ts` (601 lines) → `workers/media-upload-worker.ts`

## Overview

- **Priority:** P1
- **Status:** pending
- **Effort:** 2h

Replace the 140-line streaming/batching/offset engine with: read NAS file → one
POST → record hash. **Remove the per-ad-account concurrency gate.** Replace fixed
cooldowns with pacing driven by Meta's usage headers.

## Key Insights

### Removing the per-account gate deliberately reverses two commits

`0f8756f` (per-app gate) and `6e34a33` (refined to per-ad-account) were
**correct for the workload they were written for**: multi-hour audience uploads
streaming millions of hashed rows, where two concurrent jobs on one account
would genuinely collide and where a 10s re-check cost nothing against a 3-hour
job. That workload no longer exists.

For thousands of ~1s image POSTs the gate is actively harmful:

- It serializes jobs to strictly one-at-a-time per account, then makes each
  waiting job sleep `ACCOUNT_BUSY_RETRY_DELAY_MS = 10s` before re-checking a gate
  that freed in ~1s. A 5000-image batch would spend **~14 hours idle-waiting** on
  Standard tier — a tier where the rate limit permits the whole batch in ~15 min.
- Everything the gate protects, `acquireMetaRequestSlot` already protects: it is
  **per ad account**, backed by Redis `SET NX PX`, and enforces a minimum
  interval between calls. The gate adds mutual exclusion the throttle already
  implies, at a 10s granularity the throttle achieves in milliseconds.

**This is a workload change, not a repudiation.** Anyone reading `git log` should
see the gate removed *because the job shape inverted* (few×hours → thousands×seconds),
not because it was a mistake. Say so in the commit message.

### The throttle is now the *only* pacing mechanism — verify it holds

With the gate gone, `UPLOAD_WORKER_CONCURRENCY` (default 4) handlers can target
one account simultaneously. `acquireMetaRequestSlot` is a Redis `SET NX PX`
mutex with a TTL equal to the interval: one acquirer wins, the rest sleep for the
remaining `PTTL` and re-try. That *is* a correct distributed min-interval limiter
under N waiters — but it is now load-bearing, so phase exit **requires proving it
empirically** (Success Criteria), not assuming it.

Known wart: waiters wake together (thundering herd) at TTL expiry. At
concurrency 4 that's ~4 wakeups/interval — negligible. It would matter at
concurrency 50; we're not there.

### Pacing is BUC-driven, and dev tier is the shipping path

The 2026-07-16 probe (plan.md) measured: **all 5 accounts are
`development_access`**, and **`X-Ad-Account-Usage` does not exist** on these
edges. So the `acc_id_util_pct` / `reset_time_duration` brake I previously
designed **has no input and is deleted**. The input is
`X-Business-Use-Case-Usage`, and `ads_api_access_tier` rides inside it.

| Tier | Interval | Yields | Reasoning |
|---|---|---|---|
| **`development_access`** ← **ships & gets tested** | **15s** | ~240/hr | Under the BUC floor of 300/hr (`300 + 40×active_ads`), **and** ≤20 writes/300s in case the unreported ad-account score limit is real |
| `standard_access` | 200ms | ~18,000/hr | Far under `100000/hr`; kept so an upgrade pays off immediately |
| `unknown` | 1s (env floor) | ~3,600/hr | Only before the first response; the tier arrives with the first `me/adaccounts` at page load |

**Why 15s and not 12s.** BUC alone would allow 300/hr = 12s. But
`X-Ad-Account-Usage` being absent does **not** prove the 60-point/300s score limit
is gone — it may simply be unreported for this app. That limit permits 20
writes/300s = **15s**. 15s satisfies both; 12s satisfies only the one we can see.
Costs ~4h on a 5000-image drain (21h vs 17h) to be safe against a limit we cannot
observe. If phase 02's probe or production logs later prove the score limit
doesn't apply, drop to 12s via `UPLOAD_META_REQUEST_INTERVAL_MS` — no code change.

**The `call_count` brake** covers what the static interval can't (another process
on the same account, a quota smaller than assumed):

```
if (usage.callCount >= BRAKE_PCT) await waitFor(BRAKE_SLEEP_MS)
```

- **A single `if`, not a `while`.** A loop would deadlock: the usage store is only
  refreshed by *responses*, so sleeping without calling means `callCount` never
  moves. One check → sleep → let this call through → its response refreshes the
  store → the next job re-evaluates. Self-correcting, no probe call needed.
- **`BRAKE_PCT = 90`, not 80.** At the designed dev-tier pace we already sit at
  ~80% of the *minimum* quota (240/hr of 300/hr) by construction — an 80 brake
  would fire on every job at steady state. 90 leaves headroom while still catching
  genuine overrun.
- **Blocked on phase 02 step 1b:** if `call_count` turns out to be an absolute
  count rather than a percentage, `>= 90` means 90 calls (~30% of quota) — a
  needlessly early brake. Fails safe (slow, not broken), but re-derive the
  threshold from `300 + 40×active_ads` before shipping.

**We do not auto-speed-up when quota is larger than assumed.** `active_ads` raises
the quota (`+40` each) and we'd under-use it. Inferring quota from a coarse
integer percentage on a rolling window is noisy guesswork. Instead: **log
`call_count` every 25 jobs**. If it sits at 5% after an hour, the operator lowers
`UPLOAD_META_REQUEST_INTERVAL_MS` with real evidence. Env knob already exists;
auto-calibration is a follow-up, not v1.

### Other

- `syncLinesFromNas` (140 lines: accumulator, offset checkpoints, proactive
  pause, resume-by-line) has **no images-only equivalent**. Delete it whole.
- Ad account + token now live on the **batch** (phase 01), not the job → one
  `getBatch` per job. Cache per `batchId` in a module `Map` (5000 jobs, 1 batch =
  1 fetch); the batch is immutable after creation.
- Cancellation was checked inside the stream loop via `onProgress`. With no loop,
  check once before the POST. A cancel landing mid-POST completes the upload and
  records the hash — honest: the asset *is* in the library. Don't fake a rollback.
- Worker restart is already safe: BullMQ recovers stalled jobs, and a re-POST of
  identical bytes returns the same hash (Meta dedupes). No dedupe logic needed.

## Requirements

**Functional**
- Per job: guard → resolve batch → read NAS bytes → OOM guard → throttle → `uploadAdImage` → `transitionJobStatus("completed", {imageHash, previewUrl})`.
- Jobs for different accounts run in parallel; one account is paced by the throttle.
- Cancelled jobs never resurrect to processing.
- Rate limit → `queued` + `nextRetryAt` from Meta's own header; permanent rejection → `failed` fast.

**Non-functional**
- File < 200 lines (from 601).
- Single worker process (in-memory usage store + batch cache) — unchanged constraint, now documented.

## Architecture

```
bullJob → getMediaUploadJob(jobId)
  completed  → return (idempotent replay)
  cancelled  → return { cancelled: true }
  transitionJobStatus("processing", { errorMessage:"", nextRetryAt:null })
  batch = getBatchCached(job.batchId)          // ad account + token
  cancelled? → transition("cancelled"), return
  { buffer, contentType } = fetchWebDavFileBuffer(job.nasFilePath)
  buffer.byteLength > maxFileBytes → UnrecoverableError      // OOM guard
  await acquireMetaRequestSlot(accountKey)     // adaptive interval + util brake
  uploadAdImage({ bytes, fileName, contentType, adAccountId, tokenId })
  transitionJobStatus("completed", { imageHash, previewUrl })
```

No `try/finally` gate release — there is no gate.

**Adaptive throttle:**

```
acquireMetaRequestSlot(accountKey):
  usage = getUsage(accountKey)                 // BUC; key-normalized (phase 02)
  if usage && usage.callCount >= BRAKE_PCT:    // single check — never a loop
     await waitFor(BRAKE_SLEEP_MS)             // 60s
  interval = max(envFloorMs, TIER_INTERVAL_MS[usage?.tier ?? "unknown"])
  loop:  SET throttle:<accountKey> 1 PX <interval> NX
         → OK ? return : sleep(PTTL) and retry
```

**Error routing** (order matters):

| Error | Action |
|---|---|
| `JobCancelledError` | transition `cancelled`, return normally (no retry, no failed) |
| `isFacebookRateLimitError` | `MetaRateLimitRetryError(waitMs = suggestedWaitMs(error.usage, fallback))` → rethrow → BullMQ retries after exactly `waitMs` |
| `isTransientFetchError` | rethrow → exponential backoff |
| `isMetaMediaRejectionError` | `UnrecoverableError(meta message)` — fail fast |
| else | `UnrecoverableError(message)` |

`metaAwareRetryDelayMs` now reads the wait off the error (`MetaRateLimitRetryError.waitMs`)
instead of returning a constant; `metaRateLimitDelayMs` is the fallback when Meta
sent no header.

**Kept:** `acquireMetaRequestSlot` (adapted), `MetaRateLimitRetryError` (+`waitMs`),
`JobCancelledError`, `isJobCancelled`, `metaAwareRetryDelayMs`, `shouldRetryLater`,
`buildRetryMessage`, `waitFor`, `worker.on("failed")`, the `backoffStrategy`
wiring, SIGINT/SIGTERM shutdown.

**Deleted:** `activeAccountKeys`, `resolveAccountKey`'s gate role (the function
stays — it still keys the throttle), `ACCOUNT_BUSY_RETRY_DELAY_MS`, the
`moveToDelayed`+`DelayedError` deferral, `syncLinesFromNas`, `SyncProgress`,
`retryMetaAware`'s `isMetaServiceError` branch, the proactive-pause throw, all
`updateProgress` calls.

## Related Code Files

**Modify:** `workers/media-upload-worker.ts` (renamed in phase 01)

**Read for context (do not edit):** `lib/media-upload/meta-images.ts`,
`meta-graph.ts`, `meta-usage.ts` (phase 02); `lib/media-upload/jobs.ts`,
`batches.ts`, `env.ts` (phase 01); `lib/webdav.server.ts`; `lib/resilient-fetch.ts`

## Implementation Steps

1. Rewrite imports: `uploadAdImage`; `isFacebookRateLimitError` +
   `isMetaMediaRejectionError`; `getUsage`/`suggestedWaitMs`;
   `fetchWebDavFileBuffer`; `transitionJobStatus`/`getMediaUploadJob`; `getBatch`.
   Drop `getNasFileMeta`/`streamNasFileLines`/`createEmptyAudience`/`uploadHashedUsers`.
2. **Delete the gate**: `activeAccountKeys`, `ACCOUNT_BUSY_RETRY_DELAY_MS`, the
   `moveToDelayed`/`DelayedError` branch, the `try/finally` release. `DelayedError`
   leaves the bullmq import.
3. Constants: `META_REQUEST_THROTTLE_PREFIX = "media-upload:meta-request-throttle"`,
   `DEFAULT_RETRY_DELAY_MS = 5_000`, `BRAKE_PCT = 90`, `BRAKE_SLEEP_MS = 60_000`,
   `TIER_INTERVAL_MS = { standard_access: 200, development_access: 15_000, unknown: 1_000 }`.
   Comment *why* 15s (both limits — see Key Insights), so nobody "optimizes" it to 12s.
4. `getBatchCached(batchId)` — module `Map`, no TTL (batches are immutable; the
   process is short-lived relative to a batch).
5. Rewrite the handler per the flow. Target ~70 lines.
6. Adapt `acquireMetaRequestSlot` per the pseudocode: `call_count` brake (single
   `if`), then the tier-derived interval floored by env.
7. Delete `syncLinesFromNas` + `SyncProgress`.
8. Trim `retryMetaAware` to the rate-limit branch; carry `waitMs` from
   `suggestedWaitMs(error.usage, config.metaRateLimitDelayMs)`.
9. `metaAwareRetryDelayMs(attemptsMade, error)` → `error.waitMs` when it's a
   `MetaRateLimitRetryError`, else the existing capped exponential backoff.
10. OOM guard after the read (catches a null-`fileSize` file that skipped the
    creation-time check).
11. Log prefixes `[audience-upload-worker]` → `[media-upload-worker]`. **Log tier
    on the first response per account, and `call_count` every 25 jobs** — the
    former explains the ETA to an operator, the latter is the evidence for tuning
    `UPLOAD_META_REQUEST_INTERVAL_MS` (see Key Insights).
12. Gate: `npx tsc --noEmit && npm run lint && npm test`, then the empirical runs below.

## Todo List

- [ ] Delete the gate (`activeAccountKeys`, busy-delay, DelayedError branch)
- [ ] Rewrite imports; drop audience/storage symbols
- [ ] Throttle prefix → `media-upload:*`; tier interval table; util brake
- [ ] `getBatchCached`
- [ ] Rewrite handler (guard → batch → read → OOM → throttle → POST → hash)
- [ ] Delete `syncLinesFromNas` / `SyncProgress` / proactive pause
- [ ] `retryMetaAware` + `metaAwareRetryDelayMs` read the wait from Meta's headers
- [ ] Log tier + util per account
- [ ] **Prove the throttle holds under concurrency** (below)
- [ ] < 200 lines; build gate green
- [ ] Commit message explains the gate reversal vs `6e34a33`/`0f8756f`

## Success Criteria

- **Throttle-under-concurrency proof (blocking):** `UPLOAD_WORKER_CONCURRENCY=4`,
  200 images, **one** ad account. Log every Meta request timestamp. Assert: **no
  two requests to the same account closer than the tier interval**, and **zero**
  rate-limit errors. This is the criterion that replaces the gate — if it fails,
  the gate removal is not safe and must be reconsidered, not patched over.
- Two ad accounts × 50 images → both progress concurrently; per-account spacing
  still holds independently.
- Single valid JPEG → `completed` with a non-null `imageHash`; visible in Ads
  Manager → Media.
- **Dev tier is the real path — test it for real** (all 5 accounts are dev tier;
  no stubbing needed): 40 images → worker logs `development_access`, requests land
  ~15s apart, **zero** 429s, ~10 min wall clock. This is the shipping
  configuration; treat a failure here as a phase blocker.
- Standard-tier path: no account available to test. Force it via a `TIER_INTERVAL_MS`
  override or a stubbed `getUsage` → confirm 200ms spacing. **Record that it is
  unverified against real Meta** — it's dead code until someone upgrades.
- `call_count` climbs across the run and is logged every 25 jobs. Record the
  observed value at job 25/50/100 in the completion note — that's the evidence for
  whether 15s is too conservative.
- Forced rate limit (code 17) → status `queued`, `nextRetryAt` ≈ now +
  `estimated_time_to_regain_access` **minutes** — verify the unit against the log,
  not the code.
- Corrupt `.jpg` → `failed` on the **first** attempt with Meta's message.
- Cancel a queued job → stays `cancelled`.
- `kill -9` mid-batch → restart → in-flight jobs retry and complete; batch counts
  self-consistent (`SCARD` sums == `total`); no duplicate assets beyond hash dedupe.
- `wc -l workers/media-upload-worker.ts` < 200.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| **Gate removal → 429 storm under concurrency** | Med × **High** | The blocking throttle proof above. `SET NX PX` is a correct min-interval mutex under N waiters; the test proves it rather than assuming |
| Tier misdetected (BUC header missing → `unknown`) → 1s interval on dev tier → **15× too fast** → immediate throttling | Med × **High** | Probe proves the header is present on both edges, and the tier arrives at page load. If it ever goes missing, the `call_count` brake + error-driven `estimated_time_to_regain_access` still bound it — degrades to slow, not broken |
| **`call_count` is absolute, not a %** → brake fires at 90 calls (~30% of quota) → ~3× slower than needed | Med × Med | Phase 02 step 1b settles it before this phase codes the brake. Fails safe |
| **The unreported ad-account score limit is real and stricter than assumed** | Low × Med | 15s = exactly 20 writes/300s, the documented dev cap. If 429s still appear, raise the env interval — no code change |
| Minutes confusion on `regainMinutes` → 60× wrong wait | Med × High | Isolated in `suggestedWaitMs` (phase 02) + a success criterion that reads the unit off a real log |
| Standard-tier path ships untested (no such account exists) | **High** × Low | It's inert until an upgrade; the dev path is what runs. Flagged in the criteria rather than pretended-tested |
| Thundering herd on TTL expiry at high concurrency | Low × Low | 4 waiters ≈ 4 wakeups/interval. Revisit only above ~20 |
| In-memory usage store + batch cache break under 2 worker processes | Med × Med | Single-process already required; make phase 06 state it loudly in the README |
| Whole file buffered × concurrency 4 | Low × Med | 100MB guard × 4 = 400MB worst case; document |
| `UnrecoverableError` swallows a transient error | Low × Low | Rate-limit + transient checks run first |
| A 21h dev-tier drain outlives the worker process | Med × Low | BullMQ persists; restart resumes. Covered by the `kill -9` criterion |

## Security Considerations

- Worker resolves tokens from the encrypted store by `tokenId` (now via the batch)
  — never log a decrypted token or the graph URL (it carries `access_token`).
- Verify `describeFetchError` doesn't print request URLs for `meta-graph` failures.
- Usage percentages/timers are non-secret — safe to log.
- NAS bytes go memory → Meta; nothing touches local disk (`shardTempDir` is gone).

## Next Steps

With phase 04, the backend is complete and end-to-end testable before UI work.
