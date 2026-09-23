"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, getErrorMessage } from "@/lib/media-upload/client-fetch";
import type { MediaUploadBatch, MediaUploadBatchCounts } from "@/lib/media-upload/types";

// Mirrors app/page.tsx's original JOB_POLL_INTERVAL_MS, now pointed at the
// batch list (~10 rows, O(1) counts) instead of the full job list.
const POLL_INTERVAL_MS = 2000;

export interface BatchListEntry {
  batch: MediaUploadBatch;
  counts: MediaUploadBatchCounts;
}

export interface CreateBatchInput {
  nasFolderPath: string;
  adAccountId: string;
  adAccountName?: string;
  appName?: string;
  tokenId?: string;
}

export interface CreateLocalBatchInput {
  files: File[];
  folderName: string;
  adAccountId: string;
  adAccountName?: string;
  appName?: string;
  tokenId?: string;
  onProgress?: (uploaded: number, total: number) => void;
}

export interface CreateBatchResponse {
  batch: MediaUploadBatch;
  counts: MediaUploadBatchCounts;
  skipped: Array<{ nasFilePath: string; reason: string }>;
}

// List + 2s active-only poll + create/retry/delete mutations, all against
// GET/POST /api/upload-batches and its sub-routes.
export function useUploadBatches() {
  const [entries, setEntries] = useState<BatchListEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Timestamp of the last successful sync — passed down to BatchCard instead
  // of it calling Date.now() during render (React 19's purity rule forbids
  // impure calls in the render body; this one happens inside the fetch
  // callback instead, which is not render).
  const [lastSyncedAt, setLastSyncedAt] = useState(0);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const payload = await fetchJson<{ batches?: BatchListEntry[] }>(
        "/api/upload-batches"
      );
      if (!isMountedRef.current) return;
      setEntries(payload.batches ?? []);
      setLastSyncedAt(Date.now());
      setError(null);
    } catch (err) {
      if (isMountedRef.current) {
        setError(getErrorMessage(err, "Không thể tải danh sách batch."));
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    // Wrapped in an inline async IIFE (rather than calling the `refresh`
    // callback directly) so the effect's own top-level statement is not a
    // direct call to a state-setting function — see the analogous mount
    // effects in use-fb-tokens.ts / use-ad-accounts.ts.
    void (async () => {
      await refresh();
    })();
    return () => {
      isMountedRef.current = false;
    };
  }, [refresh]);

  const hasActiveBatch = entries.some(
    ({ counts }) => counts.queued > 0 || counts.processing > 0
  );

  // Poll only while at least one batch is still draining — an overnight run
  // that already finished should not keep hitting the API forever (see
  // plan.md: "optimize for after-the-fact review, not realtime watching").
  useEffect(() => {
    if (!hasActiveBatch) return;

    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveBatch, refresh]);

  const createFromFolder = useCallback(
    async (input: CreateBatchInput) => {
      const response = await fetchJson<CreateBatchResponse>("/api/upload-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      await refresh();
      return response;
    },
    [refresh]
  );

  const createFromLocalFolder = useCallback(
    async (input: CreateLocalBatchInput) => {
      const sessionId = crypto.randomUUID();
      const staged: Array<{
        localFileRef: string;
        fileName: string;
        fileSize: number;
      }> = [];
      let nextIndex = 0;
      let uploaded = 0;
      let uploadError: unknown = null;

      try {
        // Two concurrent request bodies keep throughput reasonable without
        // multiplying the route's whole-file memory use by a large factor.
        const uploadOneByOne = async () => {
          while (!uploadError && nextIndex < input.files.length) {
            const file = input.files[nextIndex++];
            try {
              const form = new FormData();
              form.set("sessionId", sessionId);
              form.set("file", file, file.name);

              const result = await fetchJson<{
                localFileRef: string;
                fileName: string;
                fileSize: number;
              }>("/api/local-uploads", { method: "POST", body: form });
              staged.push(result);
              uploaded += 1;
              input.onProgress?.(uploaded, input.files.length);
            } catch (error) {
              uploadError = error;
            }
          }
        };

        await Promise.all([uploadOneByOne(), uploadOneByOne()]);
        if (uploadError) throw uploadError;

        const response = await fetchJson<CreateBatchResponse>("/api/upload-batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            localFiles: staged,
            localFolderName: input.folderName,
            localUploadSessionId: sessionId,
            adAccountId: input.adAccountId,
            adAccountName: input.adAccountName,
            appName: input.appName,
            tokenId: input.tokenId,
          }),
        });
        await refresh();
        return response;
      } catch (error) {
        await fetch(`/api/local-uploads?sessionId=${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }).catch(() => {});
        throw error;
      }
    },
    [refresh]
  );

  const retryFailed = useCallback(
    async (batchId: string) => {
      const response = await fetchJson<{ retried?: number }>(
        `/api/upload-batches/${batchId}/retry-failed`,
        { method: "POST" }
      );
      await refresh();
      return response.retried ?? 0;
    },
    [refresh]
  );

  const deleteBatch = useCallback(
    async (batchId: string) => {
      await fetchJson(`/api/upload-batches/${batchId}`, { method: "DELETE" });
      await refresh();
    },
    [refresh]
  );

  return {
    entries,
    isLoading,
    error,
    lastSyncedAt,
    refresh,
    createFromFolder,
    createFromLocalFolder,
    retryFailed,
    deleteBatch,
  };
}
