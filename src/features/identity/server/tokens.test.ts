import { describe, expect, it } from "vitest";

import { equalHex, randomOtp, randomToken, sha256HexBytes, sha256hex } from "./tokens";

describe("tokens", () => {
  it("generates 32 url-safe bytes", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it("hashes with SHA-256", () => {
    expect(sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256HexBytes(new TextEncoder().encode("abc"))).toBe(sha256hex("abc"));
  });

  it("compares hashes in constant time", () => {
    const hash = sha256hex("token");
    expect(equalHex(hash, sha256hex("token"))).toBe(true);
    expect(equalHex(hash, sha256hex("other"))).toBe(false);
    expect(equalHex(hash, "short")).toBe(false);
  });

  it("generates 6-digit codes", () => {
    for (let i = 0; i < 20; i++) expect(randomOtp()).toMatch(/^\d{6}$/);
  });
});
