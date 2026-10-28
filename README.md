# template-fullstack-t3

[![CI](https://github.com/tanzhongyan-org/template-fullstack-t3/actions/workflows/ci.yml/badge.svg)](https://github.com/tanzhongyan-org/template-fullstack-t3/actions/workflows/ci.yml)
[![CodeQL](https://github.com/tanzhongyan-org/template-fullstack-t3/actions/workflows/codeql.yml/badge.svg)](https://github.com/tanzhongyan-org/template-fullstack-t3/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A GitHub template for a typed web app: Next.js, tRPC, Drizzle on PostgreSQL, Tailwind and shadcn/ui. It is for developers and coding agents who start a new product and want working gates, feature folders and a tenant-safe example on day one.

## Quick start

Install [Bun](https://bun.sh), [Docker](https://docs.docker.com/get-docker/) and Node.js 22 or later. Then run:

```bash
gh repo create my-app --template tanzhongyan-org/template-fullstack-t3 --private --clone
cd my-app
make setup
bun run dev:setup
make dev
```

`make setup` installs dependencies and git hooks. `bun run dev:setup` copies `.env.example` to `.env`, starts PostgreSQL and creates the tables. `make dev` prints `Ready` and serves <http://localhost:3000>.

> [!NOTE]
> The home page needs an `x-user-id` request header, because `TRUST_IDENTITY_HEADER=true` is a stand-in for real authentication. Without it the page shows "Sign in to view your notes."

## What you get

- Next.js 16 App Router, React 19, TypeScript strict mode.
- tRPC 11 with Zod input validation and a notes example under `src/features/notes/`.
- Drizzle ORM and generated SQL migrations in `drizzle/`.
- Tailwind CSS 4 and shadcn/ui primitives in `src/shared/components/ui/`.
- Six gates in `make check`: typecheck, Biome, Vitest, knip, fallow, ast-grep. Import boundaries between layers are ast-grep rules.
- CI with CodeQL, secret scanning, dependency audit and a weekly ZAP baseline scan.

## After creating your repo

1. Run the **Initialize Template Repository** workflow from the Actions tab. It renames the placeholders and opens a "Template follow-ups" issue.
2. Run `make template-debt`. You see one line per `TEMPLATE-TODO` marker you must resolve.

## Configuration

Copy `.env.example` to `.env`. The schema is in `src/shared/config/env.js`.

| Variable                | Required | Default | Description                                                                                               |
| ----------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | Yes      | none    | PostgreSQL connection string                                                                              |
| `TRUST_IDENTITY_HEADER` | No       | `false` | Honour the `x-user-id` header as caller identity. When false, every protected call returns `UNAUTHORIZED` |

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
