import { expect, test } from "playwright/test";

import { devSignIn } from "./dev-sign-in";
import { seedCaseRoute } from "./seed-cases";

// Its own user: two files signing the same email in at once would overwrite each other's one-time code.
const caseChatEmail = "e2e-case-chat@example.test";

test("375px: the case chat sheet fills the viewport, posts the case id and shows the confirm card", async ({
  page,
  context,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await devSignIn(context, baseURL, caseChatEmail);
  await page.goto("/dashboard"); // creates the user row the seed needs
  const caseId = await seedCaseRoute(caseChatEmail);
  // The model is never called: the stream is canned with one write tool awaiting confirmation.
  const bodies: Array<{ caseId?: string }> = [];
  await page.route("**/api/chat", (route) => {
    bodies.push(route.request().postDataJSON());
    const events = [
      {
        type: "confirm_request",
        callId: "call-1",
        name: "withdraw_case",
        summary: "Withdraw this case",
        args: { caseId },
      },
      { type: "done" },
    ];
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });
  await page.goto(`/cases/${caseId}`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Ask about this case" }).click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toBeVisible();
  await expect
    .poll(async () => (await sheet.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(375);
  expect((await sheet.boundingBox())?.height).toBeGreaterThanOrEqual(812);

  const composer = sheet.getByLabel("Chat message");
  await composer.fill("What is happening?");
  await composer.press("Enter");
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]?.caseId).toBe(caseId);
  await expect(sheet.getByLabel("Confirm withdraw_case")).toBeVisible();
});
