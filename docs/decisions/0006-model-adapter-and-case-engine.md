# 6. Model adapter placement and case-engine sharing

Date: 2026-10-28

## Context

Spec 0004 adds a model adapter every feature will call, a case engine the
identity feature's mandate flow must write through, and case tools that reuse
the mandate, holder-approval and provider-search logic from specs 0001–0003.
Three placement questions follow from the repo rules: the adapter needs a new
`src/` directory (ADR + `layout.allow`), the engine lives in
`src/features/cases/server/` while its callers sit in other features (the
ast-grep rule forces cross-feature imports through the feature barrel), and
the spec's `response_format` check needs a live Meta API key this environment
does not have.

## Decision

- The adapter lives in `src/server/model/` (`layout.allow` updated): tier
  rule, `llm_usage` budgets, the OpenAI-SDK transport for the Meta endpoint,
  and the scripted `fake` transport. `MODEL_PROVIDER` defaults to `fake`, so
  development, tests and CI never call the network; production sets `meta`.
- JSON output uses prompt instructions plus Zod validation with one retry on
  a parse failure, not `response_format`. The live API check in spec 0004 was
  not possible without a key, and the prompt path works on any
  OpenAI-compatible endpoint. If the owner later verifies `response_format`
  against the live API, the adapter can switch transports without touching
  callers.
- Cross-feature server reuse goes through the feature barrel, exactly as the
  `feature-no-deep-imports` rule says: `~/features/cases` re-exports the
  engine's `transition` for the mandate flow, `~/features/identity`
  re-exports `requestMandate`, the holder list and step approvals for the
  case tools, and `~/features/providers` re-exports search and detail. No
  client component imports these barrels for server values; the two mandate
  pages keep importing the client components they need, whose module graphs
  never include the server re-exports.
- Case events publish fire-and-forget on `case:<id>`: the transition commits
  first, then publishes without awaiting, so a down Valkey never blocks a
  case move. Tests inject a recording fake through `setEventsOverride`.
- The 0003 scraper calls the adapter with no owner key (it is a system job,
  not owner spend) and enforces its own US$1 run cap across the 5-provider
  loop; the runner aborts the loop on `MODEL_BUDGET_EXCEEDED` from either
  source and keeps the pages it already processed.
- The planner saves one `execute-channel` step per plan with the channel id
  in `args`. Spec 0005 owns the per-kind step templates and expands this
  placeholder; the guard (at least one step plus `chosen_channel_id`) is
  satisfied either way.

## Consequences

- `ARCHITECTURE.md` no longer calls the feature barrel client-safe only: it
  is the sanctioned path for cross-feature server reuse, with the
  client-safety note moved to the barrels themselves.
- New dependencies: `openai` (Meta's OpenAI-compatible endpoint),
  `unpdf` (bill text layers) and `@aws-sdk/s3-request-presigner` (upload
  URLs, the signing half of the installed S3 client). Each has a ledger row.
