---

type: spec
status: draft
---

# RipCord Data Contract

The single source of truth for RipCord's domain data, case lifecycle and pricing. Every feature spec, ticket and agent builds on this file.

## Rules for agents

1. Do not add, rename or drop a table, column, enum value or state that this file does not list. If the work needs one, stop and report it. Do not invent it.
2. `src/server/db/schema.ts` must match this file. A change to one changes the other in the same pull request.
3. Enum values, state names, tool names and limits are exact strings and numbers. Copy them; do not paraphrase.
4. If this file and another spec disagree, this file wins. Report the conflict.

## Conventions

- Table names are plural `snake_case`; columns are `snake_case`. This matches `notes` in `src/server/db/schema.ts`.
- Domain primary keys are `uuid` with `gen_random_uuid()`. `audit_logs.id` is a `bigint` identity.
- User and organisation IDs are `text`, because Better Auth owns those tables.
- Every timestamp is `timestamptz`. Every table has `created_at` (default now, not null). Mutable tables also have `updated_at`.
- Money is an integer number of cents plus an ISO 4217 `currency` (`SGD` by default). Never use floats for money.
- "Owner" means the requesting user (`owner_user_id`) or their organisation (`org_id`). Every query filters on one of them.

## Data classes

| Class | Meaning                                                                                | Where it may appear                                                            |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| V     | Secret PII: NRIC, full name, date of birth, address, phone, email, account number, PIN | Only as ciphertext in `vault_secrets`. Everywhere else as a placeholder token. |
| P     | Personal but not secret: login email and name                                          | Better Auth tables and the UI for that user only                               |
| N     | Not personal                                                                           | Anywhere                                                                       |

**Placeholder token format:** `{{vault:<KIND>:<vault_secret_id>}}`, for example `{{vault:NRIC:3f0c…}}`. Model prompts, tool arguments, transcripts, logs and URLs contain only tokens. The channel executor resolves a token at send time, as defined under Vault release rules.

## Enums

| Enum                  | Values                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_kind`         | `NRIC`, `FULL_NAME`, `DOB`, `ADDRESS`, `PHONE`, `EMAIL`, `ACCOUNT_NO`, `PIN`                                                                                                                  |
| `service_type`        | `MOBILE_POSTPAID`, `MOBILE_PREPAID`, `BROADBAND`, `PAY_TV`, `FIXED_LINE`, `UTILITY`, `GYM`, `STREAMING`, `SAAS`, `OTHER`                                                                      |
| `channel_kind`        | `EMAIL`, `PHONE_IVR`, `WEB_FORM`, `WEB_CHAT`, `WHATSAPP`, `STORE`, `POST`                                                                                                                     |
| `tri_state`           | `YES`, `NO`, `UNKNOWN`                                                                                                                                                                        |
| `policy_kind`         | `EARLY_TERMINATION_FEE`, `NOTICE_PERIOD`, `MIN_TERM`, `EQUIPMENT_RETURN`, `CANCELLATION_METHOD`                                                                                               |
| `case_status`         | `DRAFT`, `DISCOVERY`, `PRE_FLIGHT_AUDIT`, `AWAITING_MANDATE`, `CHANNEL_PLANNING`, `EXECUTING`, `RECEIPT_ACQUISITION`, `AWAITING_VERIFICATION`, `SUCCEEDED`, `FAILED`, `WITHDRAWN`, `DISPUTED` |
| `execution_phase`     | `CONTACTING`, `RETENTION_DEFENSE`, `TERMS_VERIFICATION`                                                                                                                                       |
| `failure_reason`      | `PROVIDER_UNSUPPORTED`, `NO_VIABLE_CHANNEL`, `MANDATE_EXPIRED`, `MANDATE_REVOKED`, `PROVIDER_REFUSED`, `TIMEOUT`, `INTERNAL_ERROR`                                                            |
| `mandate_status`      | `PENDING`, `ACTIVE`, `REVOKED`, `EXPIRED`, `CONSUMED`                                                                                                                                         |
| `mandate_action`      | `CANCEL_SERVICE`, `REQUEST_FINAL_BILL`, `ARRANGE_EQUIPMENT_RETURN`                                                                                                                            |
| `document_kind`       | `BILL`, `CONTRACT`, `SCREENSHOT`, `LOA`, `RECEIPT`, `DISPUTE_PACKAGE`                                                                                                                         |
| `step_status`         | `PLANNED`, `AWAITING_APPROVAL`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`                                                                                                                   |
| `direction`           | `INBOUND`, `OUTBOUND`                                                                                                                                                                         |
| `verification_result` | `NO_REBILL`, `REBILLED`, `UNKNOWN`                                                                                                                                                            |
| `credit_reason`       | `PURCHASE`, `PLAN_GRANT`, `CONSUME`, `REFUND`, `EXPIRE`, `ADMIN_ADJUST`                                                                                                                       |
| `plan`                | `INDIVIDUAL`, `ORG_MONTHLY`                                                                                                                                                                   |
| `dsr_kind`            | `ACCESS`, `DELETE`                                                                                                                                                                            |
| `dsr_status`          | `RECEIVED`, `IN_PROGRESS`, `COMPLETED`, `REJECTED`                                                                                                                                            |
| `actor_type`          | `USER`, `HOLDER`, `AGENT`, `SYSTEM`, `ADMIN`                                                                                                                                                  |

