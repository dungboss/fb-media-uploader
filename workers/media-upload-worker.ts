// One BullMQ job per image: read NAS bytes → POST act_X/adimages → record
// hash. No streaming, no chunking, no resume (see plan.md scope decisions).
// Error classification lives in media-upload-retry.ts, usage logging in
// media-upload-usage-log.ts — both split out purely to keep this file under
// the 200-line guideline.
//
// BURST MODE — no pre-emptive pacing, react to Meta instead. Reverses the
// per-ad-account throttle (`1f75e3f` / `d261a55`) AND, before it, the
// concurrency gate (`0f8756f` / `6e34a33`). Explicit product decision
// (2026-07-16): upload as fast as Meta allows, and when Meta says stop, wait
// and resume.
//
// Why the throttle went: it paced dev-tier accounts at a fixed 15s (~240
// images/hr) chosen to stay under a `300 + 40 × active_ads` calls/hr quota.
// But `active_ads` is unknown to us, so 15s was a guess at the FLOOR of that
// quota — an account with many active ads may allow thousands/hr, and the
// throttle would leave all of it unused while claiming a precise "240/hr" the
// UI then repeated to the operator. Pacing never raises the ceiling; only the
// quota does. So: run flat out, let Meta's 429 define the real ceiling, and
// log `call_count` (media-upload-usage-log.ts) so the ceiling gets MEASURED
// rather than guessed.
//
// Why this is not a 429 storm: a rate-limited job is not a failed job. It
// throws `Worker.RateLimitError()` after `worker.rateLimit(waitMs)`, which
// returns the job to `wait` WITHOUT consuming an attempt (measured, not
// assumed — attemptsMade stayed [0,0,0,0] across 3 rate limits in a real-Redis
// probe) and pauses the WHOLE worker for waitMs. waitMs is Meta's own
// `estimated_time_to_regain_access` when it sends one, else
// UPLOAD_META_RATE_LIMIT_DELAY_MS (5 min). So the worker self-tunes to Meta's
// actual quota: burst → 429 → sleep → burst.
//
// NOTE on the `limiter` option below: the BullMQ docs say "limiter.max is
// used to determine if we need to execute the rate limit validation", which
// reads as "worker.rateLimit() no-ops without it". MEASURED FALSE on bullmq
// 5.79.1 (2026-07-16): rateLimit(1500ms)×3 took 4519ms with the limiter and
// 4515ms without — identical. It is kept, set deliberately high, purely as
// cheap insurance in case a future version makes the documented rule true.
// Nothing here depends on it today; do not add anything that does.

import { UnrecoverableError, Worker, type Job } from "bullmq";
import { fileURLToPath } from "node:url";

import { getBatch } from "../lib/media-upload/batches";
import { getMediaUploadConfig } from "../lib/media-upload/env";
import { FacebookApiError } from "../lib/media-upload/facebook-error";
import { getMediaUploadJob, transitionJobStatus } from "../lib/media-upload/jobs";
import { uploadAdImage } from "../lib/media-upload/meta-images";
import { getBullConnectionOptions } from "../lib/media-upload/redis";
import type { MediaUploadBatch, MediaUploadJobPayload } from "../lib/media-upload/types";
import { describeFetchError } from "../lib/resilient-fetch";
import { fetchWebDavFileBuffer } from "../lib/webdav.server";
import { logUsageProgress, resolveAccountKey } from "./media-upload-usage-log";
import {
  buildRetryMessage,
  DEFAULT_RETRY_DELAY_MS,
  isMetaRateLimitRetryError,
  JobCancelledError,
  metaAwareRetryDelayMs,
  shouldRetryLater,
  translateUploadError,
} from "./media-upload-retry";

// Ad account + token live on the batch, not the job — one getBatch per job,
// cached per batchId (batches are immutable after creation).
const batchCache = new Map<string, MediaUploadBatch>();

async function getBatchCached(batchId: string): Promise<MediaUploadBatch> {
  const cached = batchCache.get(batchId);
  if (cached) return cached;
  const batch = await getBatch(batchId);
  if (!batch) throw new UnrecoverableError(`Batch ${batchId} không tồn tại.`);
  batchCache.set(batchId, batch);
  return batch;
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  return (await getMediaUploadJob(jobId)).status === "cancelled";
}

type BullJob = Job<MediaUploadJobPayload>;

// Assigned in main(). processJob needs it to call `worker.rateLimit()` on a
// 429, which is what pauses every job — not just this one — for Meta's
// suggested wait.
let worker: Worker<MediaUploadJobPayload>;

