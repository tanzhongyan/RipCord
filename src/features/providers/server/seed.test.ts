import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { providerChannels, providerPolicies, providers } from "~/server/db/schema";
import { SEED_PROVIDERS, seedProviders } from "./seed";

describe("seed list", () => {
  it("carries identity only, never addresses or policies", () => {
    expect(SEED_PROVIDERS.map((seed) => seed.slug)).toEqual([
      "singtel",
      "starhub",
      "m1",
      "sp-group",
      "anytime-fitness-sg",
      "demo-telco",
    ]);
    for (const seed of SEED_PROVIDERS) {
      expect(Object.keys(seed).sort()).toEqual(
        ["category", "country", "name", "seedUrls", "slug", "website"].sort(),
      );
      expect(seed.seedUrls.length).toBeGreaterThan(0);
    }
  });
});

describe("B6 Demo provider", () => {
  it("seeds verified demo-telco channels and policies, idempotently", async () => {
    const first = await seedProviders(db);
    expect(first).toEqual({ providers: 6, demoChannels: 2, demoPolicies: 3 });
    const second = await seedProviders(db);
    expect(second).toEqual(first);

    const [demo] = await db
      .select()
      .from(providers)
      .where(eq(providers.slug, "demo-telco"))
      .limit(1);
    expect(demo).toBeDefined();
    if (!demo) return;

    const channels = await db
      .select()
      .from(providerChannels)
      .where(eq(providerChannels.providerId, demo.id));
    expect(channels).toHaveLength(2);

    const email = channels.find((channel) => channel.kind === "EMAIL");
    expect(email?.address).toBe("cancel@demo-telco.test");
    expect(email?.isVerifiedDestination).toBe(true);

    const ivr = channels.find((channel) => channel.kind === "PHONE_IVR");
    if (!ivr) throw new Error("demo PHONE_IVR channel missing");
    expect(ivr.address).toBe("+15005550006");
    expect(ivr.isVerifiedDestination).toBe(true);
    expect(Array.isArray(ivr.ivrPath) && (ivr.ivrPath as unknown[]).length > 0).toBe(true);

    for (const channel of channels) {
      expect(channel.acceptsLoa).toBe("YES");
      expect(channel.requiredSecrets).toEqual(["FULL_NAME", "NRIC", "ACCOUNT_NO"]);
      expect(channel.noticeDays).toBe(30);
    }

    const policies = await db
      .select()
      .from(providerPolicies)
      .where(eq(providerPolicies.providerId, demo.id));
    expect(policies).toHaveLength(3);
    const byKind = new Map(policies.map((policy) => [policy.kind, policy]));
    expect(byKind.get("EARLY_TERMINATION_FEE")?.rule).toEqual({
      formula: "REMAINING_MONTHS_X_MONTHLY_FEE",
    });
    expect(byKind.get("MIN_TERM")?.rule).toEqual({ months: 24 });
    expect(byKind.get("EQUIPMENT_RETURN")?.rule).toEqual({ items: ["router"], within_days: 14 });
  });

  it("upserts provider identity without touching other providers", async () => {
    await seedProviders(db);
    const [singtel] = await db
      .select()
      .from(providers)
      .where(and(eq(providers.slug, "singtel"), eq(providers.country, "SG")))
      .limit(1);
    expect(singtel?.name).toBe("Singtel");
    expect(singtel?.category).toBe("MOBILE_POSTPAID");
  });
});
