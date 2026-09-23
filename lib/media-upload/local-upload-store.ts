import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getMediaUploadConfig } from "./env";
import { FacebookApiError } from "./facebook-error";
import { resolveMediaType } from "./media-type";

const LOCAL_UPLOAD_PREFIX = "local-upload:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_UPLOAD_ROOT = path.join(process.cwd(), ".data", "local-uploads");

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new FacebookApiError(`${label} không hợp lệ.`, 400);
  }
}

export function buildLocalUploadRef(sessionId: string, fileId: string) {
  assertUuid(sessionId, "Upload session");
  assertUuid(fileId, "Upload file ID");
  return `${LOCAL_UPLOAD_PREFIX}${sessionId}:${fileId}`;
}

export function parseLocalUploadRef(value: string) {
  if (!value.startsWith(LOCAL_UPLOAD_PREFIX)) return null;

  const [sessionId, fileId, extra] = value.slice(LOCAL_UPLOAD_PREFIX.length).split(":");
  if (extra || !sessionId || !fileId) return null;
  if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(fileId)) return null;

  return { sessionId, fileId };
}

export function isLocalUploadRef(value: string) {
  return parseLocalUploadRef(value) !== null;
}

export async function stageLocalUpload(input: {
  sessionId: string;
  fileName: string;
  contentType: string | null;
  bytes: ArrayBuffer;
}) {
  assertUuid(input.sessionId, "Upload session");

  const fileName = path.basename(input.fileName.trim());
  if (!fileName || resolveMediaType({ name: fileName, mimeType: input.contentType }) === null) {
    throw new FacebookApiError(
      "Chỉ hỗ trợ ảnh .jpg, .jpeg, .png hoặc .gif.",
      400
    );
  }

  const { maxFileBytes } = getMediaUploadConfig();
  if (input.bytes.byteLength > maxFileBytes) {
    throw new FacebookApiError("File vượt quá giới hạn kích thước cho phép.", 413);
  }

  const fileId = randomUUID();
  const sessionDirectory = path.join(LOCAL_UPLOAD_ROOT, input.sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    path.join(/*turbopackIgnore: true*/ sessionDirectory, fileId),
    Buffer.from(input.bytes)
  );

  return {
    localFileRef: buildLocalUploadRef(input.sessionId, fileId),
    fileName,
    fileSize: input.bytes.byteLength,
  };
}

export async function readLocalUpload(localFileRef: string) {
  const parsed = parseLocalUploadRef(localFileRef);
  if (!parsed) {
    throw new FacebookApiError("Tham chiếu file local không hợp lệ.", 400);
  }

  const buffer = await readFile(
    path.join(LOCAL_UPLOAD_ROOT, parsed.sessionId, parsed.fileId)
  );
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export async function deleteLocalUploadSession(sessionId: string) {
  assertUuid(sessionId, "Upload session");
  await rm(path.join(LOCAL_UPLOAD_ROOT, sessionId), {
    recursive: true,
    force: true,
  });
}

export async function deleteLocalUpload(localFileRef: string) {
  const parsed = parseLocalUploadRef(localFileRef);
  if (!parsed) return;
  await rm(
    path.join(LOCAL_UPLOAD_ROOT, parsed.sessionId, parsed.fileId),
    { force: true }
  );
}
