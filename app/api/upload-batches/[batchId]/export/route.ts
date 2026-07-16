import { getBatch, listBatchJobIds } from "@/lib/media-upload/batches";
import { buildCsvFilename, csvHeaderLine, CSV_LINE_ENDING, jobToCsvRow } from "@/lib/media-upload/csv";
import { FacebookApiError } from "@/lib/media-upload/facebook-error";
import { getMediaUploadJobs } from "@/lib/media-upload/jobs";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Rows fetched (and flushed) per pull. A real batch runs to thousands of
// images and UPLOAD_MAX_BATCH_FILES allows 10k, so the whole batch is
// deliberately never materialised: page the ids, pipeline that page's
// HGETALLs, push the chunk, drop it. Bounded memory regardless of batch size,
// and the download starts immediately instead of after a long stall.
const EXPORT_CHUNK_SIZE = 500;

// One CSV row per job in the batch, failures included (blank hash + status +
// error) — see lib/media-upload/csv.ts for the escaping rules and why they
// are pinned by tests rather than inlined here.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { batchId } = await params;

    // Resolve the batch BEFORE streaming: once the first byte of a 200 is
    // sent, a later failure cannot be turned back into an error response —
    // the browser would just save a truncated CSV and call it a success.
    const batch = await getBatch(batchId);
    if (!batch) {
      throw new FacebookApiError("Batch không tồn tại.", 404);
    }

    const filename = buildCsvFilename(batch.nasFolderPath, batchId);
    const encoder = new TextEncoder();

    // Paging state lives out here, not in pull(): pull is invoked once per
    // chunk the consumer is ready for (that is what gives us backpressure),
    // so it must resume where the last call stopped rather than restart.
    let cursor: string | undefined = undefined;
    let headerSent = false;
    let exhausted = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (!headerSent) {
            headerSent = true;
            controller.enqueue(encoder.encode(csvHeaderLine()));
            return;
          }

          if (exhausted) {
            controller.close();
            return;
          }

          const page: { jobIds: string[]; nextCursor: string | null } = await listBatchJobIds({
            batchId,
            cursor,
            limit: EXPORT_CHUNK_SIZE,
          });

          if (page.jobIds.length > 0) {
            const jobs = await getMediaUploadJobs(page.jobIds);
            controller.enqueue(
              encoder.encode(jobs.map(jobToCsvRow).join(CSV_LINE_ENDING) + CSV_LINE_ENDING)
            );
          }

          cursor = page.nextCursor ?? undefined;
          if (!cursor) {
            exhausted = true;
          }
        } catch (error) {
          // Mid-stream failure: abort the body so the browser reports a broken
          // download instead of silently keeping a partial file that looks
          // complete.
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        // Both forms on purpose: the ASCII `filename` is the fallback, and
        // `filename*` (RFC 5987) carries the real, usually-Vietnamese name.
        "Content-Disposition": `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể xuất CSV cho batch.");

    return Response.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}
