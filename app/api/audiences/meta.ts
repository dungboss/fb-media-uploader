import { createHmac } from "node:crypto";

import {
  FacebookApiError,
  type MetaApiErrorPayload,
} from "@/lib/media-upload/facebook-error";
import { getFbTokenCredentials } from "@/lib/media-upload/token-store";
import { resilientFetch } from "@/lib/resilient-fetch";

// Re-exported so existing `import { FacebookApiError } from "@/app/api/audiences/meta"`
// call sites keep working after the type moved to its own module.
export { FacebookApiError };

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_FACEBOOK_API_VERSION = "v23.0";
const FACEBOOK_GRAPH_BASE_URL = "https://graph.facebook.com";

export type AudienceAvailability = "ready" | "populating";

export interface AudienceListItem {
  id: string;
  name: string;
  description: string;
  subtype: string;
  availability: AudienceAvailability;
  sizeUpperBound: number | null;
  sizeLowerBound: number | null;
  timeUpdated: string | null;
}

export interface AdAccountListItem {
  id: string; // act_<id> — use this for Graph API paths
  accountId: string; // numeric id without the act_ prefix
  name: string;
  accountStatus: number | null;
  currency: string | null;
}

interface FacebookCredentials {
  accessToken: string;
  apiVersion: string;
  // app secret backing the token; when present every call carries an
  // appsecret_proof. null when the token was stored without one.
  appSecret: string | null;
}

// Selects which access token a Meta call uses. `tokenId` references a stored
// (encrypted) token in Redis; `token` (+ optional `appSecret`) is a raw pair
// used only to validate a freshly-added token. All omitted → fall back to
// FACEBOOK_ACCESS_TOKEN in .env.
export interface FacebookCredentialOptions {
  tokenId?: string;
  token?: string;
  appSecret?: string;
}

interface MetaAudience {
  id: string;
  name?: string;
  description?: string;
  subtype?: string;
  time_updated?: string;
  approximate_count_upper_bound?: number | string;
  approximate_count_lower_bound?: number | string;
  operation_status?: MetaStatus;
  delivery_status?: MetaStatus;
}

interface MetaAudienceListResponse {
  data?: MetaAudience[];
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

interface MetaAudienceCreateResponse {
  id: string;
}

interface MetaAudienceUploadResponse {
  num_received?: number;
  num_invalid_entries?: number;
  session_id?: string;
}

interface MetaDeleteResponse {
  success?: boolean;
}

type MetaStatus =
  | string
  | {
      code?: number | string;
      description?: string;
      status?: string;
    }
  | null
  | undefined;

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

// Meta error #2650 "service error" on the custom-audience /users endpoint. Not a
// documented rate limit, but per our chosen policy we back off (wait) and resume
// the upload from where it stopped instead of failing the whole job.
export function isMetaServiceError(error: unknown) {
  return error instanceof FacebookApiError && error.details?.code === 2650;
}

export function validateHashedEmails(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new FacebookApiError(
      "Danh sách email đã băm không hợp lệ hoặc đang trống.",
      400
    );
  }

  const normalizedHashes = input.map((value) => String(value).trim().toLowerCase());
  const invalidHashes = normalizedHashes.filter((hash) => !HASH_PATTERN.test(hash));

  if (invalidHashes.length > 0) {
    throw new FacebookApiError(
      "Server chỉ chấp nhận chuỗi SHA-256 hợp lệ. Không gửi email plaintext lên API.",
      400
    );
  }

  return Array.from(new Set(normalizedHashes));
}

