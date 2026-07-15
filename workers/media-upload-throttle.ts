// Per-ad-account pacing for Meta requests. Split out of media-upload-worker
// purely to keep that file under the 200-line guideline; also lets the
// concurrency-proof test (media-upload-throttle.test.ts) import
// `acquireThrottleSlot` with zero side effects (no Worker/main() to guard
// against on import).
//
// GATE REMOVAL CONTEXT (see media-upload-worker.ts's header comment for the
// full rationale): this Redis `SET NX PX` mutex is now the ONLY pacing
// mechanism — the per-ad-account BullMQ concurrency gate (`6e34a33` /
// `0f8756f`) was removed because it actively hurt the thousands-of-~1s-POSTs
// workload. `acquireThrottleSlot` already enforces the real constraint (a
// minimum interval between calls per account), so nothing else needs to.

import { getUsage, type MetaAccessTier } from "../lib/media-upload/meta-usage";
import { getRedis } from "../lib/media-upload/redis";

const META_REQUEST_THROTTLE_PREFIX = "media-upload:meta-request-throttle";

// Single `if`, never a `while` — the usage store only advances on a Meta
// response, so a loop that sleeps without calling would deadlock.
const BRAKE_PCT = 90;
const BRAKE_SLEEP_MS = 60_000;

// Per-tier minimum spacing between Meta requests. 15s (not the 12s the raw
// 300/hr BUC floor alone allows) for dev tier: X-Ad-Account-Usage — carrier
// of the 60-point/300s score limit — was measured ABSENT on these edges,
// which doesn't prove that limit is gone, only unreported. 15s = 20
// writes/300s, safe either way. Do not lower without new evidence (see
// logUsageProgress below and plan.md "Rate-limit ground truth").
const TIER_INTERVAL_MS: Record<MetaAccessTier, number> = {
  standard_access: 200,
  development_access: 15_000,
  unknown: 1_000,
};

// Throttle bucket for a job: ad account id, else token id, else a shared
// default. No gate role anymore (removed — see header) — this only keys
// the Redis throttle below.
export function resolveAccountKey(adAccountId: string | null, tokenId: string | null): string {
  const account = adAccountId?.trim();
  if (account) return `act:${account}`;
  const token = tokenId?.trim();
  return token ? `token:${token}` : "default";
}

// The mutex primitive: a self-expiring Redis key enforces a minimum
// `intervalMs` between acquisitions per accountKey (SET NX wins; every other
// waiter sleeps the remaining PTTL and retries). This is what the
// concurrency-proof test verifies directly against real Redis, independent
// of the BUC/tier policy layered on top by acquireMetaRequestSlot below.
export async function acquireThrottleSlot(accountKey: string, intervalMs: number): Promise<void> {
  const redis = getRedis();
  const throttleKey = `${META_REQUEST_THROTTLE_PREFIX}:${accountKey}`;

  while (true) {
    const acquired = await redis.set(throttleKey, "1", "PX", intervalMs, "NX");
    if (acquired === "OK") return;
    const remainingTtlMs = await redis.pttl(throttleKey);
    await waitFor(remainingTtlMs > 0 ? remainingTtlMs : 100);
  }
}

// Brakes on observed call_count, derives the interval from the account's
// tier (floored by the env knob), then acquires the mutex.
export async function acquireMetaRequestSlot(accountKey: string, envFloorMs: number): Promise<void> {
  const usage = getUsage(accountKey);

  if (usage && typeof usage.callCount === "number" && usage.callCount >= BRAKE_PCT) {
    console.warn(`[media-upload-worker] ${accountKey} call_count=${usage.callCount} >= ${BRAKE_PCT}, braking`);
    await waitFor(BRAKE_SLEEP_MS);
  }

  const intervalMs = Math.max(envFloorMs, TIER_INTERVAL_MS[usage?.tier ?? "unknown"]);
  await acquireThrottleSlot(accountKey, intervalMs);
}

// Tier on first response per account (explains the ETA to an operator),
// call_count every 25 completed jobs (evidence for tuning
// UPLOAD_META_REQUEST_INTERVAL_MS — see the TIER_INTERVAL_MS comment).
const tierLoggedAccounts = new Set<string>();
let completedJobCount = 0;

export function logUsageProgress(accountKey: string): void {
  const usage = getUsage(accountKey);
  if (!usage) return;

  if (!tierLoggedAccounts.has(accountKey)) {
    tierLoggedAccounts.add(accountKey);
    console.info(`[media-upload-worker] ${accountKey} tier=${usage.tier} interval=${TIER_INTERVAL_MS[usage.tier]}ms`);
  }

  completedJobCount += 1;
  if (completedJobCount % 25 === 0) {
    console.info(`[media-upload-worker] progress: ${completedJobCount} done, ${accountKey} call_count=${usage.callCount ?? "?"}`);
  }
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
