import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { accountHolders, auditLogs, caseSteps } from "~/server/db/schema";
import { type ApprovalDeps, approveStep, requestStepApproval } from "./approvals";
import {
  callerFor,
  createSmsOutbox,
  FakeValkey,
  seedCase,
  seedHolder,
  seedProvider,
  seedStep,
  seedUser,
} from "./test-support";

function extractCode(body: string): string {
  const match = /(\d{6})/.exec(body);
  if (!match?.[1]) throw new Error("no code in SMS body");
  return match[1];
}

describe("step approval", () => {
  async function setup(input: { ownerIsHolder?: boolean } = {}) {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id, { phone: "+6591234501" });
    if (input.ownerIsHolder) {
      await db
        .update(accountHolders)
        .set({ userId: user.id })
        .where(eq(accountHolders.id, holder.id));
    }
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "EXECUTING",
    });
    const step = await seedStep(c.id, { status: "PLANNED" });
    const valkey = new FakeValkey();
    const sms = createSmsOutbox();
    const deps: ApprovalDeps = { db, valkey, sms: sms.sender, now: () => new Date() };
    return { user, holder, c, step, valkey, sms, deps };
  }

  it("approves without SMS when the owner is the holder", async () => {
    const { user, step, sms, deps } = await setup({ ownerIsHolder: true });
    const caller = { userId: user.id, orgIds: [] as string[] };
    await expect(requestStepApproval({ stepId: step.id }, caller, deps)).resolves.toEqual({
      smsRequired: false,
    });
    expect(sms.messages).toHaveLength(0);
    await expect(approveStep({ stepId: step.id }, caller, deps)).resolves.toEqual({
      approved: true,
    });
    const [row] = await db.select().from(caseSteps).where(eq(caseSteps.id, step.id)).limit(1);
    expect(row?.status).toBe("AWAITING_APPROVAL");
    expect(row?.approvedByUserId).toBe(user.id);
    expect(row?.approvedAt).toBeInstanceOf(Date);
  });

  it("requires the holder SMS code when the owner is not the holder", async () => {
    const { user, step, sms, deps } = await setup();
    const caller = { userId: user.id, orgIds: [] as string[] };
    await expect(requestStepApproval({ stepId: step.id }, caller, deps)).resolves.toEqual({
      smsRequired: true,
    });
    expect(sms.messages).toHaveLength(1);
    await expect(approveStep({ stepId: step.id }, caller, deps)).rejects.toThrow("Code required");
    await expect(approveStep({ stepId: step.id, code: "000000" }, caller, deps)).rejects.toThrow(
      "Invalid code",
    );
    const code = extractCode(sms.messages[0]?.body ?? "");
    await expect(approveStep({ stepId: step.id, code }, caller, deps)).resolves.toEqual({
      approved: true,
    });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, step.id));
    expect(audits.some((row) => row.action === "STEP_APPROVED")).toBe(true);
  });

  it("rate-limits code sends through the shared OTP budget", async () => {
    const { user, step, deps } = await setup();
    const caller = { userId: user.id, orgIds: [] as string[] };
    await requestStepApproval({ stepId: step.id }, caller, deps);
    await requestStepApproval({ stepId: step.id }, caller, deps);
    await requestStepApproval({ stepId: step.id }, caller, deps);
    await expect(requestStepApproval({ stepId: step.id }, caller, deps)).rejects.toThrow(
      "Too many codes sent",
    );
  });

  it("hides another user's step behind NOT_FOUND", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(alice.id);
    const c = await seedCase({ ownerId: alice.id, holderId: holder.id, providerId: provider.id });
    const step = await seedStep(c.id, { status: "PLANNED" });
    const bobCaller = callerFor(bob.id, []);
    await expect(bobCaller.approvals.request({ stepId: step.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a step that is not awaiting approval", async () => {
    const { user, c, deps } = await setup();
    const step = await seedStep(c.id, { status: "RUNNING" });
    await expect(
      requestStepApproval({ stepId: step.id }, { userId: user.id, orgIds: [] }, deps),
    ).rejects.toThrow("Step is not awaiting approval");
  });
});
