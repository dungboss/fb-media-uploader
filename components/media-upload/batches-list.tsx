"use client";

import { Loader2, PackageOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AdAccount } from "@/hooks/use-ad-accounts";
import type { BatchListEntry } from "@/hooks/use-upload-batches";
import { formatNumber } from "@/lib/media-upload/format";

import { BatchCard } from "./batch-card";

interface BatchesListProps {
  entries: BatchListEntry[];
  isLoading: boolean;
  error: string | null;
  adAccounts: AdAccount[];
  nowMs: number;
  retryingBatchId: string | null;
  deletingBatchId: string | null;
  onOpenJobs: (batchId: string) => void;
  onRetryFailed: (batchId: string) => void;
  onDelete: (batchId: string) => void;
}

// The batch-centric dashboard's main list: cards, not rows — the unit of
// attention is the batch (plan.md). Empty/loading states + the reassurance
// that a batch survives a closed browser tab.
export function BatchesList({
  entries,
  isLoading,
  error,
  adAccounts,
  nowMs,
  retryingBatchId,
  deletingBatchId,
  onOpenJobs,
  onRetryFailed,
  onDelete,
}: BatchesListProps) {
  return (
    <Card className="rounded-[28px] border-white/60 bg-white/85 shadow-lg shadow-slate-950/5 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          Batch upload
          {!isLoading ? <Badge variant="secondary">{formatNumber(entries.length)}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {error}
          </p>
        ) : null}

        {isLoading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Đang tải...
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border bg-muted/40">
              <PackageOpen className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Chưa có batch nào.</p>
              <p className="text-sm text-muted-foreground">
                Chọn một thư mục ảnh trên NAS ở trên để bắt đầu upload.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              {entries.map(({ batch, counts }) => (
                <BatchCard
                  key={batch.id}
                  batch={batch}
                  counts={counts}
                  adAccounts={adAccounts}
                  nowMs={nowMs}
                  isRetrying={retryingBatchId === batch.id}
                  isDeleting={deletingBatchId === batch.id}
                  onOpenJobs={() => onOpenJobs(batch.id)}
                  onRetryFailed={() => onRetryFailed(batch.id)}
                  onDelete={() => onDelete(batch.id)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Đóng tab vẫn chạy tiếp — batch xử lý trên server, danh sách sẽ tự cập nhật khi
              bạn quay lại.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
