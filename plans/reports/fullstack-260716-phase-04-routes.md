# Phase 04 — API routes (folder enumeration, batches, paged jobs)

Plan: `plans/260716-0010-nas-images-to-fb-media-library/phase-04-api-routes.md`

## Files changed

New (app/api/** only, per file ownership):
- `app/api/upload-batches/route.ts` (57 lines) — POST create (folder xor files), GET list w/ pipelined counts
- `app/api/upload-batches/batch-intake.ts` (125 lines) — xor validation, PROPFIND enumeration, explicit-file cap/normalize. Split out to keep route.ts <100 lines
- `app/api/upload-batches/batch-counts.ts` (44 lines) — bulk pipelined SCARD across N batches (the "250 ops, 1 round trip" requirement)
- `app/api/upload-batches/collect-set-members.ts` (23 lines) — exhaustive SSCAN helper, shared by cancel + retry-failed
- `app/api/upload-batches/[batchId]/route.ts` (85 lines) — GET, DELETE (cancel non-terminal → BullMQ remove → purge)
- `app/api/upload-batches/[batchId]/jobs/route.ts` (85 lines) — GET paged, status-filtered
- `app/api/upload-batches/[batchId]/retry-failed/route.ts` (61 lines) — POST, remove-then-transition-then-one-addBulk
- `app/api/upload-jobs/[jobId]/retry/route.ts` (49 lines) — POST, single-job retry

Not modified (already correct / already done by an earlier phase, verified via `git diff`):
- `app/api/upload-jobs/[jobId]/route.ts` — imports already point at `lib/media-upload/*`; no rewire needed
- `app/api/upload-jobs/route.ts` — already deleted + committed before this session started (confirmed via `git log`/`ls`)

Untouched, as required: `app/api/webdav/**`, `app/api/facebook/**`, `workers/**`, `lib/media-upload/env.ts`, `app/page.tsx`.

## Build gate

- `npx tsc --noEmit` — clean
- `npm run lint` — **14 errors / 4 warnings**, matches the stated 14-error baseline exactly, all in `app/page.tsx` (untouched, phase 05) + one pre-existing warning in `components/nas-folder-tree.tsx`. Zero new lint errors from any file I added.
- `npm test` — all pass (38 tests; 24 were mine-adjacent lib tests already there, +14 landed concurrently from phase 03's worker tests mid-session — confirms parallel-safe coexistence)
- `npm run build` — succeeds; all 8 new routes show up in the route table (`ƒ /api/upload-batches`, `[batchId]`, `[batchId]/jobs`, `[batchId]/retry-failed`, `/api/upload-jobs/[jobId]/retry`, plus the pre-existing untouched ones)

## Smoke test (real Redis + real NAS, read-only Meta — no Meta calls made)

Ran `next dev` on port 3311, curled routes against the real WebDAV NAS
(`/NAME/Tshirt PNG/test`: 3 real `.jpg` + 1 `Thumbs.db`). Safety: confirmed no
`worker:media` process running and no `FACEBOOK_ACCESS_TOKEN`/
`FACEBOOK_AD_ACCOUNT_ID` fallback in `.env`, then used a deliberately-invalid
`tokenId` on top of that — even if a worker had picked the jobs up mid-test,
credential resolution would 400 before any Graph call. No Meta call occurred.

| Test | Result |
|---|---|
| POST folder mode, 3 jpg + 1 Thumbs.db | `201`, `total:3`, `counts.queued:3`, `skipped:[]` — Thumbs.db never enumerated (matches spec: non-images aren't "skipped", they're just not seen) |
| POST both fields | `400` "Chọn đúng một trong hai..." |
| POST neither field | `400` same message |
| POST file mode, 3 valid + 1 `.csv` | `201`, `total:3`, `skipped:[{nasFilePath:"/some/report.csv", reason:"Không phải định dạng ảnh..."}]` |
| POST file mode, 501 files | `400` "Chỉ chọn tối đa 500 file..." |
| GET `/api/upload-batches` | returns both created batches with correct pipelined counts |
| GET `/api/upload-batches/[id]` | batch + counts |
| GET `/api/upload-batches/[id]/jobs` (unfiltered) | 3 rows, real `nasFilePath`s, `nextCursor:null` |
| GET `.../jobs?status=failed` | `[]` (none failed yet) |
| GET `.../jobs?status=bogus` | `400` naming the valid set |
| POST `/api/upload-jobs/[jobId]/retry` on a `queued` job | `400` "Job đang chạy, không thể thử lại..." |
| POST `.../retry-failed` with 0 failed | `{"retried":0}` |
| GET nonexistent batch | `404` "Không tìm thấy batch." |
| DELETE both batches | `{"id":..., "deleted":true}`; list returns `[]` after; GET deleted batch → `404` |
| Post-cleanup Redis check | `redis.keys("media-upload:*")` → 0 keys (no leftovers) |

Not exercised live: the 5000-image / <10s / <200-byte-request criteria (no
5000-file folder available on the real NAS in the time available) and
`retry-failed` with actual failures (would require a running worker + real
Meta call, out of scope for read-only smoke testing). Logic for both is
straightforward extensions of the tested paths (enumeration is a filter over
whatever PROPFIND returns; `retry-failed` reuses the same SSCAN+transition
+addBulk pattern verified end-to-end with `retried:0`) — flagging as
untested-at-scale rather than claiming false confidence.

## Deviations from spec (and why)

1. **Counts on POST are computed directly (`{queued: jobs.length, ...}`), not read back via `getBatchCounts`.** Spec's response shape (`{ batch, counts, skipped }`) is unchanged; only the source of `counts` differs. Reading it back right after `enqueueMediaUploadJobs` would race a fast worker that may already have started processing job 0, which would make `counts.queued` wrong at exactly the moment the success criterion ("`counts.queued:5000`") is checked. Computing it from what was just created is both correct and saves a Redis round trip.
2. **Split into helper files (`batch-intake.ts`, `batch-counts.ts`, `collect-set-members.ts`) beyond the "Related Code Files" list.** Needed to hit the NFR "each route < 100 lines" — the POST handler alone (xor validation + PROPFIND enumeration + explicit-file cap/normalize) doesn't fit under 100 lines inline. All three live under `app/api/upload-batches/`, inside my file-ownership boundary; no lib files touched.
3. **`GET /api/upload-batches/[batchId]` does not set `Cache-Control: no-store`.** Matched the existing single-resource convention (`GET /api/upload-jobs/[jobId]` doesn't set it either); reserved `no-store` for the two actual list endpoints (`GET /api/upload-batches`, `GET .../jobs`) per "list responses carry Cache-Control: no-store."
4. **Explicit file-mode `nasFilePath` is normalized via `normalizeWebDavPath` before persisting**, not just implied by folder mode's PROPFIND path. Security Considerations explicitly says both `nasFolderPath` and `nasFilePath` need this "before any PROPFIND or persist" — folder mode gets it for free from PROPFIND's own paths, file mode needed an explicit call.
5. **Batch cancel/retry-failed use `Promise.all` over per-job `transitionJobStatus`/`removeMediaUploadJob`** rather than a single custom pipeline, to keep `transitionJobStatus` as the sole status-transition writer (its own doc comment: "must go through here"). At 5000 jobs this is O(N) concurrent round trips instead of one pipelined call — acceptable for a DELETE/retry-failed action (no latency criterion given), but flagged here as a place to revisit if it's ever measured slow in practice.

## Unresolved questions

None blocking. One judgment call surfaced above (item 5) — happy to swap to a
bespoke pipeline in `[batchId]/route.ts`/`retry-failed/route.ts` if a reviewer
wants stricter O(1)-round-trip behavior over reusing the shared state-machine
writer.

**Status:** DONE
**Summary:** All 8 routes implemented per spec (folder + file-mode batch create, pipelined batch list/counts, paged failed-first job rows, retry + retry-failed, single-job retry). Build gate green (tsc/lint/test/build), lint at exact 14-error baseline (zero new), full curl matrix passed against real Redis + real NAS with zero Meta calls made.
**Concerns/Blockers:** None. Two judgment calls documented above (counts computed vs re-read; Promise.all vs custom pipeline for bulk cancel/retry) — both are correctness-preserving, flagged for reviewer visibility rather than blocking.
