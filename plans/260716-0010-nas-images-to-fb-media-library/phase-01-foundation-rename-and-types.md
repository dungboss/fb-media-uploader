# Phase 01 — Foundation: rename, types, batches, jobs, vitest

## Context Links

- Overview: [plan.md](plan.md) — read the **rate-limit findings** first; they drive the TTL and batch design
- Research: `plans/reports/researcher-260715-2332-meta-media-upload-api.md`
- Current job type: `lib/audience-upload/types.ts` · Current CRUD: `lib/audience-upload/jobs.ts`

## Overview

- **Priority:** P1 (blocks every other phase)
- **Status:** pending
- **Effort:** 3.5h

Rename the module, replace the job type with an images-only `MediaUploadJob`, add
the **batch** aggregate that makes thousands-scale tractable, add image
media-type detection, trim env of hash-era knobs, stand up vitest.

## Key Insights

- `lib/audience-upload/facebook-error.ts` **already** holds `FacebookApiError`.
  `env.ts` and `jobs.ts` import it via `@/app/api/audiences/meta` (a re-export) —
  a lib→app/api inversion. Fix here; phase 02 deletes that module.
- `lib/audience-upload/storage.ts` exists only to hash CSV lines over a 10MB
  range loop. Images are single-shot → **delete the file**. Do not port the loop.
- WebDAV PROPFIND nulls out `application/octet-stream`
  (`lib/webdav.server.ts:126`), so `mimeType` is frequently `null` on a NAS.
  **Extension is the primary signal.**
- **Counting 5000 jobs must never scan 5000 hashes.** Per-status Redis SETs give
  `SCARD` = O(1). Sets are **idempotent** — a job re-entering `completed` after a
  retry is a no-op, whereas an `HINCRBY +1/-1` delta scheme double-counts on any
  crash between the hash write and the counter write. Idempotency is why sets win.
- **`jobTtlSeconds = 24h` is a real bug at this scale, and the probe proves it's
  not hypothetical.** `refreshJobExpiry` only runs on patch, and a queued job
  isn't patched until it runs. All 5 ad accounts measured `development_access`
  (plan.md) → a 5000-image drain is **~21h, every time** — inside 24h only by 3
  hours. One throttle stall, one worker restart, one 6000-image folder, and the
  tail jobs **expire while still queued** and vanish mid-drain. → 7 days.
- `MAX_RECENT_JOBS = 20` is meaningless once jobs are grouped by batch — the
  recent-jobs list is replaced by a recent-**batches** list.

## Requirements

**Functional**
- `MediaUploadJob`: no audience/offset/line fields; carries `batchId`.
- `MediaUploadBatch`: aggregate with O(1) status counts.
- `resolveMediaType(entry)` → `"image" | null`; extension first, mime fallback.
- `createMediaUploadJobs` creates a batch + N jobs in one pipeline.
- `transitionJobStatus` is the **single** writer of job status + batch sets.
- New key prefix `media-upload:*`; token store keys untouched.
- One-shot NAS file read.

**Non-functional**
- Every file < 200 lines. kebab-case. Modify in place.
- `types.ts` import-safe for client components (pure types, no node imports).
- `lib/**` must not import from `app/**`.
- `npm test` green and part of the gate from this phase onward.

## Architecture

**Redis key map** (all new except the token key):

| Key | Type | Purpose |
|---|---|---|
| `media-upload:job:<jobId>` | hash | job state |
| `media-upload:batch:<batchId>` | hash | batch metadata + `total` |
| `media-upload:batch:<batchId>:jobs` | list | job ids, creation order (enumerate/delete) |
| `media-upload:batch:<batchId>:status:<status>` | set | `SCARD` = O(1) count; `SSCAN` = paged rows |
| `media-upload:recent-batches` | list | batch ids, newest first (cap 50) |
| `media-upload:meta-request-throttle:<accountKey>` | string | phase 03 throttle |
| `audience-upload:fb-tokens` | hash | **UNCHANGED — do not rename** |

**Types** (`lib/media-upload/types.ts`):

