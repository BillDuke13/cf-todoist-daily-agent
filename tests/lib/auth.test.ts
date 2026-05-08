import { describe, expect, it } from "vitest";
import { constantTimeEqual, decodeBasicCredentials, safeEqual } from "@/lib/auth";

describe("decodeBasicCredentials", () => {
  it("decodes a basic 'user:pass' pair", () => {
    expect(decodeBasicCredentials(btoa("alice:secret"))).toBe("alice:secret");
  });

  it("returns an empty string for empty input", () => {
    expect(decodeBasicCredentials("")).toBe("");
  });

  it("preserves UTF-8 multi-byte sequences (matches Buffer behavior)", () => {
    const utf8Bytes = new TextEncoder().encode("alice:密码");
    const binary = String.fromCharCode(...utf8Bytes);
    expect(decodeBasicCredentials(btoa(binary))).toBe("alice:密码");
  });

  it("throws on non-base64 input so the caller can return 401", () => {
    expect(() => decodeBasicCredentials("!!!not-base64!!!")).toThrow();
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical byte arrays", () => {
    expect(
      constantTimeEqual(new Uint8Array([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4])),
    ).toBe(true);
  });

  it("returns false for arrays of different lengths", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("returns false for same-length arrays with differing content", () => {
    expect(
      constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
    ).toBe(false);
  });

  it("treats two empty arrays as equal", () => {
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("catches a single-bit flip in the final byte", () => {
    expect(
      constantTimeEqual(new Uint8Array([0xff, 0xff]), new Uint8Array([0xff, 0xfe])),
    ).toBe(false);
  });

  it("catches a single-bit flip in the first byte", () => {
    expect(
      constantTimeEqual(new Uint8Array([0x00, 0xff]), new Uint8Array([0x01, 0xff])),
    ).toBe(false);
  });
});

describe("safeEqual", () => {
  it("returns true for identical strings", async () => {
    expect(await safeEqual("admin", "admin")).toBe(true);
  });

  it("returns false for different strings of the same length", async () => {
    expect(await safeEqual("admin", "guest")).toBe(false);
  });

  it("returns false for strings of different lengths", async () => {
    expect(await safeEqual("a", "ab")).toBe(false);
  });

  it("returns true for two empty strings", async () => {
    expect(await safeEqual("", "")).toBe(true);
  });

  it("handles UTF-8 multi-byte strings consistently", async () => {
    expect(await safeEqual("密码", "密码")).toBe(true);
    expect(await safeEqual("密码", "口令")).toBe(false);
  });

  it("does not collide on a real SHA-256 prefix collision attempt", async () => {
    // Sanity guard: extremely close strings must hash differently.
    expect(await safeEqual("password", "Password")).toBe(false);
    expect(await safeEqual("password ", "password")).toBe(false);
  });
});
