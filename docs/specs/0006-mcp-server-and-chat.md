---

type: spec
status: draft
---

# 0006 MCP Server and In-App Chat

Builds on `docs/specs/0000-data-contract.md` (limits) and spec 0004 (tool registry, agent loop). It copies the shape of afterclass.io's MCP server (`afterclass.io/src/mcp/`, `src/app/api/mcp/[[...path]]/route.ts`).

## Problem

Users should be able to cancel by chatting, either on RipCord's site or from the AI assistant they already use (Claude, ChatGPT, Cursor and others). Both paths must share one set of tools, one permission model and one rate limit, and must never hand personal data to an outside model.

## Solution

### MCP server

- **Route.** `src/app/api/mcp/[[...path]]/route.ts` exports `GET`, `POST`, `DELETE` and `OPTIONS` from `createNextHandler(server)` (`mcp-use/next`), with `runtime = "nodejs"` and `maxDuration = 300`.
- **Stateless.** No session store. `POST` declines `subscriptions/listen`, as afterclass.io does (`declineSubscriptions`), so no stream holds the function open.
- **Auth.** `oauth: oauthBetterAuthProvider({ authURL: ${BETTER_AUTH_URL}/api/auth, resource: ${APP_URL}/api/mcp })` from `mcp-use/oauth/better-auth`. Better Auth runs `@better-auth/oauth-provider` with:
  - the `jwt()` plugin
  - `loginPage: "/sign-in"` and `consentPage: "/oauth/consent"`
  - dynamic client registration enabled explicitly
  - `validAudiences: [${APP_URL}/api/mcp]`

  The route `/.well-known/oauth-authorization-server/api/auth` serves the metadata. Verify every option against the installed versions (`mcp-use@2.12.0`, `@better-auth/oauth-provider@1.7.14`).
- **Development bypass.** Only when `NODE_ENV === "development"` and `MCP_DEV_BYPASS=true`: OAuth is omitted and the user is `MCP_DEV_USER_EMAIL`. Any other `NODE_ENV` fails closed.
- **Tools.** Every tool in the spec 0004 registry is registered, except the executor-only tools. Names, input schemas and descriptions come from the registry; do not redefine them. Each tool gets MCP annotations: `readOnlyHint` for `budget: read`, and `destructiveHint` for tools with `confirm: true`.
- **Confirm gate.** For confirm tools, `confirm` is declared as an optional boolean in the Zod schema, so it is not stripped. The dispatcher rejects calls without `confirm: true` and returns `CONFIRM_REQUIRED` with a one-line summary of what the call would do, so the external model can ask its user.
- **Outputs.** Tool results are JSON, redacted, and contain tokens or hints only. A result never includes a vault value, a signed upload URL older than 10 minutes, or another user's data.
- **Resources.** A `ripcord://providers/{slug}` resource returns a provider's verified channels and policies (public data). There are no prompts.
- **Host checks.** Allowed hosts and origins come from `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`, unset by default.
- **Connected agents page.** `/settings/connected-agents` lists OAuth clients with access tokens for the user (name, created, last used) and a "Revoke" button that deletes their tokens.

### Shared dispatcher

`src/features/cases/server/tools/dispatch.ts`, `dispatchToolCall({ name, input, ctx, transport: "mcp" | "chat" })`, runs these checks in order:

1. Look up the tool. An executor-only or unknown tool returns `UNKNOWN_TOOL`.
2. Rate limit in Valkey: fixed one-minute windows keyed `<transport>-<budget>:<userId>` (read 60, write 10). Chat and MCP use separate buckets, so an outside agent cannot drain the in-app chat.
3. Zod validation.
4. PII input guard (spec 0004).
5. Confirm gate.
6. The handler.
7. Redact the output.
8. An `audit_logs` row for every write tool.

Errors use only the codes in the data contract's "Error codes" section.

### In-app chat

- **Page.** `/chat` has a message list, an input box and a file-attach button (uploads through `attach-document`). Tool calls render as compact status lines. Confirm tools render a card with "Confirm" and "Cancel" buttons, instead of asking the model to type yes.
- **Route.** `POST /api/chat` takes `{ messages: [{ role, content }] (≤ 40), caseId? }`. It runs the spec 0004 agent loop with `transport: "chat"` and streams Server-Sent Events: `token`, `tool_call`, `tool_result`, `confirm_request`, `done`, `error`.
- **No stored history.** The browser keeps the conversation in memory, and `sessionStorage` keeps an unsent draft. The server stores nothing except what tools write (cases, steps, audit). The case page is the durable record.
- The chat shows the remaining credits and the monthly AI allowance in the header.

## Acceptance Scenarios

- **B1 Discovery.** Given an MCP client, when it fetches `/.well-known/oauth-protected-resource` for `/api/mcp`, then the response names the Better Auth issuer.
- **B2 No token.** Given no bearer token in production mode, when `tools/list` is called, then the response is 401 with a `WWW-Authenticate` header.
- **B3 Tool list.** Given a valid token, when `tools/list` runs, then it returns exactly the non-executor registry tools, and `send-notice-email`, `place-call`, `send-digits`, `bridge-holder` and `hang-up` are absent.
- **B4 Confirm.** Given `start-case` is called over MCP without `confirm`, then the result is `CONFIRM_REQUIRED` with a summary, and no credit is consumed.
- **B5 Separate buckets.** Given a user used all 10 MCP write calls this minute, when they call a write tool from `/chat`, then it succeeds.
- **B6 Rate limit.** Given an 11th MCP write call within one minute, then it returns `RATE_LIMITED`.
- **B7 Redacted output.** Given a case with an account number in the vault, when `get-case` runs over MCP, then the JSON contains the token or `display_hint` only.
- **B8 Dev bypass fails closed.** Given `NODE_ENV=test` and `MCP_DEV_BYPASS=true`, when the server is built, then OAuth is still required.
- **B9 Chat confirm card.** Given the agent proposes `request-mandate`, when the stream emits `confirm_request`, then the UI shows a confirm card, and the tool runs only after the user clicks "Confirm".
- **B10 Revoke.** Given a connected client, when the user revokes it, then the client's next call returns 401.

## Budgets

- `tools/list` under 100 ms p95. Read tools under 200 ms p95 end to end (excluding model calls).
- `/api/chat` first SSE event under 300 ms after the request; the stream closes within 300 s.
- The MCP route is cold-start safe: the server and registry are built once per process, and the `buildRouteServer` pattern from afterclass.io is reused.

## Public Entry Points

| Entry point                                        | Contract                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `/api/mcp`                                         | MCP Streamable HTTP, stateless, OAuth 2.1 bearer                       |
| `/.well-known/oauth-authorization-server/api/auth` | Authorization server metadata                                          |
| `/oauth/consent`                                   | Consent page listing the client name and the requested scope `ripcord` |
| `POST /api/chat`                                   | SSE agent stream, Better Auth session required                         |
| `dispatchToolCall`                                 | Tested directly for each error code                                    |

## Decisions & Out of Scope

- One registry and one dispatcher: chat and MCP cannot drift apart.
- Rejected: storing chat transcripts (more personal data to protect for little value).
- Out of scope: MCP `prompts`, MCP sampling, change subscriptions, and per-tool OAuth scopes (one `ripcord` scope for now).
