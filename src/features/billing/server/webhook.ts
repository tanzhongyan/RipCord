import { and, desc, eq, gt, sql } from "drizzle-orm";

import { type Database, db, type Transaction } from "~/server/db";
import { billingCustomers, creditLedger } from "~/server/db/schema";
import { clearBalanceCache, ledgerBalance } from "./balance";

/** Plan grant size: 20 credits per renewal. */
const PLAN_GRANT_SIZE = 20;

interface CheckoutSessionObject {
  id: string;
  mode?: string | null;
  customer?: string | null;
  metadata?: Record<string, string> | null;
  quantity?: number | null;
}

interface InvoiceObject {
  id: string;
  customer?: string | null;
  subscription?: string | null;
}

interface SubscriptionObject {
  id: string;
  customer?: string | null;
}

interface StripeEvent {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
}

type Conn = Database | Transaction;

function asEvent(value: unknown): StripeEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.id !== "string") return null;
  return record as unknown as StripeEvent;
}

async function hasStripeRef(conn: Conn, stripeRef: string): Promise<boolean> {
  const [row] = await conn
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.stripeRef, stripeRef))
    .limit(1);
  return !!row;
}

/**
 * Lock the customer row for one event. Concurrent replays of the same event
 * serialize here, so the `stripe_ref` check below grants exactly once. (A
 * renewal writes two rows under one `stripe_ref`, so no unique index can
 * express the rule; the lock does.)
 */
async function lockedCustomerByStripeId(
  tx: Transaction,
  stripeCustomerId: string,
): Promise<typeof billingCustomers.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
    .for("update")
    .limit(1);
  return row;
}

/** Apply a payment checkout. Returns the customer id when a row was written. */
async function applyCheckoutCompleted(
  tx: Transaction,
  session: CheckoutSessionObject,
): Promise<string | null> {
  if (session.mode !== "payment") return null;
  const stripeRef = session.id;
  const customerId = session.customer;
  if (!customerId) return null;
  const customer = await lockedCustomerByStripeId(tx, customerId);
  if (!customer) return null;
  if (await hasStripeRef(tx, stripeRef)) return null;
  const quantity = Number(session.metadata?.quantity ?? session.quantity ?? 0);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  await tx.insert(creditLedger).values({
    billingCustomerId: customer.id,
    delta: quantity,
    reason: "PURCHASE",
    stripeRef,
  });
  return customer.id;
}

/**
 * Plan renewal: first `EXPIRE -n` where
 * `n = min(balance, max(0, last_grant − consumes_since_last_grant))`,
 * then `PLAN_GRANT +20`. Both keyed on the invoice ID. In that order.
 */
async function applyPlanRenewal(
  tx: Transaction,
  customerId: string,
  invoiceId: string,
  now: Date,
): Promise<{ expired: number; granted: number }> {
  if (await hasStripeRef(tx, invoiceId)) return { expired: 0, granted: 0 };
  const [lastGrant] = await tx
    .select()
    .from(creditLedger)
    .where(
      and(eq(creditLedger.billingCustomerId, customerId), eq(creditLedger.reason, "PLAN_GRANT")),
    )
    .orderBy(desc(creditLedger.createdAt))
    .limit(1);
  let unexpired = 0;
  if (lastGrant) {
    const [consumes] = await tx
      .select({ total: sql<number | null>`coalesce(sum(${creditLedger.delta}), 0)` })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.billingCustomerId, customerId),
          eq(creditLedger.reason, "CONSUME"),
          gt(creditLedger.createdAt, lastGrant.createdAt),
        ),
      );
    const consumed = Math.abs(Number(consumes?.total ?? 0));
    unexpired = Math.max(0, lastGrant.delta - consumed);
  }
  const balance = await ledgerBalance(tx, customerId);
  const n = Math.min(balance, unexpired);
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
  if (n > 0) {
    await tx.insert(creditLedger).values({
      billingCustomerId: customerId,
      delta: -n,
      reason: "EXPIRE",
      stripeRef: invoiceId,
    });
  }
  await tx.insert(creditLedger).values({
    billingCustomerId: customerId,
    delta: PLAN_GRANT_SIZE,
    reason: "PLAN_GRANT",
    stripeRef: invoiceId,
    expiresAt,
  });
  await tx
    .update(billingCustomers)
    .set({ plan: "ORG_MONTHLY", planRenewsAt: expiresAt })
    .where(eq(billingCustomers.id, customerId));
  return { expired: n, granted: PLAN_GRANT_SIZE };
}

/** Apply a paid invoice. Returns the customer id when rows were written. */
async function applyInvoicePaid(
  tx: Transaction,
  invoice: InvoiceObject,
  now: Date,
): Promise<string | null> {
  const customerId = invoice.customer;
  if (!customerId) return null;
  if (!invoice.subscription) return null;
  const customer = await lockedCustomerByStripeId(tx, customerId);
  if (!customer) return null;
  const { granted } = await applyPlanRenewal(tx, customer.id, invoice.id, now);
  return granted > 0 ? customer.id : null;
}

async function applySubscriptionDeleted(
  tx: Transaction,
  subscription: SubscriptionObject,
): Promise<void> {
  const customerId = subscription.customer;
  if (!customerId) return;
  const customer = await lockedCustomerByStripeId(tx, customerId);
  if (!customer) return;
  await tx
    .update(billingCustomers)
    .set({ plan: "INDIVIDUAL", planRenewsAt: null })
    .where(eq(billingCustomers.id, customer.id));
}

/** Apply one verified Stripe event. Unknown types are ignored. */
export async function handleStripeEvent(
  event: unknown,
  opts: { conn?: Database; now?: Date } = {},
): Promise<{ handled: boolean }> {
  const parsed = asEvent(event);
  if (!parsed) return { handled: false };
  const conn = opts.conn ?? db;
  const now = opts.now ?? new Date();
  const object = (parsed.data?.object ?? {}) as Record<string, unknown>;
  switch (parsed.type) {
    case "checkout.session.completed": {
      const customerId = await conn.transaction((tx) =>
        applyCheckoutCompleted(tx, {
          id: String(object.id ?? parsed.id),
          mode: typeof object.mode === "string" ? object.mode : null,
          customer: typeof object.customer === "string" ? object.customer : null,
          metadata:
            typeof object.metadata === "object" && object.metadata !== null
              ? (object.metadata as Record<string, string>)
              : null,
          quantity: typeof object.quantity === "number" ? object.quantity : null,
        }),
      );
      if (customerId) await clearBalanceCache(customerId);
      return { handled: true };
    }
    case "invoice.paid": {
      const customerId = await conn.transaction((tx) =>
        applyInvoicePaid(
          tx,
          {
            id: String(object.id ?? parsed.id),
            customer: typeof object.customer === "string" ? object.customer : null,
            subscription: typeof object.subscription === "string" ? object.subscription : null,
          },
          now,
        ),
      );
      if (customerId) await clearBalanceCache(customerId);
      return { handled: true };
    }
    case "customer.subscription.deleted":
      await conn.transaction((tx) =>
        applySubscriptionDeleted(tx, {
          id: String(object.id ?? parsed.id),
          customer: typeof object.customer === "string" ? object.customer : null,
        }),
      );
      return { handled: true };
    default:
      return { handled: false };
  }
}
