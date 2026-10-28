import { z } from "zod";

export const checkoutSchema = z.object({
  quantity: z.union([z.literal(1), z.literal(5), z.literal(10)]),
  orgId: z.string().min(1).optional(),
});

export const ledgerSchema = z.object({
  orgId: z.string().min(1).optional(),
  page: z.number().int().min(1).default(1),
});

export const balanceSchema = z.object({
  orgId: z.string().min(1).optional(),
});

export const portalSchema = z.object({
  orgId: z.string().min(1).optional(),
});

export const subscribeSchema = z.object({
  orgId: z.string().min(1),
});

/** Ledger page size: newest first, 50 per page. */
export const LEDGER_PAGE_SIZE = 50;
