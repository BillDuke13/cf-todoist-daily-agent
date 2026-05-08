/**
 * HTTP Basic Auth helpers extracted from src/proxy.ts so they can be
 * unit-tested without spinning up the Next.js proxy harness.
 *
 * The implementation is intentionally Web-Crypto-only: webpack cannot
 * resolve the `node:crypto` or `node:buffer` schemes during the OpenNext
 * production build, so the proxy must stay free of Node-specific
 * imports.
 *
 * @internal Public only for the proxy and its test suite.
 */

/**
 * Decode a base64-encoded "user:password" payload to a UTF-8 string.
 * Mirrors the behavior of `Buffer.from(s, "base64").toString("utf8")`
 * without pulling in `node:buffer`.
 *
 * Throws when the input is not valid base64 (atob raises
 * `InvalidCharacterError`); the caller is expected to translate that
 * into a 401 Unauthorized response.
 */
export function decodeBasicCredentials(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Hash both inputs to a fixed-length SHA-256 digest and compare them in
 * constant time. The digest funnel collapses both the attacker-controlled
 * and server-controlled lengths to 32 bytes, removing length-based
 * timing leaks before the comparison even starts.
 */
export async function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return constantTimeEqual(new Uint8Array(digestA), new Uint8Array(digestB));
}

/**
 * Compare two byte arrays in constant time. SHA-256 always yields
 * 32-byte digests, so the length check is a sanity net rather than a
 * leak. The XOR-OR loop visits every byte regardless of where the first
 * mismatch occurs.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}
