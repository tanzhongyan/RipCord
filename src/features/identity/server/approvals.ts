import { eq } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { writeAudit } from "~/server/audit";
import type { Database } from "~/server/db";
import { db } from "~/server/db";
import { accountHolders, caseSteps, cases } from "~/server/db/schema";
import { getSecretValue } from "~/server/vault";
import { approveStepSchema, stepIdSchema } from "../schemas/approval";
import { type CallerIdentity, callerOwns, MandateError, toTRPCError } from "./mandate-flow";
import { type SmsSender, sendSms } from "./sms";
import {
  equalHex,
  OTP_MAX_ATTEMPTS,
  OTP_SENDS_PER_HOUR,
  OTP_TTL_SECONDS,
  otpSendsKey,
  randomOtp,
  sha256hex,
} from "./tokens";
import { type ValkeyClient, valkey } from "./valkey";

export interface ApprovalDeps {
  db: Database;
  valkey: ValkeyClient;
  sms: SmsSender;
  now: () => Date;
}

function liveDeps(): ApprovalDeps {
  return { db, valkey: valkey(), sms: sendSms, now: () => new Date() };
}

const approvalOtpKey = (stepId: string) => `release:otp:${stepId}`;

type StepRow = typeof caseSteps.$inferSelect;
type CaseRow = typeof cases.$inferSelect;
type HolderRow = typeof accountHolders.$inferSelect;

async function loadOwnedStep(
  conn: Database,
  stepId: string,
  caller: CallerIdentity,
): Promise<{ step: StepRow; c: CaseRow; holder: HolderRow }> {
  const [step] = await conn.select().from(caseSteps).where(eq(caseSteps.id, stepId)).limit(1);
  if (!step) throw new MandateError("NOT_FOUND", "Step not found");
  const [c] = await conn.select().from(cases).where(eq(cases.id, step.caseId)).limit(1);
  if (!c || !callerOwns(c, caller)) throw new MandateError("NOT_FOUND", "Step not found");
  const [holder] = await conn
    .select()
    .from(accountHolders)
    .where(eq(accountHolders.id, c.holderId))
    .limit(1);
  if (!holder) throw new MandateError("INTERNAL_ERROR", "Holder not found");
  return { step, c, holder };
}

/** No SMS code when the case owner is the holder themselves. */
function smsRequired(c: CaseRow, holder: HolderRow): boolean {
  return holder.userId !== c.ownerUserId;
}

interface OtpRecord {
  hash: string;
  attempts: number;
}

function parseOtpRecord(raw: string | null): OtpRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OtpRecord>;
    if (typeof parsed.hash !== "string" || typeof parsed.attempts !== "number") return null;
    return { hash: parsed.hash, attempts: parsed.attempts };
  } catch {
    return null;
  }
}

/**
 * Move a step to `AWAITING_APPROVAL`, texting an SMS code to the holder when
 * the owner is not the holder. The code reuses the mandate OTP budget: 6
 * digits, 10 minutes, 5 attempts, 3 sends per holder phone per hour.
 */
export async function requestStepApproval(
  input: { stepId: string },
  caller: CallerIdentity,
  deps: ApprovalDeps = liveDeps(),
): Promise<{ smsRequired: boolean }> {
  const { step, c, holder } = await loadOwnedStep(deps.db, input.stepId, caller);
  if (step.status !== "PLANNED" && step.status !== "AWAITING_APPROVAL") {
    throw new MandateError("VALIDATION", "Step is not awaiting approval");
  }
  if (step.status === "PLANNED") {
    await deps.db
      .update(caseSteps)
      .set({ status: "AWAITING_APPROVAL" })
      .where(eq(caseSteps.id, step.id));
  }
  if (!smsRequired(c, holder)) return { smsRequired: false };
  const sends = await deps.valkey.incr(otpSendsKey(holder.id));
  if (sends === 1) await deps.valkey.expire(otpSendsKey(holder.id), 3600);
  if (sends > OTP_SENDS_PER_HOUR) {
    throw new MandateError("RATE_LIMITED", "Too many codes sent. Try again later.");
  }
  const code = randomOtp();
  await deps.valkey.set(
    approvalOtpKey(step.id),
    JSON.stringify({ hash: sha256hex(code), attempts: 0 }),
    "EX",
    OTP_TTL_SECONDS,
  );
  const phone = await getSecretValue(deps.db, holder.phoneSecretId);
  try {
    await deps.sms(phone, `Your RipCord approval code is: ${code}`);
  } catch {
    throw new MandateError("INTERNAL_ERROR", "Could not send code");
  }
  return { smsRequired: true };
}

/**
 * The owner's tap on the case page. When the owner is not the holder, the SMS
 * code the holder received must come with it. Approval covers one step only:
 * it stamps `approved_at` on this step, which `resolveTokens` reads.
 */
export async function approveStep(
  input: { stepId: string; code?: string },
  caller: CallerIdentity,
  deps: ApprovalDeps = liveDeps(),
): Promise<{ approved: true }> {
  const { step, c, holder } = await loadOwnedStep(deps.db, input.stepId, caller);
  if (step.status !== "AWAITING_APPROVAL") {
    throw new MandateError("VALIDATION", "Step is not awaiting approval");
  }
  if (smsRequired(c, holder)) {
    if (!input.code) throw new MandateError("VALIDATION", "Code required");
    const record = parseOtpRecord(await deps.valkey.get(approvalOtpKey(step.id)));
    if (!record) throw new MandateError("VALIDATION", "Code has expired. Request a new one.");
    if (!equalHex(sha256hex(input.code), record.hash)) {
      const attempts = record.attempts + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await deps.valkey.del(approvalOtpKey(step.id));
        throw new MandateError("VALIDATION", "Too many wrong codes. Request a new one.");
      }
      await deps.valkey.set(
        approvalOtpKey(step.id),
        JSON.stringify({ hash: record.hash, attempts }),
        "EX",
        OTP_TTL_SECONDS,
      );
      throw new MandateError("VALIDATION", "Invalid code");
    }
    await deps.valkey.del(approvalOtpKey(step.id));
  }
  await deps.db
    .update(caseSteps)
    .set({ approvedByUserId: caller.userId, approvedAt: deps.now() })
    .where(eq(caseSteps.id, step.id));
  await writeAudit(deps.db, {
    actorType: "USER",
    actorId: caller.userId,
    action: "STEP_APPROVED",
    targetType: "case_step",
    targetId: step.id,
    caseId: c.id,
    metadata: {},
  });
  return { approved: true };
}

export const approvalsRouter = createTRPCRouter({
  request: protectedProcedure.input(stepIdSchema).mutation(async ({ ctx, input }) => {
    try {
      return await requestStepApproval(input, { userId: ctx.userId, orgIds: ctx.orgIds });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  approve: protectedProcedure.input(approveStepSchema).mutation(async ({ ctx, input }) => {
    try {
      return await approveStep(input, { userId: ctx.userId, orgIds: ctx.orgIds });
    } catch (error) {
      throw toTRPCError(error);
    }
  }),
});
