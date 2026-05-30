import type { NextRequest } from "next/server";
import { problemResponse } from "./errors";

export class OriginNotAllowedError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "OriginNotAllowedError";
  }
}

// Defense-in-depth CSP. React escapes all model-generated text (no innerHTML
// sinks), so this is a second layer rather than the primary XSS control.
// `script-src`/`style-src` keep `'unsafe-inline'` because Next.js injects inline
// bootstrap scripts and next/font emits an inline <style>; tightening to a
// per-request nonce is the documented follow-up. `frame-ancestors 'none'` is the
// modern superset of X-Frame-Options; `connect-src 'self'` matches the SPA only
// ever calling its same-origin /plan and /api/transcribe endpoints.
//
// Development needs two relaxations the production bundle never does: the Next
// dev server (Turbopack) evaluates modules with `eval()` — hence `'unsafe-eval'`
// — and React Fast Refresh opens an HMR WebSocket — hence `ws:` in connect-src.
// The production build (`next build --webpack`) uses neither, so prod stays
// strict. `process.env.NODE_ENV` is inlined at build time by Next.
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
  // Allow microphone for the voice-input flow on the same origin and disable
  // browser features the app does not use. interest-cohort opts out of FLoC.
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
  // Cross-origin browser requests always carry Origin, so any CSRF probe that
  // could ride Basic Auth lands in the mismatch branch. Absent Origin means
  // same-origin / server-to-server / privacy-stripped fetch — CORS cannot
  // defend those once Basic Auth cleared, so mirror configured[0] instead.
  if (requestOrigin && !configured.includes(requestOrigin)) {
    throw new OriginNotAllowedError();
  }
  return requestOrigin ?? configured[0];
}

export function buildCorsHeaders(origin: string, extra?: Record<string, string>) {
  // Streaming responses bypass NextResponse.next(), so every route must inject
  // SECURITY_HEADERS itself. Spreading them LAST makes callers' `extra` unable
  // to weaken the baseline (e.g. an X-Frame-Options: SAMEORIGIN gets overridden).
  return {
    // `origin` is always a single allow-listed value (resolveOrigin rejects any
    // mismatch and never returns "*"), so pairing it with Allow-Credentials is
    // safe and lets a cross-origin FRONTEND_ORIGIN send Basic Auth credentials.
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
