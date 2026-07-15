import { Queue } from "bullmq";

import { getMediaUploadConfig } from "./env";
import { getBullConnectionOptions } from "./redis";
import type { MediaUploadJobPayload } from "./types";

export const MEDIA_UPLOAD_QUEUE_JOB_NAME = "upload-ad-image";

declare global {
  var __mediaUploadQueue__: Queue<MediaUploadJobPayload, unknown, string> | undefined;
}

export function getMediaUploadQueue() {
  if (!globalThis.__mediaUploadQueue__) {
    const { jobAttempts, metaRateLimitDelayMs, queueName } = getMediaUploadConfig();

    globalThis.__mediaUploadQueue__ = new Queue(queueName, {
      connection: getBullConnectionOptions(),
      defaultJobOptions: {
        attempts: jobAttempts,
        backoff: {
          type: "meta-aware",
          delay: metaRateLimitDelayMs,
        },
        removeOnComplete: 250,
        removeOnFail: 250,
      },
    });
  }

  return globalThis.__mediaUploadQueue__;
}

// Single-job enqueue — used by the one-off "retry this job" route. Early
// returns an existing BullMQ entry with the same id (dedupe by jobId), so
// callers that want a genuine re-run must remove the stale entry first.
export async function enqueueMediaUploadJob(jobId: string) {
  const queue = getMediaUploadQueue();
  const existingJob = await queue.getJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return queue.add(MEDIA_UPLOAD_QUEUE_JOB_NAME, { jobId }, { jobId });
}

// Bulk enqueue for batch creation — one pipelined round trip via BullMQ's
// addBulk instead of N individual `add` calls, which would not fit a
// 5000-image batch inside the route's request budget.
export async function enqueueMediaUploadJobs(jobIds: string[]) {
  if (jobIds.length === 0) {
    return [];
  }

  const queue = getMediaUploadQueue();

  return queue.addBulk(
    jobIds.map((jobId) => ({
      name: MEDIA_UPLOAD_QUEUE_JOB_NAME,
      data: { jobId },
      opts: { jobId },
    }))
  );
}

// Drop a job from the queue so a cancelled/retried job is never (re)processed
// under a stale entry. A waiting/delayed job is removed outright; an active
// (locked) job can't be removed by BullMQ — the worker stops it
// cooperatively via the Redis status.
export async function removeMediaUploadJob(jobId: string) {
  const queue = getMediaUploadQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return false;
  }

  try {
    await job.remove();
    return true;
  } catch {
    // Job is active/locked — leave it; worker will abort on next cancel check.
    return false;
  }
}
