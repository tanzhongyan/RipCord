---

type: spec
status: draft
---

# 0001 Identity, Delegates and Mandates

Builds on `docs/specs/0000-data-contract.md`. Tables, enums and limits named here are defined there.

## Problem

Anyone can sign up, so anyone could try to cancel someone else's service. RipCord must know who each user is, who they act for, and must hold proof that the account holder agreed to each cancellation before the agent does anything.

## Solution

1. **Login.** Users sign in with Better Auth using email one-time codes (no passwords). Users can create an organisation and invite members.
2. **Holders.** A user creates an account holder record with an alias (for example "Dad") and the holder's mobile number. The number goes to the vault (spec 0002), never into `account_holders`.
3. **Mandate request.** When a case reaches `AWAITING_MANDATE`, RipCord texts the holder a link: `/m/<mandate_id>?t=<token>`. The token is 32 random bytes, base64url, stored only as a SHA-256 hash in Valkey with a 7-day TTL.
4. **Holder review page.** The link opens a page that needs no login. It shows the requester's display name, provider name, service type, the masked account number (`display_hint`), the allowed actions, the maximum fee, the expiry date and a sandbox/live badge. It never shows other PII.
5. **Holder confirms.** The holder taps "Send code", receives a 6-digit SMS code and enters it. If the vault has no `FULL_NAME` or `NRIC` for this holder, the page then asks the holder to enter them. These go straight to the vault, so the delegate never sees them. NRIC is checked against `^[STFGM]\d{7}[A-Z]$` and its checksum. The holder types their name as a signature and taps "I authorise". The mandate becomes `ACTIVE`, `signed_at` and `expires_at = signed_at + 30 days` are set, and the letter of authorisation PDF is generated (see below). The holder can also tap "Decline", which sets `REVOKED`.
6. **Live mode.** A mandate starts with `live_mode_approved = false`. The review page has a separate checkbox, "Allow RipCord to contact the provider for real". Without it, the case stays in sandbox (spec 0005).
7. **Revoke.** The SMS link keeps working until expiry and shows a "Revoke" button. Revoking moves the case to `FAILED` with `MANDATE_REVOKED`.
8. **Self-service.** When the requester is the holder (`account_holders.user_id = ctx.userId`), the same mandate flow runs. The review page is shown inside the app, with no SMS link, but the SMS code is still required.

### Letter of authorisation

Generated with `pdf-lib` as an A4 PDF and stored as a `case_documents` row of kind `LOA`. Content, in order:

1. Title "Letter of Authorisation".
2. Date of signing (Asia/Singapore).
3. "To: {provider.name}".
4. "I, {{vault:FULL_NAME}}, holder of identification {{vault:NRIC}}, authorise {delegate display name} to act on my behalf for the following account only: {{vault:ACCOUNT_NO}}, service type {service_type}."
5. Allowed actions as a bullet list, using these labels: `CANCEL_SERVICE` → "Terminate the service", `REQUEST_FINAL_BILL` → "Request the final bill", `ARRANGE_EQUIPMENT_RETURN` → "Arrange return of equipment".
6. "This authorisation does not permit opening, upgrading or changing any other service. It expires on {expires_at date}."
7. Signature block: the typed name in italics, "Signed electronically", the signing timestamp, and "Mandate reference: {mandate_id}".

Tokens are resolved to real values only when the PDF is rendered for sending to a verified provider destination (spec 0002 release rules). The stored PDF keeps tokens; the rendered copy is never stored.

## Acceptance Scenarios

- **B1 Sign-in.** Given a new email, when the user requests a code and enters it within 10 minutes, then a `users` row exists and a session cookie is set.
- **B2 Holder PII stays in the vault.** Given a user creates a holder with alias "Dad" and phone "+6591234567", when the row is saved, then `account_holders` holds no phone digits and `vault_secrets` has one `PHONE` row whose `display_hint` is "4567".
- **B3 Mandate link.** Given a case in `AWAITING_MANDATE`, when the mandate is requested, then exactly one SMS is sent to the holder's number and the link token hash is stored in Valkey with a TTL of 604800 seconds.
- **B4 Code limits.** Given a holder, when they request a 4th code within one hour, then the request returns HTTP 429. When they enter a wrong code 5 times, then the code is invalidated.
- **B5 Activation.** Given a valid code and a typed name, when the holder authorises, then the mandate is `ACTIVE`, `expires_at = signed_at + 30 days`, an `LOA` document exists, the case moves to `CHANNEL_PLANNING`, and one `audit_logs` row records `MANDATE_SIGNED`.
- **B6 Bad token.** Given a wrong or expired token, when the link is opened, then the page shows "This link is invalid or has expired" and reveals nothing about the case.
- **B7 Revoke.** Given an `ACTIVE` mandate, when the holder revokes, then the mandate is `REVOKED`, the case is `FAILED` with `MANDATE_REVOKED`, and any `RUNNING` step is stopped before its next tool call.
- **B8 Ownership.** Given user A owns a holder, when user B calls any holder or mandate procedure with that ID, then the result is `NOT_FOUND`.
- **B9 Org access.** Given a holder created inside an org, when another member of that org lists holders, then the holder is listed. A non-member gets `NOT_FOUND`.
- **B10 Active mandate cap.** Given a holder with 5 `ACTIVE` mandates, when a 6th is requested, then the request fails with `LIMIT_REACHED`.

