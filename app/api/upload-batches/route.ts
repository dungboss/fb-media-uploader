import { NextResponse } from "next/server";

import { listRecentBatches } from "@/lib/media-upload/batches";
import { createMediaUploadJobs } from "@/lib/media-upload/jobs";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import { enqueueMediaUploadJobs } from "@/lib/media-upload/queue";
import type { MediaUploadBatchCounts } from "@/lib/media-upload/types";

import { getCountsForBatches } from "./batch-counts";
import { resolveBatchFiles, type CreateBatchRequestBody } from "./batch-intake";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Creates a batch from a NAS folder (server-side PROPFIND enumeration) or an
// explicit file list (<=500), then enqueues every job in ONE BullMQ addBulk.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateBatchRequestBody;
    const { files, nasFolderPath, accountMeta } = await resolveBatchFiles(body);

    const { batch, jobs, skipped } = await createMediaUploadJobs({
      files,
      nasFolderPath,
      ...accountMeta,
    });

    await enqueueMediaUploadJobs(jobs.map((job) => job.id));

    // Known at creation time (every accepted file just became "queued") —
    // computing this directly avoids both a Redis round trip AND a race
    // against the worker, which could already be processing job 0 by the
    // time a post-enqueue SCARD would run.
    const counts: MediaUploadBatchCounts = {
      queued: jobs.length,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    return NextResponse.json({ batch, counts, skipped }, { status: 201 });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể tạo batch upload.");

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}

// The 2s poll: recent batches + O(1) counts, pipelined across all of them.
export async function GET() {
  try {
    const batches = await listRecentBatches();
    const countsByBatchId = await getCountsForBatches(batches.map((batch) => batch.id));

    return NextResponse.json(
      {
        batches: batches.map((batch) => ({
          batch,
          counts: countsByBatchId[batch.id],
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể tải danh sách batch.");

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}
