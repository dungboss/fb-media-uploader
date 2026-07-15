import { NextResponse } from "next/server";

import {
  deleteBatch,
  getBatch,
  getBatchCounts,
  getBatchStatusSetKey,
} from "@/lib/media-upload/batches";
import { FacebookApiError } from "@/lib/media-upload/facebook-error";
import { transitionJobStatus } from "@/lib/media-upload/jobs";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import { removeMediaUploadJob } from "@/lib/media-upload/queue";

import { collectSetMembers } from "../collect-set-members";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await params;
    const batch = await getBatch(batchId);

    if (!batch) {
      throw new FacebookApiError("Không tìm thấy batch.", 404);
    }

    const counts = await getBatchCounts(batchId);

    return NextResponse.json({ batch, counts });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể tải batch.");

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}

// Cancels every non-terminal job (worker stops cooperatively), best-effort
// removes them from BullMQ, then purges the batch's Redis keys entirely.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await params;
    const batch = await getBatch(batchId);

    if (!batch) {
      throw new FacebookApiError("Không tìm thấy batch.", 404);
    }

    await cancelNonTerminalJobs(batchId);
    await deleteBatch(batchId);

    return NextResponse.json({ id: batchId, deleted: true });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể xoá batch.");

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}

async function cancelNonTerminalJobs(batchId: string) {
  const jobIds = [
    ...(await collectSetMembers(getBatchStatusSetKey(batchId, "queued"))),
    ...(await collectSetMembers(getBatchStatusSetKey(batchId, "processing"))),
  ];

  await Promise.all(
    jobIds.map(async (jobId) => {
      await transitionJobStatus(jobId, "cancelled");
      await removeMediaUploadJob(jobId).catch(() => {});
    })
  );
}
