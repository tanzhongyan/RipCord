# RipCord

[![CI](https://github.com/tanzhongyan/RipCord/actions/workflows/ci.yml/badge.svg)](https://github.com/tanzhongyan/RipCord/actions/workflows/ci.yml)
[![CodeQL](https://github.com/tanzhongyan/RipCord/actions/workflows/codeql.yml/badge.svg)](https://github.com/tanzhongyan/RipCord/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A GitHub template for a typed web app: Next.js, tRPC, Drizzle on PostgreSQL, Tailwind and shadcn/ui. It is for developers and coding agents who start a new product and want working gates, feature folders and a tenant-safe example on day one.

## Quick start

Install [Bun](https://bun.sh), [Docker](https://docs.docker.com/get-docker/), Node.js 22 or later and GNU make. On Windows, install make with `winget install ezwinports.make` and restart your terminal and agent. Then run:

```bash
gh repo clone tanzhongyan/RipCord
cd RipCord
make setup
bun run dev:setup
make dev
```

`make setup` installs dependencies and git hooks. `bun run dev:setup` copies `.env.example` to `.env`, starts PostgreSQL, Valkey, Mailpit and MinIO, and creates the tables. `make dev` prints `Ready` and serves <http://localhost:3000>.

Sign in on the home page with an email code. In development the code lands in Mailpit at <http://localhost:8025>, and holder SMS is logged to the server console.

## What you get

- Next.js 16 App Router, React 19, TypeScript strict mode.
- tRPC 11 with Zod input validation and the identity feature under `src/features/identity/`.
- Drizzle ORM and generated SQL migrations in `drizzle/`.
- Tailwind CSS 4 and shadcn/ui primitives in `src/shared/components/ui/`.
- Six gates in `make check`: typecheck, Biome, Vitest, knip, fallow, ast-grep. Import boundaries between layers are ast-grep rules.
- CI with CodeQL, secret scanning, dependency audit and a weekly ZAP baseline scan.

## After creating your repo

1. Run the **Initialize Template Repository** workflow from the Actions tab. It renames the placeholders and opens a "Template follow-ups" issue.
2. Run `make template-debt`. You see one line per `TEMPLATE-TODO` marker you must resolve.

## Configuration

Copy `.env.example` to `.env`. The schema is in `src/shared/config/env.js`.

| Variable             | Required      | Default                           | Description                                                                       |
| -------------------- | ------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`       | Yes           | none                              | PostgreSQL connection string                                                      |
| `POSTGRES_PORT`      | No            | `5432`                            | Host port for the compose PostgreSQL service; keep it in step with `DATABASE_URL` |
| `BETTER_AUTH_SECRET` | In production | none (dev default)                | Secret for sessions and OTP hashes; generate 32+ random bytes                     |
| `BETTER_AUTH_URL`    | No            | `http://localhost:3000`           | Public base URL of this app; set the real URL in production                       |
| `TWILIO_ACCOUNT_SID` | In production | none (console sink)               | Twilio account SID for holder SMS                                                 |
| `TWILIO_AUTH_TOKEN`  | In production | none (console sink)               | Twilio auth token                                                                 |
| `TWILIO_SMS_FROM`    | In production | none (console sink)               | Sender number for holder SMS                                                      |
| `VALKEY_URL`         | No            | `redis://localhost:6379`          | Valkey connection string for mandate tokens, OTP codes and rate limits            |
| `SMTP_URL`           | No            | `smtp://localhost:1025`           | SMTP server for login codes (Mailpit in development)                              |
| `MAIL_FROM`          | No            | `RipCord <noreply@ripcord.local>` | Sender address for login codes                                                    |
| `VAULT_MASTER_KEY`   | In production | none (dev default)                | Base64 for 32 bytes; wraps every vault data key                                   |
| `VAULT_KEY_VERSION`  | No            | `1`                               | Key version stamped on new secrets; supports rotation                             |
| `CRON_SECRET`        | In production | none                              | Bearer secret for `POST /api/cron/retention` and `/api/cron/audit-verify`         |
| `S3_ENDPOINT`        | No            | `http://localhost:9100`           | S3-compatible endpoint for case documents (MinIO in development)                  |
| `S3_BUCKET`          | No            | `ripcord`                         | Bucket for case documents                                                         |
| `S3_ACCESS_KEY`      | In production | none (MinIO default)              | S3 access key; the compose MinIO uses `minioadmin`                                |
| `S3_SECRET_KEY`      | In production | none (MinIO default)              | S3 secret key; the compose MinIO uses `minioadmin`                                |
| `ADMIN_EMAILS`       | No            | none                              | Comma-separated emails that always have provider-admin access (first admin)       |

## Commands

| Command              | What it does                                                |
| -------------------- | ----------------------------------------------------------- |
| `make setup`         | Install dependencies and git hooks                          |
| `make dev`           | Start the dev server                                        |
| `make verify`        | Fast gates, no database: typecheck, lint, anti-slop, policy |
| `make check`         | Every gate, as CI runs it; needs `DATABASE_URL`             |
| `make test`          | Run Vitest                                                  |
| `make lint`          | Biome and markdownlint                                      |
| `make fix`           | Apply Biome fixes                                           |
| `make typecheck`     | Run `tsc`                                                   |
| `make build`         | Production build                                            |
| `make knip`          | Dead code check                                             |
| `make dupes`         | Duplicate code check                                        |
| `make anti-slop`     | ast-grep rules and their tests                              |
| `make policy`        | Layout, docs, dependency ledger and version drift checks    |
| `make audit`         | Dependency vulnerability audit                              |
| `make template-debt` | List `TEMPLATE-TODO` markers                                |
| `make db-generate`   | Generate a migration from `schema.ts`                       |
| `make db-migrate`    | Apply migrations                                            |
| `make db-push`       | Sync the schema without a migration file                    |
| `bun run db:seed`    | Upsert seed providers and the `demo-telco` records          |
| `bun run scrape`     | Scrape provider help pages into the knowledge base          |

## Project layout

| Path            | Holds                          |
| --------------- | ------------------------------ |
| `src/app/`      | Routes and layouts             |
| `src/features/` | One folder per feature         |
| `src/server/`   | tRPC setup and database        |
| `src/shared/`   | UI primitives, config, helpers |
| `docs/`         | Decisions, dependency ledger   |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the code map.

## More

[CONTRIBUTING.md](.github/CONTRIBUTING.md) | [SECURITY.md](.github/SECURITY.md) | [LICENSE](LICENSE)
