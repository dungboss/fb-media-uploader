# Phase 05 — UI: batch-centric dashboard

## Context Links

- Overview: [plan.md](plan.md) — the tier table is a **user-facing** number, not a footnote
- Depends on [phase 04](phase-04-api-routes.md) (contract: poll batches, drill into rows)
- Current UI: `app/page.tsx` (2211 lines — 11× the 200-line guideline)
- NAS browser: `components/nas-file-browser-dialog-impl.tsx` (416 lines)

## Overview

- **Priority:** P1
- **Status:** pending
- **Effort:** 4h

Rebuild the dashboard around **batches, not rows**, and split the 2211-line page.
Largest, highest-churn phase.

## Key Insights

- **The unit of attention is the batch.** A user who just pointed at 5000 images
  wants "3200/5000 · 12 failed · ~2h left" — not 5000 rows. Rows are a drill-in,
  filtered to what needs action.
- **Pagination + a failed-first default beats virtualization.** No `react-window`,
  no new dep: never render more than ~50 rows. Simpler *and* faster than
  virtualizing 5000.
- `app/page.tsx` already polls every 2s (`JOB_POLL_INTERVAL_MS = 2000`) and never
  opens an `EventSource` — the SSE route was dead code (deleted in phase 02).
  **Keep the 2s poll but point it at `GET /api/upload-batches`** (~10 rows, O(1)
  counts) instead of the full job list.
- **Folder picker replaces multi-select.** Phase 04 enumerates server-side, so the
  dialog needs a "chọn thư mục này" action — *not* 5000 checkboxes. This deletes
  the multi-select work from my earlier plan: simpler dialog, tiny request.
- **All 5 of the user's ad accounts are `development_access`** (probe-verified,
  2026-07-16). So the ~21-hour drain is not an edge case to warn about — **it is
  the default experience**, every time. The UI's job is to make that legible
  *before* the user commits, and to point at the one lever that actually fixes it.
- **The tier arrives free** on `GET /api/facebook/ad-accounts` (phase 02 puts it
  on `AdAccountListItem` from the `me/adaccounts` usage header). No probe call, no
  new endpoint — my earlier "add it in phase 04 if missing" hedge is resolved.
- **The upgrade path is the product's most valuable sentence.** Standard access is
  ~75× faster than anything we can engineer. It belongs *next to the ETA*, phrased
  as an action, not buried in a tooltip or a README.
- Roughly half of `page.tsx` deletes: audience list/table, create+append forms,
  name/description inputs, delete dialog, `AudienceAvailability` badges, and the
  "Bắt đầu từ offset (MB)" input (`:1892`) with its `formatMb`/`syncedByteOffset`
  hints (`:667`, `:725`, `:1444-1446`).
- Bootstrap steps 1 (tokens `:303-369`) and 2 (ad accounts `:370-440`) survive
  nearly verbatim. Step 3 (audiences `:441-606`) deletes outright.

## Requirements

**Functional**
- Header: token picker + add-token dialog + ad-account picker (unchanged behavior, incl. localStorage) + **tier badge**.
- Upload: browse NAS → pick a **folder** → "Upload thư mục này" → `POST {nasFolderPath}` → batch appears.
- Batches list: progress bar, `done/total`, failed count, ETA, status, actions (retry-failed, delete). Polls 2s while any batch is active.
- Batch drill-in: paged rows, status filter, **failed by default**.
- Failed row shows Meta's message verbatim (the only way to diagnose an oversize image) + per-row retry.
- Empty state.

**Non-functional**
- Every file < 200 lines; `app/page.tsx` < 150.
- No new dependencies. Existing shadcn primitives only.
- Vietnamese copy throughout.

## Architecture

```
app/page.tsx                                   (<150)  composition only
components/media-upload/
  token-picker.tsx                             (~150)  picker + add-token dialog
  ad-account-picker.tsx                        (~90)   + tier badge
  folder-upload-panel.tsx                      (~120)  chosen folder + submit
  batches-list.tsx                             (~120)  cards/table + empty/loading
  batch-card.tsx                               (~130)  progress, counts, ETA, actions
  batch-jobs-dialog.tsx                        (~150)  drill-in: filter + paged rows
  job-row.tsx                                  (~110)  thumbnail, hash, error, retry
  job-status-badge.tsx                         (~40)
components/nas-file-browser-dialog-impl.tsx    (~430)  + "select this folder"
hooks/
  use-fb-tokens.ts                             (~90)
  use-ad-accounts.ts                           (~70)
  use-upload-batches.ts                        (~110)  list + 2s poll + create + retry + delete
  use-batch-jobs.ts                            (~90)   paged rows for one batch
lib/media-upload/types.ts                              shared client+server types
lib/media-upload/format.ts                     (~40)   formatFileSize, formatEta
```

