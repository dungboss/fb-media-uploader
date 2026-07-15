import { describe, expect, it } from "vitest";

import { resolveMediaType } from "./media-type";

describe("resolveMediaType", () => {
  it("matches image extensions case-insensitively", () => {
    expect(resolveMediaType({ name: "a.JPG" })).toBe("image");
    expect(resolveMediaType({ name: "a.jpeg" })).toBe("image");
    expect(resolveMediaType({ name: "a.png" })).toBe("image");
    expect(resolveMediaType({ name: "a.gif" })).toBe("image");
  });

  it("rejects non-image extensions", () => {
    expect(resolveMediaType({ name: "a.csv" })).toBeNull();
    expect(resolveMediaType({ name: "a.mp4" })).toBeNull();
    expect(resolveMediaType({ name: "a.webp" })).toBeNull();
  });

  it("falls back to mime type when the extension is missing", () => {
    expect(resolveMediaType({ name: "a", mimeType: "image/png" })).toBe("image");
  });

  it("never treats a directory as an image, even with an image extension", () => {
    expect(resolveMediaType({ name: "a.jpg", isDirectory: true })).toBeNull();
  });

  it("uses only the last extension", () => {
    expect(resolveMediaType({ name: "archive.tar.gz" })).toBeNull();
  });

  it("treats a leading-dot-only name as having no extension", () => {
    // ".jpg" has no basename before the dot (a hidden dotfile pattern), so
    // it resolves to null rather than being treated as a ".jpg" extension.
    expect(resolveMediaType({ name: ".jpg" })).toBeNull();
  });
});
