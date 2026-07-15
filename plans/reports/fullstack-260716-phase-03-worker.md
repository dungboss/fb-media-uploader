# Phase 03 — Worker Rewrite (gate removal + adaptive pacing)

**Plan:** `plans/260716-0010-nas-images-to-fb-media-library/phase-03-worker-rewrite.md`
**Status:** completed

## Files changed (all under `workers/**`, per file ownership)

- `workers/media-upload-worker.ts` (162 lines, was a phase-01 stub) — rewritten. Entrypoint: `main()`, BullMQ `Worker` wiring, `processJob` (the guard→batch→read→OOM→throttle→POST→hash flow), `handleFailedJob`, `getBatchCached`, `isJobCancelled`, graceful shutdown. Guarded so `main()` only runs on direct execution (`fileURLToPath(import.meta.url) === process.argv[1]`), never on import.
- `workers/media-upload-throttle.ts` (100 lines, new) — pacing: `acquireThrottleSlot` (the Redis `SET NX PX` mutex primitive), `acquireMetaRequestSlot` (BUC-tier-aware wrapper), `resolveAccountKey`, `logUsageProgress`, `TIER_INTERVAL_MS`/`BRAKE_PCT`/`BRAKE_SLEEP_MS`.
- `workers/media-upload-retry.ts` (91 lines, new) — error classification/retry: `JobCancelledError`, `MetaRateLimitRetryError`, `translateUploadError`, `metaAwareRetryDelayMs`, `shouldRetryLater`, `buildRetryMessage`.
- `workers/media-upload-throttle.test.ts` (72 lines, new) — the blocking concurrency proof, against real Redis.
- `workers/media-upload-retry.test.ts` (120 lines, new) — pure-function coverage of error routing/backoff (no network, no mocks).

**Deviation from spec:** the doc says "Modify: `workers/media-upload-worker.ts`" (implying one file). At my draft the single-file version hit 360 lines against the hard `<200` success criterion — this workload (mutex + BUC pacing + error classification + BullMQ wiring) doesn't fit 200 lines of real logic with the rationale comments the task required. Split into 3 files, all under `workers/**` (within my ownership grant). This also let the throttle-proof test import a side-effect-free module directly instead of relying on the entrypoint guard trick for testability. `lib/media-upload/env.ts` was **not** touched — not required.

## Build gate

- `npx tsc --noEmit`: **pass**, 0 errors.
- `npm run lint`: **14 errors / 4 warnings, all pre-existing in `app/page.tsx` + 1 warning in `components/nas-folder-tree.tsx`** (matches the stated 14-error baseline exactly). **Zero new lint issues** from any file I touched.
- `npm test`: **38/38 pass** (5 files: 3 pre-existing phase 01/02 suites + my 2 new suites).
- `npm run build`: **pass** (Next.js 16.2.9, Turbopack). Includes phase 04's concurrently-added routes (`/api/upload-batches/**`, `/api/upload-jobs/[jobId]/retry`) compiling fine — no `.next/dev/types` staleness hit.

## The blocking throttle proof — actual measured output

Per your explicit override of the phase doc's success criteria: **did not** run 200/40-image real-Meta drains (would burn dev-tier quota and litter the real media library). Proved the mutex mechanism instead, against real Redis (port 6379, DBngin), zero network calls.

Test: `workers/media-upload-throttle.test.ts` — 8 concurrent waiters × 5 acquisitions each = 40 total acquisitions on one `accountKey`, `intervalMs=100`. Assertions: (1) all 40 acquisitions land, (2) min gap between any two sorted timestamps ≥ 95ms, (3) total span ≥ 39×95ms (rules out a no-op throttle trivially passing). **Passed** in 4.9s.

Standalone probe (same scenario, run outside vitest for raw numbers):

```
gaps (ms): 201,101,202,101,102,201,100,101,102,101,101,107,96,101,102,202,101,101,
           101,101,101,101,102,101,101,101,202,100,101,202,100,101,101,102,102,
           100,101,102,201
min gap: 96ms   max gap: 202ms   total span: 4648ms (expected ≥ 3900ms)
```

Reading: min gap 96ms ≥ the 95ms floor (100ms interval − 5ms jitter slack) — **no acquisition ever landed faster than the configured interval, under 8 concurrent acquirers**. Max gap 202ms (≈2× interval) confirms the documented "thundering herd at TTL expiry" wart (waiters occasionally wake together and the loser re-sleeps a full interval) — expected, harmless at concurrency 4-8, not a correctness issue. **Gate removal is safe under the load-bearing conclusion the throttle-proof test exists to reach.**

