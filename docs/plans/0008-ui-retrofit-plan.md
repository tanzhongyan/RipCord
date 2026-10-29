---

type: plan
status: active
---

# 0008 UI Retrofit - Plan

Implements `docs/specs/0008-ui-retrofit.md`. Source for every port: `tanzhongyan-org/template-fullstack-t3` at `main`. Fetch files with `gh api repos/tanzhongyan-org/template-fullstack-t3/contents/<path>`.

## Assumptions

- **A1** Copying a template file without changing its logic counts as one file toward the 3-file cap. CLI-generated shadcn files count as one file in total.
- **A2** Runtime packages: `next-themes` and `sonner` (toasts on 3+ screens) and one markdown renderer for chat use the spec's 3-package budget (owner raised it from 2). The markdown renderer is `react-markdown` (MIT) with raw HTML off and no plugins; the worker checks its current version and licence. The one-time-code field is a plain `input` with `autocomplete="one-time-code"`, not the `input-otp` package.
- **A3** Route groups `src/app/(public)` and `src/app/(app)` hold the layouts. URLs do not change. New directories (the route groups, `e2e`) need `layout.allow` entries in `scripts/repo-policy.json` and one ADR in `docs/decisions/`, added in the ticket that creates them (T4 and T18).
- **A4** The landing page reads `PRICE_CREDIT_DISPLAY` and the org price from `env` at build time. No price is typed into copy.
- **A5** T0 ends at an owner gate: T3 onwards may not start until `EXPERIENCE.md` and `DESIGN.md` say `status: approved`.
- **A6** Spec S8 (mobile) applies to every screen ticket. Each ticket from T4 onwards is also blocked by T18. It adds its routes to the E2E route list, and `make e2e` must pass at 375, 768 and 1280 px before the ticket is done. Its PR attaches screenshots at the three widths.

## Order

T0 → T1 → T2 → T3 → (T18, T5, T6, T10 in parallel) → (T4, T9) → (T7, T8, T11–T15) → T16 → T17

## Tickets

### T0 - Product map, brand doc and marks

**Blocked by:** None. Planning tier.
**Touches auth, data or money:** no
**Files:** `EXPERIENCE.md`, `DESIGN.md`, `public/mark.svg` (mark A, `currentColor`), `src/app/icon.svg` (mark C)
**What to build:** Write both docs from spec S3 and S4 using the product-lane section list. Draw the marks: two round strokes, left tip rising, right tip dipping, no blade. Mark C is mark A in white on a coral rounded square. Add a licence table: Geist (OFL-1.1) and Lucide (ISC).
**Acceptance:**
- [ ] Both docs have every product-lane section; `make lint` passes
- [ ] `icon.svg` reads clearly at 16 px, shown in a screenshot in the PR
- [ ] Owner sets `status: approved` on both docs

### T1 - Tokens, theme and contrast gate

**Blocked by:** T0
**Touches auth, data or money:** no
**Files:** `src/styles/globals.css`; port `scripts/generate-tokens.ts` and `scripts/check-contrast.ts` with their token source and `make tokens` / `make contrast` targets; port `theme-provider.tsx` and `theme-toggle.tsx`
**What to build:** Ink and cut tokens for light and dark as shadcn CSS variables. Add `next-themes` (`attribute="class"`, `defaultTheme="system"`, `disableTransitionOnChange`) in `layout.tsx` with `suppressHydrationWarning`. Add a `docs/dependencies.md` row.
**Acceptance:**
- [ ] `make contrast` exits 0. Lowering one pair below AA makes it exit non-zero (paste both outputs).
- [ ] Reload in dark mode: no light frame and no hydration warning in the console (B6)

### T2 - Site config, metadata and brand check

**Blocked by:** T1
**Touches auth, data or money:** no
**Files:** port `src/shared/config/site.ts`, `src/app/layout.tsx` metadata, port `opengraph-image.tsx` and `apple-icon.tsx`; port `scripts/brand-check.mjs` with `make brand-check`
**What to build:** Titles use the `%s · RipCord` template from `site`. The OG image shows mark, name and tagline on off-white. Delete `public/favicon.ico` if `icon.svg` replaces it.
**Acceptance:**
- [ ] `make brand-check` exits 0. `rg "Create T3 App" src` finds nothing (B1).
- [ ] `/opengraph-image` returns a 1200×630 PNG on `next start`

### T3 - UI primitives

