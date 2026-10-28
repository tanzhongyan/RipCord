import { z } from "zod";

const mandateActionSchema = z.enum([
  "CANCEL_SERVICE",
  "REQUEST_FINAL_BILL",
  "ARRANGE_EQUIPMENT_RETURN",
]);

export type MandateAction = z.infer<typeof mandateActionSchema>;

/** Holder-facing labels, in the exact words of spec 0001. */
export const MANDATE_ACTION_LABELS: Record<MandateAction, string> = {
  CANCEL_SERVICE: "Terminate the service",
  REQUEST_FINAL_BILL: "Request the final bill",
  ARRANGE_EQUIPMENT_RETURN: "Arrange return of equipment",
};

export const requestMandateSchema = z.object({
  caseId: z.uuid(),
  actions: z.array(mandateActionSchema),
  maxFeeCents: z.number().int().min(0),
});

export const mandateIdSchema = z.object({ mandateId: z.uuid() });

/** The link token is optional: self-service holders authenticate by session. */
export const linkTokenSchema = z.object({ token: z.string().min(1).optional() });

export const signMandateSchema = z.object({
  token: z.string().min(1).optional(),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
  typedName: z.string().trim().min(1),
  allowLive: z.boolean(),
  fullName: z.string().trim().min(1).optional(),
  nric: z.string().optional(),
});

export type RequestMandateInput = z.infer<typeof requestMandateSchema>;
export type SignMandateInput = z.infer<typeof signMandateSchema>;
