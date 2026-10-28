import { z } from "zod";

export const stepIdSchema = z.object({ stepId: z.uuid() });

/** The SMS code is required only when the owner is not the holder. */
export const approveStepSchema = z.object({
  stepId: z.uuid(),
  code: z
    .string()
    .regex(/^\d{6}$/, "Code must be 6 digits")
    .optional(),
});

export type StepIdInput = z.infer<typeof stepIdSchema>;
export type ApproveStepInput = z.infer<typeof approveStepSchema>;
