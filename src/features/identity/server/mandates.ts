import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { mandateIdSchema, requestMandateSchema } from "../schemas/mandate";
import { getMandate, requestMandate, toTRPCError } from "./mandate-flow";

export const mandatesRouter = createTRPCRouter({
  request: protectedProcedure.input(requestMandateSchema).mutation(async ({ ctx, input }) => {
    try {
      return await requestMandate(input, { userId: ctx.userId, orgIds: ctx.orgIds });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  get: protectedProcedure.input(mandateIdSchema).query(async ({ ctx, input }) => {
    try {
      return await getMandate(input, { userId: ctx.userId, orgIds: ctx.orgIds });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),
});
