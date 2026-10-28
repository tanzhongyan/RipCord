---

type: spec
status: draft
---

# 0002 PII Vault and Compliance

Builds on `docs/specs/0000-data-contract.md` (tables `vault_secrets`, `vault_releases`, `audit_logs`, `data_subject_requests`; rules "Vault release rules", "Retention", "Never stored").

## Problem

Cancelling a telco line needs the holder's NRIC, full name, address and account number. Those values must not leak to the model, to logs, to delegates, or to anyone who gets a database dump, and RipCord must meet the PDPA: purpose limits, access and deletion rights, and keeping data only as long as needed.

## Solution

1. **Encryption.** Each secret is encrypted with AES-256-GCM using a fresh 32-byte data key. The data key is wrapped with AES-256-GCM using the master key `VAULT_MASTER_KEY` (32 bytes, base64, from `env`). `key_version` records which master key wrapped it. Use Node `crypto` only; no new dependency.
2. **Tokens.** Any code that needs a secret gets a token `{{vault:<KIND>:<id>}}`. Only `src/server/vault/` can decrypt.
3. **Redaction.** One function, `redact(text, holderId)`, runs on every string before it reaches the model, a log line, `communications.body`, `case_steps.args/result` or a document's `extracted` field:
   - It replaces each known secret value of that holder with its token (case-insensitive, ignoring spaces and dashes for `NRIC`, `PHONE` and `ACCOUNT_NO`).
   - It then replaces pattern matches that are not known secrets: NRIC/FIN `[STFGM]\d{7}[A-Z]` → `[NRIC]`, Singapore phone `(\+65\s?)?[689]\d{3}\s?\d{4}` → `[PHONE]`, email → `[EMAIL]`, card-like 13–19 digit runs that pass the Luhn check → `[CARD]`.
4. **Release.** `resolveTokens(text, ctx)` swaps tokens for real values only when all five conditions in the data contract's "Vault release rules" hold. It writes one `vault_releases` row and one `audit_logs` row per secret released. The result is passed straight to the channel sender and never stored or logged.
5. **Holder approval for sensitive kinds.** For `NRIC`, `PIN` and `ACCOUNT_NO`, the executor first creates a step in `AWAITING_APPROVAL`. The approval is a tap on the case page by the case owner, plus an SMS code to the holder when the owner is not the holder. Approval covers one step only.
6. **Audit chain.** Every write to `audit_logs` computes `hash = sha256(prev_hash || canonical_json(row))`. A migration adds a trigger that raises on UPDATE or DELETE. A daily job re-verifies the last 10,000 rows and alerts (logs at error level) on any break.
7. **Data subject requests.** A user or holder can request ACCESS (an export of everything stored about them, with secrets shown masked, for example `S****567A`) or DELETE (soft delete now; hard purge by the retention job within 30 days). Requests appear in the admin dashboard (spec 0007).
8. **Retention job.** A daily cron route deletes rows and object-store files exactly as the data contract's Retention table says. Each purge writes an `audit_logs` row with counts only.
9. **Logging.** The server logger wraps `console` and runs `redact` with no holder (patterns only) on every message. Request logs never include bodies or query strings.

## Acceptance Scenarios

- **B1 Round trip.** Given a stored `NRIC` secret, when it is read back through the vault with a valid release context, then the plaintext matches, and the database row holds no plaintext bytes.
- **B2 Tampering.** Given a row whose `ciphertext` has one byte flipped, when it is decrypted, then decryption throws and no value is returned.
- **B3 Redact known values.** Given holder H with NRIC "S1234567D", when `redact("my ic is s 1234567 d", H)` runs, then the output contains `{{vault:NRIC:<id>}}` and not "1234567".
- **B4 Redact unknown values.** Given text with an unknown NRIC "T0123456G", when it is redacted, then the output contains `[NRIC]`.
- **B5 Release denied.** Given a step whose channel has `is_verified_destination = false`, when tokens are resolved, then the call throws `VAULT_RELEASE_DENIED`, no `vault_releases` row is written, and the step becomes `FAILED`.
- **B6 Release approved.** Given every release condition holds, when tokens are resolved, then exactly one `vault_releases` row per secret is written, with `holder_approved_at` set for the NRIC.
- **B7 Audit immutability.** Given any `audit_logs` row, when an UPDATE or DELETE is run against it, then Postgres raises an error.
- **B8 Chain check.** Given 100 audit rows, when row 50's metadata is changed with the trigger disabled, then the verifier reports the break at row 50.
- **B9 Delete request.** Given a holder with secrets and a closed case, when a DELETE request completes, then their `vault_secrets` ciphertext is overwritten, `deleted_at` is set, and documents of kind `BILL`, `CONTRACT` and `SCREENSHOT` are gone from the object store.
- **B10 Log hygiene.** Given a request whose body contains an NRIC, when the request fails with an error, then no log line contains the NRIC digits.

## Budgets

- Encrypt or decrypt one secret: under 1 ms p95. `redact` on 10 kB of text with 20 known secrets: under 5 ms p95.
- Master key rotation: re-wrap 10,000 data keys in under 60 s with no downtime; old `key_version` values still decrypt until re-wrapped.
- Uploaded files go to S3-compatible storage (MinIO in compose, any S3 in production) with server-side encryption. The maximum upload size is 10 MB, accepting only `application/pdf`, `image/png` and `image/jpeg`.

## Public Entry Points

| Entry point                                            | Contract                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/vault/index.ts`                            | `storeSecret`, `listSecretKinds`, `redact`, `resolveTokens`, `deleteHolderSecrets`. This is the only module that imports `node:crypto` for vault work. An ast-grep rule enforces it. |
| tRPC `privacy.requestAccess` / `privacy.requestDelete` | Create a `data_subject_requests` row for the caller or a holder they own                                                                                                             |
| tRPC `privacy.export`                                  | Returns the JSON export for a completed ACCESS request                                                                                                                               |
| Route `POST /api/cron/retention`                       | Runs the retention job. Requires `Authorization: Bearer ${CRON_SECRET}`.                                                                                                             |
| Route `POST /api/cron/audit-verify`                    | Runs the chain check. Same auth.                                                                                                                                                     |

## Implementation Notes

- Folder `src/server/vault/` (needs an ADR and a `layout.allow` entry). Add an ast-grep rule that forbids importing it from `"use client"` files and from `src/features/*/components`.
- New env vars: `VAULT_MASTER_KEY`, `VAULT_KEY_VERSION` (default 1), `CRON_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.
- Add MinIO (`minio/minio`) to `compose.yaml`. Package: `@aws-sdk/client-s3@3.1158.0`.
- Write tests at the vault module boundary and the cron routes. The redaction patterns get table-driven tests that include near-misses (for example a 7-digit postcode-like run with no letter).

## Decisions & Out of Scope

- App-level envelope encryption chosen over Postgres `pgcrypto`, so keys never reach the database server. Rejected: a cloud KMS, because it is not open source or self-hostable. A KMS can replace the master-key unwrap later behind the same function.
- Out of scope: hardware security modules, per-tenant master keys, and automatic redaction of images (images are only read by the model on the standard tier; see spec 0004).
