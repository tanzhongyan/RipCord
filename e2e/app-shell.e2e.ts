import type { Page } from "playwright/test";
import { expect, test } from "playwright/test";

import { devSignIn, e2eAdminEmail } from "./dev-sign-in";

const widths = [375, 1280];
const plainUser = () => `e2e-user-${Date.now()}@example.test`;

/** Below md the nav lives in a slide-out sheet; open it first. */
async function openNav(page: Page, width: number) {
  if (width < 768) await page.getByRole("button", { name: "Open menu" }).click();
}

async function clickNav(page: Page, width: number, name: string) {
  await openNav(page, width);
  await page.getByRole("link", { name, exact: true }).click();
}

test("signed-out visitors are sent to /sign-in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/);
});

for (const width of widths) {
  test(`${width}px: a signed-in user reaches every app route by clicking`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await devSignIn(context, baseURL, e2eAdminEmail);
    await page.goto("/dashboard");

    for (const [name, path] of [
      ["Chat", "/chat"],
      ["Billing", "/billing"],
      ["Settings", "/settings"],
      ["Admin", "/admin"],
      ["Dashboard", "/dashboard"],
    ] as const) {
      await clickNav(page, width, name);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }

    await clickNav(page, width, "Settings");
    await page.getByRole("link", { name: "Manage" }).click();
    await expect(page).toHaveURL(/\/settings\/connected-agents$/);

    // Connected agents belong to Settings, which stays the active item.
    await openNav(page, width);
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByRole("link", { name: "RipCord home" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
}

test("a non-admin sees no Admin item and gets a 404 at /admin", async ({
  page,
  context,
  baseURL,
}) => {
  await devSignIn(context, baseURL, plainUser());
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
});

test("375px: the sidebar slides out from the trigger", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await devSignIn(context, baseURL, plainUser());
  await page.goto("/dashboard");

  const sidebar = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await expect(sidebar).toBeHidden();
  const trigger = page.getByRole("button", { name: "Open menu" });
  expect((await trigger.boundingBox())?.width).toBeGreaterThanOrEqual(44);
  await trigger.click();
  await expect(sidebar).toBeVisible();
  // Wait for the slide-in to finish: the panel rests at the left edge.
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);
  expect((await sidebar.boundingBox())?.width).toBeLessThan(375);
  await expect(sidebar.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
});

test("1280px: the sidebar is fixed and there is no trigger", async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await devSignIn(context, baseURL, plainUser());
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
});
