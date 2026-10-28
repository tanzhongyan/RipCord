import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { accountHolders, vaultSecrets } from "~/server/db/schema";
import { storeSecret } from "~/server/vault/vault";
import { createHolderSchema, holderIdSchema } from "../schemas/holder";
import { callerOwns } from "./mandate-flow";

const holderNotFound = () => new TRPCError({ code: "NOT_FOUND", message: "Holder not found" });

export const holdersRouter = createTRPCRouter({
  create: protectedProcedure.input(createHolderSchema).mutation(async ({ ctx, input }) => {
    if (input.orgId && !ctx.orgIds.includes(input.orgId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Organisation not found" });
    }
    const holderId = randomUUID();
    // One transaction: the holder and its secret reference each other, and the
    // deferred foreign keys are checked at commit.
    const created = await ctx.db.transaction(async (tx) => {
      const secret = await storeSecret(tx, { holderId, kind: "PHONE", value: input.phone });
      const [holder] = await tx
        .insert(accountHolders)
        .values({
          id: holderId,
          ownerUserId: ctx.userId,
          orgId: input.orgId ?? null,
          alias: input.alias,
          phoneSecretId: secret.id,
        })
        .returning({ id: accountHolders.id });
      return holder;
    });
    if (!created) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create holder" });
    }
    return { id: created.id };
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const ownership = [eq(accountHolders.ownerUserId, ctx.userId)];
    if (ctx.orgIds.length > 0) ownership.push(inArray(accountHolders.orgId, ctx.orgIds));
    return ctx.db
      .select({
        id: accountHolders.id,
        alias: accountHolders.alias,
        orgId: accountHolders.orgId,
        displayHint: vaultSecrets.displayHint,
        createdAt: accountHolders.createdAt,
      })
      .from(accountHolders)
      .innerJoin(vaultSecrets, eq(vaultSecrets.id, accountHolders.phoneSecretId))
      .where(and(isNull(accountHolders.deletedAt), or(...ownership)))
      .orderBy(desc(accountHolders.createdAt));
  }),

  delete: protectedProcedure.input(holderIdSchema).mutation(async ({ ctx, input }) => {
    const [holder] = await ctx.db
      .select()
      .from(accountHolders)
      .where(and(eq(accountHolders.id, input.id), isNull(accountHolders.deletedAt)))
      .limit(1);
    if (!holder || !callerOwns(holder, { userId: ctx.userId, orgIds: ctx.orgIds })) {
      throw holderNotFound();
    }
    await ctx.db
      .update(accountHolders)
      .set({ deletedAt: new Date() })
      .where(eq(accountHolders.id, input.id));
    return { success: true };
  }),
});
