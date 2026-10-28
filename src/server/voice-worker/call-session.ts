import { desc, eq } from "drizzle-orm";

import {
  CALL_MAX_DURATION_MS,
  chooseMenuDigits,
  classifySpeaker,
  detectMenuPrompt,
  generateCards,
  handleStepFailure,
  processProviderReply,
  resolveCallDigits,
  transition,
} from "~/features/cases";
import { caseChannel, caseEvents } from "~/features/cases/server/events";
import { db } from "~/server/db";
import {
  accountHolders,
  caseSteps,
  cases,
  communications,
  mandates,
  providerChannels,
} from "~/server/db/schema";
import type { CallOverrides } from "~/server/model/adapter";
import type { TelephonyAdapter, TurnSpeaker } from "~/server/telephony";
import { getSecretValue, redact } from "~/server/vault";

type CaseRow = typeof cases.$inferSelect;
type ChannelRow = typeof providerChannels.$inferSelect;
type MandateRow = typeof mandates.$inferSelect;
type StepRow = typeof caseSteps.$inferSelect;

/** One final speech-to-text turn with the service's speaker label. */
export interface LiveTurn {
  text: string;
  speakerLabel: string | null;
}

/** A live provider call the worker is driving. */
export interface LiveSession {
  callSid: string;
  streamSid: string;
  caseId: string;
  stepId: string;
  /** Case snapshot: only the immutable `id` and `holderId` are read. */
  c: CaseRow;
  channel: ChannelRow;
  mandate: MandateRow;
  holderPhone: string;
  ownerKey: string | null;
  transcript: Array<{ speaker: TurnSpeaker; text: string }>;
  digitsSent: string[];
  bridgeAsked: boolean;
  startMs: number;
  adapter: TelephonyAdapter;
  close: () => void;
}

export interface LiveSessionDeps {
  adapter: TelephonyAdapter;
  close?: () => void;
  now?: () => Date;
  model?: CallOverrides;
  maxDurationMs?: number;
}

const REP_LABELS = ["agent", "rep", "representative", "human", "provider", "csr"];
const IVR_LABELS = ["ivr", "menu", "system", "bot", "recorded", "announcement"];
const HOLDER_LABELS = ["holder", "customer", "caller", "user"];

/**
 * Map a speech-service speaker label to a turn speaker. Null means the
 * label says nothing (diarization ids like `speaker_0`), and the model
 * classifies the turn instead.
 */
export function mapSpeakerLabel(label: string | null): TurnSpeaker | null {
  if (!label) return null;
  const lower = label.toLowerCase();
  if (HOLDER_LABELS.some((keyword) => lower.includes(keyword))) return "HOLDER";
  if (REP_LABELS.some((keyword) => lower.includes(keyword))) return "REP";
  if (IVR_LABELS.some((keyword) => lower.includes(keyword))) return "IVR";
  return null;
}

/**
 * Open a session for a media stream: the call SID resolves through the
 * handoff's `communications` row to the case and step. Null when the SID
 * is unknown or the step is no longer `RUNNING`.
 */
export async function createLiveSession(
  callSid: string,
  streamSid: string,
  deps: LiveSessionDeps,
): Promise<LiveSession | null> {
  const now = deps.now ?? (() => new Date());
  const [comm] = await db
    .select({ caseId: communications.caseId, stepId: communications.stepId })
    .from(communications)
    .where(eq(communications.externalRef, callSid))
    .orderBy(desc(communications.occurredAt))
    .limit(1);
  if (!comm?.stepId) return null;
  const [step] = await db.select().from(caseSteps).where(eq(caseSteps.id, comm.stepId)).limit(1);
  if (!step || step.caseId !== comm.caseId || step.status !== "RUNNING") return null;
  const [c] = await db.select().from(cases).where(eq(cases.id, step.caseId)).limit(1);
  if (c?.status !== "EXECUTING") return null;
  const args = step.args as { providerChannelId?: unknown };
  const [channel] =
    typeof args.providerChannelId === "string"
      ? await db
          .select()
          .from(providerChannels)
          .where(eq(providerChannels.id, args.providerChannelId))
          .limit(1)
      : [];
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(eq(mandates.caseId, c.id))
    .orderBy(desc(mandates.createdAt))
    .limit(1);
  const [holder] = await db
    .select()
    .from(accountHolders)
    .where(eq(accountHolders.id, c.holderId))
    .limit(1);
  if (!channel || !mandate || !holder) return null;
  return {
    callSid,
    streamSid,
    caseId: c.id,
    stepId: step.id,
    c,
    channel,
    mandate,
    holderPhone: await getSecretValue(db, holder.phoneSecretId),
    ownerKey: c.orgId ? `org:${c.orgId}` : `user:${c.ownerUserId}`,
    transcript: [],
    digitsSent: [],
    bridgeAsked: false,
    startMs: now().getTime(),
    adapter: deps.adapter,
    close: deps.close ?? (() => {}),
  };
}

async function publish(session: LiveSession, payload: Record<string, unknown>): Promise<void> {
  await caseEvents().publish(
    caseChannel(session.caseId),
    JSON.stringify({ caseId: session.caseId, ...payload }),
  );
}

async function loadStep(stepId: string): Promise<StepRow | undefined> {
  const [step] = await db.select().from(caseSteps).where(eq(caseSteps.id, stepId)).limit(1);
  return step;
}

