import { afterEach, describe, expect, it, vi } from "vitest";

async function callerWith(trust: "true" | "false", headers: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("TRUST_IDENTITY_HEADER", trust);
  const { appRouter } = await import("~/server/api/root");
  const { createTRPCContext } = await import("~/server/api/trpc");
  const ctx = await createTRPCContext({ headers: new Headers(headers) });
  return appRouter.createCaller(ctx);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("identity is fail-closed", () => {
  it("rejects a missing x-user-id header with UNAUTHORIZED", async () => {
    const caller = await callerWith("true", {});
    await expect(caller.notes.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a blank x-user-id header with UNAUTHORIZED", async () => {
    const caller = await callerWith("true", { "x-user-id": "   " });
    await expect(caller.notes.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("ignores the header when TRUST_IDENTITY_HEADER is false", async () => {
    const caller = await callerWith("false", { "x-user-id": "alice" });
    await expect(caller.notes.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("accepts the header when TRUST_IDENTITY_HEADER is true", async () => {
    const caller = await callerWith("true", { "x-user-id": "trpc-identity-test" });
    await expect(caller.notes.list()).resolves.toEqual([]);
  });
});
