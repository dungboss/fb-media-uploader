// Per-ad-account usage reporting for Meta requests. This file used to also
// hold the pacing throttle (`media-upload-throttle.ts`, commits `1f75e3f` /
// `d261a55`); the throttle is GONE by explicit product decision — see the
// "BURST MODE" note in media-upload-worker.ts's header for the full rationale.
//
// What remains is the only visibility we have into Meta's real quota:
// `call_count` from the BUC header. Dev-tier quota is `300 + 40 × active_ads`
// calls/hr and `active_ads` is unknown to us, so the ceiling cannot be
// derived — it can only be OBSERVED. These log lines are that observation.

import { getUsage } from "../lib/media-upload/meta-usage";

// Throttle bucket for a job: ad account id, else token id, else a shared
// default. Also the key handed to getUsage(), so it MUST reduce to the bare
// id Meta's BUC header is keyed by.
//
// Strip any existing act_/act: before prefixing: batch.adAccountId arrives as
// "act_<id>", so a blind `act:${account}` yields "act:act_<id>", which
// normalizeAccountKey (one prefix only) reduces to "act_<id>" and never
// matches the stored bare "<id>". That miss is silent — getUsage returns null
// and nothing errors. It cost a real bug once (`d261a55`): the tier was never
// learned, so pacing silently sat at the wrong default. Caught end-to-end, not
// by unit tests; media-upload-usage-key.test.ts now pins the round trip.
export function resolveAccountKey(adAccountId: string | null, tokenId: string | null): string {
  const account = adAccountId?.trim().replace(/^(?:act[_:])+/, "");
  if (account) return `act:${account}`;
  const token = tokenId?.trim();
  return token ? `token:${token}` : "default";
}

// Tier on first response per account, call_count every 25 completed jobs.
// In burst mode call_count is the ONLY evidence of where Meta's real ceiling
// sits — read these lines to find out what the account actually allows.
const tierLoggedAccounts = new Set<string>();
let completedJobCount = 0;
const USAGE_LOG_EVERY_N_JOBS = 25;

export function logUsageProgress(accountKey: string): void {
  const usage = getUsage(accountKey);
  if (!usage) return;

  if (!tierLoggedAccounts.has(accountKey)) {
    tierLoggedAccounts.add(accountKey);
    console.info(`[media-upload-worker] ${accountKey} tier=${usage.tier} (burst mode — no pacing)`);
  }

  completedJobCount += 1;
  if (completedJobCount % USAGE_LOG_EVERY_N_JOBS === 0) {
    console.info(
      `[media-upload-worker] progress: ${completedJobCount} done, ${accountKey} call_count=${usage.callCount ?? "?"}`
    );
  }
}