/**
 * Abort a live call: hang up, fail the step without re-planning twice, and
 * close the stream. The 45-minute cap instead fails the case with
 * `TIMEOUT`, exactly like the in-process runner.
 */
export async function abortLiveSession(
  session: LiveSession,
  outcome: "MENU_OPTION_BLOCKED" | "TIMEOUT" | "INTERNAL_ERROR",
  message: string,
): Promise<void> {
  await session.adapter.hangUp(session.callSid).catch(() => {});
  const [c] = await db.select().from(cases).where(eq(cases.id, session.caseId)).limit(1);
  if (!c) {
    session.close();
    return;
  }
  if (outcome === "TIMEOUT") {
    await db
      .update(caseSteps)
      .set({
        status: "FAILED",
        result: { callId: session.callSid, outcome },
        finishedAt: new Date(),
      })
      .where(eq(caseSteps.id, session.stepId));
    await publish(session, { type: "step", stepId: session.stepId, status: "FAILED" });
    if (c.status === "EXECUTING") {
      await transition(session.caseId, "FAILED", {
        reason: "TIMEOUT",
        actor: { type: "SYSTEM", id: "voice-worker" },
      });
    }
  } else {
    await handleStepFailure(session.caseId, session.stepId, "VALIDATION", message, {
      type: "SYSTEM",
      id: "voice-worker",
    });
  }
  session.close();
}

/**
 * Handle one final transcript turn: store and stream it, work menus until
 * the holder bridges, then keep transcribing and coaching while the holder
 * talks. The agent never speaks to the rep.
 */
export async function handleLiveTurn(
  session: LiveSession,
  turn: LiveTurn,
  deps: LiveSessionDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  if (now().getTime() - session.startMs > (deps.maxDurationMs ?? CALL_MAX_DURATION_MS)) {
    await abortLiveSession(session, "TIMEOUT", "The call reached its 45-minute limit");
    return;
  }
  let speaker = mapSpeakerLabel(turn.speakerLabel);
  const redacted = await redact(db, turn.text, session.c.holderId);
  if (!speaker) {
    const human = await classifySpeaker(
      {
        callId: session.callSid,
        speaker: "REP",
        text: redacted,
        durationS: null,
        expectsDigits: false,
      },
      redacted,
      session.ownerKey,
      deps.model,
    );
    speaker = human ? "REP" : "IVR";
  }
  session.transcript.push({ speaker, text: redacted });
  await db.insert(communications).values({
    caseId: session.caseId,
    stepId: session.stepId,
    channel: "PHONE_IVR",
    direction: speaker === "HOLDER" ? "OUTBOUND" : "INBOUND",
    body: redacted,
    externalRef: session.callSid.length <= 120 ? session.callSid : null,
    occurredAt: now(),
  });
  await publish(session, {
    type: "transcript",
    stepId: session.stepId,
    callId: session.callSid,
    speaker,
    text: redacted,
  });

  if (speaker === "HOLDER") return;
  if (speaker === "IVR" && !session.bridgeAsked) {
    if (!(await detectMenuPrompt(redacted, session.ownerKey, deps.model))) return;
    const digits = await chooseMenuDigits(redacted, session.channel, session.ownerKey, deps.model);
    if (digits === null) {
      await abortLiveSession(session, "MENU_OPTION_BLOCKED", "The menu offered no safe option");
      return;
    }
    const step = await loadStep(session.stepId);
    if (step?.status !== "RUNNING") return;
    const resolved = await resolveCallDigits(
      digits,
      session.c,
      step,
      session.channel,
      session.mandate,
      {},
      { now, sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) },
    );
    await session.adapter.sendDigits(session.callSid, resolved);
    session.digitsSent.push(resolved);
    return;
  }
  if (speaker === "REP") {
    const cards = await generateCards(session.caseId, redacted, session.ownerKey, {
      model: deps.model,
    });
    for (const card of cards) {
      await publish(session, {
        type: "card",
        stepId: session.stepId,
        callId: session.callSid,
        card,
      });
    }
    if (!session.bridgeAsked) {
      session.bridgeAsked = true;
      // Fire-and-forget: the status callback publishes the join, and the
      // rep may confirm even when the bridge fails.
      await session.adapter.bridgeHolder(session.callSid, session.holderPhone).catch(() => {});
    }
  }
}

/**
 * Settle a finished live call: the redacted transcript reads like an email
 * reply, proposing the receipt or re-planning on refusal.
 */
export async function finishLiveSession(
  session: LiveSession,
  deps: LiveSessionDeps,
): Promise<void> {
  const fullTranscript = session.transcript
    .map((entry) => `${entry.speaker}: ${entry.text}`)
    .join("\n");
  const reply = await processProviderReply({
    caseId: session.caseId,
    stepId: session.stepId,
    channel: "PHONE_IVR",
    text: fullTranscript,
    ownerKey: session.ownerKey,
    actor: { type: "SYSTEM", id: "voice-worker" },
    deps: { model: deps.model },
  });
  if (reply.action === "confirm-receipt") {
    await db
      .update(caseSteps)
      .set({
        result: {
          callId: session.callSid,
          digitsSent: session.digitsSent,
          turns: session.transcript.length,
          bridged: session.bridgeAsked,
          outcome: "CONFIRMED",
          proposal: reply.proposal,
        },
      })
      .where(eq(caseSteps.id, session.stepId));
  }
}
