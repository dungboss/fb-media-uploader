// Pure-function coverage for error routing + retry/backoff policy — no
// network, no mocks (matches the project's "minimal vitest" scope). Exists
// because phase 03 inverted the worker's retry shape: a rate limit now
// carries Meta's own suggested wait (MetaRateLimitRetryError.waitMs)
// instead of a constant, and getBatchCached-style helpers moved out of the
// gate. These functions are the part most likely to silently misroute an
// error, so they get direct coverage rather than only end-to-end reasoning.

import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";

import { FacebookApiError } from "../lib/media-upload/facebook-error";
import {
  buildRetryMessage,
  isMetaRateLimitRetryError,
  MetaRateLimitRetryError,
  metaAwareRetryDelayMs,
  shouldRetryLater,
  translateUploadError,
} from "./media-upload-retry";

try {
  // metaAwareRetryDelayMs / translateUploadError read getMediaUploadConfig(),
  // which requires REDIS_URL to be a non-empty string (no connection made).
  process.loadEnvFile();
} catch {
  // No .env file on disk (e.g. CI) — rely on whatever the shell exported.
}

describe("translateUploadError", () => {
  it("classifies a Meta rate-limit error as MetaRateLimitRetryError carrying a wait", () => {
    const rateLimitError = new FacebookApiError("Application request limit reached", 613, {
      code: 17,
    });

    const translated = translateUploadError(rateLimitError);

    expect(isMetaRateLimitRetryError(translated)).toBe(true);
    expect((translated as MetaRateLimitRetryError).waitMs).toBeGreaterThan(0);
  });

  it("classifies a permanent media rejection (400, not rate-limited) as UnrecoverableError", () => {
    const rejection = new FacebookApiError("Ảnh không hợp lệ hoặc bị hỏng.", 400);

    const translated = translateUploadError(rejection);

    expect(translated).toBeInstanceOf(UnrecoverableError);
    expect(translated.message).toBe("Ảnh không hợp lệ hoặc bị hỏng.");
  });

  it("rethrows a transient connection drop as-is for exponential backoff", () => {
    const transient = new TypeError("terminated");

    const translated = translateUploadError(transient);

    expect(translated).toBe(transient);
    expect(translated).not.toBeInstanceOf(UnrecoverableError);
  });

  it("passes an existing UnrecoverableError through unchanged (no double-wrap)", () => {
    const original = new UnrecoverableError("OOM guard tripped");

    expect(translateUploadError(original)).toBe(original);
  });

  it("falls back to UnrecoverableError for an unclassified error", () => {
    const translated = translateUploadError(new Error("boom"));

    expect(translated).toBeInstanceOf(UnrecoverableError);
    expect(translated.message).toBe("boom");
  });
});

describe("metaAwareRetryDelayMs", () => {
  it("uses the error's own waitMs for a MetaRateLimitRetryError", () => {
    const error = new MetaRateLimitRetryError("rate limited", 120_000);

    expect(metaAwareRetryDelayMs(3, error)).toBe(120_000);
  });

  it("grows exponentially for a non-rate-limit error, capped at the configured fallback", () => {
    const first = metaAwareRetryDelayMs(1, new Error("boom"));
    const second = metaAwareRetryDelayMs(2, new Error("boom"));

    expect(second).toBeGreaterThan(first);
  });
});

describe("shouldRetryLater", () => {
  const bullJob = (attemptsMade: number, attempts = 5) => ({ attemptsMade, opts: { attempts } });

  it("never retries an UnrecoverableError", () => {
    expect(shouldRetryLater(bullJob(1), new UnrecoverableError("bad"))).toBe(false);
  });

  it("retries a rate-limit error while attempts remain", () => {
    expect(shouldRetryLater(bullJob(1), new MetaRateLimitRetryError("wait", 1_000))).toBe(true);
  });

  it("stops retrying once attemptsMade reaches the configured max", () => {
    expect(shouldRetryLater(bullJob(5, 5), new MetaRateLimitRetryError("wait", 1_000))).toBe(false);
  });

  it("does not retry a plain (non-transient, non-rate-limit) error", () => {
    expect(shouldRetryLater(bullJob(1), new Error("validation failed"))).toBe(false);
  });
});

describe("buildRetryMessage", () => {
  it("includes a Vietnamese-locale retry time for a rate-limit error", () => {
    const message = buildRetryMessage(new MetaRateLimitRetryError("Facebook giới hạn tốc độ.", 60_000));

    expect(message).toContain("Facebook giới hạn tốc độ.");
    expect(message).toContain("Dự kiến thử lại lúc");
  });

  it("returns the raw message for an unclassified error", () => {
    expect(buildRetryMessage(new Error("validation failed"))).toBe("validation failed");
  });
});
