import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "playwright/test";

import { devSignIn, e2eAdminEmail } from "./dev-sign-in";
import { seedDashboardCases } from "./seed-cases";

/** Public routes. Later tickets append theirs (plan 0008 A6). */
export const publicRoutes = ["/", "/sign-in", "/privacy", "/terms", "/refund", "/does-not-exist"];

/** Signed-in routes, visited as the E2E admin so `/admin` renders. */
export const appRoutes = [
  "/dashboard",
  "/chat",
  "/billing",
  "/settings",
  "/settings/connected-agents",
  "/admin",
];

const widths = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

/** Known axe failures on pages not yet restyled. Each entry names the ticket that removes it. */
const knownAxeFailures: Record<string, string[]> = {
  // "/": [] // T7 (landing page)
};

const slug = (route: string) => (route === "/" ? "home" : route.slice(1).replaceAll("/", "_"));

for (const route of [...publicRoutes, ...appRoutes]) {
  for (const { width, height } of widths) {
    test(`${route} at ${width}px`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height });
      if (appRoutes.includes(route)) await devSignIn(context, baseURL, e2eAdminEmail);
      if (route === "/dashboard") await seedDashboardCases(e2eAdminEmail);
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