```ts
export type MediaUploadJobStatus =
  | "queued" | "processing" | "completed" | "failed" | "cancelled";

export const MEDIA_UPLOAD_JOB_STATUSES = [
  "queued", "processing", "completed", "failed", "cancelled",
] as const satisfies readonly MediaUploadJobStatus[];

export interface MediaUploadJob {
  id: string;
  batchId: string;
  status: MediaUploadJobStatus;
  nasFilePath: string;
  fileName: string;
  fileSize: number | null;      // PROPFIND; display + OOM guard only
  imageHash: string | null;     // Meta result
  previewUrl: string | null;    // Meta url_128
  errorMessage: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaUploadBatch {
  id: string;
  nasFolderPath: string | null; // null when built from an explicit file list
  total: number;
  adAccountId: string | null;
  adAccountName: string | null;
  appName: string | null;
  tokenId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaUploadBatchCounts {
  queued: number; processing: number;
  completed: number; failed: number; cancelled: number;
}

export interface MediaUploadJobPayload { jobId: string; }
```

**Ad account / token move to the batch.** They were per-job; at 5000 jobs that is
5000 copies of the same 4 strings. The worker resolves them via `batchId` (one
extra `hgetall` per job, cached per batch in-process). Cuts job hash size ~40%
and makes "this folder → that account" the honest model.

**Dropped job fields:** `kind`/`audienceId` (feature gone); `name`/`description`
(no per-file title in a 5000-file batch — filename is the identity);
`startOffsetBytes`/`syncedByteOffset`/`lastSessionId` (no resume);
`syncedHashCount`/`syncedLines`/`processedLines`/`totalLines` (no lines);
`processedBytes`/`totalBytes` (a single POST has no sub-progress).

**`transitionJobStatus` — the one status writer:**

```
transitionJobStatus(jobId, next, patch?)
  job = HGETALL job:<id>            // has batchId + current status
  pipeline:
    HSET   job:<id> status=next, updatedAt, ...patch
    SREM   batch:<b>:status:<prev> <id>      // no-op if absent
    SADD   batch:<b>:status:<next> <id>      // idempotent
    EXPIRE job:<id> / batch keys  (ttl)
  exec
```

Every status change routes through it — worker, API, cancel, retry. One code path
= one place for the invariant "a job is in exactly one status set". Callers must
never `HSET status` directly.

**Batch counts:** `SCARD` × 5 = 5 O(1) ops regardless of batch size.

## Related Code Files

**Rename (git mv, then edit):**
- `lib/audience-upload/` → `lib/media-upload/`
- `workers/audience-upload-worker.ts` → `workers/media-upload-worker.ts` (body in phase 03)

**Create:**
- `lib/media-upload/media-type.ts` — `resolveMediaType`, `IMAGE_EXTENSIONS`
- `lib/media-upload/batches.ts` — batch CRUD, `SCARD` counts, paged job ids
- `lib/media-upload/media-type.test.ts`
- `vitest.config.ts`

**Modify:**
- `lib/media-upload/types.ts` — replace wholesale
- `lib/media-upload/jobs.ts` — new prefix, `transitionJobStatus`, batch-aware create, drop `resumeAudienceUploadJob`
- `lib/media-upload/env.ts` — config diff below; import `FacebookApiError` from `./facebook-error`
- `lib/media-upload/queue.ts` — renamed exports/globals, job name `upload-ad-image`, **`addBulk` helper**
- `lib/media-upload/redis.ts` — rename global
- `lib/media-upload/token-store.ts` — **import path only.** `TOKENS_KEY = "audience-upload:fb-tokens"` **MUST NOT CHANGE**
- `lib/webdav.ts` — image sets; `isSupportedWebDavUploadFile` delegates to `resolveMediaType`
- `lib/webdav.server.ts` — add `fetchWebDavFileBuffer`
- `package.json` — `worker:media`, `test`, vitest devDep

**Delete:** `lib/media-upload/storage.ts`, `test_emails.txt`

**Env config diff:**

| Key | Action | Why |
|---|---|---|
| `metaBatchSize`, `metaMaxHashesPerSecond` | remove | hash-era |
| `proactivePauseBytes` | remove | 1h self-pause is nonsense for a 2MB POST |
| `shardTempDir`, `presignedUrlTtlSeconds` | remove | dead (no S3/dropzone caller) |
| `jobTtlSeconds` | **7 days** (was 24h) | dev-tier drain ≈ 21h — see Key Insights |
| `metaRequestIntervalMs` | keep as a **floor**, default **1000ms** | phase 03 adapts from tier/headers |
| `metaRateLimitDelayMs` | keep as **fallback only**, default **5min** | used only when Meta sends no usage header |
| `jobAttempts` | default **10** | adaptive waits mean fewer, better-timed attempts |
| `queueName` | default `media-upload` | new queue; old jobs orphaned by design |
| `maxFileBytes` | **new**, `UPLOAD_MAX_FILE_BYTES`, 100MB | OOM guard — **not** Meta's limit |
| `maxBatchFiles` | **new**, `UPLOAD_MAX_BATCH_FILES`, **10000** | sanity bound (was 100 — far too low) |
| `workerConcurrency`, `workerRateLimit*` | unchanged | still correct |

