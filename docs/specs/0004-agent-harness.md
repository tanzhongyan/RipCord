---

type: spec
status: draft
---

# 0004 Agent Harness, Tools and Case Engine

Builds on `docs/specs/0000-data-contract.md` (case lifecycle, `case_steps`, `contract_terms`, `llm_usage`, limits) and specs 0001–0003.

## Problem

Cancelling is a multi-step job: read the bill, work out the cost, get consent, pick a channel, then act. A single prompt cannot do it safely. RipCord needs an agent that works through tools, cannot step outside its mandate, and keeps model spend inside a budget.

## Solution

### Model adapter (`src/server/model/`)

- Uses the `openai@7.45.1` SDK against the Meta Model API's OpenAI-compatible Chat Completions endpoint (`META_BASE_URL`, default `https://api.meta.ai/v1`; key `META_API_KEY`).
- Two tiers, set in env:
  - `standard` = `MODEL_STANDARD` (default `muse-spark-1.3`)
  - `contributor` = `MODEL_CONTRIBUTOR` (default `muse-spark-1.3-contributor`)
- **Tier rule.** Meta trains on contributor-tier traffic, and its terms forbid personal data there. The adapter therefore sends a request on `contributor` only when every message has passed `redact` (spec 0002) and has no file or image parts. Anything else is forced to `standard`. Callers cannot override this.
- `MODEL_PROVIDER=meta|fake`. `fake` replays scripted responses from test fixtures; CI always uses `fake`.
- **Budget.** Before each call, the adapter checks `llm_usage` for the owner key and month. Defaults: US$2.00 per individual, US$20.00 per org. Over budget raises `MODEL_BUDGET_EXCEEDED`, which the UI shows as "Monthly AI limit reached". Prices per million tokens are config values (`MODEL_PRICES_JSON`). After each call, the adapter upserts token counts and cost.
- Timeouts: 30 s per call; one retry on HTTP 429 or 5xx after 2 s.

### Document extraction

`documents.extract` reads one `case_documents` file:

- A PDF with a text layer is read with `unpdf@1.9.1`, then redacted before the model sees it. A PDF without text, or any image, goes to the model as an image on the `standard` tier.
- The model must return JSON matching `ExtractionSchema`: `{ provider_name, service_type, account_no, holder_full_name, monthly_fee_cents, contract_start, contract_end_date, min_term_months, etf_clause_text, notice_days, equipment[], bundle_links[], evidence[{page, quote}] }`.
- On the server, `account_no` and `holder_full_name` go straight to the vault and are replaced by tokens before anything is stored or logged. Other fields fill `contract_terms`.
- Fields without evidence get `confidence` lowered by 30 points.

### Recommendation (deterministic code, not the model)

- `months_left = max(0, months between today and contract_end_date)`
- `cost_now = etf_estimate + monthly_fee × ceil(notice_days / 30)`. The fee estimate uses the provider policy formula. `REMAINING_MONTHS_X_MONTHLY_FEE` = `months_left × monthly_fee`; other formulas use the clause's fixed amount, or null when unknown.
- `cost_wait = monthly_fee × months_left`
- Recommend `CANCEL_NOW` when `cost_now ≤ cost_wait`, or when the end date is unknown. Otherwise recommend `WAIT_UNTIL` with `until = contract_end_date − notice_days`.
- When `etf_estimate > mandate max_fee_cents`, the UI warns before the mandate is requested.

### Case engine (`src/features/cases/server/engine.ts`)

- `transition(caseId, to, { reason?, actor })` is the only code that writes `cases.status`. It checks the data contract's lifecycle table, runs the transition and its guard in one transaction, writes `audit_logs`, and publishes an event on the Valkey channel `case:<id>` for live UI updates.
- **Channel planner** (deterministic):
  1. Candidates are channels for `provider_id` whose `service_type` matches or is null, with `is_verified_destination = true`.
  2. Drop a candidate when one of its `required_secrets` is missing from the vault and the holder cannot supply it, or when it requires a document that does not exist.
  3. Rank by success rate `(successes + 1) / (attempts + 2)`, descending. Break ties by kind order `EMAIL`, `PHONE_IVR`, `WEB_FORM`, `WEB_CHAT`, `WHATSAPP`, `POST`, `STORE`, then by `median_minutes`.
  4. Save the steps for the top channel (step templates in spec 0005).
  5. On failure, move back to `CHANNEL_PLANNING` and use the next channel. After the last channel fails, the case becomes `FAILED` with `NO_VIABLE_CHANNEL`.

