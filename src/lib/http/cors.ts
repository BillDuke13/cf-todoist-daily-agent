import type { NextRequest } from "next/server";
import { problemResponse } from "./errors";

export class OriginNotAllowedError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "OriginNotAllowedError";
  }
}

// Next.js emits inline bootstrap scripts and next/font emits inline styles, so
// 'unsafe-inline' stays enabled until per-request nonces are wired. Dev mode
// adds 'unsafe-eval' and ws: for Turbopack/HMR; production omits both.
export function buildContentSecurityPolicy(isDev: boolean): string {
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  const connectSrc = isDev ? "connect-src 'self' ws:" : "connect-src 'self'";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    connectSrc,
  ].join("; ");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": buildContentSecurityPolicy(process.env.NODE_ENV !== "production"),
  "Permissions-Policy":
    "camera=(), geolocation=(), payment=(), usb=(), interest-cohort=(), microphone=(self)",
};

export function parseAllowedOrigins(raw: string | undefined) {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveOrigin(request: NextRequest, allowed: string | undefined) {
  const configured = parseAllowedOrigins(allowed);
  if (!configured.length) {
    throw new Error("FRONTEND_ORIGIN is not configured");
  }
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && !configured.includes(requestOrigin)) {
    throw new OriginNotAllowedError();
  }
  return requestOrigin ?? configured[0];
}

export function buildCorsHeaders(origin: string, extra?: Record<string, string>) {
  // Spread SECURITY_HEADERS last so caller extras cannot weaken the security baseline.
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "content-type, authorization",
    Vary: "Origin",
    ...extra,
    ...SECURITY_HEADERS,
  };
}

export function forbidden() {
  return problemResponse({ status: 403, code: "forbidden_origin", headers: SECURITY_HEADERS });
}