## Implementation Steps

1. `git mv lib/audience-upload lib/media-upload` and
   `git mv workers/audience-upload-worker.ts workers/media-upload-worker.ts`.
   Build is red until step 15 — expected.
2. Fix the inversion: `env.ts` + `jobs.ts` import `FacebookApiError` from `./facebook-error`.
3. `git rm lib/media-upload/storage.ts test_emails.txt`.
4. Rewrite `types.ts` per the block above.
5. Create `media-type.ts`:
   ```ts
   export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
   export function resolveMediaType(
     entry: { name: string; mimeType?: string | null; isDirectory?: boolean }
   ): "image" | null;
   ```
   Extension first (lowercased, after the last `.`); else `image/jpeg|png|gif`
   mime prefix; else `null`. Pure — no node imports (a client component uses it).
   Formats exactly as research-confirmed (JPEG/PNG/GIF); webp/avif excluded.
6. `lib/webdav.ts`: delete the CSV/TXT sets; `isSupportedWebDavUploadFile(entry)` =
   `!entry.isDirectory && resolveMediaType(entry) !== null`. Keep the export name
   (the NAS dialog imports it). Drop the CSV/TXT branches in `getWebDavEntryTypeLabel`.
7. `lib/webdav.server.ts`: add
   `fetchWebDavFileBuffer(path): Promise<{ buffer: ArrayBuffer; contentType: string | null }>`
   — model on `fetchWebDavFileRange` minus `Range`: `resilientFetch`,
   `Accept-Encoding: identity`, `{ label: "webdav-file" }`, throw on `!ok`. Leave
   every existing export untouched.
8. Create `batches.ts`:
   - `createBatch(input)`, `getBatch(id)`, `getBatchCounts(id)` (5 × `SCARD`),
     `listRecentBatches(limit=50)`, `deleteBatch(id)` (LRANGE job ids → pipeline
     DEL hashes + status sets + list + LREM from recent),
     `listBatchJobIds({ batchId, status?, cursor, limit })` (`SSCAN` when filtered
     by status, `LRANGE` when not).
   - `refreshBatchExpiry(id)` — TTL on the batch hash + list + all 5 status sets.
