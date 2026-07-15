// Parses Meta's `X-Business-Use-Case-Usage` (BUC) header — the ONLY usage
// signal these edges emit. `X-Ad-Account-Usage` was measured ABSENT on both
// `me/adaccounts` and `act_X/adimages` (2026-07-16 live probe; see plan.md
// "Rate-limit ground truth"), so it is deliberately not read anywhere here.
//
// BUC entries are keyed by the BARE ad account id (no `act_` prefix); our
// callers hold `act_<id>` or `act:<id>`. Every read/write below normalizes
// through `normalizeAccountKey` — get this wrong and the store silently
// returns null forever while nothing errors.

export type MetaAccessTier = "development_access" | "standard_access" | "unknown";

export interface MetaUsage {
  tier: MetaAccessTier; // BUC entry .ads_api_access_tier
  callCount: number | null; // .call_count — units unconfirmed, treat as % (see plan.md risk #2)
  cpuPct: number | null; // .total_cputime (%)
  timePct: number | null; // .total_time (%)
  regainMinutes: number | null; // .estimated_time_to_regain_access — MINUTES, not ms/seconds
  observedAt: number;
}

interface BucEntry {
  type?: string;
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
  ads_api_access_tier?: string;
}

// Marketing-API docs say `X-Business-Use-Case`; Graph-API docs and the live
// 2026-07-16 probe both used `X-Business-Use-Case-Usage`. Read both — take
// whichever the edge actually sent.
const USAGE_HEADER_NAMES = ["x-business-use-case-usage", "x-business-use-case"];

// Module-level store — single-process assumption, same as the old in-memory
// gate made. Usage is genuinely per-account server-side state, so a keyed
// store here is semantically honest, not a shortcut.
const usageStore = new Map<string, MetaUsage>();

// Parses the header into one entry per bare ad account id. Never throws:
// a missing header or malformed JSON both resolve to an empty map.
export function parseUsageHeaders(headers: Headers): Map<string, MetaUsage> {
  const result = new Map<string, MetaUsage>();
  const raw = readUsageHeader(headers);
  if (!raw) {
    return result;
  }

  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return result;
  }

  for (const [accountKey, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      continue;
    }
    result.set(normalizeAccountKey(accountKey), pickUsage(entries as BucEntry[]));
  }

  return result;
}

// Records every account found in the header — one `me/adaccounts` response
// updates all 5 accounts' entries at once; one `adimages` response updates
// just the one it targeted.
export function recordUsageFromHeaders(headers: Headers): void {
  for (const [accountKey, usage] of parseUsageHeaders(headers)) {
    // Normalize on write too, not just on read: today Meta keys these by bare
    // id so this is a no-op, but the store's whole contract is "one entry per
    // bare id". Relying on the header's format to hold that invariant makes a
    // future format change a silent miss rather than an error.
    usageStore.set(normalizeAccountKey(accountKey), usage);
  }
}

// Accepts act_X, act:X, or a bare id — all three resolve to the same entry.
export function getUsage(accountKey: string): MetaUsage | null {
  return usageStore.get(normalizeAccountKey(accountKey)) ?? null;
}

// Converts observed usage into a wait before the next call. `regainMinutes`
// is Meta's own advice on a rate-limited response — trust it verbatim
// (converted to ms, the one place that conversion happens) when it names a
// positive wait. Otherwise fall back to the caller-supplied floor.
export function suggestedWaitMs(usage: MetaUsage | null, fallbackMs: number): number {
  if (usage?.regainMinutes && usage.regainMinutes > 0) {
    return usage.regainMinutes * 60_000;
  }
  return fallbackMs;
}

// Selects the `ads_management` bucket (what `adimages` reports into); falls
// back to the first entry if that type is absent.
function pickUsage(entries: BucEntry[]): MetaUsage {
  const entry = entries.find((candidate) => candidate.type === "ads_management") ?? entries[0];

  return {
    tier: normalizeTier(entry.ads_api_access_tier),
    callCount: toNullableNumber(entry.call_count),
    cpuPct: toNullableNumber(entry.total_cputime),
    timePct: toNullableNumber(entry.total_time),
    regainMinutes: toNullableNumber(entry.estimated_time_to_regain_access),
    observedAt: Date.now(),
  };
}

function normalizeTier(value: string | undefined): MetaAccessTier {
  return value === "development_access" || value === "standard_access" ? value : "unknown";
}

// Reduces any caller's key form to the bare id the BUC header uses. Strips
// REPEATED prefixes on purpose: a caller that prefixes an already-prefixed id
// produces "act:act_<id>", and stripping only one leading prefix leaves
// "act_<id>" — a silent lookup miss with no error anywhere. Defence in depth;
// resolveAccountKey no longer builds such keys.
function normalizeAccountKey(rawKey: string): string {
  return rawKey.trim().replace(/^(?:act[_:])+/, "");
}

function readUsageHeader(headers: Headers): string | null {
  for (const name of USAGE_HEADER_NAMES) {
    const value = headers.get(name);
    if (value) {
      return value;
    }
  }
  return null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toNullableNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
