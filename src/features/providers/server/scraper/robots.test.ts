import { describe, expect, it } from "vitest";

import { loadRobots, parseRobots, SCRAPER_USER_AGENT } from "./robots";

describe("robots.txt", () => {
  it("uses the RipCord user agent", () => {
    expect(SCRAPER_USER_AGENT).toBe("RipCordBot/1.0 (+https://github.com/tanzhongyan/RipCord)");
  });

  it("honours disallow rules", () => {
    const robots = parseRobots(
      "https://example.com/robots.txt",
      "User-agent: *\nDisallow: /help\n",
    );
    expect(robots.isAllowed("https://example.com/cancel")).toBe(true);
    expect(robots.isAllowed("https://example.com/help/closing")).toBe(false);
  });

  it("allows everything when robots.txt is missing or broken", async () => {
    const missing = await loadRobots(async () => null, "https://example.com/start");
    expect(missing.isAllowed("https://example.com/help")).toBe(true);
    const broken = await loadRobots(async () => {
      throw new Error("network down");
    }, "https://example.com/start");
    expect(broken.isAllowed("https://example.com/help")).toBe(true);
  });

  it("fetches robots.txt from the domain root", async () => {
    const requested: string[] = [];
    const robots = await loadRobots(async (url) => {
      requested.push(url);
      return "User-agent: *\nDisallow: /help\n";
    }, "https://example.com/deep/start");
    expect(requested).toEqual(["https://example.com/robots.txt"]);
    expect(robots.isAllowed("https://example.com/help")).toBe(false);
  });
});
