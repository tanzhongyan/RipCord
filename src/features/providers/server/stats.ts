import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { channelOutcomeStats } from "~/server/db/schema";
import type { ProviderValkey } from "./valkey";

/** How many recent durations per channel feed the median. */
export const STATS_DURATION_WINDOW = 50;

export interface ChannelStatsDeps {
  db: Database;
  valkey: ProviderValkey;
}

function durationsKey(channelId: string): string {
  return `providers:stats:durations:${channelId}`;
}

/**
 * Median of whole minutes. An even count averages the two middle values and
 * rounds, so the result stays an integer for `median_minutes`.
 */
export function medianMinutes(durations: number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

export interface ChannelAttempt {
  channelId: string;
  durationMinutes: number;
}

/**
 * Record one closed case against the channels it tried. The spec 0004 engine
 * calls this on close; it takes no case ID, so the aggregate can never link
 * back to a case. Attempts and successes move in a single transaction, and
 * each median is recomputed from the last 50 durations in Valkey.
 */
export async function recordChannelOutcomes(
  input: { tried: ChannelAttempt[]; succeededChannelId?: string | null },
  deps: ChannelStatsDeps,
): Promise<void> {
  if (input.tried.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "[VALIDATION] No channels tried" });
  }
  const successId = input.succeededChannelId ?? null;
  if (successId && !input.tried.some((attempt) => attempt.channelId === successId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "[VALIDATION] Success channel was not tried",
    });
  }
  for (const attempt of input.tried) {
    if (!Number.isInteger(attempt.durationMinutes) || attempt.durationMinutes < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "[VALIDATION] Durations are whole minutes",
      });
    }
  }

  const medians = new Map<string, number | null>();
  for (const attempt of input.tried) {
    const key = durationsKey(attempt.channelId);
    await deps.valkey.lpush(key, String(attempt.durationMinutes));
    await deps.valkey.ltrim(key, 0, STATS_DURATION_WINDOW - 1);
    const raw = await deps.valkey.lrange(key, 0, -1);
    medians.set(
      attempt.channelId,
      medianMinutes(raw.map(Number).filter((value) => Number.isFinite(value))),
    );
  }

  await deps.db.transaction(async (tx) => {
    for (const attempt of input.tried) {
      const won = successId === attempt.channelId ? 1 : 0;
      const median = medians.get(attempt.channelId) ?? null;
      await tx
        .insert(channelOutcomeStats)
        .values({
          providerChannelId: attempt.channelId,
          attempts: 1,
          successes: won,
          medianMinutes: median,
        })
        .onConflictDoUpdate({
          target: channelOutcomeStats.providerChannelId,
          set: {
            attempts: sql`${channelOutcomeStats.attempts} + 1`,
            successes: sql`${channelOutcomeStats.successes} + ${won}`,
            medianMinutes: median,
            updatedAt: new Date(),
          },
        });
    }
  });
}
