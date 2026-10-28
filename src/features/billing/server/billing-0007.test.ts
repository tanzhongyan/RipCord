import { randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as stripeWebhook } from "~/app/api/stripe/webhook/route";
import { setValkeyOverride } from "~/features/identity";
import { db } from "~/server/db";
import { billingCustomers, creditLedger, users } from "~/server/db/schema";
import { FakeStripeClient, setStripeOverride } from "./stripe";
import { handleStripeEvent } from "./webhook";

/** Minimal Valkey double for the balance cache. */
class FakeCache {
  private readonly strings = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.strings.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    this.strings.delete(key);
    return 1;
  }
  async incr(): Promise<number> {
    return 1;
  }
  async expire(): Promise<unknown> {
    return 1;
  }
  async ttl(): Promise<number> {
    return -1;
  }
}

beforeEach(() => {
  setValkeyOverride(new FakeCache() as never);
});

afterEach(() => {
  setStripeOverride(null);
  setValkeyOverride(null);
});

async function seedUserAndCustomer() {
  const [user] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      name: "Billing User",
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("seed user failed");
  const [customer] = await db
    .insert(billingCustomers)
    .values({ userId: user.id, stripeCustomerId: `cus_${randomUUID()}`, plan: "INDIVIDUAL" })
    .returning();
  if (!customer) throw new Error("seed customer failed");
  return { user, customer };
}

async function purchaseCount(stripeRef: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(creditLedger)
    .where(and(eq(creditLedger.stripeRef, stripeRef), eq(creditLedger.reason, "PURCHASE")));
  return row?.n ?? 0;
}

describe("B1 Purchase", () => {
  it("grants once on a replayed checkout.session.completed", async () => {
    setStripeOverride(new FakeStripeClient());
    const { customer } = await seedUserAndCustomer();
    const sessionId = `cs_b1_${customer.id.slice(0, 8)}`;
    const event = {
      id: "evt_b1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          mode: "payment",
          customer: customer.stripeCustomerId,
          metadata: { quantity: "5" },
        },
      },
    };
    await handleStripeEvent(event);
    await handleStripeEvent(event);
    expect(await purchaseCount(sessionId)).toBe(1);
    const [row] = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.stripeRef, sessionId))
      .limit(1);
    expect(row?.delta).toBe(5);
  });
});

describe("B6 Plan renewal", () => {
  it("writes EXPIRE then PLAN_GRANT on invoice.paid", async () => {
    setStripeOverride(new FakeStripeClient());
    const { customer } = await seedUserAndCustomer();
    // Prior grant of 20, 12 consumed (case-less consumes keep the math).
    await db.insert(creditLedger).values({
      billingCustomerId: customer.id,
      delta: 20,
      reason: "PLAN_GRANT",
    });
    for (let i = 0; i < 12; i++) {
      await db.insert(creditLedger).values({
        billingCustomerId: customer.id,
        delta: -1,
        reason: "CONSUME",
      });
    }
    const invoiceId = `in_b6_${customer.id.slice(0, 8)}`;
    await handleStripeEvent({
      id: "evt_b6",
      type: "invoice.paid",
      data: {
        object: { id: invoiceId, customer: customer.stripeCustomerId, subscription: "sub_1" },
      },
    });
    const rows = await db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.stripeRef, invoiceId))
      .orderBy(creditLedger.createdAt);
    expect(rows.map((row) => `${row.reason}:${row.delta}`)).toEqual(["EXPIRE:-8", "PLAN_GRANT:20"]);
  });
});

describe("B7 Webhook signature", () => {
  it("returns 400 and writes nothing on a bad signature", async () => {
    setStripeOverride(new FakeStripeClient());
    const [before] = await db.select({ n: count() }).from(creditLedger);
    const res = await stripeWebhook(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "bad-signature" },
        body: JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: {} }),
      }),
    );
    expect(res.status).toBe(400);
    const [after] = await db.select({ n: count() }).from(creditLedger);
    expect(after?.n).toBe(before?.n);
  });
});
