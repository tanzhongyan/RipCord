import { eq } from "drizzle-orm";

import type { Database, Transaction } from "~/server/db";
import { billingCustomers } from "~/server/db/schema";
import { stripeClient } from "./stripe";

export interface CustomerParty {
  userId: string;
  orgId: string | null;
}

export type BillingCustomerRow = typeof billingCustomers.$inferSelect;

/** Load the billing customer for a user or org, or undefined. */
export async function findBillingCustomer(
  conn: Database | Transaction,
  party: CustomerParty,
): Promise<BillingCustomerRow | undefined> {
  const [row] = await conn
    .select()
    .from(billingCustomers)
    .where(
      party.orgId
        ? eq(billingCustomers.orgId, party.orgId)
        : eq(billingCustomers.userId, party.userId),
    )
    .limit(1);
  return row;
}

/** Load the customer row with `FOR UPDATE`, for the consume transaction. */
export async function lockBillingCustomer(
  tx: Transaction,
  party: CustomerParty,
): Promise<BillingCustomerRow | undefined> {
  const [row] = await tx
    .select()
    .from(billingCustomers)
    .where(
      party.orgId
        ? eq(billingCustomers.orgId, party.orgId)
        : eq(billingCustomers.userId, party.userId),
    )
    .for("update")
    .limit(1);
  return row;
}

/** Find the customer or create one with a Stripe customer. Callers hold no lock. */
export async function findOrCreateBillingCustomer(
  conn: Database,
  party: CustomerParty,
): Promise<BillingCustomerRow> {
  const existing = await findBillingCustomer(conn, party);
  if (existing) return existing;
  const stripe = await stripeClient().createCustomer(
    party.orgId ? { orgId: party.orgId } : { userId: party.userId },
  );
  const [row] = await conn
    .insert(billingCustomers)
    .values({
      userId: party.orgId ? null : party.userId,
      orgId: party.orgId,
      stripeCustomerId: stripe.id,
      plan: "INDIVIDUAL",
    })
    .returning();
  if (!row) throw new Error("Failed to create billing customer");
  return row;
}

/** Find the customer inside a transaction or create one. Used by consume. */
export async function lockOrCreateBillingCustomer(
  tx: Transaction,
  party: CustomerParty,
): Promise<BillingCustomerRow> {
  const locked = await lockBillingCustomer(tx, party);
  if (locked) return locked;
  const stripe = await stripeClient().createCustomer(
    party.orgId ? { orgId: party.orgId } : { userId: party.userId },
  );
  const [row] = await tx
    .insert(billingCustomers)
    .values({
      userId: party.orgId ? null : party.userId,
      orgId: party.orgId,
      stripeCustomerId: stripe.id,
      plan: "INDIVIDUAL",
    })
    .returning();
  if (!row) throw new Error("Failed to create billing customer");
  return row;
}
