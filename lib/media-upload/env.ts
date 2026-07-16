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
  // BullMQ limiter, set high in burst mode. Lower it to re-introduce a hard
  // pacing cap without code changes. Does NOT gate the 429 backoff — see the
  // measured limiter note in workers/media-upload-worker.ts.
  workerRateLimitMax: number;
  workerRateLimitDurationMs: number;
  // How long the worker sleeps after a 429 when Meta sends no
  // `estimated_time_to_regain_access` of its own to obey instead.
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
    // Only real failures (corrupt image, dropped connection) consume an
    // attempt — a 429 does not (see media-upload-worker.ts BURST MODE), so 10
    // is a budget for genuine errors, not for rate limiting.
    jobAttempts: readNumberEnv("UPLOAD_JOB_ATTEMPTS", 10),
    // Upper bound on jobs processed in parallel. Each job holds one whole
    // image in memory for the multipart POST, so this is an OOM bound as much
    // as a speed knob — raise it with that in mind.
    workerConcurrency: readNumberEnv("UPLOAD_WORKER_CONCURRENCY", 4),
    // 10k/sec ≈ no ceiling: burst mode lets Meta's 429 define the real limit
    // rather than guessing it here. The old default (1 per 1000ms) was a
    // hidden 3600/hr cap that outlived the throttle it was paired with.
    workerRateLimitMax: readNumberEnv("UPLOAD_WORKER_RATE_LIMIT_MAX", 10_000),
    workerRateLimitDurationMs: readNumberEnv(
      "UPLOAD_WORKER_RATE_LIMIT_DURATION_MS",
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
