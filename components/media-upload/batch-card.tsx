"use client";

import { useState } from "react";
import { Download, Loader2, RotateCcw, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { AdAccount } from "@/hooks/use-ad-accounts";
import { formatEta, formatNumber } from "@/lib/media-upload/format";
import type { MediaUploadBatch, MediaUploadBatchCounts } from "@/lib/media-upload/types";

import { DevTierCallout } from "./dev-tier-callout";

// Hide the ETA until the observed rate has enough samples to be worth
// showing (locked decision: early rates on a fresh batch are noise).
const MIN_COMPLETIONS_FOR_ETA = 20;

interface BatchCardProps {
  batch: MediaUploadBatch;
  counts: MediaUploadBatchCounts;
  adAccounts: AdAccount[];
  // Timestamp of the last successful batch-list sync, supplied by the
  // parent (captured outside render, in the fetch callback) rather than
  // this component calling Date.now() itself — React 19's purity rule
  // forbids impure calls in the render body.
  nowMs: number;
  isRetrying: boolean;
  isDeleting: boolean;
  onOpenJobs: () => void;
  onRetryFailed: () => void;
  onDelete: () => void;
}

// One batch's progress, counts, ETA and actions — the unit of attention per
// plan.md ("3200/5000 · 12 failed · ~2h left", not 5000 rows).
export function BatchCard({
  batch,
  counts,
  adAccounts,
  nowMs,
  isRetrying,
  isDeleting,
  onOpenJobs,
  onRetryFailed,
  onDelete,
}: BatchCardProps) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const total = batch.total;
  const doneCount = counts.completed + counts.failed + counts.cancelled;
  const progressPct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const remaining = counts.queued + counts.processing;
  const isActive = remaining > 0;

  // Client-side, deliberately crude: remaining / (completed / elapsed).
  // Recomputed whenever the batch list re-syncs (nowMs advances) — no extra timer.
  const elapsedMs = nowMs > 0 ? nowMs - new Date(batch.createdAt).getTime() : 0;
  const rate = elapsedMs > 0 ? counts.completed / elapsedMs : 0;
  const etaMs = rate > 0 ? remaining / rate : null;
  const showEta =
    counts.completed >= MIN_COMPLETIONS_FOR_ETA && etaMs !== null && Number.isFinite(etaMs);

  const account = adAccounts.find((a) => a.id === batch.adAccountId);
  const isDevTier = account?.tier === "development_access";

  return (
    <div className="space-y-3 rounded-2xl border bg-white/70 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold" title={batch.nasFolderPath ?? undefined}>
            {batch.nasFolderPath ?? "Batch upload"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {batch.adAccountName || batch.adAccountId || "—"}
            {batch.appName ? ` · ${batch.appName}` : ""}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onOpenJobs}>
          Xem chi tiết
        </Button>
      </div>

      <div>
        <Progress value={progressPct} className="h-2" />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-slate-700">
            {formatNumber(doneCount)}/{formatNumber(total)}
          </span>
          {counts.failed > 0 ? (
            <span className="font-medium text-destructive">
              {formatNumber(counts.failed)} lỗi
            </span>
          ) : null}
          {showEta ? (
            <span>Còn lại {formatEta(etaMs as number)} (ước tính)</span>
          ) : isActive ? (
            <span>Đang tính ước tính...</span>
          ) : null}
        </div>
      </div>

      {isDevTier && isActive ? <DevTierCallout compact /> : null}

      <div className="flex items-center gap-2">
        {counts.failed > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetryFailed}
            disabled={isRetrying}
          >
            {isRetrying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            Thử lại {formatNumber(counts.failed)} lỗi
          </Button>
        ) : null}
        {doneCount > 0 ? (
          // A plain <a>, not a fetch+blob: the export streams, so letting the
          // browser own the download keeps memory flat on a 10k-row batch and
          // gives a real progress indicator for free. Styled via
          // buttonVariants because Button wraps a base-ui primitive with no
          // asChild escape hatch.
          <a
            href={`/api/upload-batches/${batch.id}/export`}
            download
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Download className="size-3.5" />
            Tải CSV
          </a>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setIsConfirmOpen(true)}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          Xoá
        </Button>
      </div>

      <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá batch này?</AlertDialogTitle>
            <AlertDialogDescription>
              {isActive
                ? "Batch đang chạy — worker sẽ dừng xử lý các job còn lại. "
                : ""}
              Toàn bộ dữ liệu batch (job, tiến độ) sẽ bị xoá vĩnh viễn khỏi hệ thống. Ảnh
              đã upload lên Meta không bị ảnh hưởng. Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Không, giữ lại</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setIsConfirmOpen(false);
                onDelete();
              }}
            >
              <Trash2 className="size-4" />
              Xoá vĩnh viễn
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