**Data flow:**

```
NAS dialog ──nasFolderPath──► folder-upload-panel
   token-picker ──tokenId──┐          │
ad-account-picker ──actId──┼──────────▼
                     POST /api/upload-batches { nasFolderPath, tokenId, adAccountId, ... }
                                      │
                          { batch, counts, skipped } ──► toast
                                      │
              use-upload-batches ◄────┴── GET /api/upload-batches every 2s  (O(1) counts)
                                      │
                              batches-list → batch-card
                                      │ click
                              batch-jobs-dialog ── GET .../jobs?status=failed&cursor=
                                      │
                                   job-row
```

**Batch card:**

| Element | Source |
|---|---|
| Folder name + ad account | `batch.nasFolderPath`, `batch.adAccountName` |
| Progress bar | `(completed+failed+cancelled) / total` |
| `3200/5000 · 12 lỗi` | `counts` |
| ETA | client-side: `remaining / (completed / elapsed)`; label **ước tính**, hide until ≥20 completed (early rates are noise) |
| Actions | "Thử lại N lỗi" (when `failed>0`), "Xoá" |

ETA is computed client-side from counters — no server state. Deliberately crude;
the honest framing is "roughly", especially on dev tier where a 300s block
dominates.

**Polling:** poll only while a batch has `queued+processing > 0` (mirrors the
existing active-only behavior). One request regardless of job count.

**NAS dialog change:** keep single-file selection for the `{files}` path, add a
primary **"Upload toàn bộ thư mục này (N ảnh)"** action using the already-loaded
directory listing to show N. No checkboxes, no select-all.

## Related Code Files

**Modify:**
- `app/page.tsx` — 2211 → <150
- `components/nas-file-browser-dialog-impl.tsx` — add the folder action + `onSelectFolder`
- `components/nas-file-browser-dialog.tsx` — re-export unchanged

**Create:** the 8 `components/media-upload/*`, 4 `hooks/*`, `lib/media-upload/format.ts`

**Delete:** nothing new — audience UI dies inside `page.tsx` as it decomposes

**Untouched:** `components/ui/**`, `components/nas-folder-tree.tsx`, `hooks/use-webdav-folder-tree.ts`

## Implementation Steps

1. **Extract before rewriting.** Move surviving logic out of `page.tsx`
   unchanged, verifying the build after each move — never extract-and-rewrite in
   one step:
   a. `use-fb-tokens.ts` ← `:303-369` + token add/delete `:184-196`
   b. `use-ad-accounts.ts` ← `:370-440`
   c. `token-picker.tsx`, `ad-account-picker.tsx` ← header JSX
   d. `job-status-badge.tsx` ← `JobStatusBadge`
2. Delete the audience surface: `:441-606`, audience state/table/forms/delete
   dialog, `ProgressPanel`, `NasUploadSelector`, the offset input `:1892`, every
   `syncedByteOffset`/`formatMb` reference, and the old job-poll effect
   (`:607-760`) — superseded by `use-upload-batches`.
3. `lib/media-upload/format.ts`: move `formatFileSize` from `page.tsx`; add
   `formatEta(ms)`. (`formatMb` dies with the offset UI.)
4. `use-upload-batches.ts`: list + 2s active-only poll + `createFromFolder` +
   `retryFailed` + `deleteBatch`.
5. `batches-list.tsx` + `batch-card.tsx` per the table.
6. `use-batch-jobs.ts` + `batch-jobs-dialog.tsx`: status filter (default
   `failed`), cursor paging, "tải thêm". De-dupe by job id on append (SSCAN can
   repeat — see phase 04).
7. `job-row.tsx`: thumbnail via plain `<img loading="lazy">` — `next/image` would
   need a remote-pattern config for `platform-lookaside.fbsbx.com`, not worth it
   for a 128px thumb (YAGNI). Comment the tradeoff.
8. NAS dialog: `onSelectFolder(path, imageCount)` + the primary folder action.
9. `folder-upload-panel.tsx`: chosen folder + image count, "Upload thư mục này",
   disabled without token/ad account. On success: toast `Đã tạo batch N ảnh`;
   when `skipped.length`, a warning toast with the first 3 reasons.
10. **Tier surface (two places, both non-negotiable).** Source: `tier` on the
    ad-accounts response — already there, no extra call.
    a. `ad-account-picker.tsx` — badge next to the account.
       `development_access` → **warning**; `standard_access` → neutral.
    b. `folder-upload-panel.tsx` — **before** the user commits, once a folder with
       N images is chosen and the tier is `development_access`, show an inline
       callout (not a tooltip, not a toast):
       > ⚠️ Tài khoản đang ở **Development tier** — khoảng **240 ảnh/giờ**.
       > {N} ảnh ≈ **{N/240} giờ**. Xin cấp **Standard access** để nhanh hơn ~75×.
       > [Hướng dẫn nâng tier ↗]
       Link: Meta's ads API access-tier docs. Repeat it compactly on `batch-card`
       next to the ETA while the batch drains — that's when "21 hours" starts to
       hurt and the user wants the fix.
    Do **not** block the upload — inform, don't gate.
