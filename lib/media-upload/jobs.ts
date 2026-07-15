import { getMediaUploadConfig } from "./env";
import { FacebookApiError } from "./facebook-error";
import { parseJobPayload, parseJobStatus, toJobHashPatch } from "./job-codec";
import {
  getBatchJobsListKey,
  getBatchStatusSetKey,
  getJobKey,
} from "./redis-keys";
import { getRedis } from "./redis";
import type { MediaUploadJob, MediaUploadJobStatus } from "./types";

// Batch + job creation (validation, filtering, the one-pipeline write) lives
// in job-intake.ts; re-exported here so callers only need `./jobs`.
export {
  createMediaUploadJobs,
  type CreateMediaUploadJobsInput,
  type CreateMediaUploadJobsResult,
} from "./job-intake";

// The ONLY writer of job status. Every status change — worker, API, cancel,
// retry — must go through here so a job is always in exactly one
// batch:<id>:status:<s> set (SREM prev + SADD next; both idempotent, so a
// retried transition is a safe no-op, never a double-count).
export async function transitionJobStatus(
  jobId: string,
  next: MediaUploadJobStatus,
  patch?: Partial<
    Pick<MediaUploadJob, "imageHash" | "previewUrl" | "errorMessage" | "nextRetryAt">
  >
): Promise<MediaUploadJob> {
  const redis = getRedis();
  const existing = await redis.hgetall(getJobKey(jobId));

  if (Object.keys(existing).length === 0) {
    throw new FacebookApiError("Không tìm thấy upload job.", 404);
  }

  const batchId = existing.batchId ?? "";
  const prevStatus = parseJobStatus(existing.status);
  const { jobTtlSeconds } = getMediaUploadConfig();
  const updatedAt = new Date().toISOString();

  const pipeline = redis.pipeline();
  pipeline.hset(getJobKey(jobId), toJobHashPatch({ status: next, updatedAt, ...patch }));
  pipeline.expire(getJobKey(jobId), jobTtlSeconds);

  if (batchId) {
    pipeline.srem(getBatchStatusSetKey(batchId, prevStatus), jobId);
    pipeline.sadd(getBatchStatusSetKey(batchId, next), jobId);
    pipeline.expire(getBatchStatusSetKey(batchId, next), jobTtlSeconds);
  }

  await pipeline.exec();

  return getMediaUploadJob(jobId);
}

export function markMediaUploadJobCompleted(
  jobId: string,
  patch: Pick<MediaUploadJob, "imageHash" | "previewUrl">
) {
  return transitionJobStatus(jobId, "completed", patch);
}

export function markMediaUploadJobFailed(jobId: string, errorMessage: string) {
  return transitionJobStatus(jobId, "failed", { errorMessage });
}

export async function getMediaUploadJob(jobId: string): Promise<MediaUploadJob> {
  const normalizedJobId = jobId.trim();

  if (!normalizedJobId) {
    throw new FacebookApiError("Job ID không hợp lệ.", 400);
  }

  const payload = await getRedis().hgetall(getJobKey(normalizedJobId));

  if (Object.keys(payload).length === 0) {
    throw new FacebookApiError("Không tìm thấy upload job.", 404);
  }

  return parseJobPayload(normalizedJobId, payload);
}

// Pipelined hgetall — hydrates a page of job rows for the UI without N
// sequential round trips.
export async function getMediaUploadJobs(jobIds: string[]): Promise<MediaUploadJob[]> {
  if (jobIds.length === 0) {
    return [];
  }

  const pipeline = getRedis().pipeline();
  for (const id of jobIds) {
    pipeline.hgetall(getJobKey(id));
  }

  const results = (await pipeline.exec()) as [Error | null, Record<string, string>][];

  return results
    .map(([error, payload], index) => {
      if (error || !payload || Object.keys(payload).length === 0) {
        return null;
      }
      return parseJobPayload(jobIds[index], payload);
    })
    .filter((job): job is MediaUploadJob => job !== null);
}

export async function cancelMediaUploadJob(jobId: string): Promise<MediaUploadJob> {
  const existing = await getMediaUploadJob(jobId);

  if (existing.status !== "queued" && existing.status !== "processing") {
    // Already terminal — return as-is, silently.
    return existing;
  }

  return transitionJobStatus(jobId, "cancelled");
}

// Removes a job entirely: drop it from its batch's job list + status set,
// delete its hash. Used for "Xoá" on a terminal job.
export async function deleteMediaUploadJob(jobId: string) {
  const normalizedJobId = jobId.trim();

  if (!normalizedJobId) {
    throw new FacebookApiError("Job ID không hợp lệ.", 400);
  }

  const redis = getRedis();
  const existing = await redis.hgetall(getJobKey(normalizedJobId));

  if (Object.keys(existing).length > 0) {
    const batchId = existing.batchId;
    const status = parseJobStatus(existing.status);

    const pipeline = redis.pipeline();
    pipeline.del(getJobKey(normalizedJobId));
    if (batchId) {
      pipeline.srem(getBatchStatusSetKey(batchId, status), normalizedJobId);
      pipeline.lrem(getBatchJobsListKey(batchId), 0, normalizedJobId);
    }
    await pipeline.exec();
  }

  return { id: normalizedJobId, deleted: true };
}
