# 4. Better Auth identity with email OTP, organisations and admin

Date: 2026-10-28

## Context

Spec 0001 replaces the `x-user-id` header stub with real authentication: email
one-time codes, user-owned organisations with invitations, an admin role, and an
OAuth provider for MCP (spec 0006). The data contract (0000) defers identity
tables to the Better Auth generated schema. Two new server directories are
needed: `src/server/auth/` for the Better Auth instance and `src/server/vault/`
for the vault stub that 0002 will complete.

## Decision

- Use `better-auth` with the `emailOTP`, `organization`, `admin`, `jwt` and
  `@better-auth/oauth-provider` plugins. Login is email codes only; there is no
  password flow. Invitation emails reuse the 0001 SMTP sender. The `jwt` plugin
  exists only because the OAuth provider requires it.
- Identity tables use the plugin-generated Drizzle schema (produced by the
  adapter's own generator for these exact options) with table names
  `users`, `sessions`, `accounts`, `organizations`, `members`, `invitations`
  and the `oauth_*` tables.
- The Better Auth verification table stays singular (`verification`). The data
  contract lists identity `verifications` but also requires a domain
  `verifications` table for rebill checks; both cannot exist. The domain table
  keeps the plural name. Reported as a contract conflict in the 0001 PR.
- New directories `src/server/auth/` and `src/server/vault`, plus route folders
  `src/app/m/` and `src/app/m/[mandateId]`, are added to `layout.allow`.
- `bun run db:push` cannot run the `pg_trgm` extension or the `audit_logs`
  append-only trigger, so CI and `scripts/dev-setup.ts` use `db:migrate`.
  `db:push` stays for local-only work, as before.
- `account_holders.phone_secret_id` and `vault_secrets.holder_id` are
  `DEFERRABLE INITIALLY DEFERRED`: the two rows reference each other, so
  holder creation inserts both in one transaction and the checks run at commit.
- Backend dependencies required by spec 0001 (`better-auth`,
  `@better-auth/oauth-provider`, `twilio`, `pdf-lib`, `iovalkey`) are recorded
  in `docs/dependencies.md`. ADR 0003 only lists frontend triggers, so there is
  no trigger row to cite for backend libraries; the spec reference stands in.

## Consequences

- `resolveOwnerId` and `TRUST_IDENTITY_HEADER` are gone. `ctx` carries `userId`
  and `orgIds`; `ownerId` stays as a temporary alias.
- Every query filters on `userId` or an `orgIds` membership; a miss returns
  `NOT_FOUND`.
- Production refuses to start without `TWILIO_*`. Without Twilio in
  non-production, SMS goes to a console sink. Login codes go to Mailpit in
  development.
- The vault stub derives its key from the auth secret and fakes envelope
  fields; spec 0002 replaces it with `VAULT_MASTER_KEY` envelope encryption.
- Knip ignores `src/server/db/schema.ts` (the data contract owns it, and later
  specs consume the tables 0001 does not touch) and `src/trpc/server.ts` plus
  the `server-only` dependency (no server component calls tRPC yet). The tRPC
  React `api` export is unexported until a client component needs it.
