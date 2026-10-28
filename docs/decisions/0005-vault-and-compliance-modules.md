# 5. Vault envelope encryption and compliance modules

Date: 2026-10-28

## Context

Spec 0002 replaces the vault stub (a key derived from the auth secret) with
real envelope encryption, and adds the audit chain, redacting logger, S3
document storage and retention job. These cross every feature, so they need a
shared home that keeps the existing import direction (features import server,
never the reverse).

## Decision

- Each secret is encrypted with AES-256-GCM under a fresh 32-byte data key.
  The data key is wrapped with AES-256-GCM under `VAULT_MASTER_KEY` (32 bytes,
  base64, from `env`). `wrapped_dek` stores `wrap_iv || enc(dek) || tag` and
  `ciphertext` stores `enc(value) || tag`. Node `crypto` only, in
  `src/server/vault/`, which an ast-grep rule keeps as the only AES user.
- Outside production the vault falls back to a fixed dev key (a hash, not a
  literal) so tests need no secret; production refuses to start without one.
- Audit (`src/server/audit.ts`), logger (`src/server/logger.ts`), storage
  (`src/server/storage.ts`) and retention (`src/server/retention.ts`) are
  single files under the existing `src/server/` directory: no new directory,
  so no `layout.allow` change. The audit writer moved out of the identity
  feature so the vault can write release rows without an import cycle.
- Data-subject and step-approval procedures live in the identity feature
  (`privacy` and `approvals` routers), which already owns holders, the mandate
  OTP code and SMS. No new feature directory: a procedures-only feature would
  leave a dead `index.ts` for knip to flag.
- One-time codes for mandate signing and step approval share the
  `mandate:otp_sends` Valkey counter, so the 3-per-hour limit in the data
  contract holds across both flows.

## Consequences

- `src/server/vault/` is the only module that can decrypt; components and
  `"use client"` files cannot import it (ast-grep).
- `audit_logs` hashes use `sha256(prev_hash || canonical_json(row))`,
  replacing the 0001 pipe-joined form; rows written before 0002 exist only in
  development databases.
- The retention table keeps `audit_logs` for 5 years, but the data contract
  also says the database must reject UPDATE and DELETE on that table, which
  makes a scheduled purge impossible without a privileged trigger bypass.
  The trigger wins: the job never purges `audit_logs`, and the 5-year purge
  stays a manual DBA task until the owner approves a privileged path.
- MinIO is pulled from Quay (see `compose.yaml`) because MinIO removed
  its image from Docker Hub; the tags and digests are identical.
