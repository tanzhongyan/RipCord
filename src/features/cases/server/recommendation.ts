import { and, eq, isNull, or } from "drizzle-orm";

import type { Database, Transaction } from "~/server/db";
import { cases, contractTerms, providerPolicies } from "~/server/db/schema";
import { ToolError } from "./errors";

/** The provider policy formula for remaining-months fees. */
export const REMAINING_MONTHS_FORMULA = "REMAINING_MONTHS_X_MONTHLY_FEE";

export interface RecommendationInput {
  monthlyFeeCents: number | null;
  /** `YYYY-MM-DD`, or null when the end date is unknown. */
  contractEndDate: string | null;
  noticeDays: number | null;
  /** The ETF policy rule's `formula`, or null when no policy matched. */
  etfFormula: string | null;
  /** A fixed amount from the ETF policy rule, when it names one. */
  etfFixedCents: number | null;
  /** The extracted ETF clause text, a fallback amount source. */
  etfClauseText: string | null;
}

export interface Recommendation {
  action: "CANCEL_NOW" | "WAIT_UNTIL";
  /** `WAIT_UNTIL` target: end date minus notice days. */
  until: string | null;
  costNowCents: number;
  costWaitCents: number;
  etfEstimateCents: number | null;
}

/** Whole calendar months from `today` to `endDate`, at least zero. */
export function monthsLeft(endDate: string, today: Date): number {
  const [year, month] = endDate.split("-").map(Number) as [number, number];
  const months = (year - today.getUTCFullYear()) * 12 + (month - (today.getUTCMonth() + 1));
  return Math.max(0, months);
}

/** First `$`/`S$` amount in a clause, in cents. Null when the text names none. */
export function parseAmountCents(text: string | null): number | null {
  if (!text) return null;
  const match = /(?:S\$|\$)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i.exec(text);
  if (!match?.[1]) return null;
  const cents = Math.round(Number.parseFloat(match[1].replace(/,/g, "")) * 100);
  return Number.isFinite(cents) ? cents : null;
}

function shiftDate(endDate: string, days: number): string {
  const date = new Date(`${endDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * Deterministic money advice (spec 0004): `cost_now` is the fee estimate
 * plus the fee for the notice window, `cost_wait` is the fee for the months
 * left. Unknown money counts as zero; an unknown end date always says
 * `CANCEL_NOW`, since waiting has no defined end.
 */
export function computeRecommendation(
  input: RecommendationInput,
  today: Date = new Date(),
): Recommendation {
  const fee = input.monthlyFeeCents ?? 0;
  const notice = input.noticeDays ?? 0;
  const months = input.contractEndDate ? monthsLeft(input.contractEndDate, today) : 0;

  let etf: number | null = null;
  if (input.etfFormula === REMAINING_MONTHS_FORMULA) {
    etf = months * fee;
  } else if (input.etfFixedCents !== null) {
    etf = input.etfFixedCents;
  } else {
    etf = parseAmountCents(input.etfClauseText);
  }

  const costWait = fee * months;
  const costNow = (etf ?? 0) + fee * Math.ceil(notice / 30);
  if (!input.contractEndDate || costNow <= costWait) {
    return {
      action: "CANCEL_NOW",
      until: null,
      costNowCents: costNow,
      costWaitCents: costWait,
      etfEstimateCents: etf,
    };
  }
  // A wait target in the past is no target at all: cancel now.
  const until = shiftDate(input.contractEndDate, notice);
  if (until <= today.toISOString().slice(0, 10)) {
    return {
      action: "CANCEL_NOW",
      until: null,
      costNowCents: costNow,
      costWaitCents: costWait,
      etfEstimateCents: etf,
    };
  }
  return {
    action: "WAIT_UNTIL",
    until,
    costNowCents: costNow,
    costWaitCents: costWait,
    etfEstimateCents: etf,
  };
}

/** True when the fee estimate exceeds what the holder accepts on the mandate. */
export function etfExceedsMandate(etfEstimateCents: number | null, maxFeeCents: number): boolean {
  return etfEstimateCents !== null && etfEstimateCents > maxFeeCents;
}

function fixedAmountOf(rule: unknown): number | null {
  if (typeof rule !== "object" || rule === null) return null;
  const record = rule as Record<string, unknown>;
  for (const key of ["amount_cents", "fixed_amount_cents", "amount"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

function formulaOf(rule: unknown): string | null {
  if (typeof rule !== "object" || rule === null) return null;
  const formula = (rule as Record<string, unknown>).formula;
  return typeof formula === "string" ? formula : null;
}

/**
 * Compute the recommendation from the stored terms and the provider's ETF
 * policy, then store it on the case with the fee estimate on the terms row.
 * The exact-service policy wins over the generic one.
 */
export async function persistRecommendation(
  conn: Database | Transaction,
  caseId: string,
  etfClauseText: string | null,
  today: Date = new Date(),
): Promise<Recommendation> {
  const [c] = await conn.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  const [terms] = await conn
    .select()
    .from(contractTerms)
    .where(eq(contractTerms.caseId, caseId))
    .limit(1);
  if (!terms) throw new ToolError("VALIDATION", "Contract terms are missing");

  let etfFormula: string | null = null;
  let etfFixedCents: number | null = null;
  if (c.providerId) {
    const policies = await conn
      .select()
      .from(providerPolicies)
      .where(
        and(
          eq(providerPolicies.providerId, c.providerId),
          eq(providerPolicies.kind, "EARLY_TERMINATION_FEE"),
          c.serviceType
            ? or(
                eq(providerPolicies.serviceType, c.serviceType),
                isNull(providerPolicies.serviceType),
              )
            : isNull(providerPolicies.serviceType),
        ),
      );
    const exact = policies.find((policy) => policy.serviceType === c.serviceType) ?? policies[0];
    etfFormula = formulaOf(exact?.rule);
    etfFixedCents = exact ? fixedAmountOf(exact.rule) : null;
  }

  const recommendation = computeRecommendation(
    {
      monthlyFeeCents: terms.monthlyFeeCents,
      contractEndDate: terms.contractEndDate,
      noticeDays: terms.noticeDays,
      etfFormula,
      etfFixedCents,
      etfClauseText,
    },
    today,
  );
  await conn
    .update(contractTerms)
    .set({ etfEstimateCents: recommendation.etfEstimateCents })
    .where(eq(contractTerms.caseId, caseId));
  await conn
    .update(cases)
    .set({
      recommendation: {
        action: recommendation.action,
        ...(recommendation.until ? { until: recommendation.until } : {}),
        cost_now_cents: recommendation.costNowCents,
        cost_wait_cents: recommendation.costWaitCents,
      },
    })
    .where(eq(cases.id, caseId));
  return recommendation;
}