// Lists every ad account the access token can reach (Graph `me/adaccounts`),
// following pagination so accounts beyond the first page are included. Lets the
// UI offer a picker instead of hardcoding FACEBOOK_AD_ACCOUNT_ID in .env.
export async function listAdAccounts(
  options?: FacebookCredentialOptions
): Promise<AdAccountListItem[]> {
  const credentials = await resolveCredentials(options);
  const fields = ["account_id", "name", "account_status", "currency"].join(",");

  // First page goes through the shared helper (token + api version + parsing).
  let page = await facebookRequest<MetaAdAccountListResponse>(
    "me/adaccounts",
    {
      method: "GET",
      query: { fields, limit: "200" },
    },
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
    const proof = computeAppSecretProof(
      credentials.accessToken,
      credentials.appSecret
    );
    if (proof) {
      nextUrl.searchParams.set("appsecret_proof", proof);
    }

    const response = await resilientFetch(
      nextUrl,
      {
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
      { label: "meta-adaccounts" }
    );
    page = await parseFacebookResponse<MetaAdAccountListResponse>(response);
  }

  return items.sort((left, right) => left.name.localeCompare(right.name));
}

export async function listAudiences(
  options?: FacebookCredentialOptions & { adAccountId?: string }
): Promise<AudienceListItem[]> {
  const credentials = await resolveCredentials(options);
  const adAccountId = resolveAdAccountId(options?.adAccountId);
  const response = await facebookRequest<MetaAudienceListResponse>(
    `${adAccountId}/customaudiences`,
    {
      method: "GET",
      query: {
        fields: [
          "id",
          "name",
          "description",
          "subtype",
          "time_updated",
          "approximate_count_upper_bound",
          "approximate_count_lower_bound",
          "operation_status",
          "delivery_status",
        ].join(","),
        limit: "200",
      },
    },
    credentials
  );

  return (response.data ?? [])
    .map(mapAudience)
    .sort((left, right) => {
      const leftTime = left.timeUpdated ? new Date(left.timeUpdated).getTime() : 0;
      const rightTime = right.timeUpdated ? new Date(right.timeUpdated).getTime() : 0;
      return rightTime - leftTime;
    });
}

export async function createAudience(input: {
  name: string;
  description?: string;
  hashedEmails: unknown;
  adAccountId?: string;
  tokenId?: string;
}) {
  const name = input.name.trim();
  const hashedEmails = validateHashedEmails(input.hashedEmails);

  if (!name) {
    throw new FacebookApiError("Tên đối tượng là bắt buộc.", 400);
  }
  const createdAudience = await createEmptyAudience({
    name,
    description: input.description,
    adAccountId: input.adAccountId,
    tokenId: input.tokenId,
  });
  const uploadResult = await uploadHashedUsers(createdAudience.id, hashedEmails, {
    tokenId: input.tokenId,
  });

  return {
    audienceId: createdAudience.id,
    uploadedCount: uploadResult.num_received ?? hashedEmails.length,
    invalidEntryCount: uploadResult.num_invalid_entries ?? 0,
    sessionId: uploadResult.session_id ?? null,
  };
}

export async function addUsersToAudience(input: {
  audienceId: string;
  hashedEmails: unknown;
  tokenId?: string;
}) {
  const audienceId = input.audienceId.trim();
  const hashedEmails = validateHashedEmails(input.hashedEmails);

  if (!audienceId) {
    throw new FacebookApiError("Audience ID không hợp lệ.", 400);
  }

  const uploadResult = await uploadHashedUsers(audienceId, hashedEmails, {
    tokenId: input.tokenId,
  });

  return {
    audienceId,
    uploadedCount: uploadResult.num_received ?? hashedEmails.length,
    invalidEntryCount: uploadResult.num_invalid_entries ?? 0,
    sessionId: uploadResult.session_id ?? null,
  };
}

export async function createEmptyAudience(input: {
  name: string;
  description?: string;
  adAccountId?: string;
  tokenId?: string;
}) {
  const credentials = await resolveCredentials({ tokenId: input.tokenId });
  const adAccountId = resolveAdAccountId(input.adAccountId);
  const name = input.name.trim();
  const description = input.description?.trim() ?? "";

  if (!name) {
    throw new FacebookApiError("Tên đối tượng là bắt buộc.", 400);
  }

  const createFormData = new URLSearchParams();
  createFormData.set("name", name);
  createFormData.set("subtype", "CUSTOM");
  createFormData.set("customer_file_source", "USER_PROVIDED_ONLY");

  if (description) {
    createFormData.set("description", description);
  }

  const createdAudience = await facebookRequest<MetaAudienceCreateResponse>(
    `${adAccountId}/customaudiences`,
    {
      method: "POST",
      body: createFormData,
    },
    credentials
  );

  return {
    id: createdAudience.id,
  };
}

export async function uploadHashedUsers(
  audienceId: string,
  hashedEmails: unknown,
  options?: FacebookCredentialOptions
) {
  const normalizedAudienceId = audienceId.trim();
  const normalizedHashes = validateHashedEmails(hashedEmails);

  if (!normalizedAudienceId) {
    throw new FacebookApiError("Audience ID không hợp lệ.", 400);
  }

  const credentials = await resolveCredentials(options);
  return uploadAudienceUsers(normalizedAudienceId, normalizedHashes, credentials);
}

export async function deleteAudience(
  audienceId: string,
  options?: FacebookCredentialOptions
) {
  const normalizedAudienceId = audienceId.trim();

  if (!normalizedAudienceId) {
    throw new FacebookApiError("Audience ID không hợp lệ.", 400);
  }

  const credentials = await resolveCredentials(options);
  const response = await facebookRequest<MetaDeleteResponse>(
    normalizedAudienceId,
    {
      method: "DELETE",
    },
    credentials
  );

  return {
    audienceId: normalizedAudienceId,
    deleted: Boolean(response.success ?? true),
  };
}

function getApiVersion(): string {
  return (
    pickFirstDefinedEnv(["FACEBOOK_API_VERSION", "META_API_VERSION"]) ??
    DEFAULT_FACEBOOK_API_VERSION
  );
}

// True when a fallback token exists in .env (lets the UI offer it as an option).
export function hasEnvAccessToken(): boolean {
  return Boolean(
    pickFirstDefinedEnv([
      "FACEBOOK_ACCESS_TOKEN",
      "FB_ACCESS_TOKEN",
      "ACCESS_TOKEN",
    ])
  );
}

// Resolves the access token + app secret to use: a raw pair (validation) wins,
// then a stored token by id (decrypted from Redis), then the .env fallback
// token (which has no app secret). Throws when no token is available.
async function resolveTokenAndSecret(
  options?: FacebookCredentialOptions
): Promise<{ accessToken: string; appSecret: string | null }> {
  const rawToken = options?.token?.trim();
  if (rawToken) {
    return { accessToken: rawToken, appSecret: options?.appSecret?.trim() || null };
  }

  const tokenId = options?.tokenId?.trim();
  if (tokenId) {
    const credentials = await getFbTokenCredentials(tokenId);
    if (!credentials) {
      throw new FacebookApiError(
        "Access token đã chọn không còn tồn tại. Hãy chọn hoặc thêm token khác.",
        400
      );
    }
    return {
      accessToken: credentials.accessToken,
      appSecret: credentials.appSecret,
    };
  }

  const envToken = pickFirstDefinedEnv([
    "FACEBOOK_ACCESS_TOKEN",
    "FB_ACCESS_TOKEN",
    "ACCESS_TOKEN",
  ]);
  if (!envToken) {
    throw new FacebookApiError(
      "Chưa có access token. Hãy thêm token trong dashboard hoặc đặt FACEBOOK_ACCESS_TOKEN trong .env.",
      400
    );
  }
  return { accessToken: envToken, appSecret: null };
}

async function resolveCredentials(
  options?: FacebookCredentialOptions
): Promise<FacebookCredentials> {
  const { accessToken, appSecret } = await resolveTokenAndSecret(options);
  return {
    accessToken,
    appSecret,
    apiVersion: getApiVersion(),
  };
}

// Meta's appsecret_proof: HMAC-SHA256 of the access token keyed by the app
// secret. Required when the app enables "Require app secret"; harmless (and
// accepted) otherwise. Returns null when no app secret is configured.
function computeAppSecretProof(
  accessToken: string,
  appSecret: string | null
): string | null {
  if (!appSecret) {
    return null;
  }
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
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

  if (!raw) {
    return null;
  }

  return normalizeAdAccountId(raw);
}

// Resolves the ad account to act on: an explicit (user-selected) id wins,
// otherwise fall back to the .env default. Throws when neither is available.
function resolveAdAccountId(explicit?: string): string {
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

function normalizeAdAccountId(rawAdAccountId: string): string {
  const trimmed = rawAdAccountId.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function mapAdAccount(account: MetaAdAccount): AdAccountListItem | null {
  const accountId = (
    account.account_id ??
    account.id?.replace(/^act_/, "") ??
    ""
  ).trim();

  if (!accountId) {
    return null;
  }

  return {
    id: `act_${accountId}`,
    accountId,
    name: account.name?.trim() || `act_${accountId}`,
    accountStatus: toNullableNumber(account.account_status),
    currency: account.currency ?? null,
  };
}

async function facebookRequest<T>(
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

  return parseFacebookResponse<T>(response);
}

async function parseFacebookResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? tryParseJson(text) : {};

  if (!response.ok || hasMetaError(payload)) {
    const errorPayload = hasMetaError(payload) ? payload.error : undefined;
    const fallbackMessage = `Facebook API trả về lỗi ${response.status}.`;

    throw new FacebookApiError(
      formatMetaErrorMessage(errorPayload) ?? errorPayload?.message ?? fallbackMessage,
      response.status,
      errorPayload
    );
  }

  return payload as T;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FacebookApiError("Facebook API trả về dữ liệu không phải JSON.", 502);
  }
}

function hasMetaError(
  payload: unknown
): payload is {
  error: MetaApiErrorPayload;
} {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
  );
}

