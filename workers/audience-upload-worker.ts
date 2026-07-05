import { DelayedError, UnrecoverableError, Worker } from "bullmq";

import {
  createEmptyAudience,
  isFacebookRateLimitError,
  isMetaServiceError,
  uploadHashedUsers,
} from "../app/api/audiences/meta";
import { getAudienceUploadConfig } from "../lib/audience-upload/env";
import {
  getAudienceUploadJob,
  markAudienceUploadJobCompleted,
  markAudienceUploadJobFailed,
  patchAudienceUploadJob,
} from "../lib/audience-upload/jobs";
import {
  getBullConnectionOptions,
  getRedis,
} from "../lib/audience-upload/redis";
import {
  getNasFileMeta,
  streamNasFileLines,
} from "../lib/audience-upload/storage";
import {
  describeFetchError,
  isTransientFetchError,
} from "../lib/resilient-fetch";
import type { AudienceUploadJobPayload } from "../lib/audience-upload/types";

const DEFAULT_RETRY_DELAY_MS = 5_000;
// Per-ad-account Meta request throttle: one self-expiring key per ad account so
// different accounts pace independently (and can upload in parallel).
const META_REQUEST_THROTTLE_PREFIX = "audience-upload:meta-request-throttle";
// A job whose ad account is already busy is deferred by this long, then retried.
const ACCOUNT_BUSY_RETRY_DELAY_MS = 10_000;

// Ad-account keys currently being processed by THIS worker process. Enforces "at
// most one job per ad account (act_id) at a time" while letting different
// accounts run concurrently. In-memory is sufficient because a single Worker
// runs all concurrent handlers in one process; BullMQ already prevents two
// workers from taking the same job.
const activeAccountKeys = new Set<string>();

// Resolves the concurrency/throttle bucket for a job: its ad account id, else
// the token id, else a shared default bucket.
function resolveAccountKey(
  adAccountId: string | null,
  tokenId: string | null
): string {
  const account = adAccountId?.trim();
  if (account) {
    return `act:${account}`;
  }
  const token = tokenId?.trim();
  return token ? `token:${token}` : "default";
}

