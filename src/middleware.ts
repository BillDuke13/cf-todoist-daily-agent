import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS, parseAllowedOrigins } from "@/lib/cors";

const REALM = "Todoist Daily Agent";

export function middleware(request: NextRequest) {
  const { env } = getCloudflareContext();

  // CORS preflight requests cannot carry an Authorization header (Fetch spec),
  // so they must bypass Basic Auth. Defense-in-depth: pre-validate Origin in
  // the middleware itself so any future route that forgets to call
  // resolveOrigin() cannot be probed cross-origin via OPTIONS.
  if (request.method === "OPTIONS") {
    const allowedOrigins = parseAllowedOrigins(env.FRONTEND_ORIGIN);
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(requestOrigin)) {
      return new NextResponse("Forbidden", { status: 403, headers: SECURITY_HEADERS });
    }
    return withSecurityHeaders(NextResponse.next());
  }

  const username = env.BASIC_AUTH_USER;
  const password = env.BASIC_AUTH_PASS;

  if (!username || !password) {
    return new NextResponse("Basic authentication secrets are not configured.", { status: 500 });
  }

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString("utf8");
  } catch {
    return unauthorized();
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return unauthorized();
  }

  const providedUser = decoded.slice(0, separator);
  const providedPass = decoded.slice(separator + 1);

  if (!safeEqual(providedUser, username) || !safeEqual(providedPass, password)) {
    return unauthorized();
  }

  return withSecurityHeaders(NextResponse.next());
}

function unauthorized() {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      ...SECURITY_HEADERS,
    },
  });
}

// Hash both inputs to a fixed-length digest so the comparison cost no longer
// branches on the attacker-controlled input length.
function safeEqual(a: string, b: string) {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function withSecurityHeaders(response: NextResponse) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
