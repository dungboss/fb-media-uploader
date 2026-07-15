// Turns a raw Meta Graph error body into a Vietnamese, user-facing message
// (or undefined when no special-cased message applies — the caller then
// falls back to Meta's own `message`). Split out of meta-graph.ts purely to
// keep that file under the 200-line guideline.

import type { MetaApiErrorPayload } from "./facebook-error";

export function hasMetaError(
  payload: unknown
): payload is { error: MetaApiErrorPayload } {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
  );
}

export function formatMetaErrorMessage(errorPayload?: MetaApiErrorPayload) {
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
    expiredOnMatch ? `Token cu het han vao ${expiredOnMatch[1]}.` : undefined,
    currentTimeMatch ? `Thoi diem Meta kiem tra la ${currentTimeMatch[1]}.` : undefined,
  ].filter(Boolean);

  return details.join(" ");
}
