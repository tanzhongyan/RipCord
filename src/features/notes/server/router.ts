import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { notes } from "~/server/db/schema";
import { createNoteSchema, noteIdSchema, updateNoteSchema } from "../schemas/note";

const noteNotFound = () => new TRPCError({ code: "NOT_FOUND", message: "Note not found" });

export const notesRouter = createTRPCRouter({
  create: protectedProcedure.input(createNoteSchema).mutation(async ({ ctx, input }) => {
    const [note] = await ctx.db
      .insert(notes)
      .values({ ownerId: ctx.ownerId, title: input.title, body: input.body })
      .returning();
    if (!note) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create note" });
    }
    return note;
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.notes.findMany({
      where: eq(notes.ownerId, ctx.ownerId),
      orderBy: [desc(notes.createdAt)],
    });
  }),

  get: protectedProcedure.input(noteIdSchema).query(async ({ ctx, input }) => {
    const note = await ctx.db.query.notes.findFirst({
      where: and(eq(notes.id, input.id), eq(notes.ownerId, ctx.ownerId)),
    });
    if (!note) throw noteNotFound();
    return note;
  }),

  update: protectedProcedure.input(updateNoteSchema).mutation(async ({ ctx, input }) => {
    const values: { title?: string; body?: string } = {};
    if (input.title !== undefined) values.title = input.title;
    if (input.body !== undefined) values.body = input.body;

    const [updated] = await ctx.db
      .update(notes)
      .set(values)
      .where(and(eq(notes.id, input.id), eq(notes.ownerId, ctx.ownerId)))
      .returning();
    if (!updated) throw noteNotFound();
    return updated;
  }),

  delete: protectedProcedure.input(noteIdSchema).mutation(async ({ ctx, input }) => {
    const [deleted] = await ctx.db
      .delete(notes)
      .where(and(eq(notes.id, input.id), eq(notes.ownerId, ctx.ownerId)))
      .returning();
    if (!deleted) throw noteNotFound();
    return { success: true };
  }),
});
