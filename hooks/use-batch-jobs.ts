"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchJson, getErrorMessage } from "@/lib/media-upload/client-fetch";
import type { MediaUploadJob, MediaUploadJobStatus } from "@/lib/media-upload/types";

function pageKeyFor(batchId: string | null, status: MediaUploadJobStatus | undefined) {
  return `${batchId ?? ""}:${status ?? ""}`;
}

// Paged rows for one batch's drill-in dialog: GET
// /api/upload-batches/[batchId]/jobs?status=&cursor=. Resets and refetches
// whenever batchId or status changes; "tải thêm" appends and de-dupes by id
// (the underlying SSCAN cursor can repeat ids across pages).
export function useBatchJobs(batchId: string | null, status: MediaUploadJobStatus | undefined) {
  const [jobs, setJobs] = useState<MediaUploadJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Reset paging state during render when batchId/status changes, instead of
  // in an effect (React's "adjusting state when a prop changes" pattern —
  // avoids the extra render + the set-state-in-effect lint rule). The actual
  // network fetch stays in the effect below; fetchPage(null, false) resets
  // seenIdsRef itself (a fresh Set on the non-append path), so this block
  // only needs to touch state, never the ref directly (refs can't be
  // mutated during render).
  const [pageKey, setPageKey] = useState(() => pageKeyFor(batchId, status));
  const nextPageKey = pageKeyFor(batchId, status);
  if (nextPageKey !== pageKey) {
    setPageKey(nextPageKey);
    setJobs([]);
    setCursor(null);
    setHasMore(false);
  }

  const fetchPage = useCallback(
    async (cursorParam: string | null, append: boolean) => {
      if (!batchId) return;

      if (append) setIsLoadingMore(true);
      else setIsLoading(true);

      try {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        if (cursorParam) params.set("cursor", cursorParam);

        const payload = await fetchJson<{
          jobs?: MediaUploadJob[];
          nextCursor?: string | null;
        }>(`/api/upload-batches/${batchId}/jobs?${params.toString()}`);
        const incoming = payload.jobs ?? [];

        setJobs((previous) => {
          const base = append ? previous : [];
          const seen = append ? seenIdsRef.current : new Set<string>();
          const merged = [...base];

          for (const job of incoming) {
            if (seen.has(job.id)) continue;
            seen.add(job.id);
            merged.push(job);
          }

          seenIdsRef.current = seen;
          return merged;
        });

        setCursor(payload.nextCursor ?? null);
        setHasMore(Boolean(payload.nextCursor));
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err, "Không thể tải danh sách job của batch."));
      } finally {
        if (append) setIsLoadingMore(false);
        else setIsLoading(false);
      }
    },
    [batchId, status]
  );

  useEffect(() => {
    if (!batchId) return;
    // Inline IIFE rather than calling `fetchPage` directly at the effect's
    // top level — see the analogous mount effect in use-upload-batches.ts.
    void (async () => {
      await fetchPage(null, false);
    })();
  }, [pageKey, batchId, fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    void fetchPage(cursor, true);
  }, [cursor, hasMore, isLoadingMore, fetchPage]);

  const refresh = useCallback(() => {
    seenIdsRef.current = new Set();
    void fetchPage(null, false);
  }, [fetchPage]);

  return { jobs, isLoading, isLoadingMore, hasMore, error, loadMore, refresh };
}
