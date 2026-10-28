import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

console.log("Setting up local development environment...");

if (!existsSync(".env") && existsSync(".env.example")) {
  copyFileSync(".env.example", ".env");
  console.log("[OK] Created .env from .env.example");
}

console.log("[Docker] Starting PostgreSQL service...");
execSync("docker compose up -d --wait", { stdio: "inherit" });

console.log("[Drizzle] Applying database migrations...");
execSync("bun run db:migrate", { stdio: "inherit" });

console.log("\n[READY] Environment is ready. Run 'bun run dev' to start Next.js.");
