#!/usr/bin/env node
// Build the app (unless E2E_REUSE_BUILD=1), start `next start` on a free port,
// run Playwright against it, then stop the server. Installs Chromium when missing.
// Usage: node scripts/playwright-run.mjs [playwright args]

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const require = createRequire(join(root, "package.json"));
const nodeRun = (args, env = {}) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

const { chromium } = require("playwright");
if (!existsSync(chromium.executablePath())) {
  console.log("playwright: installing chromium (one-time)");
  const withDeps = process.platform === "linux" ? ["--with-deps"] : [];
  nodeRun([join(root, "node_modules/playwright/cli.js"), "install", ...withDeps, "chromium"]);
}

if (process.env.E2E_REUSE_BUILD !== "1" || !existsSync(join(root, ".next/BUILD_ID"))) {
  const build = nodeRun([join(root, "scripts/build.mjs")]);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const baseURL = `http://127.0.0.1:${port}`;

// Public pages need no secrets, so production start skips environment validation.
// Signed-in tests mint sessions in the test process (e2e/dev-sign-in.ts), so the
// server and the tests share one throwaway secret, and the E2E admin is listed.
const e2eEnv = {
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-only-secret-0123456789abcdef0123",
  ADMIN_EMAILS: "e2e-admin@example.test",
};
const server = spawn(
  process.execPath,
  [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"],
  { cwd: root, stdio: "inherit", env: { ...process.env, ...e2eEnv, SKIP_ENV_VALIDATION: "1" } },
);

const stop = () => server.kill();
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

let status = 1;
try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(baseURL);
      break;
    } catch {
      if (i === 59) throw new Error("next start did not come up");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  status =
    nodeRun([join(root, "node_modules/playwright/cli.js"), "test", ...process.argv.slice(2)], {
      PLAYWRIGHT_TEST_BASE_URL: baseURL,
      ...e2eEnv,
    }).status ?? 1;
} finally {
  stop();
}
process.exit(status);
