import { expect, test } from "playwright/test";

for (const route of ["/privacy", "/sign-in"]) {
  test(`header mark on ${route} goes home`, async ({ page }) => {
    await page.goto(route);
    await page.getByRole("link", { name: "RipCord home" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
}

test("375px: menu button opens the nav", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/privacy");
  await expect(page.getByRole("link", { name: "Pricing" })).toBeHidden();
  const menu = page.getByRole("button", { name: "Open menu" });
  expect((await menu.boundingBox())?.width).toBeGreaterThanOrEqual(44);
  await menu.click();
  await expect(page.getByRole("link", { name: "Pricing" })).toBeVisible();
});

test("1280px: nav is inline and there is no menu button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/privacy");
  await expect(page.getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
});