async function main() {
  const config = getAudienceUploadConfig();
  const worker = new Worker<AudienceUploadJobPayload>(
    config.queueName,
    async (bullJob, token) => {
      const { jobId } = bullJob.data;
      let uploadJob = await getAudienceUploadJob(jobId);

      if (uploadJob.status === "completed") {
        return {
          jobId,
          audienceId: uploadJob.audienceId,
          syncedHashCount: uploadJob.syncedHashCount,
        };
      }

      // Honor cancellation: never resurrect a cancelled job back to processing.
      if (uploadJob.status === "cancelled") {
        console.info(
          `[audience-upload-worker] job ${jobId} already cancelled, skipping.`
        );
        return {
          jobId,
          audienceId: uploadJob.audienceId,
          syncedHashCount: uploadJob.syncedHashCount,
          cancelled: true,
        };
      }

      // Per-ad-account concurrency gate: at most one job per ad account (act_id)
      // processes at a time; a same-account job is deferred (no attempt consumed)
      // so the worker can run other accounts' jobs meanwhile.
      const accountKey = resolveAccountKey(
        uploadJob.adAccountId,
        uploadJob.tokenId
      );
      if (activeAccountKeys.has(accountKey)) {
        console.info(
          `[audience-upload-worker] job ${jobId} deferred: ${accountKey} busy`
        );
        await bullJob.moveToDelayed(
          Date.now() + ACCOUNT_BUSY_RETRY_DELAY_MS,
          token
        );
        throw new DelayedError();
      }
      activeAccountKeys.add(accountKey);

      try {
      await patchAudienceUploadJob(jobId, {
        status: "processing",
        errorMessage: "",
        // No longer waiting — clear any prior retry countdown.
        nextRetryAt: null,
        updatedAt: new Date().toISOString(),
      });
      uploadJob = await getAudienceUploadJob(jobId);

      let audienceId = uploadJob.audienceId;

      // Resume point: lines already confirmed-synced to Meta in a previous
      // attempt. On a BullMQ retry these counts survive in Redis, so we re-read
      // the file but skip re-sending them and continue where we left off.
      const resume = {
        syncedLines: uploadJob.syncedLines,
        syncedHashCount: uploadJob.syncedHashCount,
        syncedByteOffset: uploadJob.syncedByteOffset,
      };
      if (resume.syncedLines > 0) {
        console.info(
          `[audience-upload-worker] resuming job ${jobId} from line ${resume.syncedLines} (already synced).`
        );
      }

      try {
        // Create audience if needed (skipped on retry — audienceId is persisted).
        if (uploadJob.kind === "create" && !audienceId) {
          const createdAudience = await retryMetaAware(() =>
            createEmptyAudience({
              name: uploadJob.name,
              description: uploadJob.description,
              // Snapshotted at job creation; falls back to the .env defaults
              // inside createEmptyAudience when null (older jobs / unset).
              adAccountId: uploadJob.adAccountId ?? undefined,
              tokenId: uploadJob.tokenId ?? undefined,
            })
          );

          audienceId = createdAudience.id;
          await patchAudienceUploadJob(jobId, {
            audienceId,
            status: "processing",
            updatedAt: new Date().toISOString(),
          });
        }

        if (!audienceId) {
          throw new Error("Worker chưa có audienceId để sync dữ liệu lên Meta.");
        }

        // Get file metadata
        const fileMeta = await getNasFileMeta(uploadJob.nasFilePath);
        console.info(
          `[audience-upload-worker] nas file ${uploadJob.nasFilePath}, content-length=${fileMeta.contentLength} (jobId=${jobId})`
        );

        // Sync hashes while streaming from NAS
        // Prefer fileSize from PROPFIND (NAS browser) over Content-Length from HEAD
        const totalBytes = uploadJob.fileSize ?? fileMeta.contentLength ?? 0;

        const result = await syncLinesFromNas(
          audienceId,
          uploadJob.nasFilePath,
          totalBytes,
          resume,
          uploadJob.tokenId ?? undefined,
          uploadJob.startOffsetBytes,
          accountKey,
          async (progress) => {
            // Cooperative cancel: stop streaming/uploading if the job was cancelled.
            if (await isJobCancelled(jobId)) {
              throw new JobCancelledError();
            }

            await patchAudienceUploadJob(jobId, {
              processedLines: progress.processedLines,
              processedBytes: progress.processedBytes,
              syncedHashCount: progress.syncedHashCount,
              syncedLines: progress.syncedLines,
              syncedByteOffset: progress.syncedByteOffset,
              totalBytes: totalBytes > 0 ? totalBytes : null,
              lastSessionId: progress.lastSessionId,
              updatedAt: new Date().toISOString(),
            });

            await bullJob.updateProgress({
              processedLines: progress.processedLines,
              processedBytes: progress.processedBytes,
              totalBytes: totalBytes > 0 ? totalBytes : undefined,
              syncedHashCount: progress.syncedHashCount,
            });
          }
        );

        // Final update
        await patchAudienceUploadJob(jobId, {
          processedLines: result.processedLines,
          processedBytes: result.processedBytes,
          syncedHashCount: result.syncedHashCount,
          syncedLines: result.syncedLines,
          syncedByteOffset: result.syncedByteOffset,
          totalLines: result.processedLines,
          totalBytes: totalBytes > 0 ? totalBytes : null,
          lastSessionId: result.lastSessionId,
          updatedAt: new Date().toISOString(),
        });

        uploadJob = await markAudienceUploadJobCompleted(jobId);

        return {
          jobId,
          audienceId: uploadJob.audienceId,
          syncedHashCount: uploadJob.syncedHashCount,
        };
      } catch (error) {
        // Cancelled mid-flight: keep the cancelled status, return normally so
        // BullMQ treats it as done (no retry, no failed status).
        if (error instanceof JobCancelledError) {
          await patchAudienceUploadJob(jobId, {
            status: "cancelled",
            updatedAt: new Date().toISOString(),
          });
          console.info(
            `[audience-upload-worker] job ${jobId} cancelled mid-flight, stopping.`
          );
          return { jobId, audienceId, cancelled: true };
        }

        // Retryable: transient connection drop or Meta rate limit → let BullMQ retry.
        if (isTransientFetchError(error) || isMetaRateLimitRetryError(error)) {
          throw error;
        }

        // Genuine, non-recoverable error (bad token, deleted audience, invalid
        // data...) → fail fast instead of looping all 168 attempts.
        throw new UnrecoverableError(
          error instanceof Error ? error.message : String(error)
        );
      }
      } finally {
        // Release the app so another job for the same app_id can run. A job
        // that threw for retry frees the app now and re-acquires on its retry.
        activeAccountKeys.delete(accountKey);
      }
    },
    {
      connection: getBullConnectionOptions(),
      concurrency: config.workerConcurrency,
      limiter: {
        max: config.workerRateLimitMax,
        duration: config.workerRateLimitDurationMs,
      },
      settings: {
        backoffStrategy: (attemptsMade, type, error) => {
          if (type !== "meta-aware") {
            return DEFAULT_RETRY_DELAY_MS;
          }
          return metaAwareRetryDelayMs(attemptsMade, error);
        },
      },
    }
  );

  worker.on("completed", (bullJob) => {
    console.info(
      `[audience-upload-worker] completed ${bullJob.id} for upload job ${bullJob.data.jobId}`
    );
  });

  worker.on("failed", async (bullJob, error) => {
    const jobId = bullJob?.data?.jobId;
    const bullJobId = bullJob?.id ?? "unknown";
    const attemptsMade = bullJob?.attemptsMade ?? 0;
    const maxAttempts = bullJob?.opts?.attempts ?? 1;

    console.error(
      `[audience-upload-worker] failed ${bullJobId} (jobId=${jobId}, attempts=${attemptsMade}/${maxAttempts}): ${describeFetchError(error)}`,
      error.stack ? `\n${error.stack}` : ""
    );

    if (jobId) {
      if (bullJob && shouldRetryLater(bullJob, error)) {
        const retryMessage = buildRetryMessage(error);
        const nextRetryAt = new Date(
          Date.now() + metaAwareRetryDelayMs(attemptsMade, error)
        ).toISOString();
        console.info(
          `[audience-upload-worker] retrying ${bullJobId} later (attempt ${attemptsMade}/${maxAttempts}, at ${nextRetryAt}): ${retryMessage}`
        );
        await patchAudienceUploadJob(jobId, {
          status: "queued",
          errorMessage: retryMessage,
          nextRetryAt,
          updatedAt: new Date().toISOString(),
        });
      } else {
        console.error(
          `[audience-upload-worker] permanently failing ${bullJobId} (attempt ${attemptsMade}/${maxAttempts} exhausted): ${error.message}`
        );
        await markAudienceUploadJobFailed(jobId, error.message);
      }
    }
  });

  const shutdown = async (signal: string) => {
    console.info(`[audience-upload-worker] shutting down on ${signal}`);
    await worker.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  console.info(
    `[audience-upload-worker] listening queue=${config.queueName} concurrency=${config.workerConcurrency}`
  );
}

interface SyncProgress {
  processedLines: number;
  processedBytes: number;
  syncedHashCount: number;
  syncedLines: number;
  syncedByteOffset: number;
  lastSessionId: string | null;
}

async function syncLinesFromNas(
  audienceId: string,
  nasFilePath: string,
  totalBytes: number,
  resume: { syncedLines: number; syncedHashCount: number; syncedByteOffset: number },
  tokenId: string | undefined,
  startOffsetBytes: number,
  accountKey: string,
  onProgress: (progress: SyncProgress) => Promise<void>
) {
  // metaBatchSize is configurable via UPLOAD_META_BATCH_SIZE (Meta documents 10,000/call).
  const { metaBatchSize, metaRequestIntervalMs, proactivePauseBytes } =
    getAudienceUploadConfig();

  // Lines already uploaded in a previous attempt: re-read but don't re-send.
  const resumeFromLine = resume.syncedLines;
  // Bytes already confirmed-uploaded at the start of THIS run — the proactive
  // pause measures new bytes uploaded since here.
  const runBaseOffset = resume.syncedByteOffset;

  let processedLines = 0;
  let processedBytes = 0;
  let syncedHashCount = resume.syncedHashCount;
  let syncedLines = resume.syncedLines;
  // Absolute byte boundary confirmed-uploaded so far (conservative).
  let syncedByteOffset = resume.syncedByteOffset;
  let lastSessionId: string | null = null;

  // Accumulate hashes across stream yields until we reach batch size
  const accumulator: string[] = [];
  // One entry per chunk: the absolute byte boundary becomes "synced" only once
  // every line up to `linesThreshold` has actually been uploaded. Keeps
  // syncedByteOffset conservative — never ahead of what Meta received.
  const offsetCheckpoints: Array<{ linesThreshold: number; offset: number }> = [];

  const advanceSyncedByteOffset = () => {
    while (
      offsetCheckpoints.length > 0 &&
      offsetCheckpoints[0].linesThreshold <= syncedLines
    ) {
      syncedByteOffset = offsetCheckpoints.shift()!.offset;
    }
  };

  for await (const { hashes, bytesRead, endOffset } of streamNasFileLines(
    nasFilePath,
    {
      knownSize: totalBytes > 0 ? totalBytes : null,
      startByte: startOffsetBytes > 0 ? startOffsetBytes : 0,
    }
  )) {
    processedBytes += bytesRead;

    for (const hash of hashes) {
      processedLines += 1;
      // Skip hashes confirmed-synced in a prior run — Meta already has them.
      if (processedLines <= resumeFromLine) {
        continue;
      }
      accumulator.push(hash);
    }

    // This chunk's byte boundary is safe once `processedLines` are all uploaded.
    offsetCheckpoints.push({ linesThreshold: processedLines, offset: endOffset });
    advanceSyncedByteOffset();

    // Flush accumulator in batches
    while (accumulator.length >= metaBatchSize) {
      const batch = accumulator.splice(0, metaBatchSize);

      await acquireMetaRequestSlot(metaRequestIntervalMs, accountKey);

      const result = await retryMetaAware(() =>
        uploadHashedUsers(audienceId, batch, { tokenId })
      );
      syncedHashCount += result.num_received ?? batch.length;
      syncedLines += batch.length;
      lastSessionId = result.session_id ?? lastSessionId;
      advanceSyncedByteOffset();

      await onProgress({
        processedLines,
        processedBytes,
        syncedHashCount,
        syncedLines,
        syncedByteOffset,
        lastSessionId,
      });

      // Proactive self-pacing: after ~N bytes uploaded in this run, pause (1h)
      // and resume from the saved offset. Progress was just persisted above, so
      // the retry continues cleanly. Reuses the rate-limit wait+resume path.
      if (
        proactivePauseBytes > 0 &&
        syncedByteOffset - runBaseOffset >= proactivePauseBytes
      ) {
        const uploadedGb = (
          (syncedByteOffset - runBaseOffset) /
          (1024 * 1024 * 1024)
        ).toFixed(2);
        throw new MetaRateLimitRetryError(
          `Da up ${uploadedGb} GB trong phien nay — chu dong nghi roi up tiep.`
        );
      }
    }
  }

  // Flush remaining accumulator
  if (accumulator.length > 0) {
    await acquireMetaRequestSlot(metaRequestIntervalMs, accountKey);

    const result = await retryMetaAware(() =>
      uploadHashedUsers(audienceId, accumulator, { tokenId })
    );
    syncedHashCount += result.num_received ?? accumulator.length;
    syncedLines += accumulator.length;
    lastSessionId = result.session_id ?? lastSessionId;
  }

  // Everything read has now been uploaded → drain remaining checkpoints so the
  // offset reflects the end of the consumed data.
  advanceSyncedByteOffset();

  await onProgress({
    processedLines,
    processedBytes,
    syncedHashCount,
    syncedLines,
    syncedByteOffset,
    lastSessionId,
  });

  return {
    processedLines,
    processedBytes,
    syncedHashCount,
    syncedLines,
    syncedByteOffset,
    lastSessionId,
  };
}

async function retryMetaAware<T>(callback: () => Promise<T>) {
  try {
    return await callback();
  } catch (error) {
    if (isFacebookRateLimitError(error)) {
      throw new MetaRateLimitRetryError(
        "Facebook gioi han toc do. Worker se cho roi up tiep tu cho dang do."
      );
    }

    // Per policy: Meta #2650 "service error" → wait, then resume the upload.
    if (isMetaServiceError(error)) {
      throw new MetaRateLimitRetryError(
        "Meta tra ve loi #2650 (service error). Worker se cho roi up tiep tu cho dang do."
      );
    }

    throw error;
  }
}

// Global rate gate shared across workers: a self-expiring Redis key enforces a
// minimum `intervalMs` between Meta requests. The key auto-expires after
// `intervalMs`, so the next acquirer either grabs it (NX) or sleeps for exactly
// the remaining TTL before retrying.
async function acquireMetaRequestSlot(intervalMs: number, accountKey: string) {
  const redis = getRedis();
  const throttleKey = `${META_REQUEST_THROTTLE_PREFIX}:${accountKey}`;

  while (true) {
    const acquired = await redis.set(throttleKey, "1", "PX", intervalMs, "NX");

    if (acquired === "OK") {
      return;
    }

    const remainingTtlMs = await redis.pttl(throttleKey);
    await waitFor(remainingTtlMs > 0 ? remainingTtlMs : 100);
  }
}

class MetaRateLimitRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaRateLimitRetryError";
  }
}

