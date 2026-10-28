import robotsParser from "robots-parser";

export const SCRAPER_USER_AGENT = "RipCordBot/1.0 (+https://github.com/tanzhongyan/RipCord)";

export interface RobotsChecker {
  isAllowed(url: string): boolean;
}

/** Parse one robots.txt body into a checker for our user agent. */
export function parseRobots(robotsUrl: string, body: string): RobotsChecker {
  const robots = robotsParser(robotsUrl, body);
  return {
    isAllowed(url: string): boolean {
      return robots.isAllowed(url, SCRAPER_USER_AGENT) !== false;
    },
  };
}

/** Fetch a domain's robots.txt; missing or broken files allow everything. */
export async function loadRobots(
  fetchText: (url: string) => Promise<string | null>,
  pageUrl: string,
): Promise<RobotsChecker> {
  const robotsUrl = new URL("/robots.txt", pageUrl).href;
  try {
    const body = await fetchText(robotsUrl);
    if (body === null) return { isAllowed: () => true };
    return parseRobots(robotsUrl, body);
  } catch {
    return { isAllowed: () => true };
  }
}
