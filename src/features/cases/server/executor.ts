import { and, eq, inArray } from "drizzle-orm";

import { db } from "~/server/db";
import { caseSteps, cases, communications, mandates, providerChannels } from "~/server/db/schema";
import { getTelephonyAdapter } from "~/server/telephony";
import { VaultReleaseError } from "~/server/vault";
import { env } from "~/shared/config/env";
import { type CallDeps, runCall } from "./call";
import { type EmailStepDeps, runEmailStep } from "./email";
import { type TransitionActor, transition } from "./engine";
import { ToolError } from "./errors";
import { caseChannel, caseEvents } from "./events";
import { EXECUTE_CHANNEL_TOOL, replanAfterFailure } from "./planner";
import { isLiveCase } from "./sandbox";

type CaseRow = typeof cases.$inferSelect;
type ChannelRow = typeof providerChannels.$inferSelect;
type MandateRow = typeof mandates.$inferSelect;
type StepRow = typeof caseSteps.$inferSelect;

export type RunNextStepStatus =
  | "done"
  | "waiting_approval"
  | "waiting_reply"
  | "waiting_call"
  | "failed"
  | "idle";

export interface RunNextStepResult {
  status: RunNextStepStatus;
  stepId?: string;
  /** The replanned channel kind, when a failure led to a new plan. */
  kind?: string;
}

export interface ExecutorDeps {
  email?: EmailStepDeps;
  call?: CallDeps;
  now?: () => Date;
}

export interface RunNextStepOpts extends ExecutorDeps {
  actor?: TransitionActor;
}

function stepChannelId(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const id = (args as Record<string, unknown>).providerChannelId;
  return typeof id === "string" ? id : null;
}

async function publishStepEvent(caseId: string, stepId: string, status: string): Promise<void> {
  await caseEvents().publish(
    caseChannel(caseId),
    JSON.stringify({ type: "step", caseId, stepId, status }),
  );
}

async function loadChannel(channelId: string): Promise<ChannelRow | undefined> {
  const [channel] = await db
    .select()
    .from(providerChannels)
    .where(eq(providerChannels.id, channelId))
    .limit(1);
  return channel;
}

async function loadActiveMandate(caseId: string): Promise<MandateRow | undefined> {
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.caseId, caseId), eq(mandates.status, "ACTIVE")))
    .limit(1);
  return mandate;
}

/**
 * Expand the planner's `execute-channel` placeholder into the channel's own
 * steps: `send-notice-email` plus `await-provider-reply` for email,
 * `place-call` for phone. The placeholder retires as `SKIPPED`; every child
 * carries the channel id, so a later re-plan knows what was tried. Channels
 * without an executor template fail the step, which re-plans onto the next
 * channel.
 */
async function expandPlaceholder(step: StepRow): Promise<StepRow[]> {
  const channelId = stepChannelId(step.args);
  const channel = channelId ? await loadChannel(channelId) : undefined;
  if (!channelId || !channel) {
    throw new ToolError("VALIDATION", "The planned channel is missing");
  }
  const children: Array<{ tool: string; requiresApproval: boolean }> =
    channel.kind === "EMAIL"
      ? [
          { tool: "send-notice-email", requiresApproval: true },
          { tool: "await-provider-reply", requiresApproval: false },
        ]
      : channel.kind === "PHONE_IVR"
        ? [{ tool: "place-call", requiresApproval: true }]
        : [];
  if (children.length === 0) {
    throw new ToolError("VALIDATION", `The ${channel.kind} channel has no executor template`);
  }
  const rows = await db
    .select({ seq: caseSteps.seq })
    .from(caseSteps)
    .where(eq(caseSteps.caseId, step.caseId));
  let seq = rows.reduce((max, row) => Math.max(max, row.seq), 0);
  const now = new Date();
  await db
    .update(caseSteps)
    .set({
      status: "SKIPPED",
      result: { expanded: true, into: children.map((child) => child.tool) },
      finishedAt: now,
    })
    .where(eq(caseSteps.id, step.id));
  await publishStepEvent(step.caseId, step.id, "SKIPPED");
  const inserted: StepRow[] = [];
  for (const child of children) {
    seq += 1;
    const [row] = await db
      .insert(caseSteps)
      .values({
        caseId: step.caseId,
        seq,
        tool: child.tool,
        args: { providerChannelId: channel.id, kind: channel.kind },
        status: "PLANNED",
        requiresApproval: child.requiresApproval,
      })
      .returning();
    if (row) {
      inserted.push(row);
      await publishStepEvent(step.caseId, row.id, "PLANNED");
    }
  }
  return inserted;
}

