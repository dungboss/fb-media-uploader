import { NextResponse } from "next/server";

import { FacebookApiError } from "@/lib/media-upload/facebook-error";
import { getMediaUploadJob, transitionJobStatus } from "@/lib/media-upload/jobs";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import { enqueueMediaUploadJob, removeMediaUploadJob } from "@/lib/media-upload/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Re-enqueues one job (whole-image re-upload — no byte-offset cloning, see
// the deleted resume/route.ts). Order matters: enqueueMediaUploadJob
// early-returns an existing BullMQ entry with the same id, so a lingering
// entry from the prior attempt must be removed BEFORE the queued transition
// + re-add, or the retry silently no-ops.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const existing = await getMediaUploadJob(jobId);

    if (existing.status === "queued" || existing.status === "processing") {
      throw new FacebookApiError(
        "Job đang chạy, không thể thử lại. Hãy huỷ trước nếu muốn thử lại.",
        400
      );
    }

    await removeMediaUploadJob(jobId);
    const job = await transitionJobStatus(jobId, "queued", {
      errorMessage: "",
      nextRetryAt: null,
      imageHash: null,
    });
    await enqueueMediaUploadJob(jobId);

    return NextResponse.json({ job });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể thử lại upload job.");

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}
