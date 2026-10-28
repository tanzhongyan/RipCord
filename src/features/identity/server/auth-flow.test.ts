import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createAuthInstance } from "~/server/auth/auth";
import { db } from "~/server/db";
import { users } from "~/server/db/schema";

describe("B1 Sign-in", () => {
  it("creates a user and sets a session cookie from an email code", async () => {
    const codes = new Map<string, string>();
    const auth = createAuthInstance({
      sendEmail: (to, _subject, text) => {
        codes.set(to, text.match(/(\d{6})/)?.[1] ?? "");
        return Promise.resolve();
      },
    });
    const email = `${randomUUID()}@example.com`;
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = codes.get(email);
    expect(otp).toMatch(/^\d{6}$/);

    const response = await auth.api.signInEmailOTP({
      body: { email, otp: otp ?? "" },
      headers: new Headers(),
      asResponse: true,
    });
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.includes("better-auth.session_token"))).toBe(true);

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(user?.email).toBe(email);
  });
});
