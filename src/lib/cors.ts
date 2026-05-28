import type { NextRequest } from "next/server";
import { problemResponse } from "./errors";

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
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "OPTIONS, POST",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
    ...extra,
    ...SECURITY_HEADERS,
  };
}

export function forbidden() {
  return problemResponse({ status: 403, code: "forbidden_origin", headers: SECURITY_HEADERS });
}
