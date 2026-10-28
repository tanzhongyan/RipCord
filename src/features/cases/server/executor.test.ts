import { eq } from "drizzle-orm";
import { extractText } from "unpdf";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import {
  accountHolders,
  caseSteps,
  cases,
  communications,
  vaultReleases,
} from "~/server/db/schema";
import { setFakeResponses } from "~/server/model/fake";
import { setTelephonyOverride } from "~/server/telephony";
import { secretToken, storeSecret } from "~/server/vault";
import { setEventsOverride } from "./events";
import { runNextStep } from "./executor";
import { setMailOverride } from "./mailer";
import { setLiveModeOverride } from "./sandbox";
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
  testToolContext,
} from "./test-support";
import { callTool } from "./tools/registry";

afterEach(() => {
  setMailOverride(null);
  setEventsOverride(null);
  setFakeResponses([]);
  setLiveModeOverride(null);
  setTelephonyOverride(null);
});

async function setupEmailCase(address = "cancel@demo-telco.test") {
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
    address,
    requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
    noticeDays: 30,
  });
  await seedTerms(c.id, { noticeDays: 30 });
  const loa = await seedLoaDocument(c.id, {
    fullName: secretToken("FULL_NAME", fullName.id),
    nric: secretToken("NRIC", nric.id),
    accountNo: secretToken("ACCOUNT_NO", account.id),
  });
  const mandate = await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: account.id,
    status: "ACTIVE",
    loaDocumentId: loa.id,
  });
  return { user, provider, holder, c, channel, mandate };
}

async function sendStepFor(caseId: string) {
  const rows = await db.select().from(caseSteps).where(eq(caseSteps.caseId, caseId));
  const send = rows.find((row) => row.tool === "send-notice-email");
  if (!send) throw new Error("send-notice-email step missing");
  return send;
}

describe("B1 Sandbox email", () => {
  it("sends the notice with a resolved LOA and stores tokens only", async () => {
    const mail = new FakeMailTransport();
    setMailOverride(mail);
    setEventsOverride(new FakeEvents());
    const { user, c, channel } = await setupEmailCase();
    await seedStep(c.id, {
      seq: 1,
      tool: "execute-channel",
      args: { providerChannelId: channel.id, kind: "EMAIL" },
      status: "PLANNED",
      requiresApproval: true,
    });

    expect(await runNextStep(c.id)).toMatchObject({ status: "waiting_approval" });
    const send = await sendStepFor(c.id);
    expect(send.status).toBe("AWAITING_APPROVAL");
    const approved = await callTool(
      "approve-step",
      { caseId: c.id, stepId: send.id, confirm: true },
      testToolContext(user.id, []),
    );
    expect(approved).toEqual({ approved: true });

    expect(mail.sent).toHaveLength(1);
    const msg = mail.sent[0];
    if (!msg) throw new Error("no mail sent");
    expect(msg.to).toBe("cancel@demo-telco.test");
    expect(msg.cc).toBe("dad@example.com");
    expect(msg.replyTo).toBe("dad@example.com");
    expect(msg.subject).toBe("Termination request – account DT-88231-004");
    expect(msg.text).toContain("Demo Dad");
    expect(msg.text).toContain("DT-88231-004");
    expect(msg.text).not.toContain("{{vault:");
    expect(msg.attachments).toHaveLength(1);
    const attachment = msg.attachments[0];
    if (!attachment) throw new Error("LOA attachment missing");
    expect(attachment.filename).toBe("letter-of-authorisation.pdf");
    const { text: loaText } = await extractText(new Uint8Array(attachment.content), {
      mergePages: true,
    });
    expect(loaText).toContain("Demo Dad");
    expect(loaText).toContain("DT-88231-004");
    expect(loaText).not.toContain("{{vault:");

    const comms = await db.select().from(communications).where(eq(communications.caseId, c.id));
    expect(comms).toHaveLength(1);
    expect(comms[0]?.channel).toBe("EMAIL");
    expect(comms[0]?.direction).toBe("OUTBOUND");
    expect(comms[0]?.body).toContain("{{vault:ACCOUNT_NO:");
    expect(comms[0]?.body).toContain("{{vault:FULL_NAME:");
    expect(comms[0]?.body).not.toContain("DT-88231-004");
    expect(comms[0]?.body).not.toContain("Demo Dad");
    expect(comms[0]?.externalRef).toBe("<fake-1@ripcord.test>");

    // One row each time a value leaves the vault: name and account in the
    // body, name, NRIC and account in the attached letter.
    const releases = await db
      .select({ secretId: vaultReleases.secretId })
      .from(vaultReleases)
      .where(eq(vaultReleases.caseId, c.id));
    expect(releases).toHaveLength(5);

    const rows = await db.select().from(caseSteps).where(eq(caseSteps.caseId, c.id));
    expect(rows.find((row) => row.tool === "send-notice-email")?.status).toBe("SUCCEEDED");
    expect(rows.find((row) => row.tool === "await-provider-reply")?.status).toBe("RUNNING");
  });
});

