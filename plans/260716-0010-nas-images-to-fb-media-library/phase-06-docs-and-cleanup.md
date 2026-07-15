# Phase 06 — README, docs, dependency cleanup

## Context Links

- Overview: [plan.md](plan.md) — the rate-limit findings are the headline this phase must land
- Depends on phases 01–05
- `README.md` — documents audiences end-to-end; MUST be rewritten
- `package.json` — name + dead deps

## Overview

- **Priority:** P2 (last, not optional — the README actively misleads)
- **Status:** pending
- **Effort:** 0.5h

Rewrite the README for the folder-scale image flow, drop dead dependencies, record
the pivot and the rate-limit reality in `docs/`.

## Key Insights

- **The tier explains everything an operator will ask**, and the 2026-07-16 probe
  settled it: **all 5 ad accounts are `development_access`** → ~240 img/hr → a
  5000-image folder is a **~21-hour** job, every time. This is not a caveat, it's
  the product's headline performance characteristic. Top of the README.
- **The only real fix is a tier upgrade (~75×).** Say it plainly, with the link.
  No config knob in this repo comes within two orders of magnitude.
- The README's **"Resuming a large upload from an offset"** section describes a
  feature that no longer exists — delete, don't amend.
- The README claims "at most one job per ad account at a time" — **now false**
  (phase 03 removed the gate). Replace with the throttle model.
- `papaparse`, `@types/papaparse`, `react-dropzone`, `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner` have **zero importers** (grepped across
  `app lib workers components hooks`). papaparse dies by decision; the other
  three were already dead pre-pivot.
- `package.json` `name: "fb-audience-uploader"` contradicts the repo dir
  `fb-media-uploader`; so does the README's trailing `# fb-audience-uploader`.
- **Single-worker-process is now a hard requirement**, not a nicety: the usage
  store (`meta-usage.ts`) and the batch cache are in-memory. Running two workers
  silently doubles the Meta request rate for an account. Must be stated loudly.
- No `docs/` dir exists. Create only what this pivot justifies — not the
  seven-file template (YAGNI).

## Requirements

**Functional**
- README covers: tokens, ad-account selection, **access tier & throughput**,
  folder upload, batch monitoring, rate-limit/pacing model, env vars, running the
  worker (single process).
- Every env var in `lib/media-upload/env.ts` documented; no removed var mentioned.
- Dead deps removed; `npm ci && npm run build` green.

**Non-functional**
- Sacrifice grammar for concision. Vietnamese sections stay Vietnamese.

## Architecture

**README section diff:**

| Section | Action |
|---|---|
| Next.js boilerplate (`:1-36`) | trim to a short Getting Started |
| Access tokens (`:38-58`) | keep; drop "…so the worker creates the audience" wording |
| Ad account selection (`:60-66`) | keep; "creates the audience under" → "uploads images to" |
| **Resuming a large upload from an offset** (`:68-81`) | **DELETE** |
| **Per-ad-account upload concurrency** (`:83-92`) | **REWRITE** — the one-job-per-account gate is gone; describe the per-account min-interval throttle + tier-adaptive pacing + why a single worker process is mandatory |
| NAS WebDAV (`:94-96`) | keep; note the image-extension filter |
| `# fb-audience-uploader` (`:98`) | → `# fb-media-uploader` |
| **Upload ảnh từ NAS** | **NEW**: pick a folder → server enumerates → one job per image → batch progress; formats jpg/jpeg/png/gif; size limit is Meta's call, not ours |
| **Access tier & throughput** | **NEW** — see below |
| **Environment variables** | **NEW**: table of every var in `env.ts` |

**The tier section (the headline):**

| Tier | BUC quota / ad account | Our pacing | 5000 images |
|---|---|---|---|
| **`development_access`** ← all 5 accounts today | `300 + 40 × active_ads` calls/hr | 15s | **~21 hours** |
| `standard_access` (Full Access) | `100000 + 40 × active_ads` calls/hr | 200ms | ~17 min |

Explain, from **measured** behavior (not docs):
- `X-Business-Use-Case-Usage` (`type: ads_management`) is the live limit signal;
  `adimages` reports into it. `X-Ad-Account-Usage` is **not returned** on these
  edges, so the 60/9000 point-score model is not something we can observe — we
  pace at 15s which respects it anyway.
- The app auto-detects the tier from `ads_api_access_tier` inside that header (for
  free, on `me/adaccounts` at page load), paces per tier, brakes on `call_count`,
  and waits exactly `estimated_time_to_regain_access` minutes when throttled.
- **Request Standard access if 21h is unacceptable — that is the only real fix**
  (~75×), not a config tweak. Link Meta's access-tier docs.
- Tuning: if `call_count` stays low in the worker logs, the account's quota is
  bigger than the floor (more active ads) → lower `UPLOAD_META_REQUEST_INTERVAL_MS`.

**Section: why we don't spread a batch across the 5 ad accounts** (so nobody
re-proposes it): ad images are per-account assets — an `image_hash` from act_A is
unusable in act_B's creatives, which is exactly why Meta ships
`copy_from{source_account_id, hash}`. And `copy_from` wouldn't help: our limit is
calls/hour against the *destination* account, and a copy is still such a call.
Wanting the same library in 5 accounts = 5 batches, which already drain in
parallel (the throttle is per-account).

