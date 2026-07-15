import { describe, expect, it } from "vitest";

import {
  getUsage,
  parseUsageHeaders,
  recordUsageFromHeaders,
  suggestedWaitMs,
} from "./meta-usage";

// Verbatim X-Business-Use-Case-Usage body from the 2026-07-16 probe
// (GET act_679927437761688/adimages) — see plan.md "Rate-limit ground truth".
const PROBE_PAYLOAD = JSON.stringify({
  "679927437761688": [
    {
      type: "ads_management",
      call_count: 0,
      total_cputime: 0,
      total_time: 0,
      estimated_time_to_regain_access: 0,
      ads_api_access_tier: "development_access",
    },
  ],
});

function headersWith(name: string, value: string): Headers {
  return new Headers({ [name]: value });
}

describe("parseUsageHeaders", () => {
  it("parses the verbatim probe payload, keyed by the bare account id", () => {
    const result = parseUsageHeaders(
      headersWith("x-business-use-case-usage", PROBE_PAYLOAD)
    );

    expect(result.size).toBe(1);
    expect(result.get("679927437761688")).toMatchObject({
      tier: "development_access",
      callCount: 0,
    });
  });

  it("parses a me/adaccounts-style header carrying 5 account keys", () => {
    const payload: Record<string, unknown> = {};
    for (const id of ["1", "2", "3", "4", "5"]) {
      payload[id] = [
        {
          type: "ads_management",
          ads_api_access_tier: id === "1" ? "standard_access" : "development_access",
          call_count: Number(id),
        },
      ];
    }

    const result = parseUsageHeaders(
      headersWith("x-business-use-case-usage", JSON.stringify(payload))
    );

    expect(result.size).toBe(5);
    expect(result.get("1")).toMatchObject({ tier: "standard_access", callCount: 1 });
    expect(result.get("2")).toMatchObject({ tier: "development_access", callCount: 2 });
  });

  it("reads the Marketing-API header spelling (X-Business-Use-Case) identically", () => {
    const result = parseUsageHeaders(headersWith("x-business-use-case", PROBE_PAYLOAD));

    expect(result.get("679927437761688")?.tier).toBe("development_access");
  });

  it("returns an empty map, never throws, when the header is absent", () => {
    expect(parseUsageHeaders(new Headers()).size).toBe(0);
  });

  it("returns an empty map, never throws, on malformed JSON", () => {
    const result = parseUsageHeaders(
      headersWith("x-business-use-case-usage", "{not valid json")
    );

    expect(result.size).toBe(0);
  });

  it("picks the ads_management entry among several types", () => {
    const payload = {
      "1": [
        { type: "custom_audience", call_count: 99 },
        { type: "ads_management", call_count: 5, ads_api_access_tier: "development_access" },
      ],
    };

    const result = parseUsageHeaders(
      headersWith("x-business-use-case-usage", JSON.stringify(payload))
    );

    expect(result.get("1")).toMatchObject({ callCount: 5, tier: "development_access" });
  });

  it("fills every field null (never throws) when an entry has no usable data", () => {
    const result = parseUsageHeaders(
      headersWith("x-business-use-case-usage", JSON.stringify({ "1": [{}] }))
    );

    expect(result.get("1")).toMatchObject({
      tier: "unknown",
      callCount: null,
      cpuPct: null,
      timePct: null,
      regainMinutes: null,
    });
  });
});

describe("getUsage key normalization", () => {
  it("resolves act_X, act:X, and the bare id to the same recorded entry", () => {
    recordUsageFromHeaders(headersWith("x-business-use-case-usage", PROBE_PAYLOAD));

    const bare = getUsage("679927437761688");
    const withUnderscorePrefix = getUsage("act_679927437761688");
    const withColonPrefix = getUsage("act:679927437761688");

    expect(bare).not.toBeNull();
    expect(withUnderscorePrefix).toEqual(bare);
    expect(withColonPrefix).toEqual(bare);
  });

  it("returns null for an account nothing has recorded usage for", () => {
    expect(getUsage("000000000000000")).toBeNull();
  });
});

describe("suggestedWaitMs", () => {
  it("converts regainMinutes to milliseconds when positive", () => {
    const usage = {
      tier: "development_access" as const,
      callCount: 90,
      cpuPct: null,
      timePct: null,
      regainMinutes: 2,
      observedAt: Date.now(),
    };

    expect(suggestedWaitMs(usage, 1_000)).toBe(120_000);
  });

  it("falls back to the configured default when usage is null", () => {
    expect(suggestedWaitMs(null, 1_234)).toBe(1_234);
  });

  it("falls back to the default when regainMinutes is 0 (no wait signaled)", () => {
    const usage = {
      tier: "development_access" as const,
      callCount: 0,
      cpuPct: null,
      timePct: null,
      regainMinutes: 0,
      observedAt: Date.now(),
    };

    expect(suggestedWaitMs(usage, 500)).toBe(500);
  });
});
