# 9. MCP server and chat placement

Date: 2026-10-28

## Context

Spec 0006 adds an MCP Streamable-HTTP server, OAuth metadata routes, an
in-app chat page, a consent page and a connected-agents page. The MCP
route uses `createNextHandler` from `mcp-use`, which reads
`.mcp-use/build/manifest.json` on first request. RipCord ships no MCP
views, so the manifest is the static `{"views":{}}`; committing it keeps
every environment (dev, test, build, production) working without a
code-generation step. The new App Router pages need `layout.allow`
entries.

## Decision

- The MCP server module lives in the new `src/features/chat/` feature
  (covered by the existing `src/features/*` wildcards), beside the agent
  loop and chat UI. The route `src/app/api/mcp/[[...path]]/route.ts`
  stays thin.
- `.mcp-use/build/manifest.json` is committed with `{"views":{}}` and
  `.mcp-use` joins `layout.allow`. If views are ever added, the manifest
  is regenerated with `mcp-use build` instead.
- New page directories join `layout.allow`: `src/app/chat`,
  `src/app/sign-in`, `src/app/oauth/consent`,
  `src/app/settings/connected-agents`, and the two `.well-known` routes.
- New runtime dependencies `mcp-use` and `@modelcontextprotocol/server`
  gain ledger rows in `docs/dependencies.md`. No ADR 0003 trigger
  applies: that table covers frontend capabilities, and both libraries
  are server-only.

## Consequences

- `make policy` passes with the new directories allow-listed.
- Tests import the MCP route directly; the committed manifest makes the
  handler work with no build step.
