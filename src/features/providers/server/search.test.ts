import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import {
  getProvider,
  SEARCH_CACHE_TTL_SECONDS,
  SEARCH_MAX_RESULTS,
  SEARCH_RATE_LIMIT_PER_MINUTE,
  SEARCH_SIMILARITY_THRESHOLD,
  searchProviders,
} from "./search";
import { seedProviders } from "./seed";
import { callerFor, createCountingDb, FakeValkey, seedChannel, seedProvider } from "./test-support";
import { setValkeyOverride } from "./valkey";

describe("B1 Fuzzy search", () => {
  it("ranks singtel first for 'sing tel'", async () => {
    await seedProviders(db);
    const valkey = new FakeValkey();
    const counting = createCountingDb();
    try {
      const hits = await searchProviders(
        { query: "sing tel" },
        { ip: "b1-fuzzy" },
        { db: counting.db, valkey },
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(SEARCH_MAX_RESULTS);
      expect(SEARCH_MAX_RESULTS).toBe(5);
      expect(hits[0]?.slug).toBe("singtel");
      expect(SEARCH_SIMILARITY_THRESHOLD).toBe(0.3);
      for (const hit of hits) expect(hit.score).toBeGreaterThanOrEqual(SEARCH_SIMILARITY_THRESHOLD);
    } finally {
      await counting.close();
    }
  });

  it("filters by country", async () => {
    await seedProviders(db);
    const valkey = new FakeValkey();
    const hits = await searchProviders(
      { query: "sing tel", country: "SG" },
      { ip: "b1-country" },
      { db, valkey },
    );
    expect(hits[0]?.slug).toBe("singtel");
    const empty = await searchProviders(
      { query: "sing tel", country: "US" },
      { ip: "b1-country-us" },
      { db, valkey },
    );
    expect(empty).toEqual([]);
  });
});

describe("B2 Cache", () => {
  it("runs no SQL when the same search repeats within 10 minutes", async () => {
    await seedProviders(db);
    const valkey = new FakeValkey();
    const counting = createCountingDb();
    try {
      const deps = { db: counting.db, valkey };
      const first = await searchProviders({ query: "sing tel" }, { ip: "b2-cache" }, deps);
      expect(first.length).toBeGreaterThan(0);
      expect(counting.queries).toHaveLength(1);
      expect(await valkey.ttl("providers:search:sing tel")).toBe(SEARCH_CACHE_TTL_SECONDS);
      expect(SEARCH_CACHE_TTL_SECONDS).toBe(600);

      const before = counting.queries.length;
      const second = await searchProviders({ query: "sing tel" }, { ip: "b2-cache" }, deps);
      expect(second).toEqual(first);
      expect(counting.queries.length).toBe(before);

      const mixedCase = await searchProviders({ query: "SING TEL" }, { ip: "b2-cache" }, deps);
      expect(mixedCase).toEqual(first);
      expect(counting.queries.length).toBe(before);
    } finally {
      await counting.close();
    }
  });
});

describe("providers.get", () => {
  it("returns channels and policies in one query", async () => {
    const provider = await seedProvider();
    await seedChannel(provider.id, {
      isVerifiedDestination: false,
      confidence: 40,
      sourceQuote: "Email us to cancel.",
    });
    const valkey = new FakeValkey();
    const counting = createCountingDb();
    try {
      const detail = await getProvider({ id: provider.id }, { db: counting.db, valkey });
      expect(counting.queries).toHaveLength(1);
      expect(detail.slug).toBe(provider.slug);
      expect(detail.channels).toHaveLength(1);
      expect(detail.channels[0]?.verified).toBe(false);
      expect(detail.channels[0]?.sourceQuote).toBe("Email us to cancel.");
    } finally {
      await counting.close();
    }
  });

  it("returns NOT_FOUND for a missing provider", async () => {
    await expect(
      getProvider({ id: "00000000-0000-0000-0000-000000000000" }, { db, valkey: new FakeValkey() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("providers.search entry point", () => {
  it("is public and rate-limits per IP at 60/min", async () => {
    await seedProviders(db);
    const valkey = new FakeValkey();
    setValkeyOverride(valkey);
    try {
      const anonymous = callerFor(null, []);
      const hits = await anonymous.providers.search({ query: "sing tel" });
      expect(hits[0]?.slug).toBe("singtel");

      expect(SEARCH_RATE_LIMIT_PER_MINUTE).toBe(60);
      await valkey.set(
        "providers:search:rl:unknown",
        String(SEARCH_RATE_LIMIT_PER_MINUTE),
        "EX",
        60,
      );
      await expect(anonymous.providers.search({ query: "sing tel" })).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: expect.stringContaining("RATE_LIMITED"),
      });
    } finally {
      setValkeyOverride(null);
    }
  });

  it("rejects a query shorter than 2 characters", async () => {
    const valkey = new FakeValkey();
    setValkeyOverride(valkey);
    try {
      await expect(callerFor(null, []).providers.search({ query: "x" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    } finally {
      setValkeyOverride(null);
    }
  });
});
