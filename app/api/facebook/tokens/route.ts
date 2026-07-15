import { NextResponse } from "next/server";

import { hasEnvAccessToken, listAdAccounts } from "@/lib/media-upload/meta-ad-accounts";
import { getClientSafeError } from "@/lib/media-upload/meta-graph";
import { addFbToken, listFbTokens } from "@/lib/media-upload/token-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Returns stored token summaries (id + label only — never the raw token) plus
// whether a .env fallback token exists, so the UI can offer it as an option.
export async function GET() {
  try {
    const tokens = await listFbTokens();

    return NextResponse.json(
      { tokens, hasEnvToken: hasEnvAccessToken() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const safeError = getClientSafeError(
      error,
      "Không thể tải danh sách access token."
    );

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}

// Adds a new access token. Validates it against Meta (must reach at least one
// ad account) before encrypting and storing it, so bad tokens are rejected up
// front instead of failing later inside a worker job.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      label?: unknown;
      token?: unknown;
      appId?: unknown;
      appSecret?: unknown;
    };

    const token = typeof body.token === "string" ? body.token.trim() : "";
    const label = typeof body.label === "string" ? body.label : "";
    const appId = typeof body.appId === "string" ? body.appId.trim() : "";
    const appSecret =
      typeof body.appSecret === "string" ? body.appSecret.trim() : "";

    if (!token) {
      return NextResponse.json(
        { error: "Access token không được để trống." },
        { status: 400 }
      );
    }

    // Validate before persisting — surfaces expired/invalid tokens immediately.
    // Pass the app secret so validation also exercises the appsecret_proof path
    // when the app requires it (otherwise a proof-required app would 400 here).
    const adAccounts = await listAdAccounts({ token, appSecret });

    const saved = await addFbToken({ label, token, appId, appSecret });

    return NextResponse.json(
      { token: saved, adAccountCount: adAccounts.length },
      { status: 201 }
    );
  } catch (error) {
    const safeError = getClientSafeError(
      error,
      "Không thể thêm access token. Kiểm tra token còn hiệu lực và có quyền ads_read/ads_management."
    );

    return NextResponse.json(
      { error: safeError.message, details: safeError.details },
      { status: safeError.status }
    );
  }
}
