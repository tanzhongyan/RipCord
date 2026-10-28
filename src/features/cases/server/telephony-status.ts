import { desc, eq } from "drizzle-orm";

import { type ValkeyClient, valkey } from "~/features/identity";
import { db } from "~/server/db";
import { caseSteps, communications } from "~/server/db/schema";
import { holderLegKey } from "~/server/telephony";
import { caseChannel, caseEvents } from "./events";
import { handleStepFailure } from "./executor";

/** Terminal leg statuses: the call will send no more updates. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);

export interface TwilioStatusDeps {
  valkey?: ValkeyClient;
}

async function stepForCallSid(callSid: string) {
  const [comm] = await db
    .select({ caseId: communications.caseId, stepId: communications.stepId })
    .from(communications)
    .where(eq(communications.externalRef, callSid))
    .orderBy(desc(communications.occurredAt))
    .limit(1);
  if (!comm?.stepId) return null;
  const [step] = await db.select().from(caseSteps).where(eq(caseSteps.id, comm.stepId)).limit(1);
  if (!step || step.caseId !== comm.caseId) return null;
  return { caseId: comm.caseId, step };
}

/**
 * Route a verified Twilio status callback: holder-leg answers publish
 * `holder_joined`; provider-leg updates publish `step` events, and a
 * terminal status on a still-`RUNNING` step fails it (the worker normally
 * settles first, so this is the missed-call backstop).
 */
export async function handleTwilioStatus(
  params: { CallSid?: string; CallStatus?: string },
  deps: TwilioStatusDeps = {},
): Promise<Record<string, unknown>> {
  const callSid = params.CallSid;
  const callStatus = params.CallStatus ?? "";
  if (!callSid) return { ok: true };
  const store = deps.valkey ?? valkey();

  const holderLeg = await store.get(holderLegKey(callSid));
  if (holderLeg) {
    let providerCallSid = "";
    try {
      providerCallSid = (JSON.parse(holderLeg) as { providerCallSid?: unknown })
        .providerCallSid as string;
    } catch {
      return { ok: true };
    }
    if (callStatus === "in-progress" || callStatus === "answered") {
      const target = await stepForCallSid(providerCallSid);
      if (target) {
        await caseEvents().publish(
          caseChannel(target.caseId),
          JSON.stringify({
            type: "holder_joined",
            caseId: target.caseId,
            stepId: target.step.id,
            callId: providerCallSid,
          }),
        );
      }
    }
    return { ok: true, leg: "holder" };
  }

  const target = await stepForCallSid(callSid);
  if (!target) return { ok: true, unknown: true };
  await caseEvents().publish(
    caseChannel(target.caseId),
    JSON.stringify({
      type: "step",
      caseId: target.caseId,
      stepId: target.step.id,
      callStatus: callStatus || "unknown",
    }),
  );
  if (TERMINAL_STATUSES.has(callStatus) && target.step.status === "RUNNING") {
    await handleStepFailure(
      target.caseId,
      target.step.id,
      "VALIDATION",
      `The call ended (${callStatus})`,
      { type: "SYSTEM", id: "twilio-status" },
      { replan: "if-fresh" },
    );
  }
  return { ok: true };
}
