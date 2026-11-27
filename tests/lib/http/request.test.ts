import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  exceedsDeclaredLength,
  handleCorsPreflight,
  isJsonContentType,
  readJsonBody,
  resolveRequestOrigin,
} from "@/lib/http/request";

describe("isJsonContentType", () => {
  it("accepts application/json with or without charset", () => {
    const plain = new NextRequest("http://example.test/plan", {
      headers: { "content-type": "application/json" },
    });
    const withCharset = new NextRequest("http://example.test/plan", {
      headers: { "content-type": "Application/JSON; charset=utf-8" },
    });
    expect(isJsonContentType(plain)).toBe(true);
    expect(isJsonContentType(withCharset)).toBe(true);
  });

  it("rejects missing or composite media types", () => {
    const missing = new NextRequest("http://example.test/plan");
    const composite = new NextRequest("http://example.test/plan", {
      headers: { "content-type": "text/html+application/json" },
    });
    expect(isJsonContentType(missing)).toBe(false);
    expect(isJsonContentType(composite)).toBe(false);
  });
});

describe("exceedsDeclaredLength", () => {
  it("flags payloads whose Content-Length exceeds the limit", () => {
    const over = new NextRequest("http://example.test/plan", {
      headers: { "content-length": "1025" },
    });
    const exact = new NextRequest("http://example.test/plan", {
      headers: { "content-length": "1024" },
    });
    const absent = new NextRequest("http://example.test/plan");
    expect(exceedsDeclaredLength(over, 1024)).toBe(true);
    expect(exceedsDeclaredLength(exact, 1024)).toBe(false);
    expect(exceedsDeclaredLength(absent, 1024)).toBe(false);
  });
});

describe("readJsonBody", () => {
  it("returns parsed JSON for valid bodies and null for invalid JSON", async () => {
    const valid = new NextRequest("http://example.test/plan", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    const invalid = new NextRequest("http://example.test/plan", {
      method: "POST",
      body: "{bad",
    });
    expect(await readJsonBody(valid)).toEqual({ ok: true });
    expect(await readJsonBody(invalid)).toBeNull();
  });
});

describe("resolveRequestOrigin & handleCorsPreflight", () => {
  it("returns allowed origin or a 403 problem response", () => {
    const allowedReq = new NextRequest("http://example.test/plan", {
      headers: { origin: "https://app.example.com" },
    });
    const blockedReq = new NextRequest("http://example.test/plan", {
      headers: { origin: "https://evil.example.com" },
    });

    const okResult = resolveRequestOrigin(allowedReq, "https://app.example.com");
    expect(okResult).toEqual({ ok: true, origin: "https://app.example.com" });

    const badResult = resolveRequestOrigin(blockedReq, "https://app.example.com");
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) {
      expect(badResult.response.status).toBe(403);
    }
  });

  it("returns 204 with Access-Control-Max-Age for valid preflight requests", () => {
    const req = new NextRequest("http://example.test/plan", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    });
    const res = handleCorsPreflight(req, "https://app.example.com");
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
  });
});
