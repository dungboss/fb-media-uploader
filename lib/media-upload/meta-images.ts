// The `adimages` upload — one image per call. Meta dedupes by content, so a
// retried upload of identical bytes returns the same hash (idempotent).

import { FacebookApiError } from "./facebook-error";
import { facebookRequest } from "./meta-graph";
import { resolveAdAccountId } from "./meta-ad-accounts";
import { resolveCredentials } from "./meta-token-resolver";

export interface AdImageUploadResult {
  hash: string;
  url: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
}

interface AdImageResponseEntry {
  hash?: unknown;
  url?: unknown;
  url_128?: unknown;
  width?: unknown;
  height?: unknown;
}

// Field name lands in a multipart Content-Disposition header — sanitize to
// ASCII so a NAS filename with quotes/newlines/unicode can't break the
// boundary or inject a header. The real filename still goes through as the
// Blob's third (filename) argument.
const UNSAFE_FIELD_NAME_CHARS = /[^A-Za-z0-9._-]/g;
const FALLBACK_FIELD_NAME = "image.jpg";

function sanitizeFieldName(fileName: string): string {
  const sanitized = fileName.replace(UNSAFE_FIELD_NAME_CHARS, "_");
  return sanitized || FALLBACK_FIELD_NAME;
}

export async function uploadAdImage(input: {
  bytes: ArrayBuffer;
  fileName: string;
  contentType?: string | null;
  adAccountId?: string;
  tokenId?: string;
}): Promise<AdImageUploadResult> {
  const credentials = await resolveCredentials({ tokenId: input.tokenId });
  const adAccountId = resolveAdAccountId(input.adAccountId);
  const fieldName = sanitizeFieldName(input.fileName);

  const form = new FormData();
  form.append(
    fieldName,
    new Blob([input.bytes], { type: input.contentType || "application/octet-stream" }),
    input.fileName
  );

  // No Content-Type header on the request — fetch must choose the multipart
  // boundary itself (facebookRequest already enforces this).
  const payload = await facebookRequest<unknown>(
    `${adAccountId}/adimages`,
    { method: "POST", body: form },
    credentials
  );

  return parseAdImageResponse(payload, fieldName);
}

// Meta's live response nests the uploaded image under `images.<field_name>`
// (verified 2026-07-16 by a real POST — see plan.md risk #1: the research
// report's flat `{hash,url,...}` shape was WRONG for this edge). Meta could
// plausibly change either way, so this parser tolerates three shapes, tried
// in order:
//   1. `images[fieldName]`     — the shape actually observed live
//   2. `images[<first key>]`   — fieldName came back renamed/mismatched
//   3. the payload itself      — flat, the shape the (wrong) report claimed
// No usable `hash` after all three → the response is unusable: throw a 502
// rather than let `undefined.hash` reach a caller silently.
export function parseAdImageResponse(
  payload: unknown,
  fieldName: string
): AdImageUploadResult {
  const entry = pickImageEntry(payload, fieldName);
  const hash = entry && typeof entry.hash === "string" ? entry.hash : null;

  if (!entry || !hash) {
    throw new FacebookApiError("Meta không trả về image hash.", 502);
  }

  return {
    hash,
    url: typeof entry.url === "string" ? entry.url : null,
    previewUrl: typeof entry.url_128 === "string" ? entry.url_128 : null,
    width: toNullableNumber(entry.width),
    height: toNullableNumber(entry.height),
  };
}

function pickImageEntry(
  payload: unknown,
  fieldName: string
): AdImageResponseEntry | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const images = (payload as { images?: unknown }).images;
  if (images && typeof images === "object") {
    const byFieldName = (images as Record<string, unknown>)[fieldName];
    if (byFieldName && typeof byFieldName === "object") {
      return byFieldName as AdImageResponseEntry;
    }

    const firstKey = Object.keys(images).at(0);
    const byFirstKey = firstKey ? (images as Record<string, unknown>)[firstKey] : undefined;
    return byFirstKey && typeof byFirstKey === "object"
      ? (byFirstKey as AdImageResponseEntry)
      : null;
  }

  // No `images` wrapper — treat the payload itself as the flat shape.
  return payload as AdImageResponseEntry;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
