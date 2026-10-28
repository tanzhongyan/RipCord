import type { z } from "zod";

import { db } from "~/server/db";
import { env } from "~/shared/config/env";
import {
  checkBudget,
  costMicrosForUsage,
  currentPeriod,
  ModelError,
  parsePrices,
  recordUsage,
} from "./budget";
import { takeFakeResponse } from "./fake";
import { type MetaTransportOpts, metaComplete, metaStream } from "./meta";

export type ModelTier = "standard" | "contributor";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** `data:` URL. Never logged: it may show an unredacted bill. */
  dataUrl: string;
}

export type MessagePart = TextPart | ImagePart;

/**
 * One chat message. `redacted` attests the text passed `redact` (spec 0002)
 * or is public data that passed the pattern pass; the tier rule trusts this
 * flag, so only set it after actually redacting.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | MessagePart[];
  redacted: boolean;
}

export interface ModelUsage {
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
}

export interface CompleteInput {
  tier: ModelTier;
  messages: ChatMessage[];
  /**
   * `llm_usage` owner key (`user:<id>` or `org:<id>`). Null skips the monthly
   * budget: system jobs such as the provider scraper enforce their own
   * run-scoped cap instead.
   */
  ownerKey: string | null;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  /** The model that actually served the request, after the tier rule. */
  model: string;
  usage: ModelUsage;
}

export interface CallOverrides extends MetaTransportOpts {
  provider?: "meta" | "fake";
  /** Test seam: the live key comes from `META_API_KEY`. */
  apiKey?: string;
  now?: () => Date;
}

export function hasImagePart(message: ChatMessage): boolean {
  return (
    typeof message.content !== "string" && message.content.some((part) => part.type === "image")
  );
}

/**
 * The enforced tier rule (spec 0004): `contributor` serves a request only
 * when every message passed `redact` and carries no image parts. Anything
 * else drops to `standard`. Callers cannot override this.
 */
export function resolveModel(
  tier: ModelTier,
  messages: ChatMessage[],
  models: { standard: string; contributor: string },
): string {
  if (tier !== "contributor") return models.standard;
  const clean = messages.every((message) => message.redacted && !hasImagePart(message));
  return clean ? models.contributor : models.standard;
}

function liveModels(): { standard: string; contributor: string } {
  return { standard: env.MODEL_STANDARD, contributor: env.MODEL_CONTRIBUTOR };
}

/** Monthly budget gate. A null owner key (system jobs) skips the check. */
async function checkOwnerBudget(ownerKey: string | null, period: string): Promise<void> {
  if (!ownerKey) return;
  const budgetMicros = ownerKey.startsWith("org:")
    ? env.MODEL_BUDGET_ORG_MICROS
    : env.MODEL_BUDGET_USER_MICROS;
  await checkBudget(db, { ownerKey, period, budgetMicros });
}

/**
 * One chat completion. The budget check runs before any transport work, so
 * an over-budget owner never causes an HTTP request.
 */
export async function complete(
  input: CompleteInput,
  overrides: CallOverrides = {},
): Promise<CompleteResult> {
  if (input.messages.length === 0) {
    throw new ModelError("VALIDATION", "At least one message is required");
  }
  const provider = overrides.provider ?? env.MODEL_PROVIDER;
  const now = overrides.now ?? (() => new Date());
  const period = currentPeriod(now());
  const models = liveModels();
  const model = resolveModel(input.tier, input.messages, models);
  const prices = parsePrices(env.MODEL_PRICES_JSON);
  await checkOwnerBudget(input.ownerKey, period);

  let text: string;
  let tokensIn: number;
  let tokensOut: number;
  if (provider === "fake") {
    const scripted = takeFakeResponse({ model, tier: input.tier, messages: input.messages });
    text = scripted.text;
    tokensIn = scripted.tokensIn;
    tokensOut = scripted.tokensOut;
  } else {
    const result = await metaComplete(
      {
        baseUrl: env.META_BASE_URL,
        apiKey: overrides.apiKey ?? env.META_API_KEY ?? "",
        model,
        messages: input.messages,
        maxTokens: input.maxTokens,
      },
      overrides,
    );
    text = result.text;
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
  }

  const costMicros = costMicrosForUsage(prices, model, tokensIn, tokensOut);
  if (input.ownerKey) {
    await recordUsage(db, {
      ownerKey: input.ownerKey,
      period,
      tokensIn,
      tokensOut,
      costMicros,
    });
  }
  return { text, model, usage: { tokensIn, tokensOut, costMicros } };
}

