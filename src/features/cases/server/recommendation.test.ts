import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "~/server/db";
import { cases, contractTerms, providerPolicies } from "~/server/db/schema";
import {
  computeRecommendation,
  etfExceedsMandate,
  monthsLeft,
  parseAmountCents,
  persistRecommendation,
  REMAINING_MONTHS_FORMULA,
} from "./recommendation";
import { seedCase, seedHolder, seedProvider, seedTerms, seedUser } from "./test-support";

const TODAY = new Date("2026-10-28T00:00:00Z");

describe("B4 Recommendation", () => {
  it("waits out a cheaper tail: cost_now 35000 vs cost_wait 30000", () => {
    const result = computeRecommendation(
      {
        monthlyFeeCents: 5000,
        contractEndDate: "2027-04-28",
        noticeDays: 30,
        etfFormula: REMAINING_MONTHS_FORMULA,
        etfFixedCents: null,
        etfClauseText: null,
      },
      TODAY,
    );
    expect(REMAINING_MONTHS_FORMULA).toBe("REMAINING_MONTHS_X_MONTHLY_FEE");
    expect(monthsLeft("2027-04-28", TODAY)).toBe(6);
    expect(result.etfEstimateCents).toBe(30000);
    expect(result.costNowCents).toBe(35000);
    expect(result.costWaitCents).toBe(30000);
    expect(result.action).toBe("WAIT_UNTIL");
    expect(result.until).toBe("2027-03-29");
  });
});

describe("recommendation edges", () => {
  it("cancels now when the end date is unknown", () => {
    const result = computeRecommendation(
      {
        monthlyFeeCents: 5000,
        contractEndDate: null,
        noticeDays: 30,
        etfFormula: "REMAINING_MONTHS_X_MONTHLY_FEE",
        etfFixedCents: null,
        etfClauseText: null,
      },
      TODAY,
    );
    expect(result.action).toBe("CANCEL_NOW");
    expect(result.until).toBeNull();
  });

  it("cancels now when waiting has no future target", () => {
    const result = computeRecommendation(
      {
        monthlyFeeCents: 5000,
        contractEndDate: "2026-09-01",
        noticeDays: 30,
        etfFormula: "REMAINING_MONTHS_X_MONTHLY_FEE",
        etfFixedCents: null,
        etfClauseText: null,
      },
      TODAY,
    );
    expect(result.action).toBe("CANCEL_NOW");
  });

  it("cancels now when leaving now is cheaper", () => {
    const result = computeRecommendation(
      {
        monthlyFeeCents: 5000,
        contractEndDate: "2027-10-28",
        noticeDays: 0,
        etfFormula: "FIXED",
        etfFixedCents: 1000,
        etfClauseText: null,
      },
      TODAY,
    );
    expect(result.etfEstimateCents).toBe(1000);
    expect(result.costNowCents).toBe(1000);
    expect(result.costWaitCents).toBe(60000);
    expect(result.action).toBe("CANCEL_NOW");
  });

  it("reads a fixed fee from the clause text when the policy names none", () => {
    expect(parseAmountCents("Early termination fee of S$199 applies.")).toBe(19900);
    expect(parseAmountCents("no money here")).toBeNull();
    const result = computeRecommendation(
      {
        monthlyFeeCents: 5000,
        contractEndDate: "2027-04-28",
        noticeDays: 30,
        etfFormula: "SOME_OTHER_FORMULA",
        etfFixedCents: null,
        etfClauseText: "Early termination fee of $199 applies.",
      },
      TODAY,
    );
    expect(result.etfEstimateCents).toBe(19900);
  });

  it("warns when the fee estimate exceeds the mandate cap", () => {
    expect(etfExceedsMandate(30000, 500)).toBe(true);
    expect(etfExceedsMandate(300, 500)).toBe(false);
    expect(etfExceedsMandate(null, 500)).toBe(false);
  });

  it("persists the estimate and the case recommendation", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "DISCOVERY",
    });
    await seedTerms(c.id, { contractEndDate: "2027-04-28", monthlyFeeCents: 5000, noticeDays: 30 });
    await db.insert(providerPolicies).values({
      providerId: provider.id,
      serviceType: null,
      kind: "EARLY_TERMINATION_FEE",
      rule: { formula: "REMAINING_MONTHS_X_MONTHLY_FEE" },
      excerpt: "Fee equals remaining months times the monthly fee.",
      sourceUrl: "https://demo-telco.test/terms",
      checkedAt: new Date(),
    });
    const result = await persistRecommendation(db, c.id, null, TODAY);
    expect(result.action).toBe("WAIT_UNTIL");
    const [terms] = await db
      .select({ etf: contractTerms.etfEstimateCents })
      .from(contractTerms)
      .where(eq(contractTerms.caseId, c.id))
      .limit(1);
    expect(terms?.etf).toBe(30000);
    const [updated] = await db
      .select({ recommendation: cases.recommendation })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(updated?.recommendation).toMatchObject({
      action: "WAIT_UNTIL",
      until: "2027-03-29",
      cost_now_cents: 35000,
      cost_wait_cents: 30000,
    });
  });
});
