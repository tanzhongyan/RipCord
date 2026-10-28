import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { providerChannels, providerPolicies, scrapeRuns } from "~/server/db/schema";
import { adminListReview } from "../admin";
import { FakeValkey, seedProvider } from "../test-support";
import { PAGE_TIMEOUT_MS } from "./fetcher";
import { type ModelExtraction, modelExtractionSchema } from "./model";
import {
  MAX_CRAWL_DEPTH,
  MAX_PAGES_PER_PROVIDER,
  REQUEST_INTERVAL_MS,
  runProviderScrape,
  type ScrapeChangeSummary,
  type ScrapeDeps,
  shouldExitZero,
} from "./scrape";

function emptySummary(): ScrapeChangeSummary {
  return { added: [], changed: [], removed: [], skippedRobots: [], pages: [], modelCalls: 0 };
}

const CANCEL_SENTENCE = "Email cancel@example.com at least 30 days before billing to cancel.";

function articlePage(
  title: string,
  paragraphs: string[],
  links: Array<{ href: string; text: string }> = [],
): string {
  const body = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("");
  const anchors = links.map((link) => `<a href="${link.href}">${link.text}</a>`).join(" ");
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}${anchors}</article></body></html>`;
}

interface PageFixtures {
  pages: Map<string, string>;
  requested: string[];
}

function pageServer(pages: Record<string, string>): PageFixtures {
  const fixtures: PageFixtures = { pages: new Map(Object.entries(pages)), requested: [] };
  return fixtures;
}

function testDeps(
  fixtures: PageFixtures,
  model: (url: string) => ModelExtraction,
  robotsBody: string | null = null,
): { deps: ScrapeDeps; valkey: FakeValkey; slept: number[]; modelCalls: string[] } {
  const valkey = new FakeValkey();
  const slept: number[] = [];
  const modelCalls: string[] = [];
  const deps: ScrapeDeps = {
    db,
    valkey,
    fetchPage: async (url: string) => {
      fixtures.requested.push(url);
      const html = fixtures.pages.get(url);
      if (html === undefined) throw new Error(`no fixture for ${url}`);
      return html;
    },
    fetchText: async (url: string) => (url.endsWith("/robots.txt") ? robotsBody : null),
    extractWithModel: async (page) => {
      modelCalls.push(page.url);
      return structuredClone(model(page.url));
    },
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
  return { deps, valkey, slept, modelCalls };
}

function emailExtraction(address: string, quote: string): ModelExtraction {
  return modelExtractionSchema.parse({
    channels: [
      {
        kind: "EMAIL",
        address,
        acceptsLoa: "YES",
        requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
        noticeDays: 30,
        confidence: 80,
        quote,
      },
    ],
    policies: [],
  });
}

describe("B5 robots.txt", () => {
  it("skips disallowed URLs and lists them in the change summary", async () => {
    const provider = await seedProvider();
    const fixtures = pageServer({
      "https://example.com/start": articlePage(
        "Start",
        [CANCEL_SENTENCE],
        [
          { href: "/help/cancel", text: "cancel help" },
          { href: "/cancel", text: "cancel here" },
        ],
      ),
      "https://example.com/cancel": articlePage("Cancel", [CANCEL_SENTENCE]),
      "https://example.com/help/cancel": articlePage("Help", [CANCEL_SENTENCE]),
    });
    const { deps } = testDeps(
      fixtures,
      () => emailExtraction(`b5-${randomUUID()}@example.com`, CANCEL_SENTENCE),
      "User-agent: *\nDisallow: /help\n",
    );

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    expect(fixtures.requested).not.toContain("https://example.com/help/cancel");
    expect(result.changeSummary.skippedRobots).toEqual(["https://example.com/help/cancel"]);
    expect(result.pagesFetched).toBe(2);

    const [run] = await db
      .select()
      .from(scrapeRuns)
      .where(eq(scrapeRuns.providerId, provider.id))
      .orderBy(desc(scrapeRuns.startedAt))
      .limit(1);
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.pagesFetched).toBe(2);
    expect(run?.changeSummary).toMatchObject({
      skippedRobots: ["https://example.com/help/cancel"],
    });
  });
});

describe("B3 Quote check", () => {
  it("drops a channel whose quote is absent from the page", async () => {
    const provider = await seedProvider();
    const ghostAddress = `ghost-${randomUUID()}@example.com`;
    const keptAddress = `kept-${randomUUID()}@example.com`;
    const fixtures = pageServer({
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE]),
    });
    const { deps } = testDeps(fixtures, () =>
      modelExtractionSchema.parse({
        channels: [
          {
            kind: "PHONE_IVR",
            address: ghostAddress,
            acceptsLoa: "UNKNOWN",
            confidence: 60,
            quote: "call the hotline at midnight",
          },
          {
            kind: "EMAIL",
            address: keptAddress,
            acceptsLoa: "YES",
            confidence: 80,
            quote: CANCEL_SENTENCE,
          },
        ],
        policies: [],
      }),
    );

    await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    const rows = await db
      .select({ address: providerChannels.address })
      .from(providerChannels)
      .where(eq(providerChannels.providerId, provider.id));
    const addresses = rows.map((row) => row.address);
    expect(addresses).toContain(keptAddress);
    expect(addresses).not.toContain(ghostAddress);
  });
});

describe("B4 Unverified by default", () => {
  it("saves scraped addresses unverified and lists them for review", async () => {
    const provider = await seedProvider();
    const address = `fresh-${randomUUID()}@example.com`;
    const fixtures = pageServer({
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE]),
    });
    const { deps } = testDeps(fixtures, () => emailExtraction(address, CANCEL_SENTENCE));

    await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    const [channel] = await db
      .select()
      .from(providerChannels)
      .where(eq(providerChannels.providerId, provider.id))
      .limit(1);
    expect(channel?.address).toBe(address);
    expect(channel?.isVerifiedDestination).toBe(false);
    expect(channel?.sourceQuote).toBe(CANCEL_SENTENCE);

    const review = await adminListReview({ db, valkey: new FakeValkey() });
    const listed = review.find((row) => row.id === channel?.id);
    expect(listed?.sourceQuote).toBe(CANCEL_SENTENCE);
    expect(listed?.sourceUrl).toBe("https://example.com/start");
  });

  it("never flips a verified destination back", async () => {
    const provider = await seedProvider();
    const address = `known-${randomUUID()}@example.com`;
    const [seeded] = await db
      .insert(providerChannels)
      .values({
        providerId: provider.id,
        serviceType: null,
        kind: "EMAIL",
        address,
        acceptsLoa: "YES",
        requiredDocuments: [],
        requiredSecrets: [],
        isVerifiedDestination: true,
        sourceUrl: "https://example.com/old",
        checkedAt: new Date(),
        confidence: 100,
      })
      .returning({ id: providerChannels.id });
    if (!seeded) throw new Error("channel seed failed");
    const fixtures = pageServer({
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE]),
    });
    const { deps } = testDeps(fixtures, () => emailExtraction(address, CANCEL_SENTENCE));

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    const [updated] = await db
      .select()
      .from(providerChannels)
      .where(eq(providerChannels.id, seeded.id))
      .limit(1);
    expect(updated?.isVerifiedDestination).toBe(true);
    expect(result.changeSummary.changed).toContain(`channel:${address}`);
  });
});

describe("F2 Removed fields", () => {
  it("reports dropped entries and nulled fields without deleting rows", async () => {
    const provider = await seedProvider();
    const address = `shrinking-${randomUUID()}@example.com`;
    const [seeded] = await db
      .insert(providerChannels)
      .values({
        providerId: provider.id,
        serviceType: null,
        kind: "EMAIL",
        address,
        ivrPath: [{ prompt: "Press 1", digits: "1" }],
        hours: { mon: "9-5" },
        acceptsLoa: "YES",
        requiredDocuments: ["BILL"],
        requiredSecrets: ["FULL_NAME", "NRIC"],
        noticeDays: 30,
        isVerifiedDestination: false,
        sourceUrl: "https://example.com/old",
        sourceQuote: "Old quote.",
        checkedAt: new Date(),
        confidence: 80,
      })
      .returning({ id: providerChannels.id });
    if (!seeded) throw new Error("channel seed failed");
    await db.insert(providerPolicies).values({
      providerId: provider.id,
      serviceType: null,
      kind: "MIN_TERM",
      rule: { months: 24, grace_days: 7 },
      excerpt: "Minimum term is 24 months.",
      sourceUrl: "https://example.com/old",
      checkedAt: new Date(),
    });
    const termSentence = "The minimum term is 24 months.";
    const fixtures = pageServer({
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE, termSentence]),
    });
    const { deps } = testDeps(fixtures, () =>
      modelExtractionSchema.parse({
        channels: [
          {
            kind: "EMAIL",
            address,
            acceptsLoa: "YES",
            requiredSecrets: ["FULL_NAME"],
            confidence: 80,
            quote: CANCEL_SENTENCE,
          },
        ],
        policies: [
          {
            kind: "MIN_TERM",
            rule: { months: 24 },
            excerpt: "Minimum term is 24 months.",
            confidence: 70,
            quote: termSentence,
          },
        ],
      }),
    );

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    expect(result.changeSummary.removed.sort()).toEqual(
      [
        `channel:${address}:requiredDocuments`,
        `channel:${address}:requiredSecrets`,
        `channel:${address}:ivrPath`,
        `channel:${address}:hours`,
        `channel:${address}:noticeDays`,
        "policy:MIN_TERM:rule",
      ].sort(),
    );
    expect(result.changeSummary.changed).toContain(`channel:${address}`);
    expect(result.changeSummary.changed).toContain("policy:MIN_TERM");

    const [updated] = await db
      .select()
      .from(providerChannels)
      .where(eq(providerChannels.id, seeded.id))
      .limit(1);
    expect(updated?.requiredSecrets).toEqual(["FULL_NAME"]);
    expect(updated?.noticeDays).toBeNull();
  });
});

describe("crawl budget", () => {
  it("stops at 25 pages and depth 2, pacing one request per second", async () => {
    expect(MAX_PAGES_PER_PROVIDER).toBe(25);
    expect(MAX_CRAWL_DEPTH).toBe(2);
    expect(REQUEST_INTERVAL_MS).toBe(1000);
    expect(PAGE_TIMEOUT_MS).toBe(20_000);
    const provider = await seedProvider();
    const links = Array.from({ length: 30 }, (_, index) => ({
      href: `/p-${index}`,
      text: `cancel option ${index}`,
    }));
    const pages: Record<string, string> = {
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE], links),
    };
    for (let index = 0; index < 30; index++) {
      pages[`https://example.com/p-${index}`] = articlePage(`Page ${index}`, [
        `Filler paragraph ${index} with enough words to read.`,
      ]);
    }
    const fixtures = pageServer(pages);
    const { deps, slept, modelCalls } = testDeps(fixtures, () =>
      modelExtractionSchema.parse({ channels: [], policies: [] }),
    );

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    expect(result.pagesFetched).toBe(25);
    expect(fixtures.requested).toHaveLength(25);
    expect(modelCalls).toHaveLength(25);
    expect(slept.length).toBeGreaterThan(0);
    for (const ms of slept) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(REQUEST_INTERVAL_MS);
    }
  });

  it("does not follow links past depth 2", async () => {
    const provider = await seedProvider();
    const fixtures = pageServer({
      "https://example.com/start": articlePage(
        "Start",
        [CANCEL_SENTENCE],
        [{ href: "/d1", text: "cancel level 1" }],
      ),
      "https://example.com/d1": articlePage(
        "D1",
        [CANCEL_SENTENCE],
        [{ href: "/d2", text: "cancel level 2" }],
      ),
      "https://example.com/d2": articlePage(
        "D2",
        [CANCEL_SENTENCE],
        [{ href: "/d3", text: "cancel level 3" }],
      ),
      "https://example.com/d3": articlePage("D3", [CANCEL_SENTENCE]),
    });
    const { deps } = testDeps(fixtures, () =>
      modelExtractionSchema.parse({ channels: [], policies: [] }),
    );

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    expect(result.pagesFetched).toBe(3);
    expect(fixtures.requested).not.toContain("https://example.com/d3");
  });
});

