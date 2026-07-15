// Meta error classification + BullMQ retry/backoff policy. Split out of
// media-upload-worker.ts purely to keep that file under the 200-line
// guideline.

import { UnrecoverableError } from "bullmq";

import { getMediaUploadConfig } from "../lib/media-upload/env";
import { FacebookApiError } from "../lib/media-upload/facebook-error";
import { isFacebookRateLimitError, isMetaMediaRejectionError } from "../lib/media-upload/meta-graph";
import { suggestedWaitMs } from "../lib/media-upload/meta-usage";
import { describeFetchError, isTransientFetchError } from "../lib/resilient-fetch";

// Also used by media-upload-worker.ts as the non-"meta-aware" backoff fallback.
export const DEFAULT_RETRY_DELAY_MS = 5_000;

// A cancel found before the upload starts unwinds via this. A cancel
// landing mid-POST is NOT caught by the caller — the upload completes and
// its hash is recorded; the asset genuinely is in the library, so faking a
// rollback would be dishonest.
export class JobCancelledError extends Error {
  constructor() {
    super("Job đã bị huỷ bởi người dùng.");
    this.name = "JobCancelledError";
  }
}

export class MetaRateLimitRetryError extends Error {
  constructor(
    message: string,
    readonly waitMs: number
  ) {
    super(message);
    this.name = "MetaRateLimitRetryError";
  }
}

export function isMetaRateLimitRetryError(error: unknown): error is MetaRateLimitRetryError {
  return error instanceof Error && error.name === "MetaRateLimitRetryError";
}

// Error routing (order matters): rate limit → carry Meta's suggested wait;
// transient drop → rethrow for exponential backoff; media rejection / else
// → fail fast. JobCancelledError is handled by the caller before this runs.
export function translateUploadError(error: unknown): Error {
  if (error instanceof UnrecoverableError) return error;

  if (isFacebookRateLimitError(error)) {
    const usage = error instanceof FacebookApiError ? (error.usage ?? null) : null;
    const waitMs = suggestedWaitMs(usage, getMediaUploadConfig().metaRateLimitDelayMs);
    return new MetaRateLimitRetryError(error instanceof Error ? error.message : String(error), waitMs);
  }
  if (isTransientFetchError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (isMetaMediaRejectionError(error)) {
    // Permanent 400 (corrupt/rejected image) — fail fast with Meta's own message.
    return new UnrecoverableError(error instanceof Error ? error.message : String(error));
  }

  // Any other unclassified error also fails fast rather than retrying forever.
  return new UnrecoverableError(error instanceof Error ? error.message : String(error));
}

// Meta's suggested rate-limit wait, else exponential backoff capped at the
// configured fallback. Shared by the BullMQ backoff strategy and the
// worker's own "failed" handler (nextRetryAt for the UI countdown).
export function metaAwareRetryDelayMs(attemptsMade: number, error: unknown): number {
  if (isMetaRateLimitRetryError(error)) return error.waitMs;
  const { metaRateLimitDelayMs } = getMediaUploadConfig();
  return Math.min(DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(attemptsMade - 1, 0), metaRateLimitDelayMs);
}

export function shouldRetryLater(
  bullJob: { attemptsMade: number; opts: { attempts?: number } },
  error: Error
): boolean {
  if (error instanceof UnrecoverableError) return false;
  const maxAttempts = bullJob.opts.attempts ?? 1;
  const retryable = isMetaRateLimitRetryError(error) || isTransientFetchError(error);
  return retryable && bullJob.attemptsMade < maxAttempts;
}

export function buildRetryMessage(error: Error): string {
  if (isMetaRateLimitRetryError(error)) {
    const retryAt = new Date(Date.now() + error.waitMs).toLocaleString("vi-VN");
    return `${error.message} Dự kiến thử lại lúc ${retryAt}.`;
  }
  if (isTransientFetchError(error)) return `Kết nối bị gián đoạn (${describeFetchError(error)}). Worker sẽ thử lại.`;
  return error.message;
}
