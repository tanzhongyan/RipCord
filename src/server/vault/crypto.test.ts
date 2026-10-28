import { afterEach, describe, expect, it, vi } from "vitest";

import { DEK_BYTES, openEnvelope, sealEnvelope } from "./crypto";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("envelope crypto", () => {
  it("round-trips with a fresh 32-byte data key", () => {
    expect(DEK_BYTES).toBe(32);
    const first = sealEnvelope("S1234567D");
    const second = sealEnvelope("S1234567D");
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
    expect(first.wrappedDek.length).toBe(12 + 32 + 16);
    expect(openEnvelope(first)).toBe("S1234567D");
    expect(first.keyVersion).toBe(1);
  });

  it("uses the dev key outside production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("VAULT_MASTER_KEY", undefined);
    const { masterKey } = await import("./crypto");
    expect(masterKey()).toHaveLength(32);
  });

  it("refuses production without a master key", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SKIP_ENV_VALIDATION", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("VAULT_MASTER_KEY", undefined);
    const { masterKey } = await import("./crypto");
    expect(() => masterKey()).toThrow("VAULT_MASTER_KEY is required in production");
  });

  it("reads the key version from env", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("VAULT_MASTER_KEY", undefined);
    vi.stubEnv("VAULT_KEY_VERSION", "3");
    const { currentKeyVersion, sealEnvelope: seal } = await import("./crypto");
    expect(currentKeyVersion()).toBe(3);
    expect(seal("x").keyVersion).toBe(3);
  });
});
