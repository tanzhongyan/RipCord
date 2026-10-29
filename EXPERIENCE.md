---

type: experience
status: draft
---

# RipCord Experience

Owner decisions are in spec 0008 S4. Data rules are in `docs/specs/0000-data-contract.md`; this file never restates a table, price or limit.

## Brief

| Field            | Content                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem and user | People in Singapore pay for subscriptions they cannot easily cancel. Cancelling takes phone queues, retention offers and repeat bills. Adult children often do it for parents. Today they call, email or give up.                                   |
| Hypothesis       | If RipCord cancels a service for S$1.99 under a signed mandate and checks the next bill, then people with an unwanted subscription will pay for one request instead of calling.                                                                     |
| Stage            | `v1`                                                                                                                                                                                                                                                |
| North-star       | Cases reaching `SUCCEEDED` per week                                                                                                                                                                                                                 |
| Inputs           | Sign-ups that start a case; mandates signed within 24 h of the request; cases that are not refunded                                                                                                                                                 |
| Activation event | First mandate signed (`MANDATE_SIGNED`)                                                                                                                                                                                                             |
| Kill criteria    | Fewer than 20 paid requests within 60 days of public launch. **Owner to confirm the number and the launch date.**                                                                                                                                   |
| Monetisation     | Per request, plus the `ORG_MONTHLY` plan, as in the data contract's Pricing section. The person who starts the case pays.                                                                                                                           |
| Top 3 risks      | 1. Providers refuse delegated cancellation; tested by the per-provider success rate. 2. Holders do not sign the SMS link; tested by sign rate within 24 h. 3. Visitors do not trust an agent with accounts; tested by landing → sign-up conversion. |

## Surfaces

| Surface                                           | Status                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Landing (`/`)                                     | In                                                               |
| Web app                                           | In                                                               |
| Admin (`/admin`)                                  | In, admins only                                                  |
| Holder pages (`/m/[mandateId]`, `/oauth/consent`) | In                                                               |
| Mobile app                                        | Out: the holder flow is an SMS link and works in a phone browser |
| MCP and connected agents                          | In (spec 0006)                                                   |

## Personas

- **Requester.** Wants one service gone and does not want to call. Often cancels for a parent. Uses a phone and a laptop.
- **Holder.** The account owner, for example a parent. Has no RipCord account and only sees the SMS link and code. May be wary of links.
- **Org admin.** Runs cancellations for a team or household on the monthly plan.
- **Agent client.** An AI assistant connected through MCP that acts for the requester.
- **RipCord admin.** Watches cases, failures and refunds.

## Key flows

1. **First cancellation (self).**
   - Steps: `/` → "Start a cancellation" → `/sign-in` (email code) → `/dashboard` start card → `/chat`, where the user describes the service → buys a credit if the balance is 0 → confirms "Start cancellation" → pre-flight audit → signs the mandate in-app with an SMS code → the case page shows progress → receipt → bill check.
   - Failures:
     - provider unsupported: the case shows "We can't cancel this provider yet" and the credit is refunded;
     - checkout cancelled: the user returns to chat with the balance unchanged;
     - mandate expires: the case is closed with the reason and a "Start again" link.
2. **Cancel for a parent.**
   - Steps: create holder "Dad" → case reaches `AWAITING_MANDATE` → Dad gets an SMS link → `/m/[id]`: review, code, name, "I authorise" → the requester sees "Signed" on the case page.
   - Failures:
     - Dad declines or revokes: the case is `FAILED` with the reason shown to both;
     - the link expires after 7 days unsigned: the case is `FAILED` with `MANDATE_EXPIRED`, and the case page links to `/chat` to start again;
     - wrong code 5 times: the code is invalidated and the page says how to request another.
3. **Provider bills again.**
   - Steps: verification finds `REBILLED` → case `DISPUTED` → the case page shows "Your provider billed again" and a dispute package download → the user sends it to their bank or the provider.
