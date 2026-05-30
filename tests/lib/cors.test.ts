import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  OriginNotAllowedError,
  SECURITY_HEADERS,
  buildCorsHeaders,
  forbidden,
  parseAllowedOrigins,
  resolveOrigin,
} from "@/lib/cors";

function makeRequest(origin?: string) {
  const init = origin ? { headers: { Origin: origin } } : undefined;
  return new NextRequest("http://example.test/", init);
}

describe("parseAllowedOrigins", () => {
  it("returns an empty array for empty or undefined input", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins(",,, ")).toEqual([]);
  });

  it("parses a single origin", () => {
    expect(parseAllowedOrigins("https://app.example.com")).toEqual(["https://app.example.com"]);
  });

  it("parses comma-separated origins and trims whitespace", () => {
    expect(
      parseAllowedOrigins("https://a.example , https://b.example,https://c.example"),
    ).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
  });
});

describe("OriginNotAllowedError", () => {
  it("is an Error subclass with the expected name", () => {
    const error = new OriginNotAllowedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OriginNotAllowedError");
    expect(error.message).toBe("Forbidden");
  });

  it("accepts a custom message", () => {
    expect(new OriginNotAllowedError("nope").message).toBe("nope");
  });
});

describe("resolveOrigin", () => {
  it("throws when FRONTEND_ORIGIN is not configured", () => {
    expect(() => resolveOrigin(makeRequest(), undefined)).toThrow(/not configured/);
    expect(() => resolveOrigin(makeRequest(), "")).toThrow(/not configured/);
  });

  it("returns the configured origin when no Origin header is present", () => {
    expect(resolveOrigin(makeRequest(), "https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });

  it("mirrors the request origin when it matches the allowlist", () => {
    expect(
      resolveOrigin(makeRequest("https://app.example.com"), "https://app.example.com"),
    ).toBe("https://app.example.com");
  });

  it("supports comma-separated allowlists", () => {
    const allowed = "https://a.example,https://b.example";
    expect(resolveOrigin(makeRequest("https://b.example"), allowed)).toBe("https://b.example");
  });

  it("throws OriginNotAllowedError on a mismatch", () => {
    expect(() =>
      resolveOrigin(makeRequest("https://evil.example"), "https://app.example.com"),
    ).toThrow(OriginNotAllowedError);
  });
});

describe("buildCorsHeaders", () => {
  const origin = "https://app.example.com";

  it("includes the standard CORS triplet plus the security baseline", () => {
    const headers = buildCorsHeaders(origin) as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).toBe(origin);
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Access-Control-Allow-Methods"]).toBe("OPTIONS, POST");
    expect(headers["Access-Control-Allow-Headers"]).toBe("content-type, authorization");
    expect(headers["Vary"]).toBe("Origin");
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[key]).toBe(value);
    }
  });

  it("pairs Allow-Credentials only with a specific (never wildcard) origin", () => {
    const headers = buildCorsHeaders(origin) as Record<string, string>;
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("lets callers add headers like Content-Type via `extra`", () => {
    const headers = buildCorsHeaders(origin, {
      "Content-Type": "application/json",
    }) as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("never lets `extra` weaken the security baseline", () => {
    const headers = buildCorsHeaders(origin, {
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "unsafe-url",
    }) as Record<string, string>;
    expect(headers["X-Frame-Options"]).toBe(SECURITY_HEADERS["X-Frame-Options"]);
    expect(headers["Referrer-Policy"]).toBe(SECURITY_HEADERS["Referrer-Policy"]);
  });
});

describe("SECURITY_HEADERS", () => {
  it("ships a Content-Security-Policy that forbids framing and restricts sources", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe("forbidden", () => {
  it("returns a 403 problem+json Response carrying the security baseline", async () => {
    const response = forbidden();
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(key)).toBe(value);
    }
    const body = (await response.json()) as { code: string; status: number };
    expect(body.code).toBe("forbidden_origin");
    expect(body.status).toBe(403);
  });
});
