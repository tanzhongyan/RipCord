import { and, desc, eq, gt, sql } from "drizzle-orm";

import { type Database, db } from "~/server/db";
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

function asEvent(value: unknown): StripeEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.id !== "string") return null;
  return record as unknown as StripeEvent;
}

async function hasStripeRef(conn: Database, stripeRef: string): Promise<boolean> {
  const [row] = await conn
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.stripeRef, stripeRef))
    .limit(1);
  return !!row;
}

async function customerByStripeId(
  conn: Database,
  stripeCustomerId: string,
): Promise<typeof billingCustomers.$inferSelect | undefined> {
  const [row] = await conn
    .select()
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row;
}

async function handleCheckoutCompleted(
  conn: Database,
  session: CheckoutSessionObject,
): Promise<void> {
  if (session.mode !== "payment") return;
  const stripeRef = session.id;
  if (await hasStripeRef(conn, stripeRef)) return;
  const customerId = session.customer;
  if (!customerId) return;
  const customer = await customerByStripeId(conn, customerId);
  if (!customer) return;
  const quantity = Number(session.metadata?.quantity ?? session.quantity ?? 0);
  if (!Number.isInteger(quantity) || quantity <= 0) return;
  await conn.insert(creditLedger).values({
    billingCustomerId: customer.id,
    delta: quantity,
    reason: "PURCHASE",
    stripeRef,
  });
  await clearBalanceCache(customer.id);
}

/**
 * Plan renewal: first `EXPIRE -n` where
 * `n = min(balance, max(0, last_grant − consumes_since_last_grant))`,
 * then `PLAN_GRANT +20`. Both keyed on the invoice ID. In that order.
 */
async function applyPlanRenewal(
  conn: Database,
  customerId: string,
  invoiceId: string,
  now: Date,
): Promise<{ expired: number; granted: number }> {
  if (await hasStripeRef(conn, invoiceId)) return { expired: 0, granted: 0 };
  const [lastGrant] = await conn
    .select()
    .from(creditLedger)
    .where(
      and(eq(creditLedger.billingCustomerId, customerId), eq(creditLedger.reason, "PLAN_GRANT")),
    )
    .orderBy(desc(creditLedger.createdAt))
    .limit(1);
  let unexpired = 0;
  if (lastGrant) {
    const [consumes] = await conn
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
  const balance = await ledgerBalance(conn, customerId);
  const n = Math.min(balance, unexpired);
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
  if (n > 0) {
    await conn.insert(creditLedger).values({
      billingCustomerId: customerId,
      delta: -n,
      reason: "EXPIRE",
      stripeRef: invoiceId,
    });
  }
  await conn.insert(creditLedger).values({
    billingCustomerId: customerId,
    delta: PLAN_GRANT_SIZE,
    reason: "PLAN_GRANT",
    stripeRef: invoiceId,
    expiresAt,
  });
  await conn
    .update(billingCustomers)
    .set({ plan: "ORG_MONTHLY", planRenewsAt: expiresAt })
    .where(eq(billingCustomers.id, customerId));
  await clearBalanceCache(customerId);
  return { expired: n, granted: PLAN_GRANT_SIZE };
}

async function handleInvoicePaid(conn: Database, invoice: InvoiceObject, now: Date): Promise<void> {
  const customerId = invoice.customer;
  if (!customerId) return;
  const customer = await customerByStripeId(conn, customerId);
  if (!customer) return;
  if (!invoice.subscription) return;
  await applyPlanRenewal(conn, customer.id, invoice.id, now);
}

async function handleSubscriptionDeleted(
  conn: Database,
  subscription: SubscriptionObject,
): Promise<void> {
  const customerId = subscription.customer;
  if (!customerId) return;
  const customer = await customerByStripeId(conn, customerId);
  if (!customer) return;
  await conn
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
    case "checkout.session.completed":
      await handleCheckoutCompleted(conn, {
        id: String(object.id ?? parsed.id),
        mode: typeof object.mode === "string" ? object.mode : null,
        customer: typeof object.customer === "string" ? object.customer : null,
        metadata:
          typeof object.metadata === "object" && object.metadata !== null
            ? (object.metadata as Record<string, string>)
            : null,
        quantity: typeof object.quantity === "number" ? object.quantity : null,
      });
      return { handled: true };
    case "invoice.paid":
      await handleInvoicePaid(
        conn,
        {
          id: String(object.id ?? parsed.id),
          customer: typeof object.customer === "string" ? object.customer : null,
          subscription: typeof object.subscription === "string" ? object.subscription : null,
        },
        now,
      );
      return { handled: true };
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(conn, {
        id: String(object.id ?? parsed.id),
        customer: typeof object.customer === "string" ? object.customer : null,
      });
      return { handled: true };
    default:
      return { handled: false };
  }
}
