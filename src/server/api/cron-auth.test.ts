import { afterEach, describe, expect, it, vi } from "vitest";

import { requireCronSecret } from "~/server/api/cron-auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("cron auth", () => {
  it("denies without a configured secret", async () => {
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", undefined);
    const { requireCronSecret: check } = await import("~/server/api/cron-auth");
    const res = check(new Request("http://localhost/api/cron/retention", { method: "POST" }));
    expect(res?.status).toBe(401);
  });

  it("denies a wrong bearer token", async () => {
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { requireCronSecret: check } = await import("~/server/api/cron-auth");
    const res = check(
      new Request("http://localhost/api/cron/retention", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(res?.status).toBe(401);
  });

  it("allows the matching bearer token", async () => {
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { requireCronSecret: check } = await import("~/server/api/cron-auth");
    const res = check(
      new Request("http://localhost/api/cron/retention", {
        method: "POST",
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(res).toBeNull();
  });

  it("answers 401 from the statically imported module when unset", () => {
    // The test shell leaves CRON_SECRET unset, so the shared module denies.
    const res = requireCronSecret(
      new Request("http://localhost/api/cron/retention", { method: "POST" }),
    );
    expect(res?.status).toBe(401);
  });
});
