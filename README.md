This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Access tokens

Tokens are managed from the dashboard, not hardcoded in `.env`. Use **Thêm
token** in the header to paste a token (with an optional label, and optional
**App ID + App Secret**); it is validated against Meta (`me/adaccounts`) then
stored **encrypted at rest** in Redis (AES-256-GCM). Set `TOKEN_ENCRYPTION_KEY`
in `.env` first — generate one with `openssl rand -base64 32`. Tokens need
`ads_management` or `ads_read` scope.

- **App ID / App Secret are per token** (no longer read from `.env`). When an
  app secret is provided, every Graph call made with that token carries an
  `appsecret_proof` — required if the app enables "Require app secret", harmless
  otherwise. Leave both blank for apps that don't require it. The app secret is
  encrypted alongside the token; the app id is stored as a plain reference.
- Raw tokens and app secrets never round-trip back to the browser; only token
  ids (and the non-secret app id) do.
- The picker remembers the selected token per browser (localStorage stores the
  id, never the secret).
- `FACEBOOK_ACCESS_TOKEN` in `.env` still works as the optional default token.
- Each upload job snapshots the chosen token id so the worker (a separate
  process) resolves the same token from Redis.

## Ad account selection

The dashboard fetches every ad account the **active token** can reach (Graph
`me/adaccounts`) and shows them in a picker in the header — no need to hardcode
the target account. The picked account is remembered per browser and is
snapshotted onto each upload job so the worker creates the audience under the
right account. `FACEBOOK_AD_ACCOUNT_ID` is now only an optional default.

## Resuming a large upload from an offset

Big files are uploaded in 10 MB ranges; the worker tracks how many bytes have
been **confirmed-uploaded to Meta** and shows it per job ("Đã up: X MB"). The
tracked offset is conservative — it never runs ahead of what Meta received.

If a job fails (e.g. Meta `#2650` exhausts its retries), the failed row shows the
uploaded offset and a suggested **start offset in MB**. To continue, create a new
upload job for the **same file** and enter that MB value in **"Bắt đầu từ offset
(MB)"** — the worker range-reads from there instead of re-uploading the whole
file. The suggested value is rounded **down** on purpose: starting slightly early
re-sends a few already-uploaded rows (Meta de-duplicates by hash), whereas
starting too late would skip data. Requires a NAS that supports HTTP Range.

## Per-ad-account upload concurrency

The worker runs **at most one job per ad account (act_id) at a time**, while jobs
for different ad accounts run in parallel. Each ad account also has its own Meta
request throttle, so two accounts upload at full independent rates instead of
sharing one global gate. A job whose ad account is already busy is deferred (no
retry attempt consumed) until the account frees up. Set
`UPLOAD_WORKER_CONCURRENCY` to at least the number of ad accounts you upload with
(default 4). Concurrency is coordinated in-memory, so run a single worker
process.

## NAS WebDAV

The dashboard can browse files from a NAS WebDAV endpoint and load them into the upload flow.
Set `WEBDAV_BASE_URL` to your NAS endpoint, and optionally `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` if basic auth is required.

# fb-audience-uploader
