import { z } from "zod";

import {
  channelKindSchema,
  documentKindSchema,
  policyKindSchema,
  secretKindSchema,
  serviceTypeSchema,
  triStateSchema,
} from "../../index";

const ivrStepSchema = z.object({
  prompt: z.string().min(1).max(500),
  digits: z.string().min(1).max(120),
});

const extractedChannelSchema = z.object({
  kind: channelKindSchema,
  serviceType: serviceTypeSchema.nullable().default(null),
  address: z.string().min(1).max(2000),
  ivrPath: z.array(ivrStepSchema).max(20).nullable().default(null),
  hours: z.unknown().default(null),
  acceptsLoa: triStateSchema,
  requiredDocuments: z.array(documentKindSchema).max(10).default([]),
  requiredSecrets: z.array(secretKindSchema).max(10).default([]),
  noticeDays: z.number().int().min(0).max(366).nullable().default(null),
  confidence: z.number().int().min(0).max(100),
  /** The exact sentence the model took this channel from. Empty drops the row. */
  quote: z.string().default(""),
});

const extractedPolicySchema = z.object({
  kind: policyKindSchema,
  serviceType: serviceTypeSchema.nullable().default(null),
  rule: z.record(z.string(), z.unknown()),
  excerpt: z.string().min(1).max(500),
  confidence: z.number().int().min(0).max(100),
  /** The exact sentence the model took this policy from. Empty drops the row. */
  quote: z.string().default(""),
});

export const modelExtractionSchema = z.object({
  channels: z.array(extractedChannelSchema).max(20).default([]),
  policies: z.array(extractedPolicySchema).max(20).default([]),
});

export type ModelExtraction = z.infer<typeof modelExtractionSchema>;

export interface ModelPage {
  url: string;
  text: string;
}

export type ExtractWithModel = (page: ModelPage) => Promise<ModelExtraction>;

/**
 * Model extraction seam.
 *
 * TODO(spec 0004): route this through the 0004 model adapter (contributor
 * tier allowed, since provider pages are public data) with
 * `modelExtractionSchema` as the JSON schema, a US$1 spend cap for a full
 * 5-provider run, and an abort when the adapter's budget says so. Until
 * then live scrapes stop here with a clear error, and tests inject
 * `fakeExtractWithModel`.
 */
export const extractWithModel: ExtractWithModel = async () => {
  throw new Error("Model extraction is not wired until spec 0004 builds the model adapter");
};

/** Test double: returns the canned extraction for any page. */
export function fakeExtractWithModel(canned: ModelExtraction): ExtractWithModel {
  return async () => structuredClone(canned);
}

/** Parse one model response; unknown fields fail the page, not the run. */
export function parseModelExtraction(raw: unknown): ModelExtraction {
  return modelExtractionSchema.parse(raw);
}
