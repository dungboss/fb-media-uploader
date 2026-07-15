// Ad account listing + id resolution. Salvaged from
// app/api/audiences/meta.ts — see phase-02-meta-image-client.md's salvage
// map.

import { resilientFetch } from "@/lib/resilient-fetch";

import { FacebookApiError } from "./facebook-error";
import {
  facebookRequest,
  parseFacebookResponse,
  type FacebookCredentialOptions,
} from "./meta-graph";
import {
  computeAppSecretProof,
  pickFirstDefinedEnv,
  resolveCredentials,
} from "./meta-token-resolver";
import { getUsage, type MetaAccessTier } from "./meta-usage";

export interface AdAccountListItem {
  id: string; // act_<id> — use this for Graph API paths
  accountId: string; // numeric id without the act_ prefix
  name: string;
  accountStatus: number | null;
  currency: string | null;
  // Free off `me/adaccounts`' X-Business-Use-Case-Usage header — no extra
  // Meta call. "unknown" until at least one call for this account has
  // recorded usage.
  tier: MetaAccessTier;
}

interface MetaAdAccount {
  id?: string;
  account_id?: string;
  name?: string;
  account_status?: number | string;
  currency?: string;
}

interface MetaAdAccountListResponse {
  data?: MetaAdAccount[];
  paging?: { next?: string };
}

// Lists every ad account the access token can reach (Graph `me/adaccounts`),
// following pagination so accounts beyond the first page are included. Lets
// the UI offer a picker instead of hardcoding FACEBOOK_AD_ACCOUNT_ID in .env.
export async function listAdAccounts(
  options?: FacebookCredentialOptions
): Promise<AdAccountListItem[]> {
  const credentials = await resolveCredentials(options);
  const fields = ["account_id", "name", "account_status", "currency"].join(",");

  // First page goes through the shared helper (token + api version + parsing).
  let page = await facebookRequest<MetaAdAccountListResponse>(
    "me/adaccounts",
    { method: "GET", query: { fields, limit: "200" } },
    credentials
  );

  const items: AdAccountListItem[] = [];
  let guard = 0;

  while (true) {
    for (const account of page.data ?? []) {
      const mapped = mapAdAccount(account);
      if (mapped) {
        items.push(mapped);
      }
    }

    const next = page.paging?.next;
    if (!next || guard >= 25) {
      break;
    }
    guard += 1;

    // `next` is an absolute Graph URL already carrying access_token + cursor;
    // re-attach appsecret_proof (it isn't preserved in the paging link).
    const nextUrl = new URL(next);
    const proof = computeAppSecretProof(credentials.accessToken, credentials.appSecret);
    if (proof) {
      nextUrl.searchParams.set("appsecret_proof", proof);
    }

    const response = await resilientFetch(
      nextUrl,
      { cache: "no-store", headers: { Accept: "application/json" } },
      { label: "meta-adaccounts" }
    );
    page = await parseFacebookResponse<MetaAdAccountListResponse>(
      response,
      "me/adaccounts"
    );
  }

  return items.sort((left, right) => left.name.localeCompare(right.name));
}

// True when a fallback token exists in .env (lets the UI offer it as an option).
export function hasEnvAccessToken(): boolean {
  return Boolean(
    pickFirstDefinedEnv(["FACEBOOK_ACCESS_TOKEN", "FB_ACCESS_TOKEN", "ACCESS_TOKEN"])
  );
}

// The ad account from .env, normalized to `act_<id>`. Now only a default —
// callers may override it with a runtime-selected account. Returns null when
// unset (the UI then drives selection from listAdAccounts()).
export function getDefaultAdAccountId(): string | null {
  const raw = pickFirstDefinedEnv([
    "FACEBOOK_AD_ACCOUNT_ID",
    "FB_AD_ACCOUNT_ID",
    "AD_ACCOUNT_ID",
  ]);

  return raw ? normalizeAdAccountId(raw) : null;
}

// Resolves the ad account to act on: an explicit (user-selected) id wins,
// otherwise fall back to the .env default. Throws when neither is available.
export function resolveAdAccountId(explicit?: string): string {
  const normalizedExplicit = explicit?.trim();

  if (normalizedExplicit) {
    return normalizeAdAccountId(normalizedExplicit);
  }

  const fallback = getDefaultAdAccountId();

  if (!fallback) {
    throw new FacebookApiError(
      "Chưa chọn ad account. Hãy chọn một tài khoản quảng cáo từ danh sách hoặc đặt FACEBOOK_AD_ACCOUNT_ID trong .env.",
      400
    );
  }

  return fallback;
}

export function normalizeAdAccountId(rawAdAccountId: string): string {
  const trimmed = rawAdAccountId.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function mapAdAccount(account: MetaAdAccount): AdAccountListItem | null {
  const accountId = (account.account_id ?? account.id?.replace(/^act_/, "") ?? "").trim();

  if (!accountId) {
    return null;
  }

  const usage = getUsage(accountId);

  return {
    id: `act_${accountId}`,
    accountId,
    name: account.name?.trim() || `act_${accountId}`,
    accountStatus: toNullableNumber(account.account_status),
    currency: account.currency ?? null,
    tier: usage?.tier ?? "unknown",
  };
}

function toNullableNumber(value: number | string | undefined) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsedNumber = Number(value);
  return Number.isFinite(parsedNumber) ? parsedNumber : null;
}
