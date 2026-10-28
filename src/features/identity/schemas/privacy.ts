import { z } from "zod";

/** Omit `holderId` for a self request; pass it for a holder the caller owns. */
export const requestAccessSchema = z.object({ holderId: z.uuid().optional() });

export const requestDeleteSchema = z.object({ holderId: z.uuid().optional() });

export const exportSchema = z.object({ requestId: z.uuid() });

export type RequestAccessInput = z.infer<typeof requestAccessSchema>;
export type RequestDeleteInput = z.infer<typeof requestDeleteSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
