// Client-safe plan names. Import this file directly; the feature barrel is server-only.
const PLAN_LABELS: Record<string, string> = {
  INDIVIDUAL: "Individual",
  ORG_MONTHLY: "Organisation monthly",
};

export const planLabel = (plan: string) => PLAN_LABELS[plan] ?? plan;