11. Recompose `app/page.tsx`. Verify < 150 lines.
12. Gate: `npx tsc --noEmit && npm run lint && npm test && npm run build` + the checklist.

## Todo List

- [ ] Extract `use-fb-tokens` / `use-ad-accounts` / pickers / badge (build-verified per move)
- [ ] Delete audience UI + offset input + old job poll
- [ ] `lib/media-upload/format.ts`
- [ ] `use-upload-batches` (2s active-only poll)
- [ ] `batches-list` + `batch-card` (progress, counts, ETA, retry-failed, delete)
- [ ] `use-batch-jobs` + `batch-jobs-dialog` (failed-first, cursor paging, de-dupe)
- [ ] `job-row` (thumbnail, hash, Meta error, retry)
- [ ] NAS dialog folder action
- [ ] `folder-upload-panel` + skipped toast
- [ ] Tier badge + pre-commit upgrade callout + ETA-adjacent repeat
- [ ] Recompose `page.tsx` < 150 lines
- [ ] All files < 200 lines; build gate; checklist

## Success Criteria

**Manual e2e checklist** (vitest covers pure functions only — UI is manual by design):

- [ ] Pick a 5000-image folder → one POST (<200B) → batch card appears `0/5000`
- [ ] Card advances live; **exactly one** network request per 2s poll regardless of 5000 jobs (verify in devtools — this is the whole point)
- [ ] ETA appears after ~20 completions and is within ~2× of actual
- [ ] Folder with images + `.csv` + subfolders → count shows images only
- [ ] Folder with no images → actionable error, no batch created
- [ ] Drill in → defaults to **failed**; "tải thêm" pages without dupes/gaps
- [ ] An oversize image → row `failed` with **Meta's** message; others complete
- [ ] "Thử lại N lỗi" → those rows re-queue; counts shift
- [ ] Delete a batch mid-drain → disappears; worker stops
- [ ] Dev-tier account (i.e. **every** account) → warning badge + "≈21 giờ" +
      the Standard-access callout shown **before** the user clicks upload
- [ ] The upgrade callout repeats next to the ETA on a draining batch card
- [ ] Switching token reloads ad accounts; both remembered after reload
- [ ] Poll stops when all batches are terminal (no idle traffic)
- [ ] No console errors; `wc -l` every touched file < 200 (`page.tsx` < 150)

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| Big-bang rewrite of 2211 lines breaks token/ad-account flows | **High** × Med | Step 1 extracts working code *unchanged*, build-verified per move, before any rewrite |
| ETA wrong early on (dev tier's 15s pacing is steady, but a brake/throttle skews the average) | Med × Low | Label "ước tính"; hide until ≥20 completions. Dev-tier pacing is actually *very* regular (15s/image), so the observed rate converges fast. Don't build a smarter estimator (YAGNI) |
| **A 21h batch spans browser sessions** — user closes the tab, assumes it died | **High** × Med | All state is server-side (Redis + BullMQ); the batch list rehydrates on load. Say so in the empty/loading copy: "đóng tab vẫn chạy tiếp" |
| Poll still heavy: 50 batches × 5 SCARD every 2s | Low × Low | Pipelined server-side (phase 04), < 100ms; only while active |
| Batch card hides individual failures → user never drills in | Med × Med | Failed count is prominent + "Thử lại N lỗi" on the card itself |
| Thumbnails: 50 `<img>` per page to fbsbx | Low × Low | `loading="lazy"`; only completed rows; paging caps at ~50 |
| `skipped` silently dropped → user believes all uploaded | Med × **High** | Explicit warning toast (step 9); in the checklist |
| Tier not exposed by any endpoint → badge can't be built | Med × Med | Step 10 says add it in phase 04 rather than improvising client-side |
| SSCAN duplicates across pages → duplicate rows | Med × Low | De-dupe by id on append (step 6) |

## Security Considerations

- Raw tokens/app secrets never reach the browser — only `tokenId` + non-secret
  `appId`. Do not widen the token API while refactoring.
- localStorage keeps only the selected token **id**.
- `previewUrl` is a Meta-hosted URL from the API: render it, never interpolate it
  into HTML or an unsanitized `href`.
- `errorMessage` renders as text (React escapes). Never `dangerouslySetInnerHTML`
  a Meta error.
- The tier badge is non-secret usage metadata — safe to display.

## Next Steps

Phase 06: README/docs + dependency cleanup.
