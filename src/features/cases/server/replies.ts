import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "~/server/db";
import { caseSteps, cases, communications } from "~/server/db/schema";
import { type CallOverrides, complete, completeJson } from "~/server/model/adapter";
import { redact } from "~/server/vault";
import { type TransitionActor, transition } from "./engine";
import { ToolError } from "./errors";
import { caseChannel, caseEvents } from "./events";
import { replanAfterFailure } from "./planner";

const ReplyExtractionSchema = z.object({
  reference_code: z.string().max(80).nullable().default(null),
  effective_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  final_bill_estimate_cents: z.number().int().min(0).nullable().default(null),
  outcome: z.enum(["CONFIRMED", "NEEDS_MORE_INFO", "REFUSED"]),
  requested_items: z.array(z.string().max(500)).max(20).default([]),
});

export type ReplyExtraction = z.infer<typeof ReplyExtractionSchema>;

const EXTRACT_SYSTEM =
  "Read a provider's reply to a service termination request and extract the outcome. " +
  "CONFIRMED means the provider accepted the termination. " +
  "NEEDS_MORE_INFO means the provider asks for more information or another step. " +
  "REFUSED means the provider will not terminate. " +
  "List everything the provider asks for in requested_items, quoting briefly.";

const DRAFT_FOLLOW_UP_SYSTEM =
  "Draft one short email reply to a provider about a service termination request. " +
  "Answer what the provider asked for, restate the termination request politely, and " +
  "ask for the termination reference number and effective date. " +
  "Keep placeholders like {{vault:...}} exactly as they are. Reply with the draft only.";

export interface ReplyDeps {
  model?: CallOverrides;
  now?: () => Date;
}

export interface ReplyProposal {
  referenceCode: string | null;
  effectiveDate: string | null;
  finalBillEstimateCents: number | null;
}

export type ReplyAction = "confirm-receipt" | "approve-draft" | "replanned";

export interface ProcessReplyResult {
  outcome: ReplyExtraction["outcome"];
  requestedItems: string[];
  proposal: ReplyProposal | null;
  action: ReplyAction;
}

/** A reply that demands a phone call is a channel switch, not a question. */
const CALL_SIGNAL_RE = /\b(call|phone|ring)\b/i;

function stepChannelId(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const id = (args as Record<string, unknown>).providerChannelId;
  return typeof id === "string" ? id : null;
}

function proposalOf(extraction: ReplyExtraction): ReplyProposal {
  return {
    referenceCode: extraction.reference_code,
    effectiveDate: extraction.effective_date,
    finalBillEstimateCents: extraction.final_bill_estimate_cents,
  };
}

async function publishStepEvent(caseId: string, stepId: string, status: string): Promise<void> {
  await caseEvents().publish(
    caseChannel(caseId),
    JSON.stringify({ type: "step", caseId, stepId, status }),
  );
}

/**
 * Read one provider reply: email text the user pasted, or a finished call's
 * transcript. The text is redacted, stored as an `INBOUND` communication,
 * then sent to the model (contributor tier) for receipt extraction.
 * `CONFIRMED` proposes the receipt for `record-receipt`; `NEEDS_MORE_INFO`
 * drafts a follow-up for approval, or re-plans when the provider demands a
 * phone call; `REFUSED` fails the step and re-plans.
 */
