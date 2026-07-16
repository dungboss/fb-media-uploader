// Burst mode's load-bearing claim, against REAL Redis: a job that Meta rate
// limits must go back to `wait` WITHOUT consuming a retry attempt, and the
// worker must actually pause.
//
// Why this test exists (replaces media-upload-throttle.test.ts, which proved
// the deleted mutex): burst mode has no pacing, so `Worker.RateLimitError()`
// is the ONLY thing standing between a 429 and a permanently-`failed` image.
// The way that silently breaks — caught by neither types nor any unit test —
// is throwing the translated error directly instead of
// `Worker.RateLimitError()`: BullMQ counts it as a failure, burns an attempt,
// and after UPLOAD_JOB_ATTEMPTS a perfectly good image is marked failed just
// because Meta was busy. That is the shape of bug that cost this project a day
// (`d261a55`): each half correct, the JOIN untested. This test crosses it —
// verified by mutation, it goes red when the throw is swapped for a plain
// Error.
//
// It does NOT assert that the Worker's `limiter` option is present, on
// purpose: removing the limiter was measured to change nothing (bullmq
// 5.79.1 — rateLimit(1500ms)×3 took 4519ms with it, 4515ms without), so a
// test asserting otherwise would be testing a superstition. See the limiter
// note in media-upload-worker.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const QUEUE_NAME = "test-media-upload-rate-limit";
const RATE_LIMIT_MS = 250;
const RATE_LIMITS_BEFORE_SUCCESS = 3;
const JOB_ATTEMPTS = 2; // deliberately FEWER than the rate limits above

// Plain options, not an IORedis instance — mirrors getBullConnectionOptions()
// and sidesteps the type clash from bullmq bundling its own ioredis copy.
function bullConnection() {
  const url = new URL(REDIS_URL);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

let pingClient: IORedis;

beforeAll(async () => {
  pingClient = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

  // Fail fast with a clear message instead of hanging: maxRetriesPerRequest:
  // null (which BullMQ requires) makes commands queue forever against a dead
  // Redis rather than reject, so a bare `await ping()` would time the suite
  // out with no explanation.
  await Promise.race([
    pingClient.ping(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Redis không chạy ở ${REDIS_URL} — test này cần Redis thật.`)), 2000)
    ),
  ]);
});

afterAll(async () => {
  await pingClient?.quit();
});

describe("burst mode — Meta rate limit must not consume a retry attempt", () => {
  it("survives more rate limits than it has attempts, then completes", async () => {
    const connection = bullConnection();
    const queue = new Queue(QUEUE_NAME, { connection });
    await queue.obliterate({ force: true }).catch(() => {});

    const attemptsSeen: number[] = [];
    let rateLimitsIssued = 0;

    const worker: Worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        attemptsSeen.push(job.attemptsMade);

        if (rateLimitsIssued < RATE_LIMITS_BEFORE_SUCCESS) {
          rateLimitsIssued += 1;
          // Exactly what media-upload-worker.ts does on a 429.
          await worker.rateLimit(RATE_LIMIT_MS);
          throw Worker.RateLimitError();
        }
        return "uploaded";
      },
      {
        connection,
        concurrency: 1,
        // Mirrors the worker's config so the test exercises the real shape.
        limiter: { max: 10_000, duration: 1_000 },
      }
    );

    const startedAt = Date.now();
    await queue.add("probe", {}, { attempts: JOB_ATTEMPTS, removeOnComplete: false, removeOnFail: false });

    const outcome = await new Promise<string>((resolve) => {
      worker.on("completed", () => resolve("completed"));
      worker.on("failed", (_job, error) => resolve(`failed: ${error.message}`));
      setTimeout(() => resolve("timeout"), 15_000);
    });
    const elapsedMs = Date.now() - startedAt;

    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();

    // The point: 3 rate limits on a job allowed only 2 attempts. If rate
    // limiting consumed attempts, this job would be `failed`, not `completed`.
    expect(rateLimitsIssued).toBe(RATE_LIMITS_BEFORE_SUCCESS);
    expect(outcome).toBe("completed");

    // attemptsMade must never advance on a rate limit — the whole claim.
    expect(attemptsSeen).toEqual([0, 0, 0, 0]);

    // And the pause must be real, not a no-op: 3 × 250ms of enforced waiting
    // cannot collapse below ~2 intervals even with scheduler slack.
    expect(elapsedMs).toBeGreaterThanOrEqual(RATE_LIMIT_MS * 2);
  }, 20_000);
});
