# Phase 02 — Meta client: graph core, usage headers, adimages

## Context Links

- Overview: [plan.md](plan.md) — the **rate-limit findings** are this phase's reason for existing
- Depends on [phase 01](phase-01-foundation-rename-and-types.md)
- Research: `plans/reports/researcher-260715-2332-meta-media-upload-api.md` §1, §4, §6 (§4 is **wrong** — see below)
- Docs: [Marketing API rate limiting](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/) · [Graph API rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- Source to salvage: `app/api/audiences/meta.ts` (802 lines, deleted here)

## Overview

- **Priority:** P1
- **Status:** pending
- **Effort:** 3h

Split the salvageable ~40% of `app/api/audiences/meta.ts` into focused
`lib/media-upload/meta-*.ts` modules, add the `adimages` upload **and the usage-header
layer that every pacing decision downstream depends on**, delete
`app/api/audiences/**`, rewire importers.

## Key Insights

- **The research report's `adimages` POST response shape is suspect.** It
  documents a flat `{ hash, url, url_128, width, height, name }`. Meta's live API
  is widely observed to return `{ "images": { "<field_name>": { hash, url, ... } } }`
  keyed by the multipart field name. **Verify before writing the parser** (step
  1); ship a parser tolerant of both; vitest locks both shapes.
  **The 2026-07-16 probe does NOT settle this.** Its `GET act_X/adimages` returned
  flat `{hash,name,width,height,id}` under `data[]` — that is the **read** edge.
  Read and write edges routinely differ. Step 1 is still a hard gate.
- **The report's §4 rate-limit model is void** (see plan.md). The probe measured
  the truth: **`X-Ad-Account-Usage` does not exist** on these edges, and
  `X-Business-Use-Case-Usage` carries everything — including
  `ads_api_access_tier`, which lives **inside the BUC entry**, not in a separate
  header. Build the usage layer on BUC alone.
- **BUC is keyed by bare ad account id** (`"679927437761688"`), while our account
  keys are `act:<id>`. Normalizing across that boundary is the #1 way this layer
  silently records nothing.
- **The tier is free at page load.** `me/adaccounts` returns BUC entries for all
  accounts at once, so `GET /api/facebook/ad-accounts` already has the tier in
  hand — no probe call, no new endpoint (this resolves phase 05's hedge).
- Auth is **not** Bearer. `facebookRequest` puts `access_token` in the query plus
  `appsecret_proof` (`meta.ts:559-594`). The report's TS sketch uses
  `Authorization: Bearer` — **do not copy it**; follow the in-repo pattern.
- Field naming for the upload is `-F '<filename>=@<filename>'` — the field name
  becomes the asset `name`. Meta dedupes by content: re-uploading identical bytes
  returns the same `hash`, so retries are safe and idempotent.
- Do **not** set `Content-Type` manually on a multipart POST — fetch must set the
  boundary. `facebookRequest` spreads `init.headers` over `{Accept:
  "application/json"}`; passing a `FormData` body works as long as nothing adds
  an explicit content-type.
- **Usage headers arrive on errors too** — in fact that's when they matter most
  (`estimated_time_to_regain_access` on a 429 tells us the exact wait). So they
  must be parsed in `parseFacebookResponse` *before* the throw, and attached to
  the thrown error.

## Requirements

**Functional**
- `uploadAdImage({ adAccountId, tokenId, fileName, bytes, contentType })` → `{ hash, url, previewUrl, width, height }`.
- `parseUsageHeaders(headers)` → `MetaUsage`; recorded per ad account and attached to `FacebookApiError`.
- `listAdAccounts`, `getDefaultAdAccountId`, `hasEnvAccessToken` preserved byte-compatible with today's responses.
- `getClientSafeError`, `isFacebookRateLimitError` preserved.
- New `isMetaMediaRejectionError(error)` → permanent asset rejections (bad format, too large, corrupt) fail fast.

**Non-functional**
- Each module < 200 lines. No `app/**` imports from `lib/**`.
- Zero behavior change for the token / ad-account endpoints.

## Architecture

```
lib/media-upload/
  meta-graph.ts        # credentials, appsecret_proof, facebookRequest, parseFacebookResponse,
                       # getClientSafeError, isFacebookRateLimitError, isMetaMediaRejectionError
  meta-usage.ts        # NEW: MetaUsage, parseUsageHeaders, recordUsage/getUsage store
  meta-ad-accounts.ts  # listAdAccounts (+paging), getDefaultAdAccountId, hasEnvAccessToken,
                       # resolveAdAccountId, normalizeAdAccountId, AdAccountListItem
  meta-images.ts       # uploadAdImage + tolerant response parsing
  meta-images.test.ts  # NEW: parser, both shapes
  facebook-error.ts    # exists; + optional `usage` field
```

**Usage model** (`meta-usage.ts`) — BUC only; `X-Ad-Account-Usage` does not exist:

```ts
export type MetaAccessTier = "development_access" | "standard_access" | "unknown";

export interface MetaUsage {
  tier: MetaAccessTier;          // BUC entry .ads_api_access_tier
  callCount: number | null;      // .call_count      — units TBD, see step 1
  cpuPct: number | null;         // .total_cputime   (%)
  timePct: number | null;        // .total_time      (%)
  regainMinutes: number | null;  // .estimated_time_to_regain_access (MINUTES)
  observedAt: number;
}

/** Parses X-Business-Use-Case-Usage. Returns one entry per bare ad account id. */
export function parseUsageHeaders(headers: Headers): Map<string, MetaUsage>;
export function recordUsageFromHeaders(headers: Headers): void;  // records ALL accounts
export function getUsage(accountKey: string): MetaUsage | null;  // accepts act_X | act:X | bare
export function suggestedWaitMs(usage: MetaUsage | null, fallbackMs: number): number;
```

Measured payload shape:

```json
{"679927437761688":[{"type":"ads_management","call_count":0,"total_cputime":0,
  "total_time":0,"estimated_time_to_regain_access":0,
  "ads_api_access_tier":"development_access"}]}
```

- **Key normalization is mandatory.** The header key is the **bare** id
  (`679927437761688`); callers hold `act_679927437761688` or `act:679927437761688`.
  Strip `act_` / `act:` on both write and read. Get this wrong and the store looks
  fine while always returning `null` → pacing silently degrades to the floor.
- **One response updates many accounts.** `me/adaccounts` returns entries for all
  5 accounts → `recordUsageFromHeaders` records the whole map, not one key. Free
  tier detection at page load.
- Select the entry with `type === "ads_management"`; if absent, take the first.
- **Unit trap:** `regainMinutes` is **minutes**. Converting is `suggestedWaitMs`'s
  job and nowhere else. A 60× error here is silent.
- **`callCount` units are unconfirmed** — docs say "percentage of allowed calls",
  the probe's `0` fits both readings. Step 1 disambiguates. Keep the field named
  `callCount` (not `callPct`) until proven, so nobody assumes.
- Missing/garbage header → every field `null`, never throw.
  `suggestedWaitMs(null, fallback)` → the configured fallback.
- **Header-name discrepancy:** Marketing-API doc says `X-Business-Use-Case`;
  Graph-API doc and the live response say `X-Business-Use-Case-Usage`. Read both.
- The store is a module-level `Map`. Single-process worker — same assumption the
  old in-memory gate made. Usage *is* per-account server-side state, so a keyed
  store is semantically honest.

**Salvage map from `app/api/audiences/meta.ts`:**

| Symbol | Destination |
|---|---|
| `facebookRequest`, `parseFacebookResponse`, `tryParseJson`, `hasMetaError`, `formatMetaErrorMessage`, `extractTokenExpirationDetail`, `resolveCredentials`, `resolveTokenAndSecret`, `computeAppSecretProof`, `getApiVersion`, `pickFirstDefinedEnv`, `FacebookCredentialOptions` | `meta-graph.ts` |
| `getClientSafeError`, `isFacebookRateLimitError` | `meta-graph.ts` |
| `listAdAccounts`, `mapAdAccount`, `toNullableNumber`, `getDefaultAdAccountId`, `resolveAdAccountId`, `normalizeAdAccountId`, `hasEnvAccessToken`, `AdAccountListItem` | `meta-ad-accounts.ts` |
| `isMetaServiceError` (#2650 = audience `/users` only) | **drop** |
| `createEmptyAudience`, `uploadHashedUsers`, `addUsersToAudience`, `createAudience`, `deleteAudience`, `listAudiences`, `validateHashedEmails`, `mapAudience`, `deriveAvailability`, `normalizeMetaStatus`, `uploadAudienceUsers`, `postUsersPayload`, all `MetaAudience*` types, `HASH_PATTERN` | **delete** |

**Data flow:**

```
worker → uploadAdImage(bytes)
       → FormData → facebookRequest POST act_X/adimages (access_token + appsecret_proof in query)
       → parseFacebookResponse: recordUsageFromHeaders(response.headers)   // ALL accounts in the header
                              → on throw, attach this account's usage to FacebookApiError
       → tolerant parse → { hash, previewUrl }

page load → listAdAccounts (me/adaccounts)
          → same recordUsageFromHeaders → tier for all 5 accounts, zero extra calls
```

**Error classification (the worker's contract):**

| Condition | Classifier | Worker action |
|---|---|---|
| code 4/17/32/613/80003, or rate-limit text | `isFacebookRateLimitError` | wait `suggestedWaitMs(error.usage, fallback)` |
| code 190 (token expired) | neither | `UnrecoverableError` — fail fast |
| image rejected (format/size/corrupt) | `isMetaMediaRejectionError` | fail fast, Meta's message verbatim |
| undici terminated / ECONNRESET | `isTransientFetchError` (existing) | retry w/ backoff |

`isMetaMediaRejectionError`: `FacebookApiError` with HTTP 400 **and** a
non-rate-limit code — Meta understood the request and refused the asset.
Deliberately **no size threshold** anywhere: the limit is undocumented (research
§Unresolved #1), so Meta is the only authority.

## Related Code Files

**Create:** `meta-graph.ts`, `meta-usage.ts`, `meta-ad-accounts.ts`,
`meta-images.ts`, `meta-images.test.ts` (all under `lib/media-upload/`)

**Modify:**
- `lib/media-upload/facebook-error.ts` — add optional `usage?: MetaUsage` to `FacebookApiError`
- `app/api/facebook/ad-accounts/route.ts` → `@/lib/media-upload/meta-graph` + `meta-ad-accounts`
- `app/api/facebook/tokens/route.ts` → same
- `app/api/facebook/tokens/[id]/route.ts` → `meta-graph`
- `app/api/upload-jobs/route.ts`, `app/api/upload-jobs/[jobId]/route.ts` → `meta-graph` (bodies rewritten in phase 04)
- `workers/media-upload-worker.ts` → `meta-graph` (body rewritten in phase 03)

**Delete:**
- `app/api/audiences/**` (whole dir: `meta.ts`, `route.ts`, `[id]/route.ts`)
- `app/api/facebook/route.ts` — legacy `createAudience` compat route, audience-only
- `app/api/upload-jobs/[jobId]/resume/route.ts` — resume-by-offset gone (phase 04 adds retry)
- `app/api/upload-jobs/[jobId]/stream/route.ts` — **dead code**: `app/page.tsx` polls the list every 2s and never opens an `EventSource`. Per-job SSE would also blow the browser's ~6-connection cap at batch scale

## Implementation Steps

1. **Verify the POST empirically — do not skip, and do not skip it because the
   read-edge probe looked flat.** Two things to settle:

   **(a) POST response shape.** One throwaway upload:
   ```bash
   curl -s -D - -o /tmp/adimages.json \
     -F "smoke.jpg=@/path/to/smoke.jpg" \
     "https://graph.facebook.com/v23.0/act_<ID>/adimages?access_token=<TOKEN>"
   jq . /tmp/adimages.json
   ```
   Record the body verbatim + `X-Business-Use-Case-Usage` in the completion note.
   Whatever it shows, **keep the tolerant parser** — 6 lines, and it covers a
   future Meta change.

   **(b) `call_count` units — percentage or absolute?** Docs say "percentage of
   allowed calls"; the probe's `0` fits both. Make ~5 cheap **reads** against one
   account and watch the value move:
   ```bash
   for i in $(seq 1 5); do
     curl -s -D - -o /dev/null \
       "https://graph.facebook.com/v23.0/act_<ID>?fields=name&access_token=<TOKEN>" \
       | grep -i "business-use-case"
   done
   ```
   - `0 → 1` after ~3 calls ⇒ **percentage** of a ~300/hr quota (1% ≈ 3 calls).
     The ≥90 brake works as designed.
   - value tracks the call count 1:1 (`0→5`) ⇒ **absolute**. The brake threshold
     must then become quota-relative (`300 + 40×active_ads`), or be dropped in
     favour of `estimated_time_to_regain_access` alone. **Report before coding it.**

   Use a read edge for (b) — reads consume the same quota, and this burns 5 of a
   ~300/hr budget. Don't spend writes on it.
2. Create `meta-graph.ts`: move the salvage-map symbols verbatim. Keep
   `FACEBOOK_GRAPH_BASE_URL`, `DEFAULT_FACEBOOK_API_VERSION = "v23.0"`. Export
   `facebookRequest`. Drop `HASH_PATTERN`, `isMetaServiceError`.
3. Create `meta-usage.ts` per the Architecture block. Pure parsing + a `Map`;
   tolerate missing/garbage headers (wrap `JSON.parse` in try/catch → `null`).
   **Normalize keys** (`act_X` / `act:X` / bare → bare) on both write and read.
4. Wire usage into `parseFacebookResponse`: `recordUsageFromHeaders(response.headers)`
   on **every** response, success or error. Since the header is self-describing
   (keyed by account id), `facebookRequest` needs **no** account-key parameter —
   drop that idea. On the error path, look up this call's account (from the path)
   and attach its `usage` to the `FacebookApiError`.
4b. `listAdAccounts` gets the tier for free — expose it on `AdAccountListItem`
   (`tier: MetaAccessTier`) so `GET /api/facebook/ad-accounts` carries it to the
   UI without a new endpoint (phase 05 depends on this).
5. Add `isMetaMediaRejectionError` to `meta-graph.ts`.
6. Create `meta-ad-accounts.ts`: move `listAdAccounts` **unchanged**, including
   the paging loop that re-attaches `appsecret_proof` to `paging.next`
   (`meta.ts:213-239`) — load-bearing and easy to lose in a move.
7. Create `meta-images.ts`:
   ```ts
   export interface AdImageUploadResult {
     hash: string; url: string | null; previewUrl: string | null;
     width: number | null; height: number | null;
   }
   export async function uploadAdImage(input: {
     bytes: ArrayBuffer; fileName: string; contentType?: string | null;
     adAccountId?: string; tokenId?: string;
   }): Promise<AdImageUploadResult>;
   ```
   - `resolveAdAccountId(input.adAccountId)`, `resolveCredentials({tokenId})`.
   - Sanitize the field name to ASCII `[A-Za-z0-9._-]` (fallback `image.jpg`) — it
     lands in a multipart header. Pass the **real** filename as the third arg:
     ```ts
     form.append(fieldName, new Blob([input.bytes], { type }), input.fileName);
     ```
   - `facebookRequest(`${adAccountId}/adimages`, { method: "POST", body: form }, credentials)`.
     Set **no** Content-Type.
   - **Export `parseAdImageResponse(payload, fieldName)`** (exported so vitest can
     reach it without a network call). Order: `payload.images?.[fieldName]` →
     `payload.images?.[firstKey]` → `payload` (flat). No `hash` after all three →
     `FacebookApiError("Meta không trả về image hash.", 502)`. `url_128` → `previewUrl`.
8. `meta-images.test.ts` — the table in Success Criteria. Pure function, no mocks,
   no network.
9. Rewire the 5 importers (mechanical; symbol names unchanged).
10. Delete the files listed above.
11. Gate: `npx tsc --noEmit && npm run lint && npm test && npm run build`, then
    `curl localhost:3000/api/facebook/tokens` and
    `/api/facebook/ad-accounts?tokenId=<id>` → identical payloads to pre-phase.

## Todo List

- [ ] **Step 1 curl** — record body + all usage headers verbatim
- [ ] `meta-graph.ts` — salvage graph core + error helpers
- [ ] `meta-usage.ts` — parse/record/suggestWait (mind seconds vs minutes)
- [ ] Wire usage into `parseFacebookResponse` + `FacebookApiError.usage`
- [ ] `isMetaMediaRejectionError`
- [ ] `meta-ad-accounts.ts` — incl. the `appsecret_proof`-on-paging fix
- [ ] `meta-images.ts` — `uploadAdImage` + exported tolerant parser
- [ ] `meta-images.test.ts` — both shapes + malformed
- [ ] Rewire 5 importers
- [ ] Delete `app/api/audiences/**`, `app/api/facebook/route.ts`, resume + stream routes
- [ ] Build gate; ad-account/token endpoints unchanged

## Success Criteria

- `grep -rn "app/api/audiences" .` (excl. `.git`, `plans/`) → nothing.
- `GET /api/facebook/ad-accounts?tokenId=<id>` returns the same JSON as before.
- Real `uploadAdImage` → a `hash`; asset visible in Ads Manager → Media.
- Same file uploaded twice → **same hash** (idempotency confirmed).
- A `.txt` renamed `.jpg` → `FacebookApiError`, `isMetaMediaRejectionError()` true.
- `getUsage("act_<id>")` after one upload → `tier: "development_access"`, non-null
  `callCount`. **Log the tier — it sets expectations for a 5000-image folder.**
- `GET /api/facebook/ad-accounts` returns `tier` per account with **no extra Meta
  call** (it comes off the `me/adaccounts` response header).
- `npm test` green:

  | `parseAdImageResponse` input | Expect |
  |---|---|
  | `{images:{"smoke.jpg":{hash:"h",url:"u",url_128:"t"}}}`, field `smoke.jpg` | `{hash:"h", previewUrl:"t"}` |
  | `{images:{"bytes":{hash:"h"}}}`, field `smoke.jpg` (key mismatch) | `{hash:"h"}` via first-key fallback |
  | `{hash:"h",url:"u",url_128:"t"}` (flat, as the report claims) | `{hash:"h", previewUrl:"t"}` |
  | `{images:{}}` / `{}` / `{images:{"k":{}}}` | throws `FacebookApiError` 502 |

  | `parseUsageHeaders` input | Expect |
  |---|---|
  | the **verbatim probe payload** (single account, `ads_management`, dev tier) | `tier: "development_access"`, `callCount: 0`, keyed by `679927437761688` |
  | `me/adaccounts`-style header with **5 account keys** | 5 map entries, each with its own tier |
  | `X-Business-Use-Case` (Marketing-API spelling) | parsed identically |
  | no header | empty map, no throw |
  | malformed JSON | empty map, no throw |
  | entry array with several `type`s | picks `ads_management` |
  | `getUsage("act_679927437761688")` / `("act:679…")` / `("679…")` | **all three** resolve to the same entry (key normalization) |

- No file > 200 lines; build gate green.

## Risk Assessment

| Risk | L×I | Mitigation |
|---|---|---|
| **POST response shape ≠ research** → parser reads `undefined.hash` | **High** × **High** | Step 1a verifies the POST live; parser handles both; vitest locks both; explicit 502 rather than a silent `undefined` hash. The probe's flat *read* shape is **not** evidence about the POST |
| **`call_count` is absolute, not a percentage** → a ≥90 brake fires at 90 calls (30% of quota) → 3× slower than necessary | **Med** × Med | Step 1b disambiguates before the brake is coded. Fails safe: an early brake is slow, never incorrect |
| **Key normalization missed** (`act_X` vs bare) → store always returns `null` → pacing silently falls to the floor | **Med** × **High** | Explicit in step 3 + a three-way vitest case. Symptom is invisible (no error, just wrong speed) — that's why it's tested, not eyeballed |
| Minutes unit mix on `regainMinutes` → 60× wrong wait | Med × **High** | Unit-suffixed name; conversion isolated in `suggestedWaitMs`; vitest per unit |
| Marketing-API vs Graph-API header-name contradiction | Med × Med | Read both names |
| `listAdAccounts` move drops the `appsecret_proof` paging fix → 2nd page 400s for app-secret tokens | Med × Med | Called out in step 6; verify on an account with >200 ad accounts, else code-read the diff |
| In-memory usage store wrong under multiple worker processes | Low × Med | Single-process is already required (documented in README). Redis-backed usage is a follow-up if that changes |
| `isMetaMediaRejectionError` too broad → retryable errors fail fast | Med × Med | Narrow: HTTP 400 **and** not rate-limit. The rate-limit check runs first in the worker |
| Image size limit unknown → opaque user-facing failure | High × Med | Meta's message surfaced verbatim into `errorMessage`; shown in the UI (phase 05). No client-side guess |

## Security Considerations

- `appsecret_proof` on **every** call including the paging loop and the multipart
  POST — `facebookRequest` centralizes it; don't hand-roll a fetch in `meta-images.ts`.
- `getClientSafeError` stays the only Meta-error → HTTP path; it must never leak
  `access_token`. The upload URL carries one: **never** put a raw URL into
  `errorMessage`.
- Usage headers are non-secret (percentages/timers) — safe to log and to surface
  in the UI. Do not log the `business_id` key.
- Sanitized multipart field name prevents header injection via a NAS filename.

## Next Steps

Unblocks phase 03 (worker) and phase 04 (routes) — parallel-safe.
