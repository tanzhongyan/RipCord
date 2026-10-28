import type { AuthInfo, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { type CallToolResult, MCPServer } from "mcp-use";
import { type BetterAuthOAuthUser, oauthBetterAuthProvider } from "mcp-use/oauth/better-auth";

import {
  dispatchToolCall,
  listMcpTools,
  liveToolContext,
  type ToolContext,
  ToolError,
} from "~/features/cases";
import { getProviderBySlug, liveSearchDeps } from "~/features/providers";
import { db } from "~/server/db";
import { members, oauthClient, oauthConsent, oauthRefreshToken, users } from "~/server/db/schema";
import { logger } from "~/server/logger";
import { env } from "~/shared/config/env";
import packageJson from "../../../../package.json";

/** The MCP endpoint path. `MCPServer` requires the OAuth resource to use it exactly. */
const MCP_BASE_PATH = "/api/mcp";

/** Scopes the MCP server accepts and advertises. Keep in step with `auth.ts`. */
const MCP_SCOPES = ["ripcord", "openid", "profile", "email", "offline_access"];

/** The RFC 8707 resource identifier: where tokens for this server are addressed. */
function mcpResourceUrl(): string {
  return `${env.APP_URL}${MCP_BASE_PATH}`;
}

/** The Better Auth issuer URL, including its base path. */
function mcpIssuerUrl(): string {
  return `${env.BETTER_AUTH_URL}/api/auth`;
}

/**
 * Pure dev-bypass gate. OAuth is omitted only when `NODE_ENV` is
 * `development` AND `MCP_DEV_BYPASS` is true; every other combination,
 * including `test`, fails closed.
 */
export function isDevBypass(nodeEnv: string, mcpDevBypass: boolean): boolean {
  return nodeEnv === "development" && mcpDevBypass;
}

type McpAuthMode = "oauth" | "bypass";

/** The live gate reading, from validated env. */
export function mcpAuthMode(): McpAuthMode {
  return isDevBypass(env.NODE_ENV, env.MCP_DEV_BYPASS) ? "bypass" : "oauth";
}

interface McpAuthStubResult {
  userId: string;
  clientId: string;
  scopes: string[];
}

/**
 * Test seam: maps a Bearer [REDACTED] to an identity without JWT crypto. The
 * grant check below still runs, so revoke tests exercise the real path.
 */
type McpAuthStub = (token: string) => McpAuthStubResult | null;

let authStub: McpAuthStub | null = null;

/** Install a stub verifier (`null` restores JWT verification). Tests only. */
export function setMcpAuthStub(stub: McpAuthStub | null): void {
  authStub = stub;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Server-side grant check. Better Auth access tokens for this resource are
 * self-contained JWTs that outlive a revoke, so a valid signature is not
 * enough: the (user, client) pair must still hold a consent or a live
 * refresh token, and the client must exist and be enabled. Revoking deletes
 * those rows, so the next call fails with `invalid_token` (HTTP 401).
 */
async function assertMcpGrant(userId: string, clientId: string): Promise<void> {
  const revoked = () => {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Client access was revoked");
  };
  const [client] = await db
    .select({ disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!client || client.disabled) revoked();
  const [consent] = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);
  if (consent) return;
  const [refresh] = await db
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(
      and(
        eq(oauthRefreshToken.userId, userId),
        eq(oauthRefreshToken.clientId, clientId),
        isNull(oauthRefreshToken.revoked),
        or(isNull(oauthRefreshToken.expiresAt), gt(oauthRefreshToken.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (!refresh) revoked();
}

function decodeJwtSubject(token: string): string {
  const segment = token.split(".")[1];
  if (!segment) throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing Better Auth subject");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing Better Auth subject");
  }
  const sub = (payload as { sub?: unknown }).sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "Missing Better Auth subject");
  }
  return sub;
}

/**
 * The Better Auth JWT verifier plus the grant check. The inner verifier
 * owns signature, issuer, audience and expiry; this layer owns revocation.
 */
function wrapVerifier(inner: OAuthTokenVerifier, resource: URL): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const stub = authStub;
      if (stub) {
        const mapped = stub(token);
        if (!mapped) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
        }
        await assertMcpGrant(mapped.userId, mapped.clientId);
        return {
          token,
          clientId: mapped.clientId,
          scopes: mapped.scopes,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          resource,
          // The provider's identity mapper reads the subject from here,
          // exactly as the JWT verifier's `extra.payload` provides it.
          extra: {
            payload: {
              sub: mapped.userId,
              client_id: mapped.clientId,
              azp: mapped.clientId,
              scope: mapped.scopes.join(" "),
            },
          },
        };
      }
      const authInfo = await inner.verifyAccessToken(token);
      await assertMcpGrant(decodeJwtSubject(token), authInfo.clientId);
      return authInfo;
    },
  };
}

function hostGuards(): { allowedHosts?: string[]; allowedOrigins?: string[] } {
  const guards: { allowedHosts?: string[]; allowedOrigins?: string[] } = {};
  const hosts = splitList(env.MCP_ALLOWED_HOSTS);
  const origins = splitList(env.MCP_ALLOWED_ORIGINS);
  if (hosts.length > 0) guards.allowedHosts = hosts;
  if (origins.length > 0) guards.allowedOrigins = origins;
  return guards;
}

function stripCodePrefix(message: string): string {
  return message.replace(/^\[[A-Z_]+\] /, "");
}

function mcpOk(output: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }] };
}

function mcpError(code: string, message: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ code, message, ...extra }) }],
    isError: true,
  };
}

