import { eq } from "drizzle-orm";

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
