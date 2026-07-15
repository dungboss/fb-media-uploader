# Phase 04 — API: folder enumeration, batches, paged jobs

## Context Links

- Overview: [plan.md](plan.md)
- Depends on [phase 02](phase-02-meta-image-client.md); parallel with [phase 03](phase-03-worker-rewrite.md) — disjoint files
- Convention reference: the existing `app/api/**` handlers are the authoritative
  in-repo Next 16.2.9 pattern (`AGENTS.md` warns training data is stale; the
  bundled next docs are unreadable here)

## Overview

- **Priority:** P1
- **Status:** pending
- **Effort:** 2h

Replace one-file-per-job POST with **folder enumeration server-side**, expose
batch aggregates for the UI poll, and page job rows server-side.

## Key Insights

- **Don't send 5000 paths — send the folder.** The coordinator asked me to check
  payload size and chunk the create call. Better: delete the problem. The server
  already PROPFINDs (`fetchWebDavDirectoryResponse`), so
  `{ nasFolderPath }` (~50 bytes) replaces ~500KB–2MB of JSON. No chunking, no
  body-size limit, no multi-request batch assembly.
  It also kills the UI problem: nobody checkbox-selects 3000 of 5000 files — at
  this scale "select all" *means* "the folder".
- Explicit `{ files }` stays for genuine sub-selection, capped at **500 per
  request** (no chunking — anyone hand-picking >500 should pick the folder).
- **The 2s poll cannot return 5000 rows.** Split the contract: poll **batches**
  (O(1) `SCARD` counts, ~10 rows, tiny) and fetch **rows** on demand, paged and
  status-filtered. This is why phase 01 built per-status sets.
- Default row filter is **failed-first**: out of 5000, only failures need action.
  Nobody scrolls 4988 successes — which is also why this needs no virtualization.
- **PROPFIND Depth:1 only.** Non-recursive: bounded cost, no surprise crawl of a
  10-level tree. Recursion is a follow-up if asked.
- `enqueueMediaUploadJobs` must use BullMQ `addBulk` (phase 01) — 5000 individual
  `add` round-trips would not fit `maxDuration = 60`.
- **The access tier needs no new endpoint.** `GET /api/facebook/ad-accounts`
  already calls `me/adaccounts`, whose `X-Business-Use-Case-Usage` header carries
  `ads_api_access_tier` for **all 5 accounts at once** (probe-verified). Phase 02
  puts `tier` on `AdAccountListItem`; this phase just doesn't drop it. That
  resolves phase 05's hedge — no probe call, no extra route.
- **All 5 accounts are `development_access`** → a 5000-image batch is a **~21-hour**
  job. Nothing here should assume a batch completes within a session, a deploy, or
  a token's lifetime.
- **In-repo conventions to copy exactly:** `dynamic = "force-dynamic"`,
  `runtime = "nodejs"`, `maxDuration = 60`; params are **awaited**
  (`{ params }: { params: Promise<{ jobId: string }> }`); errors funnel through
  `getClientSafeError` → `NextResponse.json({ error, details }, { status })`;
  list responses carry `Cache-Control: no-store`.

## Requirements

**Functional**

| Route | Purpose |
|---|---|
| `POST /api/upload-batches` | `{ nasFolderPath }` **or** `{ files:[…≤500] }` + account/token → `201 { batch, counts, skipped }` |
| `GET /api/upload-batches` | recent batches + O(1) counts — **the 2s poll** |
| `GET /api/upload-batches/[batchId]` | one batch + counts |
| `DELETE /api/upload-batches/[batchId]` | cancel all non-terminal jobs, then purge |
| `GET /api/upload-batches/[batchId]/jobs?status=&cursor=&limit=50` | paged rows, server-filtered |
| `POST /api/upload-batches/[batchId]/retry-failed` | re-enqueue every failed job in the batch |
| `GET /api/upload-jobs/[jobId]` | one job |
| `DELETE /api/upload-jobs/[jobId]` | cancel if active, remove if terminal |
| `POST /api/upload-jobs/[jobId]/retry` | re-enqueue one job |

**Non-functional**
- Each route < 100 lines. No new deps. No change to `app/api/webdav/*` or `app/api/facebook/*`.

## Architecture

**Create (folder mode):**

