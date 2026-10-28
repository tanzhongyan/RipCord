import { z } from "zod";

export const caseIdSchema = z.object({ caseId: z.uuid() });

/** Tool list views page through 25 rows at a time. */
export const LIST_PAGE_SIZE = 25;

export const listCasesSchema = z.object({
  page: z.number().int().min(1).default(1),
  status: z.string().min(1).max(40).optional(),
  holderId: z.uuid().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type ListCasesInput = z.infer<typeof listCasesSchema>;

export const dashboardListSchema = z.object({
  status: z.string().min(1).max(40).optional(),
  holderId: z.uuid().optional(),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
