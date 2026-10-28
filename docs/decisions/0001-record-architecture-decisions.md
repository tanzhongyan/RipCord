# 1. Record architecture decisions

Date: 2026-10-27

## Context

Structural choices made without a record get reversed by people who do not know why they were made. This template is copied into new repositories, so those choices spread.

## Decision

Record each irreversible technical choice as a short ADR in `docs/decisions/NNNN-<slug>.md` using the Context, Decision, Consequences format. ADRs are append-only. A change of mind is a new ADR that states `Supersedes: NNNN`.

A new top-level or `src/` directory needs an ADR and a matching change to `layout.allow` in `scripts/repo-policy.json`, in the same pull request.

## Consequences

- A reader finds the reason for a choice next to the code.
- Pull requests that change structure carry one extra short file.
- `make policy` fails when a directory is not allowed, which prompts the ADR.