## Tables

`→` marks a foreign key. Every column is `NOT NULL` unless marked `null`.

### Identity (owned by Better Auth)

`users`, `sessions`, `accounts`, `verifications`, `organizations`, `members`, plus the OAuth client and token tables from the Better Auth MCP/OIDC plugin. Use the plugin's generated schema without changes. Class P.

### Holders and vault

**`account_holders`**: the person whose service is being cancelled. They may or may not have a login.

| Column          | Type                       | Notes                                              |
| --------------- | -------------------------- | -------------------------------------------------- |
| id              | uuid                       | PK                                                 |
| owner_user_id   | text → users               | The user who created the record                    |
| org_id          | text → organizations, null |                                                    |
| alias           | varchar(60)                | A label such as "Dad". Must not be a real name.    |
| phone_secret_id | uuid → vault_secrets       | Destination for the mandate one-time code          |
| user_id         | text → users, null         | Set when the holder has their own login            |
| deleted_at      | timestamptz, null          | Soft delete; the deletion job purges after 30 days |

**`vault_secrets`** (class V)

| Column       | Type                   | Notes                                                     |
| ------------ | ---------------------- | --------------------------------------------------------- |
| id           | uuid                   | PK                                                        |
| holder_id    | uuid → account_holders |                                                           |
| kind         | secret_kind            |                                                           |
| ciphertext   | bytea                  | AES-256-GCM                                               |
| iv           | bytea                  | 12 bytes                                                  |
| wrapped_dek  | bytea                  | Per-record data key, wrapped by the master key from `env` |
| key_version  | smallint               | Supports master key rotation                              |
| display_hint | varchar(8), null       | Last 4 characters only. Always null for `PIN`.            |
| last_used_at | timestamptz, null      | Drives retention                                          |
| deleted_at   | timestamptz, null      | Ciphertext is overwritten when set                        |

There is no unique constraint on `(holder_id, kind)`, because a holder can have several `ACCOUNT_NO` secrets (for example mobile and broadband).

**`vault_releases`**: append-only. One row each time a real value leaves the vault.

| Column              | Type                     | Notes                                               |
| ------------------- | ------------------------ | --------------------------------------------------- |
| id                  | uuid                     | PK                                                  |
| secret_id           | uuid → vault_secrets     |                                                     |
| case_id             | uuid → cases             |                                                     |
| step_id             | uuid → case_steps        |                                                     |
| provider_channel_id | uuid → provider_channels | The destination                                     |
| mandate_id          | uuid → mandates          |                                                     |
| holder_approved_at  | timestamptz, null        | Required when kind is `NRIC`, `PIN` or `ACCOUNT_NO` |
| released_at         | timestamptz              |                                                     |

### Provider knowledge base (public data, class N)

**`providers`**: `id` uuid PK · `slug` varchar(80) unique · `name` varchar(120) · `country` char(2) · `category` service_type · `website` text · `updated_at`.

**`provider_channels`**