describe("scrape resilience", () => {
  it("keeps the run green when the model is unavailable", async () => {
    const provider = await seedProvider();
    const fixtures = pageServer({
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE]),
    });
    const { deps } = testDeps(fixtures, () => {
      throw new Error("Model extraction is not wired until spec 0004");
    });

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    expect(result.pagesFetched).toBe(1);
    expect(result.changeSummary.modelCalls).toBe(0);
    const [run] = await db
      .select({ status: scrapeRuns.status })
      .from(scrapeRuns)
      .where(eq(scrapeRuns.providerId, provider.id))
      .orderBy(desc(scrapeRuns.startedAt))
      .limit(1);
    expect(run?.status).toBe("SUCCEEDED");
  });

  it("skips model calls for pages without article text", async () => {
    const provider = await seedProvider();
    const fixtures = pageServer({ "https://example.com/empty": "<html><body></body></html>" });
    const { deps, modelCalls } = testDeps(fixtures, () =>
      modelExtractionSchema.parse({ channels: [], policies: [] }),
    );

    const result = await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/empty"],
      deps,
    );

    expect(result.pagesFetched).toBe(1);
    expect(modelCalls).toHaveLength(0);
  });

  it("clears the provider cache when fields change", async () => {
    const provider = await seedProvider();
    const fixtures = pageServer({
      "https://example.com/start": articlePage("Start", [CANCEL_SENTENCE]),
    });
    const address = `cache-${randomUUID()}@example.com`;
    const { deps, valkey } = testDeps(fixtures, () => emailExtraction(address, CANCEL_SENTENCE));
    await valkey.set("providers:search:stale", "[]", "EX", 600);
    await valkey.sadd(`providers:search:idx:${provider.id}`, "providers:search:stale");

    await runProviderScrape(
      { id: provider.id, slug: provider.slug },
      ["https://example.com/start"],
      deps,
    );

    expect(await valkey.get("providers:search:stale")).toBeNull();
    expect(await valkey.smembers(`providers:search:idx:${provider.id}`)).toEqual([]);
  });
});

describe("shouldExitZero", () => {
  it("needs every provider to process a page", () => {
    expect(shouldExitZero([])).toBe(false);
    expect(
      shouldExitZero([{ providerId: "a", pagesFetched: 0, changeSummary: emptySummary() }]),
    ).toBe(false);
    expect(
      shouldExitZero([
        { providerId: "a", pagesFetched: 1, changeSummary: emptySummary() },
        { providerId: "b", pagesFetched: 3, changeSummary: emptySummary() },
      ]),
    ).toBe(true);
  });
});
