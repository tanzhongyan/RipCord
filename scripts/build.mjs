#!/usr/bin/env node
// Production build wrapper. `next build` validates the environment in
// production mode, but compiling is not serving: fill placeholder secrets for
// unset production-only variables so the build can proceed. Real values set by
// the operator always win, and the running server validates the real
// environment on start.
import { spawnSync } from "node:child_process";

process.env.BETTER_AUTH_SECRET ||= "build-placeholder-secret-000000000000";
process.env.TWILIO_ACCOUNT_SID ||= "build-placeholder";
process.env.TWILIO_AUTH_TOKEN ||= "build-placeholder";
process.env.TWILIO_SMS_FROM ||= "build-placeholder";
// Zero-entropy placeholders: base64 for 32 zero bytes passes the key format check.
process.env.VAULT_MASTER_KEY ||= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.CRON_SECRET ||= "build-placeholder";
process.env.S3_ACCESS_KEY ||= "build-placeholder";
process.env.S3_SECRET_KEY ||= "build-placeholder";

const result = spawnSync("bun", ["x", "next", "build"], { stdio: "inherit" });
process.exit(result.status ?? 1);
