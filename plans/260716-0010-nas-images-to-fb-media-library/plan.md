---
title: "Pivot: NAS CSV audiences → NAS images to FB Ads Media Library"
description: "Replace the Custom Audience flow with folder-scale image upload from NAS WebDAV to act_X/adimages, paced by Meta's own usage headers."
status: pending
priority: P1
effort: 15h
branch: main
tags: [pivot, meta-api, adimages, nas, webdav, bullmq, rate-limiting, refactor]
created: 2026-07-16
updated: 2026-07-16
---

# NAS Images → Facebook Ads Media Library

Pivot from "create Custom Audiences from NAS CSV" to "upload a NAS folder of
images into the Ads Media Library" (`POST act_X/adimages`). Audience code removed
entirely (git history only). **Images only.** Target scale: **thousands of images
per folder**, drained reliably over minutes-to-hours.

## ⚠️ Rate-limit ground truth — measured, not derived

**A read-only probe (2026-07-16) against the user's real token settles this.**
Probe results override both the research report §4 (which is void) and my earlier
doc-derived model. Docs for reference only:
[Marketing API](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/) ·
[Graph API](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/).

**1. All 5 ad accounts are `development_access`.** (Miho 1–5:
`act_1354278695880333`, `act_660062069985442`, `act_679927437761688`,
`act_1874694576280943`, `act_1569761797025413`.)
**The slow case is the only case.** Long-drain reliability — 7-day TTL, batch
counters, restart safety, O(1) progress — is load-bearing, not insurance.

**2. `X-Ad-Account-Usage` is ABSENT** on both `me/adaccounts` and
`act_X/adimages`. Zero occurrences. **The `acc_id_util_pct` / `reset_time_duration`
/ 300s-decay-score model has no input and is removed from the plan.** The score
limit may still exist server-side unreported — that possibility only makes our
pacing more conservative (see phase 03), it is never relied upon.

**3. `X-Business-Use-Case-Usage` is present on both edges and carries everything.**
Real payload from `GET act_679927437761688/adimages`:

```json
{"679927437761688":[{"type":"ads_management","call_count":0,"total_cputime":0,
  "total_time":0,"estimated_time_to_regain_access":0,
  "ads_api_access_tier":"development_access"}]}
```

Keyed by **bare ad account id — no `act_` prefix** (a parsing trap; our account
keys are `act:<id>`). `ads_api_access_tier` lives **inside the BUC entry**, not in
a separate header. `me/adaccounts` returns all 5 accounts' entries at once → **the
UI learns the tier at page load for free, no probe call.**

**4. `adimages` reports into the `ads_management` BUC bucket.** The edge is
rate-limited and tells us so. Header-driven pacing survives — its input is BUC.

**5. Therefore:**

| Tier | BUC quota (per ad account) | Our pacing | 5000 images |
|---|---|---|---|
| **`development_access`** ← **what ships** | `300 + 40 × active_ads` calls/hr | 15s interval → ~240/hr | **~21 hours** |
| `standard_access` (if upgraded) | `100000 + 40 × active_ads` calls/hr | 200ms floor → ~18,000/hr | ~17 min |

**~75× spread.** `call_count: 0` today — the accounts are fresh, no head start.
Quota scales with `active_ads`, which we neither know nor control → **ETA is
computed from observed throughput, never from the formula**.

**The upgrade path is the only real lever.** Requesting Standard access beats
anything we can write by ~75×. The UI must say so next to the ETA (phase 05), not
bury it.

## Why we do NOT spread a batch across the 5 ad accounts

BUC limits are per ad account, so 5 accounts looks like 5× throughput. **It is
not, for this use case — do not re-propose it:**

1. **Ad images are per-account assets.** An `image_hash` from `act_A` is not
   usable in `act_B`'s creatives.
