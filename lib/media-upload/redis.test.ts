import { describe, expect, it } from "vitest";

import { redactRedisUrl } from "./redis";

// redactRedisUrl guards a client-visible string: describeRedisError's output is
// returned in the response body of every route via getClientSafeError. A
// password reaching this function must never reach the browser.
describe("redactRedisUrl", () => {
  it("leaves a credential-free local URL untouched", () => {
    expect(redactRedisUrl("redis://localhost:6379")).toBe("redis://localhost:6379");
  });

  it("leaves Render's default internal URL untouched (it carries no credentials)", () => {
    expect(redactRedisUrl("redis://red-abc123xyz:6379")).toBe("redis://red-abc123xyz:6379");
  });

  it("strips the password from an authenticated Key Value URL", () => {
    const redacted = redactRedisUrl(
      "rediss://default:sUp3r-S3cret_pw@singapore-keyvalue.render.com:6379"
    );

    expect(redacted).not.toContain("sUp3r-S3cret_pw");
    expect(redacted).not.toContain("default");
    expect(redacted).toContain("singapore-keyvalue.render.com");
  });

  it("strips a password containing URL-escaped characters", () => {
    const redacted = redactRedisUrl("redis://user:p%40ss%3Aword@10.0.0.5:6379");

    expect(redacted).not.toContain("p%40ss");
    expect(redacted).not.toContain("ss%3Aword");
    expect(redacted).toContain("10.0.0.5");
  });

  it("keeps the host, port and db path so the message stays diagnostic", () => {
    const redacted = redactRedisUrl("redis://default:hunter2@cache.internal:6380/3");

    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("cache.internal");
    expect(redacted).toContain("6380");
    expect(redacted).toContain("/3");
  });

  it("replaces an unparseable URL rather than echoing it", () => {
    // If we cannot parse it we cannot prove it holds no secret, so it must not
    // be passed through verbatim.
    expect(redactRedisUrl("not a url::maybe:a:password@host")).toBe(
      "(REDIS_URL không hợp lệ)"
    );
  });
});
