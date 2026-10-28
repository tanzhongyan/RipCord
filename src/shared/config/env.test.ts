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
    const { env } = await import("./env");
    expect(env.TWILIO_SMS_FROM).toBe("+123");
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