| Column                  | Type               | Notes                                                                      |
| ----------------------- | ------------------ | -------------------------------------------------------------------------- |
| id                      | uuid               | PK                                                                         |
| provider_id             | uuid → providers   |                                                                            |
| service_type            | service_type, null | Null means every service type                                              |
| kind                    | channel_kind       |                                                                            |
| address                 | text               | Email address, E.164 phone number, or URL                                  |
| ivr_path                | jsonb, null        | Ordered list of `{prompt, digits}`. `digits` may hold a placeholder token. |
| hours                   | jsonb, null        | Opening hours in the provider's local time                                 |
| accepts_loa             | tri_state          |                                                                            |
| required_documents      | jsonb              | Array of `document_kind`                                                   |
| required_secrets        | jsonb              | Array of `secret_kind`                                                     |
| notice_days             | smallint, null     |                                                                            |
| is_verified_destination | boolean            | Only verified destinations may receive vault releases                      |
| source_url              | text               |                                                                            |
| source_quote            | text, null         | The exact sentence the address was taken from; null when unknown           |
| checked_at              | timestamptz        |                                                                            |
| confidence              | smallint           | 0–100                                                                      |

**`provider_policies`**: `id` uuid PK · `provider_id` → providers · `service_type` null · `kind` policy_kind · `rule` jsonb (structured, e.g. `{ "formula": "REMAINING_MONTHS_X_MONTHLY_FEE" }`) · `excerpt` varchar(500) · `source_url` text · `checked_at`.

**`scrape_runs`**: `id` uuid PK · `provider_id` → providers · `started_at` · `finished_at` null · `status` varchar(20) (`RUNNING`, `SUCCEEDED`, `FAILED`) · `pages_fetched` int · `change_summary` jsonb.

**`channel_outcome_stats`**: anonymous aggregate with no link to cases or people. `provider_channel_id` PK → provider_channels · `attempts` int · `successes` int · `median_minutes` int null · `updated_at`.

### Cases (class N; PII only as tokens)

**`cases`**

| Column            | Type                           | Notes                                                                                     |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| id                | uuid                           | PK                                                                                        |
| owner_user_id     | text → users                   |                                                                                           |
| org_id            | text → organizations, null     |                                                                                           |
| holder_id         | uuid → account_holders         |                                                                                           |
| provider_id       | uuid → providers, null         | Null until discovery                                                                      |
| service_type      | service_type, null             |                                                                                           |
| status            | case_status                    | Default `DRAFT`                                                                           |
| execution_phase   | execution_phase, null          | Set only while status is `EXECUTING`                                                      |
| failure_reason    | failure_reason, null           | Set only when status is `FAILED`                                                          |
| chosen_channel_id | uuid → provider_channels, null |                                                                                           |
| sandbox           | boolean                        | Default `true`                                                                            |
| recommendation    | jsonb, null                    | `{ action: "CANCEL_NOW" or "WAIT_UNTIL", until?: date, cost_now_cents, cost_wait_cents }` |
| closed_at         | timestamptz, null              | Set on any terminal status                                                                |
| updated_at        | timestamptz                    |                                                                                           |

**`case_documents`**: `id` uuid PK · `case_id` → cases · `kind` document_kind · `storage_key` text (object store, encrypted at rest) · `sha256` char(64) · `extracted` jsonb null (non-PII fields only; extracted PII goes to the vault) · `delete_after` timestamptz null.

**`contract_terms`**: one row per case. `case_id` PK → cases · `contract_end_date` date null · `min_term_months` smallint null · `etf_estimate_cents` int null · `monthly_fee_cents` int null · `currency` char(3) · `notice_days` smallint null · `equipment` jsonb · `bundle_links` jsonb · `confidence` smallint · `evidence` jsonb (`[{document_id, page}]`).

**`mandates`**

| Column             | Type                        | Notes                                                           |
| ------------------ | --------------------------- | --------------------------------------------------------------- |
| id                 | uuid                        | PK                                                              |
| case_id            | uuid → cases                |                                                                 |
| holder_id          | uuid → account_holders      |                                                                 |
| delegate_user_id   | text → users, null          |                                                                 |
| delegate_org_id    | text → organizations, null  | Exactly one delegate column is set                              |
| provider_id        | uuid → providers            | Scope                                                           |
| service_secret_id  | uuid → vault_secrets        | Scope: the `ACCOUNT_NO` being cancelled                         |
| actions            | mandate_action[]            | Scope                                                           |
| max_fee_cents      | int                         | Scope: the highest fee the holder accepts                       |
| status             | mandate_status              | Default `PENDING`                                               |
| live_mode_approved | boolean                     | Default `false`                                                 |
| otp_verified_at    | timestamptz, null           |                                                                 |
| signed_at          | timestamptz, null           |                                                                 |
| signature_evidence | jsonb, null                 | `{ typed_name_sha256, ip_sha256, user_agent_sha256 }`           |
| loa_document_id    | uuid → case_documents, null |                                                                 |
| expires_at         | timestamptz                 | `signed_at + 30 days`, or `created_at + 7 days` while `PENDING` |
| revoked_at         | timestamptz, null           |                                                                 |

