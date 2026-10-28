import { eq } from "drizzle-orm";
import { createBrowserFetcher } from "../src/features/providers/server/scraper/fetcher";
import { extractWithModel } from "../src/features/providers/server/scraper/model";
import { SCRAPER_USER_AGENT } from "../src/features/providers/server/scraper/robots";
import {
  type ProviderScrapeResult,
  runProviderScrape,
  shouldExitZero,
} from "../src/features/providers/server/scraper/scrape";
import { SEED_PROVIDERS } from "../src/features/providers/server/seed";
import { valkey } from "../src/features/providers/server/valkey";
import { db } from "../src/server/db";
import { providers } from "../src/server/db/schema";

/**
 * Provider scraper CLI. `demo-telco` is skipped: its channels are seeded,
 * and its `.test` domain exists only in Mailpit and the sandbox.
 */
const SCRAPE_SLUGS = SEED_PROVIDERS.filter((seed) => seed.slug !== "demo-telco").map(
  (seed) => seed.slug,
);

function usage(): string {
  return `Usage: bun run scrape [--provider <slug>]\nSlugs: ${SCRAPE_SLUGS.join(", ")}`;
}

function parseArgs(argv: string[]): { slug: string | null } {
  const flag = argv.indexOf("--provider");
  if (flag === -1) return { slug: null };
  const slug = argv[flag + 1];
  if (!slug || slug.startsWith("--")) {
    console.error(`${usage()}\n--provider needs a slug.`);
    process.exit(2);
  }
  return { slug };
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { "user-agent": SCRAPER_USER_AGENT } });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

const { slug } = parseArgs(process.argv.slice(2));
const slugs = slug ? [slug] : SCRAPE_SLUGS;
const seeds = new Map(SEED_PROVIDERS.map((seed) => [seed.slug, seed]));
for (const wanted of slugs) {
  if (!seeds.has(wanted)) {
    console.error(`${usage()}\nUnknown provider slug: ${wanted}`);
    process.exit(2);
  }
}

const browser = await createBrowserFetcher();
const results: ProviderScrapeResult[] = [];
try {
  for (const wanted of slugs) {
    const seed = seeds.get(wanted);
    if (!seed) continue;
    const [row] = await db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.slug, wanted))
      .limit(1);
    if (!row) {
      console.error(`Provider '${wanted}' is not seeded. Run 'bun run db:seed' first.`);
      process.exit(1);
    }
    const result = await runProviderScrape({ id: row.id, slug: wanted }, seed.seedUrls, {
      db,
      valkey: valkey(),
      fetchPage: browser.fetchPage,
      fetchText,
      extractWithModel,
    });
    console.log(
      `Scraped ${wanted}: ${result.pagesFetched} pages, +${result.changeSummary.added.length}/~${result.changeSummary.changed.length} fields.`,
    );
    results.push(result);
  }
} finally {
  await browser.close();
}

process.exit(shouldExitZero(results) ? 0 : 1);
