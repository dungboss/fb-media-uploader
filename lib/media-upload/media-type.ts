// Pure media-type detection for the images-only upload flow. No node
// imports — both a server route and a client component (NAS folder picker)
// use this to decide what counts as an uploadable image.

// WebDAV PROPFIND on this NAS nulls out `application/octet-stream`
// (see lib/webdav.server.ts), so `mimeType` is frequently null for real
// files. Extension is therefore the primary signal; mime is a fallback for
// the rare case a server does report a real image content-type.
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);

const IMAGE_MIME_PREFIXES = ["image/jpeg", "image/png", "image/gif"];

/**
 * Resolves whether a directory/file entry is an uploadable image.
 * Extension (lowercased, after the LAST dot only — "archive.tar.gz" is not
 * an image) is checked first; falls back to a known image mime prefix.
 * Directories and anything else resolve to null.
 */
export function resolveMediaType(entry: {
  name: string;
  mimeType?: string | null;
  isDirectory?: boolean;
}): "image" | null {
  if (entry.isDirectory) {
    return null;
  }

  const lastDotIndex = entry.name.lastIndexOf(".");
  if (lastDotIndex > 0) {
    const extension = entry.name.slice(lastDotIndex).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) {
      return "image";
    }
  }

  const normalizedMimeType = entry.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (IMAGE_MIME_PREFIXES.includes(normalizedMimeType)) {
    return "image";
  }

  return null;
}