**`case_steps`**: `id` uuid PK · `case_id` → cases · `seq` int · `tool` varchar(60) · `args` jsonb (tokens only) · `status` step_status · `requires_approval` boolean · `approved_by_user_id` text null · `approved_at` null · `result` jsonb null (redacted) · `started_at` null · `finished_at` null. Unique `(case_id, seq)`.

**`communications`**: `id` uuid PK · `case_id` → cases · `step_id` → case_steps null · `channel` channel_kind · `direction` direction · `body` text (redacted, tokens only) · `external_ref` varchar(120) null (email Message-ID or Twilio call SID) · `occurred_at`.

**`receipts`**: `case_id` PK → cases · `reference_code` varchar(80) · `effective_date` date · `final_bill_estimate_cents` int null · `evidence_document_id` uuid → case_documents null · `confirmed_by_user_at` null.

**`verifications`**: `case_id` PK → cases · `due_at` (next billing date + 7 days) · `result` verification_result null · `evidence_document_id` null · `resolved_at` null.

### Billing (see Pricing)

**`billing_customers`**: `id` uuid PK · `user_id` text null · `org_id` text null (exactly one set) · `stripe_customer_id` varchar(64) unique · `plan` plan · `plan_renews_at` null. Unique partial indexes: `(user_id) WHERE user_id IS NOT NULL` and `(org_id) WHERE org_id IS NOT NULL`. One customer per user, one per org.

**`credit_ledger`**: append-only.

| Column              | Type                     | Notes                          |
| ------------------- | ------------------------ | ------------------------------ |
| id                  | uuid                     | PK                             |
| billing_customer_id | uuid → billing_customers |                                |
| delta               | int                      | `+n` grants, `-1` consume      |
| reason              | credit_reason            |                                |
| case_id             | uuid → cases, null       | Set for `CONSUME` and `REFUND` |
| stripe_ref          | varchar(80), null        | Payment Intent or Invoice ID   |
| expires_at          | timestamptz, null        | Set for `PLAN_GRANT`           |

Unique partial indexes: `(case_id) WHERE reason = 'CONSUME'` and `(case_id) WHERE reason = 'REFUND'`. A case is charged at most once and refunded at most once.

### Compliance and usage

**`audit_logs`**: append-only. A database trigger rejects UPDATE and DELETE. `id` bigint identity PK · `actor_type` actor_type · `actor_id` text · `action` varchar(60) · `target_type` varchar(40) · `target_id` text · `case_id` uuid null · `metadata` jsonb (no class V or P values) · `prev_hash` char(64) · `hash` char(64) (SHA-256 of `prev_hash` + the row) · `created_at`.

**`data_subject_requests`**: `id` uuid PK · `user_id` text null · `holder_id` uuid null · `kind` dsr_kind · `status` dsr_status · `completed_at` null.

**`llm_usage`**: `owner_key` text (`user:<id>` or `org:<id>`) · `period` char(7) (`YYYY-MM`) · `tokens_in` bigint · `tokens_out` bigint · `cost_micros` bigint. PK `(owner_key, period)`.

Rate-limit counters, one-time code attempts and cached provider reads live in Valkey, not Postgres.

## Indexes

| Index                                                                       | Serves                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `cases (owner_user_id, status, updated_at DESC)`                            | Dashboard list                                       |
| `cases (org_id, status, updated_at DESC)`                                   | Org dashboard                                        |
| `mandates (case_id)` and `mandates (holder_id, status)`                     | Scope check on every tool call; active-mandate limit |
| `case_steps (case_id, seq)` unique                                          | Step order                                           |
| `communications (case_id, occurred_at)`                                     | Transcript view                                      |
| `providers (slug)` unique, plus a `pg_trgm` GIN index on `providers (name)` | Fuzzy provider lookup at intake                      |
| `provider_channels (provider_id, service_type, kind)`                       | Channel planning                                     |
| `verifications (due_at) WHERE result IS NULL`                               | Daily verification job                               |
| `credit_ledger (billing_customer_id, created_at)`                           | Balance                                              |
| `audit_logs (case_id, created_at)`                                          | Case history                                         |
| `vault_secrets (holder_id)`                                                 | Vault lookup                                         |

## Case lifecycle

