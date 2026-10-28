import { z } from "zod";

/** Exact copies of the 0000 data-contract enums used by provider records. */
export const serviceTypeSchema = z.enum([
  "MOBILE_POSTPAID",
  "MOBILE_PREPAID",
  "BROADBAND",
  "PAY_TV",
  "FIXED_LINE",
  "UTILITY",
  "GYM",
  "STREAMING",
  "SAAS",
  "OTHER",
]);

export const channelKindSchema = z.enum([
  "EMAIL",
  "PHONE_IVR",
  "WEB_FORM",
  "WEB_CHAT",
  "WHATSAPP",
  "STORE",
  "POST",
]);

export const triStateSchema = z.enum(["YES", "NO", "UNKNOWN"]);

export const documentKindSchema = z.enum([
  "BILL",
  "CONTRACT",
  "SCREENSHOT",
  "LOA",
  "RECEIPT",
  "DISPUTE_PACKAGE",
]);

export const secretKindSchema = z.enum([
  "NRIC",
  "FULL_NAME",
  "DOB",
  "ADDRESS",
  "PHONE",
  "EMAIL",
  "ACCOUNT_NO",
  "PIN",
]);

export const policyKindSchema = z.enum([
  "EARLY_TERMINATION_FEE",
  "NOTICE_PERIOD",
  "MIN_TERM",
  "EQUIPMENT_RETURN",
  "CANCELLATION_METHOD",
]);

export const searchProvidersSchema = z.object({
  query: z.string().trim().min(2).max(80),
  country: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
});

export type SearchProvidersInput = z.input<typeof searchProvidersSchema>;

export const getProviderSchema = z.object({
  id: z.string().uuid(),
});

const ivrStepSchema = z.object({
  prompt: z.string().min(1).max(500),
  digits: z.string().min(1).max(120),
});

/**
 * Fields an admin may edit. `isVerifiedDestination` is deliberately absent:
 * only the `verify` flag on the update input may change it. Strict, so a
 * caller cannot smuggle the verified flag through the patch.
 */
export const adminChannelPatchSchema = z.strictObject({
  serviceType: serviceTypeSchema.nullable().optional(),
  kind: channelKindSchema.optional(),
  address: z.string().min(1).max(2000).optional(),
  ivrPath: z.array(ivrStepSchema).max(20).nullable().optional(),
  hours: z.unknown().optional(),
  acceptsLoa: triStateSchema.optional(),
  requiredDocuments: z.array(documentKindSchema).max(10).optional(),
  requiredSecrets: z.array(secretKindSchema).max(10).optional(),
  noticeDays: z.number().int().min(0).max(366).nullable().optional(),
  sourceUrl: z.string().url().max(2000).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

export type AdminChannelPatch = z.infer<typeof adminChannelPatchSchema>;

export const adminUpdateChannelSchema = z.object({
  channelId: z.string().uuid(),
  patch: adminChannelPatchSchema,
  verify: z.boolean(),
});
