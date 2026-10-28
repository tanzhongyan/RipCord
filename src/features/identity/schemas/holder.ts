import { z } from "zod";

const E164_RE = /^\+[1-9]\d{7,14}$/;

export const createHolderSchema = z.object({
  alias: z.string().min(1).max(60),
  phone: z.string().regex(E164_RE, "Phone must be E.164, for example +6591234567"),
  orgId: z.string().min(1).optional(),
});

export const holderIdSchema = z.object({ id: z.uuid() });

export type CreateHolderInput = z.infer<typeof createHolderSchema>;
