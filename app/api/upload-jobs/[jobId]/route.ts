import { NextResponse } from "next/server";

import { getClientSafeError } from "@/app/api/audiences/meta";
import {
  cancelMediaUploadJob,
  deleteMediaUploadJob,
  getMediaUploadJob,
} from "@/lib/media-upload/jobs";
import { removeMediaUploadJob } from "@/lib/media-upload/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const job = await getMediaUploadJob(jobId);

    return NextResponse.json({ job });
  } catch (error) {
    const safeError = getClientSafeError(
      error,
      "Không thể tải trạng thái upload job."
    );

    return NextResponse.json(
      {
        error: safeError.message,
        details: safeError.details,
      },
      {
        status: safeError.status,
      }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const existing = await getMediaUploadJob(jobId);

    // Active job → cancel (worker stops cooperatively, queue entry removed).
    if (existing.status === "queued" || existing.status === "processing") {
      const job = await cancelMediaUploadJob(jobId);
      await removeMediaUploadJob(jobId);
      return NextResponse.json({ job });
    }

    // Terminal job (failed/completed/cancelled) → remove it from the list.
    await removeMediaUploadJob(jobId).catch(() => {});
    const result = await deleteMediaUploadJob(jobId);
    return NextResponse.json(result);
  } catch (error) {
    const safeError = getClientSafeError(
      error,
      "Không thể huỷ hoặc xoá upload job."
    );

    return NextResponse.json(
      {
        error: safeError.message,
        details: safeError.details,
      },
      {
        status: safeError.status,
      }
    );
  }
}