import { and, count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { caseSteps, cases, channelOutcomeStats, creditLedger } from "~/server/db/schema";
import { setEventsOverride } from "./events";
import { EXECUTE_CHANNEL_TOOL, planChannel, replanAfterFailure } from "./planner";
import {
  FakeEvents,
  seedAccountSecret,
  seedBillingCustomer,
  seedCase,
  seedChannel,
  seedCredit,
  seedHolder,
  seedProvider,
  seedUser,
} from "./test-support";

const ACTOR = { type: "USER" as const, id: "user-1" };

async function setupPlanning() {
  const user = await seedUser();
  const provider = await seedProvider({ name: "Demo Telco" });
  const holder = await seedHolder(user.id);
  await seedAccountSecret(holder.id);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceType: "MOBILE_POSTPAID",
    status: "CHANNEL_PLANNING",
  });
  return { user, provider, holder, c };
}

async function stepsFor(caseId: string) {
  return db.select().from(caseSteps).where(eq(caseSteps.caseId, caseId)).orderBy(caseSteps.seq);
}

afterEach(() => {
  setEventsOverride(null);
});

describe("B9 Planner", () => {
  it("saves the EMAIL steps first when no channel has stats", async () => {
    const { provider, c } = await setupPlanning();
    const email = await seedChannel(provider.id, {
      kind: "EMAIL",
      serviceType: null,
      address: "cancel@demo-telco.test",
      requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
    });
    await seedChannel(provider.id, {
      kind: "PHONE_IVR",
      serviceType: null,
      address: "+15005550006",
      requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
    });
    const events = new FakeEvents();
    setEventsOverride(events);

    const outcome = await planChannel(c.id, ACTOR);

    expect(outcome).toEqual({ planned: true, channelId: email.id, kind: "EMAIL" });
    const steps = await stepsFor(c.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.tool).toBe(EXECUTE_CHANNEL_TOOL);
    expect(steps[0]?.args).toMatchObject({ providerChannelId: email.id, kind: "EMAIL" });
    expect(steps[0]?.requiresApproval).toBe(true);
    const [updated] = await db
      .select({ status: cases.status, chosen: cases.chosenChannelId })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(updated?.status).toBe("EXECUTING");
    expect(updated?.chosen).toBe(email.id);
    expect(events.published.map((event) => event.channel)).toContain(`case:${c.id}`);
  });
});

describe("B10 Fallback", () => {
  it("re-plans onto the next channel without consuming another credit", async () => {
    const { user, provider, c } = await setupPlanning();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    await seedCredit(customer.id, { delta: -1, reason: "CONSUME", caseId: c.id });
    const email = await seedChannel(provider.id, { kind: "EMAIL", serviceType: null });
    const phone = await seedChannel(provider.id, {
      kind: "PHONE_IVR",
      serviceType: null,
      address: "+15005550006",
    });
    await planChannel(c.id, ACTOR);

    const outcome = await replanAfterFailure(c.id, email.id, ACTOR);

    expect(outcome).toEqual({ planned: true, channelId: phone.id, kind: "PHONE_IVR" });
    const steps = await stepsFor(c.id);
    expect(steps.map((step) => (step.args as { kind?: string }).kind)).toEqual([
      "EMAIL",
      "PHONE_IVR",
    ]);
    expect(steps[0]?.status).toBe("SKIPPED");
    const [updated] = await db
      .select({ status: cases.status, chosen: cases.chosenChannelId })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(updated?.status).toBe("EXECUTING");
    expect(updated?.chosen).toBe(phone.id);
    const [consumed] = await db
      .select({ n: count() })
      .from(creditLedger)
      .where(and(eq(creditLedger.caseId, c.id), eq(creditLedger.reason, "CONSUME")));
    expect(consumed?.n).toBe(1);
  });
});

describe("planner ranking", () => {
  it("prefers the higher success rate over kind order", async () => {
    const { provider, c } = await setupPlanning();
    const email = await seedChannel(provider.id, { kind: "EMAIL", serviceType: null });
    const phone = await seedChannel(provider.id, {
      kind: "PHONE_IVR",
      serviceType: null,
      address: "+15005550006",
    });
    await db.insert(channelOutcomeStats).values([
      { providerChannelId: email.id, attempts: 10, successes: 0, medianMinutes: 5 },
      { providerChannelId: phone.id, attempts: 10, successes: 9, medianMinutes: 60 },
    ]);
    const outcome = await planChannel(c.id, ACTOR);
    expect(outcome).toEqual({ planned: true, channelId: phone.id, kind: "PHONE_IVR" });
  });

  it("skips channels whose documents are missing", async () => {
    const { provider, c } = await setupPlanning();
    await seedChannel(provider.id, {
      kind: "EMAIL",
      serviceType: null,
      requiredDocuments: ["BILL"],
    });
    const phone = await seedChannel(provider.id, {
      kind: "PHONE_IVR",
      serviceType: null,
      address: "+15005550006",
    });
    const outcome = await planChannel(c.id, ACTOR);
    expect(outcome).toEqual({ planned: true, channelId: phone.id, kind: "PHONE_IVR" });
  });

  it("fails with NO_VIABLE_CHANNEL and refunds when nothing qualifies", async () => {
    const { user, provider, c } = await setupPlanning();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    await seedCredit(customer.id, { delta: -1, reason: "CONSUME", caseId: c.id });
    await seedChannel(provider.id, {
      kind: "EMAIL",
      serviceType: null,
      isVerifiedDestination: false,
    });

    const outcome = await planChannel(c.id, ACTOR);

    expect(outcome).toEqual({ planned: false, reason: "NO_VIABLE_CHANNEL" });
    const [failed] = await db
      .select({ status: cases.status, reason: cases.failureReason })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.reason).toBe("NO_VIABLE_CHANNEL");
    const [refunded] = await db
      .select({ n: count() })
      .from(creditLedger)
      .where(and(eq(creditLedger.caseId, c.id), eq(creditLedger.reason, "REFUND")));
    expect(refunded?.n).toBe(1);
  });
});
