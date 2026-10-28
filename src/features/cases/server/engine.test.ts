import { and, count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import {
  auditLogs,
  cases,
  creditLedger,
  mandates,
  receipts,
  verifications,
} from "~/server/db/schema";
import { isTerminalStatus, transition } from "./engine";
import { setEventsOverride } from "./events";
import {
  FakeEvents,
  seedAccountSecret,
  seedBillingCustomer,
  seedCase,
  seedCredit,
  seedHolder,
  seedMandate,
  seedProvider,
  seedStep,
  seedTerms,
  seedUser,
} from "./test-support";

const ACTOR = { type: "USER" as const, id: "user-1" };

async function setup(status: typeof cases.$inferInsert.status = "DRAFT") {
  const user = await seedUser();
  const provider = await seedProvider();
  const holder = await seedHolder(user.id);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    status,
  });
  return { user, provider, holder, c };
}

async function caseStatus(caseId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: cases.status })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  return row?.status;
}

async function consumeCount(caseId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(creditLedger)
    .where(and(eq(creditLedger.caseId, caseId), eq(creditLedger.reason, "CONSUME")));
  return row?.n ?? 0;
}

async function refundCount(caseId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(creditLedger)
    .where(and(eq(creditLedger.caseId, caseId), eq(creditLedger.reason, "REFUND")));
  return row?.n ?? 0;
}

afterEach(() => {
  setEventsOverride(null);
});

