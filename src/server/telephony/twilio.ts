import { eq } from "drizzle-orm";
import twilio from "twilio";

import type { ValkeyClient } from "~/features/identity";
import { valkey } from "~/features/identity";
import { db } from "~/server/db";
import { caseSteps, cases, communications, providers } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import type { TelephonyAdapter, TelephonyEvent, TelephonyEventMap } from "./adapter";

/**
 * The Twilio REST surface the adapter uses, verified against `twilio@6.2.0`:
 * `calls.create` for outbound legs, `calls(sid).update` for TwiML redirects
 * and hang-ups. Tests substitute a recording fake.
 */
export interface TwilioCalls {
  create(params: {
    to: string;
    from: string;
    twiml: string;
    statusCallback?: string;
    statusCallbackEvent?: string[];
  }): Promise<{ sid: string }>;
  (
    sid: string,
  ): {
    update(params: { status?: "completed" | "canceled"; twiml?: string }): Promise<unknown>;
  };
}

export interface TwilioAdapterDeps {
  client?: TwilioCalls;
  from?: string;
  streamUrl?: string;
  statusCallbackUrl?: string;
  gatherUrl?: string;
  valkey?: ValkeyClient;
  /** Resolve the provider name spoken in the holder-bridge message. */
  providerNameForCall?: (callId: string) => Promise<string>;
}

/** Valkey key for a holder leg's call SID: JSON `{ caseId, stepId, providerCallSid }`. */
export const holderLegKey = (holderCallSid: string): string => `twilio:holder:${holderCallSid}`;

/** Holder-leg mappings outlive any call (45 min cap): 4 h TTL. */
const HOLDER_LEG_TTL_SECONDS = 4 * 3600;

async function defaultProviderNameForCall(callId: string): Promise<string> {
  const [comm] = await db
    .select({ stepId: communications.stepId })
    .from(communications)
    .where(eq(communications.externalRef, callId))
    .limit(1);
  const [step] = comm?.stepId
    ? await db.select().from(caseSteps).where(eq(caseSteps.id, comm.stepId)).limit(1)
    : [];
  const [c] = step ? await db.select().from(cases).where(eq(cases.id, step.caseId)).limit(1) : [];
  const [provider] = c?.providerId
    ? await db
        .select({ name: providers.name })
        .from(providers)
        .where(eq(providers.id, c.providerId))
        .limit(1)
    : [];
  return provider?.name ?? "provider";
}

/**
 * Live adapter (spec 0005, P1). Outbound legs open with TwiML
 * `<Connect><Stream>` to the voice worker; digits go out as `<Play digits>`
 * call updates; the holder bridge conferences both legs. Media frames never
 * pass through here: the worker feeds `audio()` through `ingestAudio`.
 * Answered/ended legs report through the status callback route, which
 * publishes case events; this adapter emits no events itself.
 */
export class TwilioAdapter implements TelephonyAdapter {
  private readonly audioQueues = new Map<
    string,
    { chunks: Uint8Array[]; waiters: Array<() => void>; open: boolean }
  >();

  constructor(private readonly deps: TwilioAdapterDeps = {}) {}

  private get client(): TwilioCalls {
    if (this.deps.client) return this.deps.client;
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error("Twilio is not configured");
    return twilio(sid, token).calls as unknown as TwilioCalls;
  }

  private get from(): string {
    const from = this.deps.from ?? env.TWILIO_VOICE_FROM;
    if (!from) throw new Error("TWILIO_VOICE_FROM is not configured");
    return from;
  }

  private get streamUrl(): string {
    if (this.deps.streamUrl) return this.deps.streamUrl;
    return `${env.VOICE_WORKER_URL.replace(/^http/, "ws").replace(/\/$/, "")}/twilio/stream`;
  }

  private get statusCallbackUrl(): string {
    return (
      this.deps.statusCallbackUrl ??
      `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/telephony/twilio/status`
    );
  }

  private get gatherUrl(): string {
    return (
      this.deps.gatherUrl ?? `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/telephony/twilio/gather`
    );
  }

  on<E extends TelephonyEvent>(
    _event: E,
    _handler: (payload: TelephonyEventMap[E]) => void,
  ): () => void {
    // Leg statuses arrive on the status callback route, never here.
    return () => {};
  }

  async placeCall(to: string): Promise<{ callId: string }> {
    const voice = new twilio.twiml.VoiceResponse();
    voice.connect().stream({ url: this.streamUrl });
    const call = await this.client.create({
      to,
      from: this.from,
      twiml: voice.toString(),
      statusCallback: this.statusCallbackUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    return { callId: call.sid };
  }

  async sendDigits(callId: string, digits: string): Promise<void> {
    const voice = new twilio.twiml.VoiceResponse();
    voice.play({ digits });
    await this.client(callId).update({ twiml: voice.toString() });
  }

  async *audio(callId: string): AsyncIterable<Uint8Array> {
    const queue = this.queueFor(callId);
    for (;;) {
      const chunk = queue.chunks.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (!queue.open) return;
      await new Promise<void>((resolve) => {
        queue.waiters.push(resolve);
      });
    }
  }

  /** The voice worker feeds media frames here, one chunk per frame. */
  ingestAudio(callId: string, chunk: Uint8Array): void {
    const queue = this.queueFor(callId);
    queue.chunks.push(chunk);
    for (const resolve of queue.waiters.splice(0)) resolve();
  }

  /** The voice worker closes the stream when the media ends. */
  endAudio(callId: string): void {
    const queue = this.queueFor(callId);
    queue.open = false;
    for (const resolve of queue.waiters.splice(0)) resolve();
  }

  async bridgeHolder(callId: string, holderPhone: string): Promise<void> {
    const conference = `ripcord-${callId}`;
    const providerName =
      (await (this.deps.providerNameForCall ?? defaultProviderNameForCall)(callId)) ?? "provider";
    const gather = new twilio.twiml.VoiceResponse();
    gather
      .gather({
        numDigits: 1,
        action: `${this.gatherUrl}?conf=${encodeURIComponent(conference)}`,
        method: "POST",
      })
      .say(`RipCord: your ${providerName} call is connected, press 1 to join`);
    const holderLeg = await this.client.create({
      to: holderPhone,
      from: this.from,
      twiml: gather.toString(),
      statusCallback: this.statusCallbackUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    const store = this.deps.valkey ?? valkey();
    await store.set(
      holderLegKey(holderLeg.sid),
      JSON.stringify({ providerCallSid: callId }),
      "EX",
      HOLDER_LEG_TTL_SECONDS,
    );
    // The provider leg waits silently until the holder joins.
    const providerTwiml = new twilio.twiml.VoiceResponse();
    providerTwiml
      .dial()
      .conference({ startConferenceOnEnter: false, endConferenceOnExit: true }, conference);
    await this.client(callId).update({ twiml: providerTwiml.toString() });
  }

  async hangUp(callId: string): Promise<void> {
    this.endAudio(callId);
    await this.client(callId).update({ status: "completed" });
  }

  private queueFor(callId: string): {
    chunks: Uint8Array[];
    waiters: Array<() => void>;
    open: boolean;
  } {
    let queue = this.audioQueues.get(callId);
    if (!queue) {
      queue = { chunks: [], waiters: [], open: true };
      this.audioQueues.set(callId, queue);
    }
    return queue;
  }
}
