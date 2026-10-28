import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "~/server/db";
import {
  accountHolders,
  caseDocuments,
  caseSteps,
  cases,
  channelOutcomeStats,
  providerChannels,
} from "~/server/db/schema";
import { listSecretKinds } from "~/server/vault";
import { type TransitionActor, transition } from "./engine";
import { ToolError } from "./errors";
import { maybeLeaveSandbox } from "./sandbox";

/** Kind tiebreak order, exactly as spec 0004 lists it. */
const KIND_ORDER = ["EMAIL", "PHONE_IVR", "WEB_FORM", "WEB_CHAT", "WHATSAPP", "POST", "STORE"];

/**
 * Placeholder step tool. Spec 0005 owns the per-kind step templates and
 * expands this row; the channel it plans for rides in `args`.
 */
export const EXECUTE_CHANNEL_TOOL = "execute-channel";

/** Release rules demand holder approval for these secret kinds. */
const APPROVAL_SECRETS = new Set(["NRIC", "PIN", "ACCOUNT_NO"]);

type ChannelRow = typeof providerChannels.$inferSelect;

interface RankedChannel {
  channel: ChannelRow;
  score: number;
  kindRank: number;
  median: number | null;
}

function rankOf(kind: string): number {
  const rank = KIND_ORDER.indexOf(kind);
  return rank === -1 ? KIND_ORDER.length : rank;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stepChannelId(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const id = (args as Record<string, unknown>).providerChannelId;
  return typeof id === "string" ? id : null;
}

export type PlanOutcome =
  | { planned: true; channelId: string; kind: string }
  | { planned: false; reason: "NO_VIABLE_CHANNEL" };

export interface PlanOpts {
  excludeChannelIds?: string[];
  now?: () => Date;
}

/**
 * Deterministic channel choice (spec 0004): verified destinations for the
 * provider and service, minus unsatisfiable ones, ranked by smoothed
 * success rate, kind order, then median minutes. The winner's step is
 * saved, the case moves to `EXECUTING`; with no winner it moves to
 * `FAILED` with `NO_VIABLE_CHANNEL` and the credit is refunded.
 */
export async function planChannel(
  caseId: string,
  actor: TransitionActor,
  opts: PlanOpts = {},
): Promise<PlanOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  if (c.status !== "CHANNEL_PLANNING") {
    throw new ToolError("ILLEGAL_TRANSITION", "The case is not planning a channel");
  }

  const winner = c.providerId
    ? await pickChannel(
        { holderId: c.holderId, providerId: c.providerId, serviceType: c.serviceType, id: c.id },
        opts.excludeChannelIds ?? [],
      )
    : null;
  if (!winner) {
    await transition(caseId, "FAILED", { reason: "NO_VIABLE_CHANNEL", actor, now: () => now });
    return { planned: false, reason: "NO_VIABLE_CHANNEL" };
  }

  await supersedePriorPlan(caseId);
  const seq = await nextSeq(caseId);
  const requiredSecrets = stringArray(winner.requiredSecrets);
  await db.insert(caseSteps).values({
    caseId,
    seq,
    tool: EXECUTE_CHANNEL_TOOL,
    args: { providerChannelId: winner.id, kind: winner.kind },
    status: "PLANNED",
    requiresApproval: requiredSecrets.some((kind) => APPROVAL_SECRETS.has(kind)),
  });
  await db.update(cases).set({ chosenChannelId: winner.id }).where(eq(cases.id, caseId));
  // The sandbox flips only here, while the case is still CHANNEL_PLANNING,
  // and only when the mandate allows live mode (spec 0005).
  await maybeLeaveSandbox(caseId);
  await transition(caseId, "EXECUTING", { actor, now: () => now });
  return { planned: true, channelId: winner.id, kind: winner.kind };
}

