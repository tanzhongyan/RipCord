import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import { auditLogs, caseDocuments, cases, verifications } from "~/server/db/schema";
import { caseIdSchema, dashboardListSchema } from "../schemas/case";
import { ToolError } from "./errors";
import { getCaseView, listCases } from "./listing";
import { pasteReply } from "./replies";
import { liveToolContext } from "./tools/context";
import { callTool } from "./tools/registry";

const TRPC_CODES = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "BAD_REQUEST",
  CONFIRM_REQUIRED: "BAD_REQUEST",
  PII_NOT_ALLOWED: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  LIMIT_REACHED: "FORBIDDEN",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  MODEL_BUDGET_EXCEEDED: "TOO_MANY_REQUESTS",
  ILLEGAL_TRANSITION: "BAD_REQUEST",
  UNKNOWN_TOOL: "NOT_FOUND",
  VAULT_RELEASE_DENIED: "FORBIDDEN",
  SANDBOX_DESTINATION_BLOCKED: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_SERVER_ERROR",
} as const;

export function toTRPCError(error: unknown): TRPCError {
  if (error instanceof ToolError) {
    return new TRPCError({
      code: TRPC_CODES[error.code],
      message: `[${error.code}] ${error.message.replace(/^\[[A-Z_]+\] /, "")}`,
    });
  }
  if (error instanceof TRPCError) return error;
  throw error;
}

interface OwnedCaseContext {
  db: Database;
  userId: string;
  orgIds: string[];
}

async function requireOwnedCase(ctx: OwnedCaseContext, caseId: string) {
  const ownership = [eq(cases.ownerUserId, ctx.userId)];
  if (ctx.orgIds.length > 0) ownership.push(inArray(cases.orgId, ctx.orgIds));
  const [c] = await ctx.db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), or(...ownership)))
    .limit(1);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
  return c;
}

export const casesRouter = createTRPCRouter({
  /** Case page Approve button. Same handler as the `approve-step` tool. */
  approveStep: protectedProcedure
    .input(z.object({ caseId: z.uuid(), stepId: z.uuid(), code: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await callTool(
          "approve-step",
          { caseId: input.caseId, stepId: input.stepId, code: input.code, confirm: true },
          liveToolContext(ctx.userId, ctx.orgIds),
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** Case page Withdraw button. Same handler as the `withdraw-case` tool. */
  withdraw: protectedProcedure.input(caseIdSchema).mutation(async ({ ctx, input }) => {
    try {
      return await callTool(
        "withdraw-case",
        { caseId: input.caseId, confirm: true },
        liveToolContext(ctx.userId, ctx.orgIds),
      );
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /**
   * Paste the provider's reply (or a chat transcript) for the running
   * `await-provider-reply` step. Redacts, extracts the receipt proposal or
   * the next action, and returns it for the case page.
   */
  pasteReply: protectedProcedure
    .input(z.object({ caseId: z.uuid(), text: z.string().min(1).max(20000) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await pasteReply(input.caseId, input.text, {
          userId: ctx.userId,
          orgIds: ctx.orgIds,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** Dashboard list. Same handler as the `list-cases` tool. */
  list: protectedProcedure.input(dashboardListSchema).query(async ({ ctx, input }) => {
    try {
      return await listCases(
        {
          status: input.status,
          holderId: input.holderId,
          cursor: input.cursor ?? null,
          limit: input.limit,
        },
        { userId: ctx.userId, orgIds: ctx.orgIds },
      );
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Dashboard detail. Same handler as the `get-case` tool. */
  get: protectedProcedure.input(caseIdSchema).query(async ({ ctx, input }) => {
    const c = await requireOwnedCase(ctx, input.caseId);
    try {
      return await getCaseView(c);
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  /** Case page timeline: the case's audit trail, oldest first. */
  timeline: protectedProcedure.input(caseIdSchema).query(async ({ ctx, input }) => {
    await requireOwnedCase(ctx, input.caseId);
    return ctx.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(eq(auditLogs.caseId, input.caseId))
      .orderBy(asc(auditLogs.id));
  }),

  /** Case page documents: stored artifacts, oldest first. */
  documents: protectedProcedure.input(caseIdSchema).query(async ({ ctx, input }) => {
    await requireOwnedCase(ctx, input.caseId);
    return ctx.db
      .select({
        id: caseDocuments.id,
        kind: caseDocuments.kind,
        createdAt: caseDocuments.createdAt,
      })
      .from(caseDocuments)
      .where(eq(caseDocuments.caseId, input.caseId))
      .orderBy(asc(caseDocuments.createdAt));
  }),

  /** Case page verification: due date plus the bill-check outcome, if any. */
  verification: protectedProcedure.input(caseIdSchema).query(async ({ ctx, input }) => {
    await requireOwnedCase(ctx, input.caseId);
    const [row] = await ctx.db
      .select({
        dueAt: verifications.dueAt,
        result: verifications.result,
        resolvedAt: verifications.resolvedAt,
      })
      .from(verifications)
      .where(eq(verifications.caseId, input.caseId))
      .limit(1);
    return row ?? null;
  }),
});
