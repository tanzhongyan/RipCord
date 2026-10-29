.PHONY: setup dev test lint fix typecheck verify check build audit policy template-debt fmt \
	anti-slop knip dupes db-generate db-push db-migrate tokens tokens-check contrast brand-check e2e

BIN := node_modules/.bin

setup:
	bun install --frozen-lockfile
	$(BIN)/lefthook install

dev:
	bun run dev

test:
	bun run test

# Formats one file; the agent post-edit hook calls this with FILE set.
fmt:
	$(BIN)/biome check --write --no-errors-on-unmatched --files-ignore-unknown=true $(FILE)

lint:
	$(BIN)/biome check .
	$(BIN)/markdownlint-cli2

fix:
	$(BIN)/biome check --write .

typecheck:
	bun run typecheck

build:
	bun run build

# Entry files come from the package.json "knip" field; SKIP_ENV_VALIDATION keeps config loading free of a database URL.
knip:
	SKIP_ENV_VALIDATION=1 $(BIN)/knip

dupes:
	$(BIN)/fallow dupes --quiet --no-fragments

anti-slop:
	$(BIN)/ast-grep scan
	$(BIN)/ast-grep test --skip-snapshot-tests

policy:
	node scripts/repo-policy.mjs all

audit:
	bun audit --audit-level=moderate

template-debt:
	@git grep -n "TEMPLATE-TODO(" -- . ':(exclude)Makefile' ':(exclude).ast-grep' || true

# Brand and theme gates.
tokens:
	bun scripts/generate-tokens.ts

# Gates only read: fail when the generated CSS is stale instead of rewriting it.
tokens-check:
	bun scripts/generate-tokens.ts --check

contrast:
	bun scripts/check-contrast.ts

brand-check:
	node scripts/brand-check.mjs

# Responsive and axe check on a production server (375, 768, 1280 px). Not part of make check.
# E2E_REUSE_BUILD=1 skips the build when .next exists.
e2e:
	node scripts/playwright-run.mjs

# Fast gate for hooks: no database, no build.
verify: typecheck lint anti-slop policy tokens-check contrast brand-check

# Full gate set used by CI. Tests need DATABASE_URL and a migrated database.
check: typecheck lint test build knip dupes anti-slop policy tokens-check contrast brand-check

db-generate:
	bun run db:generate

db-push:
	bun run db:push

db-migrate:
	bun run db:migrate
