import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright/test";
import { expect, test } from "playwright/test";

import { devSignIn, e2eAdminEmail } from "./dev-sign-in";
import { seedCaseRoute, seedDashboardCases } from "./seed-cases";

/** Public routes. Later tickets append theirs (plan 0008 A6). */
export const publicRoutes = ["/", "/sign-in", "/privacy", "/terms", "/refund", "/does-not-exist"];

/** Signed-in routes, visited as the E2E admin so `/admin` renders. */
export const appRoutes = [
  "/dashboard",
  "/cases/:seeded",
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

/** Light runs at every width; dark at the two ends (plan 0008 T17). */
const runs = [
  ...widths.map((size) => ({ ...size, scheme: "light" as const })),
  ...widths
    .filter(({ width }) => width !== 768)
    .map((size) => ({ ...size, scheme: "dark" as const })),
];

/** Known axe failures on pages not yet restyled. Each entry names the ticket that removes it. */
const knownAxeFailures: Record<string, string[]> = {
  // "/": [] // T7 (landing page)
};

const slug = (route: string) =>
  route === "/" ? "home" : route.slice(1).replaceAll("/", "_").replace(":", "");

/**
 * Controls in main, header and nav smaller than 44 x 44 px (B14). A link inside a
 * paragraph is exempt: WCAG 2.5.8 excepts targets in a sentence.
 */
function smallTargets(page: Page) {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="link"], [role="button"]';
    const found = new Set<Element>();
    for (const region of document.querySelectorAll("main, header, nav")) {
      for (const el of region.querySelectorAll(selector)) found.add(el);
    }
    return [...found]
      .filter((el) => {
        if (el.matches(":disabled, [aria-disabled='true']")) return false;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
        if (el.matches("a") && el.closest("p")) return false;
        const { width, height } = el.getBoundingClientRect();
        return width > 0 && height > 0 && (width < 44 || height < 44);
      })
      .map((el) => {
        const { width, height } = el.getBoundingClientRect();
        const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? "";
        return `${el.tagName.toLowerCase()} "${name}" ${Math.round(width)}x${Math.round(height)}`;
      });
  });
}

for (const route of [...publicRoutes, ...appRoutes]) {
  for (const { width, height, scheme } of runs) {
    const suffix = scheme === "dark" ? "-dark" : "";
    test(`${route} at ${width}px${suffix}`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      if (appRoutes.includes(route)) await devSignIn(context, baseURL, e2eAdminEmail);
      if (route === "/dashboard") await seedDashboardCases(e2eAdminEmail);
      const target = route.includes(":seeded")
        ? route.replace(":seeded", await seedCaseRoute(e2eAdminEmail))
        : route;
      await page.goto(target, { waitUntil: "networkidle" });
      await expect(page.getByText("Something went wrong")).toHaveCount(0);

      // Shot first, so a failing page still leaves its screenshot to inspect.
      await page.screenshot({
        path: `e2e/screenshots/${slug(route)}-${width}${suffix}.png`,
        fullPage: true,
      });

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

      expect(await smallTargets(page), "touch targets under 44 px").toEqual([]);
    });
  }
}
