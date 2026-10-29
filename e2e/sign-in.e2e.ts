import type { Page } from "playwright/test";
import { expect, test } from "playwright/test";

import { e2eAdminEmail } from "./dev-sign-in";

const message = "If that email can sign in, we've sent a code.";

async function requestCode(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send login code" }).click();
  await expect(page.getByText(message)).toBeVisible({ timeout: 20_000 });
}

test("known and unknown emails get the same message", async ({ page }) => {
  await requestCode(page, e2eAdminEmail);
  await requestCode(page, `nobody-${Date.now()}@example.test`);
});

test("the code field asks for a one-time numeric code", async ({ page }) => {
  await requestCode(page, e2eAdminEmail);
  const code = page.getByLabel(/Login code/);
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
});