9. Rewrite `jobs.ts`:
   - Keys per the map. Keep the existing `parseInteger` / `parseNullableInteger` /
     `parseEnum` / `toRedisHashPatch` helpers (DRY).
   - `createMediaUploadJobs({ files, nasFolderPath, adAccountId, adAccountName, appName, tokenId })`
     → `{ batch, jobs, skipped }`. Per file: reject empty path,
     `resolveMediaType() === null`, or `fileSize > maxFileBytes` → `skipped`
     (don't throw). Throw `FacebookApiError(400)` only when `files` is empty,
     **every** file is rejected, or `files.length > maxBatchFiles`.
     **One pipeline** for the batch hash + N job hashes + N `RPUSH` + N `SADD`
     into `status:queued` + expiries.
   - `transitionJobStatus(jobId, next, patch?)` per the Architecture block — the
     only status writer.
   - Keep `getMediaUploadJob`, `getMediaUploadJobs(ids[])` (pipelined `hgetall`),
     `cancelMediaUploadJob`, `deleteMediaUploadJob` — routed through
     `transitionJobStatus` where they change status.
   - `markCompleted`/`markFailed` become thin `transitionJobStatus` wrappers.
   - **Delete `resumeAudienceUploadJob`** — retry = re-enqueue the same id (phase 04).
   - Drop `listRecentAudienceUploadJobs` / `MAX_RECENT_JOBS` (superseded by batches).
10. `queue.ts` / `redis.ts`: rename exports + globals (`__mediaUploadQueue__`,
    `__mediaUploadRedis__`). Job name `upload-ad-image`. Add
    `enqueueMediaUploadJobs(jobIds[])` using **`queue.addBulk`** — 5000 individual
    `add` calls will not fit the route budget.
11. `package.json`: `"worker:media": "tsx --env-file=.env workers/media-upload-worker.ts"`,
    `"test": "vitest run"`. `npm i -D vitest`.
12. `vitest.config.ts` — minimal: `environment: "node"`, `@/` alias matching
    `tsconfig.json`. No coverage config, no setup files.
13. `media-type.test.ts` — the table in Success Criteria.
14. `workers/media-upload-worker.ts`: keep-compiling edits only (imports +
    renamed symbols); stub `main()` with a `TODO phase 03` throw if faster. It
    **must** typecheck.
15. Gate: `npx tsc --noEmit && npm run lint && npm test && npm run build`.

## Todo List

- [ ] `git mv` lib dir + worker file
- [ ] Fix `FacebookApiError` import inversion
- [ ] Delete `storage.ts`, `test_emails.txt`
- [ ] Rewrite `types.ts` (job + batch + counts)
- [ ] `media-type.ts` + `media-type.test.ts`
- [ ] `lib/webdav.ts` filter → images
- [ ] `fetchWebDavFileBuffer`
- [ ] `batches.ts` (CRUD, SCARD counts, paged ids, TTL)
- [ ] `jobs.ts` (pipeline create, `transitionJobStatus`, drop resume/recent-jobs)
- [ ] `env.ts` diff (TTL 7d, maxBatchFiles 10000, maxFileBytes)
- [ ] `queue.ts` `addBulk` + renames; `redis.ts` rename
- [ ] `token-store.ts` import path only — verify `TOKENS_KEY` byte-identical
- [ ] vitest + `npm test` script + config
- [ ] Build gate green

## Success Criteria

- `grep -rn "audience-upload" lib/ workers/ package.json` → **only**
  `token-store.ts` `TOKENS_KEY`.
- `grep -rn "from \"@/app/api" lib/` → nothing.
- Status is written only inside `transitionJobStatus` (grep `jobs.ts` for `hset`).
- `npm test` green:

  | `resolveMediaType` input | Expect |
  |---|---|
  | `{name:"a.JPG"}` | `"image"` (case-insensitive) |
  | `{name:"a.jpeg"}` / `.png` / `.gif` | `"image"` |
  | `{name:"a.csv"}` / `.mp4` / `.webp` | `null` |
  | `{name:"a", mimeType:"image/png"}` | `"image"` |
  | `{name:"a.jpg", isDirectory:true}` | `null` |
  | `{name:"archive.tar.gz"}` | `null` (last extension only) |
  | `{name:".jpg"}` | `null` or `"image"` — assert whichever, don't leave it undefined |

- `createMediaUploadJobs` with 3 valid + 1 `.csv` → batch `total:3`, 3 jobs, 1 skipped, no throw.
- 5000-file create → **one** pipeline round-trip, < 2s; `getBatchCounts` returns
  `{queued:5000, ...}` in < 10ms.
- `transitionJobStatus(id, "completed")` twice → `SCARD` stays 1 (idempotent).
- Existing tokens still decrypt (`GET /api/facebook/tokens` unchanged).
- Build gate green.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| `TOKENS_KEY` renamed with the module → **all stored tokens orphaned** | Low × **High** | Explicit step + criteria grep. `HGETALL audience-upload:fb-tokens` before/after. Only recovery is re-adding tokens by hand |
| A caller bypasses `transitionJobStatus` → status sets drift from hashes → wrong counts forever | **Med** × **High** | Single writer + grep criterion. Counts are UI-only, so a drift is cosmetic, not data loss; repair = rebuild sets from hashes. Note that in `batches.ts` |
| 5000-job pipeline blows the Redis request buffer | Low × Med | ~20k small commands ≈ few MB; ioredis chunks writes. Verify at the 10000 cap |
| 7-day TTL × several 5000-batches → Redis growth | Med × Low | ~2MB/batch; 10 batches ≈ 20MB. `deleteBatch` frees it. Revisit only if measured |
| Batch-level token/account means one batch can't span accounts | Low × Low | Matches the UX (one folder → one account). Two accounts = two batches |
| vitest + Next 16 config friction (aliases, ESM) | Med × Low | Node environment only, no React tests. If the `@/` alias fights back, use relative imports in the 2 test files |

## Security Considerations

- Token store encryption path untouched — same key, same AES-256-GCM. Do not
  "improve" it here.
- `nasFilePath` / `nasFolderPath` must pass `normalizeWebDavPath` (strips `..`)
  **before** persisting; reject absolute URLs.
- No token/secret in job or batch hashes — only `tokenId` (a store reference).

## Next Steps

Unblocks phase 02, and through it everything else.
