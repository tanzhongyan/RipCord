import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { providerChannels, providerPolicies, providers } from "~/server/db/schema";
import { invalidateProviderSearchCache } from "./search";
import type { ProviderValkey } from "./valkey";

export interface SeedProvider {
  slug: string;
  name: string;
  country: string;
  category: typeof providers.$inferInsert.category;
  website: string;
  /** Hand-picked help and terms pages where the scraper starts. */
  seedUrls: string[];
}

/**
 * The seed list carries identity only: slug, name, country, category,
 * website and starting URLs. Channel addresses, phone numbers and policies
 * are never seeded from memory; they arrive through a scrape run or an
 * admin edit, each with a `source_url`. `demo-telco` is the one exception:
 * RipCord's own mock provider, seeded in full below.
 */
export const SEED_PROVIDERS: SeedProvider[] = [
  {
    slug: "singtel",
    name: "Singtel",
    country: "SG",
    category: "MOBILE_POSTPAID",
    website: "https://www.singtel.com",
    seedUrls: [
      "https://www.singtel.com/personal/support",
      "https://www.singtel.com/personal/terms-and-conditions",
    ],
  },
  {
    slug: "starhub",
    name: "StarHub",
    country: "SG",
    category: "MOBILE_POSTPAID",
    website: "https://www.starhub.com",
    seedUrls: [
      "https://www.starhub.com/personal/support",
      "https://www.starhub.com/personal/terms-and-conditions",
    ],
  },
  {
    slug: "m1",
    name: "M1",
    country: "SG",
    category: "MOBILE_POSTPAID",
    website: "https://www.m1.com.sg",
    seedUrls: ["https://www.m1.com.sg/support", "https://www.m1.com.sg/terms-and-conditions"],
  },
  {
    slug: "sp-group",
    name: "SP Group",
    country: "SG",
    category: "UTILITY",
    website: "https://www.spgroup.com.sg",
    seedUrls: ["https://www.spgroup.com.sg/contact-us", "https://www.spgroup.com.sg/terms-of-use"],
  },
  {
    slug: "anytime-fitness-sg",
    name: "Anytime Fitness",
    country: "SG",
    category: "GYM",
    website: "https://www.anytimefitness.sg",
    seedUrls: [
      "https://www.anytimefitness.sg/contact/",
      "https://www.anytimefitness.sg/terms-and-conditions/",
    ],
  },
  {
    slug: "demo-telco",
    name: "Demo Telco",
    country: "SG",
    category: "MOBILE_POSTPAID",
    website: "https://demo-telco.test",
    seedUrls: ["https://demo-telco.test/cancel", "https://demo-telco.test/terms"],
  },
];

const DEMO_SOURCE_URL = "https://demo-telco.test/cancel";

export interface SeedCounts {
  providers: number;
  demoChannels: number;
  demoPolicies: number;
}

/**
 * Idempotent: providers upsert on slug, demo records upsert on their keys.
 * Every upserted provider's cached searches are cleared, since a seed is a
 * provider write like any other.
 */
export async function seedProviders(
  conn: Database,
  cache: ProviderValkey | null = null,
): Promise<SeedCounts> {
  for (const seed of SEED_PROVIDERS) {
    await conn
      .insert(providers)
      .values({
        slug: seed.slug,
        name: seed.name,
        country: seed.country,
        category: seed.category,
        website: seed.website,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: providers.slug,
        set: {
          name: seed.name,
          country: seed.country,
          category: seed.category,
          website: seed.website,
          updatedAt: new Date(),
        },
      });
  }

  const [demo] = await conn
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.slug, "demo-telco"))
    .limit(1);
  if (!demo) throw new Error("seedProviders: demo-telco missing after upsert");

  const now = new Date();
  const demoChannels: Array<typeof providerChannels.$inferInsert> = [
    {
      providerId: demo.id,
      serviceType: null,
      kind: "EMAIL",
      address: "cancel@demo-telco.test",
      ivrPath: null,
      hours: null,
      acceptsLoa: "YES",
      requiredDocuments: [],
      requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
      noticeDays: 30,
      isVerifiedDestination: true,
      sourceUrl: DEMO_SOURCE_URL,
      sourceQuote: "Email cancel@demo-telco.test at least 30 days before billing to cancel.",
      checkedAt: now,
      confidence: 100,
    },
    {
      providerId: demo.id,
      serviceType: null,
      kind: "PHONE_IVR",
      address: "+15005550006",
      ivrPath: [
        { prompt: "Main menu: press 3 to cancel a service", digits: "3" },
        { prompt: "Confirm cancellation: press 1", digits: "1" },
      ],
      hours: null,
      acceptsLoa: "YES",
      requiredDocuments: [],
      requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
      noticeDays: 30,
      isVerifiedDestination: true,
      sourceUrl: DEMO_SOURCE_URL,
      sourceQuote: "Call +15005550006 and press 3, then 1 to confirm cancellation.",
      checkedAt: now,
      confidence: 100,
    },
  ];
  for (const channel of demoChannels) {
    const [existing] = await conn
      .select({ id: providerChannels.id })
      .from(providerChannels)
      .where(
        and(
          eq(providerChannels.providerId, demo.id),
          isNull(providerChannels.serviceType),
          eq(providerChannels.kind, channel.kind),
          eq(providerChannels.address, channel.address),
        ),
      )
      .limit(1);
    if (existing) {
      await conn.update(providerChannels).set(channel).where(eq(providerChannels.id, existing.id));
    } else {
      await conn.insert(providerChannels).values(channel);
    }
  }

  const demoPolicies: Array<typeof providerPolicies.$inferInsert> = [
    {
      providerId: demo.id,
      serviceType: null,
      kind: "EARLY_TERMINATION_FEE",
      rule: { formula: "REMAINING_MONTHS_X_MONTHLY_FEE" },
      excerpt: "Early termination fee equals the remaining months multiplied by the monthly fee.",
      sourceUrl: DEMO_SOURCE_URL,
      checkedAt: now,
    },
    {
      providerId: demo.id,
      serviceType: null,
      kind: "MIN_TERM",
      rule: { months: 24 },
      excerpt: "Minimum contract term is 24 months.",
      sourceUrl: DEMO_SOURCE_URL,
      checkedAt: now,
    },
    {
      providerId: demo.id,
      serviceType: null,
      kind: "EQUIPMENT_RETURN",
      rule: { items: ["router"], within_days: 14 },
      excerpt: "Return the router within 14 days of cancellation.",
      sourceUrl: DEMO_SOURCE_URL,
      checkedAt: now,
    },
  ];
  for (const policy of demoPolicies) {
    const [existing] = await conn
      .select({ id: providerPolicies.id })
      .from(providerPolicies)
      .where(
        and(
          eq(providerPolicies.providerId, demo.id),
          isNull(providerPolicies.serviceType),
          eq(providerPolicies.kind, policy.kind),
        ),
      )
      .limit(1);
    if (existing) {
      await conn.update(providerPolicies).set(policy).where(eq(providerPolicies.id, existing.id));
    } else {
      await conn.insert(providerPolicies).values(policy);
    }
  }

  if (cache) {
    const rows = await conn
      .select({ id: providers.id })
      .from(providers)
      .where(
        inArray(
          providers.slug,
          SEED_PROVIDERS.map((seed) => seed.slug),
        ),
      );
    for (const row of rows) {
      await invalidateProviderSearchCache(cache, row.id);
    }
  }

  return { providers: SEED_PROVIDERS.length, demoChannels: demoChannels.length, demoPolicies: 3 };
}
