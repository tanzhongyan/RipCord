import { afterEach, describe, expect, it, vi } from "vitest";

import { seedUser } from "~/features/identity/server/test-support";
import { auth } from "~/server/auth/auth";
import AdminPage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

afterEach(() => {
  vi.restoreAllMocks();
});

/** A signed-in user whose row has the plain `user` role. */
async function signInAsNonAdmin() {
  const { id, email } = await seedUser("Plain User");
  vi.spyOn(auth.api, "getSession").mockResolvedValue({
    session: {
      id: "session-id",
      userId: id,
      token: "session-token",
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id,
      name: "Plain User",
      email,
      emailVerified: true,
      banned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

describe("B5 /admin for a non-admin", () => {
  it("answers 404 and renders no admin data", async () => {
    await signInAsNonAdmin();
    const error = await AdminPage().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect((error as { digest?: string } | null)?.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
