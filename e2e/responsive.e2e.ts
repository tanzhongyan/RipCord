import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "playwright/test";

/** Public routes. Later tickets append theirs (plan 0008 A6). */
export const publicRoutes = ["/", "/sign-in", "/does-not-exist"];

/**
 * Signed-in routes. Empty until T9 adds the app shell and a dev sign-in helper.
 * Add the sign-in step in the test body when the first route is added.
 */
export const appRoutes: string[] = [];

const widths = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

/** Known axe failures on pages not yet restyled. Each entry names the ticket that removes it. */
const knownAxeFailures: Record<string, string[]> = {
  // "/": [] // T7 (landing page)
  // "/sign-in": [] // T8 (sign-in page)
  // "/does-not-exist": [] // T5 (404 page)
};

const slug = (route: string) => (route === "/" ? "home" : route.slice(1).replaceAll("/", "_"));

for (const route of [...publicRoutes, ...appRoutes]) {
  for (const { width, height } of widths) {
    test(`${route} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      // T9: for appRoutes, run the dev sign-in helper here before goto.
      await page.goto(route, { waitUntil: "networkidle" });

      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth, "page overflows horizontally").toBeLessThanOrEqual(innerWidth);

      const known = knownAxeFailures[route] ?? [];
      const { violations } = await new AxeBuilder({ page }).analyze();
      const blocking = violations.filter(
        (v) => (v.impact === "serious" || v.impact === "critical") && !known.includes(v.id),
      );
      expect(blocking.map((v) => `${v.id} (${v.impact})`)).toEqual([]);

      await page.screenshot({
        path: `e2e/screenshots/${slug(route)}-${width}.png`,
        fullPage: true,
      });
    });
  }
}