4. **Buy credits.**
   - Steps: `/billing` → pick 1, 5 or 10 → Stripe Checkout → return to `/billing`, which shows the new balance once the webhook lands.
   - Failure: the webhook is slow, so the balance is unchanged on return. The page says credits can take a few seconds to appear after payment. Automatic refresh is out of scope for spec 0008.
5. **Connect an AI agent.**
   - Steps: the agent starts OAuth → `/oauth/consent` → approve → the agent appears in `/settings/connected-agents` with a revoke button.
   - Failure: the user denies, and the agent gets an error with no access.

## Sitemap and navigation

| Surface | Routes                                                                                      | Navigation                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public  | `/`, `/sign-in`, `/privacy`, `/terms`, `/refund`, 404                                       | Header: mark A + `ripcord` (→ `/`), How it works, Pricing, FAQ (anchors on `/`), Sign in / Open app. Footer: Privacy, Terms, Refunds, contact email. |
| App     | `/dashboard`, `/cases/[id]`, `/chat`, `/billing`, `/settings`, `/settings/connected-agents` | Sidebar: Dashboard, Chat, Billing, Settings (Connected agents is a tab). User menu: email, theme, sign out. Case rows link to `/cases/[id]`.         |
| Admin   | `/admin`                                                                                    | Sidebar item for admins only                                                                                                                         |
| Holder  | `/m/[mandateId]`, `/oauth/consent`                                                          | Brand header only, no links into the app                                                                                                             |

No orphan pages: every route above is reachable from the header, the sidebar, a case row or an SMS link.

## Cross-cutting UX

- **Active nav:** the sidebar and header mark the current route with `aria-current="page"`.
- **User menu:** email, theme (system, light, dark), sign out.
- **Search:** none in v1. The dashboard case table filters by status through the URL, and that one control is reused if search is added.
- **States:** every app route has a skeleton, an error with retry, and an empty state that invites the next step. These come from shared components.
- **Errors:** 404 and 500 pages are branded and link home.
- **Toasts:** for short confirmations only ("Link sent", "Agent revoked"). Errors that need action stay inline.
- **Money and time:** amounts in SGD and dates in the Asia/Singapore time zone, formatted with `Intl`.

## Baseline decisions

Rows in production-baseline §1, §2 and §6–§10 that specs 0000–0007 already implement stay as built. This retrofit decides the UI rows:

| Row                                                                            | Decision                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| §3 Static marketing                                                            | In: `/` and legal pages are static                              |
| §3 Web vitals, images                                                          | In: spec 0008 budgets; brand assets are SVG                     |
| §4 Rendering, states, root errors, forms, theme, accessibility, copy           | In                                                              |
| §4 Optimistic UI                                                               | Out: every RipCord action involves money, mandates or providers |
| §5 Metadata, sitemap, robots, social, structured data, crawlable, answer-first | In                                                              |
| §5 Canonical host, search consoles                                             | Later: decided at domain purchase                               |
| §5 Languages                                                                   | Out: English only in v1                                         |
| §9 Event taxonomy, owner dashboard                                             | Later: needs PostHog, which is not installed; a follow-up spec  |
| §10 Teams                                                                      | In through the org plan (spec 0007)                             |

## Data map

The data classes, purposes and retention periods are in the data contract's Data classes, Retention and Never stored sections. UI work adds no new data. Theme choice lives only in a cookie-free `localStorage` key.

## Responsive and platform

- Phone first for `/`, `/sign-in` and `/m/[mandateId]`, because holders and most visitors arrive from SMS or social links.
- The app sidebar becomes a sheet below 768 px. Tables become stacked rows below 640 px.
- The case chat opens as a side sheet on desktop and full screen on phones.

## Ship

v1 is done when:

- every spec 0008 scenario (B1–B15) has evidence in the plan ledger;
- the owner has walked flows 1–5 on a preview URL at phone and desktop width;
- the kill criteria above are confirmed.
