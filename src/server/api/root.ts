import { casesRouter } from "~/features/cases/server/router";
import { approvalsRouter } from "~/features/identity/server/approvals";
import { holdersRouter } from "~/features/identity/server/holders";
import { mandatesRouter } from "~/features/identity/server/mandates";
import { privacyRouter } from "~/features/identity/server/privacy";
import { providersRouter } from "~/features/providers/server/router";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * Each feature router in src/features/<x>/server/router.ts is added here.
 */
export const appRouter = createTRPCRouter({
  cases: casesRouter,
  holders: holdersRouter,
  mandates: mandatesRouter,
  privacy: privacyRouter,
  approvals: approvalsRouter,
  providers: providersRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 */
export const createCaller = createCallerFactory(appRouter);
