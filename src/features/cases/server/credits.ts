import { and, eq } from "drizzle-orm";

import {
  clearBalanceCache,
  isStripeConfigured,
  ledgerBalance,
  lockBillingCustomer,
  lockOrCreateBillingCustomer,
} from "~/features/billing";
import type { Database, Transaction } from "~/server/db";
import { billingCustomers, creditLedger } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import { ToolError } from "./errors";

interface CreditParty {
  userId: string;
  orgId: string | null;
}

function checkoutUrl(): string {
  return `${env.APP_URL}/billing?buy=1`;
}

/**
 * One cancellation request costs one credit, consumed at `DRAFT → DISCOVERY`
 * in the same transaction as the status move. The customer row is locked
 * (`SELECT … FOR UPDATE`), the balance is the plain sum of deltas, and a
 * short balance aborts with `PAYMENT_REQUIRED` plus a Checkout URL.
 * Re-consuming an already-consumed case is a no-op, so a retried transition
 * never double-charges (the partial unique index backs this as well).
 */
export async function consumeCredit(
  tx: Transaction,
  input: CreditParty & { caseId: string; now: Date },
): Promise<void> {
  void input.now;
  const [already] = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.caseId, input.caseId), eq(creditLedger.reason, "CONSUME")))
    .limit(1);
  if (already) return;

  let customer = await lockBillingCustomer(tx, input);
  if (!customer) {
    // First use creates the Stripe customer; without Stripe there is no
    // credit to spend, so the case stays DRAFT with a Checkout URL.
    if (!isStripeConfigured()) {
      throw new ToolError("PAYMENT_REQUIRED", `No credit left. Buy more: ${checkoutUrl()}`);
    }
    customer = await lockOrCreateBillingCustomer(tx, input);
  }
  const balance = await ledgerBalance(tx, customer.id);
  if (balance < 1) {
    throw new ToolError("PAYMENT_REQUIRED", `No credit left. Buy more: ${checkoutUrl()}`);
  }

  await tx
    .insert(creditLedger)
    .values({ billingCustomerId: customer.id, delta: -1, reason: "CONSUME", caseId: input.caseId })
    .onConflictDoNothing();
  await clearBalanceCache(customer.id);
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
  await clearBalanceCache(customer.id);
}

/**
 * Credit balance for a user or org customer. No customer row means no
 * credits. The chat header (spec 0006) reads this; spending still goes
 * through `consumeCredit` inside the transition transaction.
 */
export async function creditBalance(
  conn: Database | Transaction,
  input: CreditParty & { now: Date },
): Promise<number> {
  void input.now;
  const customer = await findCustomer(conn, input);
  if (!customer) return 0;
  return ledgerBalance(conn, customer.id);
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
