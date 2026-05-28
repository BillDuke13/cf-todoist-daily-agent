import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { decodeBasicCredentials, safeEqual } from "@/lib/auth";
import { SECURITY_HEADERS, parseAllowedOrigins } from "@/lib/cors";
import { problemResponse } from "@/lib/errors";

const DEFAULT_REALM = "Todoist Daily Agent";

export async function proxy(request: NextRequest) {
  const { env } = getCloudflareContext();

  // CORS preflight requests cannot carry an Authorization header (Fetch spec),
  // so they must bypass Basic Auth. Defense-in-depth: pre-validate Origin in
  // the proxy itself so any future route that forgets to call
  // resolveOrigin() cannot be probed cross-origin via OPTIONS.
  if (request.method === "OPTIONS") {
    const allowedOrigins = parseAllowedOrigins(env.FRONTEND_ORIGIN);
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(requestOrigin)) {
      return problemResponse({ status: 403, code: "forbidden_origin", headers: SECURITY_HEADERS });
    }
    return withSecurityHeaders(NextResponse.next());
  }

  const username = env.BASIC_AUTH_USER;
  const password = env.BASIC_AUTH_PASS;
  const realm = env.AUTH_REALM || DEFAULT_REALM;

  if (!username || !password) {
    // Do not reveal which secret is missing.
    console.error("Basic auth secrets are not configured");
    return problemResponse({ status: 500, code: "misconfigured", headers: SECURITY_HEADERS });
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) {
    return unauthorized(realm);
  }

  let decoded: string;
  try {
    decoded = decodeBasicCredentials(header.slice("Basic ".length));
  } catch {
    return unauthorized(realm);
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return unauthorized(realm);
  }

  const providedUser = decoded.slice(0, separator);
  const providedPass = decoded.slice(separator + 1);

  const [userMatches, passMatches] = await Promise.all([
    safeEqual(providedUser, username),
    safeEqual(providedPass, password),
  ]);
  if (!userMatches || !passMatches) {
    return unauthorized(realm);
  }

  return withSecurityHeaders(NextResponse.next());
}

function unauthorized(realm: string) {
  return problemResponse({
    status: 401,
    code: "unauthorized",
    headers: {
      "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
      ...SECURITY_HEADERS,
    },
  });
}

function withSecurityHeaders(response: NextResponse) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

// Explicit allow-list of protected paths: the SPA shell (`/`), the public alias
// `/plan` (rewritten to `/api/plan`), and every `/api/*` route. Static assets
// under `/_next/*` stay public. An explicit list avoids a negative lookahead
// silently protecting — or exposing — future routes.
export const config = {
  matcher: ["/", "/plan", "/api/:path*"],
};
