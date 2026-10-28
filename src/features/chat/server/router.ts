import { z } from "zod";

import { creditBalance, dispatchToolCall, liveToolContext, toTRPCError } from "~/features/cases";
import { documentKindSchema } from "~/features/providers";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { currentPeriod, readUsage } from "~/server/model/budget";
import { MAX_UPLOAD_BYTES } from "~/server/storage";
import { env } from "~/shared/config/env";

const attachSchema = z.object({
  caseId: z.uuid(),
  kind: documentKindSchema,
  contentType: z.string().min(1).max(127),
  contentLength: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

const attachResultSchema = z.object({
  documentId: z.uuid(),
  uploadUrl: z.url(),
});

export const chatRouter = createTRPCRouter({
  /**
   * The chat header: remaining personal credits plus this month's AI spend
   * against the individual allowance.
   */
  status: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const [credits, usage] = await Promise.all([
      creditBalance(ctx.db, { userId: ctx.userId, orgId: null, now }),
      readUsage(ctx.db, { ownerKey: `user:${ctx.userId}`, period: currentPeriod(now) }),
    ]);
    return {
      credits,
      aiSpentMicros: usage.costMicros,
      aiBudgetMicros: env.MODEL_BUDGET_USER_MICROS,
    };
  }),

  /**
   * Attach a file from the chat box: runs `attach-document` through the
   * shared dispatcher (`transport: "chat"`), so chat uploads share the
   * tool's permissions and rate limit. The client PUTs the file to the
   * returned URL itself.
   */
  attachDocument: protectedProcedure.input(attachSchema).mutation(async ({ ctx, input }) => {
    try {
      const output = await dispatchToolCall({
        name: "attach-document",
        input,
        ctx: liveToolContext(ctx.userId, ctx.orgIds),
        transport: "chat",
      });
      return attachResultSchema.parse(output);
    } catch (error) {
      throw toTRPCError(error);
    }
  }),
});
