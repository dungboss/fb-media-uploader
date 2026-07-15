"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBatchJobs } from "@/hooks/use-batch-jobs";
import type { MediaUploadJobStatus } from "@/lib/media-upload/types";

import { JobRow } from "./job-row";

interface BatchJobsDialogProps {
  batchId: string | null;
  batchLabel: string | null;
  onClose: () => void;
  // Lets the batch list refresh its counts immediately after a retry,
  // instead of waiting up to 2s for the next poll.
  onJobRetried?: () => void;
}

// Status filter tabs — failed is the default (locked decision: "failed-first
// paging matters more than live progress").
const STATUS_TABS: Array<{ value: MediaUploadJobStatus | "all"; label: string }> = [
  { value: "failed", label: "Lỗi" },
  { value: "all", label: "Tất cả" },
  { value: "queued", label: "Đang chờ" },
  { value: "processing", label: "Đang xử lý" },
  { value: "completed", label: "Hoàn tất" },
  { value: "cancelled", label: "Đã huỷ" },
];

// Batch drill-in: status filter + cursor-paged rows. Never fetches the whole
// batch at once — GET .../jobs is capped at 50-200 rows per page.
export function BatchJobsDialog({
  batchId,
  batchLabel,
  onClose,
  onJobRetried,
}: BatchJobsDialogProps) {
  const [statusTab, setStatusTab] = useState<MediaUploadJobStatus | "all">("failed");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Reset the filter back to "failed" whenever a different batch opens —
  // adjusted during render (React's recommended pattern) rather than in an
  // effect, so switching batches never flashes the previous filter's rows.
  const [resetForBatchId, setResetForBatchId] = useState(batchId);
  if (batchId !== resetForBatchId) {
    setResetForBatchId(batchId);
    setStatusTab("failed");
  }

  const status = statusTab === "all" ? undefined : statusTab;
  const { jobs, isLoading, isLoadingMore, hasMore, error, loadMore, refresh } = useBatchJobs(
    batchId,
    status
  );

  async function handleRetryRow(jobId: string) {
    setRetryingId(jobId);
    try {
      const response = await fetch(`/api/upload-jobs/${jobId}/retry`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Không thể thử lại job.");
      }
      toast.success("Đã đưa job vào hàng đợi thử lại.");
      refresh();
      onJobRetried?.();
    } catch (error) {
      toast.error("Thử lại thất bại.", {
        description: error instanceof Error ? error.message : "Không thể thử lại job.",
      });
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <Dialog open={batchId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl overflow-hidden p-0">
        <div className="flex max-h-[85vh] flex-col">
          <DialogHeader className="border-b border-border/70 px-6 pt-6 pb-4">
            <DialogTitle>Chi tiết batch</DialogTitle>
            <DialogDescription className="truncate">{batchLabel ?? ""}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2 border-b border-border/70 px-6 py-3">
            {STATUS_TABS.map((tab) => (
              <Button
                key={tab.value}
                type="button"
                size="sm"
                variant={statusTab === tab.value ? "default" : "outline"}
                onClick={() => setStatusTab(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {error ? (
              <p className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                {error}
              </p>
            ) : null}

            {isLoading && jobs.length === 0 ? (
              <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Đang tải...
              </div>
            ) : jobs.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Không có job nào ở trạng thái này.
              </p>
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    isRetrying={retryingId === job.id}
                    onRetry={() => handleRetryRow(job.id)}
                  />
                ))}
              </div>
            )}

            {hasMore ? (
              <div className="pt-3 text-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Tải thêm
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
