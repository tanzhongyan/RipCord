import { sql } from "drizzle-orm";

import type { Database, Transaction } from "~/server/db";
import { llmUsage } from "~/server/db/schema";

export type ModelErrorCode = "MODEL_BUDGET_EXCEEDED" | "VALIDATION" | "INTERNAL_ERROR";

export class ModelError extends Error {
  readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ModelError";
    this.code = code;
  }
}

/** USD per million tokens, per the `MODEL_PRICES_JSON` config value. */
export interface ModelPrice {
  input: number;
  output: number;
}

export type ModelPrices = Record<string, ModelPrice>;

function isPrice(value: unknown): value is ModelPrice {
  if (typeof value !== "object" || value === null) return false;
  const price = value as Record<string, unknown>;
  return (
    typeof price.input === "number" &&
    Number.isFinite(price.input) &&
    price.input >= 0 &&
    typeof price.output === "number" &&
    Number.isFinite(price.output) &&
    price.output >= 0
  );
}

/** Parse `MODEL_PRICES_JSON`. Every entry is `{ input, output }` in USD per million tokens. */
export function parsePrices(json: string): ModelPrices {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    throw new ModelError("INTERNAL_ERROR", "MODEL_PRICES_JSON is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModelError("INTERNAL_ERROR", "MODEL_PRICES_JSON must be an object");
  }
  for (const [model, price] of Object.entries(raw)) {
    if (!isPrice(price)) {
      throw new ModelError("INTERNAL_ERROR", `MODEL_PRICES_JSON has no usable price for ${model}`);
    }
  }
  return raw as ModelPrices;
}

/** Model-specific price, else the `default` entry. A missing price fails loudly, never free. */
export function priceFor(prices: ModelPrices, model: string): ModelPrice {
  const price = prices[model] ?? prices.default;
  if (!price) throw new ModelError("INTERNAL_ERROR", `No model price for ${model}`);
  return price;
}

/**
 * Micro-dollars for one call. Prices are USD per million tokens, so one
 * token at price P costs exactly P micros: `tokens * P / 1e6 * 1e6`.
 */
export function costMicrosForUsage(
  prices: ModelPrices,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const price = priceFor(prices, model);
  return Math.round(tokensIn * price.input + tokensOut * price.output);
}

/** `llm_usage.period` for a moment: the UTC calendar month as `YYYY-MM`. */
export function currentPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Monthly budget in micros for an owner key (`org:<id>` gets the org budget). */
export function budgetForOwnerKey(
  ownerKey: string,
  budgets: { userMicros: number; orgMicros: number },
): number {
  return ownerKey.startsWith("org:") ? budgets.orgMicros : budgets.userMicros;
}

/**
 * Throw `MODEL_BUDGET_EXCEEDED` when the owner already spent this month's
 * budget. Runs before any HTTP leaves the server.
 */
export async function checkBudget(
  conn: Database | Transaction,
  input: { ownerKey: string; period: string; budgetMicros: number },
): Promise<void> {
  const rows = await conn
    .select({ costMicros: llmUsage.costMicros })
    .from(llmUsage)
    .where(sql`${llmUsage.ownerKey} = ${input.ownerKey} AND ${llmUsage.period} = ${input.period}`)
    .limit(1);
  const spent = rows[0]?.costMicros ?? 0;
  if (spent >= input.budgetMicros) {
    throw new ModelError("MODEL_BUDGET_EXCEEDED", "Monthly AI limit reached");
  }
}

/** Add one call's tokens and cost to the owner's monthly row. */
export async function recordUsage(
  conn: Database | Transaction,
  input: {
    ownerKey: string;
    period: string;
    tokensIn: number;
    tokensOut: number;
    costMicros: number;
  },
): Promise<void> {
  await conn
    .insert(llmUsage)
    .values({
      ownerKey: input.ownerKey,
      period: input.period,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costMicros: input.costMicros,
    })
    .onConflictDoUpdate({
      target: [llmUsage.ownerKey, llmUsage.period],
      set: {
        tokensIn: sql`${llmUsage.tokensIn} + ${input.tokensIn}`,
        tokensOut: sql`${llmUsage.tokensOut} + ${input.tokensOut}`,
        costMicros: sql`${llmUsage.costMicros} + ${input.costMicros}`,
      },
    });
}