const JSON_SUFFIX =
  "Reply with a single JSON object and no other text. Do not wrap it in code fences.";

function withJsonSuffix(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1] as ChatMessage;
  if (typeof last.content === "string") {
    return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${JSON_SUFFIX}` }];
  }
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...last.content, { type: "text" as const, text: JSON_SUFFIX }] },
  ];
}

export interface CompleteJsonResult<T> {
  data: T;
  model: string;
  usage: ModelUsage;
  attempts: number;
}

/**
 * Completion parsed as JSON and validated with Zod, retrying once on a
 * parse failure. Usage sums both attempts. The prompt path (not
 * `response_format`) keeps this working on any OpenAI-compatible endpoint.
 */
export async function completeJson<T>(
  input: CompleteInput,
  schema: z.ZodType<T>,
  overrides: CallOverrides = {},
): Promise<CompleteJsonResult<T>> {
  const errors: string[] = [];
  const usage: ModelUsage = { tokensIn: 0, tokensOut: 0, costMicros: 0 };
  let model = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await complete(
      { ...input, messages: withJsonSuffix(input.messages) },
      overrides,
    );
    model = result.model;
    usage.tokensIn += result.usage.tokensIn;
    usage.tokensOut += result.usage.tokensOut;
    usage.costMicros += result.usage.costMicros;
    try {
      const parsed = schema.parse(JSON.parse(result.text) as unknown);
      return { data: parsed, model, usage, attempts: attempt };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Invalid JSON");
    }
  }
  throw new ModelError("VALIDATION", `Model returned invalid JSON: ${errors.at(-1) ?? ""}`);
}

/**
 * Streaming completion. Each budget check runs before the stream opens; the
 * returned generator yields text deltas, and usage is recorded once the
 * consumer drains it.
 */
export async function stream(
  input: CompleteInput,
  overrides: CallOverrides = {},
): Promise<{ chunks: AsyncIterable<string>; model: string; usage: () => Promise<ModelUsage> }> {
  if (input.messages.length === 0) {
    throw new ModelError("VALIDATION", "At least one message is required");
  }
  const provider = overrides.provider ?? env.MODEL_PROVIDER;
  const now = overrides.now ?? (() => new Date());
  const period = currentPeriod(now());
  const models = liveModels();
  const model = resolveModel(input.tier, input.messages, models);
  const prices = parsePrices(env.MODEL_PRICES_JSON);
  await checkOwnerBudget(input.ownerKey, period);

  const finish = async (tokensIn: number, tokensOut: number): Promise<ModelUsage> => {
    const costMicros = costMicrosForUsage(prices, model, tokensIn, tokensOut);
    if (input.ownerKey) {
      await recordUsage(db, {
        ownerKey: input.ownerKey,
        period,
        tokensIn,
        tokensOut,
        costMicros,
      });
    }
    return { tokensIn, tokensOut, costMicros };
  };

  if (provider === "fake") {
    const scripted = takeFakeResponse({ model, tier: input.tier, messages: input.messages });
    const done = { recorded: false, usage: { tokensIn: 0, tokensOut: 0, costMicros: 0 } };
    async function* chunks(): AsyncGenerator<string> {
      for (const piece of scripted.chunks) yield piece;
      done.usage = await finish(scripted.tokensIn, scripted.tokensOut);
      done.recorded = true;
    }
    return {
      chunks: chunks(),
      model,
      usage: async () => {
        if (!done.recorded) done.usage = await finish(scripted.tokensIn, scripted.tokensOut);
        return done.usage;
      },
    };
  }

  const live = await metaStream(
    {
      baseUrl: env.META_BASE_URL,
      apiKey: overrides.apiKey ?? env.META_API_KEY ?? "",
      model,
      messages: input.messages,
      maxTokens: input.maxTokens,
    },
    overrides,
  );
  let recorded: ModelUsage | null = null;
  async function* chunks(): AsyncGenerator<string> {
    for await (const piece of live.chunks) yield piece;
    const tokens = await live.usage();
    recorded = await finish(tokens.tokensIn, tokens.tokensOut);
  }
  return {
    chunks: chunks(),
    model,
    usage: async () => {
      if (!recorded) {
        const tokens = await live.usage();
        recorded = await finish(tokens.tokensIn, tokens.tokensOut);
      }
      return recorded;
    },
  };
}