export async function processProviderReply(input: {
  caseId: string;
  stepId: string;
  channel: "EMAIL" | "PHONE_IVR";
  text: string;
  ownerKey: string | null;
  actor: TransitionActor;
  deps?: ReplyDeps;
}): Promise<ProcessReplyResult> {
  const now = (input.deps?.now ?? (() => new Date()))();
  const [c] = await db.select().from(cases).where(eq(cases.id, input.caseId)).limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  const [step] = await db
    .select()
    .from(caseSteps)
    .where(and(eq(caseSteps.id, input.stepId), eq(caseSteps.caseId, input.caseId)))
    .limit(1);
  if (!step) throw new ToolError("NOT_FOUND", "Step not found");

  const redacted = await redact(db, input.text, c.holderId);
  await db.insert(communications).values({
    caseId: c.id,
    stepId: step.id,
    channel: input.channel,
    direction: "INBOUND",
    body: redacted,
    occurredAt: now,
  });

  const { data: extraction } = await completeJson(
    {
      tier: "contributor",
      messages: [
        { role: "system", content: EXTRACT_SYSTEM, redacted: true },
        { role: "user", content: redacted, redacted: true },
      ],
      ownerKey: input.ownerKey,
    },
    ReplyExtractionSchema,
    input.deps?.model,
  );

  if (extraction.outcome === "CONFIRMED") {
    const proposal = proposalOf(extraction);
    await db
      .update(caseSteps)
      .set({
        status: "SUCCEEDED",
        result: { outcome: "CONFIRMED", proposal, requestedItems: extraction.requested_items },
        finishedAt: now,
      })
      .where(eq(caseSteps.id, step.id));
    await publishStepEvent(c.id, step.id, "SUCCEEDED");
    if (c.status === "EXECUTING") {
      await transition(c.id, "RECEIPT_ACQUISITION", { actor: input.actor, now: () => now });
    }
    return {
      outcome: "CONFIRMED",
      requestedItems: extraction.requested_items,
      proposal,
      action: "confirm-receipt",
    };
  }

  if (extraction.outcome === "REFUSED") {
    return failAndReplan(c.id, step, extraction, input.actor, now, "REFUSED");
  }

  // NEEDS_MORE_INFO: a demand to call is a channel switch; anything else
  // gets a drafted follow-up on the same email channel.
  const demandToCall = CALL_SIGNAL_RE.test(`${extraction.requested_items.join(" ")} ${redacted}`);
  if (demandToCall || input.channel !== "EMAIL") {
    return failAndReplan(c.id, step, extraction, input.actor, now, "NEEDS_MORE_INFO");
  }
  const draft = await complete({
    tier: "contributor",
    messages: [
      { role: "system", content: DRAFT_FOLLOW_UP_SYSTEM, redacted: true },
      {
        role: "user",
        content:
          `The provider replied:\n${redacted}\n\n` +
          `They asked for: ${extraction.requested_items.join("; ") || "nothing specific"}.`,
        redacted: true,
      },
    ],
    ownerKey: input.ownerKey,
  });
  await db
    .update(caseSteps)
    .set({
      status: "SUCCEEDED",
      result: { outcome: "NEEDS_MORE_INFO", requestedItems: extraction.requested_items },
      finishedAt: now,
    })
    .where(eq(caseSteps.id, step.id));
  await publishStepEvent(c.id, step.id, "SUCCEEDED");
  const channelId = stepChannelId(step.args);
  const rows = await db
    .select({ seq: caseSteps.seq })
    .from(caseSteps)
    .where(eq(caseSteps.caseId, c.id));
  const seq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
  const [followUp] = await db
    .insert(caseSteps)
    .values({
      caseId: c.id,
      seq,
      tool: "send-notice-email",
      args: { providerChannelId: channelId, kind: "EMAIL", replyBody: draft.text.trim() },
      status: "PLANNED",
      requiresApproval: true,
    })
    .returning({ id: caseSteps.id });
  if (followUp) await publishStepEvent(c.id, followUp.id, "PLANNED");
  return {
    outcome: "NEEDS_MORE_INFO",
    requestedItems: extraction.requested_items,
    proposal: null,
    action: "approve-draft",
  };
}

async function failAndReplan(
  caseId: string,
  step: typeof caseSteps.$inferSelect,
  extraction: ReplyExtraction,
  actor: TransitionActor,
  now: Date,
  outcome: "REFUSED" | "NEEDS_MORE_INFO",
): Promise<ProcessReplyResult> {
  await db
    .update(caseSteps)
    .set({
      status: "FAILED",
      result: { outcome, requestedItems: extraction.requested_items },
      finishedAt: now,
    })
    .where(eq(caseSteps.id, step.id));
  await publishStepEvent(caseId, step.id, "FAILED");
  const channelId = stepChannelId(step.args);
  if (channelId) {
    await replanAfterFailure(caseId, channelId, actor, { now: () => now });
  } else {
    await transition(caseId, "CHANNEL_PLANNING", { actor, now: () => now });
  }
  return {
    outcome,
    requestedItems: extraction.requested_items,
    proposal: null,
    action: "replanned",
  };
}

/**
 * tRPC `cases.pasteReply`: the case page's "paste the provider's reply"
 * box. The running `await-provider-reply` step consumes the text; anything
 * else (no await step, wrong status) is a `VALIDATION` error, never a
 * silent no-op. Model output only fills the receipt proposal: it can never
 * invoke executor-only tools, which live outside the registry.
 */
export async function pasteReply(
  caseId: string,
  text: string,
  ctx: { userId: string; orgIds: string[] },
  deps: ReplyDeps = {},
): Promise<ProcessReplyResult> {
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const owned =
    c && (c.ownerUserId === ctx.userId || (c.orgId !== null && ctx.orgIds.includes(c.orgId)));
  if (!c || !owned) throw new ToolError("NOT_FOUND", "Case not found");
  if (c.status !== "EXECUTING") {
    throw new ToolError("VALIDATION", "The case is not waiting for a provider reply");
  }
  const [step] = await db
    .select()
    .from(caseSteps)
    .where(
      and(
        eq(caseSteps.caseId, caseId),
        eq(caseSteps.tool, "await-provider-reply"),
        eq(caseSteps.status, "RUNNING"),
      ),
    )
    .orderBy(desc(caseSteps.seq))
    .limit(1);
  if (!step) {
    throw new ToolError("VALIDATION", "The case is not waiting for a provider reply");
  }
  return processProviderReply({
    caseId,
    stepId: step.id,
    channel: "EMAIL",
    text,
    ownerKey: c.orgId ? `org:${c.orgId}` : `user:${ctx.userId}`,
    actor: { type: "USER", id: ctx.userId },
    deps,
  });
}