function formatMetaErrorMessage(errorPayload?: MetaApiErrorPayload) {
  if (!errorPayload) {
    return undefined;
  }

  if (errorPayload.code === 190) {
    const expirationDetail = extractTokenExpirationDetail(errorPayload.message);
    return [
      "Facebook access token da het han.",
      expirationDetail,
      "Hay tao token moi, cap nhat FACEBOOK_ACCESS_TOKEN trong .env.local, sau do khoi dong lai server Next.js.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return undefined;
}

function extractTokenExpirationDetail(message?: string) {
  if (!message) {
    return undefined;
  }

  const expiredOnMatch = message.match(/Session has expired on (.+?)\./i);
  const currentTimeMatch = message.match(/The current time is (.+?)\./i);

  if (!expiredOnMatch && !currentTimeMatch) {
    return undefined;
  }

  const details = [
    expiredOnMatch
      ? `Token cu het han vao ${expiredOnMatch[1]}.`
      : undefined,
    currentTimeMatch
      ? `Thoi diem Meta kiem tra la ${currentTimeMatch[1]}.`
      : undefined,
  ].filter(Boolean);

  return details.join(" ");
}

async function uploadAudienceUsers(
  audienceId: string,
  hashedEmails: string[],
  credentials: FacebookCredentials
): Promise<MetaAudienceUploadResponse> {
  const matrixPayload = {
    schema: ["EMAIL_SHA256"],
    data: hashedEmails.map((hash) => [hash]),
  };

  try {
    return await postUsersPayload(audienceId, matrixPayload, credentials);
  } catch (error) {
    if (
      error instanceof FacebookApiError &&
      /schema|payload|data/i.test(error.message)
    ) {
      return postUsersPayload(
        audienceId,
        {
          schema: "EMAIL_SHA256",
          data: hashedEmails,
        },
        credentials
      );
    }

    throw error;
  }
}

async function postUsersPayload(
  audienceId: string,
  payload:
    | {
        schema: string[];
        data: string[][];
      }
    | {
        schema: string;
        data: string[];
      },
  credentials: FacebookCredentials
): Promise<MetaAudienceUploadResponse> {
  const uploadFormData = new URLSearchParams();
  uploadFormData.set("payload", JSON.stringify(payload));

  return facebookRequest<MetaAudienceUploadResponse>(
    `${audienceId}/users`,
    {
      method: "POST",
      body: uploadFormData,
    },
    credentials
  );
}

function mapAudience(audience: MetaAudience): AudienceListItem {
  return {
    id: audience.id,
    name: audience.name?.trim() || "Untitled audience",
    description: audience.description?.trim() ?? "",
    subtype: audience.subtype ?? "CUSTOM",
    availability: deriveAvailability(audience),
    sizeUpperBound: toNullableNumber(audience.approximate_count_upper_bound),
    sizeLowerBound: toNullableNumber(audience.approximate_count_lower_bound),
    timeUpdated: audience.time_updated ?? null,
  };
}

function deriveAvailability(audience: MetaAudience): AudienceAvailability {
  const statusText = [
    normalizeMetaStatus(audience.operation_status),
    normalizeMetaStatus(audience.delivery_status),
  ]
    .join(" ")
    .toLowerCase();

  if (/\bready\b|available|active/.test(statusText)) {
    return "ready";
  }

  if (/populating|processing|building|pending/.test(statusText)) {
    return "populating";
  }

  return (toNullableNumber(audience.approximate_count_upper_bound) ?? 0) > 0
    ? "ready"
    : "populating";
}

function normalizeMetaStatus(status: MetaStatus) {
  if (!status) {
    return "";
  }

  if (typeof status === "string") {
    return status;
  }

  return [status.code, status.status, status.description]
    .filter(Boolean)
    .join(" ");
}

function toNullableNumber(value: number | string | undefined) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsedNumber = Number(value);
  return Number.isFinite(parsedNumber) ? parsedNumber : null;
}

function pickFirstDefinedEnv(variableNames: string[]) {
  for (const variableName of variableNames) {
    const value = process.env[variableName]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}
