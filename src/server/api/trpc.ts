import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError, z } from "zod";
import { db } from "~/server/db";
import { env } from "~/shared/config/env";

/**
 * Resolve the caller identity. Returns null unless `TRUST_IDENTITY_HEADER` is true and the
 * `x-user-id` header holds a non-blank value.
 *
 * TEMPLATE-TODO(auth): replace header identity with real authentication
 */
const resolveOwnerId = (headers: Headers): string | null => {
  if (!env.TRUST_IDENTITY_HEADER) return null;
  const value = headers.get("x-user-id")?.trim();
  return value ? value : null;
};

export const createTRPCContext = async (opts: { headers: Headers }) => {
  return {
    db,
    ownerId: resolveOwnerId(opts.headers),
    ...opts,
  };
};

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
/** @public Template API: use for procedures that need no identity. */
export const publicProcedure = t.procedure;

/** Rejects callers without an identity and narrows `ctx.ownerId` to a string. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.ownerId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ownerId: ctx.ownerId } });
});
