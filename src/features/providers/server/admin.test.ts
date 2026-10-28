import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { db } from "~/server/db";
import { auditLogs, providerChannels } from "~/server/db/schema";
import { adminChannelPatchSchema } from "../index";
import { adminListReview, parseAdminEmails, requireAdmin } from "./admin";
import { searchProviders } from "./search";
import {
  callerFor,
  createCountingDb,
  FakeValkey,
  seedChannel,
  seedProvider,
  seedUser,
} from "./test-support";
import { setValkeyOverride } from "./valkey";

afterEach(() => {
  setValkeyOverride(null);
});

describe("B7 Admin only", () => {
  it("rejects adminUpdateChannel for a non-admin with FORBIDDEN", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const channel = await seedChannel(provider.id);
    const valkey = new FakeValkey();
    setValkeyOverride(valkey);
    try {
      await expect(
        callerFor(user.id, []).providers.adminUpdateChannel({
          channelId: channel.id,
          patch: { confidence: 10 },
          verify: false,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      setValkeyOverride(null);
    }
  });

  it("rejects adminListReview for a non-admin with FORBIDDEN", async () => {
    const user = await seedUser();
    const valkey = new FakeValkey();
    setValkeyOverride(valkey);
    try {
      await expect(callerFor(user.id, []).providers.adminListReview()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } finally {
      setValkeyOverride(null);
    }
  });

  it("lets a Better Auth admin update a channel, audit it and clear cache", async () => {
    const admin = await seedUser({ role: "admin" });
    const provider = await seedProvider({ slug: `admin-kb-${Date.now()}` });
    const channel = await seedChannel(provider.id, {
      isVerifiedDestination: false,
      confidence: 40,
      address: "suggest@example.com",
    });
    const valkey = new FakeValkey();
    const counting = createCountingDb();
    try {
      const searchDeps = { db: counting.db, valkey };
      await searchProviders({ query: provider.slug }, { ip: "b7-admin" }, searchDeps);
      const cachedQueries = counting.queries.length;
      expect(cachedQueries).toBeGreaterThan(0);

      setValkeyOverride(valkey);
      const result = await callerFor(admin.id, []).providers.adminUpdateChannel({
        channelId: channel.id,
        patch: { confidence: 95, address: "cancel@example.com" },
        verify: true,
      });
      expect(result).toEqual({ id: channel.id, verified: true });

      const [updated] = await db
        .select()
        .from(providerChannels)
        .where(eq(providerChannels.id, channel.id))
        .limit(1);
      expect(updated?.isVerifiedDestination).toBe(true);
      expect(updated?.address).toBe("cancel@example.com");
      expect(updated?.confidence).toBe(95);

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.action, "PROVIDER_CHANNEL_UPDATED"), eq(auditLogs.targetId, channel.id)),
        )
        .limit(1);
      expect(audit?.actorType).toBe("ADMIN");
      expect(audit?.actorId).toBe(admin.id);

      await searchProviders({ query: provider.slug }, { ip: "b7-admin" }, searchDeps);
      expect(counting.queries.length).toBeGreaterThan(cachedQueries);
    } finally {
      setValkeyOverride(null);
      await counting.close();
    }
  });
});

describe("ADMIN_EMAILS first admin", () => {
  it("parses comma-separated emails", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails("boss@example.com, Ops@Example.com ,")).toEqual([
      "boss@example.com",
      "ops@example.com",
    ]);
  });

  it("admits a listed email without the admin role", async () => {
    const user = await seedUser();
    vi.stubEnv("ADMIN_EMAILS", user.email);
    vi.resetModules();
    try {
      const fresh = await import("./admin");
      await fresh.requireAdmin({ db, valkey: new FakeValkey() }, user.id);
      await expect(
        fresh.requireAdmin({ db, valkey: new FakeValkey() }, "no-such-user"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("fails closed without the role or the listing", async () => {
    const user = await seedUser();
    await expect(requireAdmin({ db, valkey: new FakeValkey() }, user.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("admin channel patch", () => {
  it("rejects the verified flag: only `verify` may set it", () => {
    expect(adminChannelPatchSchema.parse({ confidence: 10 })).toEqual({ confidence: 10 });
    expect(() => adminChannelPatchSchema.parse({ isVerifiedDestination: true })).toThrow();
  });
});

describe("adminListReview", () => {
  it("lists unverified and low-confidence channels with their source", async () => {
    const provider = await seedProvider();
    const unverified = await seedChannel(provider.id, {
      isVerifiedDestination: false,
      confidence: 90,
      sourceQuote: "Email us to cancel.",
    });
    const shaky = await seedChannel(provider.id, {
      isVerifiedDestination: true,
      confidence: 50,
    });
    const trusted = await seedChannel(provider.id, {
      isVerifiedDestination: true,
      confidence: 90,
    });
    const rows = await adminListReview({ db, valkey: new FakeValkey() });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(unverified.id);
    expect(ids).toContain(shaky.id);
    expect(ids).not.toContain(trusted.id);
    const first = rows.find((row) => row.id === unverified.id);
    expect(first?.providerSlug).toBe(provider.slug);
    expect(first?.sourceUrl).toBe("https://provider.example.com/cancel");
    expect(first?.sourceQuote).toBe("Email us to cancel.");
    expect(first?.verified).toBe(false);
  });
});
