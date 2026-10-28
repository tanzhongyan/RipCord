# Lessons

Pain-point rules. Load this file only when a gate fails or a surprise matches a rule. Add one row per new failure before you close the task. Archive older rows to `docs/archive/` past 200 lines.

| #   | Rule                                                                                                     | Owner    | Detection                                       |
| --- | -------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| 1   | Run `make verify` before you claim a change is done; `make check` before you open a pull request         | Author   | Agent stop hook, CI `gates` job                 |
| 2   | Put `"use client"` files behind `~/trpc/react`; never import `~/server/**` from them                     | Author   | ast-grep `client-no-server-imports`             |
| 3   | Read configuration through `~/shared/config/env`; add each new variable to `.env.example` and the README | Author   | ast-grep `no-env-outside-config`, `make policy` |
| 4   | Filter every query by `ctx.ownerId`; never trust an id from input alone                                  | Reviewer | Tenant isolation tests in `router.test.ts`      |

## Incident log

| Date | Task | Mistake | Fix | Detection |
| ---- | ---- | ------- | --- | --------- |
