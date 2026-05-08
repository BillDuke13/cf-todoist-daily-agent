import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS, parseAllowedOrigins } from "@/lib/cors";

const REALM = "Todoist Daily Agent";

export async function middleware(request: NextRequest) {
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
    decoded = decodeBasicCredentials(header.slice("Basic ".length));
  } catch {
    return unauthorized();
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return unauthorized();
  }

  const providedUser = decoded.slice(0, separator);
  const providedPass = decoded.slice(separator + 1);

  const [userMatches, passMatches] = await Promise.all([
    safeEqual(providedUser, username),
    safeEqual(providedPass, password),
  ]);
  if (!userMatches || !passMatches) {
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

// Decode base64 to a UTF-8 string using only Web standards. We avoid Node's
// Buffer because `node:buffer` is unresolvable by webpack during the OpenNext
// production build (UnhandledSchemeError on the `node:` URI scheme).
function decodeBasicCredentials(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Hash both inputs to a fixed-length digest so the comparison cost no longer
// branches on the attacker-controlled input length. We use Web Crypto rather
// than node:crypto because the latter is unresolvable by webpack during the
// OpenNext production build, which would block deploys.
async function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return constantTimeEqual(new Uint8Array(digestA), new Uint8Array(digestB));
}

// SHA-256 always produces 32-byte digests, so the length check is a sanity
// net rather than a leak. The XOR-OR loop visits every byte regardless of
// where the first mismatch occurs, keeping the comparison constant-time.
function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
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
