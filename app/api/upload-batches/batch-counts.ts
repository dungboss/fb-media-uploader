// Bulk O(1) batch counts: pipelines every status SET's SCARD for every
// requested batch into ONE Redis round trip. `getBatchCounts` in
// lib/media-upload/batches.ts already pipelines the 5 SCARD for a single
// batch; this does the same across N batches so the 2s poll
// (GET /api/upload-batches, ~50 batches) pays one round trip instead of N.

import { getBatchStatusSetKey } from "@/lib/media-upload/batches";
import { getRedis } from "@/lib/media-upload/redis";
import {
  MEDIA_UPLOAD_JOB_STATUSES,
  type MediaUploadBatchCounts,
} from "@/lib/media-upload/types";

export async function getCountsForBatches(
  batchIds: string[]
): Promise<Record<string, MediaUploadBatchCounts>> {
  const result: Record<string, MediaUploadBatchCounts> = {};

  if (batchIds.length === 0) {
    return result;
  }

  const pipeline = getRedis().pipeline();
  for (const batchId of batchIds) {
    for (const status of MEDIA_UPLOAD_JOB_STATUSES) {
      pipeline.scard(getBatchStatusSetKey(batchId, status));
    }
  }

  const results = (await pipeline.exec()) as [Error | null, number][];

  let cursor = 0;
  for (const batchId of batchIds) {
    const counts = {} as MediaUploadBatchCounts;
    for (const status of MEDIA_UPLOAD_JOB_STATUSES) {
      const [error, count] = results[cursor] ?? [null, 0];
      counts[status] = error ? 0 : count;
      cursor += 1;
    }
    result[batchId] = counts;
  }

  return result;
}
