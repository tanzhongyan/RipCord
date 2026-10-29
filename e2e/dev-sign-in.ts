import { sql } from "drizzle-orm";
import type { BrowserContext } from "playwright/test";

import { createAuthInstance } from "~/server/auth/auth";
import { db } from "~/server/db";
import { env } from "~/shared/config/env";

/** Listed in `ADMIN_EMAILS` for the server that `scripts/playwright-run.mjs` starts. */
export const e2eAdminEmail = "e2e-admin@example.test";

const localHosts = new Set(["localhost", "127.0.0.1"]);

/**
 * Dev-only sign-in guard. E2E sign-in mints a real session from an email code,
 * so it must never run in production or against a remote host.
 */
export function assertDevSignInAllowed(nodeEnv: string | undefined, baseURL: string | undefined) {
  if (nodeEnv === "production") throw new Error("E2E sign-in is disabled in production");
  if (!baseURL || !localHosts.has(new URL(baseURL).hostname)) {
    throw new Error("E2E sign-in only targets a local server");
  }
}

/**
 * Sign `email` in without a browser form: it asks Better Auth for a code with a
 * capturing mailer, redeems it, and puts the session cookie on the context.
 * This lives in `e2e/` and is never imported by the app, so no production code
 * path exists. The server must share `BETTER_AUTH_SECRET` and the database
 * (the runner sets both).
 */
export async function devSignIn(
  context: BrowserContext,
  baseURL: string | undefined,
  email: string,
) {
  assertDevSignInAllowed(env.NODE_ENV, baseURL);
  // Playwright workers sign the same email in at once. Each request replaces the
  // stored code, so concurrent redeems fail. A per-email advisory lock queues them.
  const response = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`);
    let code = "";
    const auth = createAuthInstance({
      sendEmail: (_to, _subject, text) => {
        code = text.match(/(\d{6})/)?.[1] ?? "";
        return Promise.resolve();
      },
    });
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    return auth.api.signInEmailOTP({
      body: { email, otp: code },
      headers: new Headers(),
      asResponse: true,
    });
  });
  if (!response.ok) throw new Error(`E2E sign-in failed for ${email}: ${response.status}`);
  const cookies = response.headers.getSetCookie().map((header) => {
    const pair = header.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: baseURL ?? "" };
  });
  await context.addCookies(cookies);
}
