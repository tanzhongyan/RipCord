import { describe, expect, it } from "vitest";

import { GET } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** F14: chargeCents is Zod-validated at the entry; invalid input is a 400. */
describe("F14 dispute-package chargeCents", () => {
  it.each(["-5", "abc", "199.5", "99999999999"])(
    "rejects chargeCents=%s with 400",
    async (value) => {
      const response = await GET(
        new Request(`http://localhost/api/cases/x/dispute-package?chargeCents=${value}`),
        params("00000000-0000-0000-0000-000000000000"),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "VALIDATION" });
    },
  );

  it("passes valid chargeCents through to auth", async () => {
    const response = await GET(
      new Request("http://localhost/api/cases/x/dispute-package?chargeCents=199"),
      params("00000000-0000-0000-0000-000000000000"),
    );
    expect(response.status).toBe(401);
  });
});
