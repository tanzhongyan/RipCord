import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeStripeClient, setStripeOverride } from "~/features/billing";
import { setValkeyOverride } from "~/features/identity";
import { db } from "~/server/db";
import { cases, creditLedger } from "~/server/db/schema";
import { transition } from "./engine";
import { setEventsOverride } from "./events";
import {
  FakeEvents,
  FakeValkey,
  seedBillingCustomer,
  seedCase,
  seedCredit,
  seedHolder,
  seedUser,
  testToolContext,
} from "./test-support";
import { callTool } from "./tools/registry";

const ACTOR = { type: "USER" as const, id: "user-1" };

async function balanceOf(customerId: string): Promise<number> {
  const rows = await db
    .select({ delta: creditLedger.delta })
    .from(creditLedger)
    .where(eq(creditLedger.billingCustomerId, customerId));
  return rows.reduce((sum, row) => sum + row.delta, 0);
}

async function refundCount(caseId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(creditLedger)
    .where(and(eq(creditLedger.caseId, caseId), eq(creditLedger.reason, "REFUND")));
  return row?.n ?? 0;
}

beforeEach(() => {
  setValkeyOverride(new FakeValkey() as never);
});

afterEach(() => {
  setEventsOverride(null);
  setStripeOverride(null);
  setValkeyOverride(null);
});

describe("B2 Consume race", () => {
  it("lets exactly one of two racing start-case calls succeed", async () => {
    setStripeOverride(new FakeStripeClient());
    setEventsOverride(new FakeEvents());
    const user = await seedUser();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    const holder = await seedHolder(user.id);
    const first = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    const second = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    const ctx = testToolContext(user.id, []);
    const results = await Promise.allSettled([
      callTool("start-case", { caseId: first.id, confirm: true }, ctx),
      callTool("start-case", { caseId: second.id, confirm: true }, ctx),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
    expect(reason.code).toBe("PAYMENT_REQUIRED");
    expect(await balanceOf(customer.id)).toBe(0);
  });
});

describe("B3 Idempotent start", () => {
  it("does not change the balance on retry for the same case", async () => {
    setStripeOverride(new FakeStripeClient());
    setEventsOverride(new FakeEvents());
    const user = await seedUser();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 2 });
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    const ctx = testToolContext(user.id, []);
    await callTool("start-case", { caseId: c.id, confirm: true }, ctx);
    const before = await balanceOf(customer.id);
    await expect(
      callTool("start-case", { caseId: c.id, confirm: true }, ctx),
    ).rejects.toBeDefined();
    expect(await balanceOf(customer.id)).toBe(before);
  });
});

describe("B4 Refund rules", () => {
  it("refunds NO_VIABLE_CHANNEL but not PROVIDER_REFUSED", async () => {
    setStripeOverride(new FakeStripeClient());
    setEventsOverride(new FakeEvents());
    const user = await seedUser();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 2 });
    const holder = await seedHolder(user.id);
    const ok = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      status: "CHANNEL_PLANNING",
    });
    await seedCredit(customer.id, { delta: -1, reason: "CONSUME", caseId: ok.id });
    await transition(ok.id, "FAILED", { reason: "NO_VIABLE_CHANNEL", actor: ACTOR });
    expect(await refundCount(ok.id)).toBe(1);

    const refused = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      status: "EXECUTING",
    });
    await seedCredit(customer.id, { delta: -1, reason: "CONSUME", caseId: refused.id });
    await transition(refused.id, "FAILED", { reason: "PROVIDER_REFUSED", actor: ACTOR });
    expect(await refundCount(refused.id)).toBe(0);
    expect(customer.id).toBeDefined();
  });
});

describe("B5 Withdraw", () => {
  it("issues no refund on withdraw", async () => {
    setStripeOverride(new FakeStripeClient());
    setEventsOverride(new FakeEvents());
    const user = await seedUser();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    const ctx = testToolContext(user.id, []);
    await callTool("start-case", { caseId: c.id, confirm: true }, ctx);
    await callTool("withdraw-case", { caseId: c.id, confirm: true }, ctx);
    expect(await refundCount(c.id)).toBe(0);
    const [row] = await db.select({ status: cases.status }).from(cases).where(eq(cases.id, c.id));
    expect(row?.status).toBe("WITHDRAWN");
    expect(customer.id).toBeDefined();
  });
});
