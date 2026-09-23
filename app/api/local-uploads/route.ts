import { NextResponse } from "next/server";

import { FacebookApiError } from "@/lib/media-upload/facebook-error";
import {
  deleteLocalUploadSession,
  stageLocalUpload,
} from "@/lib/media-upload/local-upload-store";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Stages one browser-selected file per request. Sending files separately
// keeps a large folder from becoming one enormous multipart body and lets the
// UI report deterministic upload progress before creating the BullMQ batch.
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const sessionId = form.get("sessionId");
    const file = form.get("file");

    if (typeof sessionId !== "string" || !(file instanceof File)) {
      throw new FacebookApiError("Thiếu upload session hoặc file local.", 400);
    }

    const staged = await stageLocalUpload({
      sessionId,
      fileName: file.name,
      contentType: file.type || null,
      bytes: await file.arrayBuffer(),
    });

    return NextResponse.json(staged, { status: 201 });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể nhận file từ máy tính.");
    return NextResponse.json({ error: safeError.message }, { status: safeError.status });
  }
}

// Best-effort cleanup when the browser upload fails before a batch exists.
export async function DELETE(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) {
      throw new FacebookApiError("Thiếu upload session.", 400);
    }

    await deleteLocalUploadSession(sessionId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const safeError = getClientSafeError(error, "Không thể dọn file local tạm.");
    return NextResponse.json({ error: safeError.message }, { status: safeError.status });
  }
}
