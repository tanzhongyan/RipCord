# Contributing

## Prerequisites

| Tool     | Version source                     | Install                               |
| -------- | ---------------------------------- | ------------------------------------- |
| Bun      | `packageManager` in `package.json` | <https://bun.sh>                      |
| Node.js  | `engines.node` in `package.json`   | <https://nodejs.org>                  |
| Docker   | any current version                | <https://docs.docker.com/get-docker/> |
| GNU Make | any version                        | your package manager                  |

All other tools (Biome, knip, fallow, ast-grep, lefthook, markdownlint) install from `package.json`.

## Set up

```bash
make setup
bun run dev:setup
```

You see `[READY] Environment is ready.` at the end.

## Daily loop

```bash
make verify
make check
```

`make verify` runs typecheck, lint, anti-slop rules and policy checks in a few seconds with no database. `make check` adds tests, build, knip and fallow, and needs `DATABASE_URL` pointing at a migrated database. Both print nothing noisy on success and a failing gate on error.

## Add a feature

Use the notes slice as the model. Replace `<name>` with your feature.

1. Add the table to `src/server/db/schema.ts`, then run `make db-generate`.
2. Create `src/features/<name>/schemas/` with the Zod input schemas.
3. Create `src/features/<name>/server/router.ts` using `protectedProcedure` and an owner filter.
4. Register the router in `src/server/api/root.ts`.
5. Create `src/features/<name>/components/` and export the public component from `src/features/<name>/index.ts`.
6. Render it from a route in `src/app/`.
7. Write tests that call the router through `appRouter.createCaller`, including a cross-tenant read that returns `NOT_FOUND`.
8. Update the code map in `ARCHITECTURE.md` and add a row to `docs/dependencies.md` for any new dependency.
9. Run `make check`.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org): `feat(notes): add pinning`. The `commit-msg` hook rejects other formats and AI `Co-Authored-By` trailers. Fill in the pull request template. `ci-passed` must be green.

## Where docs go

See [docs/README.md](../docs/README.md). A new top-level or `src/` directory needs an ADR in `docs/decisions/` and a `layout.allow` change in `scripts/repo-policy.json`, in the same pull request.

## Maintainer notes

- **Rulesets.** `.github/rulesets/main.json` is an export of a branch ruleset that requires `ci-passed` and CodeQL results. Import it under Settings, Rules, Rulesets, Import a ruleset. Nothing applies it automatically.
- **Renovate.** `.github/renovate.json` groups non-major updates and pins GitHub Actions to digests.
- **Template debt.** Run `make template-debt` to list what a derived repository must change.
- **Licence holder.** TEMPLATE-TODO(license): replace the copyright holder in `LICENSE` in derived repositories.
