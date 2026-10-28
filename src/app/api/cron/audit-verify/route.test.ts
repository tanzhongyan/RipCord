import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/cron/audit-verify", () => {
  it("answers 401 without the cron secret", async () => {
    const res = await POST(
      new Request("http://localhost/api/cron/audit-verify", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("runs the chain check with the cron secret", async () => {
    vi.resetModules();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const { POST: authed } = await import("./route");
    const call = () =>
      authed(
        new Request("http://localhost/api/cron/audit-verify", {
          method: "POST",
          headers: { authorization: "Bearer test-cron-secret" },
        }),
      );
    // The B8 tamper test shares this table; a 500 mid-tamper is retried.
    let res = await call();
    for (let attempt = 0; attempt < 10 && res.status === 500; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      res = await call();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.checked).toBe("number");
  });
});
