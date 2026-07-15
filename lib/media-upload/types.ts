// Pure types for the media-upload feature. No node imports — a client
// component (NAS folder picker) imports from this module.

export type MediaUploadJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export const MEDIA_UPLOAD_JOB_STATUSES = [
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly MediaUploadJobStatus[];

export interface MediaUploadJob {
  id: string;
  batchId: string;
  status: MediaUploadJobStatus;
  nasFilePath: string;
  fileName: string;
  // From WebDAV PROPFIND — display + the 100MB OOM guard only, never the
  // basis for a client-side "too big for Meta" rejection (limit unknown).
  fileSize: number | null;
  imageHash: string | null; // Meta adimages result
  previewUrl: string | null; // Meta url_128
  errorMessage: string | null;
  // ISO timestamp the worker expects to retry at (Meta cooldown). Null when
  // not waiting. Lets the UI show a countdown to the next attempt.
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaUploadBatch {
  id: string;
  // Null when the batch was built from an explicit file list instead of a
  // NAS folder pick.
  nasFolderPath: string | null;
  total: number;
  // Ad account / token snapshotted once per batch (not per job) — at 5000
  // jobs that would be 5000 copies of the same 4 strings.
  adAccountId: string | null;
  adAccountName: string | null;
  appName: string | null;
  tokenId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaUploadBatchCounts {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface MediaUploadJobPayload {
  jobId: string;
}
