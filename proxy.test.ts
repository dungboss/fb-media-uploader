// Proves the Basic Auth gate actually blocks. This is the app's only access
// control — a bug here silently republishes the company NAS to the internet,
// and nothing else in the test suite would notice.

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function requestWith(authorization?: string): NextRequest {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return new NextRequest("http://localhost:3000/api/webdav/entries", { headers });
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

describe("proxy — Basic Auth", () => {
  it("401s a request with no Authorization header", () => {
    process.env.BASIC_AUTH_PASSWORD = "s3cret";
    const response = proxy(requestWith());
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic realm=");
  });

  it("401s a wrong password", () => {
    process.env.BASIC_AUTH_PASSWORD = "s3cret";
    expect(proxy(requestWith(basic("admin", "wrong"))).status).toBe(401);
  });

  it("401s a wrong user", () => {
    process.env.BASIC_AUTH_PASSWORD = "s3cret";
    expect(proxy(requestWith(basic("attacker", "s3cret"))).status).toBe(401);
  });

  it("401s garbage that is not base64 credentials", () => {
    process.env.BASIC_AUTH_PASSWORD = "s3cret";
    expect(proxy(requestWith("Basic !!!not-base64!!!")).status).toBe(401);
    expect(proxy(requestWith("Bearer token")).status).toBe(401);
  });

  it("lets the correct credentials through", () => {
    process.env.BASIC_AUTH_PASSWORD = "s3cret";
    expect(proxy(requestWith(basic("admin", "s3cret"))).status).toBe(200);
  });

  it("honours a custom user name", () => {
    process.env.BASIC_AUTH_USER = "dung";
    process.env.BASIC_AUTH_PASSWORD = "s3cret";
    expect(proxy(requestWith(basic("dung", "s3cret"))).status).toBe(200);
    expect(proxy(requestWith(basic("admin", "s3cret"))).status).toBe(401);
  });

  it("accepts a password containing a colon (split on the first one only)", () => {
    process.env.BASIC_AUTH_PASSWORD = "a:b:c";
    expect(proxy(requestWith(basic("admin", "a:b:c"))).status).toBe(200);
  });

  // The deployment failure mode this guards: forgetting the env var on Render.
  // Serving the NAS unprotected must never be the fallback.
  it("refuses to serve in production when no password is configured", () => {
    delete process.env.BASIC_AUTH_PASSWORD;
    Object.defineProperty(process.env, "NODE_ENV", { value: "production", configurable: true });
    const response = proxy(requestWith());
    expect(response.status).toBe(503);
  });

  it("stays open on localhost when no password is configured", () => {
    delete process.env.BASIC_AUTH_PASSWORD;
    Object.defineProperty(process.env, "NODE_ENV", { value: "development", configurable: true });
    expect(proxy(requestWith()).status).toBe(200);
  });
});
