import { type Browser, chromium } from "playwright";

import { SCRAPER_USER_AGENT } from "./robots";

export const PAGE_TIMEOUT_MS = 20_000;

export interface BrowserFetcher {
  fetchPage: (url: string) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * One headless Chromium for a scrape run. Provider help pages render with
 * JavaScript, so each page loads to network idle with a 20 s timeout.
 * Tests never touch this; they inject a fake `fetchPage`.
 */
export async function createBrowserFetcher(): Promise<BrowserFetcher> {
  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: SCRAPER_USER_AGENT });
  return {
    fetchPage: async (url: string): Promise<string> => {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT_MS });
        return await page.content();
      } finally {
        await page.close();
      }
    },
    close: async (): Promise<void> => {
      await context.close();
      await browser.close();
    },
  };
}
