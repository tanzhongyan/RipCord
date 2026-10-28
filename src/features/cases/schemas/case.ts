import { z } from "zod";

export const caseIdSchema = z.object({ caseId: z.uuid() });

/** Tool list views page through 25 rows at a time. */
export const LIST_PAGE_SIZE = 25;

export const listCasesSchema = z.object({
  page: z.number().int().min(1).default(1),
});

export type ListCasesInput = z.infer<typeof listCasesSchema>;
