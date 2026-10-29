import { expect, test } from "playwright/test";

// B3 and B13: the landing page is complete without JavaScript and carries valid JSON-LD.
test.use({ javaScriptEnabled: false });

test("landing has every section, the price and legal links with JS off", async ({ page }) => {
  await page.goto("/");
  for (const name of [
    "How it works",
    "What RipCord will and won't do",
    "Consent and security",
    "Pricing",
    "Questions",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  await expect(page.getByRole("main")).toContainText("S$1.99");
  for (const href of ["/privacy", "/terms", "/refund"]) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeAttached();
  }
});

test("landing JSON-LD parses as Organization and FAQPage", async ({ page }) => {
  await page.goto("/");
  const blocks = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ""));
  const types = blocks.map((b) => (JSON.parse(b) as { "@type": string })["@type"]);
  expect(types.sort()).toEqual(["FAQPage", "Organization"]);
  const faq = JSON.parse(blocks.find((b) => b.includes("FAQPage")) ?? "{}") as {
    mainEntity: unknown[];
  };
  expect(faq.mainEntity.length).toBeGreaterThanOrEqual(5);
});
