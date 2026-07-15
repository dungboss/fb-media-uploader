// Blocking exit criterion for phase 03's gate removal (see plan.md "Key
// risks" #3 and media-upload-worker.ts's header comment): with the
// per-ad-account BullMQ concurrency gate gone, `acquireThrottleSlot` — a
// Redis `SET NX PX` mutex — is the ONLY thing pacing requests to one
// account. This must be proven empirically against REAL Redis under N
// concurrent acquirers, not assumed.
//
// Deliberately NOT a real-Meta test: no network call, no `uploadAdImage`.
// This proves the mutex primitive holds the interval property under
// concurrency; it says nothing about Meta's actual rate limits (that's the
// job of the tier/BUC constants in media-upload-throttle.ts, reasoned about
// separately since they need no live traffic to verify).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRedis } from "../lib/media-upload/redis";
import { acquireThrottleSlot } from "./media-upload-throttle";

try {
  // `vitest run` (unlike `tsx --env-file=.env`) does not read .env by
  // itself — load it here so REDIS_URL is available for getRedis() below.
  // No-op if already set by the shell.
  process.loadEnvFile();
} catch {
  // No .env file on disk (e.g. CI) — rely on whatever the shell exported.
}

const INTERVAL_MS = 100;
const CONCURRENT_WAITERS = 8;
const ACQUISITIONS_PER_WAITER = 5;
const TOTAL_ACQUISITIONS = CONCURRENT_WAITERS * ACQUISITIONS_PER_WAITER;

describe("acquireThrottleSlot — real Redis, N concurrent acquirers", () => {
  const accountKey = `test-throttle:${randomUUID()}`;
  const throttleKey = `media-upload:meta-request-throttle:${accountKey}`;

  // Fail fast and honestly when Redis is simply not running. Without this the
  // suite hangs and reports a *timeout* on the throttle assertion — which reads
  // as "the mutex is broken" when the real cause is an unreachable dependency.
  //
  // The ping must be raced against a timer rather than awaited: the shared
  // client sets `maxRetriesPerRequest: null` (BullMQ requires it), so commands
  // queue forever waiting for a connection instead of rejecting. A plain
  // `await ping()` would hang, not throw.
  beforeAll(async () => {
    const reachable = await Promise.race([
      getRedis()
        .ping()
        .then(() => true)
        .catch(() => false),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);

    if (!reachable) {
      throw new Error(
        `Redis unreachable at ${process.env.REDIS_URL ?? "redis://localhost:6379"}. ` +
          `This test needs real Redis — it proves the SET NX PX mutex holds under ` +
          `concurrency, which cannot be faked. Start Redis and re-run.`
      );
    }
  }, 5_000);

  afterAll(async () => {
    await getRedis().del(throttleKey);
  });

  it(
    "never lets two acquisitions on the same account land closer than intervalMs apart",
    async () => {
      const acquiredAt: number[] = [];

      async function waiter() {
        for (let i = 0; i < ACQUISITIONS_PER_WAITER; i++) {
          await acquireThrottleSlot(accountKey, INTERVAL_MS);
          acquiredAt.push(Date.now());
          // Stub "upload": no network I/O here — proves the mutex, not Meta.
        }
      }

      await Promise.all(Array.from({ length: CONCURRENT_WAITERS }, () => waiter()));

      expect(acquiredAt).toHaveLength(TOTAL_ACQUISITIONS);

      const sorted = [...acquiredAt].sort((a, b) => a - b);
      const gaps = sorted.slice(1).map((timestamp, index) => timestamp - sorted[index]);
      const minGap = Math.min(...gaps);

      // 5ms slack for scheduler/event-loop jitter — the property under test
      // is "never faster than the interval", not sub-millisecond precision.
      expect(minGap).toBeGreaterThanOrEqual(INTERVAL_MS - 5);
      // The full run must take at least (N-1) intervals serialized through
      // one mutex — guards against a no-op throttle trivially "passing".
      expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThanOrEqual((TOTAL_ACQUISITIONS - 1) * (INTERVAL_MS - 5));
    },
    20_000
  );
});