async function pickChannel(
  c: {
    holderId: string;
    providerId: string;
    serviceType: typeof cases.$inferSelect.serviceType;
    id: string;
  },
  excludeChannelIds: string[],
): Promise<ChannelRow | null> {
  const rows = await db
    .select()
    .from(providerChannels)
    .where(
      and(
        eq(providerChannels.providerId, c.providerId),
        c.serviceType
          ? or(
              eq(providerChannels.serviceType, c.serviceType),
              isNull(providerChannels.serviceType),
            )
          : isNull(providerChannels.serviceType),
        eq(providerChannels.isVerifiedDestination, true),
      ),
    );
  const candidates = rows.filter((row) => !excludeChannelIds.includes(row.id));
  if (candidates.length === 0) return null;

  const [holder] = await db
    .select({ deletedAt: accountHolders.deletedAt })
    .from(accountHolders)
    .where(eq(accountHolders.id, c.holderId))
    .limit(1);
  // A live holder supplies missing secrets on the secure page; a deleted
  // holder cannot, so missing secrets only drop candidates then.
  const vaultKinds = new Set(await listSecretKinds(db, c.holderId));
  const docs = await db
    .select({ kind: caseDocuments.kind })
    .from(caseDocuments)
    .where(eq(caseDocuments.caseId, c.id));
  const docKinds = new Set(docs.map((doc) => doc.kind));

  const satisfiable = candidates.filter((channel) => {
    if (holder?.deletedAt) {
      const missing = stringArray(channel.requiredSecrets).some(
        (kind) => !vaultKinds.has(kind as never),
      );
      if (missing) return false;
    }
    return stringArray(channel.requiredDocuments).every((kind) => docKinds.has(kind as never));
  });
  if (satisfiable.length === 0) return null;

  const statsRows = await db
    .select()
    .from(channelOutcomeStats)
    .where(
      inArray(
        channelOutcomeStats.providerChannelId,
        satisfiable.map((channel) => channel.id),
      ),
    );
  const stats = new Map(statsRows.map((row) => [row.providerChannelId, row]));
  const ranked: RankedChannel[] = satisfiable.map((channel) => {
    const row = stats.get(channel.id);
    const attempts = row?.attempts ?? 0;
    const successes = row?.successes ?? 0;
    return {
      channel,
      score: (successes + 1) / (attempts + 2),
      kindRank: rankOf(channel.kind),
      median: row?.medianMinutes ?? null,
    };
  });
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.kindRank - b.kindRank ||
      (a.median ?? Number.MAX_SAFE_INTEGER) - (b.median ?? Number.MAX_SAFE_INTEGER) ||
      (a.channel.id < b.channel.id ? -1 : 1),
  );
  return ranked[0]?.channel ?? null;
}

/** Prior unstarted plans are history once a new channel is chosen. */
async function supersedePriorPlan(caseId: string): Promise<void> {
  await db
    .update(caseSteps)
    .set({ status: "SKIPPED", finishedAt: new Date() })
    .where(
      and(
        eq(caseSteps.caseId, caseId),
        inArray(caseSteps.status, ["PLANNED", "AWAITING_APPROVAL"]),
      ),
    );
}

async function nextSeq(caseId: string): Promise<number> {
  const rows = await db
    .select({ seq: caseSteps.seq })
    .from(caseSteps)
    .where(eq(caseSteps.caseId, caseId));
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
}

/**
 * Retry after a channel failure: the failed channel's running steps close
 * as `FAILED`, the case moves back to `CHANNEL_PLANNING`, and planning
 * runs again without the tried channels. No new credit is consumed.
 */
export async function replanAfterFailure(
  caseId: string,
  failedChannelId: string,
  actor: TransitionActor,
  opts: PlanOpts = {},
): Promise<PlanOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  await transition(caseId, "CHANNEL_PLANNING", { actor, now: () => now });
  const steps = await db.select().from(caseSteps).where(eq(caseSteps.caseId, caseId));
  const failedStepIds = steps
    .filter((step) => step.status === "RUNNING" && stepChannelId(step.args) === failedChannelId)
    .map((step) => step.id);
  if (failedStepIds.length > 0) {
    await db
      .update(caseSteps)
      .set({ status: "FAILED", finishedAt: now })
      .where(inArray(caseSteps.id, failedStepIds));
  }
  const tried = new Set([failedChannelId, ...(opts.excludeChannelIds ?? [])]);
  for (const step of steps) {
    const id = stepChannelId(step.args);
    if (id) tried.add(id);
  }
  return planChannel(caseId, actor, { ...opts, excludeChannelIds: [...tried] });
}