Also ran the worker directly (`npx tsx --env-file=.env workers/media-upload-worker.ts`, idle, no jobs enqueued) to confirm `main()` fires on direct execution and shuts down cleanly on SIGTERM:
```
[media-upload-worker] listening queue=media-upload concurrency=4
[media-upload-worker] shutting down on SIGTERM
```

## What was NOT verified against real Meta (by your explicit instruction, not an oversight)

- 200-image / 4-worker / one-account 429-storm run (phase doc's literal blocking criterion) — replaced by the Redis-only proof above.
- 40-image dev-tier real run (~15s spacing, zero 429s, ~10min wall clock) — phase doc calls this "the shipping configuration... treat a failure here as a phase blocker." Not run; would consume ~13% of the ~300/hr dev quota and create 40 junk assets in the real Ads Manager library.
- Two-account concurrent progress, single valid/corrupt JPEG round-trip, `kill -9` mid-batch restart-safety — all require either real Meta writes or a real NAS file; not attempted.
- Standard-tier 200ms spacing — no such account exists (per plan.md); code path (`TIER_INTERVAL_MS.standard_access = 200`) is written per spec but genuinely untested, same as the original phase doc already flagged as unavoidable.

These gaps are exactly what the delegating instructions called out as acceptable/expected; flagging so it's an explicit decision on record, not a silent gap.

## Gate-reversal rationale — where it lives

Written into `workers/media-upload-worker.ts`'s header comment (the "GATE REMOVAL" block) and echoed in `workers/media-upload-throttle.ts`'s header, explaining the reversal of `6e34a33`/`0f8756f` as a workload-shape change (few×hours → thousands×seconds), not a correction of a prior mistake. Also here, so it's discoverable without opening the file.

## Design notes / how the code maps to the spec

- **Error routing** in `media-upload-retry.ts::translateUploadError` follows the doc's table order exactly: `UnrecoverableError` passthrough (no double-wrap) → rate limit (carries `suggestedWaitMs`) → transient (rethrown as-is) → media rejection / else (both fail fast, checked as a genuine branch rather than a discarded call, so the routing table stays literal in code).
- **Brake**: single `if`, not `while` (`acquireMetaRequestSlot`), exactly per spec — a loop would deadlock since `call_count` only advances on a response.
- **Interval formula**: `max(envFloorMs, TIER_INTERVAL_MS[tier])`, exactly the pseudocode in the phase doc. Noted for the record: with the code default `UPLOAD_META_REQUEST_INTERVAL_MS=1000ms`, the `standard_access` row (200ms) is dominated by the 1000ms floor unless the operator explicitly lowers the env var below 200 — this matches the doc's own success criterion phrasing ("force it via a TIER_INTERVAL_MS override... no account available to test" — i.e., standard tier is expected to need an explicit override to observe its true 200ms pace). Implemented literally per the phase-doc pseudocode; flagging in case this reads as surprising later.
- **Cancellation**: `JobCancelledError` checked once (batch fetched, before NAS read) per the "single check, not a loop" design; a cancel landing mid-POST is deliberately not caught (asset genuinely lands in the library — no fake rollback).
- **`getBatchCached`**: unbounded module `Map`, no TTL — matches spec (batches immutable after creation, process short-lived relative to a batch).
- **Test additions beyond the mandated throttle proof**: added `media-upload-retry.test.ts` (13 pure-function tests, no mocks/network) covering the error-routing table, backoff growth, and retry-message construction — this is the piece most likely to silently misroute an error and had no other automated coverage.

## Unresolved questions

1. Should `UPLOAD_META_REQUEST_INTERVAL_MS`'s default (1000ms) be lowered so the `standard_access` 200ms row isn't dominated by the floor out of the box? Left as-is (matches the phase doc's literal formula and its own "force via override" phrasing for standard-tier testing), but worth a decision before an upgrade to Standard access actually happens.
2. The 40-image real dev-tier run and the 2-account/corrupt-file/`kill -9` restart-safety criteria remain unverified against live Meta/NAS — will need a deliberate, budgeted real-world test pass before this ships, per your instruction to not do that in this phase.

**Status:** DONE
**Summary:** Worker rewritten and split across 3 files under `workers/**` (162/100/91 lines, all <200). Gate removed, replaced by BUC-tier-adaptive Redis throttle; concurrency-safety proven against real Redis (40 acquisitions, 8 concurrent waiters, min gap 96ms ≥ 95ms floor). Full build gate green, zero new lint issues (14-error baseline unchanged), 38/38 tests pass.
**Concerns/Blockers:** None blocking. Two unresolved questions above (env-floor interaction with standard tier; still-pending real-Meta/real-NAS verification for criteria this phase was explicitly told not to run) are informational, not blockers.
