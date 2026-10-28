import { describe, expect, it } from "vitest";

import { config, middleware } from "./middleware";

describe("mandate page headers", () => {
  it("sets no-store and no-referrer", () => {
    const response = middleware();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("matches the holder review page", () => {
    expect(config.matcher).toBe("/m/:path*");
  });
});
