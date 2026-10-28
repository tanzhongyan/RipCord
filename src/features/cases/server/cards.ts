import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "~/server/db";
import { cases, contractTerms, mandates, providerPolicies, providers } from "~/server/db/schema";
import { type CallOverrides, completeJson } from "~/server/model/adapter";
import { loadRetentionPrompt } from "./prompts";

const CheatCardSchema = z.object({
  kind: z.enum(["COUNTER", "VERIFY", "WARN", "INFO"]),
  say: z.string().min(1).max(200),
  why: z.string().min(1).max(160),
});

export type CheatCard = z.infer<typeof CheatCardSchema>;

const CardsResponseSchema = z.object({
  cards: z.array(CheatCardSchema).min(1).max(3),
});

export interface CardsDeps {
  model?: CallOverrides;
}

function cents(value: number | null): string {
  return value === null ? "unknown" : `S$${(value / 100).toFixed(2)}`;
}

function mandateScope(mandate: typeof mandates.$inferSelect): string {
  return (
    `Authorised actions: ${mandate.actions.join(", ")}. ` +
    `Highest fee the holder accepts: ${cents(mandate.maxFeeCents)}. ` +
    `Services outside this mandate must not be changed.`
  );
}

/**
 * Retention-defense cheat cards for one rep turn. The input is already
 * redacted; the model (contributor tier) grounds its 1–3 cards in the
 * contract terms, the provider's published policies and the mandate scope.
 * In chat assist mode `say` is the 1-tap reply; RipCord never sends into
 * third-party chats itself.
 */
export async function generateCards(
  caseId: string,
  redactedRepTurn: string,
  ownerKey: string | null,
  deps: CardsDeps = {},
): Promise<CheatCard[]> {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!c) throw new Error("Case not found");
  const [terms] = await db
    .select()
    .from(contractTerms)
    .where(eq(contractTerms.caseId, caseId))
    .limit(1);
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.caseId, caseId), eq(mandates.status, "ACTIVE")))
    .limit(1);
  const policies = c.providerId
    ? await db
        .select()
        .from(providerPolicies)
        .where(
          and(
            eq(providerPolicies.providerId, c.providerId),
            c.serviceType
              ? or(
                  eq(providerPolicies.serviceType, c.serviceType),
                  isNull(providerPolicies.serviceType),
                )
              : isNull(providerPolicies.serviceType),
          ),
        )
    : [];
  const [provider] = c.providerId
    ? await db
        .select({ name: providers.name })
        .from(providers)
        .where(eq(providers.id, c.providerId))
        .limit(1)
    : [];

  const facts = [
    `Provider: ${provider?.name ?? "unknown"}.`,
    terms
      ? `Contract facts: end date ${terms.contractEndDate ?? "unknown"}, ` +
        `minimum term ${terms.minTermMonths ?? "unknown"} months, ` +
        `early termination estimate ${cents(terms.etfEstimateCents)}, ` +
        `monthly fee ${cents(terms.monthlyFeeCents)}, ` +
        `notice ${terms.noticeDays ?? "unknown"} days, ` +
        `equipment ${JSON.stringify(terms.equipment)}, ` +
        `bundle links ${JSON.stringify(terms.bundleLinks)}.`
      : "Contract facts: unknown. Ask the rep to confirm fees and dates in writing.",
    policies.length > 0
      ? `Published policies: ${policies.map((policy) => `[${policy.kind}] ${policy.excerpt}`).join(" ")}`
      : "Published policies: none on file.",
    mandate ? mandateScope(mandate) : "Mandate: none active.",
  ].join("\n");

  const { data } = await completeJson(
    {
      tier: "contributor",
      messages: [
        { role: "system", content: loadRetentionPrompt(), redacted: true },
        {
          role: "user",
          content: `${facts}\n\nRep's latest message:\n${redactedRepTurn}`,
          redacted: true,
        },
      ],
      ownerKey,
    },
    CardsResponseSchema,
    deps.model,
  );
  return data.cards;
}