2. **Meta's own API proves it:** `adimages` ships a `copy_from
   { source_account_id, hash }` parameter (research §1). A copy API exists only
   because assets do not cross accounts.
3. **`copy_from` doesn't help anyway.** Our bottleneck is *calls/hour against the
   destination account* — a copy is still a call against that quota. It saves
   bytes, not quota.
4. **The legitimate case is already handled.** If the user genuinely wants the
   same library in all 5 accounts, that's 5 batches × 5000 uploads, and our
   throttle is already per-account, so they drain in parallel. The lever is
   pulled; no design change needed.

Spreading one logical batch across accounts would put images where they cannot be
used. That is a correctness bug wearing a performance costume.

## Scope decisions (locked)

| Decision | Value |
|---|---|
| Media types | Images only: `.jpg .jpeg .png .gif`. No webp/avif |
| Upload shape | Single-shot multipart → `hash`. No resume, no chunking |
| Rename | `lib/audience-upload/` → `lib/media-upload/`; `MediaUploadJob`; `workers/media-upload-worker.ts`; script `worker:media` |
| Redis | Token store keys **unchanged** (`audience-upload:fb-tokens`). Jobs/batches use `media-upload:*`. Old audience jobs dropped, no migration |
| **Primary UX** | **Pick a NAS folder → the server enumerates it.** Paths never cross the wire at scale |
| Execution unit | **One BullMQ job per image** (retry isolation) + a **batch record** for UX aggregation. Not BullMQ flows |
| Pacing | **BUC-header-driven**, per ad account. Dev-tier 15s interval is the shipping path; `call_count` brake + `estimated_time_to_regain_access` for exact waits |
| Multi-account spreading | **Rejected** — images are per-account assets (see above) |
| Per-account gate | **Removed** (reverses `6e34a33`/`0f8756f` — rationale in phase 03) |
| Byte-offset resume | Removed (fields, UI, README) |
| Image size limit | Never client-validated against a guess. Meta's error verbatim. 100MB **OOM guard** only |
| Tests | Minimal vitest: response parser + `resolveMediaType`. No mocks, no coverage gates |

## User answers to the planner's open questions (2026-07-16) — locked

| Question | Answer | Consequence |
|---|---|---|
| Is Standard access attainable? | **Yes — user will apply** | Phase 05 **keeps** the upgrade callout with a link. It is actionable advice, not salt in the wound. The ~75× lever is real for this user. |
| Is a 21h drain acceptable? | **Yes — runs overnight** | Phase 05 optimises for **durability + after-the-fact failure review**, NOT realtime watching. Nobody is staring at the bar. Failed-first paging matters more than live progress. Do not spend effort on realtime polish. |
| Branch strategy | **Work directly on `main`** (user chose over a feature branch, knowing the rollback trade-off) | One commit per phase still gives `git revert` granularity. Build gate green per phase is now the *only* safety net — do not merge a red phase. |

## Phases

| # | Phase | Status | Effort | Depends on |
|---|-------|--------|--------|-----------|
| 01 | [Foundation: rename, types, batches, jobs, vitest](phase-01-foundation-rename-and-types.md) | pending | 3.5h | — |
| 02 | [Meta client: graph, usage headers, adimages](phase-02-meta-image-client.md) | pending | 3h | 01 |
| 03 | [Worker: gate removal + adaptive pacing](phase-03-worker-rewrite.md) | pending | 2h | 02 |
| 04 | [API: folder enumeration, batches, paged jobs](phase-04-api-routes.md) | pending | 2h | 02 |
| 05 | [UI: batch-centric dashboard](phase-05-ui-rewrite.md) | pending | 4h | 04 |
| 06 | [README, docs, dependency cleanup](phase-06-docs-and-cleanup.md) | pending | 0.5h | 01–05 |

**Parallel-safe:** 03 (`workers/*`) and 04 (`app/api/*`) own disjoint files.

**Build gate:** every phase ends green on
`npx tsc --noEmit && npm run lint && npm test && npm run build`.

## Dependency graph

```
01 foundation ──► 02 meta client ──┬─► 03 worker ──┐
   (+vitest)         (+usage hdrs) └─► 04 routes ──┴─► 05 UI ──► 06 docs
```

## Scale architecture

```
NAS folder ──PROPFIND(Depth:1)──► server enumerates + filters images
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

**O(1) batch progress:** per-status Redis SETs (`media-upload:batch:<id>:status:<s>`).
`SCARD` = count, no scanning. Set membership is **idempotent**, so retries and
crashes cannot corrupt counters — an `HINCRBY` delta scheme can.

**Why one job per image survives at 5000:** BullMQ/Redis handle 5000 jobs
trivially (~2MB). The bottleneck was never the queue — it was rendering and
polling 5000 rows, fixed in the UI/API contract, not the execution model.
Per-image retry isolation is worth keeping: one corrupt file must not stall 4999.

**Why the request stays small:** the client sends a folder path, not 5000 paths.
This also kills the "select all 5000 checkboxes" UI problem and any need to chunk
the create call.

## Key risks (detail per phase)

1. ~~**`adimages` POST response shape still unverified.**~~ **RESOLVED 2026-07-16
   by a real POST** (test image → Miho 5 → deleted). **The response is NESTED and
   the research report was wrong:**

   ```json
   {"images":{"<field_name>":{"hash":"2dd5a641…","height":600,"width":600,
     "url":"…","url_128":"…","url_256":"…","url_256_height":"260",
     "url_256_width":"260","name":"<field_name>"}}}
   ```

   **The key inside `images{}` is the multipart FIELD NAME the client chose** (we
   sent `probe-test-image.png` and got that key back). The parser must read the
   first/only entry, never hard-code a field name. The read edge's flat
   `data[{hash,name,width,height,id}]` was indeed no evidence for the write edge —
   they differ, exactly as feared. Keep the tolerant parser: the both-shapes test
   is now a regression guard, not a hedge.

   Also wrong in the report: **delete is `DELETE act_X/adimages?hash=<hash>`** →
   `{"success":true}`. Not `DELETE /{hash}`. Verified.

2. **`call_count` units — strong evidence for PERCENTAGE, not settled.** After 2
   writes (POST + DELETE) on a fresh account, `call_count` was still `0`. An
   absolute counter would read `2`; a percentage of the ~300/hr dev quota reads
   `0.67 → 0`. Treat as percentage, keep the field named `callCount`, keep the
   brake fail-safe (early brake = slow, never wrong). Phase 02 step 1b's counted
   burst can still confirm.
3. **Gate removal → 429 storm** — the Redis `SET NX PX` throttle must hold under
   4 concurrent workers on one account. Phase 03 proves it before merge.
4. **Dev-tier drain ≈ 21h** — the 24h job TTL would expire still-queued jobs
   mid-drain. Raised to 7 days in phase 01.
5. **An unreported ad-account score limit may still exist** (`X-Ad-Account-Usage`
   absent ≠ limit absent). Phase 03's 15s dev-tier interval is chosen to satisfy
   it anyway (≤20 writes/300s), so we are covered whether or not it applies.

## Rollback

One commit per phase on a feature branch; rollback = `git revert`. Redis is
rollback-safe: new key prefixes (`media-upload:*`), token store untouched, old
audience jobs TTL out on their own. No migration to undo.
