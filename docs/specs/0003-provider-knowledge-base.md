---

type: spec
status: draft
---

# 0003 Provider Knowledge Base

Builds on `docs/specs/0000-data-contract.md` (tables `providers`, `provider_channels`, `provider_policies`, `scrape_runs`, `channel_outcome_stats`).

## Problem

Each provider hides its cancellation rules in a different place: a help page, contract terms, a phone menu. The agent needs one trusted, sourced record of how to cancel with each provider, and it must never make up a phone number or email address.

## Solution

1. **Seed list.** `src/features/providers/server/seed.ts` lists providers by `slug`, `name`, `country`, `category`, `website` and an array of `seedUrls` (help and terms pages chosen by hand). Seed only these fields. **Never seed channel addresses, phone numbers or policies from memory.** They come only from a scrape run or an admin edit, each with a `source_url`.
2. **Seed providers:** `singtel`, `starhub`, `m1`, `sp-group` (utility), `anytime-fitness-sg` (gym), and `demo-telco`. `demo-telco` is RipCord's own mock provider for sandbox and the demo. Its channels are seeded in full: `EMAIL` to `cancel@demo-telco.test` (caught by Mailpit), `PHONE_IVR` to `+15005550006` (handled by the simulated telephony adapter, spec 0005), `accepts_loa = YES`, `required_secrets = [FULL_NAME, NRIC, ACCOUNT_NO]`, `notice_days = 30`, plus policies: early termination fee `REMAINING_MONTHS_X_MONTHLY_FEE`, minimum term 24 months, router return within 14 days. All are marked `is_verified_destination = true`.
3. **Scraper CLI.** `bun run scrape [--provider <slug>]` runs outside the web server:
   - Checks `robots.txt` with `robots-parser`. A disallowed URL is skipped and logged.
   - Loads each seed URL in headless Chromium (Playwright), because sites such as Singtel render their content with JavaScript. Waits for network idle, with a 20 s timeout per page.
   - Follows links on the same domain whose text or URL matches `cancel|terminat|close account|contact|terms|policy` up to depth 2, with a maximum of 25 pages per provider.
   - Extracts readable text with `@mozilla/readability` over `linkedom`.
   - Sends each page's text to the model (spec 0004 adapter, contributor tier allowed, since this is public data) with a JSON schema for channels and policies. The model must quote the exact sentence it took each field from. A field without a quote, or whose quote is not found verbatim in the page text, is dropped.
   - Upserts results, keyed on `(provider_id, service_type, kind, address)`. Sets `source_url`, `checked_at` and `confidence`.
   - Never sets `is_verified_destination`. New or changed addresses always start as `false`.
   - Writes one `scrape_runs` row with `pages_fetched` and a `change_summary` of fields added, changed and removed.
   - Rate: one request per second per domain, user agent `RipCordBot/1.0 (+https://github.com/tanzhongyan/RipCord)`.
4. **Admin review.** The admin dashboard (spec 0007) lists channels where `is_verified_destination = false` or `confidence < 70`, side by side with the source quote and URL. Only an admin can set `is_verified_destination = true` or edit a record, and each edit writes an `audit_logs` row.
5. **Lookup.** `providers.search` uses `pg_trgm` similarity on `providers.name` and `slug` (threshold 0.3, top 5). Results are cached in Valkey for 10 minutes, keyed on the lower-cased query. Any provider write clears that provider's cache keys.
6. **Outcome stats.** When a case closes, one transaction increments `channel_outcome_stats.attempts` for each channel that was tried, and `successes` for the channel that produced the receipt. `median_minutes` is recomputed from the last 50 durations kept in a Valkey list per channel. No case ID is stored.

## Acceptance Scenarios

- **B1 Fuzzy search.** Given seeded providers, when `providers.search("sing tel")` runs, then `singtel` is the first result.
- **B2 Cache.** Given a search was just made, when the same search repeats within 10 minutes, then no SQL query runs (asserted through a query counter in the test).
- **B3 Quote check.** Given a model response with a phone number whose quote is not in the page text, when the scraper saves results, then that channel is not written.
- **B4 Unverified by default.** Given a scrape finds a new email address, when it is saved, then `is_verified_destination = false` and the channel appears in the admin review list.
- **B5 robots.txt.** Given robots.txt disallows `/help`, when the scraper runs, then no request is made to `/help/*` and the skip is listed in `change_summary`.
- **B6 Demo provider.** Given a fresh database, when the seed runs, then `demo-telco` has a verified `EMAIL` channel and a verified `PHONE_IVR` channel with a non-empty `ivr_path`.
- **B7 Admin only.** Given a non-admin user, when they call `providers.adminUpdateChannel`, then the result is `FORBIDDEN`.
- **B8 Stats anonymity.** Given a case closes as `SUCCEEDED`, when stats update, then `channel_outcome_stats` changes and no column anywhere links it to the case.

## Budgets

- `providers.search`: under 30 ms p95 from cache, under 80 ms p95 from the database.
- `providers.get` (provider with channels and policies): one SQL query with joins, under 50 ms p95.
- Scraper: at most 25 pages and 60 model calls per provider per run. Model spend for a full run of 5 providers is capped at US$1 (abort when the adapter's budget says so).

## Public Entry Points

| Entry point                         | Contract                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| tRPC `providers.search`             | `{ query: string(2..80), country?: char(2) }` → up to 5 `{ id, slug, name, category, score }`. Public: needs no login, rate-limited per IP at 60/min. |
| tRPC `providers.get`                | `{ id }` → provider with channels and policies. Unverified channels are included with `verified: false`.                                              |
| tRPC `providers.adminListReview`    | Admin only → channels needing review                                                                                                                  |
| tRPC `providers.adminUpdateChannel` | Admin only. `{ channelId, patch, verify: boolean }`                                                                                                   |
| CLI `bun run scrape`                | As described above. Exit code 0 when at least one page per provider was processed.                                                                    |
| CLI `bun run db:seed`               | Idempotent. Upserts seed providers and the `demo-telco` records.                                                                                      |

## Implementation Notes

- Feature folder `src/features/providers/`. The scraper lives in `src/features/providers/server/scraper/` and is never imported by app routes; it runs from `scripts/scrape.ts`.
- Migration: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` plus the GIN index from the data contract.
- Admin role: Better Auth `admin` plugin (`better-auth/plugins/admin`). The first admin is set by the env var `ADMIN_EMAILS` (comma-separated) at sign-in.
- Packages: `playwright@1.64.1` (dev dependency; run `bunx playwright install chromium`), `robots-parser@3.0.1`, `@mozilla/readability@0.6.0`, `linkedom@0.18.14`.

## Decisions & Out of Scope

- A human verifies every destination before RipCord sends PII to it. A wrong scraped address would leak an NRIC to a stranger, so automation stops at "suggested".
- Rejected: crawling whole sites, because it is slow and against most terms. Rejected: third-party scraping APIs, because they are not open source.
- Out of scope: providers outside Singapore (the schema supports them), automatic re-scrape schedules (run by hand or CI for now), and crowd-sourced edits.
