import { TRPCError } from "@trpc/server";
import { eq, lt, or } from "drizzle-orm";

import { writeAudit } from "~/server/audit";
import type { Database } from "~/server/db";
import { db } from "~/server/db";
import { providerChannels, providers, users } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import type { AdminChannelPatch } from "../index";
import { invalidateProviderSearchCache } from "./search";
import { type ProviderValkey, valkey } from "./valkey";

export interface ProviderAdminDeps {
  db: Database;
  valkey: ProviderValkey;
}

export function liveAdminDeps(): ProviderAdminDeps {
  return { db, valkey: valkey() };
}

/** Split the comma-separated `ADMIN_EMAILS` value into lower-cased emails. */
export function parseAdminEmails(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Fail closed: the caller is an admin when the Better Auth admin plugin has
 * `role = 'admin'` on their user row, or their email is listed in
 * `ADMIN_EMAILS` (the first-admin bootstrap). Anything else gets FORBIDDEN.
 */
export async function requireAdmin(deps: ProviderAdminDeps, userId: string): Promise<void> {
  const [user] = await deps.db
    .select({ role: users.role, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  if (user.role === "admin") return;
  if (parseAdminEmails(env.ADMIN_EMAILS).includes(user.email.toLowerCase())) return;
  throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
}

export interface ReviewChannel {
  id: string;
  providerId: string;
  providerSlug: string;
  providerName: string;
  serviceType: string | null;
  kind: string;
  address: string;
  verified: boolean;
  confidence: number;
  sourceUrl: string;
  checkedAt: Date;
}

const REVIEW_CONFIDENCE_CUTOFF = 70;
const REVIEW_LIMIT = 100;

/** Channels that need a human: unverified destinations or low confidence. */
export async function adminListReview(deps: ProviderAdminDeps): Promise<ReviewChannel[]> {
  const rows = await deps.db
    .select({
      id: providerChannels.id,
      providerId: providerChannels.providerId,
      providerSlug: providers.slug,
      providerName: providers.name,
      serviceType: providerChannels.serviceType,
      kind: providerChannels.kind,
      address: providerChannels.address,
      verified: providerChannels.isVerifiedDestination,
      confidence: providerChannels.confidence,
      sourceUrl: providerChannels.sourceUrl,
      checkedAt: providerChannels.checkedAt,
    })
    .from(providerChannels)
    .innerJoin(providers, eq(providers.id, providerChannels.providerId))
    .where(
      or(
        eq(providerChannels.isVerifiedDestination, false),
        lt(providerChannels.confidence, REVIEW_CONFIDENCE_CUTOFF),
      ),
    )
    .limit(REVIEW_LIMIT);
  return rows;
}

/**
 * Apply an admin edit and set the verified flag in one transaction, then
 * clear the provider's cached searches. Every edit writes one audit row.
 */
export async function adminUpdateChannel(
  input: { channelId: string; patch: AdminChannelPatch; verify: boolean },
  actor: { userId: string },
  deps: ProviderAdminDeps,
): Promise<{ id: string; verified: boolean }> {
  const [channel] = await deps.db
    .select({ id: providerChannels.id, providerId: providerChannels.providerId })
    .from(providerChannels)
    .where(eq(providerChannels.id, input.channelId))
    .limit(1);
  if (!channel) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
  }

  const changedFields = Object.keys(input.patch);
  await deps.db.transaction(async (tx) => {
    await tx
      .update(providerChannels)
      .set({ ...input.patch, isVerifiedDestination: input.verify, checkedAt: new Date() })
      .where(eq(providerChannels.id, input.channelId));
    await writeAudit(tx, {
      actorType: "ADMIN",
      actorId: actor.userId,
      action: "PROVIDER_CHANNEL_UPDATED",
      targetType: "provider_channel",
      targetId: input.channelId,
      caseId: null,
      metadata: { providerId: channel.providerId, verify: input.verify, fields: changedFields },
    });
  });

  await invalidateProviderSearchCache(deps.valkey, channel.providerId);
  return { id: input.channelId, verified: input.verify };
}