async function nextActionableStep(caseId: string): Promise<StepRow | undefined> {
  const [step] = await db
    .select()
    .from(caseSteps)
    .where(
      and(
        eq(caseSteps.caseId, caseId),
        inArray(caseSteps.status, ["PLANNED", "AWAITING_APPROVAL"]),
      ),
    )
    .orderBy(caseSteps.seq)
    .limit(1);
  return step;
}

/**
 * Run a case's steps in `seq` order. A step that needs approval waits in
 * `AWAITING_APPROVAL` until `approve-step`; anything runnable runs
 * in-process, and the loop continues until a step waits, fails, or none
 * remain. Before running, the executor rechecks the mandate (`ACTIVE`, not
 * expired) and the case status. A step that throws becomes `FAILED` and the
 * engine re-plans; only a missing case throws out of this function.
 */
export async function runNextStep(
  caseId: string,
  opts: RunNextStepOpts = {},
): Promise<RunNextStepResult> {
  const now = opts.now ?? (() => new Date());
  const actor = opts.actor ?? { type: "AGENT" as const, id: "executor" };
  const [c] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  if (c.status !== "EXECUTING") return { status: "idle" };

  // Each pass runs or parks one step; the bound stops a pathological loop.
  for (let pass = 0; pass < 20; pass++) {
    const [live] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (live?.status !== "EXECUTING") return { status: "done" };
    const step = await nextActionableStep(caseId);
    if (!step) return { status: "done" };

    if (step.tool === EXECUTE_CHANNEL_TOOL && step.status === "PLANNED") {
      try {
        await expandPlaceholder(step);
      } catch (error) {
        return failStepAndReplan(live, step, error, actor, now(), opts);
      }
      continue;
    }

    if (step.requiresApproval && !step.approvedAt) {
      if (step.status === "PLANNED") {
        await db
          .update(caseSteps)
          .set({ status: "AWAITING_APPROVAL" })
          .where(eq(caseSteps.id, step.id));
        await publishStepEvent(caseId, step.id, "AWAITING_APPROVAL");
      }
      return { status: "waiting_approval", stepId: step.id };
    }

    const mandate = await loadActiveMandate(caseId);
    if (!mandate || mandate.expiresAt.getTime() <= now().getTime()) {
      return failStepAndReplan(
        live,
        step,
        new ToolError("VAULT_RELEASE_DENIED", "The mandate is not active"),
        actor,
        now(),
        opts,
      );
    }

    if (step.tool === "await-provider-reply") {
      await db
        .update(caseSteps)
        .set({ status: "RUNNING", startedAt: now() })
        .where(eq(caseSteps.id, step.id));
      await publishStepEvent(caseId, step.id, "RUNNING");
      return { status: "waiting_reply", stepId: step.id };
    }

    const channelId = stepChannelId(step.args);
    const channel = channelId ? await loadChannel(channelId) : undefined;
    if (!channelId || !channel) {
      return failStepAndReplan(
        live,
        step,
        new ToolError("VALIDATION", "The step's channel is missing"),
        actor,
        now(),
        opts,
      );
    }

    try {
      await db
        .update(caseSteps)
        .set({ status: "RUNNING", startedAt: now() })
        .where(eq(caseSteps.id, step.id));
      await publishStepEvent(caseId, step.id, "RUNNING");
      if (step.tool === "send-notice-email") {
        const { subject, messageId } = await runEmailStep(live, step, channel, mandate, {
          ...opts.email,
          now: opts.now,
        });
        await succeedStep(step.id, { subject, messageId });
      } else if (step.tool === "place-call") {
        if (
          isLiveCase(live, mandate) &&
          env.TELEPHONY_PROVIDER === "twilio" &&
          !opts.call?.adapter
        ) {
          return handOffLiveCall(live, step, channel, now());
        }
        const summary = await runCall(live, step, channel, mandate, actor, {
          ...opts.call,
          now: opts.now,
        });
        if (summary.outcome === "TIMEOUT") return { status: "failed", stepId: step.id };
      } else {
        throw new ToolError("UNKNOWN_TOOL", `The executor cannot run ${step.tool}`);
      }
    } catch (error) {
      return failStepAndReplan(live, step, error, actor, now(), opts);
    }
  }
  throw new ToolError("INTERNAL_ERROR", "The executor did not settle the case");
}

/**
 * Live Twilio calls run in the voice worker, not in the request: place the
 * call, record its SID for the worker and status callback to find, and leave
 * the step `RUNNING`. The worker settles the step when the call ends.
 */