## Budgets

- Holder review page: server-rendered, under 300 ms p95 at the server, no client JavaScript bundle over 100 kB gzipped.
- SMS send: called once per request; Twilio failures retry at most 2 times with 2 s and 8 s back-off, then show "Could not send code".
- The mandate token is compared in constant time. The page sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- No PII appears in the link URL. The URL holds only `mandate_id` and the token.

## Public Entry Points

| Entry point                                    | Contract                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/auth/*`                                  | Better Auth handler: email OTP sign-in, organisation plugin, OAuth provider for MCP (spec 0006)                                                                                                                                                                                                                                      |
| tRPC `holders.create`                          | Input `{ alias: string(1..60), phone: E.164, orgId?: string }` → `{ id }`                                                                                                                                                                                                                                                            |
| tRPC `holders.list`                            | → holders the caller owns or shares through an org; no PII except `display_hint`                                                                                                                                                                                                                                                     |
| tRPC `holders.delete`                          | Soft delete; vault secrets purged by the retention job                                                                                                                                                                                                                                                                               |
| tRPC `mandates.request`                        | Input `{ caseId, actions: mandate_action[], maxFeeCents: int ≥ 0 }` → `{ mandateId }`. Only for cases in `AWAITING_MANDATE`. Fails with `VALIDATION` ("Upload a bill that shows the account number first") when the holder has no `ACCOUNT_NO` secret from this case's extraction, because `mandates.service_secret_id` is required. |
| tRPC `mandates.get`                            | → mandate status and scope for the case owner                                                                                                                                                                                                                                                                                        |
| Route `GET /m/[mandateId]`                     | Holder review page (token in `t` query parameter)                                                                                                                                                                                                                                                                                    |
| Route `POST /api/mandates/[mandateId]/otp`     | Sends the code. Body `{ token }`.                                                                                                                                                                                                                                                                                                    |
| Route `POST /api/mandates/[mandateId]/sign`    | Body `{ token, code, typedName, allowLive: boolean }`                                                                                                                                                                                                                                                                                |
| Route `POST /api/mandates/[mandateId]/revoke`  | Body `{ token }`                                                                                                                                                                                                                                                                                                                     |
| Route `POST /api/mandates/[mandateId]/decline` | Body `{ token }`                                                                                                                                                                                                                                                                                                                     |

The four `POST /api/mandates/...` routes validate the body with Zod and use the same Valkey rate limits as Limits in spec 0000.

## Implementation Notes

- Feature folder: `src/features/identity/` (holders, mandates). Better Auth instance in `src/server/auth/`, which needs an ADR and a `layout.allow` entry.
- Replace `resolveOwnerId` in `src/server/api/trpc.ts` with the Better Auth session. Remove the `TRUST_IDENTITY_HEADER` stub and its `TEMPLATE-TODO(auth)` markers. `ctx` gains `userId` and `orgIds: string[]`. Keep `ownerId` as an alias of `userId` so the notes feature keeps working, then delete the notes feature in the same PR (it is template sample code).
- Packages (exact pins): `better-auth@1.7.14`, `@better-auth/oauth-provider@1.7.14`, `twilio@6.2.0`, `pdf-lib@1.17.1`, `iovalkey@0.4.0`. Verify each API against the installed version before use.
- New env vars, all validated in `src/shared/config/env.js`: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `VALKEY_URL`, `SMTP_URL`, `MAIL_FROM`.
- Add Valkey (`valkey/valkey:8-alpine`) and Mailpit (`axllent/mailpit`) to `compose.yaml`. Login codes go to Mailpit in development.
- When `TWILIO_*` is unset, SMS goes to a development sink that logs `"SMS to ****4567: <code>"` to the server console. This applies only when `NODE_ENV !== "production"`; production refuses to start without Twilio.

## Decisions & Out of Scope

- Email one-time codes chosen over passwords: no password storage, and fewer reset flows. Rejected: Supabase Auth (afterclass.io), because it adds a hosted dependency and its MCP OAuth glue is app-owned.
- Holder identity is proven by possession of their phone. Rejected: Singpass MyInfo. It is the strongest option, but needs a government partnership that a hackathon cannot get.
- Out of scope: holders signing with a drawn signature, notarised letters, a holder app.
