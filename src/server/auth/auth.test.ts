import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("server secret", () => {
  // Full Better Auth import: slow under a loaded suite, so the timeout is generous.
  it("refuses to start production without BETTER_AUTH_SECRET", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_SMS_FROM", "+123");
    vi.stubEnv("VAULT_MASTER_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("S3_ACCESS_KEY", "test-access");
    vi.stubEnv("S3_SECRET_KEY", "test-secret");
    await expect(import("./auth")).rejects.toThrow("BETTER_AUTH_SECRET is required in production");
  }, 15_000);

  it("starts production with a secret", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-only-not-a-real-secret");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_SMS_FROM", "+123");
    vi.stubEnv("VAULT_MASTER_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("S3_ACCESS_KEY", "test-access");
    vi.stubEnv("S3_SECRET_KEY", "test-secret");
    const { serverSecret } = await import("./auth");
    expect(serverSecret()).toBe("unit-test-only-not-a-real-secret");
  });
});