### Tool registry (`src/features/cases/server/tools/`)

One registry serves the in-app chat (spec 0006), MCP (spec 0006) and the executor (spec 0005). Each tool declares:

- `name` (kebab-case)
- a Zod `input` schema
- `budget` (`read` or `write`)
- `confirm` (true means the input must include `confirm: true`)
- `statuses` (the case statuses in which it may run)
- `handler`

Every case-scoped handler first loads the case with `owner_user_id = ctx.userId` or an `org_id` in `ctx.orgIds` (otherwise `NOT_FOUND`), then checks `statuses`.

| Tool                    | Budget | Confirm | Allowed statuses                                                                | Effect                                                        |
| ----------------------- | ------ | ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `search-providers`      | read   | no      | any                                                                             | `providers.search`                                            |
| `get-provider`          | read   | no      | any                                                                             | `providers.get`                                               |
| `list-holders`          | read   | no      | any                                                                             | Holders, with hints only                                      |
| `create-case`           | write  | no      | none (new)                                                                      | Creates a `DRAFT` case for `{ holderId, providerId?, note? }` |
| `start-case`            | write  | **yes** | `DRAFT`                                                                         | Consumes a credit (spec 0007), then moves to `DISCOVERY`      |
| `get-case`              | read   | no      | any                                                                             | Case, steps, terms, receipt, all redacted                     |
| `list-cases`            | read   | no      | any                                                                             | Paginated, 25 per page                                        |
| `attach-document`       | write  | no      | `DISCOVERY`, `PRE_FLIGHT_AUDIT`, `RECEIPT_ACQUISITION`, `AWAITING_VERIFICATION` | Returns a pre-signed upload URL (10 MB, PDF/PNG/JPEG)         |
| `extract-document`      | write  | no      | `DISCOVERY`, `PRE_FLIGHT_AUDIT`                                                 | Runs document extraction, then moves to `PRE_FLIGHT_AUDIT`    |
| `accept-recommendation` | write  | no      | `PRE_FLIGHT_AUDIT`                                                              | Moves to `AWAITING_MANDATE`                                   |
| `request-mandate`       | write  | **yes** | `AWAITING_MANDATE`                                                              | `mandates.request` (spec 0001)                                |
| `approve-step`          | write  | **yes** | `EXECUTING`                                                                     | Approves one `AWAITING_APPROVAL` step                         |
| `draft-chat-reply`      | write  | no      | `EXECUTING`                                                                     | Retention-defense drafting (spec 0005)                        |
| `record-receipt`        | write  | **yes** | `EXECUTING`, `RECEIPT_ACQUISITION`                                              | Saves the receipt, then moves to `AWAITING_VERIFICATION`      |
| `report-bill-check`     | write  | **yes** | `AWAITING_VERIFICATION`                                                         | `{ result: NO_REBILL or REBILLED, documentId? }`              |
| `withdraw-case`         | write  | **yes** | any non-terminal                                                                | Moves to `WITHDRAWN`                                          |

Phone and email actions (`send-notice-email`, `place-call`, `send-digits`, `bridge-holder`, `hang-up`) are **executor-only**. They are never exposed to chat or MCP, and only the executor (spec 0005) runs them, from saved steps.

**Input guard.** Every tool input is checked with the redaction patterns. If it contains an NRIC, card number or full phone number (except `holders.create`), the tool returns the error `PII_NOT_ALLOWED`: "Do not send personal identifiers here. The holder enters them on the secure page."

### Agent loop (in-app chat)

- System prompt: the "Agent system prompt" below. Tools come from the registry. At most 12 tool rounds per user turn. Responses stream to the UI.
- The loop uses the `contributor` tier by default, because all tool outputs are redacted. It switches to `standard` automatically whenever an image is attached.

**Agent system prompt** (store as `src/features/cases/server/prompts/agent.md`):