| From                    | To                      | Trigger                                           | Guard                                                    |
| ----------------------- | ----------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| `DRAFT`                 | `DISCOVERY`             | User confirms "Start cancellation"                | One credit is consumed in the same transaction           |
| `DISCOVERY`             | `PRE_FLIGHT_AUDIT`      | Provider and service identified                   | `provider_id` and `service_type` set                     |
| `DISCOVERY`             | `FAILED`                | Provider not in the knowledge base                | `failure_reason = PROVIDER_UNSUPPORTED`; credit refunded |
| `PRE_FLIGHT_AUDIT`      | `AWAITING_MANDATE`      | User accepts the recommendation                   | `contract_terms` row exists                              |
| `AWAITING_MANDATE`      | `CHANNEL_PLANNING`      | Holder signs                                      | Mandate `ACTIVE`                                         |
| `AWAITING_MANDATE`      | `FAILED`                | Mandate expires unsigned                          | `MANDATE_EXPIRED`; no refund                             |
| `CHANNEL_PLANNING`      | `EXECUTING`             | Plan saved                                        | At least one step; `chosen_channel_id` set               |
| `CHANNEL_PLANNING`      | `FAILED`                | No channel can be satisfied                       | `NO_VIABLE_CHANNEL`; credit refunded                     |
| `EXECUTING`             | `RECEIPT_ACQUISITION`   | Provider confirms cancellation                    |                                                          |
| `EXECUTING`             | `CHANNEL_PLANNING`      | Channel failed and another remains                | Re-plan; no new charge                                   |
| `EXECUTING`             | `FAILED`                | `PROVIDER_REFUSED`, `TIMEOUT` or `INTERNAL_ERROR` | Refund only for `INTERNAL_ERROR`                         |
| `RECEIPT_ACQUISITION`   | `AWAITING_VERIFICATION` | Receipt saved                                     | `receipts` row exists; mandate becomes `CONSUMED`        |
| `AWAITING_VERIFICATION` | `SUCCEEDED`             | `NO_REBILL`, or `UNKNOWN` 30 days after `due_at`  |                                                          |
| `AWAITING_VERIFICATION` | `DISPUTED`              | `REBILLED`                                        | Dispute package generated                                |
| any non-terminal        | `WITHDRAWN`             | User withdraws                                    | No refund once a credit is consumed                      |
| any non-terminal        | `FAILED`                | Mandate revoked                                   | `MANDATE_REVOKED`; no refund                             |

Terminal statuses are `SUCCEEDED`, `FAILED`, `WITHDRAWN` and `DISPUTED`; reaching one sets `closed_at`. A case may stay non-terminal for at most 60 days, after which it moves to `FAILED` with `TIMEOUT`. Every transition writes one `audit_logs` row.

## Pricing

Billing is per cancellation request, not per success, so it never depends on the user reporting an outcome.

- One cancellation request costs **one credit**. A credit costs **S$1.99**.
- A request covers one provider and one service, until the case closes: all channels, retries, the receipt, verification, and one dispute package.
- The credit is consumed at `DRAFT → DISCOVERY`. Provider search and browsing the knowledge base are free.
- Refunds are automatic and depend only on system state, never on a user claim. A refund is issued only for `PROVIDER_UNSUPPORTED`, `NO_VIABLE_CHANNEL` and `INTERNAL_ERROR`.
- `ORG_MONTHLY` plan: **S$29 per month** grants **20 credits** (`PLAN_GRANT`, expiring at renewal). Extra credits cost **S$1.49**.
- Payment uses Stripe Checkout (test mode during the hackathon). Credits are granted only by the Stripe webhook, keyed on `stripe_ref`, so a replayed webhook cannot grant twice.
- Every price is a config value with the default above. None is hard-coded.

## Limits

| Limit                                | Value                                          |
| ------------------------------------ | ---------------------------------------------- |
| Cases created per user per day       | 10                                             |
| Open (non-terminal) cases per owner  | 20                                             |
| Active mandates per holder           | 5                                              |
| One-time code sends per holder phone | 3 per hour                                     |
| One-time code                        | 6 digits; expires after 10 minutes; 5 attempts |
| Outbound emails per mandate          | 10 per day                                     |
| Outbound calls per mandate           | 5 per day                                      |
| MCP and chat read tools              | 60 per minute per user                         |
| MCP and chat write tools             | 10 per minute per user                         |
| Agent tool-call rounds per turn      | 12                                             |
| Model spend                          | Monthly budget per owner key, set in config    |

