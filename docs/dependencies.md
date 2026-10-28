# Dependency ledger

Every direct dependency in `package.json` has one row. Add the row in the same pull request that adds the dependency. `make policy` fails when a manifest entry has no row, or a row has no manifest entry. The policy for adding dependencies is in [ADR 0003](decisions/0003-frontend-dependency-policy.md).

## Runtime dependencies

| Dependency                      | Purpose                                                                      | Why the default was not enough                                                                                    | Replaced                          |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `next`                          | App Router framework, bundler and server                                     | A React app needs routing, server rendering and a build pipeline; hand-rolling them costs more than the framework | Nothing; the base of the template |
| `react`                         | UI rendering                                                                 | Required by Next.js                                                                                               | Nothing                           |
| `react-dom`                     | DOM renderer for React                                                       | Required by Next.js                                                                                               | Nothing                           |
| `@trpc/server`                  | Typed API procedures and routers                                             | `fetch` plus hand-written route handlers loses the shared input and output types                                  | Hand-written route handlers       |
| `@trpc/client`                  | Typed client and links for tRPC                                              | The server package has no client transport                                                                        | `fetch` calls                     |
| `@trpc/react-query`             | React hooks and server-component hydration helpers for tRPC                  | Binds tRPC procedures to TanStack Query without glue code                                                         | Custom hooks around `fetch`       |
| `@tanstack/react-query`         | Server-state cache, retries, invalidation                                    | `useEffect` plus `useState` has no cache, dedupe or invalidation                                                  | `useEffect` data loading          |
| `superjson`                     | Serializes `Date`, `Map` and `Set` across the tRPC boundary                  | JSON drops those types, so `createdAt` would arrive as a string                                                   | Plain JSON transport              |
| `drizzle-orm`                   | Typed SQL queries and schema                                                 | Raw SQL strings lose column types and migrations drift from code                                                  | Raw `postgres` queries            |
| `postgres`                      | PostgreSQL driver used by Drizzle                                            | Drizzle needs a driver; this one has no native build step                                                         | Nothing                           |
| `zod`                           | Input validation at the tRPC and environment boundaries                      | TypeScript types vanish at runtime, so request bodies need a runtime check                                        | Hand-written guards               |
| `@t3-oss/env-nextjs`            | Validates environment variables at build and start                           | `process.env` is untyped and fails late                                                                           | Direct `process.env` reads        |
| `server-only`                   | Fails the build when server code enters a client bundle                      | A review rule cannot stop an accidental client import                                                             | Nothing                           |
| `@base-ui/react`                | Unstyled accessible primitives behind shadcn components                      | Focus handling, ARIA and keyboard behaviour are error-prone to rewrite                                            | Hand-built widgets                |
| `class-variance-authority`      | Variant classes for shadcn components                                        | Template-string class switches do not compose                                                                     | Conditional class strings         |
| `clsx`                          | Conditional class names                                                      | Needed by `cn`                                                                                                    | String concatenation              |
| `tailwind-merge`                | Resolves conflicting Tailwind classes in `cn`                                | `clsx` alone keeps both `px-2` and `px-4`                                                                         | Nothing                           |
| `lucide-react`                  | The one icon set                                                             | Inline SVG copies drift in size and stroke                                                                        | Inline SVG                        |
| `tw-animate-css`                | Animation utilities that shadcn components expect                            | Tailwind has no enter and exit animation classes                                                                  | Nothing                           |
| `better-auth`                   | Email-OTP sign-in, organisations, admin roles (spec 0001)                    | Hand-rolled sessions, OTP hashing and org membership invite auth bugs                                             | Header identity stub              |
| `@better-auth/oauth-provider`   | OAuth/OIDC provider tables for MCP (spec 0001, wired in 0006)                | The MCP server needs standards-shaped clients, tokens and consents                                                | Nothing                           |
| `twilio`                        | Holder SMS for mandate links and codes (spec 0001)                           | Valkey and Mailpit cannot reach phones                                                                            | Console sink in non-production    |
| `pdf-lib`                       | Letter of authorisation PDF (spec 0001)                                      | No other PDF writer is installed                                                                                  | Nothing                           |
| `iovalkey`                      | Valkey client for tokens, codes and rate limits (spec 0001)                  | Counters and TTLs do not belong in Postgres                                                                       | Nothing                           |
| `@aws-sdk/client-s3`            | S3-compatible document storage, MinIO in development (0002)                  | Node ships no S3 client; uploads need signed requests, SSE and bucket APIs                                        | Inline data URLs in `storage_key` |
| `robots-parser`                 | Parses robots.txt for the provider scraper (spec 0003)                       | Wildcard and precedence rules are easy to get wrong by hand                                                       | Hand-written prefix checks        |
| `@mozilla/readability`          | Extracts article text from scraped pages (spec 0003)                         | Raw HTML keeps nav and ads, which would poison model extraction                                                   | Regex HTML stripping              |
| `linkedom`                      | DOM for Readability and link extraction (spec 0003)                          | Readability needs a document; linkedom is lighter than jsdom                                                      | `jsdom`                           |
| `openai`                        | Typed client for the Meta Model API's OpenAI-compatible endpoint (spec 0004) | A hand-rolled client would reimplement SSE streaming, typed errors and retries                                    | Raw `fetch` calls                 |
| `unpdf`                         | Bill PDF text layers for document extraction (spec 0004)                     | The installed `pdf-lib` writes PDFs but cannot read text; raw `pdfjs-dist` needs serverless shims                 | Nothing                           |
| `@aws-sdk/s3-request-presigner` | Pre-signed upload URLs for bill intake (spec 0004)                           | SigV4 signing by hand is error-prone; the signing half of the installed S3 client                                 | Nothing                           |
| `nodemailer`                    | SMTP sending for sandbox and live notice email (spec 0005)                   | Node ships no SMTP client; raw sockets would reimplement MIME, auth and retries                                   | Nothing                           |

