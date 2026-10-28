import { initTRPC, TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { ZodError, z } from "zod";
import { auth } from "~/server/auth/auth";
import { db } from "~/server/db";
import { members } from "~/server/db/schema";
import { env } from "~/shared/config/env";

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const session = await auth.api.getSession({ headers: opts.headers });
  const userId = session?.user.id ?? null;
  const rows = userId
    ? await db
        .select({ orgId: members.organizationId })
        .from(members)
        .where(eq(members.userId, userId))
    : [];
  const orgIds = rows.map((row) => row.orgId);
  return {
    db,
    userId,
    orgIds,
    ownerId: userId,
    ...opts,
  };
};

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const leaksInternals = error.code === "INTERNAL_SERVER_ERROR" && env.NODE_ENV === "production";
    return {
      ...shape,
      message: leaksInternals ? "Internal server error" : shape.message,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const createTRPCRouter = t.router;
/** @public API for procedures that need no identity. */
export const publicProcedure = t.procedure;

/** Rejects callers without a session and narrows `ctx.userId` to a string. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { userId: ctx.userId, ownerId: ctx.userId } });
});
