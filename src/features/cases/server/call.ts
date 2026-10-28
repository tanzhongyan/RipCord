import { eq } from "drizzle-orm";
import { z } from "zod";

import { type ApprovalDeps, requestStepReapproval } from "~/features/identity";
import { db } from "~/server/db";
import {
  accountHolders,
  caseSteps,
  type cases,
  communications,
  type mandates,
  type providerChannels,
} from "~/server/db/schema";
import { type CallOverrides, completeJson } from "~/server/model/adapter";
import {
  getTelephonyAdapter,
  type TelephonyAdapter,
  type TranscriptTurn,
  transcribeFile,
} from "~/server/telephony";
import { getSecretValue, redact, resolveTokens } from "~/server/vault";
import { generateCards } from "./cards";
import { type TransitionActor, transition } from "./engine";
import { ToolError } from "./errors";
import { caseChannel, caseEvents } from "./events";
import { processProviderReply } from "./replies";
import { isLiveCase } from "./sandbox";

type CaseRow = typeof cases.$inferSelect;
type ChannelRow = typeof providerChannels.$inferSelect;
type MandateRow = typeof mandates.$inferSelect;
type StepRow = typeof caseSteps.$inferSelect;

/** A phone call ends after 45 minutes (spec 0005 budgets). */
export const CALL_MAX_DURATION_MS = 45 * 60 * 1000;
/** A sensitive digit release waits for holder approval for up to 120 s. */
const APPROVAL_WAIT_MS = 120 * 1000;
/** Bridge waits for the holder's press-1 for up to 120 s, then continues. */
const BRIDGE_WAIT_MS = 120 * 1000;

/** Menu labels the runner may select. */
const MENU_ALLOW_RE =
  /cancel|terminat|disconnect|account|billing|customer service|agent|operator|other/i;
/** Menu labels the runner must never select. */
const MENU_BLOCK_RE = /new|sign ?up|upgrade|buy|recontract|add|offer|promotion|sales/i;

/** Secret kinds whose digit release needs holder approval. */
const SENSITIVE_KINDS = new Set(["NRIC", "PIN", "ACCOUNT_NO"]);

const FULL_TOKEN_RE = /\{\{vault:([A-Z_]+):([0-9a-fA-F-]{36})\}\}/g;

const UnknownMenuSchema = z.object({
  digit: z.string().min(1).max(8),
  option_label: z.string().min(1).max(200),
});

const UNKNOWN_MENU_SYSTEM =
  "You hear a phone menu as text. Pick the option that cancels a service or " +
  "reaches a human about an existing account. Reply with the digit to press " +
  "and the option's label.";

const ClassifyTurnSchema = z.object({
  verdict: z.enum(["MENU", "HUMAN_AGENT"]),
});

const CLASSIFY_TURN_SYSTEM =
  "Classify one transcribed phone turn: MENU for a recorded menu or hold " +
  "message, HUMAN_AGENT for a live human representative speaking.";

const MenuPromptSchema = z.object({
  expects_digits: z.boolean(),
});

const MENU_PROMPT_SYSTEM =
  "Decide whether one transcribed phone turn asks the caller to press a " +
  "digit now. Answer true only when the turn names digits to press, such " +
  "as 'press 3' or 'enter your account number'. Hold music, greetings and " +
  "confirmations answer false.";

export interface CallDeps {
  adapter?: TelephonyAdapter;
  transcribe?: (audio: Uint8Array) => Promise<{ text: string }>;
  model?: CallOverrides;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxDurationMs?: number;
  approvalWaitMs?: number;
  bridgeWaitMs?: number;
  /** Approval plumbing for the sensitive-digit hold. Tests pass fakes. */
  approval?: ApprovalDeps;
}

export interface CallSummary {
  callId: string;
  turns: number;
  digitsSent: string[];
  bridged: boolean;
  outcome: string;
}

/**
 * Jaccard similarity over lowercase word tokens: |A ∩ B| / |A ∪ B|.
 * An `ivr_path` entry matches a transcribed prompt at 0.6 or above.
 */
export function tokenSetSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

interface IvrEntry {
  prompt: string;
  digits: string;
}

function ivrEntries(channel: ChannelRow): IvrEntry[] {
  if (!Array.isArray(channel.ivrPath)) return [];
  return channel.ivrPath.filter(
    (entry): entry is IvrEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as IvrEntry).prompt === "string" &&
      typeof (entry as IvrEntry).digits === "string",
  );
}

