import { defineConfig } from "playwright/test";

/** E2E config. `scripts/playwright-run.mjs` starts the server and sets PLAYWRIGHT_TEST_BASE_URL, which Playwright reads as baseURL. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  reporter: [["list"]],
});