describe("B5 Illegal transition", () => {
  it("refuses DRAFT to EXECUTING and leaves the status", async () => {
    const { c } = await setup("DRAFT");
    await expect(transition(c.id, "EXECUTING", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(await caseStatus(c.id)).toBe("DRAFT");
  });
});

describe("credit guard", () => {
  it("consumes one credit on DRAFT to DISCOVERY", async () => {
    const { user, c } = await setup("DRAFT");
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 2 });
    await transition(c.id, "DISCOVERY", { actor: ACTOR });
    expect(await caseStatus(c.id)).toBe("DISCOVERY");
    expect(await consumeCount(c.id)).toBe(1);
    await expect(transition(c.id, "DISCOVERY", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(await consumeCount(c.id)).toBe(1);
  });

  it("refuses without credit and leaves DRAFT", async () => {
    const { c } = await setup("DRAFT");
    await expect(transition(c.id, "DISCOVERY", { actor: ACTOR })).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
    expect(await caseStatus(c.id)).toBe("DRAFT");
  });
});

describe("lifecycle guards", () => {
  it("needs provider and service for DISCOVERY to PRE_FLIGHT_AUDIT", async () => {
    const { c } = await setup("DISCOVERY");
    await db.update(cases).set({ providerId: null, serviceType: null }).where(eq(cases.id, c.id));
    await expect(transition(c.id, "PRE_FLIGHT_AUDIT", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    const provider = await seedProvider();
    await db
      .update(cases)
      .set({ providerId: provider.id, serviceType: "MOBILE_POSTPAID" })
      .where(eq(cases.id, c.id));
    await transition(c.id, "PRE_FLIGHT_AUDIT", { actor: ACTOR });
    expect(await caseStatus(c.id)).toBe("PRE_FLIGHT_AUDIT");
  });

  it("needs terms for PRE_FLIGHT_AUDIT to AWAITING_MANDATE", async () => {
    const { c } = await setup("PRE_FLIGHT_AUDIT");
    await expect(transition(c.id, "AWAITING_MANDATE", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    await seedTerms(c.id);
    await transition(c.id, "AWAITING_MANDATE", { actor: ACTOR });
    expect(await caseStatus(c.id)).toBe("AWAITING_MANDATE");
  });

  it("needs an active mandate for AWAITING_MANDATE to CHANNEL_PLANNING", async () => {
    const { provider, holder, c } = await setup("AWAITING_MANDATE");
    const secret = await seedAccountSecret(holder.id);
    await seedMandate({
      caseId: c.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceSecretId: secret.id,
      status: "PENDING",
    });
    await expect(transition(c.id, "CHANNEL_PLANNING", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    await db
      .update(mandates)
      .set({ status: "ACTIVE" })
      .where(and(eq(mandates.caseId, c.id), eq(mandates.status, "PENDING")));
    await transition(c.id, "CHANNEL_PLANNING", { actor: ACTOR });
    expect(await caseStatus(c.id)).toBe("CHANNEL_PLANNING");
  });

  it("needs a saved plan for CHANNEL_PLANNING to EXECUTING", async () => {
    const { c } = await setup("CHANNEL_PLANNING");
    await expect(transition(c.id, "EXECUTING", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    const provider = await seedProvider();
    const { seedChannel } = await import("./test-support");
    const channel = await seedChannel(provider.id);
    await db.update(cases).set({ chosenChannelId: channel.id }).where(eq(cases.id, c.id));
    await seedStep(c.id);
    await transition(c.id, "EXECUTING", { actor: ACTOR });
    const [row] = await db
      .select({ status: cases.status, phase: cases.executionPhase })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(row?.status).toBe("EXECUTING");
    expect(row?.phase).toBe("CONTACTING");
  });

  it("consumes the mandate on RECEIPT_ACQUISITION to AWAITING_VERIFICATION", async () => {
    const { provider, holder, c } = await setup("RECEIPT_ACQUISITION");
    await expect(transition(c.id, "AWAITING_VERIFICATION", { actor: ACTOR })).rejects.toMatchObject(
      {
        code: "ILLEGAL_TRANSITION",
      },
    );
    const secret = await seedAccountSecret(holder.id);
    await seedMandate({
      caseId: c.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceSecretId: secret.id,
      status: "ACTIVE",
    });
    await db.insert(receipts).values({
      caseId: c.id,
      referenceCode: "RC-1",
      effectiveDate: "2026-11-01",
    });
    await transition(c.id, "AWAITING_VERIFICATION", { actor: ACTOR });
    const [mandate] = await db
      .select({ status: mandates.status })
      .from(mandates)
      .where(eq(mandates.caseId, c.id))
      .limit(1);
    expect(mandate?.status).toBe("CONSUMED");
  });

  it("succeeds on NO_REBILL and disputes on REBILLED", async () => {
    const first = await setup("AWAITING_VERIFICATION");
    await expect(transition(first.c.id, "SUCCEEDED", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    await db.insert(verifications).values({
      caseId: first.c.id,
      dueAt: new Date(),
      result: "NO_REBILL",
      resolvedAt: new Date(),
    });
    await transition(first.c.id, "SUCCEEDED", { actor: ACTOR });
    const [done] = await db
      .select({ status: cases.status, closedAt: cases.closedAt })
      .from(cases)
      .where(eq(cases.id, first.c.id))
      .limit(1);
    expect(done?.status).toBe("SUCCEEDED");
    expect(done?.closedAt).not.toBeNull();
    expect(isTerminalStatus("SUCCEEDED")).toBe(true);

    const second = await setup("AWAITING_VERIFICATION");
    await db.insert(verifications).values({
      caseId: second.c.id,
      dueAt: new Date(),
      result: "REBILLED",
      resolvedAt: new Date(),
    });
    await transition(second.c.id, "DISPUTED", { actor: ACTOR });
    expect(await caseStatus(second.c.id)).toBe("DISPUTED");
  });
});

describe("failure paths", () => {
  it("refunds PROVIDER_UNSUPPORTED but not MANDATE_EXPIRED", async () => {
    const { user, c } = await setup("DISCOVERY");
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    await seedCredit(customer.id, { delta: -1, reason: "CONSUME", caseId: c.id });
    await transition(c.id, "FAILED", { reason: "PROVIDER_UNSUPPORTED", actor: ACTOR });
    expect(await refundCount(c.id)).toBe(1);

    const expired = await setup("AWAITING_MANDATE");
    await transition(expired.c.id, "FAILED", { reason: "MANDATE_EXPIRED", actor: ACTOR });
    expect(await refundCount(expired.c.id)).toBe(0);
  });

  it("fails any non-terminal case on mandate revocation without refund", async () => {
    const { c } = await setup("EXECUTING");
    await transition(c.id, "FAILED", { reason: "MANDATE_REVOKED", actor: ACTOR });
    expect(await caseStatus(c.id)).toBe("FAILED");
    expect(await refundCount(c.id)).toBe(0);
  });

  it("rejects a wrong failure reason and a missing one", async () => {
    const { c } = await setup("DISCOVERY");
    await expect(
      transition(c.id, "FAILED", { reason: "TIMEOUT", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(transition(c.id, "FAILED", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(await caseStatus(c.id)).toBe("DISCOVERY");
  });

  it("withdraws from non-terminal only", async () => {
    const { c } = await setup("DRAFT");
    await transition(c.id, "WITHDRAWN", { actor: ACTOR });
    expect(await caseStatus(c.id)).toBe("WITHDRAWN");
    await expect(transition(c.id, "DISCOVERY", { actor: ACTOR })).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
  });

  it("answers NOT_FOUND for a missing case", async () => {
    await expect(
      transition("00000000-0000-0000-0000-000000000000", "DISCOVERY", { actor: ACTOR }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("audit and events", () => {
  it("writes one audit row and publishes the move", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    const { user, c } = await setup("DRAFT");
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    await transition(c.id, "DISCOVERY", { actor: ACTOR });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.caseId, c.id), eq(auditLogs.action, "CASE_TRANSITION")))
      .limit(1);
    expect(audit?.metadata).toMatchObject({ from: "DRAFT", to: "DISCOVERY" });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]?.channel).toBe(`case:${c.id}`);
    expect(JSON.parse(events.published[0]?.message ?? "{}")).toMatchObject({
      caseId: c.id,
      from: "DRAFT",
      to: "DISCOVERY",
    });
  });
});