async function handOffLiveCall(
  c: CaseRow,
  step: StepRow,
  channel: ChannelRow,
  now: Date,
): Promise<RunNextStepResult> {
  const adapter = await getTelephonyAdapter({ live: true });
  const { callId } = await adapter.placeCall(channel.address);
  await db.insert(communications).values({
    caseId: c.id,
    stepId: step.id,
    channel: "PHONE_IVR",
    direction: "OUTBOUND",
    body: "Call placed",
    externalRef: callId.length <= 120 ? callId : null,
    occurredAt: now,
  });
  await db
    .update(caseSteps)
    .set({ result: { callId, handedOff: true } })
    .where(eq(caseSteps.id, step.id));
  await publishStepEvent(c.id, step.id, "RUNNING");
  return { status: "waiting_call", stepId: step.id };
}

async function succeedStep(stepId: string, result: Record<string, unknown>): Promise<void> {
  const [step] = await db.select().from(caseSteps).where(eq(caseSteps.id, stepId)).limit(1);
  if (!step) return;
  await db
    .update(caseSteps)
    .set({ status: "SUCCEEDED", result, finishedAt: new Date() })
    .where(eq(caseSteps.id, stepId));
  await publishStepEvent(step.caseId, stepId, "SUCCEEDED");
}

async function failStepAndReplan(
  c: CaseRow,
  step: StepRow,
  error: unknown,
  actor: TransitionActor,
  now: Date,
  opts: RunNextStepOpts,
): Promise<RunNextStepResult> {
  const code =
    error instanceof ToolError
      ? error.code
      : error instanceof VaultReleaseError
        ? error.code
        : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message.replace(/^\[[A-Z_]+\] /, "") : "Failed";
  return handleStepFailure(c.id, step.id, code, message, actor, { ...opts, now: () => now });
}

export interface HandleStepFailureOpts extends RunNextStepOpts {
  /**
   * `always` re-plans after marking (the run loop's catch path).
   * `if-fresh` only fails a still-`RUNNING` step, so a late status callback
   * never re-plans a worker-settled call twice.
   */
  replan?: "always" | "if-fresh";
  /** Extra fields merged into the `FAILED` step result (a live transcript). */
  resultDetail?: Record<string, unknown>;
}

/**
 * Fail one step from outside the run loop (the Twilio status callback, the
 * voice worker): mark it `FAILED` unless it already settled, re-plan while
 * the case is still `EXECUTING`, then run the next step. Returns the same
 * outcome shape as `runNextStep`.
 */
export async function handleStepFailure(
  caseId: string,
  stepId: string,
  code: string,
  message: string,
  actor: TransitionActor,
  opts: HandleStepFailureOpts = {},
): Promise<RunNextStepResult> {
  const now = (opts.now ?? (() => new Date()))();
  const [current] = await db.select().from(caseSteps).where(eq(caseSteps.id, stepId)).limit(1);
  if (!current || current.caseId !== caseId) {
    throw new ToolError("NOT_FOUND", "Step not found");
  }
  if (opts.replan === "if-fresh") {
    if (current.status !== "RUNNING") return { status: "failed", stepId };
    const marked = await db
      .update(caseSteps)
      .set({
        status: "FAILED",
        result: { code, message, ...opts.resultDetail },
        finishedAt: now,
      })
      .where(and(eq(caseSteps.id, stepId), eq(caseSteps.status, "RUNNING")))
      .returning({ id: caseSteps.id });
    // Someone settled the step between the load and the mark; its aftermath
    // already ran, so there is nothing left to do.
    if (marked.length === 0) return { status: "failed", stepId };
    await publishStepEvent(caseId, stepId, "FAILED");
  } else if (current.status !== "FAILED" || !current.result) {
    // The vault fails the step itself on a denied release; the executor
    // backfills the coded result either way.
    await db
      .update(caseSteps)
      .set({
        status: "FAILED",
        result: { code, message, ...opts.resultDetail },
        finishedAt: now,
      })
      .where(eq(caseSteps.id, stepId));
    await publishStepEvent(caseId, stepId, "FAILED");
  }
  const [live] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (live?.status !== "EXECUTING") return { status: "failed", stepId };
  const channelId = stepChannelId(current.args);
  if (!channelId) {
    await transition(caseId, "CHANNEL_PLANNING", { actor, now: () => now });
    return { status: "failed", stepId };
  }
  const outcome = await replanAfterFailure(caseId, channelId, actor, { now: () => now });
  if (outcome.planned) {
    return runNextStep(caseId, { ...opts, actor, now: () => now });
  }
  return { status: "failed", stepId };
}
