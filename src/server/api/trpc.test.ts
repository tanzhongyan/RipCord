import { describe, expect, it } from "vitest";

import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

describe("identity is fail-closed", () => {
  it("rejects a request without a session with UNAUTHORIZED", async () => {
    const ctx = await createTRPCContext({ headers: new Headers() });
    const caller = appRouter.createCaller(ctx);
    await expect(caller.holders.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.mandates.get({ mandateId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("exposes no user without a session", async () => {
    const ctx = await createTRPCContext({ headers: new Headers() });
    expect(ctx.userId).toBeNull();
    expect(ctx.orgIds).toEqual([]);
  });
});
