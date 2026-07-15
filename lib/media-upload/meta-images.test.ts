import { describe, expect, it } from "vitest";

import { FacebookApiError } from "./facebook-error";
import { parseAdImageResponse } from "./meta-images";

describe("parseAdImageResponse", () => {
  it("reads the verified nested shape by field name (verbatim 2026-07-16 probe)", () => {
    // Real response body from POST act_1569761797025413/adimages, field
    // name "probe-test-image.png" — see plan.md risk #1.
    const payload = {
      images: {
        "probe-test-image.png": {
          hash: "2dd5a6417c24b8a4e6374de0b6960a6d",
          height: 600,
          url: "https://scontent.example/full.png",
          name: "probe-test-image.png",
          url_128: "https://scontent.example/thumb128.png",
          width: 600,
          url_256: "https://scontent.example/thumb256.png",
          url_256_height: "260",
          url_256_width: "260",
        },
      },
    };

    expect(parseAdImageResponse(payload, "probe-test-image.png")).toEqual({
      hash: "2dd5a6417c24b8a4e6374de0b6960a6d",
      url: "https://scontent.example/full.png",
      previewUrl: "https://scontent.example/thumb128.png",
      width: 600,
      height: 600,
    });
  });

  it("falls back to the first key when the field name does not match (key mismatch)", () => {
    const payload = { images: { bytes: { hash: "h" } } };

    expect(parseAdImageResponse(payload, "smoke.jpg")).toEqual({
      hash: "h",
      url: null,
      previewUrl: null,
      width: null,
      height: null,
    });
  });

  it("reads a hypothetical flat shape (the research report's — since disproven — claim)", () => {
    const payload = { hash: "h", url: "u", url_128: "t" };

    expect(parseAdImageResponse(payload, "smoke.jpg")).toEqual({
      hash: "h",
      url: "u",
      previewUrl: "t",
      width: null,
      height: null,
    });
  });

  it("handles an arbitrary multipart field name chosen by the caller", () => {
    const payload = {
      images: { "weird name (1).jpg": { hash: "h2", url_128: "p" } },
    };

    expect(parseAdImageResponse(payload, "weird name (1).jpg")).toEqual({
      hash: "h2",
      url: null,
      previewUrl: "p",
      width: null,
      height: null,
    });
  });

  it("throws a 502 FacebookApiError when no hash is found anywhere", () => {
    const malformedPayloads: unknown[] = [
      { images: {} },
      {},
      { images: { k: {} } },
    ];

    for (const payload of malformedPayloads) {
      let thrown: unknown;
      try {
        parseAdImageResponse(payload, "smoke.jpg");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FacebookApiError);
      expect((thrown as FacebookApiError).status).toBe(502);
    }
  });

  it("throws on malformed (non-object) input instead of crashing", () => {
    expect(() => parseAdImageResponse(null, "smoke.jpg")).toThrow(FacebookApiError);
    expect(() => parseAdImageResponse("garbage", "smoke.jpg")).toThrow(FacebookApiError);
    expect(() => parseAdImageResponse(undefined, "smoke.jpg")).toThrow(FacebookApiError);
  });
});
