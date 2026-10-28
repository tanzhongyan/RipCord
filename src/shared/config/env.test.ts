import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("environment validation", () => {
  it("refuses production without Twilio", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("TWILIO_ACCOUNT_SID", undefined);
    vi.stubEnv("TWILIO_AUTH_TOKEN", undefined);
    vi.stubEnv("TWILIO_SMS_FROM", undefined);
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("starts production with Twilio", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_SMS_FROM", "+123");
    vi.stubEnv("VAULT_MASTER_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("S3_ACCESS_KEY", "test-access");
    vi.stubEnv("S3_SECRET_KEY", "test-secret");
    const { env } = await import("./env");
    expect(env.TWILIO_SMS_FROM).toBe("+123");
  });

  it("refuses a malformed vault master key", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("VAULT_MASTER_KEY", "not-base64-for-32-bytes");
    await expect(import("./env")).rejects.toThrow("Invalid environment variables");
  });

  it("defaults the vault key version to 1", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("VAULT_MASTER_KEY", undefined);
    vi.stubEnv("VAULT_KEY_VERSION", undefined);
    const { env } = await import("./env");
    expect(env.VAULT_MASTER_KEY).toBeUndefined();
    expect(env.VAULT_KEY_VERSION).toBe(1);
  });

  it("starts outside production without Twilio", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("TWILIO_ACCOUNT_SID", undefined);
    vi.stubEnv("TWILIO_AUTH_TOKEN", undefined);
    vi.stubEnv("TWILIO_SMS_FROM", undefined);
    const { env } = await import("./env");
    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(env.VALKEY_URL).toBe("redis://localhost:6379");
  });
});