## Development dependencies

| Dependency             | Purpose                                                     | Why the default was not enough                                      | Replaced                |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| `typescript`           | Typecheck (Gate 1)                                          | Needed for strict types                                             | Nothing                 |
| `@types/node`          | Node.js types                                               | Config files and tests use Node APIs                                | Nothing                 |
| `@types/react`         | React types                                                 | React ships no types                                                | Nothing                 |
| `@types/react-dom`     | React DOM types                                             | React DOM ships no types                                            | Nothing                 |
| `@types/nodemailer`    | Type definitions for `nodemailer` (spec 0005)               | The package ships no types; `tsc` needs the community definitions   | Untyped `require` calls |
| `@biomejs/biome`       | Format and lint (Gate 2)                                    | One tool replaces a formatter plus a linter                         | ESLint and Prettier     |
| `vitest`               | Test runner (Gate 3)                                        | `bun test` lacks the Vite transform and alias handling the app uses | Nothing                 |
| `knip`                 | Dead code detection (Gate 4)                                | `tsc` does not report unused files or exports                       | Nothing                 |
| `fallow`               | Duplicate code detection (Gate 5)                           | No built-in clone detector                                          | Nothing                 |
| `@ast-grep/cli`        | Anti-slop and import boundary rules (Gate 6)                | Biome cannot express path-scoped import rules                       | Nothing                 |
| `lefthook`             | Git hooks that call `make` targets                          | Plain git hook files are not versioned                              | Nothing                 |
| `markdownlint-cli2`    | Markdown lint, run by `make lint`                           | Broken headings and lists reach readers unnoticed                   | Nothing                 |
| `drizzle-kit`          | Generates and applies migrations                            | Drizzle ORM has no migration runner                                 | Hand-written SQL files  |
| `playwright`           | Headless Chromium for JS-rendered provider pages (0003)     | Provider help pages render content with JavaScript                  | Plain `fetch` HTML      |
| `shadcn`               | CLI that adds UI primitives into `src/shared/components/ui` | Copying component source by hand drifts from upstream               | Nothing                 |
| `tailwindcss`          | Utility CSS                                                 | Part of the styling stack                                           | Nothing                 |
| `@tailwindcss/postcss` | Tailwind plugin for PostCSS                                 | Next.js builds CSS through PostCSS                                  | Nothing                 |
| `postcss`              | CSS pipeline used by Next.js                                | Required by the Tailwind plugin                                     | Nothing                 |

## Overrides

`package.json` pins `esbuild` and `katex` through `overrides` because `drizzle-kit` and `markdownlint-cli2` pull in releases with open advisories. Remove an override when the parent package ships a fixed release.
