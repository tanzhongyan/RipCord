---

type: spec
status: approved
---

# 0008 UI Retrofit: Brand, Shell, Landing and Screens

Builds on specs 0000–0007 and the product lane (`docs` repo: `workflow/product-lane.md`, `workflow/production-baseline.md` §3–§5, `workflow/ui/*`). Changes no table, enum, price or limit in `0000-data-contract.md`.

## Problem

RipCord's backend works, but it does not look or behave like a product people would trust with their subscriptions:

- The tab says "Create T3 App" and uses the default favicon.
- `/` is a sign-in box. It never says what RipCord does, what it costs, or why it is safe.
- No header, footer or sidebar exists. Dashboard, cases, chat, billing, settings and admin are reachable only by typing the URL.
- Pages hardcode 59 Tailwind colours, mixing a dark landing page with light app pages. There is no dark mode.
- Only 3 UI primitives exist. Forms, tables and the 345-line chat are hand-styled.
- There are no legal pages, sitemap, robots, OG image, 404 page, loading states or Storybook.

`template-fullstack-t3` now ships all of these. RipCord predates it.

## Solution

### S1. Reuse rule

Every UI choice in this spec follows one rule:

- **Copied-in source** (shadcn primitives and blocks, AI Elements): always allowed. It becomes our code under `src/shared/components/` or the owning feature.
- **New installed runtime package:** only with 3 or more uses, or when it replaces about 150 lines we would write. It also needs a `docs/dependencies.md` row.

### S2. Template shell

Port from `template-fullstack-t3` into RipCord. Copy each file, then adapt it; do not rewrite.

- `src/shared/config/site.ts`: name, tagline, description, URL, nav items and legal fields. Every title, nav link and legal page reads it.
- `site-header`, `site-footer`, `nav-links`, `theme-provider`, `theme-toggle` and `legal-page`.
- The 12 primitives, plus `input`, `table`, `sidebar`, `avatar` and `sheet` from shadcn.
- `not-found`, `global-error`, `icon`, `apple-icon`, `opengraph-image`, `robots`, `sitemap`, and the `/privacy`, `/terms` and `/refund` pages.
- `.storybook` with mock auth and tRPC providers and 375, 768 and 1280 px viewport presets.
- The Playwright E2E harness (`make e2e`), with the overflow and axe check from S8.
- The ast-grep rules that ban raw colours, raw controls, literal titles and `h-screen` / `min-h-screen`.

### S3. Brand (`DESIGN.md`)

Ticket 0 writes `DESIGN.md` from these owner decisions. The owner approves it before any screen ticket starts.

| Item                  | Decision                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mark                  | Two round strokes: a rope broken in the middle, the left tip rising and the right tip dipping. No blade or scissors.                                                                                       |
| Home link             | Mark plus the lowercase wordmark `ripcord` in the header, linking to `/`                                                                                                                                   |
| Favicon and app icon  | The mark in white on a rounded coral square (`icon.svg`, `favicon.ico`, `apple-icon.png`)                                                                                                                  |
| OG image              | 1200×630: the mark, name and tagline on off-white                                                                                                                                                          |
| Palette "Ink and cut" | Off-white `#FAF8F3`, ink `#1B1F2A`, coral `#D85A30` (the cut, one accent per view), muted `#6B6F7A`. Dark mode inverts ink and paper. Ticket 0 sets the final values so every pair passes `make contrast`. |
| Type                  | Geist for text, Geist Mono for amounts, case IDs and reference numbers. Both are already installed.                                                                                                        |
| Icons                 | `lucide-react` (already installed)                                                                                                                                                                         |
| Signature element     | The rope break: a section divider on the landing page, and the case progress line that snaps at `SUCCEEDED`                                                                                                |
| Voice                 | Plain and calm. States what RipCord does and does not do. No hype words.                                                                                                                                   |
| Avoid                 | Purple gradients, glassmorphism, emoji, stock photos, fake testimonials, fake logos                                                                                                                        |

### S4. Product map (`EXPERIENCE.md`)

Ticket 0 also writes `EXPERIENCE.md` (stage `v1`), which the owner approves.

| Surface         | Routes                                                                                      | Navigation                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Public          | `/`, `/sign-in`, `/privacy`, `/terms`, `/refund`, 404                                       | Header: mark, How it works, Pricing, FAQ, Sign in / Open app. Footer: legal links, contact. |
| App (signed in) | `/dashboard`, `/cases/[id]`, `/chat`, `/billing`, `/settings`, `/settings/connected-agents` | Sidebar: Dashboard, Chat, Billing, Settings. User menu: email, theme, sign out.             |
| Admin           | `/admin`                                                                                    | A sidebar item shown only to admins                                                         |
| Holder links    | `/m/[mandateId]`, `/oauth/consent`                                                          | Brand header only. No app nav, because the holder may not have an account.                  |

