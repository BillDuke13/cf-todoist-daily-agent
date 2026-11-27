import type { NextRequest } from "next/server";
import { OriginNotAllowedError, buildCorsHeaders, forbidden, resolveOrigin } from "./cors";

export type OriginResolution =
  | { ok: true; origin: string }
  | { ok: false; response: Response };

export function resolveRequestOrigin(
  request: NextRequest,
  allowedOrigins: string | undefined,
): OriginResolution {
  try {
    return { ok: true, origin: resolveOrigin(request, allowedOrigins) };
  } catch (error) {
    if (error instanceof OriginNotAllowedError) {
      return { ok: false, response: forbidden() };
    }
    throw error;
  }
}

export function handleCorsPreflight(
  request: NextRequest,
  allowedOrigins: string | undefined,
): Response {
  const resolved = resolveRequestOrigin(request, allowedOrigins);
  if (!resolved.ok) {
    return resolved.response;
  }
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(resolved.origin, {
      "Access-Control-Max-Age": "600",
    }),
  });
}

// Compare the bare media type so `application/json; charset=utf-8` passes while
// composite types such as `text/html+application/json` do not.
export function isJsonContentType(request: NextRequest): boolean {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

export function exceedsDeclaredLength(request: NextRequest, maxBytes: number): boolean {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  return Number.isFinite(declaredLength) && declaredLength > maxBytes;
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
