// HTTP Basic Auth over EVERY request. This app has no other access control:
// without this file, anyone with the URL can browse and download the whole
// company NAS (/api/webdav/entries, /api/webdav/file), list and delete the
// stored Facebook tokens, and upload to the ad accounts. That was acceptable
// while it only ever ran on localhost; it is not once it has a public URL.
//
// Next 16 renamed the `middleware` convention to `proxy` (the function MUST be
// named `proxy` or be the default export) and switched it to the Node.js
// runtime by default — which is why node:crypto is available here.
//
// No `config.matcher` on purpose. The docs warn that an unmatched proxy also
// runs for static assets, which is usually a mistake — here it is the point:
// everything is protected, and once the browser has authenticated it attaches
// the header to every later request anyway, so nothing stays blocked.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_USER = "admin";
const REALM = "fb-media-uploader";

export function proxy(request: NextRequest) {
  const expectedUser = process.env.BASIC_AUTH_USER?.trim() || DEFAULT_USER;
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD?.trim();

  if (!expectedPassword) {
    // Fail CLOSED in production. Forgetting to set the password on a deployed
    // instance is the likeliest way this protection silently disappears, and
    // an open NAS gateway is far worse than a broken deploy — so a missing
    // password is an outage, not a bypass. Dev stays open so localhost needs
    // no setup.
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "BASIC_AUTH_PASSWORD chưa được đặt. App từ chối phục vụ để không phơi NAS ra Internet.",
        { status: 503 }
      );
    }
    return NextResponse.next();
  }

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = safeDecodeBase64(header.slice("Basic ".length));
    // Split on the FIRST colon only — a password may legitimately contain one.
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex !== -1) {
      const user = decoded.slice(0, separatorIndex);
      const password = decoded.slice(separatorIndex + 1);

      if (constantTimeEquals(user, expectedUser) && constantTimeEquals(password, expectedPassword)) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Cần đăng nhập.", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      // Never let a proxy or the browser cache a 401 as if it were the page.
      "Cache-Control": "no-store",
    },
  });
}

// Compares via SHA-256 digests rather than the raw strings: timingSafeEqual
// throws on length mismatch, and guarding that with a length check would leak
// the password length through both the throw and the early return. Digests are
// always 32 bytes, so every comparison takes the same path.
function constantTimeEquals(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function safeDecodeBase64(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}
