"use client";

import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatCountdown, formatFileSize } from "@/lib/media-upload/format";
import type { MediaUploadJob } from "@/lib/media-upload/types";

import { JobStatusBadge } from "./job-status-badge";

interface JobRowProps {
  job: MediaUploadJob;
  isRetrying: boolean;
  onRetry: () => void;
}

// One row in the batch drill-in: thumbnail, hash, Meta's error verbatim
// (the only way to diagnose an oversize image), and a per-row retry.
export function JobRow({ job, isRetrying, onRetry }: JobRowProps) {
  const canRetry = job.status === "failed";
  const countdown =
    job.status === "queued" && job.nextRetryAt ? formatCountdown(job.nextRetryAt) : null;

  return (
    <div className="flex items-center gap-3 rounded-xl border bg-white/60 p-3">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
        {job.previewUrl ? (
          // Meta-hosted 128px thumbnail. Plain <img> instead of next/image:
          // a remote-pattern config for platform-lookaside.fbsbx.com isn't
          // worth it for a small thumbnail shown only on completed rows,
          // capped at ~50 per page (YAGNI).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={job.previewUrl}
            alt={job.fileName}
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <span className="text-[10px] text-muted-foreground">Ảnh</span>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium" title={job.nasFilePath}>
          {job.fileName}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <JobStatusBadge status={job.status} />
          {job.fileSize ? (
            <span className="text-xs text-muted-foreground">{formatFileSize(job.fileSize)}</span>
          ) : null}
          {job.imageHash ? (
            <span
              className="max-w-40 truncate font-mono text-xs text-muted-foreground"
              title={job.imageHash}
            >
              {job.imageHash}
            </span>
          ) : null}
        </div>
        {job.status === "failed" && job.errorMessage ? (
          <p className="text-xs text-destructive">{job.errorMessage}</p>
        ) : null}
        {countdown ? <p className="text-xs text-amber-700">{countdown}</p> : null}
      </div>

      {canRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          Thử lại
        </Button>
      ) : null}
    </div>
  );
}