describe("B2 Sandbox blocks real addresses", () => {
  it("fails with SANDBOX_DESTINATION_BLOCKED and sends nothing", async () => {
    const mail = new FakeMailTransport();
    setMailOverride(mail);
    setEventsOverride(new FakeEvents());
    const { user, c, channel } = await setupEmailCase("cancel@singtel.com");
    await seedStep(c.id, {
      seq: 1,
      tool: "execute-channel",
      args: { providerChannelId: channel.id, kind: "EMAIL" },
      status: "PLANNED",
      requiresApproval: true,
    });

    await runNextStep(c.id);
    const send = await sendStepFor(c.id);
    await callTool(
      "approve-step",
      { caseId: c.id, stepId: send.id, confirm: true },
      testToolContext(user.id, []),
    );

    const [failed] = await db
      .select({ status: caseSteps.status, result: caseSteps.result })
      .from(caseSteps)
      .where(eq(caseSteps.id, send.id))
      .limit(1);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.result).toMatchObject({ code: "SANDBOX_DESTINATION_BLOCKED" });
    expect(mail.sent).toHaveLength(0);
    const comms = await db
      .select({ id: communications.id })
      .from(communications)
      .where(eq(communications.caseId, c.id));
    expect(comms).toHaveLength(0);
  });
});

describe("B4 Approval", () => {
  it("waits in AWAITING_APPROVAL and sends nothing until approve-step succeeds", async () => {
    const mail = new FakeMailTransport();
    setMailOverride(mail);
    setEventsOverride(new FakeEvents());
    const { user, c, channel } = await setupEmailCase();
    await seedStep(c.id, {
      seq: 1,
      tool: "execute-channel",
      args: { providerChannelId: channel.id, kind: "EMAIL" },
      status: "PLANNED",
      requiresApproval: true,
    });

    const parked = await runNextStep(c.id);
    expect(parked.status).toBe("waiting_approval");
    const send = await sendStepFor(c.id);
    expect(parked.stepId).toBe(send.id);
    expect(send.status).toBe("AWAITING_APPROVAL");
    expect(mail.sent).toHaveLength(0);
    const rows = await db.select().from(caseSteps).where(eq(caseSteps.caseId, c.id));
    expect(rows.find((row) => row.tool === "execute-channel")?.status).toBe("SKIPPED");
    expect(rows.find((row) => row.tool === "execute-channel")?.result).toMatchObject({
      expanded: true,
      into: ["send-notice-email", "await-provider-reply"],
    });

    await callTool(
      "approve-step",
      { caseId: c.id, stepId: send.id, confirm: true },
      testToolContext(user.id, []),
    );
    expect(mail.sent).toHaveLength(1);
    const [done] = await db
      .select({ status: caseSteps.status })
      .from(caseSteps)
      .where(eq(caseSteps.id, send.id))
      .limit(1);
    expect(done?.status).toBe("SUCCEEDED");
  });
});

describe("executor mandate recheck", () => {
  it("fails an approved step when no mandate is active", async () => {
    setEventsOverride(new FakeEvents());
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    await seedAccountSecret(holder.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "EXECUTING",
    });
    const channel = await seedChannel(provider.id, { kind: "EMAIL", serviceType: null });
    const step = await seedStep(c.id, {
      seq: 1,
      tool: "send-notice-email",
      args: { providerChannelId: channel.id, kind: "EMAIL" },
      status: "AWAITING_APPROVAL",
      requiresApproval: true,
      approvedAt: new Date(),
      approvedByUserId: user.id,
    });

    const outcome = await runNextStep(c.id);

    expect(outcome.status).toBe("failed");
    const [failed] = await db
      .select({ status: caseSteps.status, result: caseSteps.result })
      .from(caseSteps)
      .where(eq(caseSteps.id, step.id))
      .limit(1);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.result).toMatchObject({ code: "VAULT_RELEASE_DENIED" });
  });

  it("returns idle outside EXECUTING", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    expect(await runNextStep(c.id)).toEqual({ status: "idle" });
    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(row?.status).toBe("DRAFT");
  });
});
