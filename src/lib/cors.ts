import type { NextRequest } from "next/server";

export class OriginNotAllowedError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "OriginNotAllowedError";
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
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
  // Threat model: cross-origin browser requests always carry Origin, so any
  // CSRF probe that could ride on Basic Auth credentials will be caught by
  // the mismatch branch below. An absent Origin means same-origin browser,
  // server-to-server caller, or a privacy-stripped fetch — none of which a
  // CORS check can meaningfully defend against once Basic Auth has cleared.
  // Block only the genuinely mismatched case; mirror configured[0] otherwise.
  if (requestOrigin && !configured.includes(requestOrigin)) {
    throw new OriginNotAllowedError();
  }
  return requestOrigin ?? configured[0];
}

export function buildCorsHeaders(origin: string, extra?: Record<string, string>) {
  // SECURITY_HEADERS is folded in here so every response that flows through a
  // route handler (including the streaming `new Response(stream)` path that
  // bypasses NextResponse.next()) carries the same hardening baseline as the
  // ones the proxy sets on page routes. SECURITY_HEADERS is spread LAST so
  // callers' `extra` can set headers like Content-Type or Cache-Control but
  // can never accidentally weaken the security baseline (e.g. by passing
  // X-Frame-Options: SAMEORIGIN).
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
    ...extra,
    ...SECURITY_HEADERS,
  };
}

export function forbidden() {
  return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
}