**Blocked by:** T2
**Touches auth, data or money:** no
**Files:** shadcn CLI output in `src/shared/components/ui/` (A1): input, label, textarea, dialog, dropdown-menu, tabs, skeleton, separator, sonner, table, sidebar, avatar, sheet
**What to build:** Generate with the CLI and keep the code unchanged. Check that `input` and `textarea` keep shadcn's `text-base md:text-sm` (16 px on phones); add it if the installed version lacks it. Add `<Toaster />` to the root layout. Add the `sonner` row to `docs/dependencies.md`.
**Acceptance:**
- [ ] `make check` passes. Knip reports no unused export that a later ticket does not use (list the expected ones in the PR).

### T4 - Public shell

**Blocked by:** T3
**Touches auth, data or money:** no
**Files:** port `site-header.tsx`, `site-footer.tsx` and `nav-links.tsx`; `src/app/(public)/layout.tsx`
**What to build:** The header has mark A plus the `ripcord` wordmark linking to `/`, the nav from `site`, and "Sign in" / "Open app" (→ `/dashboard`). Below `md`, the nav moves into a `sheet` opened by a menu button. The footer has legal links and contact. Move `page.tsx` and `sign-in` into `(public)`.
**Acceptance:**
- [ ] Playwright: clicking the header mark on `/privacy` and `/sign-in` lands on `/` (B2)
- [ ] Playwright: at 375 px a menu button opens the nav; at 1280 px the nav is inline and no menu button shows (B16)

### T5 - Legal pages, SEO files and error pages

