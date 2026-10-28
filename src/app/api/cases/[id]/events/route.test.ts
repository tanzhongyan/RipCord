import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/cases/[id]/events", () => {
  it("rejects callers without a session", async () => {
    const response = await GET(new Request("http://localhost/api/cases/x/events"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