```
POST /api/upload-batches { nasFolderPath, adAccountId, adAccountName, appName, tokenId }
  → normalizeWebDavPath(nasFolderPath)
  → fetchWebDavDirectoryResponse(path)          // PROPFIND Depth:1
  → files = dir.files.filter(isSupportedWebDavUploadFile)   // images only
  → 400 if files.length === 0  ("no images in this folder")
  → createMediaUploadJobs({ files, nasFolderPath, ... })    // one pipeline (phase 01)
  → enqueueMediaUploadJobs(jobs.map(j => j.id))             // addBulk
  → 201 { batch, counts, skipped }
```

Non-image entries are simply not enumerated — they never become `skipped`.
`skipped` in folder mode means "an image we refused" (oversize → OOM guard),
which is the only thing worth reporting.

**Retry (one job):**

```
POST /api/upload-jobs/[jobId]/retry
  → 400 if status is queued|processing
  → removeMediaUploadJob(jobId)        // drop the stale BullMQ entry FIRST
  → transitionJobStatus(jobId, "queued", { errorMessage:"", nextRetryAt:null, imageHash:null })
  → enqueueMediaUploadJob(jobId)
  → 200 { job }
```

Order matters: `enqueue*` early-returns an existing BullMQ job with that id, so a
lingering entry would silently no-op the retry.

`retry-failed` is the same over `SSCAN batch:<id>:status:failed` → pipeline the
transitions → one `addBulk`. Bounded by the failed count (≤ batch size).

> Contrast with the deleted `resumeAudienceUploadJob`, which cloned the job to
> carry a byte offset. Whole-image re-upload makes the clone pointless — same id,
> same file, same resulting hash.

**Delete batch:** cancel non-terminal jobs (so the worker stops cooperatively),
best-effort remove from BullMQ, then `deleteBatch` purges hashes + sets + list.

## Related Code Files

**Create:**
- `app/api/upload-batches/route.ts` (POST create, GET list)
- `app/api/upload-batches/[batchId]/route.ts` (GET, DELETE)
- `app/api/upload-batches/[batchId]/jobs/route.ts` (GET paged)
- `app/api/upload-batches/[batchId]/retry-failed/route.ts` (POST)
- `app/api/upload-jobs/[jobId]/retry/route.ts` (POST)

**Modify:**
- `app/api/upload-jobs/route.ts` — **delete the POST** (superseded by
  `/api/upload-batches`); keep `GET` only if the UI still needs an ungrouped
  list. It doesn't → **delete the file**
- `app/api/upload-jobs/[jobId]/route.ts` — import rewire; DELETE semantics unchanged

**Already deleted in phase 02 (do not resurrect):** `resume/route.ts`, `stream/route.ts`

**Untouched:** `app/api/webdav/**`, `app/api/facebook/**`

## Implementation Steps

1. `app/api/upload-batches/route.ts`:
   - `POST`: accept `nasFolderPath` **xor** `files`; 400 if both or neither.
     Folder mode per the flow. File mode: map `body.files` to
     `{nasFilePath, fileSize}`, drop malformed entries, 400 if `> 500`.
     Both paths converge on `createMediaUploadJobs` + `enqueueMediaUploadJobs`.
   - `GET`: `listRecentBatches()` → for each, `getBatchCounts` (5 `SCARD`) →
     `{ batches: [{ batch, counts }] }`, `Cache-Control: no-store`.
     50 batches × 5 SCARD = 250 O(1) ops — pipeline them.
2. `[batchId]/route.ts`: `GET` → `{ batch, counts }`. `DELETE` → cancel
   non-terminal (`SSCAN` queued + processing → `transitionJobStatus("cancelled")`),
   best-effort BullMQ removal, `deleteBatch`, → `{ id, deleted: true }`.
3. `[batchId]/jobs/route.ts`: `GET` with `status` (validated against
   `MEDIA_UPLOAD_JOB_STATUSES`), `cursor`, `limit` (default 50, max 200) →
   `listBatchJobIds` → `getMediaUploadJobs(ids)` (pipelined) →
   `{ jobs, nextCursor }`.
4. `[batchId]/retry-failed/route.ts` per the flow.
5. `app/api/upload-jobs/[jobId]/retry/route.ts` per the flow — copy the shape of
   the deleted `resume/route.ts` minus the cloning.
