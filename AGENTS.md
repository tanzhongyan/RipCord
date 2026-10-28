# Fullstack T3 Agent Guidelines (L1 Extension)

Inherits: Universal L0 Invariants (workflow/AGENTS.md).
Do not repeat global workflow rules here. The code map and invariants are in `ARCHITECTURE.md`.
This is the only agent instruction file. Claude Code, Codex, Cursor, Copilot and Gemini read it. Do not add CLAUDE.md, GEMINI.md or other per-tool copies: Claude Code ignores this file once a CLAUDE.md exists. `make policy` rejects them.

## 1. Project Technology Stack

- Next.js 16 (App Router), React 19, TypeScript strict, Bun
- PostgreSQL with Drizzle ORM; tRPC 11; Tailwind CSS 4 with shadcn/ui
- Environment validation: `@t3-oss/env-nextjs` in `src/shared/config/env.js`
- Tests: Vitest, colocated `*.test.ts`

## 2. Where things go

- Follow the Code map in `ARCHITECTURE.md`; reuse listed helpers before writing new ones.
- A feature lives in `src/features/<name>/` with components, server, schemas folders and an `index.ts`.
- New top-level or `src/` directories need an ADR and a `layout.allow` change in `scripts/repo-policy.json`, in the same PR.
- New dependencies need a row in `docs/dependencies.md` and a trigger from `docs/decisions/0003-frontend-dependency-policy.md`.

## 3. Data Access & Invariants

- Read `docs/specs/0000-data-contract.md` before touching data, cases, mandates, the vault or billing. Its tables, enums, states, limits and prices are exact. Do not invent anything it does not list; stop and report the gap.
- Read configuration only via `{ env }` from `"~/shared/config/env"` [enforced by ast-grep].
- Procedures use `protectedProcedure` and filter by `ctx.ownerId` [review-only; tenant tests].
- Client components fetch via `api` from `"~/trpc/react"`; server components via `"~/trpc/server"` [review-only].
- Identity is a stub; mark changes with `TEMPLATE-TODO(auth)` until real authentication replaces it.
- After editing `schema.ts` run `make db-generate`.

## 4. Verification Gates

Run `make verify` while working and `make check` before you finish.

1. Gate 1 (Typecheck): `make typecheck`
2. Gate 2 (Lint & Format): `make lint`
3. Gate 3 (Tests & Build): `make test` and `make build`
4. Gate 4 (Dead Code): `make knip`
5. Gate 5 (Duplication): `make dupes` (fallow)
6. Gate 6 (Anti-Slop): `make anti-slop`