Each app route has its own `loading.tsx` and `error.tsx`, plus a written empty state:
- Each state has a Storybook story.
- No page is an orphan: each is reachable from the header, the sidebar or a link on another page.

### S5. Landing page (`/`)

The landing page is static and does not read the session. From top to bottom:

1. **Hero.** One-line value statement, subline, primary CTA "Start a cancellation" (→ `/sign-in`), secondary "How it works".
2. **How it works.** 3 steps: tell us the service → sign a mandate → we cancel and check the bill.
3. **What RipCord will and won't do.** Two short lists, for example "acts only under your signed mandate" and "never stores your card".
4. **Consent and security.** Mandate, one-time code, revoke at any time, and vault tokens, with links to `/privacy` and the security policy.
5. **Pricing.** S$1.99 per request and the org plan, read from the same config values as billing, plus the refund rule from the data contract.
6. **FAQ.** 5–8 questions with `FAQPage` JSON-LD.
7. **Final CTA and footer.**

The copy states only behaviour that specs 0001–0007 implement.

### S6. Screens

| Screen                                                          | Change                                                                                                                                                                          | Reused parts                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/sign-in`                                                      | Two-column email-code sign-in: brand panel plus form. Same `emailOtp` flow.                                                                                                     | shadcn login block, `input` with `autocomplete="one-time-code"` |
| First run                                                       | A user with no cases lands on `/dashboard`'s empty state: one card, "Start your first cancellation" → `/chat`.                                                                  | `card`                                                          |
| `/dashboard`                                                    | 3 stat cards (open cases, credits, last outcome) and a case table: provider, status badge, updated date, link                                                                   | `card`, `table`, `badge`                                        |
| `/cases/[id]`                                                   | Header with status, the progress line (signature element) over the lifecycle steps, timeline, actions. "Ask about this case" opens the chat in a side sheet scoped to the case. | `sheet`, `ChatClient`                                           |
| `/chat`                                                         | Same transport and SSE schema. Messages render markdown; tool calls and confirm cards use the copied-in display pieces. Auto-scroll, draft and attachment behaviour stay.       | AI Elements display pieces (S7)                                 |
| `/billing`, `/settings`, `/settings/connected-agents`, `/admin` | Restyled onto the primitives and tokens only. Behaviour is unchanged.                                                                                                           | `table`, `card`, `tabs`, `dialog`                               |
| `/m/[mandateId]`, `/oauth/consent`                              | Brand header, tokens, primitives. Behaviour is unchanged.                                                                                                                       | `card`, `button`                                                |

### S7. Chat display pieces

Copy AI Elements' conversation, message, tool and confirmation pieces through the shadcn CLI. If they import the `ai` package or a streaming hook, take only their markup and classes and keep RipCord's state. Markdown rendering may add one package, used by both `/chat` and the case sheet, only if it passes S1.

### S8. Mobile responsiveness

Most visitors and every holder arrive from a phone, through an SMS or social link. Screens are built mobile first: base Tailwind classes target 375 px, and `sm`/`md`/`lg` add layout. The check widths are 375, 768 and 1280 px, and no page scrolls sideways at any of them.

Below `md` (768 px):

| Element                                                            | Behaviour                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Public header                                                      | The nav collapses into a menu button that opens a `sheet`. The mark stays as the home link.                          |
| App sidebar                                                        | shadcn Sidebar's mobile mode: a slide-out menu opened from a top-bar trigger                                         |
| Tables (dashboard cases, billing history, connected agents, admin) | Stacked cards showing the key fields (for cases: provider, status badge, updated date) and linking to the same place |
| Sheets and dialogs                                                 | Full screen, including the case chat sheet                                                                           |
| Multi-column sections                                              | One column: landing sections, the sign-in brand panel (shrinks to a top band), stat cards (2 per row, then 1)        |
| Chat composer                                                      | Sticky at the bottom, above the on-screen keyboard and the home indicator                                            |

At every width:

- Input and textarea text is at least 16 px, so iOS does not zoom on focus.
- Full-height layouts use `min-h-dvh`, not `min-h-screen`.
- Fixed and sticky bars pad with `env(safe-area-inset-*)` and never cover content.
- Touch targets are at least 44 px.
- Images use `next/image` with `sizes`; brand assets are SVG.

## Acceptance Scenarios

- **B1 Branding.** Given a production build, when `/` loads, then the tab title comes from `site.ts`, the favicon is the coral mark, `/opengraph-image` returns 1200×630, and no page title contains "Create T3 App".
- **B2 Home link.** Given any public or app page, when the header mark is clicked, then the browser goes to `/`.
- **B3 Landing.** Given a signed-out visitor with JavaScript off, when `/` loads, then all S5 sections, the S$1.99 price and the legal links are in the HTML.
- **B4 Static landing.** Given `next build`, then `/`, `/privacy`, `/terms` and `/refund` are listed as static.
- **B5 Navigation.** Given a signed-in user, when they follow only links, then they can reach every App route. A non-admin never sees the Admin item, and `/admin` shows the 404 page with no admin data (the page maps the router's `FORBIDDEN` to `notFound()`).
- **B6 Theme.** Given the system is in dark mode, when any page reloads, then it renders dark with no light frame and no hydration warning. Every token pair passes `make contrast` in both themes.
- **B7 No raw colours.** Given a component with `bg-slate-950` or a hex colour, when `make lint` runs, then it fails.
- **B8 States.** Given each App route, when its query is loading, empty or fails, then it shows the matching state, and each state has a Storybook story.
- **B9 Sign-in.** Given an unknown email, when a code is requested, then the response matches a known email's. The code from the dev console signs the user in and lands on `/dashboard`.
- **B10 First run.** Given a new user with no cases, when they sign in, then `/dashboard` shows the start card, and its CTA opens `/chat`.
- **B11 Case chat.** Given a case page, when "Ask about this case" is opened, then the sheet's chat sends that `caseId`, and the same confirm card appears as in `/chat`.
- **B12 Behaviour unchanged.** Given the existing test suite, when the retrofit lands, then every existing test passes unedited.
- **B13 SEO.** Given a production build, then `sitemap.xml` lists only public routes, App routes are `noindex`, and `/` has valid `FAQPage` and `Organization` JSON-LD.
- **B14 Accessibility and overflow.** Given every route at 375, 768 and 1280 px, when `make e2e` runs, then axe reports no serious or critical issues, touch targets are at least 44 px, and `document.documentElement.scrollWidth <= window.innerWidth`. A test element 500 px wide makes the check fail at 375 px.
- **B15 Review.** Given each screen PR, then it attaches screenshots at 375, 768 and 1280 px, and the owner approves in Storybook (which offers the three viewports) or the dev pages.
- **B16 Mobile layout.** Given a 375 px viewport:
  - the header shows a menu button that opens the nav, while at 1280 px the nav is inline;
  - the app sidebar opens as a slide-out menu;
  - the dashboard cases show as cards, and as a table at 1280 px;
  - the case chat sheet fills the screen;
  - focusing the chat composer does not zoom the page, and the composer stays visible.
- **B17 Height units.** Given a component using `h-screen` or `min-h-screen`, when `make lint` runs, then it fails.

## Budgets

- **Speed:** landing LCP ≤ 2.5 s on Lighthouse mobile, INP ≤ 200 ms, CLS ≤ 0.1, Lighthouse score ≥ 90 in every category.
- **Weight:** first-load JS for `/` ≤ 120 kB gzipped. The chat bundle loads only on `/chat` and the case sheet.
- **Dependencies:** at most 3 new runtime packages in total (`next-themes`, `sonner` and one markdown renderer), each passing S1 and `make licenses`.
- **Security:** headers and CSP from the template stay intact. No new client-side reads of session data on public routes.
- **Cost:** $0. No paid design tools or AI image services. Brand assets are hand-written SVG.

## Public Entry Points

- **Routes:**
  - public: `/`, `/sign-in`, `/privacy`, `/terms`, `/refund`, `/sitemap.xml`, `/robots.txt`, `/opengraph-image`;
  - app: every route in S4.
- **Config and docs:** `src/shared/config/site.ts`, `EXPERIENCE.md`, `DESIGN.md`.
- **Make targets:** `make lint` (ast-grep bans), `make contrast`, `make brand-check`, `make stories`, `make e2e` (overflow and axe at three widths).

## Decisions & Out of Scope

- **D1** Port the template's shell instead of patching RipCord's pages. Patching would leave two styles in the app.
- **D2** Copy in a shadcn login block, not `better-auth-ui`: one screen does not justify an installed package.
- **D3** Copy in the AI Elements display pieces, not `assistant-ui`: its runtime would replace RipCord's SSE contract.
- **D4** No charts. The dashboard uses stat cards until a second chart is needed.
- **D5** The landing page is static. "Open app" links to `/dashboard`, which redirects signed-out users to `/sign-in`.
- **D6** The mark and palette follow S3. Ticket 0 may adjust hex values only to pass contrast.
- **D7** Stacked cards below `md` instead of horizontally scrolling tables: a phone user sees status and provider without swiping. No responsive-table package.
- **Out of scope:**
  - Branded HTML emails: login codes and invites stay plain text.
  - The `nodemailer` provider channel from spec 0005.
  - Mobile app, i18n, and marketing pages beyond `/`.
  - Blog, testimonials, analytics events.
  - Any change to data, prices, limits or case behaviour.
