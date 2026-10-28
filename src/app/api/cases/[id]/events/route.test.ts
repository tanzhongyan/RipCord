import { afterEach, describe, expect, it, vi } from "vitest";

import { seedUser } from "~/features/identity/server/test-support";
import { auth } from "~/server/auth/auth";
import { GET } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/cases/[id]/events", () => {
  it("rejects callers without a session", async () => {
    const response = await GET(new Request("http://localhost/api/cases/x/events"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns 404 for a non-uuid id instead of a database error", async () => {
    const user = await seedUser();
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      session: {
        id: "session-id",
        userId: user.id,
        token: "session-token",
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: true,
        banned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const response = await GET(new Request("http://localhost/api/cases/not-a-uuid/events"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
