import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";
import { adminUpdateChannelSchema, getProviderSchema, searchProvidersSchema } from "../index";
import { adminListReview, adminUpdateChannel, liveAdminDeps, requireAdmin } from "./admin";
import { getProvider, liveSearchDeps, searchProviders } from "./search";

/** First entry of X-Forwarded-For, else X-Real-IP, else a shared bucket. */
function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await requireAdmin(liveAdminDeps(), ctx.userId);
  return next({ ctx });
});

export const providersRouter = createTRPCRouter({
  search: publicProcedure.input(searchProvidersSchema).query(async ({ ctx, input }) => {
    return searchProviders(input, { ip: clientIp(ctx.headers) }, liveSearchDeps());
  }),

  get: publicProcedure.input(getProviderSchema).query(async ({ input }) => {
    return getProvider(input, liveSearchDeps());
  }),

  adminListReview: adminProcedure.query(async () => {
    return adminListReview(liveAdminDeps());
  }),

  adminUpdateChannel: adminProcedure
    .input(adminUpdateChannelSchema)
    .mutation(async ({ ctx, input }) => {
      return adminUpdateChannel(input, { userId: ctx.userId }, liveAdminDeps());
    }),
});