/** The caller's tool context: the OAuth subject, or the dev-bypass user. */
async function toolContextFor(authUserId: string | undefined): Promise<ToolContext> {
  if (authUserId) {
    const rows = await db
      .select({ orgId: members.organizationId })
      .from(members)
      .where(eq(members.userId, authUserId));
    return liveToolContext(
      authUserId,
      rows.map((row) => row.orgId),
    );
  }
  const email = env.MCP_DEV_USER_EMAIL;
  if (!email) {
    throw new ToolError("INTERNAL_ERROR", "MCP dev bypass needs MCP_DEV_USER_EMAIL");
  }
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    throw new ToolError("INTERNAL_ERROR", "MCP dev bypass user not found");
  }
  const rows = await db
    .select({ orgId: members.organizationId })
    .from(members)
    .where(eq(members.userId, user.id));
  return liveToolContext(
    user.id,
    rows.map((row) => row.orgId),
  );
}

interface McpAuthContext {
  auth?: { user?: { id?: string } };
}

async function runMcpTool(
  name: string,
  params: unknown,
  ctx: McpAuthContext,
): Promise<CallToolResult> {
  let toolCtx: ToolContext;
  try {
    toolCtx = await toolContextFor(ctx.auth?.user?.id);
  } catch (error) {
    if (error instanceof ToolError) return mcpError(error.code, stripCodePrefix(error.message));
    throw error;
  }
  try {
    const output = await dispatchToolCall({ name, input: params, ctx: toolCtx, transport: "mcp" });
    return mcpOk(output);
  } catch (error) {
    if (error instanceof ToolError) {
      const details = error.details as { summary?: unknown } | undefined;
      const summary =
        typeof details?.summary === "string" ? { summary: details.summary } : undefined;
      return mcpError(error.code, stripCodePrefix(error.message), summary);
    }
    logger.error(`MCP tool ${name} failed unexpectedly`);
    return mcpError("INTERNAL_ERROR", "Internal server error");
  }
}

/**
 * Register exactly the non-executor registry tools. Names, schemas and
 * descriptions come from the registry verbatim; this layer adds only the
 * MCP annotations (`readOnlyHint` for reads, `destructiveHint` for
 * confirm tools) and the `ripcord://providers/{slug}` resource.
 */
function registerMcpTools(server: MCPServer<BetterAuthOAuthUser>): void {
  for (const def of listMcpTools()) {
    server.tool(
      {
        name: def.name,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          ...(def.budget === "read" ? { readOnlyHint: true } : {}),
          ...(def.confirm ? { destructiveHint: true } : {}),
        },
      },
      async (params, ctx) => runMcpTool(def.name, params, ctx),
    );
  }
  server.resourceTemplate(
    {
      name: "provider",
      uriTemplate: "ripcord://providers/{slug}",
      description: "A provider's verified cancellation channels and policies (public data).",
      mimeType: "application/json",
    },
    async (uri, params, _ctx) => {
      const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
      if (typeof slug !== "string" || slug.length === 0) {
        throw new ResourceNotFoundError(uri.href);
      }
      try {
        const detail = await getProviderBySlug({ slug }, liveSearchDeps());
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                slug: detail.slug,
                name: detail.name,
                country: detail.country,
                category: detail.category,
                website: detail.website,
                channels: detail.channels.filter((channel) => channel.verified),
                policies: detail.policies,
              }),
            },
          ],
        };
      } catch (error) {
        if (error instanceof TRPCError && error.code === "NOT_FOUND") {
          throw new ResourceNotFoundError(uri.href);
        }
        throw error;
      }
    },
  );
}

/**
 * Build the MCP server: stateless (a fresh SDK server per request),
 * OAuth-gated, cold-start safe (pure construction; pools stay at module
 * scope in the imported modules). In dev-bypass mode OAuth is omitted and
 * every call runs as `MCP_DEV_USER_EMAIL`.
 */
function buildMcpServer(): MCPServer<BetterAuthOAuthUser> {
  if (mcpAuthMode() === "bypass") {
    const server = new MCPServer({
      name: "ripcord",
      version: packageJson.version,
      basePath: MCP_BASE_PATH,
      ...hostGuards(),
    });
    // No OAuth provider, so no gate: callbacks resolve the dev user.
    // The cast keeps one registration path for both modes.
    const typed = server as unknown as MCPServer<BetterAuthOAuthUser>;
    registerMcpTools(typed);
    return typed;
  }
  const resource = mcpResourceUrl();
  const base = oauthBetterAuthProvider({
    authURL: mcpIssuerUrl(),
    resource,
    scopesSupported: MCP_SCOPES,
  });
  const server = new MCPServer({
    name: "ripcord",
    version: packageJson.version,
    basePath: MCP_BASE_PATH,
    oauth: {
      ...base,
      createTokenVerifier: (verified: URL) =>
        wrapVerifier(base.createTokenVerifier(verified), verified),
    },
    ...hostGuards(),
  });
  registerMcpTools(server);
  return server;
}

let cached: MCPServer<BetterAuthOAuthUser> | null = null;

/** The process-wide MCP server, built once (spec 0006 budgets). */
export function mcpServer(): MCPServer<BetterAuthOAuthUser> {
  cached ??= buildMcpServer();
  return cached;
}

/** RFC 9728 protected-resource metadata for `/.well-known/oauth-protected-resource/api/mcp`. */
export function mcpProtectedResourceMetadata(): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
} {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [mcpIssuerUrl()],
    scopes_supported: [...MCP_SCOPES],
  };
}
