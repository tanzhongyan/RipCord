# 10. E2E folder and route groups

Date: 2026-10-29

## Context

Plan 0008 retrofits the UI. Spec S8 requires every screen to work at 375,
768 and 1280 px, and B14 requires a check that fails on horizontal
overflow or serious axe issues. Plan 0008 A3 also splits layouts into
route groups.

## Decision

- `e2e/` holds Playwright specs named `*.e2e.ts`. `make e2e` runs
  `scripts/playwright-run.mjs`, which builds, starts `next start` on a free
  port with `SKIP_ENV_VALIDATION=1`, runs Playwright and stops the server.
  Screenshots go to `e2e/screenshots/` (git-ignored). `make e2e` is not part
  of `make check`; it needs a browser and a production server.
- The `(public)` and `(app)` route groups under `src/app` hold the public and signed-in
  layouts. Route groups do not change URLs. T4 creates them and adds their
  `layout.allow` entries.
- `e2e` joins `layout.allow` in `scripts/repo-policy.json`.

## Consequences

Each screen ticket adds its routes to the list in `e2e/responsive.e2e.ts`.
`@axe-core/playwright` is a dev dependency only.
