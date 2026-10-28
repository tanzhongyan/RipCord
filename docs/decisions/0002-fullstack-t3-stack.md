# 2. Use the T3 stack with feature folders

Date: 2026-10-27

## Context

The template targets small teams that need a typed web app and an API from one codebase. The pieces must typecheck end to end, from the database schema to the component, without code generation.

## Decision

Use Next.js (App Router), tRPC, Drizzle ORM over PostgreSQL, Tailwind CSS and shadcn/ui, with Bun as package manager.

Organise code by feature. A feature owns its components, tRPC router and Zod schemas under `src/features/<name>/`. Shared infrastructure lives in `src/server/` (tRPC context, database) and `src/shared/` (UI primitives, validated environment). `src/app/` holds routes only. Import boundaries between these areas are enforced by ast-grep rules.

Identity is a stub: the `x-user-id` header is honoured only when `TRUST_IDENTITY_HEADER=true`. Replace it with real authentication before shipping.

## Consequences

- Adding a feature touches one folder plus one line in `src/server/api/root.ts`.
- Moving a feature into its own package later is a folder move, not a rewrite.
- The header identity is not safe on the open internet; every derived repo must replace it.
- Bun and Next.js both move quickly, so Renovate bumps are expected weekly.