// Thrown to unwind the stream loop when a job is cancelled while processing.
class JobCancelledError extends Error {
  constructor() {
    super("Job đã bị huỷ bởi người dùng.");
    this.name = "JobCancelledError";
  }
}

async function isJobCancelled(jobId: string) {
  const job = await getAudienceUploadJob(jobId);
  return job.status === "cancelled";
}

function isMetaRateLimitRetryError(error: unknown) {
  return error instanceof Error && error.name === "MetaRateLimitRetryError";
}

// Delay (ms) before BullMQ retries a meta-aware job: full rate-limit cooldown
// for #2650 / rate limits / proactive pauses, else exponential backoff capped at
// the cooldown. Shared by the backoff strategy and the UI retry countdown.
function metaAwareRetryDelayMs(attemptsMade: number, error: unknown): number {
  const { metaRateLimitDelayMs } = getAudienceUploadConfig();
  if (isMetaRateLimitRetryError(error)) {
    return metaRateLimitDelayMs;
  }
  return Math.min(
    DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(attemptsMade - 1, 0),
    metaRateLimitDelayMs
  );
}

function shouldRetryLater(
  bullJob: { attemptsMade: number; opts: { attempts?: number } },
  error: Error
) {
  // Fail-fast errors are terminal — never re-queue them.
  if (error instanceof UnrecoverableError) {
    return false;
  }

  const maxAttempts = bullJob.opts.attempts ?? 1;
  // Re-queue both Meta rate limits and transient connection drops
  // (undici "terminated", ECONNRESET, socket timeout) instead of failing hard.
  const retryable =
    isMetaRateLimitRetryError(error) || isTransientFetchError(error);
  return retryable && bullJob.attemptsMade < maxAttempts;
}

function buildRetryMessage(error: Error) {
  if (isMetaRateLimitRetryError(error)) {
    const retryAt = new Date(
      Date.now() + getAudienceUploadConfig().metaRateLimitDelayMs
    ).toLocaleString("vi-VN");
    // error.message carries the specific reason (rate limit vs #2650).
    return `${error.message} Du kien thu lai luc ${retryAt}.`;
  }

  if (isTransientFetchError(error)) {
    return `Ket noi bi gian doan (${describeFetchError(error)}). Worker se thu lai.`;
  }

  return error.message;
}

function waitFor(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

void main().catch((error) => {
  console.error("[audience-upload-worker] fatal", error);
  process.exit(1);
});