type CallEvent =
  | { kind: "answered" }
  | { kind: "ended"; reason: string }
  | { kind: "transcript"; turn: TranscriptTurn }
  | { kind: "holder_joined" };

async function waitForApproval(
  stepId: string,
  deadlineMs: number,
  deps: Required<Pick<CallDeps, "sleep" | "now">>,
): Promise<boolean> {
  for (;;) {
    const [step] = await db
      .select({ approvedAt: caseSteps.approvedAt })
      .from(caseSteps)
      .where(eq(caseSteps.id, stepId))
      .limit(1);
    if (step?.approvedAt) return true;
    if (deps.now().getTime() >= deadlineMs) return false;
    await deps.sleep(1000);
  }
}

/**
 * `place-call`: dial the channel, work the menu, bridge the holder when a
 * human answers, and read the finished transcript like an email reply. The
 * agent never speaks to the rep: digits and the holder bridge are the only
 * outputs. Sandbox cases always use the simulated adapter.
 */
export async function runCall(
  c: CaseRow,
  step: StepRow,
  channel: ChannelRow,
  mandate: MandateRow,
  actor: TransitionActor,
  deps: CallDeps = {},
): Promise<CallSummary> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxDurationMs = deps.maxDurationMs ?? CALL_MAX_DURATION_MS;
  const ownerKey = c.orgId ? `org:${c.orgId}` : `user:${c.ownerUserId}`;
  const transcribe = deps.transcribe ?? ((audio: Uint8Array) => transcribeFile(audio));
  const live = isLiveCase(c, mandate);
  const adapter =
    deps.adapter ?? (await getTelephonyAdapter(live ? { live: true } : { live: false }));

  const [holder] = await db
    .select()
    .from(accountHolders)
    .where(eq(accountHolders.id, c.holderId))
    .limit(1);
  if (!holder) throw new ToolError("NOT_FOUND", "Holder not found");
  const holderPhone = await getSecretValue(db, holder.phoneSecretId);

  const events: CallEvent[] = [];
  let waiter: (() => void) | null = null;
  const push = (event: CallEvent): void => {
    events.push(event);
    waiter?.();
    waiter = null;
  };
  const offs = [
    adapter.on("answered", () => push({ kind: "answered" })),
    adapter.on("ended", (payload) => push({ kind: "ended", reason: payload.reason })),
    adapter.on("transcript", (turn) => push({ kind: "transcript", turn })),
    adapter.on("holder_joined", () => push({ kind: "holder_joined" })),
  ];
  const release = (): void => {
    for (const off of offs) off();
  };
  const nextEvent = async (): Promise<CallEvent> => {
    const queued = events.shift();
    if (queued) return queued;
    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
    const event = events.shift();
    if (!event) throw new ToolError("INTERNAL_ERROR", "Call event queue lost an event");
    return event;
  };
  // The deadline races every event wait, so a silent call still ends.
  const nextEventBefore = async (deadline: number): Promise<CallEvent | null> => {
    const remaining = deadline - now().getTime();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    const event = await Promise.race([nextEvent(), timeout]);
    if (timer) clearTimeout(timer);
    return event;
  };

  const publish = (payload: Record<string, unknown>): Promise<unknown> =>
    caseEvents().publish(caseChannel(c.id), JSON.stringify({ caseId: c.id, ...payload }));

  const failStep = async (result: Record<string, unknown>): Promise<void> => {
    await db
      .update(caseSteps)
      .set({ status: "FAILED", result, finishedAt: now() })
      .where(eq(caseSteps.id, step.id));
    await publish({ type: "step", stepId: step.id, status: "FAILED" });
  };

  const { callId } = await adapter.placeCall(channel.address);
  const startMs = now().getTime();
  const deadline = startMs + maxDurationMs;
  try {
    const first = await nextEventBefore(deadline);
    if (!first || first.kind === "ended") {
      await failStep({ callId, outcome: "CALL_UNANSWERED" });
      throw new ToolError("VALIDATION", "The call did not connect");
    }

    const transcript: Array<{ speaker: string; text: string }> = [];
    const digitsSent: string[] = [];
    let bridged = false;
    let bridgeAsked = false;
    let timedOut = false;

    for (;;) {
      const event = await nextEventBefore(deadline);
      if (!event) {
        timedOut = true;
        break;
      }
      if (event.kind === "ended") break;
      if (event.kind === "holder_joined") {
        bridged = true;
        await publish({ type: "holder_joined", stepId: step.id, callId });
        continue;
      }
      if (event.kind !== "transcript") continue;
      const turn = event.turn;

      let text = turn.text;
      if (text === null) {
        text = await transcribeTurn(adapter, callId, transcribe);
      }
      const redacted = await redact(db, text, c.holderId);
      transcript.push({ speaker: turn.speaker, text: redacted });
      await db.insert(communications).values({
        caseId: c.id,
        stepId: step.id,
        channel: "PHONE_IVR",
        direction: turn.speaker === "HOLDER" ? "OUTBOUND" : "INBOUND",
        body: redacted,
        externalRef: callId.length <= 120 ? callId : null,
        occurredAt: now(),
      });
      await publish({
        type: "transcript",
        stepId: step.id,
        callId,
        speaker: turn.speaker,
        text: redacted,
      });

      if (turn.speaker === "IVR" && turn.expectsDigits) {
        const digits = await chooseMenuDigits(redacted, channel, ownerKey, deps.model);
        if (digits === null) {
          await adapter.hangUp(callId);
          await failStep({
            callId,
            outcome: "MENU_OPTION_BLOCKED",
            transcript: transcript.map((entry) => `${entry.speaker}: ${entry.text}`),
          });
          throw new ToolError("VALIDATION", "The menu offered no safe option");
        }
        const resolved = await resolveCallDigits(digits, c, step, channel, mandate, deps, {
          now,
          sleep,
        });
        await adapter.sendDigits(callId, resolved);
        digitsSent.push(resolved);
      } else if (turn.speaker === "REP") {
        const cards = await generateCards(c.id, redacted, ownerKey, { model: deps.model });
        for (const card of cards) {
          await publish({ type: "card", stepId: step.id, callId, card });
        }
        if (!bridgeAsked && (await classifySpeaker(turn, redacted, ownerKey, deps.model))) {
          bridgeAsked = true;
          try {
            await adapter.bridgeHolder(callId, holderPhone);
            bridged = await waitForHolder(events, nextEventBefore, deadline, deps.bridgeWaitMs);
            if (bridged) {
              await publish({ type: "holder_joined", stepId: step.id, callId });
            }
          } catch {
            // A failed bridge never kills the call: the rep may confirm anyway.
            bridged = false;
          }
        }
      }
    }

    if (timedOut) {
      await adapter.hangUp(callId);
      await failStep({ callId, outcome: "TIMEOUT", turns: transcript.length });
      await transition(c.id, "FAILED", { reason: "TIMEOUT", actor, now });
      return { callId, turns: transcript.length, digitsSent, bridged, outcome: "TIMEOUT" };
    }

    const fullTranscript = transcript.map((entry) => `${entry.speaker}: ${entry.text}`).join("\n");
    const reply = await processProviderReply({
      caseId: c.id,
      stepId: step.id,
      channel: "PHONE_IVR",
      text: fullTranscript,
      ownerKey,
      actor,
      deps: { model: deps.model, now: deps.now },
    });
    if (reply.action === "confirm-receipt") {
      await db
        .update(caseSteps)
        .set({
          result: {
            callId,
            digitsSent,
            turns: transcript.length,
            bridged,
            outcome: "CONFIRMED",
            proposal: reply.proposal,
          },
        })
        .where(eq(caseSteps.id, step.id));
    }
    return {
      callId,
      turns: transcript.length,
      digitsSent,
      bridged,
      outcome: reply.outcome,
    };
  } finally {
    release();
  }
}

