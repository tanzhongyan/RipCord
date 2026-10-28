import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { channelOutcomeStats } from "~/server/db/schema";
import { medianMinutes, recordChannelOutcomes, STATS_DURATION_WINDOW } from "./stats";
import { FakeValkey, seedChannel, seedProvider } from "./test-support";

describe("medianMinutes", () => {
  it("returns null without durations", () => {
    expect(medianMinutes([])).toBeNull();
  });

  it("takes the middle of an odd count", () => {
    expect(medianMinutes([30, 10, 20])).toBe(20);
  });

  it("averages the middle pair of an even count", () => {
    expect(medianMinutes([10, 20])).toBe(15);
    expect(medianMinutes([10, 11])).toBe(11);
  });
});

describe("B8 Stats anonymity", () => {
  it("updates attempts, successes and the median with no case linkage", async () => {
    const provider = await seedProvider();
    const winner = await seedChannel(provider.id);
    const loser = await seedChannel(provider.id);
    const valkey = new FakeValkey();
    const deps = { db, valkey };

    await recordChannelOutcomes(
      {
        tried: [
          { channelId: loser.id, durationMinutes: 40 },
          { channelId: winner.id, durationMinutes: 20 },
        ],
        succeededChannelId: winner.id,
      },
      deps,
    );
    await recordChannelOutcomes(
      {
        tried: [
          { channelId: loser.id, durationMinutes: 60 },
          { channelId: winner.id, durationMinutes: 30 },
        ],
        succeededChannelId: winner.id,
      },
      deps,
    );

    const [won] = await db
      .select()
      .from(channelOutcomeStats)
      .where(eq(channelOutcomeStats.providerChannelId, winner.id))
      .limit(1);
    expect(won?.attempts).toBe(2);
    expect(won?.successes).toBe(2);
    expect(won?.medianMinutes).toBe(25);

    const [lost] = await db
      .select()
      .from(channelOutcomeStats)
      .where(eq(channelOutcomeStats.providerChannelId, loser.id))
      .limit(1);
    expect(lost?.attempts).toBe(2);
    expect(lost?.successes).toBe(0);
    expect(lost?.medianMinutes).toBe(50);

    const columns = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'channel_outcome_stats' order by ordinal_position`,
    );
    expect(columns.map((row) => row.column_name)).toEqual([
      "provider_channel_id",
      "attempts",
      "successes",
      "median_minutes",
      "created_at",
      "updated_at",
    ]);
  });

  it("keeps only the last 50 durations per channel", async () => {
    expect(STATS_DURATION_WINDOW).toBe(50);
    const provider = await seedProvider();
    const channel = await seedChannel(provider.id);
    const valkey = new FakeValkey();
    for (let minute = 1; minute <= 50; minute++) {
      await valkey.lpush(`providers:stats:durations:${channel.id}`, String(minute));
    }
    await recordChannelOutcomes(
      { tried: [{ channelId: channel.id, durationMinutes: 100 }] },
      { db, valkey },
    );
    const kept = await valkey.lrange(`providers:stats:durations:${channel.id}`, 0, -1);
    expect(kept).toHaveLength(50);
    expect(kept).toContain("100");
    expect(kept).not.toContain("1");
  });

  it("rejects inconsistent input", async () => {
    const deps = { db, valkey: new FakeValkey() };
    await expect(recordChannelOutcomes({ tried: [] }, deps)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      recordChannelOutcomes(
        {
          tried: [{ channelId: "00000000-0000-0000-0000-000000000000", durationMinutes: 5 }],
          succeededChannelId: "00000000-0000-0000-0000-000000000001",
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      recordChannelOutcomes(
        {
          tried: [{ channelId: "00000000-0000-0000-0000-000000000000", durationMinutes: -1 }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
