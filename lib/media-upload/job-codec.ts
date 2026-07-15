// Redis hash <-> MediaUploadJob (de)serialization. Split out of jobs.ts
// purely to keep that file focused and under the 200-line guideline.

import {
  MEDIA_UPLOAD_JOB_STATUSES,
  type MediaUploadJob,
  type MediaUploadJobStatus,
} from "./types";

export function toJobHashPatch(
  patch: Partial<Record<keyof MediaUploadJob, string | number | null>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [
      key,
      value === null || value === undefined ? "" : String(value),
    ])
  );
}

export function parseJobPayload(
  jobId: string,
  payload: Record<string, string>
): MediaUploadJob {
  return {
    id: jobId,
    batchId: payload.batchId ?? "",
    status: parseJobStatus(payload.status),
    nasFilePath: payload.nasFilePath ?? "",
    fileName: payload.fileName ?? "",
    fileSize: parseNullableInteger(payload.fileSize),
    imageHash: payload.imageHash || null,
    previewUrl: payload.previewUrl || null,
    errorMessage: payload.errorMessage || null,
    nextRetryAt: payload.nextRetryAt || null,
    createdAt: payload.createdAt ?? new Date(0).toISOString(),
    updatedAt: payload.updatedAt ?? new Date(0).toISOString(),
  };
}

export function parseJobStatus(value: string | undefined): MediaUploadJobStatus {
  if (value && (MEDIA_UPLOAD_JOB_STATUSES as readonly string[]).includes(value)) {
    return value as MediaUploadJobStatus;
  }

  return "queued";
}

function parseNullableInteger(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
