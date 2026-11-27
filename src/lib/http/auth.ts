// Uses Web Crypto only because webpack does not bundle `node:crypto`/`node:buffer`
// in the OpenNext proxy build.

// Throws DOMException on malformed base64; callers map that to HTTP 401.
export function decodeBasicCredentials(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Hash both values to fixed 32-byte digests first so input length cannot leak via timing.
export async function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return constantTimeEqual(new Uint8Array(digestA), new Uint8Array(digestB));
}

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
