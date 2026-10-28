---

type: spec
status: draft
---

# 0007 Billing, Verification and Dashboard

Builds on `docs/specs/0000-data-contract.md` (Pricing, `billing_customers`, `credit_ledger`, `verifications`, lifecycle) and specs 0001–0006.

## Problem

RipCord charges S$1.99 per cancellation request. Charges must be exact, never doubled, and refunded only by system rules. After a cancellation, RipCord must check that the provider stopped billing and help the user dispute it if not. Users and admins need one place to watch every case.

## Solution

### Credits

- **Balance** = sum of `credit_ledger.delta` for the billing customer. Plan credits expire through `EXPIRE` rows, so the balance needs no date filter.
- **Consume.** `start-case` runs one transaction:
  1. `SELECT … FOR UPDATE` on the `billing_customers` row.
  2. Compute the balance. If it is under 1, abort with `PAYMENT_REQUIRED` and a Checkout URL.
  3. Insert `CONSUME -1` with `case_id`.
  4. `transition(DRAFT → DISCOVERY)`.

  The unique index on `(case_id) WHERE reason = 'CONSUME'` makes a retry harmless.
- **Which customer pays.** A case with `org_id` charges the org's billing customer; otherwise it charges the owner's. One is created on first use, with a Stripe customer.
- **Refund.** The engine's transition to `FAILED` with `PROVIDER_UNSUPPORTED`, `NO_VIABLE_CHANNEL` or `INTERNAL_ERROR` inserts `REFUND +1` in the same transaction (unique per case). It is a credit refund, not a card refund. There is no refund for any other reason.
- **Plan expiry.** On each `invoice.paid` for an `ORG_MONTHLY` subscription, first insert `EXPIRE -n`, where `n = min(balance, max(0, last_grant − consumes_since_last_grant))`. Then insert `PLAN_GRANT +20`. Both are keyed on the invoice ID as `stripe_ref`.

### Stripe (`stripe@23.0.1`, test mode for the hackathon)

- `billing.checkout({ quantity: 1 | 5 | 10 })` creates a Checkout Session in `payment` mode with price `STRIPE_PRICE_CREDIT` (S$1.99, SGD), or `STRIPE_PRICE_CREDIT_ORG` (S$1.49) when the customer has an active org plan.
- `billing.subscribe()` creates a Checkout Session in `subscription` mode with `STRIPE_PRICE_ORG_MONTHLY` (S$29/month). Only org owners can call it.
- `billing.portal()` opens a Stripe customer portal session.
- **Webhook** `POST /api/stripe/webhook` verifies the signature with `STRIPE_WEBHOOK_SECRET`. It handles:
  - `checkout.session.completed` (payment mode) → `PURCHASE +quantity`
  - `invoice.paid` → plan expiry, then grant
  - `customer.subscription.deleted` → sets the plan to `INDIVIDUAL`

  Each grant is idempotent on `stripe_ref`, so a replayed event is ignored. Unknown events return 200.
- Prices live in Stripe and in env. The app never hard-codes amounts except to display them from env (`PRICE_CREDIT_DISPLAY="S$1.99"`).

### Verification and disputes

