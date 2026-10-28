import { notesRouter } from "~/features/notes/server/router";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * Each feature router in src/features/<x>/server/router.ts is added here.
 */
export const appRouter = createTRPCRouter({
  notes: notesRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 */
export const createCaller = createCallerFactory(appRouter);
