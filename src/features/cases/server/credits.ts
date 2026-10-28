import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import type { Database, Transaction } from "~/server/db";
import { billingCustomers, creditLedger } from "~/server/db/schema";
import { ToolError } from "./errors";

interface CreditParty {
  userId: string;
  orgId: string | null;
}

/**
 * One cancellation request costs one credit, consumed at `DRAFT → DISCOVERY`
 * in the same transaction as the status move. An org-owned case bills its
 * org's customer, never the user's. Expired `PLAN_GRANT` rows do not count
 * toward the balance. Re-consuming an already-consumed case is a no-op, so a
 * retried transition never double-charges (the partial unique index backs
 * this as well).
 */
export async function consumeCredit(
  tx: Transaction,
  input: CreditParty & { caseId: string; now: Date },
): Promise<void> {
  const [already] = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.caseId, input.caseId), eq(creditLedger.reason, "CONSUME")))
    .limit(1);
  if (already) return;

  const customer = await findCustomer(tx, input);
  if (!customer) throw new ToolError("PAYMENT_REQUIRED", "No credit left");
  const balance = await balanceOf(tx, customer.id, input.now);
  if (balance < 1) throw new ToolError("PAYMENT_REQUIRED", "No credit left");

  await tx
    .insert(creditLedger)
    .values({ billingCustomerId: customer.id, delta: -1, reason: "CONSUME", caseId: input.caseId })
    .onConflictDoNothing();
}

/**
 * Automatic refunds depend only on system state, never on a user claim. The
 * caller passes one of the three refundable reasons
 * (`PROVIDER_UNSUPPORTED`, `NO_VIABLE_CHANNEL`, `INTERNAL_ERROR`); anything
 * else is a no-op. Refunding is idempotent per case and never blocks the
 * `FAILED` move it rides with.
 */
export async function refundCredit(
  tx: Transaction,
  input: CreditParty & { caseId: string; reason: string },
): Promise<void> {
  if (
    input.reason !== "PROVIDER_UNSUPPORTED" &&
    input.reason !== "NO_VIABLE_CHANNEL" &&
    input.reason !== "INTERNAL_ERROR"
  ) {
    return;
  }
  const customer = await findCustomer(tx, input);
  if (!customer) return;
  await tx
    .insert(creditLedger)
    .values({ billingCustomerId: customer.id, delta: 1, reason: "REFUND", caseId: input.caseId })
    .onConflictDoNothing();
}

/**
 * Unexpired credit balance for a user or org customer. No customer row
 * means no credits. The chat header (spec 0006) reads this; spending still
 * goes through `consumeCredit` inside the transition transaction.
 */
export async function creditBalance(
  conn: Database | Transaction,
  input: CreditParty & { now: Date },
): Promise<number> {
  const customer = await findCustomer(conn, input);
  if (!customer) return 0;
  return balanceOf(conn, customer.id, input.now);
}

async function findCustomer(
  tx: Database | Transaction,
  input: CreditParty,
): Promise<{ id: string } | undefined> {
  const [customer] = await tx
    .select({ id: billingCustomers.id })
    .from(billingCustomers)
    .where(
      input.orgId
        ? eq(billingCustomers.orgId, input.orgId)
        : eq(billingCustomers.userId, input.userId),
    )
    .limit(1);
  return customer;
}

async function balanceOf(
  tx: Database | Transaction,
  billingCustomerId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number | null>`coalesce(sum(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.billingCustomerId, billingCustomerId),
        or(isNull(creditLedger.expiresAt), gt(creditLedger.expiresAt, now)),
      ),
    );
  return Number(row?.total ?? 0);
}
