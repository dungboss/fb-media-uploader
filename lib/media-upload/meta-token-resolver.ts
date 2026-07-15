// Resolves which Facebook access token + app secret a Meta call uses, and
// computes the appsecret_proof that goes with it. Split out of
// meta-graph.ts purely to keep that file under the 200-line guideline.

import { createHmac } from "node:crypto";

import { FacebookApiError } from "./facebook-error";
import { getFbTokenCredentials } from "./token-store";

export const DEFAULT_FACEBOOK_API_VERSION = "v23.0";

// Selects which access token a Meta call uses. `tokenId` references a stored
// (encrypted) token in Redis; `token` (+ optional `appSecret`) is a raw pair
// used only to validate a freshly-added token. All omitted → fall back to
// FACEBOOK_ACCESS_TOKEN in .env.
export interface FacebookCredentialOptions {
  tokenId?: string;
  token?: string;
  appSecret?: string;
}

export interface FacebookCredentials {
  accessToken: string;
  apiVersion: string;
  // app secret backing the token; when present every call carries an
  // appsecret_proof. null when the token was stored without one.
  appSecret: string | null;
}

export async function resolveCredentials(
  options?: FacebookCredentialOptions
): Promise<FacebookCredentials> {
  const { accessToken, appSecret } = await resolveTokenAndSecret(options);
  return {
    accessToken,
    appSecret,
    apiVersion: getApiVersion(),
  };
}

// Resolves the access token + app secret to use: a raw pair (validation)
// wins, then a stored token by id (decrypted from Redis), then the .env
// fallback token (which has no app secret). Throws when none is available.
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

function getApiVersion(): string {
  return (
    pickFirstDefinedEnv(["FACEBOOK_API_VERSION", "META_API_VERSION"]) ??
    DEFAULT_FACEBOOK_API_VERSION
  );
}

export function pickFirstDefinedEnv(variableNames: string[]) {
  for (const variableName of variableNames) {
    const value = process.env[variableName]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

// Meta's appsecret_proof: HMAC-SHA256 of the access token keyed by the app
// secret. Required when the app enables "Require app secret"; harmless (and
// accepted) otherwise. Returns null when no app secret is configured.
export function computeAppSecretProof(
  accessToken: string,
  appSecret: string | null
): string | null {
  if (!appSecret) {
    return null;
  }
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}
