import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("server secret", () => {
  it("refuses to start production without BETTER_AUTH_SECRET", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_SMS_FROM", "+123");
    await expect(import("./auth")).rejects.toThrow("BETTER_AUTH_SECRET is required in production");
  });

  it("starts production with a secret", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/x");
    vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-only-not-a-real-secret");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    vi.stubEnv("TWILIO_SMS_FROM", "+123");
    const { serverSecret } = await import("./auth");
    expect(serverSecret()).toBe("unit-test-only-not-a-real-secret");
  });
});
