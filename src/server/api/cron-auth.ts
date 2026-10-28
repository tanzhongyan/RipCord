import { timingSafeEqual } from "node:crypto";

import { env } from "~/shared/config/env";

/**
 * Authorise a cron route call. Returns null when the
 * `Authorization: Bearer ${CRON_SECRET}` header matches, else a 401 response.
 * Without a configured secret every call is denied.
 */
export function requireCronSecret(req: Request): Response | null {
  const secret = env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || !header) {
    return Response.json({ code: "UNAUTHORIZED", message: "Missing cron secret" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(header, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return Response.json({ code: "UNAUTHORIZED", message: "Invalid cron secret" }, { status: 401 });
  }
  return null;
}
