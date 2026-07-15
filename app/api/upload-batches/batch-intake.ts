// Resolves a create-batch request body into a file list ready for
// createMediaUploadJobs: either folder mode (server-side PROPFIND Depth:1
// enumeration — the primary UX, keeps the request ~200 bytes instead of
// shipping thousands of paths) or explicit file mode (client hand-picked a
// sub-selection, capped at 500). Split out of route.ts to keep it under the
// 100-line-per-route guideline.

import { isSupportedWebDavUploadFile, normalizeWebDavPath } from "@/lib/webdav";
import { fetchWebDavDirectoryResponse } from "@/lib/webdav.server";
import { FacebookApiError } from "@/lib/media-upload/facebook-error";

const MAX_EXPLICIT_FILES = 500;

export interface CreateBatchRequestBody {
  nasFolderPath?: unknown;
  files?: unknown;
  adAccountId?: unknown;
  adAccountName?: unknown;
  appName?: unknown;
  tokenId?: unknown;
}

export interface ResolvedBatchFiles {
  files: Array<{ nasFilePath: string; fileSize: number | null }>;
  nasFolderPath: string | null;
  accountMeta: {
    adAccountId?: string;
    adAccountName?: string;
    appName?: string;
    tokenId?: string;
  };
}

// Accepts exactly one of `nasFolderPath` (string) or `files` (array) — 400
// on both or neither. Folder mode PROPFINDs the NAS and filters to images;
// file mode trusts the caller's list (still normalized + capped).
export async function resolveBatchFiles(
  body: CreateBatchRequestBody
): Promise<ResolvedBatchFiles> {
  const rawFolderPath =
    typeof body.nasFolderPath === "string" ? body.nasFolderPath.trim() : "";
  const hasFolderPath = rawFolderPath.length > 0;
  const hasFiles = Array.isArray(body.files);

  if (hasFolderPath === hasFiles) {
    throw new FacebookApiError(
      "Chọn đúng một trong hai: đường dẫn thư mục NAS hoặc danh sách file.",
      400
    );
  }

  const accountMeta = {
    adAccountId: pickString(body.adAccountId),
    adAccountName: pickString(body.adAccountName),
    appName: pickString(body.appName),
    tokenId: pickString(body.tokenId),
  };

  if (hasFolderPath) {
    const { files, nasFolderPath } = await enumerateFolder(rawFolderPath);
    return { files, nasFolderPath, accountMeta };
  }

  return {
    files: resolveExplicitFiles(body.files),
    nasFolderPath: null,
    accountMeta,
  };
}

// PROPFIND Depth:1 (non-recursive — bounded cost, no surprise crawl of a
// deep tree) then filters to images only. Non-image entries are simply not
// enumerated; they never surface as `skipped` (that's reserved for images
// the OOM guard refuses).
async function enumerateFolder(nasFolderPath: string) {
  const normalizedPath = normalizeWebDavPath(nasFolderPath);
  const directory = await fetchWebDavDirectoryResponse(normalizedPath);
  const imageFiles = directory.files.filter(isSupportedWebDavUploadFile);

  if (imageFiles.length === 0) {
    throw new FacebookApiError(
      "Không có ảnh nào trong thư mục này (.jpg .jpeg .png .gif).",
      400
    );
  }

  return {
    files: imageFiles.map((file) => ({
      nasFilePath: file.path,
      fileSize: file.size,
    })),
    nasFolderPath: normalizedPath,
  };
}

function resolveExplicitFiles(rawFiles: unknown) {
  const list = Array.isArray(rawFiles) ? rawFiles : [];

  if (list.length > MAX_EXPLICIT_FILES) {
    throw new FacebookApiError(
      `Chỉ chọn tối đa ${MAX_EXPLICIT_FILES} file mỗi lần. Hãy chọn cả thư mục thay vì chọn từng file.`,
      400
    );
  }

  return list
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object"
    )
    .map((entry) => {
      const rawPath = typeof entry.nasFilePath === "string" ? entry.nasFilePath : "";

      return {
        // Normalized (strips `..`, absolute-URL origin) before it ever
        // reaches persistence — see phase-04's Security Considerations.
        nasFilePath: rawPath ? normalizeWebDavPath(rawPath) : "",
        fileSize: typeof entry.fileSize === "number" ? entry.fileSize : null,
      };
    });
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