async function transcribeTurn(
  adapter: TelephonyAdapter,
  callId: string,
  transcribe: (audio: Uint8Array) => Promise<{ text: string }>,
): Promise<string> {
  for await (const chunk of adapter.audio(callId)) {
    const { text } = await transcribe(chunk);
    return text;
  }
  throw new ToolError("INTERNAL_ERROR", "The call ended without audio");
}

/**
 * Pick digits for a menu turn: the best `ivr_path` match at similarity 0.6
 * or above, else the model's pick when its label is allow-listed and not
 * block-listed. Null hangs the call up. Shared with the voice worker.
 */
export async function chooseMenuDigits(
  redactedTurn: string,
  channel: ChannelRow,
  ownerKey: string | null,
  model?: CallOverrides,
): Promise<string | null> {
  let best: IvrEntry | null = null;
  let bestScore = 0.6;
  for (const entry of ivrEntries(channel)) {
    const score = tokenSetSimilarity(redactedTurn, entry.prompt);
    if (score >= bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (best) return best.digits;
  const { data } = await completeJson(
    {
      tier: "contributor",
      messages: [
        { role: "system", content: UNKNOWN_MENU_SYSTEM, redacted: true },
        { role: "user", content: redactedTurn, redacted: true },
      ],
      ownerKey,
    },
    UnknownMenuSchema,
    model,
  );
  if (!MENU_ALLOW_RE.test(data.option_label) || MENU_BLOCK_RE.test(data.option_label)) {
    return null;
  }
  return data.digit;
}

/**
 * Resolve vault tokens in menu digits. A sensitive kind raises a fresh
 * holder approval request first: the placement approval covered dialling,
 * so the call waits on hold for the new decision, for up to 120 s. The
 * vault re-verifies every release rule on the way out. Shared with the
 * voice worker.
 */
export async function resolveCallDigits(
  digits: string,
  c: CaseRow,
  step: StepRow,
  channel: ChannelRow,
  mandate: MandateRow,
  deps: CallDeps,
  clock: Required<Pick<CallDeps, "sleep" | "now">>,
): Promise<string> {
  const kinds = new Set<string>();
  for (const match of digits.matchAll(FULL_TOKEN_RE)) {
    if (match[1]) kinds.add(match[1]);
  }
  const sensitive = [...kinds].some((kind) => SENSITIVE_KINDS.has(kind));
  if (sensitive) {
    await requestStepReapproval(
      { stepId: step.id },
      { userId: c.ownerUserId, orgIds: c.orgId ? [c.orgId] : [] },
      deps.approval,
    );
    await caseEvents().publish(
      caseChannel(c.id),
      JSON.stringify({
        caseId: c.id,
        type: "step",
        stepId: step.id,
        status: "RUNNING",
        approvalRequested: true,
      }),
    );
    const approved = await waitForApproval(
      step.id,
      clock.now().getTime() + (deps.approvalWaitMs ?? APPROVAL_WAIT_MS),
      clock,
    );
    if (!approved) {
      throw new ToolError("VAULT_RELEASE_DENIED", "Holder approval did not arrive in time");
    }
  }
  return resolveTokens(db, digits, {
    caseId: c.id,
    stepId: step.id,
    mandateId: mandate.id,
    providerChannelId: channel.id,
  });
}

/**
 * A non-menu turn over 4 s, or a model `HUMAN_AGENT` verdict, is human.
 * Shared with the voice worker.
 */
export async function classifySpeaker(
  turn: TranscriptTurn,
  redacted: string,
  ownerKey: string | null,
  model?: CallOverrides,
): Promise<boolean> {
  if (turn.speaker === "HOLDER") return true;
  if (turn.durationS !== null && turn.durationS > 4) return true;
  // Anything else asks the model: a 3 s rep greeting is human, a 3 s menu is not.
  const { data } = await completeJson(
    {
      tier: "contributor",
      messages: [
        { role: "system", content: CLASSIFY_TURN_SYSTEM, redacted: true },
        { role: "user", content: redacted, redacted: true },
      ],
      ownerKey,
    },
    ClassifyTurnSchema,
    model,
  );
  return data.verdict === "HUMAN_AGENT";
}

/**
 * True when a live IVR turn asks the caller to press a digit now. The
 * fixture adapter flags its own turns; the voice worker asks the model so
 * it never sends digits into hold music. Shared with the voice worker.
 */
export async function detectMenuPrompt(
  redactedTurn: string,
  ownerKey: string | null,
  model?: CallOverrides,
): Promise<boolean> {
  const { data } = await completeJson(
    {
      tier: "contributor",
      messages: [
        { role: "system", content: MENU_PROMPT_SYSTEM, redacted: true },
        { role: "user", content: redactedTurn, redacted: true },
      ],
      ownerKey,
    },
    MenuPromptSchema,
    model,
  );
  return data.expects_digits;
}

/**
 * Wait for the holder's press-1 join without dropping other queued events:
 * non-join events go back to the front of the queue. The join still arrives
 * on its own timer when the script ends first, so `ended` parks and the
 * wait continues until the join or the timeout.
 */
async function waitForHolder(
  queue: CallEvent[],
  nextEventBefore: (deadline: number) => Promise<CallEvent | null>,
  callDeadline: number,
  bridgeWaitMs: number | undefined,
): Promise<boolean> {
  const deadline = Math.min(callDeadline, Date.now() + (bridgeWaitMs ?? BRIDGE_WAIT_MS));
  const parked: CallEvent[] = [];
  try {
    for (;;) {
      const event = await nextEventBefore(deadline);
      if (!event) return false;
      if (event.kind === "holder_joined") return true;
      parked.push(event);
    }
  } finally {
    queue.unshift(...parked);
  }
}
