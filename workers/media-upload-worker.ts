// One BullMQ job per image: read NAS bytes → POST act_X/adimages → record
// hash. No streaming, no chunking, no resume (see plan.md scope decisions).
// Throttle/pacing lives in media-upload-throttle.ts, error classification +
// retry/backoff in media-upload-retry.ts — both split out purely to keep
// this file under the 200-line guideline.
//
// GATE REMOVAL — reverses `0f8756f` / `6e34a33` (deliberate, not an
// oversight). Those commits added a per-app then per-ad-account "one job at
// a time" mutex, correct for the audience-upload workload it was written
// for: few, multi-hour jobs, where a job waiting on a busy gate could afford
// a 10s busy-recheck. Image uploads invert the shape: thousands of ~1s
// POSTs per batch — the old gate would serialize a batch one-at-a-time per
// account and make every waiter sleep ACCOUNT_BUSY_RETRY_DELAY_MS (10s)
// rechecking a gate that frees in ~1s (~14h idle-waiting on Standard tier).
// `acquireMetaRequestSlot` (media-upload-throttle.ts) is a Redis
// `SET NX PX` mutex per ad account that already enforces the real
// constraint — a minimum interval between Meta calls — so the gate only
// added coarser exclusion on top of a throttle that already implies it.
// Blocking exit criterion: media-upload-throttle.test.ts proves the mutex
// alone holds under N concurrent workers on one account, against real
// Redis.

import { UnrecoverableError, Worker, type Job } from "bullmq";
import { fileURLToPath } from "node:url";

import { getBatch } from "../lib/media-upload/batches";
import { getMediaUploadConfig } from "../lib/media-upload/env";
import { getMediaUploadJob, transitionJobStatus } from "../lib/media-upload/jobs";
import { uploadAdImage } from "../lib/media-upload/meta-images";
import { getBullConnectionOptions } from "../lib/media-upload/redis";
import type { MediaUploadBatch, MediaUploadJobPayload } from "../lib/media-upload/types";
import { describeFetchError } from "../lib/resilient-fetch";
import { fetchWebDavFileBuffer } from "../lib/webdav.server";
import { acquireMetaRequestSlot, logUsageProgress, resolveAccountKey } from "./media-upload-throttle";
import {
  buildRetryMessage,
  DEFAULT_RETRY_DELAY_MS,
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

async function processJob(bullJob: BullJob) {
  const { jobId } = bullJob.data;
  const job = await getMediaUploadJob(jobId);

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
    await acquireMetaRequestSlot(accountKey, getMediaUploadConfig().metaRequestIntervalMs);

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
    throw translateUploadError(error);
  }
}

async function handleFailedJob(bullJob: BullJob | undefined, error: Error) {
  const jobId = bullJob?.data?.jobId;
  const attemptsMade = bullJob?.attemptsMade ?? 0;
  const maxAttempts = bullJob?.opts?.attempts ?? 1;

  console.error(
    `[media-upload-worker] failed ${bullJob?.id ?? "unknown"} (jobId=${jobId}, attempts=${attemptsMade}/${maxAttempts}): ${describeFetchError(error)}`
  );

  if (!jobId) return;

  if (bullJob && shouldRetryLater(bullJob, error)) {
    const nextRetryAt = new Date(Date.now() + metaAwareRetryDelayMs(attemptsMade, error)).toISOString();
    await transitionJobStatus(jobId, "queued", { errorMessage: buildRetryMessage(error), nextRetryAt });
  } else {
    await transitionJobStatus(jobId, "failed", { errorMessage: error.message });
  }
}

async function main() {
  const config = getMediaUploadConfig();

  const worker = new Worker<MediaUploadJobPayload>(config.queueName, processJob, {
    connection: getBullConnectionOptions(),
    concurrency: config.workerConcurrency,
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
