// CSV serialisation for the per-batch hash export. Pure and side-effect free
// so the escaping rules below can be pinned by tests — every one of them
// exists because of a way CSV silently corrupts data rather than erroring.

import type { MediaUploadJob } from "./types";

// Excel assumes the host's legacy codepage unless a file opens with a UTF-8
// BOM. Without it, NAS paths like "/Team Đại/Embroidery 2" render as mojibake
// — and this project's paths are Vietnamese by default, so the BOM is not
// optional.
export const CSV_BOM = "﻿";

export const CSV_EXPORT_HEADER = ["file_name", "nas_path", "image_hash", "status", "error"] as const;

// Spreadsheets execute a cell whose text begins with one of these — a NAS
// filename like `=cmd|'/c calc'!A1.jpg` becomes a formula in whoever opens the
// export, not just in the uploader's own sheet (this NAS is shared across
// teams). Prefixing a single quote neutralises it while keeping the value
// legible. OWASP calls this CSV injection; it is cheap to prevent and
// invisible until it is not.
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

// Quote when the field contains a delimiter, a quote, or a newline; inner
// quotes double. This is RFC 4180 — a raw comma in an unquoted field silently
// shifts every later column, which is exactly the failure a hash export must
// not have.
export function toCsvField(value: string | null | undefined): string {
  const raw = value ?? "";
  const guarded = FORMULA_TRIGGERS.some((trigger) => raw.startsWith(trigger)) ? `'${raw}` : raw;

  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsvRow(fields: readonly (string | null | undefined)[]): string {
  return fields.map(toCsvField).join(",");
}

// One row per job, INCLUDING failures (locked decision): a blank hash next to
// status=failed is the point — it shows what did not make it, which a
// completed-only export would hide.
export function jobToCsvRow(job: MediaUploadJob): string {
  return toCsvRow([job.fileName, job.nasFilePath, job.imageHash, job.status, job.errorMessage]);
}

// CRLF per RFC 4180 — Excel on Windows treats a lone LF as one giant cell.
export const CSV_LINE_ENDING = "\r\n";

export function csvHeaderLine(): string {
  return CSV_BOM + toCsvRow(CSV_EXPORT_HEADER) + CSV_LINE_ENDING;
}

// Content-Disposition filename: ASCII-only fallback plus RFC 5987 UTF-8 form,
// because the batch's folder name is usually Vietnamese and a bare `filename=`
// with non-ASCII bytes is not interoperable.
export function buildCsvFilename(folderPath: string | null, batchId: string): string {
  const base = folderPath?.split("/").filter(Boolean).pop() ?? `batch-${batchId.slice(0, 8)}`;
  return `${base.replace(/[/\\?%*:|"<>]/g, "-")}-hashes.csv`;
}
