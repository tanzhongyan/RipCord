import { expect, test } from "playwright/test";

import { devSignIn, e2eAdminEmail } from "./dev-sign-in";

const longUrl = `https://example.test/${"cancel-service-".repeat(20)}end`;

test("375px: composer focus does not zoom and a long URL does not overflow", async ({
  page,
  context,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await devSignIn(context, baseURL, e2eAdminEmail);
  // The model is never called: the stream is canned.
  await page.route("**/api/chat", (route) => {
    const events = [
      {
        type: "token",
        text: `See [${longUrl}](${longUrl}) or ${longUrl}\n\n\`\`\`\n${"x".repeat(300)}\n\`\`\``,
      },
      { type: "done" },
    ];
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });
  await page.goto("/chat", { waitUntil: "networkidle" });

  const composer = page.getByLabel("Chat message");
  await composer.focus();
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await expect(composer).toBeInViewport({ ratio: 1 });

  await composer.fill("Where do I cancel?");
  await composer.press("Enter");
  const link = page.getByRole("link", { name: longUrl });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  await expect(composer).toBeInViewport({ ratio: 1 });
});
