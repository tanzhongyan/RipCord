import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { accountHolders, caseSteps, cases, verifications } from "~/server/db/schema";
import { secretToken, storeSecret } from "~/server/vault";
import { setEventsOverride } from "./events";
import { setMailOverride } from "./mailer";
import {
  FakeEvents,
  FakeMailTransport,
  seedAccountSecret,
  seedCase,
  seedChannel,
  seedHolder,
  seedLoaDocument,
  seedMandate,
  seedProvider,
  seedStep,
  seedTerms,
  seedUser,
} from "./test-support";

afterEach(() => {
  setMailOverride(null);
  setEventsOverride(null);
});

function callerFor(userId: string) {
  return createCaller({ db, userId, orgIds: [], ownerId: userId, headers: new Headers() });
}

/** EXECUTING case with an active mandate and everything a notice send needs. */
async function setupEmailCase() {
  const user = await seedUser();
  const provider = await seedProvider({ name: "Demo Telco" });
  const holder = await seedHolder(user.id);
  // Self-service holder: the owner approves without an SMS code.
  await db.update(accountHolders).set({ userId: user.id }).where(eq(accountHolders.id, holder.id));
  const fullName = await storeSecret(db, {
    holderId: holder.id,
    kind: "FULL_NAME",
    value: "Demo Dad",
  });
  await storeSecret(db, { holderId: holder.id, kind: "EMAIL", value: "dad@example.com" });
  const nric = await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: "S1234567D" });
  const account = await seedAccountSecret(holder.id, "DT-88231-004");
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceType: "MOBILE_POSTPAID",
    status: "EXECUTING",
  });
  const channel = await seedChannel(provider.id, {
    kind: "EMAIL",
    serviceType: null,
    address: "cancel@demo-telco.test",
    requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
    noticeDays: 30,
  });
  await seedTerms(c.id, { noticeDays: 30 });
  const loa = await seedLoaDocument(c.id, {
    fullName: secretToken("FULL_NAME", fullName.id),
    nric: secretToken("NRIC", nric.id),
    accountNo: secretToken("ACCOUNT_NO", account.id),
  });
  await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: account.id,
    status: "ACTIVE",
    loaDocumentId: loa.id,
  });
  return { user, c, channel };
}

describe("F2 cases.approveStep", () => {
  it("approves and runs the awaiting step", async () => {
    const mail = new FakeMailTransport();
    setMailOverride(mail);
    setEventsOverride(new FakeEvents());
    const { user, c, channel } = await setupEmailCase();
    const step = await seedStep(c.id, {
      seq: 1,
      tool: "send-notice-email",
      args: { providerChannelId: channel.id, kind: "EMAIL" },
      status: "AWAITING_APPROVAL",
      requiresApproval: true,
    });
    await callerFor(user.id).cases.approveStep({ caseId: c.id, stepId: step.id });
    const [done] = await db
      .select({ status: caseSteps.status })
      .from(caseSteps)
      .where(eq(caseSteps.id, step.id))
      .limit(1);
    expect(done?.status).toBe("SUCCEEDED");
    expect(mail.sent).toHaveLength(1);
  });
});

describe("F4 case page sections", () => {
  async function setupPlainCase(status: "EXECUTING" = "EXECUTING") {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceType: "MOBILE_POSTPAID",
      status,
    });
    return { user, c };
  }

  it("timeline lists the case transitions", async () => {
    setEventsOverride(new FakeEvents());
    const { user, c } = await setupPlainCase();
    await callerFor(user.id).cases.withdraw({ caseId: c.id });
    const rows = await callerFor(user.id).cases.timeline({ caseId: c.id });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((row) => row.action)).toContain("CASE_TRANSITION");
  });

  it("documents lists stored artifacts", async () => {
    const { user, c } = await setupPlainCase();
    const loa = await seedLoaDocument(c.id, {
      fullName: "F4 Name",
      nric: "S0000000A",
      accountNo: "ACC-F4",
    });
    const rows = await callerFor(user.id).cases.documents({ caseId: c.id });
    expect(rows.map((row) => row.id)).toContain(loa.id);
    expect(rows.find((row) => row.id === loa.id)?.kind).toBe("LOA");
  });

  it("verification returns the pending check and null when absent", async () => {
    const { user, c } = await setupPlainCase();
    await expect(callerFor(user.id).cases.verification({ caseId: c.id })).resolves.toBeNull();
    const dueAt = new Date(Date.now() + 86_400_000);
    await db.insert(verifications).values({ caseId: c.id, dueAt });
    const row = await callerFor(user.id).cases.verification({ caseId: c.id });
    expect(row?.result).toBeNull();
    expect(row?.dueAt.getTime()).toBe(dueAt.getTime());
  });

  it("rejects section queries for cases the caller does not own", async () => {
    const { c } = await setupPlainCase();
    const stranger = await seedUser();
    await expect(callerFor(stranger.id).cases.timeline({ caseId: c.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("F3 cases.withdraw", () => {
  it("moves a non-terminal case to WITHDRAWN", async () => {
    setEventsOverride(new FakeEvents());
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceType: "MOBILE_POSTPAID",
      status: "EXECUTING",
    });
    const out = await callerFor(user.id).cases.withdraw({ caseId: c.id });
    expect(out).toMatchObject({ caseId: c.id, status: "WITHDRAWN" });
    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(row?.status).toBe("WITHDRAWN");
  });
});
