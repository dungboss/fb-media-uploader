# Inngest TypeScript SDK Research (Mid-2026)

**Research Date:** 2026-07-16 | **Report Version:** v4.5.1+ (TypeScript SDK v4 GA)

---

## ⚠️ CORRECTIONS — three claims below are WRONG (measured 2026-07-16)

This report was written from docs and search results. Three of its load-bearing
claims did not survive measurement against inngest@4.13.0 + `inngest dev`. The
original text is left intact below so the mistakes stay visible; read these
corrections first.

**1. "RetryAfterError does NOT consume a retry attempt" (§4) — FALSE.**
It consumes an attempt exactly like any other thrown error. Measured twice with
`retries: 2` and an always-throwing `RetryAfterError`: the run executed
attempt=0, 1, 2 and then Inngest emitted `inngest/function.failed`. The docs
(`inngest-errors`, `retries`) state nothing either way — they only say it
"delays the next retry attempt", which if anything implies the opposite of this
report's claim. **This matters:** a Meta 429 is not a bad image, so letting it
burn attempts marks good images `failed` during any long rate-limited window.
The fix used in this codebase: never throw on 429 — return a sentinel from the
step (so the step succeeds and costs no attempt), then `step.sleep()` and retry.

**2. Every `createFunction` code sample (§4, and §3's implied shape) is v3 —
it throws on v4.** v4 moved triggers INTO the config object and made the
handler the second argument. The 3-arg form fails at import with:
`"createFunction" expected a handler function as the second argument. Triggers
belong in the first argument`. Correct v4 form:
```ts
inngest.createFunction(
  { id: "x", retries: 2, triggers: { event: "a/b" } },
  async ({ event, step, attempt }) => { /* ... */ }
);
```

**3. `RetryAfterError`'s numeric argument is MILLISECONDS, converted to whole
seconds (rounded up, min 1s)** — §4 shows it untyped and its example passes a
raw `retry-after` header value, which invites treating it as seconds. Measured:
`500` → `retryAfter: '1'`; `5000` → `retryAfter: '5'` with an observed gap of
5006ms; `"30s"` → `retryAfter: '30'`.

Also unverified, flagged rather than trusted: the SDK accepts `retries: 100`
client-side without complaint, but whether the Inngest **server** caps it (docs
give no maximum) was not established.

---

## 1. Next.js App Router Serve Handler

**Exact Import Path & Code:**
```typescript
import { serve } from "inngest/next";
import { inngest } from "../inngest/client";
import fnA from "../inngest/fnA"; // Import your functions

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [fnA],
});
```

**File Location:** `src/app/api/inngest/route.ts`

**Required HTTP Methods:** **GET, POST, PUT** — all three must be exported for App Router.
- **GET**: Returns function metadata, renders landing page in dev
- **POST**: Invokes functions with request body as state
- **PUT**: Registers all functions with Inngest using signing key

**Current SDK Major Version:** v4 (GA as of March 16, 2026)
- Latest version: **v4.13.0+** (check `npm view inngest version` for absolute latest)
- Changelog: https://www.inngest.com/changelog/2026-03-17-typescript-sdk-v4-ga
- Prior stable: v3.x (v4 requires migration; most apps are trivial)

**Sources:**
- https://www.inngest.com/docs/learn/serving-inngest-functions
- https://www.inngest.com/changelog/2026-03-17-typescript-sdk-v4-ga

---

## 2. Signing Key & Request Verification

**INNGEST_SIGNING_KEY Verification:** **AUTOMATIC** — no additional config needed in most cases.

**How it works:**
- All requests from Inngest to your endpoint are signed with a timestamp embedded in the signature
- The Inngest SDK's `serve()` handler automatically validates all incoming requests
- Old/replayed requests are rejected (timestamp-based anti-replay)
- Environment variable `INNGEST_SIGNING_KEY` must be set for production; fallback key `INNGEST_SIGNING_KEY_FALLBACK` supports zero-downtime key rotation

**Quote from official docs:**
> "All requests sent to your server are signed with the signing key, ensuring that they originate from Inngest. Inngest SDKs reject all requests that are not authenticated with the signing key."

**Regarding HTTP Basic Auth + Inngest Endpoint:**

The user reports "Next 16 proxy.ts with no matcher" puts HTTP Basic Auth on every route. Inngest calls would receive 401.

**Recommended Solution:** Use Next.js `proxy.ts` (formerly middleware.ts) **matcher option** to exclude the Inngest endpoint.

Example `proxy.ts`:
```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Auth logic here
  // ...
}

export const config = {
  matcher: [
    // Match all routes EXCEPT /api/inngest
    '/((?!api/inngest).*)',
  ],
};
```

**Important caveat:** Proxy should NOT be the only auth layer. The Inngest serve handler itself verifies requests via signing key, so even without HTTP Basic Auth protection, Inngest requests are authenticated. However, using matcher to skip auth middleware is the cleanest pattern for framework integration.

**Why this works:**
1. Inngest's signing key verification is independent of HTTP Basic Auth
2. Proxy matcher allows selective protection
3. The Inngest endpoint at `/api/inngest` gets signature verification from the SDK handler automatically

**Sources:**
- https://www.inngest.com/docs/platform/signing-keys
- https://www.inngest.com/docs/learn/security
- https://nextjs.org/docs/app/getting-started/proxy

---

## 3. Execution Model & Limits

**Free/Hobby Tier Limits (Current 2026):**

| Metric | Limit |
|--------|-------|
| Concurrent steps | 5 |
| Max event payload size | 256 KiB |
| Max function run length | 30 days |
| Max step timeout | 2 hours (7,200,000 ms) |
| Max sleep duration | 7 days |
| Trace/log history retention | 24 hours |
| Executions per month | ~50,000 (reports vary; exact figure TBD) |

**Execution Definition:** One "execution" = one function run or one step.run() invocation. Steps are independent units; each step has its own retry counter.

**Step Timeout Context (Critical for your use case):**
> "Each step has a timeout depending on the hosting provider of your choice...but Inngest supports up to `2 hours` at the maximum."

Since you upload files up to ~100 MB to Facebook's Graph API, a 2-hour step timeout is sufficient for slow uploads. However, your provider's timeout (e.g., Vercel: 60s, AWS Lambda: 15min) may be stricter. If using serverless, you may need to either:
1. Upgrade to a higher tier for extended step duration
2. Use `step.sleep()` to checkpoint before upload (not ideal for this use case)
3. Deploy to a platform with longer timeout support (containers, VPS)

**Billing:** Executions are counted per function invocation and per step invocation. Sleeping/waiting steps do NOT count against concurrency.

**Sources:**
- https://www.inngest.com/docs/usage-limits/inngest
- https://www.inngest.com/docs/learn/inngest-steps

---

## 4. Rate Limiting, Backoff & Retry Control

**RetryAfterError:**

**Signature (TypeScript):**
```typescript
new RetryAfterError(
  message: string,
  retryAfter: number | string | Date,
  options?: { cause?: Error }
): RetryAfterError
```

**Usage Example:**
```typescript
if (response.status === 429) {
  throw new RetryAfterError(
    "Rate limited by Facebook API",
    response.headers['retry-after'] || '30s'  // accepts: number (ms), string ("30s", "2m"), or Date
  );
}
```

**Does RetryAfterError consume a retry attempt?**
**No — it does NOT consume a retry attempt.** It schedules a delayed retry outside the normal retry budget. This is ideal for 429 backoff scenarios.

**NonRetriableError:**
```typescript
throw new NonRetriableError("Invalid input", { cause: err });
```
Prevents any retry; fails immediately. Use for unrecoverable errors (bad API key, 400, etc).

**Default Retry Behavior:**
- **Default retries per function/step:** 4 retries = 5 total attempts
- **Each step has independent retry counter:** If a function has 5 steps and 4 configured retries, each step can retry independently (not shared pool)
- **Retry strategy:** Exponential backoff (configurable)

**Per-Function Concurrency & Throttling:**

**Concurrency (limits executing steps):**
```typescript
inngest.createFunction(
  {
    id: "my-function",
    concurrency: {
      limit: 10,  // Max 10 steps executing at once for this function
      scope: "fn",  // fn (default), env, or account
      key: "event.data.customer_id",  // Optional: per-user limits using CEL
    },
  },
  { event: "user/upload.requested" },
  async ({ event, step }) => { /* ... */ }
);
```

**Throttling (limits new runs started per time window):**
```typescript
inngest.createFunction(
  {
    id: "my-function",
    throttle: {
      limit: 100,      // Max 100 runs start within period
      period: "1h",    // Time window
      burst: 10,       // Additional burst allowance
      key: "event.data.api_key",  // Optional: per-entity limits
    },
  },
  { event: "api/request" },
  async ({ event, step }) => { /* ... */ }
);
```

**Key Difference:**
- **Concurrency:** Limits *executing* steps (resource protection). Function runs can pause without consuming concurrency.
- **Throttling:** Limits *new* runs started per time period (request rate control). Does not limit executing steps.

**For your Facebook upload case:** Use **concurrency** to respect their API rate limits.

**Sources:**
- https://www.inngest.com/docs/features/inngest-functions/error-retries/inngest-errors
- https://www.inngest.com/docs/features/inngest-functions/error-retries/retries
- https://www.inngest.com/docs/guides/error-handling
- https://www.inngest.com/docs/functions/concurrency
- https://www.inngest.com/docs/guides/throttling

---

## 5. Bulk Event Enqueue

**Can you send thousands of events in one call?** Yes, `inngest.send([...])` supports bulk.

**Limits:**
- **Max events per request:** 5,000
- **Max total payload per request:** 10 MiB
- **Max single event payload:** 256 KiB (Free), 512 KiB (Basic), 3 MiB (Pro)
- **Default request size:** 512 KB (can be increased for higher-tier plans on request)

**Example:**
```typescript
const events = [];
for (let i = 0; i < 5000; i++) {
  events.push({
    name: "media/upload.requested",
    data: { userId: "123", url: "s3://..." },
  });
}
await inngest.send(events);  // All 5000 sent in one HTTP call
```

**Practical note:** If you have more than 5000 events, chunk them and make multiple send() calls (each in parallel via Promise.all() if desired).

**Sources:**
- https://www.inngest.com/docs/guides/batching
- https://www.inngest.com/docs/usage-limits/inngest

---

## 6. Local Development Setup

**Dev Server Command:**
```bash
inngest dev -u http://localhost:3000/api/inngest
```

**What happens:**
1. Inngest CLI runs a local, in-memory copy of Inngest (no external DB/Redis needed initially)
2. Auto-discovery scans common ports/endpoints like `http://localhost:3000/api/inngest`
3. Server polls your app for function definitions every ~0.5s (configurable via `--poll-interval`)
4. Dev server UI available at http://localhost:8288

**Environment variable required:**
```bash
INNGEST_DEV=1  # Tells Inngest SDK to use local dev server instead of cloud
```

**Public internet required?** **No.** The dev server polls your local app. Your app does NOT need to be publicly reachable. Polling is unidirectional: dev server → your localhost.

**Auto-discovery behavior:**
- Scans ports: 3000-3010, 5000, 5173, 8000, 8080, 8787, etc.
- Scans endpoints: `/api/inngest`, `/.netlify/functions/inngest`, etc.
- Disable with `--no-discovery` if you need manual config

**Full setup for a fresh clone:**
```bash
# Terminal 1: Start your Next.js app
npm run dev  # Runs on localhost:3000

# Terminal 2: Start Inngest dev server
inngest dev -u http://localhost:3000/api/inngest

# Open http://localhost:8288 to see UI
```

**No additional infrastructure needed.** SQLite and in-memory Redis are bundled.

**Sources:**
- https://www.inngest.com/docs/local-development

---

## 7. Self-Hosting

**Is there a supported OSS Inngest server?** **Yes.** Inngest is open source and supports self-hosting.

**Storage Options:**

| Storage | Notes |
|---------|-------|
| **SQLite** (default) | Bundled, zero-dependency, single-node only. Stored at `./.inngest/main.db` |
| **PostgreSQL** | For scaling beyond single-node. Set `postgres-uri` flag or env var `INNGEST_POSTGRES_URI`. Supports AWS RDS, Neon, Supabase, etc. |
| **Redis** | Bundled in-memory Redis for queue/state store (default). Can use external Redis via `redis-uri` flag for persistence/failover. |

**Minimum Self-Hosted Setup:**
```bash
# Single-node with SQLite (development)
inngest server

# Production with Postgres + Redis
inngest server \
  --postgres-uri "postgres://user:pass@db.example.com/inngest" \
  --redis-uri "redis://redis.example.com:6379"
```

**Deployment Options:**
- Docker (official images available)
- Kubernetes (Helm chart available at https://github.com/inngest/inngest-helm)
- Railway, Zeabur, Dokploy (pre-configured templates)

**Dependencies Summary:**
- **SQLite only:** Zero external dependencies
- **Production:** PostgreSQL + (optional) Redis for HA
- No separate worker processes needed; server handles execution internally

**Breaking news:** Postgres persistence support added January 2025, enabling proper HA/scaling past single-node limits.

**Sources:**
- https://www.inngest.com/docs/self-hosting
- https://github.com/inngest/inngest
- https://github.com/inngest/inngest-helm

---

## Key Takeaways for Your FB Media Uploader

1. **Serve handler is automatic:** Just export GET/POST/PUT from route.ts; signing key verification is built-in.
2. **HTTP Basic Auth + Inngest:** Use proxy.ts matcher to exclude `/api/inngest` path.
3. **Step timeout is 2 hours max:** Sufficient for 100MB uploads if provider supports it (watch serverless limits).
4. **RetryAfterError for rate limits:** Doesn't consume retries; ideal for Facebook 429s.
5. **Per-function concurrency:** Use to throttle parallel uploads respecting Facebook API limits.
6. **Bulk enqueue:** Supports 5000 events / 10MB per request; chunk if needed.
7. **Local dev:** `inngest dev` polls localhost; no public internet or extra infra needed.
8. **Free tier:** 5 concurrent steps, 256 KiB events, 30-day function duration. Upgrade if you hit limits.

---

## Unresolved Questions

1. **Exact current version:** Search returned v4.13.0 and v4.5.1; npm registry may show newer. Verify with `npm view inngest version`.
2. **Free tier executions cap:** Sources cite "~50,000" and "5,000 per month" inconsistently. Pricing page (https://www.inngest.com/pricing) is authoritative; docs page not accessible.
3. **Serverless provider timeouts:** Your app's timeout depends on Vercel/Lambda/etc., not just Inngest's 2-hour support. Verify your provider's max step duration.
4. **Exact Postgres setup for HA:** Helm chart docs are available, but specific failover/replication config for prod not fully covered in web search results.

---

**Status:** DONE_WITH_CONCERNS

**Concerns:**
- Unresolved Q#2 (free tier cap) and Q#3 (provider limits) require either checking official pricing or testing in your environment.
- HTTP Basic Auth exemption is pattern-based on Next.js proxy matcher; not explicitly documented by Inngest (but is the recommended approach based on framework best practices).

**Report compiled from:** Official Inngest docs (inngest.com/docs), npm changelog, GitHub releases, and web search of mid-2026 sources.