async function processJob(bullJob: BullJob) {
  const { jobId } = bullJob.data;

  // Orphan guard: deleting a batch removes its job records but cannot recall
  // BullMQ jobs already handed to the queue, so a delete mid-drain leaves
  // queue entries pointing at records that no longer exist. That is a normal
  // user action, not corruption — drop the job instead of retrying it
  // UPLOAD_JOB_ATTEMPTS times against a record that will never come back.
  const job = await getMediaUploadJob(jobId).catch((error) => {
    if (isJobRecordMissing(error)) return null;
    throw error;
  });
  if (!job) {
    console.warn(`[media-upload-worker] bỏ qua job mồ côi ${jobId} (batch đã bị xoá)`);
    return { jobId, orphaned: true };
  }

  if (job.status === "completed") return { jobId, imageHash: job.imageHash };
  if (job.status === "cancelled") return { jobId, cancelled: true };

  await transitionJobStatus(jobId, "processing", { errorMessage: "", nextRetryAt: null });

  try {
    const batch = await getBatchCached(job.batchId);
    if (await isJobCancelled(jobId)) throw new JobCancelledError();

    const { buffer, contentType } = await fetchWebDavFileBuffer(job.nasFilePath);

    // OOM guard only — NOT Meta's (unknown) documented image size limit.
    if (buffer.byteLength > getMediaUploadConfig().maxFileBytes) {
      throw new UnrecoverableError(`File ${job.fileName} (${buffer.byteLength} bytes) vượt quá giới hạn OOM-guard.`);
    }

    const accountKey = resolveAccountKey(batch.adAccountId, batch.tokenId);

    const result = await uploadAdImage({
      bytes: buffer,
      fileName: job.fileName,
      contentType,
      adAccountId: batch.adAccountId ?? undefined,
      tokenId: batch.tokenId ?? undefined,
    });

    logUsageProgress(accountKey);
    await transitionJobStatus(jobId, "completed", { imageHash: result.hash, previewUrl: result.previewUrl });
    return { jobId, imageHash: result.hash };
  } catch (error) {
    if (error instanceof JobCancelledError) {
      await transitionJobStatus(jobId, "cancelled");
      return { jobId, cancelled: true };
    }

    const translated = translateUploadError(error);

    // A 429 is Meta telling us the real ceiling — not a bad image. Park the
    // job back on `wait` (no attempt consumed) and stop the whole worker for
    // the wait Meta asked for. `Worker.RateLimitError` is the only thing
    // BullMQ accepts as "this was not a failure"; a plain throw here would
    // burn an attempt and eventually mark a perfectly good image `failed`.
    if (isMetaRateLimitRetryError(translated)) {
      const waitSeconds = Math.round(translated.waitMs / 1000);
      console.warn(`[media-upload-worker] rate limited by Meta — pausing ${waitSeconds}s: ${translated.message}`);
      await transitionJobStatus(jobId, "queued", {
        errorMessage: buildRetryMessage(translated),
        nextRetryAt: new Date(Date.now() + translated.waitMs).toISOString(),
      });
      await worker.rateLimit(translated.waitMs);
      throw Worker.RateLimitError();
    }

    throw translated;
  }
}

// A job record vanishes when its batch is deleted (see the orphan guard in
// processJob). Both call sites must tolerate it: the record is gone for good,
// so there is nothing to write and nothing to fix.
function isJobRecordMissing(error: unknown): boolean {
  return error instanceof FacebookApiError && error.status === 404;
}

// MUST NOT THROW. This is a `worker.on("failed")` handler, so its rejection is
// nobody's to catch — an unhandled rejection takes the whole worker process
// down, and `dev:all`'s --kill-others-on-fail takes the web server with it.
// That is not hypothetical: `transitionJobStatus` throws 404 on a deleted job
// record, so before this try/catch, deleting a batch mid-drain crashed the
// worker while it was recording an unrelated job's failure. Bookkeeping must
// never outrank staying alive.
async function handleFailedJob(bullJob: BullJob | undefined, error: Error) {
  const jobId = bullJob?.data?.jobId;
  const attemptsMade = bullJob?.attemptsMade ?? 0;
  const maxAttempts = bullJob?.opts?.attempts ?? 1;

  console.error(
    `[media-upload-worker] failed ${bullJob?.id ?? "unknown"} (jobId=${jobId}, attempts=${attemptsMade}/${maxAttempts}): ${describeFetchError(error)}`
  );

  if (!jobId) return;

  try {
    if (bullJob && shouldRetryLater(bullJob, error)) {
      const nextRetryAt = new Date(Date.now() + metaAwareRetryDelayMs(attemptsMade, error)).toISOString();
      await transitionJobStatus(jobId, "queued", { errorMessage: buildRetryMessage(error), nextRetryAt });
    } else {
      await transitionJobStatus(jobId, "failed", { errorMessage: error.message });
    }
  } catch (bookkeepingError) {
    if (isJobRecordMissing(bookkeepingError)) {
      console.warn(`[media-upload-worker] job ${jobId} không còn record để ghi trạng thái (batch đã bị xoá)`);
      return;
    }
    console.error(`[media-upload-worker] không ghi được trạng thái lỗi cho job ${jobId}:`, bookkeepingError);
  }
}

async function main() {
  const config = getMediaUploadConfig();

  worker = new Worker<MediaUploadJobPayload>(config.queueName, processJob, {
    connection: getBullConnectionOptions(),
    concurrency: config.workerConcurrency,
    // Deliberately high — burst mode. Not load-bearing (see the limiter note
    // in this file's header); lower it to re-introduce a hard pacing cap
    // without touching code.
    limiter: { max: config.workerRateLimitMax, duration: config.workerRateLimitDurationMs },
    settings: {
      backoffStrategy: (attemptsMade, type, error) =>
        type === "meta-aware" ? metaAwareRetryDelayMs(attemptsMade, error) : DEFAULT_RETRY_DELAY_MS,
    },
  });

  worker.on("completed", (bullJob) => {
    console.info(`[media-upload-worker] completed ${bullJob.id} (jobId=${bullJob.data.jobId})`);
  });
  worker.on("failed", (bullJob, error) => void handleFailedJob(bullJob, error));

  const shutdown = async (signal: string) => {
    console.info(`[media-upload-worker] shutting down on ${signal}`);
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.info(`[media-upload-worker] listening queue=${config.queueName} concurrency=${config.workerConcurrency}`);
}

// Only run the worker loop when this file is executed directly (tsx
// workers/media-upload-worker.ts) — never on import, so tests can import
// from the sibling throttle/retry modules without starting a real Worker.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    console.error("[media-upload-worker] fatal", error);
    process.exit(1);
  });
}
