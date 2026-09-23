import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildLocalUploadRef,
  isLocalUploadRef,
  parseLocalUploadRef,
} from "./local-upload-store";

describe("local upload references", () => {
  it("round-trips opaque session and file ids", () => {
    const sessionId = randomUUID();
    const fileId = randomUUID();
    const ref = buildLocalUploadRef(sessionId, fileId);

    expect(parseLocalUploadRef(ref)).toEqual({ sessionId, fileId });
    expect(isLocalUploadRef(ref)).toBe(true);
  });

  it("rejects paths and malformed ids", () => {
    expect(parseLocalUploadRef("local-upload:../../etc:passwd")).toBeNull();
    expect(parseLocalUploadRef("/nas/photo.jpg")).toBeNull();
    expect(isLocalUploadRef("local-upload:not-a-uuid:not-a-uuid")).toBe(false);
  });
});
