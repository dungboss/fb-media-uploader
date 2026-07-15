// Redis hash <-> MediaUploadBatch (de)serialization. Split out of batches.ts
// purely to keep that file under the 200-line guideline.

import type { MediaUploadBatch } from "./types";

export function toBatchHashPatch(batch: MediaUploadBatch): Record<string, string> {
  return {
    id: batch.id,
    nasFolderPath: batch.nasFolderPath ?? "",
    total: String(batch.total),
    adAccountId: batch.adAccountId ?? "",
    adAccountName: batch.adAccountName ?? "",
    appName: batch.appName ?? "",
    tokenId: batch.tokenId ?? "",
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

export function parseBatchPayload(
  batchId: string,
  payload: Record<string, string>
): MediaUploadBatch {
  return {
    id: batchId,
    nasFolderPath: payload.nasFolderPath || null,
    total: Number.parseInt(payload.total ?? "0", 10) || 0,
    adAccountId: payload.adAccountId || null,
    adAccountName: payload.adAccountName || null,
    appName: payload.appName || null,
    tokenId: payload.tokenId || null,
    createdAt: payload.createdAt ?? new Date(0).toISOString(),
    updatedAt: payload.updatedAt ?? new Date(0).toISOString(),
  };
}
