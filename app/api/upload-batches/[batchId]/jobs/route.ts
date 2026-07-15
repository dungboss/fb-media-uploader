import { NextResponse } from "next/server";

import { listBatchJobIds } from "@/lib/media-upload/batches";
import { FacebookApiError } from "@/lib/media-upload/facebook-error";
import { getMediaUploadJobs } from "@/lib/media-upload/jobs";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import {
  MEDIA_UPLOAD_JOB_STATUSES,
  type MediaUploadJobStatus,
} from "@/lib/media-upload/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Paged, server-filtered job rows for a batch drill-in. Never returns the
// whole batch at once — the 2s poll hits GET /api/upload-batches instead;
// this is the on-demand "show me the rows" half of the split contract.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await params;
    const url = new URL(request.url);

    const status = parseStatus(url.searchParams.get("status"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = parseLimit(url.searchParams.get("limit"));

    const { jobIds, nextCursor } = await listBatchJobIds({
      batchId,
      status,
      cursor,
      limit,
    });
    const jobs = await getMediaUploadJobs(jobIds);

    return NextResponse.json(
      { jobs, nextCursor },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const safeError = getClientSafeError(
      error,
      "Không thể tải danh sách job của batch."
    );

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}

function parseStatus(raw: string | null): MediaUploadJobStatus | undefined {
  if (!raw) {
    return undefined;
  }

  if (!(MEDIA_UPLOAD_JOB_STATUSES as readonly string[]).includes(raw)) {
    throw new FacebookApiError(
      `Trạng thái không hợp lệ. Chỉ chấp nhận: ${MEDIA_UPLOAD_JOB_STATUSES.join(", ")}.`,
      400
    );
  }

  return raw as MediaUploadJobStatus;
}

function parseLimit(raw: string | null): number {
  if (!raw) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}
