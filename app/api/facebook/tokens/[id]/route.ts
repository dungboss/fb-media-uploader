import { NextResponse } from "next/server";

import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import { deleteFbToken } from "@/lib/media-upload/token-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const deleted = await deleteFbToken(id);

    return NextResponse.json({ id, deleted });
  } catch (error) {
    const safeError = getClientSafeError(
      error,
      "Không thể xóa access token."
    );

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}
