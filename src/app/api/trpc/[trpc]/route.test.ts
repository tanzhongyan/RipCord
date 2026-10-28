import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { seedUser } from "~/features/identity/server/test-support";
import { auth } from "~/server/auth/auth";
import { POST } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("B10 Log hygiene", () => {
  it("never logs request PII when a request fails", async () => {
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
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(
      new Request("http://localhost/api/trpc/holders.S1234567D?batch=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "0": { json: { alias: "Dad", phone: "S1234567D" } },
        }),
      }) as NextRequest,
    );
    expect(res.status).toBe(404);
    const payload = JSON.stringify(await res.json());
    expect(payload).toContain("S1234567D");

    const logged = error.mock.calls
      .flat()
      .map((arg) => String(arg))
      .join("\n");
    expect(error).toHaveBeenCalled();
    expect(logged).not.toContain("1234567");
    expect(logged).toContain("[NRIC]");
  });
});
