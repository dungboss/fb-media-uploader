import { NextResponse } from "next/server";

import { getBatch, getBatchStatusSetKey } from "@/lib/media-upload/batches";
import { FacebookApiError } from "@/lib/media-upload/facebook-error";
import { transitionJobStatus } from "@/lib/media-upload/jobs";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import { enqueueMediaUploadJobs, removeMediaUploadJob } from "@/lib/media-upload/queue";

import { collectSetMembers } from "../../collect-set-members";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Re-enqueues every failed job in a batch. Drops each job's stale BullMQ
// entry FIRST — enqueueMediaUploadJobs early-returns an existing entry with
// the same id, so a lingering one would silently no-op that job's retry
// (same trap as the single-job retry route) — then flips each back to
// "queued", then ONE addBulk covers the whole cohort.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await params;
    const batch = await getBatch(batchId);

    if (!batch) {
      throw new FacebookApiError("Không tìm thấy batch.", 404);
    }

    const failedJobIds = await collectSetMembers(getBatchStatusSetKey(batchId, "failed"));

    if (failedJobIds.length === 0) {
      return NextResponse.json({ retried: 0 });
    }

    await Promise.all(
      failedJobIds.map((jobId) => removeMediaUploadJob(jobId).catch(() => {}))
    );
    await Promise.all(
      failedJobIds.map((jobId) =>
        transitionJobStatus(jobId, "queued", {
          errorMessage: "",
          nextRetryAt: null,
          imageHash: null,
        })
      )
    );
    await enqueueMediaUploadJobs(failedJobIds);

    return NextResponse.json({ retried: failedJobIds.length });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể thử lại các job lỗi.");

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}
