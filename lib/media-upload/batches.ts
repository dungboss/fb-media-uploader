// Batch aggregate CRUD. A batch is the UX-facing unit ("this folder → that
// account"); jobs are the execution unit (one per image). Counts are O(1)
// via per-status Redis SETs (SCARD) — never scan job hashes to count them.

import { parseBatchPayload, toBatchHashPatch } from "./batch-codec";
import { getMediaUploadConfig } from "./env";
import {
  getBatchJobsListKey,
  getBatchKey,
  getBatchStatusSetKey,
  getJobKey,
  RECENT_BATCHES_KEY,
} from "./redis-keys";
import { getRedis } from "./redis";
import {
  MEDIA_UPLOAD_JOB_STATUSES,
  type MediaUploadBatch,
  type MediaUploadBatchCounts,
  type MediaUploadJobStatus,
} from "./types";

export { toBatchHashPatch };

const MAX_RECENT_BATCHES = 50;

export { getBatchJobsListKey, getBatchKey, getBatchStatusSetKey };

// Builds the batch object; does not write to Redis. The caller (jobs.ts,
// createMediaUploadJobs) queues `toBatchHashPatch(batch)` on its own
// pipeline alongside the job writes, so the batch + all its jobs land in
// ONE round trip instead of two.
export function createBatch(input: {
  id: string;
  nasFolderPath: string | null;
  total: number;
  adAccountId: string | null;
  adAccountName: string | null;
  appName: string | null;
  tokenId: string | null;
}): MediaUploadBatch {
  const now = new Date().toISOString();

  return {
    id: input.id,
    nasFolderPath: input.nasFolderPath,
    total: input.total,
    adAccountId: input.adAccountId,
    adAccountName: input.adAccountName,
    appName: input.appName,
    tokenId: input.tokenId,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getBatch(batchId: string): Promise<MediaUploadBatch | null> {
  const payload = await getRedis().hgetall(getBatchKey(batchId));

  if (Object.keys(payload).length === 0) {
    return null;
  }

  return parseBatchPayload(batchId, payload);
}

// 5 × SCARD — O(1) regardless of batch size (5000 jobs counts as fast as 5).
export async function getBatchCounts(
  batchId: string
): Promise<MediaUploadBatchCounts> {
  const pipeline = getRedis().pipeline();

  for (const status of MEDIA_UPLOAD_JOB_STATUSES) {
    pipeline.scard(getBatchStatusSetKey(batchId, status));
  }

  const results = (await pipeline.exec()) as [Error | null, number][];

  const counts = {} as MediaUploadBatchCounts;
  MEDIA_UPLOAD_JOB_STATUSES.forEach((status, index) => {
    const [error, count] = results[index] ?? [null, 0];
    counts[status] = error ? 0 : count;
  });

  return counts;
}

export async function listRecentBatches(limit = MAX_RECENT_BATCHES) {
  const batchIds = await getRedis().lrange(RECENT_BATCHES_KEY, 0, limit - 1);

  if (batchIds.length === 0) {
    return [];
  }

  const pipeline = getRedis().pipeline();
  for (const id of batchIds) {
    pipeline.hgetall(getBatchKey(id));
  }

  const results = (await pipeline.exec()) as [Error | null, Record<string, string>][];

  return results
    .map(([error, payload], index) => {
      if (error || !payload || Object.keys(payload).length === 0) {
        return null;
      }
      return parseBatchPayload(batchIds[index], payload);
    })
    .filter((batch): batch is MediaUploadBatch => batch !== null);
}

export async function pushRecentBatch(batchId: string) {
  await getRedis().lpush(RECENT_BATCHES_KEY, batchId);
  await getRedis().ltrim(RECENT_BATCHES_KEY, 0, MAX_RECENT_BATCHES - 1);
}

// Paged job ids for a batch: SSCAN when filtering by status (unordered but
// O(cursor)), LRANGE when not (preserves creation order). `cursor` is a
// plain string forwarded from/to the underlying Redis scan/list cursor.
export async function listBatchJobIds(input: {
  batchId: string;
  status?: MediaUploadJobStatus;
  cursor?: string;
  limit?: number;
}): Promise<{ jobIds: string[]; nextCursor: string | null }> {
  const limit = input.limit && input.limit > 0 ? input.limit : 50;

  if (input.status) {
    const cursor = input.cursor ?? "0";
    const [nextCursor, jobIds] = await getRedis().sscan(
      getBatchStatusSetKey(input.batchId, input.status),
      cursor,
      "COUNT",
      limit
    );

    return { jobIds, nextCursor: nextCursor === "0" ? null : nextCursor };
  }

  const start = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const end = start + limit - 1;
  const jobIds = await getRedis().lrange(getBatchJobsListKey(input.batchId), start, end);
  const nextCursor = jobIds.length === limit ? String(end + 1) : null;

  return { jobIds, nextCursor };
}

// Purges a batch entirely: every job hash it owns, the job-id list, all 5
// status sets, the batch hash itself, and its entry in the recent-batches
// list. Reads the job-id list first (outside the pipeline — needed to know
// which hashes to delete), then deletes everything in one pipeline.
export async function deleteBatch(batchId: string) {
  const jobIds = await getRedis().lrange(getBatchJobsListKey(batchId), 0, -1);

  const pipeline = getRedis().pipeline();

  for (const jobId of jobIds) {
    pipeline.del(getJobKey(jobId));
  }
  pipeline.del(getBatchKey(batchId));
  pipeline.del(getBatchJobsListKey(batchId));
  for (const status of MEDIA_UPLOAD_JOB_STATUSES) {
    pipeline.del(getBatchStatusSetKey(batchId, status));
  }
  pipeline.lrem(RECENT_BATCHES_KEY, 0, batchId);

  await pipeline.exec();
}

// Refreshes TTL on every key belonging to a batch. Called after job status
// pipelines so a long-running (~21h) drain never has its batch metadata
// expire out from under still-active jobs.
export async function refreshBatchExpiry(batchId: string) {
  const { jobTtlSeconds } = getMediaUploadConfig();
  const pipeline = getRedis().pipeline();

  pipeline.expire(getBatchKey(batchId), jobTtlSeconds);
  pipeline.expire(getBatchJobsListKey(batchId), jobTtlSeconds);
  for (const status of MEDIA_UPLOAD_JOB_STATUSES) {
    pipeline.expire(getBatchStatusSetKey(batchId, status), jobTtlSeconds);
  }

  await pipeline.exec();
}

