import { eq } from "drizzle-orm";

import { db } from "~/server/db";
import { cases, mandates } from "~/server/db/schema";
import { env } from "~/shared/config/env";

let liveOverride: boolean | null = null;

/**
 * Test seam: substitute the `LIVE_MODE_ENABLED` flag. Pass null to restore
 * the environment value. The flag itself is process-wide config, so tests
 * cannot flip it per case any other way.
 */
export function setLiveModeOverride(enabled: boolean | null): void {
  liveOverride = enabled;
}

/** The `LIVE_MODE_ENABLED` environment flag. */
export function liveModeEnabled(): boolean {
  return liveOverride ?? env.LIVE_MODE_ENABLED;
}

export interface SandboxCase {
  sandbox: boolean;
}

export interface SandboxMandate {
  liveModeApproved: boolean;
}

/**
 * The spec 0005 live gate: a case sends for real only when the environment
 * allows live mode, the case left the sandbox, and the mandate approved
 * live mode. Anything else stays on Mailpit and the simulated adapter.
 */
export function isLiveCase(c: SandboxCase, mandate: SandboxMandate | null): boolean {
  return liveModeEnabled() && !c.sandbox && (mandate?.liveModeApproved ?? false);
}

/**
 * Leave the sandbox during `CHANNEL_PLANNING`, and only when the mandate
 * allows live mode. Called from the planner; anywhere else the flag is
 * read-only. Returns true when the case left the sandbox.
 */
export async function maybeLeaveSandbox(caseId: string): Promise<boolean> {
  if (!liveModeEnabled()) return false;
  const [mandate] = await db
    .select({ liveModeApproved: mandates.liveModeApproved })
    .from(mandates)
    .where(eq(mandates.caseId, caseId))
    .orderBy(mandates.createdAt)
    .limit(1);
  if (!mandate?.liveModeApproved) return false;
  await db.update(cases).set({ sandbox: false }).where(eq(cases.id, caseId));
  return true;
}
