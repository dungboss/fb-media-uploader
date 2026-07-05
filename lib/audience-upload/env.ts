import { FacebookApiError } from "@/app/api/audiences/meta";

const DEFAULT_QUEUE_NAME = "audience-upload-sync";
const DEFAULT_SHARD_TEMP_DIR = "/temp/fb-audience-uploader";

// Hashes sent per Meta request. Meta documents a 10,000-per-call limit, but the
// effective batch is configurable via env (UPLOAD_META_BATCH_SIZE) so it can be
// tuned without a code change — raise to test a higher limit, lower if rejected.
const DEFAULT_META_BATCH_SIZE = 10_000;
// Throughput ceiling in hashes/second used to derive request spacing.
const DEFAULT_META_MAX_HASHES_PER_SECOND = 10_000;

export interface AudienceUploadConfig {
  redisUrl: string;
  queueName: string;
  shardTempDir: string;
  jobTtlSeconds: number;
  presignedUrlTtlSeconds: number;
  jobAttempts: number;
  workerConcurrency: number;
  workerRateLimitMax: number;
  workerRateLimitDurationMs: number;
  metaRequestIntervalMs: number;
  metaRateLimitDelayMs: number;
  metaBatchSize: number;
  metaMaxHashesPerSecond: number;
  // Proactively pause (for metaRateLimitDelayMs) after this many bytes uploaded
  // in one run, to self-pace under Meta limits. 0 disables.
  proactivePauseBytes: number;
  webdavUsername?: string;
  webdavPassword?: string;
}

let cachedConfig: AudienceUploadConfig | null = null;

export function getAudienceUploadConfig(): AudienceUploadConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const redisUrl = readRequiredEnv("REDIS_URL");

  // Hashes sent per Meta request; tune freely via env (Meta documents 10,000/call).
  const metaBatchSize = readNumberEnv(
    "UPLOAD_META_BATCH_SIZE",
    DEFAULT_META_BATCH_SIZE
  );
  // Throughput ceiling: never push more than this many hashes/second to Meta.
  const metaMaxHashesPerSecond = readNumberEnv(
    "UPLOAD_META_MAX_PER_SEC",
    DEFAULT_META_MAX_HASHES_PER_SECOND
  );
  // Spacing between requests is derived from the rate ceiling: one batch of
  // `metaBatchSize` every `interval` ms must not exceed `metaMaxHashesPerSecond`.
  // Legacy UPLOAD_META_REQUEST_INTERVAL_MS still overrides when set explicitly.
  const derivedRequestIntervalMs = Math.max(
    1,
    Math.round((metaBatchSize / metaMaxHashesPerSecond) * 1_000)
  );
  const metaRequestIntervalMs = readNumberEnv(
    "UPLOAD_META_REQUEST_INTERVAL_MS",
    derivedRequestIntervalMs
  );

  // Proactive pause threshold in bytes. Default 1 GB; "0" disables it.
  const proactivePauseRaw = readOptionalEnv("UPLOAD_META_PROACTIVE_PAUSE_BYTES");
  const proactivePauseBytes = proactivePauseRaw
    ? Math.max(0, Number.parseInt(proactivePauseRaw, 10) || 0)
    : 1024 * 1024 * 1024;

  cachedConfig = {
    redisUrl,
    queueName: readOptionalEnv("UPLOAD_JOB_QUEUE_NAME") ?? DEFAULT_QUEUE_NAME,
    shardTempDir:
      readOptionalEnv("UPLOAD_JOB_NAS_TEMP_DIR") ?? DEFAULT_SHARD_TEMP_DIR,
    jobTtlSeconds: readNumberEnv("UPLOAD_JOB_TTL_SECONDS", 24 * 60 * 60),
    presignedUrlTtlSeconds: readNumberEnv("UPLOAD_PRESIGN_TTL_SECONDS", 15 * 60),
    jobAttempts: readNumberEnv("UPLOAD_JOB_ATTEMPTS", 168),
    // Upper bound on jobs processed in parallel. The worker also enforces at
    // most one job per ad account (act_id), so effective parallelism =
    // min(this, #ad accounts with pending jobs). Bump if you upload to more.
    workerConcurrency: readNumberEnv("UPLOAD_WORKER_CONCURRENCY", 4),
    workerRateLimitMax: readNumberEnv("UPLOAD_WORKER_RATE_LIMIT_MAX", 1),
    workerRateLimitDurationMs: readNumberEnv(
      "UPLOAD_WORKER_RATE_LIMIT_DURATION_MS",
      1_000
    ),
    metaRequestIntervalMs,
    metaRateLimitDelayMs: readNumberEnv(
      "UPLOAD_META_RATE_LIMIT_DELAY_MS",
      60 * 60 * 1_000
    ),
    metaBatchSize,
    metaMaxHashesPerSecond,
    proactivePauseBytes,
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
