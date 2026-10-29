import { and, eq } from "drizzle-orm";

import { seedCase, seedHolder, seedProvider } from "~/features/cases/server/test-support";
import { db } from "~/server/db";
import { cases, users } from "~/server/db/schema";

/** Give the signed-in E2E user three cases (once), so the dashboard has rows to render. */
export async function seedDashboardCases(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error(`no user for ${email}; sign in first`);
  const existing = await db
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.ownerUserId, user.id));
  if (existing.length > 0) return;
  const holder = await seedHolder(user.id, { alias: "Mum" });
  const provider = await seedProvider({ name: "Demo Telco" });
  for (const status of ["EXECUTING", "AWAITING_MANDATE", "SUCCEEDED"] as const) {
    await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id, status });
  }
}

/** Id of one in-flight case owned by the E2E user, seeding the dashboard cases first. */
export async function seedCaseRoute(email: string): Promise<string> {
  await seedDashboardCases(email);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error(`no user for ${email}; sign in first`);
  const [row] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.ownerUserId, user.id), eq(cases.status, "EXECUTING")));
  if (!row) throw new Error("no EXECUTING case seeded");
  return row.id;
}
