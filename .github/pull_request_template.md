# Pull request

## What and why

<!-- One or two sentences. What changes, and why now? -->

## Linked issue

<!-- Closes #123, or "none" -->

## How it was verified

<!-- Paste the quiet output of `make check`, or `make verify` if you cannot run the database. -->

## Risk and rollback

<!-- What could break? How do you undo this change? -->

## Checklist

- [ ] Tests cover the new behaviour at the entry point (tRPC procedure or route).
- [ ] Docs are updated in this pull request (`ARCHITECTURE.md`, README, ADR).
- [ ] No new dependency without a row in `docs/dependencies.md`.
- [ ] No new directory without an ADR and a `layout.allow` change in `scripts/repo-policy.json`.