**Blocked by:** T3
**Touches auth, data or money:** no
**Files:** port `legal-page.tsx` with the `/privacy`, `/terms` and `/refund` pages (A1, content from `site` and the data contract's retention and refund rules); port `sitemap.ts` and `robots.ts`; port `not-found.tsx` and `global-error.tsx`
**What to build:** The sitemap lists public routes only. `robots` allows AI crawlers and disallows app routes.
**Acceptance:**
- [ ] On a production build, `/sitemap.xml` has no `/dashboard`, `/cases`, `/chat`, `/billing`, `/settings` or `/admin` (B13)
- [ ] An unknown URL shows the branded 404

### T6 - Storybook harness

**Blocked by:** T3
**Touches auth, data or money:** no
**Files:** port `.storybook/main.ts`, `preview.tsx` and `mock-providers.tsx`; `make stories` and `make stories-build`; dev dependencies only
**What to build:** Mock auth session and tRPC providers plus a theme switcher, as in the template. Viewport presets for 375, 768 and 1280 px, with 375 px as the default.
**Acceptance:**
- [ ] `make stories-build` exits 0 with one sample story for `button`; the toolbar offers the three viewports (B15)

### T18 - E2E harness and responsive check

**Blocked by:** T3
**Touches auth, data or money:** no
**Files:** port the template's `scripts/playwright-run.mjs` with its Playwright config and `make e2e`; `e2e/responsive.e2e.ts` (one route list, signed-in routes through the dev sign-in); dev dependency `@axe-core/playwright` (dev-only, so the licence rule exempts it)
**What to build:** For each route in the list, at 375, 768 and 1280 px:

- assert `document.documentElement.scrollWidth <= window.innerWidth`;
- run axe and fail on serious or critical issues;
- save a screenshot under `e2e/screenshots/` (git-ignored) for the PR.

Start with the routes that exist. Later tickets add theirs (A6).
**Acceptance:**
- [ ] `make e2e` exits 0 on the current public routes
- [ ] A temporary 500 px-wide element on `/` makes `make e2e` fail at 375 px (paste the output, then remove it) (B14)

### T7 - Landing page

**Blocked by:** T4, T5
**Touches auth, data or money:** no
**Files:** `src/app/(public)/page.tsx`, `src/shared/components/rope-divider.tsx` (signature element), `src/app/(public)/landing-content.ts` (FAQ and section copy)
**What to build:** The spec S5 sections in order, with `FAQPage` and `Organization` JSON-LD. Prices come from `env` (A4). Remove `force-dynamic` and the session read. Copy follows the `DESIGN.md` voice and claims only behaviour from specs 0001–0007.
**Acceptance:**
- [ ] `next build` lists `/`, `/privacy`, `/terms` and `/refund` as static (B4)
- [ ] `curl` of `/` with no JS contains every section heading, `S$1.99` and the legal links (B3)
- [ ] The Google Rich Results test or `schema-dts` validation passes for both JSON-LD blocks

### T8 - Sign-in page

**Blocked by:** T4
**Touches auth, data or money:** yes (auth UI only)
**Files:** `src/app/(public)/sign-in/page.tsx`, `src/features/identity/components/sign-in.tsx`
**What to build:** A two-column layout from a shadcn login block: a brand panel with the rope mark, and a form with email then code. Same `authClient.emailOtp` calls. Errors stay generic.
**Acceptance:**
- [ ] Existing identity tests pass unedited (B12)
- [ ] Playwright: known and unknown emails get the same message. The dev-console code signs in and lands on `/dashboard` (B9).

### T9 - App shell and admin guard

**Blocked by:** T3
**Touches auth, data or money:** yes (auth guard)
**Files:** `src/app/(app)/layout.tsx` (session check → redirect `/sign-in`, `robots: noindex`), `src/shared/components/app-sidebar.tsx` (nav, user menu, theme toggle, Admin item only for admins), `src/app/(app)/admin/page.tsx` (`FORBIDDEN` → `notFound()`)
**What to build:** Move every app route into `(app)`. Reuse the existing session and admin role helpers; search with `rg` first. Use shadcn Sidebar's built-in mobile mode with a top-bar trigger below `md`. Check its API in the installed version first. The layout uses `min-h-dvh`. Replace the T1 light/dark toggle with the template's three-item menu (system, light, dark) in the user menu, and remove `theme-toggle.tsx` from the knip `ignore` list in `package.json`.
**Acceptance:**
- [ ] Playwright: a signed-in user reaches every App route by clicking only, at 375 and 1280 px (B5)
- [ ] Playwright: at 375 px the sidebar opens as a slide-out from the trigger (B16)
- [ ] Entry-point test: a non-admin gets 404 at `/admin` and no admin data in the HTML; it fails against the pre-change code (`_scripts/undo-test.ps1`)

### T10 - Shared state components

**Blocked by:** T3
**Touches auth, data or money:** no
**Files:** `src/shared/components/empty-state.tsx`, `src/shared/components/route-error.tsx`, `src/shared/components/page-skeleton.tsx`
**What to build:** One empty state (icon, title, body, CTA), one route error with retry, and one skeleton. Later tickets reuse these in every `loading.tsx` and `error.tsx`. Write a story for each.
**Acceptance:**
- [ ] `make stories-build` exits 0 with the three stories

### T11 - Dashboard and first run

**Blocked by:** T6, T9, T10
**Touches auth, data or money:** no (reads existing procedures only)
**Files:** `src/app/(app)/dashboard/page.tsx`, `case-list.tsx`, `loading.tsx` + `error.tsx` (thin)
**What to build:** 3 stat cards (open cases, credit balance, last outcome) from existing tRPC procedures, and a case table with a status badge. Below `md`, cases render as stacked cards (provider, status badge, updated date) linking to the case. Stat cards show 3 per row, then 2, then 1. With no cases, show the empty state "Start your first cancellation" → `/chat`.
**Acceptance:**
- [ ] `case-list.test.tsx` passes unedited
- [ ] Playwright: cases show as cards at 375 px and as a table at 1280 px (B16)
- [ ] Stories cover ready, loading, empty and error (B8). Playwright: a new user sees the start card (B10).

### T12 - Case page and case chat sheet

**Blocked by:** T11, T13
**Touches auth, data or money:** no
**Files:** `src/app/(app)/cases/[id]/case-detail.tsx`, `src/features/cases/components/case-progress.tsx` (rope line that snaps at `SUCCEEDED`; `FAILED`, `WITHDRAWN` and `DISPUTED` get their own states), `loading.tsx`
**What to build:** A status header, the progress line over the data-contract lifecycle steps, the timeline, and actions. "Ask about this case" opens a `sheet` with `ChatClient caseId={id}`. The sheet fills the screen below `md`. Below `md`, the progress line runs vertically. Move the `--case-*` status colours in `globals.css` (still raw oklch after T1) into `src/shared/config/tokens.ts`, so `make contrast` covers them.
**Acceptance:**
- [ ] Stories for each terminal status and one in-flight status
- [ ] Playwright: at 375 px the case chat sheet fills the viewport (B16)
- [ ] Playwright: the sheet's first chat request carries the case id, and a write tool shows the confirm card (B11)

### T13 - Chat display pieces

**Blocked by:** T6, T10
**Touches auth, data or money:** no
**Files:** `src/features/chat/components/chat-client.tsx`, `src/features/chat/components/message.tsx`, `src/features/chat/components/tool-card.tsx` (copied in from AI Elements markup only)
**What to build:** Split the 345-line client into state (kept) and display pieces. Keep the SSE schema, draft, auto-scroll and attachments. Do not add the `ai` package. Markdown follows A2. The chat fills `h-dvh` minus the header. The composer is sticky at the bottom with `env(safe-area-inset-bottom)` padding, and its textarea text is 16 px. Code blocks and long URLs wrap or scroll inside their bubble, never the page.
**Acceptance:**
- [ ] `agent.test.ts` and `route.test.ts` pass unedited (B12)
- [ ] Playwright at 375 px: focusing the composer keeps the zoom at 1 and the composer in view; a reply with a long URL causes no page overflow (B16, B14)
- [ ] Stories: streaming, tool running, tool error, confirm card, empty

### T14 - Restyle billing and settings

**Blocked by:** T9, T10
**Touches auth, data or money:** yes (billing UI only)
**Files:** `billing-view.tsx`, `src/app/(app)/settings/page.tsx`, `connected-agents.tsx`
**What to build:** Primitives and tokens only. Behaviour is unchanged. Tables become stacked cards below `md`, using the T11 pattern; the pattern is not copied. Settings tabs scroll sideways inside their own bar if they overflow.
**Acceptance:**
- [ ] `billing-view.test.tsx` passes unedited; loading and empty stories for billing

### T15 - Restyle admin, mandate and consent

**Blocked by:** T9, T10
**Touches auth, data or money:** yes (mandate signing UI)
**Files:** `admin-view.tsx`, `mandate-review.tsx`, `consent-form.tsx`
**What to build:** Same as T14. `/m/[mandateId]` and `/oauth/consent` get the brand header only (spec S4). The mandate page is laid out for 375 px first, because holders open it from an SMS. The code field uses `inputmode="numeric"` and `autocomplete="one-time-code"`, and the "I authorise" button is never below a fixed bar.
**Acceptance:**
- [ ] `admin-view.test.tsx` and the mandate tests pass unedited

### T16 - Raw colour and control bans

**Blocked by:** T7, T8, T11–T15
**Touches auth, data or money:** no
**Files:** port the template's ast-grep rules for raw colours, raw controls and literal titles into `sgconfig.yml` rules; add one rule banning `h-screen` and `min-h-screen`
**What to build:** Turn the bans on once no page breaks them. Replace any `min-h-screen` left by earlier tickets with `min-h-dvh`.
**Acceptance:**
- [ ] `rg -c "(bg|text|border)-(slate|gray|red)-[0-9]|\bh-screen\b|min-h-screen" src` returns 0
- [ ] Adding `bg-slate-950` to any component fails `make lint` (B7); adding `min-h-screen` fails it too (B17); `make check` passes

### T17 - Design pass

**Blocked by:** T16. Planning tier.
**Touches auth, data or money:** no
**Files:** fixes only, with no more than 3 files per round and at most 2 rounds
**What to build:** Screenshot every route at 375, 768 and 1280 px in light and dark, then critique against `DESIGN.md`, `workflow/ui/*` and spec S8. Run `make e2e` and Lighthouse on `/`.
**Acceptance:**
- [ ] `make e2e` passes on every route at all three widths: no overflow, no serious or critical axe issues, touch targets ≥ 44 px (B14)
- [ ] Lighthouse mobile on `/`: ≥ 90 in all categories, LCP ≤ 2.5 s, CLS ≤ 0.1; first-load JS for `/` ≤ 120 kB gzipped
- [ ] Screenshots attached; owner approves (B15)

## Requirement Ledger

| Spec scenario / limit          | Ticket                | Evidence                                                            |
| ------------------------------ | --------------------- | ------------------------------------------------------------------- |
| B1 Branding                    | T2                    | `make brand-check`; OG image response                               |
| B2 Home link                   | T4                    | Playwright header test                                              |
| B3 Landing                     | T7                    | `curl` with no JS                                                   |
| B4 Static landing              | T7                    | `next build` route table                                            |
| B5 Navigation                  | T9                    | Playwright click-through; admin 404 test                            |
| B6 Theme                       | T1                    | `make contrast`; console check                                      |
| B7 No raw colours              | T16                   | `make lint` failing on an injected colour                           |
| B8 States                      | T10, T11–T14          | Storybook build                                                     |
| B9 Sign-in                     | T8                    | Playwright enumeration and sign-in                                  |
| B10 First run                  | T11                   | Playwright new-user test                                            |
| B11 Case chat                  | T12                   | Playwright sheet test                                               |
| B12 Behaviour unchanged        | T8, T11, T13–T15      | Existing tests unedited                                             |
| B13 SEO                        | T5, T7                | Sitemap contents; JSON-LD validation                                |
| B14 Accessibility and overflow | T18, T17              | `make e2e` at 375, 768 and 1280 px; injected 500 px element fails   |
| B15 Review                     | T6, T17               | Storybook viewports; PR screenshots at three widths; owner approval |
| B16 Mobile layout              | T4, T9, T11, T12, T13 | Playwright checks at 375 and 1280 px                                |
| B17 Height units               | T16                   | `make lint` failing on an injected `min-h-screen`                   |
| Speed and weight budgets       | T17                   | Lighthouse; build output                                            |
| ≤ 3 new runtime packages       | T1, T3, T13           | `docs/dependencies.md` diff                                         |
