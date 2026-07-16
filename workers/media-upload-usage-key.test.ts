// Regression test for a bug the whole unit suite missed: the worker's throttle
// key could not reach the usage store, so the tier was never learned and the
// interval sat at the 1s "unknown" default instead of dev tier's 15s. A
// 5000-image batch would have fired ~3600 req/hr into a ~300/hr quota.
//
// Nothing errored. Every existing test passed. `resolveAccountKey` was tested
// on its own, `getUsage` was tested on its own, and both were correct on their
// own — the defect lived only in the round trip between them, which no test
// crossed. It surfaced from an end-to-end run: 3 images finished in ~3s when
// dev-tier pacing implies ~30s.
//
// So this test asserts the JOIN, not either half: a key built the way the
// worker builds it (from a real `act_<id>`) must resolve usage recorded the
// way Meta actually sends it (keyed by bare `<id>`).

import { describe, expect, it } from "vitest";

import { getUsage, recordUsageFromHeaders } from "../lib/media-upload/meta-usage";
import { resolveAccountKey } from "./media-upload-usage-log";

// Verbatim from the 2026-07-16 live probe: bare id key, no act_ prefix.
const BUC_PAYLOAD = JSON.stringify({
  "1569761797025413": [
    {
      type: "ads_management",
      call_count: 2,
      total_cputime: 0,
      total_time: 0,
      estimated_time_to_regain_access: 0,
      ads_api_access_tier: "development_access",
    },
  ],
});

function headersWithUsage(): Headers {
  return new Headers({ "x-business-use-case-usage": BUC_PAYLOAD });
}

describe("worker throttle key ↔ usage store round trip", () => {
  it("resolves usage from a key built out of a real act_-prefixed batch id", () => {
    recordUsageFromHeaders(headersWithUsage());

    // Exactly what the worker does: batch.adAccountId already carries "act_".
    const accountKey = resolveAccountKey("act_1569761797025413", "some-token-id");
    const usage = getUsage(accountKey);

    expect(usage, `getUsage(${accountKey}) must not be null — a null here means the worker silently paces at the unknown-tier default`).not.toBeNull();
    expect(usage?.tier).toBe("development_access");
  });

  it("never emits a double-prefixed key", () => {
    expect(resolveAccountKey("act_123", null)).toBe("act:123");
    expect(resolveAccountKey("act:123", null)).toBe("act:123");
    expect(resolveAccountKey("123", null)).toBe("act:123");
  });

  it("resolves the same usage entry from every key form a caller might hold", () => {
    recordUsageFromHeaders(headersWithUsage());

    for (const form of [
      "act:act_1569761797025413", // the old, broken shape — must still resolve
      "act:1569761797025413",
      "act_1569761797025413",
      "1569761797025413",
    ]) {
      expect(getUsage(form), `key form ${form} must resolve`).not.toBeNull();
    }
  });

  it("falls back to the token bucket when no ad account is set", () => {
    expect(resolveAccountKey(null, "tok-1")).toBe("token:tok-1");
    expect(resolveAccountKey(null, null)).toBe("default");
  });
});
