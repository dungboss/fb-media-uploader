// Shared Redis key builders for the media-upload feature. Kept in one place
// so jobs.ts and batches.ts (which reference each other's keys but must not
// import each other, to avoid a cycle) stay in sync.
//
// audience-upload:fb-tokens is intentionally NOT here — token-store.ts owns
// that key directly and it must never change (see token-store.ts).

import type { MediaUploadJobStatus } from "./types";

const JOB_KEY_PREFIX = "media-upload:job:";
const BATCH_KEY_PREFIX = "media-upload:batch:";

export const RECENT_BATCHES_KEY = "media-upload:recent-batches";

export function getJobKey(jobId: string) {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

export function getBatchKey(batchId: string) {
  return `${BATCH_KEY_PREFIX}${batchId}`;
}

export function getBatchJobsListKey(batchId: string) {
  return `${getBatchKey(batchId)}:jobs`;
}

export function getBatchStatusSetKey(
  batchId: string,
  status: MediaUploadJobStatus
) {
  return `${getBatchKey(batchId)}:status:${status}`;
}
