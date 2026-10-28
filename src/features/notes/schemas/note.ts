import { z } from "zod";

export const noteIdSchema = z.object({ id: z.number().int().positive() });

export const createNoteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().default(""),
});

export const updateNoteSchema = noteIdSchema.extend({
  title: z.string().min(1).max(200).optional(),
  body: z.string().optional(),
});
