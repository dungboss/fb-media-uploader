// Graph API core: the `facebookRequest` helper, response parsing, and
// Meta-error classification. Credential resolution lives in
// meta-token-resolver.ts and error-message formatting in
// meta-error-messages.ts — both split out purely to keep this file under
// the 200-line guideline. Salvaged from the deleted
// app/api/audiences/meta.ts (see phase-02-meta-image-client.md's salvage
// map). Auth is query-param `access_token` + `appsecret_proof` — NEVER
// `Authorization: Bearer`.

import { resilientFetch } from "@/lib/resilient-fetch";

import { FacebookApiError, type MetaApiErrorPayload } from "./facebook-error";
import { formatMetaErrorMessage, hasMetaError } from "./meta-error-messages";
import { getUsage, recordUsageFromHeaders } from "./meta-usage";
import {
  computeAppSecretProof,
  type FacebookCredentials,
} from "./meta-token-resolver";

export const FACEBOOK_GRAPH_BASE_URL = "https://graph.facebook.com";

// Re-exported so callers that only need graph-request concerns don't also
// have to import from meta-token-resolver.ts directly.
export {
  DEFAULT_FACEBOOK_API_VERSION,
  computeAppSecretProof,
  pickFirstDefinedEnv,
  resolveCredentials,
  type FacebookCredentialOptions,
  type FacebookCredentials,
} from "./meta-token-resolver";

export function getClientSafeError(
  error: unknown,
  fallbackMessage: string
): { message: string; status: number; details?: MetaApiErrorPayload } {
  if (error instanceof FacebookApiError) {
    return {
      message: error.message,
      status: error.status,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message || fallbackMessage,
      status: 500,
    };
  }

  return {
    message: fallbackMessage,
    status: 500,
  };
}

export function isFacebookRateLimitError(error: unknown) {
  if (!(error instanceof FacebookApiError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const code = error.details?.code;

  return (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613 ||
    code === 80003 ||
    /rate limit|too many calls|application request limit|wait and try again/i.test(
      message
    )
  );
}

// Meta understood the request and permanently refused the asset (bad
// format, too large, corrupt) — HTTP 400 that is NOT a rate limit.
// Deliberately no size threshold: Meta's real limit is undocumented, so
// Meta's own refusal is the only authority.
export function isMetaMediaRejectionError(error: unknown) {
  return (
    error instanceof FacebookApiError &&
    error.status === 400 &&
    !isFacebookRateLimitError(error)
  );
}

export async function facebookRequest<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string> },
  credentials: FacebookCredentials
): Promise<T> {
  const { accessToken, apiVersion, appSecret } = credentials;
  const url = new URL(
    `${FACEBOOK_GRAPH_BASE_URL}/${apiVersion}/${path.replace(/^\/+/, "")}`
  );

  url.searchParams.set("access_token", accessToken);

  const proof = computeAppSecretProof(accessToken, appSecret);
  if (proof) {
    url.searchParams.set("appsecret_proof", proof);
  }

  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  // Do NOT set Content-Type here — when init.body is a FormData (adimages
  // upload), fetch must choose the multipart boundary itself.
  const response = await resilientFetch(
    url,
    {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    },
    { label: "meta-graph" }
  );

  return parseFacebookResponse<T>(response, path);
}

// Parses a Graph API response: records usage headers (present on every
// response, success or error — meta-usage.ts), then throws a
// FacebookApiError (with this call's account usage attached) on a non-2xx
// status or a Meta-shaped error body. Exported so the ad-accounts paging
// loop — which fetches `paging.next` directly instead of through
// `facebookRequest` — reuses the same parsing + usage-recording path.
export async function parseFacebookResponse<T>(
  response: Response,
  path?: string
): Promise<T> {
  const text = await response.text();
  const payload = text ? tryParseJson(text) : {};

  // Usage headers arrive on errors too — in fact that's when they matter
  // most (estimated_time_to_regain_access on a 429). Record before the throw.
  recordUsageFromHeaders(response.headers);

  if (!response.ok || hasMetaError(payload)) {
    const errorPayload = hasMetaError(payload) ? payload.error : undefined;
    const fallbackMessage = `Facebook API trả về lỗi ${response.status}.`;
    const accountId = path ? extractAdAccountId(path) : null;

    throw new FacebookApiError(
      formatMetaErrorMessage(errorPayload) ?? errorPayload?.message ?? fallbackMessage,
      response.status,
      errorPayload,
      accountId ? (getUsage(accountId) ?? undefined) : undefined
    );
  }

  return payload as T;
}

// Pulls the `act_<id>` this call targeted out of a Graph path, if any — used
// to attach the right account's usage snapshot to a thrown error. A call
// like `me/adaccounts` has none (its usage response covers all accounts at
// once, not a single one).
function extractAdAccountId(path: string): string | null {
  const match = path.match(/act_(\d+)/);
  return match ? match[1] : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FacebookApiError("Facebook API trả về dữ liệu không phải JSON.", 502);
  }
}