6. Delete `app/api/upload-jobs/route.ts`; rewire `[jobId]/route.ts`.
7. Gate: `npx tsc --noEmit && npm run lint && npm test && npm run build`, then the
   curl matrix below.

## Todo List

- [ ] `POST /api/upload-batches` — folder mode (PROPFIND) + file mode (≤500)
- [ ] `GET /api/upload-batches` — pipelined counts (the 2s poll)
- [ ] `GET`/`DELETE /api/upload-batches/[batchId]`
- [ ] `GET /api/upload-batches/[batchId]/jobs` — status filter + cursor
- [ ] `POST /api/upload-batches/[batchId]/retry-failed`
- [ ] `POST /api/upload-jobs/[jobId]/retry`
- [ ] Delete `app/api/upload-jobs/route.ts`; rewire `[jobId]/route.ts`
- [ ] curl matrix; build gate green

## Success Criteria

| Request | Expect |
|---|---|
| POST `{nasFolderPath}` on a 5000-image folder | `201`, batch `total:5000`, `counts.queued:5000`, **< 10s**, 5000 BullMQ jobs |
| Same, request body size | **< 200 bytes** (the point of folder mode) |
| POST folder containing images + `.csv` + subfolders | only images enumerated; subfolders ignored (Depth:1) |
| POST folder with no images | `400`, actionable Vietnamese message |
| POST `{files:[3 valid, 1 .csv]}` | `201`, `total:3`, `skipped:[1]` |
| POST `{files: 501}` | `400` naming the cap |
| POST both / neither of `nasFolderPath`,`files` | `400` |
| GET `/api/upload-batches` with 10 batches × 5000 jobs | **< 100ms**, payload < 10KB, counts exact |
| GET `[batchId]/jobs?status=failed` | only failed; `nextCursor` pages cleanly; no dupes/skips across pages |
| GET `[batchId]/jobs?status=bogus` | `400` |
| POST `retry-failed` with 12 failed | 12 → `queued`, counts shift 12, one `addBulk` |
| POST `retry` on `failed` | `200`, `queued`, same id, actually re-runs |
| POST `retry` on `processing` | `400` |
| DELETE batch mid-drain | non-terminal → `cancelled`; keys purged; worker stops |

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| PROPFIND on a 5000-file folder is slow / huge XML | Med × Med | ~2MB XML; the existing regex parser handles it. **Measure in the 5000-file criterion**; if > 10s, stream-parse or paginate — don't guess now |
| The regex PROPFIND parser chokes at 5000 blocks | Low × Med | Same criterion catches it. It's `match(/<response>/g)` — linear, fine |
| 5000 `addBulk` exceeds `maxDuration = 60` | Low × High | `addBulk` is one pipelined round-trip; measured by the < 10s criterion |
| Folder changes between enumeration and upload (file deleted) | Med × Low | Job fails with a WebDAV 404 → `failed` with a clear message. Acceptable; no locking |
| `SSCAN` cursor pagination can repeat elements under concurrent writes | Med × Low | Redis guarantees no *misses* for elements present throughout; dupes are cosmetic in a UI list. De-dupe client-side by job id |
| Retry on a job whose BullMQ id lingers → `enqueue` no-ops | Med × Med | `removeMediaUploadJob` **before** re-adding; covered by criteria |
| Partial enqueue failure → jobs stuck `queued` forever | Low × Med | `addBulk` is atomic-ish per call; a rejection → 500 → user retries. `retry-failed` recovers stragglers |
| `skipped` ignored by the UI → user thinks all uploaded | Med × Med | Phase 05 must surface it — cross-phase contract |

## Security Considerations

- `nasFolderPath` and `nasFilePath` arrive from the client → `normalizeWebDavPath`
  (strips `..`) **before** any PROPFIND or persist. Reject absolute URLs.
  Folder mode makes the server a directory-lister on client input: it is bounded
  by `WEBDAV_BASE_URL`, but the normalization is what keeps it there.
- Never accept `tokenId` contents as a token — a store reference only.
- No token/app secret in any response; only `tokenId` round-trips.
- `limit` must be clamped (max 200) — an unclamped `limit` is a trivial DoS via
  `hgetall` amplification.

## Next Steps

Backend complete. Unblocks phase 05. Contract: poll `GET /api/upload-batches`;
drill in via `GET /api/upload-batches/[batchId]/jobs?status=failed`.
