import { FacebookApiError } from "./facebook-error";

const DEFAULT_QUEUE_NAME = "media-upload";

export interface MediaUploadConfig {
  redisUrl: string;
  queueName: string;
  // 7 days (was 24h). Measured reason: a dev-tier drain of 5000 images takes
  // ~21h and queued jobs are never patched while waiting, so a 24h TTL
  // expires still-queued jobs mid-drain and they vanish silently.
  jobTtlSeconds: number;
  jobAttempts: number;
  workerConcurrency: number;
  workerRateLimitMax: number;
  workerRateLimitDurationMs: number;
  // Floor between Meta requests per ad account; phase 03 adapts upward from
  // the observed tier/usage headers — this is only the minimum spacing.
  metaRequestIntervalMs: number;
  // Fallback wait used only when Meta sends no usage header to derive a
  // wait from.
  metaRateLimitDelayMs: number;
  // OOM guard only — NOT Meta's documented image size limit (unknown; never
  // client-validated against a guess). Rejects a file before it is read
  // fully into memory for the multipart upload.
  maxFileBytes: number;
  // Sanity bound on jobs created from one batch request.
  maxBatchFiles: number;
  webdavUsername?: string;
  webdavPassword?: string;
}

let cachedConfig: MediaUploadConfig | null = null;

export function getMediaUploadConfig(): MediaUploadConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const redisUrl = readRequiredEnv("REDIS_URL");

  cachedConfig = {
    redisUrl,
    queueName: readOptionalEnv("UPLOAD_JOB_QUEUE_NAME") ?? DEFAULT_QUEUE_NAME,
    jobTtlSeconds: readNumberEnv("UPLOAD_JOB_TTL_SECONDS", 7 * 24 * 60 * 60),
    // Adaptive waits (phase 03) mean fewer, better-timed attempts than the
    // old fixed-interval hash-batch model needed.
    jobAttempts: readNumberEnv("UPLOAD_JOB_ATTEMPTS", 10),
    // Upper bound on jobs processed in parallel. The worker paces requests
    // per ad account (act_id) via the Redis throttle, not via this knob.
    workerConcurrency: readNumberEnv("UPLOAD_WORKER_CONCURRENCY", 4),
    workerRateLimitMax: readNumberEnv("UPLOAD_WORKER_RATE_LIMIT_MAX", 1),
    workerRateLimitDurationMs: readNumberEnv(
      "UPLOAD_WORKER_RATE_LIMIT_DURATION_MS",
      1_000
    ),
    metaRequestIntervalMs: readNumberEnv(
      "UPLOAD_META_REQUEST_INTERVAL_MS",
      1_000
    ),
    metaRateLimitDelayMs: readNumberEnv(
      "UPLOAD_META_RATE_LIMIT_DELAY_MS",
      5 * 60 * 1_000
    ),
    maxFileBytes: readNumberEnv("UPLOAD_MAX_FILE_BYTES", 100 * 1024 * 1024),
    maxBatchFiles: readNumberEnv("UPLOAD_MAX_BATCH_FILES", 10_000),
    webdavUsername: readOptionalEnv("WEBDAV_USERNAME"),
    webdavPassword: readOptionalEnv("WEBDAV_PASSWORD"),
  };

  return cachedConfig;
}

function readRequiredEnv(variableName: string) {
  const value = process.env[variableName]?.trim();

  if (!value) {
    throw new FacebookApiError(
      `Thiếu biến môi trường ${variableName} cho luồng upload production.`,
      500
    );
  }

  return value;
}

function readOptionalEnv(variableName: string) {
  const value = process.env[variableName]?.trim();
  return value || undefined;
}

function readNumberEnv(variableName: string, fallback: number) {
  const rawValue = readOptionalEnv(variableName);

  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new FacebookApiError(
      `Biến môi trường ${variableName} phải là số nguyên dương.`,
      500
    );
  }

  return parsedValue;
}
