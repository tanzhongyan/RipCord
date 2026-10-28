import { describe, expect, it } from "vitest";
import config from "../../../next.config.js";

describe("next.config security headers", () => {
  it("applies the required headers to every route", async () => {
    const rules = await config.headers?.();
    const rule = rules?.find((r) => r.source === "/:path*");
    const byKey = Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));

    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBeTruthy();
    expect(byKey["Permissions-Policy"]).toBeTruthy();
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(config.poweredByHeader).toBe(false);
  });
});
