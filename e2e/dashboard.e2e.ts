import { expect, test } from "playwright/test";

import { devSignIn } from "./dev-sign-in";
import { seedDashboardCases } from "./seed-cases";

const newUser = () => `e2e-dash-${Date.now()}@example.test`;

test("375px: cases render as cards, not a table", async ({ page, context, baseURL }) => {
  const email = newUser();
  await page.setViewportSize({ width: 375, height: 812 });
  await devSignIn(context, baseURL, email);
  await seedDashboardCases(email);
  await page.goto("/dashboard");
  await expect(page.getByRole("table")).toBeHidden();
  const cards = page.locator("ul >> [data-slot='card']");
  await expect(cards).toHaveCount(3);
  await expect(cards.first().getByRole("link", { name: "Mum" })).toBeVisible();
});

test("1280px: cases render as a table, not cards", async ({ page, context, baseURL }) => {
  const email = newUser();
  await page.setViewportSize({ width: 1280, height: 800 });
  await devSignIn(context, baseURL, email);
  await seedDashboardCases(email);
  await page.goto("/dashboard");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(page.locator("ul >> [data-slot='card']").first()).toBeHidden();
});

test("a new user sees the start card and its CTA goes to /chat", async ({
  page,
  context,
  baseURL,
}) => {
  await devSignIn(context, baseURL, newUser());
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Start your first cancellation" })).toBeVisible();
  await page.getByRole("link", { name: "Start a cancellation" }).click();
  await expect(page).toHaveURL(/\/chat$/);
});