```text
You are RipCord, an assistant that helps people cancel subscriptions and contracts, including on behalf of family members.
Rules:
1. Use tools for every fact about providers, cases and money. Never invent phone numbers, emails, fees, dates or policies. If a tool has no answer, say so.
2. You only see placeholders like {{vault:NRIC:...}} instead of personal data. Never ask the user to type an NRIC, PIN or card number. Personal identifiers are entered by the account holder on the secure page.
3. Follow the case steps in order: create the case, start it (this uses one credit; say so and ask before calling start-case), get the bill, review the recommendation, request the holder's mandate, then let RipCord execute.
4. Never cancel, sign up, upgrade or change any service other than the one in the mandate. Never accept an offer for the user.
5. Before any tool marked confirm, state exactly what will happen and wait for the user's yes.
6. Be brief and plain. Use short sentences.
```

## Acceptance Scenarios

- **B1 Tier rule.** Given a message with an image part, when a caller asks for the `contributor` tier, then the request is sent to `MODEL_STANDARD`.
- **B2 Budget.** Given an owner at US$2.00 spent this month, when any model call is made, then it fails with `MODEL_BUDGET_EXCEEDED` and no HTTP request leaves the server.
- **B3 Extraction vaults PII.** Given a bill PDF with account number "1234-5678", when it is extracted, then `contract_terms` is filled, the vault has an `ACCOUNT_NO` secret, and neither `case_documents.extracted` nor any log contains "1234-5678".
- **B4 Recommendation.** Given a monthly fee of S$50, 6 months left, a fee formula of remaining months × monthly fee, and 30 notice days, when the recommendation is computed, then `cost_now = 35000`, `cost_wait = 30000`, and the action is `WAIT_UNTIL`.
- **B5 Illegal transition.** Given a case in `DRAFT`, when anything calls `transition(..., "EXECUTING")`, then it throws `ILLEGAL_TRANSITION` and the status is unchanged.
- **B6 Confirm gate.** Given `start-case` is called without `confirm: true`, then it returns `CONFIRM_REQUIRED` and no credit is consumed.
- **B7 Scope.** Given user B, when they call `get-case` on user A's case, then the result is `NOT_FOUND`.
- **B8 PII input guard.** Given `create-case` is called with a note containing "S1234567D", then it returns `PII_NOT_ALLOWED` and nothing is written.
- **B9 Planner.** Given `demo-telco` with verified `EMAIL` and `PHONE_IVR` channels and no outcome stats, when planning runs, then the `EMAIL` steps are saved first.
- **B10 Fallback.** Given the `EMAIL` channel fails, when the engine re-plans, then the `PHONE_IVR` steps are saved and no second credit is consumed.

## Budgets

- One agent turn without tools: first token in under 1.5 s p95 (the model's own speed excluded from server overhead: under 100 ms).
- Tool handlers (excluding model calls and external sends): under 150 ms p95.
- Extraction of one 3-page bill: under 20 s, at most 2 model calls.
- Model spend per case target: under US$0.05 on the contributor tier.

## Public Entry Points

The tool registry (tested through `callTool(name, input, ctx)`), `transition`, the model adapter's `complete` and `stream`, and the routes in spec 0006 that expose them.

## Implementation Notes

- New folders `src/server/model/` and `src/features/cases/` (the feature wildcard already allows `src/features/*`). `src/server/model/` needs an ADR and a `layout.allow` entry.
- Packages: `openai@7.45.1`, `unpdf@1.9.1`. New env vars: `META_API_KEY`, `META_BASE_URL`, `MODEL_STANDARD`, `MODEL_CONTRIBUTOR`, `MODEL_PROVIDER`, `MODEL_PRICES_JSON`, `MODEL_BUDGET_USER_MICROS` (default 2000000), `MODEL_BUDGET_ORG_MICROS` (default 20000000).
- Before coding the adapter, check that tool calling and JSON-schema output (`response_format`) work against the live API with one manual request each. If `response_format` is not supported, ask for JSON in the prompt and validate it with Zod, retrying once on a parse failure.

## Decisions & Out of Scope

- Money and scheduling decisions use plain code, not the model, so they can be tested and explained.
- Rejected: letting the model call phone or email tools directly. The executor runs saved, approved steps instead, so a prompt injection in a rep message cannot trigger a send.
- Out of scope: model fine-tuning, a vector store (the knowledge base is small and structured), and multi-agent orchestration.
