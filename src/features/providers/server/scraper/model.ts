import { z } from "zod";

import { type CallOverrides, completeJson } from "~/server/model/adapter";
import { ModelError } from "~/server/model/budget";
import { redactPatterns } from "~/server/vault";
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

const SCRAPE_SYSTEM =
  "Extract customer-service contact channels and cancellation policies from this " +
  "provider help page. Reply with a single JSON object { channels, policies }. " +
  "Quote the exact page sentence behind each entry in its quote field.";

export interface ScrapeModelState {
  spentMicros: number;
}

/** US$1 in micros: the spend cap for a full 5-provider scrape run. */
export const SCRAPE_RUN_SPEND_CAP_MICROS = 1_000_000;

export interface ScrapeModelOpts {
  /** Cumulative spend, shared across providers for one CLI run. */
  state?: ScrapeModelState;
  spendCapMicros?: number;
  /**
   * `llm_usage` owner key, or null for run-cap-only system runs. The
   * provider scraper is a system job, not owner spend, so it passes null
   * and enforces the run cap below instead of a monthly budget.
   */
  ownerKey?: string | null;
  model?: CallOverrides;
}

/**
 * Model extraction through the 0004 adapter. Provider pages are public
 * data, so the contributor tier is allowed after a pattern redaction pass;
 * `modelExtractionSchema` validates the answer with one retry. The shared
 * run cap throws `MODEL_BUDGET_EXCEEDED` before the call that would exceed
 * it, and the runner aborts the loop on that error.
 */
export function createScrapeExtractor(opts: ScrapeModelOpts = {}): ExtractWithModel {
  const state = opts.state ?? { spentMicros: 0 };
  const cap = opts.spendCapMicros ?? SCRAPE_RUN_SPEND_CAP_MICROS;
  return async (page) => {
    if (state.spentMicros >= cap) {
      throw new ModelError("MODEL_BUDGET_EXCEEDED", "Scrape run spend cap reached");
    }
    const { data, usage } = await completeJson(
      {
        tier: "contributor",
        messages: [
          { role: "system", content: SCRAPE_SYSTEM, redacted: true },
          {
            role: "user",
            content: `Page ${page.url}:\n\n${redactPatterns(page.text)}`,
            redacted: true,
          },
        ],
        ownerKey: opts.ownerKey ?? null,
      },
      modelExtractionSchema,
      opts.model,
    );
    state.spentMicros += usage.costMicros;
    return data;
  };
}

/** Single-provider extractor with its own run cap. The CLI shares one cap. */
export const extractWithModel: ExtractWithModel = createScrapeExtractor();

/** Test double: returns the canned extraction for any page. */
export function fakeExtractWithModel(canned: ModelExtraction): ExtractWithModel {
  return async () => structuredClone(canned);
}

/** Parse one model response; unknown fields fail the page, not the run. */
export function parseModelExtraction(raw: unknown): ModelExtraction {
  return modelExtractionSchema.parse(raw);
}
