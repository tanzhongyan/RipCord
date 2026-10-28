import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { scrapeRuns } from "~/server/db/schema";
import { logger } from "~/server/logger";
import { invalidateProviderSearchCache } from "../search";
import type { ProviderValkey } from "../valkey";
import { extractArticleText, findCandidateLinks } from "./extract";
import type { ExtractWithModel } from "./model";
import { filterExtractionByQuotes } from "./quotes";
import { loadRobots, type RobotsChecker } from "./robots";
import { upsertExtraction } from "./upsert";

export const MAX_PAGES_PER_PROVIDER = 25;
export const MAX_CRAWL_DEPTH = 2;
export const REQUEST_INTERVAL_MS = 1000;

export interface ScrapeChangeSummary {
  added: string[];
  changed: string[];
  removed: string[];
  skippedRobots: string[];
  pages: string[];
  modelCalls: number;
}

export interface ProviderScrapeResult {
  providerId: string;
  pagesFetched: number;
  changeSummary: ScrapeChangeSummary;
}

/** Exit code 0 exactly when every scraped provider processed a page. */
export function shouldExitZero(results: ProviderScrapeResult[]): boolean {
  return results.length > 0 && results.every((result) => result.pagesFetched > 0);
}

export interface ScrapeDeps {
  db: Database;
  valkey: ProviderValkey | null;
  fetchPage: (url: string) => Promise<string>;
  fetchText: (url: string) => Promise<string | null>;
  extractWithModel: ExtractWithModel;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface QueueEntry {
  url: string;
  depth: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scrape one provider: seed URLs first, then same-domain matching links to
 * depth 2, at most 25 pages. Every URL passes robots.txt, requests to one
 * domain stay a second apart, and each page's model output passes the
 * quote-verbatim check before it is upserted. Writes one `scrape_runs` row.
 */
export async function runProviderScrape(
  provider: { id: string; slug: string },
  seedUrls: string[],
  deps: ScrapeDeps,
): Promise<ProviderScrapeResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const summary: ScrapeChangeSummary = {
    added: [],
    changed: [],
    removed: [],
    skippedRobots: [],
    pages: [],
    modelCalls: 0,
  };

  const [run] = await deps.db
    .insert(scrapeRuns)
    .values({
      providerId: provider.id,
      startedAt: now(),
      finishedAt: null,
      status: "RUNNING",
      pagesFetched: 0,
      changeSummary: summary,
    })
    .returning({ id: scrapeRuns.id });
  if (!run) throw new Error(`scrape: could not open a run for ${provider.slug}`);

  const finish = async (status: "SUCCEEDED" | "FAILED"): Promise<ProviderScrapeResult> => {
    await deps.db
      .update(scrapeRuns)
      .set({
        status,
        finishedAt: now(),
        pagesFetched: summary.pages.length,
        changeSummary: summary,
      })
      .where(eq(scrapeRuns.id, run.id));
    return { providerId: provider.id, pagesFetched: summary.pages.length, changeSummary: summary };
  };

  try {
    const queue: QueueEntry[] = seedUrls.map((url) => ({ url, depth: 0 }));
    const visited = new Set<string>();
    const robotsByOrigin = new Map<string, RobotsChecker>();
    const lastFetchByOrigin = new Map<string, number>();

    while (queue.length > 0 && summary.pages.length < MAX_PAGES_PER_PROVIDER) {
      const next = queue.shift();
      if (!next || visited.has(next.url)) continue;
      visited.add(next.url);

      const origin = new URL(next.url).origin;
      let robots = robotsByOrigin.get(origin);
      if (!robots) {
        robots = await loadRobots(deps.fetchText, next.url);
        robotsByOrigin.set(origin, robots);
      }
      if (!robots.isAllowed(next.url)) {
        logger.info(`scrape: robots.txt skips ${next.url}`);
        summary.skippedRobots.push(next.url);
        continue;
      }

      const sinceLast = Date.now() - (lastFetchByOrigin.get(origin) ?? 0);
      if (sinceLast < REQUEST_INTERVAL_MS) await sleep(REQUEST_INTERVAL_MS - sinceLast);
      let html: string;
      try {
        html = await deps.fetchPage(next.url);
      } catch (error) {
        logger.warn(`scrape: fetch failed for ${next.url}: ${(error as Error).message}`);
        continue;
      }
      lastFetchByOrigin.set(origin, Date.now());
      summary.pages.push(next.url);

      if (next.depth < MAX_CRAWL_DEPTH) {
        for (const link of findCandidateLinks(html, next.url)) {
          if (!visited.has(link.url)) queue.push({ url: link.url, depth: next.depth + 1 });
        }
      }

      const article = extractArticleText(html);
      if (!article.text) continue;

      let extraction: Awaited<ReturnType<ExtractWithModel>>;
      try {
        extraction = await deps.extractWithModel({ url: next.url, text: article.text });
        summary.modelCalls += 1;
      } catch (error) {
        logger.warn(`scrape: model extraction failed for ${next.url}: ${(error as Error).message}`);
        continue;
      }
      const { extraction: checked, dropped } = filterExtractionByQuotes(extraction, article.text);
      for (const name of dropped) logger.info(`scrape: quote check drops ${name}`);
      const upserted = await upsertExtraction(deps.db, provider.id, next.url, checked, now());
      summary.added.push(...upserted.added);
      summary.changed.push(...upserted.changed);
    }

    if (deps.valkey && (summary.added.length > 0 || summary.changed.length > 0)) {
      await invalidateProviderSearchCache(deps.valkey, provider.id);
    }
    return await finish("SUCCEEDED");
  } catch (error) {
    logger.error(`scrape: run failed for ${provider.slug}: ${(error as Error).message}`);
    await finish("FAILED");
    throw error;
  }
}