## Error codes

Every tRPC procedure, tool and API route returns only these codes. Do not add codes.

| Code                          | Meaning                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `UNAUTHORIZED`                | No valid session or token                                        |
| `FORBIDDEN`                   | Signed in but not allowed (for example a non-admin)              |
| `NOT_FOUND`                   | Missing, or owned by someone else                                |
| `VALIDATION`                  | Input failed its schema or a precondition                        |
| `CONFIRM_REQUIRED`            | A confirm tool was called without `confirm: true`                |
| `PII_NOT_ALLOWED`             | Input contained a personal identifier                            |
| `RATE_LIMITED`                | A per-minute or per-hour limit was hit                           |
| `LIMIT_REACHED`               | A count cap was hit (open cases, active mandates, cases per day) |
| `PAYMENT_REQUIRED`            | No credit left                                                   |
| `MODEL_BUDGET_EXCEEDED`       | The monthly AI budget is used up                                 |
| `ILLEGAL_TRANSITION`          | The case lifecycle forbids this move                             |
| `UNKNOWN_TOOL`                | Unknown or executor-only tool                                    |
| `VAULT_RELEASE_DENIED`        | A vault release rule failed                                      |
| `SANDBOX_DESTINATION_BLOCKED` | A sandbox case tried a non-sandbox destination                   |
| `INTERNAL_ERROR`              | Anything else; the details stay in server logs                   |

## Environment variables

All are read only through `~/shared/config/env`, and listed in `.env.example` and the README. The spec in brackets explains each one.

- Core: `DATABASE_URL`, `POSTGRES_PORT`, `APP_URL`, `VALKEY_URL`, `CRON_SECRET`, `ADMIN_EMAILS` [0001, 0003]
- Auth: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MCP_DEV_BYPASS`, `MCP_DEV_USER_EMAIL`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` [0001, 0006]
- Vault and storage: `VAULT_MASTER_KEY`, `VAULT_KEY_VERSION`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` [0002]
- Model: `META_API_KEY`, `META_BASE_URL`, `MODEL_STANDARD`, `MODEL_CONTRIBUTOR`, `MODEL_PROVIDER`, `MODEL_PRICES_JSON`, `MODEL_BUDGET_USER_MICROS`, `MODEL_BUDGET_ORG_MICROS` [0004]
- Messaging: `SMTP_URL`, `SANDBOX_SMTP_URL`, `MAIL_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_VOICE_FROM`, `TELEPHONY_PROVIDER`, `VOICE_WORKER_URL`, `LIVE_MODE_ENABLED` [0001, 0005]
- Billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREDIT`, `STRIPE_PRICE_CREDIT_ORG`, `STRIPE_PRICE_ORG_MONTHLY`, `PRICE_CREDIT_DISPLAY` [0007]

`TRUST_IDENTITY_HEADER` is removed by spec 0001.

## Vault release rules

The channel executor replaces a token with the real value only when every condition holds:

1. The case is `EXECUTING` and its mandate is `ACTIVE` and not expired.
2. The step's channel is `is_verified_destination = true` and belongs to `mandates.provider_id`.
3. The secret kind is listed in that channel's `required_secrets`.
4. For `NRIC`, `PIN` and `ACCOUNT_NO`, the holder has approved this release (`holder_approved_at`).
5. If the case is `sandbox = true`, the destination is on the sandbox allowlist.

Each release writes one `vault_releases` row and one `audit_logs` row. A failed check stops the step with status `FAILED`; the value is never sent.

## Retention

| Data                                                            | Kept for                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `case_documents` of kind `BILL`, `CONTRACT`, `SCREENSHOT`       | 30 days after `closed_at`                                                     |
| `LOA`, `RECEIPT`, `DISPUTE_PACKAGE` documents, `communications` | 18 months after `closed_at`                                                   |
| `vault_secrets`                                                 | Until the holder deletes them, or 90 days after the holder's last case closes |
| Call audio                                                      | Not stored. Streamed to transcription, then discarded.                        |
| `audit_logs`                                                    | 5 years                                                                       |
| `channel_outcome_stats`, provider tables                        | Indefinitely (no personal data)                                               |

A daily job enforces retention and logs each purge to `audit_logs`.

## Never stored

Raw class V values outside `vault_secrets`. Provider login passwords. Card numbers (Stripe holds them). Call recordings. Personal data in URLs, query strings or application logs.
