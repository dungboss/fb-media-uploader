// Batch + job creation: validates and filters the incoming file list, then
// writes the batch + every job in ONE Redis pipeline round trip. Split out
// of jobs.ts (which owns status transitions + CRUD) purely to keep both
// files under the 200-line guideline.

import { randomUUID } from "node:crypto";

import { toBatchHashPatch } from "./batch-codec";
import { createBatch, pushRecentBatch } from "./batches";
import { getMediaUploadConfig } from "./env";
import { FacebookApiError } from "./facebook-error";
import { toJobHashPatch } from "./job-codec";
import { resolveMediaType } from "./media-type";
import {
  getBatchJobsListKey,
  getBatchKey,
  getBatchStatusSetKey,
  getJobKey,
} from "./redis-keys";
import { getRedis } from "./redis";
import type { MediaUploadBatch, MediaUploadJob } from "./types";

export interface CreateMediaUploadJobsInput {
  files: Array<{ nasFilePath: string; fileSize?: number | null }>;
  nasFolderPath: string | null;
  adAccountId?: string;
  adAccountName?: string;
  appName?: string;
  tokenId?: string;
}

export interface CreateMediaUploadJobsResult {
  batch: MediaUploadBatch;
  jobs: MediaUploadJob[];
  skipped: Array<{ nasFilePath: string; reason: string }>;
}

// Creates a batch + N jobs in ONE Redis pipeline round trip — the only way
// this stays fast at 5000 files. Per-file rejects (bad path, non-image,
// over the OOM-guard size) are collected as `skipped` and never throw; only
// empty input, an over-cap batch, or an all-rejected batch throw.
export async function createMediaUploadJobs(
  input: CreateMediaUploadJobsInput
): Promise<CreateMediaUploadJobsResult> {
  const { maxBatchFiles, maxFileBytes, jobTtlSeconds } = getMediaUploadConfig();

  if (input.files.length === 0) {
    throw new FacebookApiError("Không có file nào để tạo batch.", 400);
  }
  if (input.files.length > maxBatchFiles) {
    throw new FacebookApiError(
      `Batch vượt quá giới hạn ${maxBatchFiles} file.`,
      400
    );
  }

  const { accepted, skipped } = filterUploadableFiles(input.files, maxFileBytes);

  if (accepted.length === 0) {
    throw new FacebookApiError("Không có file ảnh hợp lệ nào trong batch.", 400);
  }

  const now = new Date().toISOString();
  const batchId = randomUUID();
  const batch = createBatch({
    id: batchId,
    nasFolderPath: input.nasFolderPath,
    total: accepted.length,
    adAccountId: input.adAccountId?.trim() || null,
    adAccountName: input.adAccountName?.trim() || null,
    appName: input.appName?.trim() || null,
    tokenId: input.tokenId?.trim() || null,
  });

  const jobs: MediaUploadJob[] = accepted.map(({ nasFilePath, fileSize }) => ({
    id: randomUUID(),
    batchId,
    status: "queued",
    nasFilePath,
    fileName: nasFilePath.split("/").filter(Boolean).pop() ?? nasFilePath,
    fileSize,
    imageHash: null,
    previewUrl: null,
    errorMessage: null,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  const pipeline = getRedis().pipeline();
  pipeline.hset(getBatchKey(batchId), toBatchHashPatch(batch));
  pipeline.expire(getBatchKey(batchId), jobTtlSeconds);

  const queuedSetKey = getBatchStatusSetKey(batchId, "queued");
  const jobsListKey = getBatchJobsListKey(batchId);

  for (const job of jobs) {
    pipeline.hset(getJobKey(job.id), toJobHashPatch(job));
    pipeline.expire(getJobKey(job.id), jobTtlSeconds);
    pipeline.rpush(jobsListKey, job.id);
    pipeline.sadd(queuedSetKey, job.id);
  }
  pipeline.expire(jobsListKey, jobTtlSeconds);
  pipeline.expire(queuedSetKey, jobTtlSeconds);

  await pipeline.exec();
  await pushRecentBatch(batchId);

  return { batch, jobs, skipped };
}

function filterUploadableFiles(
  files: Array<{ nasFilePath: string; fileSize?: number | null }>,
  maxFileBytes: number
) {
  const accepted: Array<{ nasFilePath: string; fileSize: number | null }> = [];
  const skipped: Array<{ nasFilePath: string; reason: string }> = [];

  for (const file of files) {
    const nasFilePath = file.nasFilePath?.trim() ?? "";
    const fileName = nasFilePath.split("/").filter(Boolean).pop() ?? nasFilePath;

    if (!nasFilePath) {
      skipped.push({ nasFilePath, reason: "Đường dẫn không hợp lệ." });
      continue;
    }
    if (resolveMediaType({ name: fileName }) === null) {
      skipped.push({
        nasFilePath,
        reason: "Không phải định dạng ảnh được hỗ trợ (.jpg .jpeg .png .gif).",
      });
      continue;
    }

    const fileSize =
      typeof file.fileSize === "number" && file.fileSize > 0 ? file.fileSize : null;
    // OOM guard only — NOT Meta's (unknown) documented image size limit.
    if (fileSize !== null && fileSize > maxFileBytes) {
      skipped.push({ nasFilePath, reason: "File vượt quá giới hạn kích thước cho phép." });
      continue;
    }

    accepted.push({ nasFilePath, fileSize });
  }

  return { accepted, skipped };
}