- On `RECEIPT_ACQUISITION → AWAITING_VERIFICATION`, insert `verifications` with `due_at = effective_date + 37 days` (one 30-day billing cycle plus 7 days' grace).
- **Daily cron** `POST /api/cron/verifications` (Bearer `CRON_SECRET`):
  - Selects rows with `due_at ≤ now() AND result IS NULL`, through the partial index.
  - Emails the case owner once: "Did {provider} bill {alias} again after {effective_date}? Upload the latest bill or tell us." The email links to the case page.
  - Rows still unresolved 30 days after `due_at` get `UNKNOWN`, and the case moves to `SUCCEEDED`.
- The user resolves the check with `report-bill-check`:
  - `NO_REBILL` → `SUCCEEDED`.
  - `REBILLED` → generates the dispute package, then `DISPUTED`.
  - If a bill is uploaded, the extraction (spec 0004) checks for charges dated after `effective_date` and proposes the result. The user still confirms.
- **Dispute package.** A PDF (`pdf-lib`) stored as `DISPUTE_PACKAGE`. It contains:
  - a cover letter to the card issuer
  - a case timeline from `audit_logs` (dates and actions only)
  - the receipt (reference code, effective date)
  - the notice email's date and `Message-ID`
  - the LOA reference
  - the disputed charge, as entered by the user

  It is rendered with tokens resolved, only for download by the case owner, and the rendered copy is not stored.

### Dashboard (server components through `~/trpc/server`)

| Page                  | Content                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard`          | Case list: alias, provider, status badge, last update. Filters by status and holder. Cursor pagination on `(updated_at DESC, id)`, 25 per page. Shows the credit balance and a "New cancellation" button. |
| `/cases/[id]`         | Status timeline, recommendation and costs, steps with an "Approve" button for `AWAITING_APPROVAL`, live transcript and cards (SSE), documents, receipt, verification, "Withdraw".                         |
| `/billing`            | Balance, buy credits, org plan, ledger (newest first, 50 per page), Stripe portal link.                                                                                                                   |
| `/admin` (admin only) | Provider review queue (spec 0003), data subject requests (spec 0002), audit chain status, model spend this month by owner, case counts by status and provider.                                            |
| `/settings`           | Profile, organisations and members, connected agents (spec 0006), privacy requests.                                                                                                                       |

The UI uses shadcn/ui primitives in `~/shared/components/ui`. Status badges map each `case_status` to one colour token in `globals.css`.

## Acceptance Scenarios

- **B1 Purchase.** Given a replayed `checkout.session.completed` for quantity 5, when the webhook runs twice, then exactly one `PURCHASE +5` row exists.
- **B2 Consume.** Given a balance of 1, when two `start-case` calls for different cases race, then exactly one succeeds and the other returns `PAYMENT_REQUIRED`.
- **B3 Idempotent start.** Given `start-case` succeeded, when it is retried for the same case, then the balance does not change.
- **B4 Refund rules.** Given a started case, when it fails with `NO_VIABLE_CHANNEL`, then one `REFUND +1` row exists. When it fails with `PROVIDER_REFUSED`, then no refund row exists.
- **B5 Withdraw.** Given a started case is withdrawn, then no refund is issued.
- **B6 Plan renewal.** Given an org got 20 plan credits and used 12, when the next `invoice.paid` arrives, then `EXPIRE -8` and `PLAN_GRANT +20` are written, in that order.
- **B7 Webhook signature.** Given a request with a bad signature, then the webhook returns 400 and writes nothing.
- **B8 Verification due.** Given a verification due yesterday, when the cron runs, then the owner gets one email. When the cron runs again, then no second email is sent (a Valkey flag is set per verification).
- **B9 Silent success.** Given a verification 30 days past due with no answer, when the cron runs, then the result is `UNKNOWN` and the case is `SUCCEEDED`.
- **B10 Dispute.** Given `report-bill-check { result: REBILLED }`, then a `DISPUTE_PACKAGE` document exists, the case is `DISPUTED`, and the stored PDF contains tokens, not raw identifiers.
- **B11 Dashboard isolation.** Given users A and B, when A loads `/dashboard`, then only A's and A's orgs' cases are listed.

## Budgets

- `/dashboard` server render under 400 ms p95 with 1,000 cases for the owner (one indexed query plus one count).
- Balance query under 10 ms p95 (index on `billing_customer_id`). Cache it in Valkey for 30 s, cleared on any ledger insert.
- Webhook handling under 1 s; Stripe retries cover failures.

## Public Entry Points

| Entry point                                                                                             | Contract                                                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| tRPC `billing.balance` / `billing.ledger` / `billing.checkout` / `billing.subscribe` / `billing.portal` | As above                                                                |
| `POST /api/stripe/webhook`                                                                              | Stripe events, raw body, signature checked                              |
| `POST /api/cron/verifications`                                                                          | Daily job                                                               |
| tRPC `cases.list` / `cases.get`                                                                         | Dashboard data (same handlers as the `list-cases` and `get-case` tools) |
| tRPC `admin.overview`                                                                                   | Admin-only metrics                                                      |

## Implementation Notes

- New env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CREDIT`, `STRIPE_PRICE_CREDIT_ORG`, `STRIPE_PRICE_ORG_MONTHLY`, `PRICE_CREDIT_DISPLAY`, `APP_URL`.
- Cron routes are called by Vercel Cron in production (`vercel.json`), and by hand or with `bun run cron:<name>` locally.

## Decisions & Out of Scope

- Per-request pricing replaces success fees, so revenue never depends on users reporting outcomes. Refunds follow system state only.
- Rejected: card refunds for failed cases (Stripe fees make S$1.99 refunds uneconomic). Credits keep the value.
- Out of scope: invoices with GST, coupons, affiliate payouts, and multi-currency.
