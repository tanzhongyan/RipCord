import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { serverSecret } from "~/server/auth/auth";
import { type Database, db } from "~/server/db";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "~/server/db/schema";
import type { CallerIdentity } from "./mandate-flow";

interface ConnectedAgentRow {
  clientId: string;
  name: string | null;
  scopes: string[];
  createdAt: Date | null;
  lastUsedAt: Date | null;
}

/** OAuth clients the caller authorized: name, grant time and last consent. */
async function listConnectedAgents(
  caller: CallerIdentity,
  conn: Database = db,
): Promise<ConnectedAgentRow[]> {
  const rows = await conn
    .select({
      clientId: oauthConsent.clientId,
      name: oauthClient.name,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
      lastUsedAt: oauthConsent.updatedAt,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, caller.userId))
    .orderBy(desc(oauthConsent.updatedAt));
  return rows.map((row) => ({ ...row, scopes: row.scopes ?? [] }));
}

/**
 * Revoke one client for the caller: the consent and every access and refresh
 * token row go. The MCP grant check then fails, so the client's next call
 * returns 401. Unknown or foreign clients answer `NOT_FOUND`.
 */
async function revokeConnectedAgent(
  caller: CallerIdentity,
  clientId: string,
  conn: Database = db,
): Promise<void> {
  const [consent] = await conn
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, caller.userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);
  if (!consent) {
    throw new TRPCError({ code: "NOT_FOUND", message: "[NOT_FOUND] Connected agent not found" });
  }
  await conn
    .delete(oauthAccessToken)
    .where(
      and(eq(oauthAccessToken.userId, caller.userId), eq(oauthAccessToken.clientId, clientId)),
    );
  await conn
    .delete(oauthRefreshToken)
    .where(
      and(eq(oauthRefreshToken.userId, caller.userId), eq(oauthRefreshToken.clientId, clientId)),
    );
  await conn.delete(oauthConsent).where(eq(oauthConsent.id, consent.id));
}

const clientIdSchema = z.object({ clientId: z.string().min(1).max(256) });

/**
 * The client behind a consent-page query, after verifying the query
 * signature. A valid signature does not replace the session check: this
 * procedure is protected, and the consent endpoint re-validates on accept.
 */
export async function readConsentClient(
  input: { clientId: string; oauthQuery: string },
  conn: Database = db,
): Promise<{ clientId: string; name: string | null }> {
  const valid = await verifyOAuthQueryParams(input.oauthQuery, serverSecret());
  if (!valid) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "[VALIDATION] Consent request expired" });
  }
  const [client] = await conn
    .select({ clientId: oauthClient.clientId, name: oauthClient.name })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, input.clientId))
    .limit(1);
  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "[NOT_FOUND] OAuth client not found" });
  }
  return client;
}

export const agentsRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    return listConnectedAgents({ userId: ctx.userId, orgIds: ctx.orgIds }, ctx.db);
  }),

  revoke: protectedProcedure.input(clientIdSchema).mutation(async ({ ctx, input }) => {
    await revokeConnectedAgent({ userId: ctx.userId, orgIds: ctx.orgIds }, input.clientId, ctx.db);
    return { revoked: true };
  }),

  consentClient: protectedProcedure
    .input(clientIdSchema.extend({ oauthQuery: z.string().min(1).max(8000) }))
    .query(async ({ ctx, input }) => {
      return readConsentClient(input, ctx.db);
    }),
});
