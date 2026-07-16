// Pins the CSV escaping rules. Each case below is a way CSV corrupts data
// SILENTLY — no error, no exception, just a file that means something other
// than what it says. That is the whole reason this module is pure and tested
// rather than inlined into the route.

import { describe, expect, it } from "vitest";

import {
  buildCsvFilename,
  csvHeaderLine,
  CSV_BOM,
  jobToCsvRow,
  toCsvField,
  toCsvRow,
} from "./csv";
import type { MediaUploadJob } from "./types";

function makeJob(overrides: Partial<MediaUploadJob> = {}): MediaUploadJob {
  return {
    id: "job-1",
    batchId: "batch-1",
    status: "completed",
    nasFilePath: "/Team Đại/Embroidery 2/Emb_001.jpg",
    fileName: "Emb_001.jpg",
    fileSize: 1024,
    imageHash: "c7f3a91b2e",
    previewUrl: "https://example.test/p.png",
    errorMessage: null,
    nextRetryAt: null,
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:01.000Z",
    ...overrides,
  };
}

describe("toCsvField", () => {
  it("leaves an ordinary value untouched", () => {
    expect(toCsvField("Emb_001.jpg")).toBe("Emb_001.jpg");
  });

  it("quotes a field containing a comma — the failure that shifts every later column", () => {
    expect(toCsvField("/NAS/ao dai, mau do/x.jpg")).toBe('"/NAS/ao dai, mau do/x.jpg"');
  });

  it("doubles inner quotes rather than truncating the field", () => {
    expect(toCsvField('anh "dep".jpg')).toBe('"anh ""dep"".jpg"');
  });

  it("quotes newlines so one row cannot become two", () => {
    expect(toCsvField("a\nb")).toBe('"a\nb"');
    expect(toCsvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("renders null and undefined as empty, never the string 'null'", () => {
    expect(toCsvField(null)).toBe("");
    expect(toCsvField(undefined)).toBe("");
  });

  it.each(["=", "+", "-", "@"])(
    "neutralises a formula starting with %s (CSV injection)",
    (trigger) => {
      expect(toCsvField(`${trigger}cmd|'/c calc'!A1`)).toBe(`'${trigger}cmd|'/c calc'!A1`);
    }
  );

  it("quotes a formula that also contains a comma — guard and quoting compose", () => {
    expect(toCsvField("=HYPERLINK(1,2)")).toBe(`"'=HYPERLINK(1,2)"`);
  });

  it("does not mangle a legitimate name that merely contains, not starts with, a trigger", () => {
    expect(toCsvField("Emb-001@2x.jpg")).toBe("Emb-001@2x.jpg");
  });
});

describe("jobToCsvRow", () => {
  it("emits file_name, nas_path, image_hash, status, error in that order", () => {
    expect(jobToCsvRow(makeJob())).toBe(
      "Emb_001.jpg,/Team Đại/Embroidery 2/Emb_001.jpg,c7f3a91b2e,completed,"
    );
  });

  // The locked reason failures are included at all: an empty hash beside
  // status=failed is the signal, not a defect.
  it("keeps a failed job with a blank hash and its error message", () => {
    const row = jobToCsvRow(
      makeJob({ status: "failed", imageHash: null, errorMessage: "Ảnh bị Meta từ chối" })
    );
    expect(row).toBe(
      "Emb_001.jpg,/Team Đại/Embroidery 2/Emb_001.jpg,,failed,Ảnh bị Meta từ chối"
    );
  });

  it("quotes an error message containing a comma", () => {
    const row = jobToCsvRow(makeJob({ status: "failed", imageHash: null, errorMessage: "Lỗi 400, ảnh hỏng" }));
    expect(row.endsWith(',failed,"Lỗi 400, ảnh hỏng"')).toBe(true);
  });
});

describe("csvHeaderLine", () => {
  it("starts with the UTF-8 BOM so Excel does not mojibake Vietnamese paths", () => {
    expect(csvHeaderLine().startsWith(CSV_BOM)).toBe(true);
  });

  it("ends the header with CRLF per RFC 4180", () => {
    expect(csvHeaderLine().endsWith("\r\n")).toBe(true);
  });
});

describe("buildCsvFilename", () => {
  it("names the file after the batch's folder", () => {
    expect(buildCsvFilename("/Team Đại/Embroidery 2", "abc")).toBe("Embroidery 2-hashes.csv");
  });

  it("falls back to the batch id when there is no folder", () => {
    expect(buildCsvFilename(null, "d1e1022f-77ee-46bb")).toBe("batch-d1e1022f-hashes.csv");
  });

  it("strips characters that are illegal in a filename", () => {
    expect(buildCsvFilename("/a/b:c*d?", "x")).toBe("b-c-d--hashes.csv");
  });
});

describe("toCsvRow", () => {
  it("joins fields with commas", () => {
    expect(toCsvRow(["a", "b", null])).toBe("a,b,");
  });
});