**Env table:** `REDIS_URL` (required), `TOKEN_ENCRYPTION_KEY` (required),
`WEBDAV_BASE_URL`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD`, `FACEBOOK_ACCESS_TOKEN`
(optional default), `FACEBOOK_AD_ACCOUNT_ID` (optional default),
`FACEBOOK_API_VERSION`, `UPLOAD_JOB_QUEUE_NAME`, `UPLOAD_JOB_TTL_SECONDS`
(**7d — must exceed the longest expected drain**), `UPLOAD_JOB_ATTEMPTS`,
`UPLOAD_WORKER_CONCURRENCY`, `UPLOAD_WORKER_RATE_LIMIT_MAX`,
`UPLOAD_WORKER_RATE_LIMIT_DURATION_MS`, `UPLOAD_META_REQUEST_INTERVAL_MS`
(**floor only — tier detection may pace slower**), `UPLOAD_META_RATE_LIMIT_DELAY_MS`
(**fallback only — used when Meta sends no usage header**), `UPLOAD_MAX_FILE_BYTES`
(**OOM guard, not Meta's limit**), `UPLOAD_MAX_BATCH_FILES`.

**Removed vars to scrub:** `UPLOAD_META_BATCH_SIZE`, `UPLOAD_META_MAX_PER_SEC`,
`UPLOAD_META_PROACTIVE_PAUSE_BYTES`, `UPLOAD_JOB_NAS_TEMP_DIR`,
`UPLOAD_PRESIGN_TTL_SECONDS`.

## Related Code Files

**Modify:**
- `README.md` — per the diff
- `package.json` — `name: "fb-media-uploader"`; remove the 5 dead deps
- `.env.example` — mirror the env table (only if the file exists)

**Create:**
- `docs/system-architecture.md` — NAS folder → enumerate → batch + N jobs →
  worker → adimages; the Redis key map (incl. **`audience-upload:fb-tokens`
  deliberately not renamed**); the batch/status-set model; BUC-driven pacing +
  the measured header payload; single-process constraint; **why multi-account
  spreading is rejected**
- `docs/project-changelog.md` — the pivot; what was removed; breaking changes
  (old audience jobs dropped, no migration; per-account gate removed, reversing
  `6e34a33`/`0f8756f` — with the workload rationale)

## Implementation Steps

1. Re-grep before deleting (phases 01–05 may have added an importer):
   `grep -rn "papaparse\|react-dropzone\|aws-sdk" --include=*.ts --include=*.tsx app lib workers components hooks`
   → must be empty.
2. `npm uninstall papaparse @types/papaparse react-dropzone @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
3. `package.json` `name` → `fb-media-uploader`.
4. Rewrite `README.md`. Non-negotiable statements: **no client-side image size
   limit** (Meta rejects; the job shows Meta's message); `UPLOAD_MAX_FILE_BYTES`
   is an OOM guard; **run exactly one worker process**; tier drives throughput.
5. `docs/system-architecture.md` + `docs/project-changelog.md`.
6. Gate: `rm -rf node_modules && npm ci && npm test && npm run build && npm run lint`.
7. Final sweep: `grep -rni "audience\|offset (MB)\|papaparse\|một job per" README.md docs/ package.json`
   → only the changelog's historical mentions and the `audience-upload:fb-tokens`
   note may match.

## Todo List

- [ ] Re-grep dead deps → empty
- [ ] `npm uninstall` the 5 dead deps
- [ ] `package.json` name → `fb-media-uploader`
- [ ] README: delete offset section, **rewrite the concurrency section**, add tier + image + env sections, fix title
- [ ] `docs/system-architecture.md` (incl. token-key warning + single-process)
- [ ] `docs/project-changelog.md` (incl. gate-removal rationale)
- [ ] `npm ci` + test + build + lint green
- [ ] Final grep sweep clean

## Success Criteria

- README documents no feature that doesn't exist; a new dev goes clone → uploading
  a folder using only the README.
- README answers "why is this taking 21 hours?" without reading code.
- README states the single-worker-process requirement.
- Every `readNumberEnv`/`readOptionalEnv` key in `env.ts` appears in the env table
  (diff the two lists by hand).
- `npm ci` from scratch → `npm test && npm run build` green with the 5 deps gone.
- `grep -rn "audience" README.md` → nothing (bar the deliberate token-key note).

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| A "dead" dep is used via a dynamic import | Low × Med | Step 1 grep + full `npm ci` rebuild gate |
| README's stale "one job per ad account" line survives → operator mis-tunes concurrency | Med × Med | Explicit rewrite row + the `một job per` grep sweep |
| Single-process requirement buried → someone scales the worker → 2× Meta rate → throttling | Med × **High** | Called out in README **and** `docs/system-architecture.md`; it's a correctness constraint, not a tip |
| Env table drifts from `env.ts` immediately | Med × Low | Success criterion is a manual diff of both lists |
| Removing `@aws-sdk/*` breaks an out-of-repo deploy script | Low × Low | No importers pre-pivot; deploy is `next build` + `tsx` |
| Docs balloon into the unread seven-file template | Med × Low | Exactly 2 files, both grounded in this pivot |

## Security Considerations

- Keep the `TOKEN_ENCRYPTION_KEY` generation instructions (`openssl rand -base64 32`)
  — losing them means tokens can't be decrypted after a redeploy.
- Document that the token store's Redis key was **deliberately not renamed**, so a
  future refactor doesn't orphan encrypted tokens.
- No real token, app secret, ad-account id, business id, or NAS host in
  README/docs examples — placeholders only.

## Next Steps

Pivot complete. Follow-ups (out of scope): recursive folder enumeration,
Redis-backed usage store if the worker ever scales past one process, `.webp`
support, requesting Full Access for dev-tier accounts.
