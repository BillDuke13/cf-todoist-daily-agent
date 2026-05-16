// Web-Crypto-only on purpose: webpack cannot resolve `node:crypto`/`node:buffer`
// during the OpenNext production build, so the proxy must avoid Node imports.
// @internal Public only for the proxy and its test suite.

// Throws InvalidCharacterError on malformed base64; callers translate that to 401.
export function decodeBasicCredentials(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Hashing both sides funnels variable-length inputs into a fixed 32-byte
// digest before the constant-time compare, eliminating length-based timing leaks.
export async function safeEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return constantTimeEqual(new Uint8Array(digestA), new Uint8Array(digestB));
}

// XOR-OR over every byte ensures the runtime is independent of where the first
// mismatch occurs. The length guard is a sanity net since both inputs are 32 bytes.
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
