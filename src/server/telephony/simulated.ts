import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type {
  TelephonyAdapter,
  TelephonyEvent,
  TelephonyEventMap,
  TranscriptTurn,
  TurnSpeaker,
} from "./adapter";

export interface FixtureTurn {
  speaker: TurnSpeaker;
  text: string;
  /** WAV file under `public/demo/`, streamed through speech-to-text. */
  audio?: string;
  /** Turn length in seconds; missing means the model classifies the turn. */
  durationS?: number;
  expectsDigits?: boolean;
  nextOnDigits?: Record<string, number>;
}

export interface TelephonyFixture {
  slug: string;
  turns: FixtureTurn[];
}

/** Parse and lightly validate a telephony fixture. */
export function parseFixture(raw: unknown): TelephonyFixture {
  const slug = (raw as { slug?: unknown }).slug;
  const turns = (raw as { turns?: unknown }).turns;
  if (typeof slug !== "string" || !Array.isArray(turns) || turns.length === 0) {
    throw new Error("Telephony fixture needs a slug and at least one turn");
  }
  for (const turn of turns) {
    const speaker = (turn as FixtureTurn).speaker;
    if (speaker !== "IVR" && speaker !== "REP" && speaker !== "HOLDER") {
      throw new Error(`Telephony fixture has a bad speaker: ${String(speaker)}`);
    }
    if (typeof (turn as FixtureTurn).text !== "string") {
      throw new Error("Telephony fixture turns need text");
    }
  }
  return { slug, turns: turns as FixtureTurn[] };
}

/** The `demo-telco` fixture, stored beside this loader. */
export function loadDemoFixture(): TelephonyFixture {
  const raw = readFileSync(new URL("./fixtures/demo-telco.json", import.meta.url), "utf8");
  return parseFixture(JSON.parse(raw) as unknown);
}

interface LiveCall {
  index: number;
  alive: boolean;
  audioQueue: Uint8Array[];
  /** Resolves the next `audio()` pull when a chunk arrives. */
  audioWaiters: Array<() => void>;
}

/**
 * Fixture-driven adapter (spec 0005, P0). Plays one fixture's turns:
 * `placeCall` answers and emits the first turn; `sendDigits` follows
 * `nextOnDigits` (an unmapped digit ends the call); turns that do not
 * expect digits advance on their own. A turn with `audio` streams the WAV
 * file on `audio()` and emits its transcript with `text: null`, so the
 * runner transcribes it; otherwise the fixture text is the transcript.
 * `bridgeHolder` emits `holder_joined` after 2 s.
 */
export class SimulatedAdapter implements TelephonyAdapter {
  /** Every `sendDigits` call, in order. Tests assert the chosen digits here. */
  readonly digitsSent: Array<{ callId: string; digits: string }> = [];
  /** Every `placeCall` destination, in order. */
  readonly callsPlaced: string[] = [];
  /** Every `bridgeHolder` call, in order. */
  readonly holdersBridged: Array<{ callId: string; holderPhone: string }> = [];
  /** Calls ended through `hangUp`. */
  readonly hungUp: string[] = [];

  private readonly calls = new Map<string, LiveCall>();
  private readonly handlers = new Map<TelephonyEvent, Set<(payload: never) => void>>();

  constructor(private readonly fixture: TelephonyFixture) {}

  on<E extends TelephonyEvent>(
    event: E,
    handler: (payload: TelephonyEventMap[E]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const fn = handler as (payload: never) => void;
    set.add(fn);
    return () => {
      this.handlers.get(event)?.delete(fn);
    };
  }

  private emit<E extends TelephonyEvent>(event: E, payload: TelephonyEventMap[E]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never);
  }

  async placeCall(to: string): Promise<{ callId: string }> {
    this.callsPlaced.push(to);
    const callId = `sim-${randomUUID()}`;
    this.calls.set(callId, { index: 0, alive: true, audioQueue: [], audioWaiters: [] });
    queueMicrotask(() => {
      const call = this.calls.get(callId);
      if (!call?.alive) return;
      this.emit("answered", { callId });
      this.emitTurn(callId, call);
    });
    return { callId };
  }

  async sendDigits(callId: string, digits: string): Promise<void> {
    const call = this.calls.get(callId);
    // Recorded even on a dead call: the runner is the source of truth, and
    // the script may have ended while it was still working a turn.
    this.digitsSent.push({ callId, digits });
    if (!call?.alive) return;
    const turn = this.fixture.turns[call.index];
    const next = turn?.nextOnDigits?.[digits];
    if (next === undefined || !this.fixture.turns[next]) {
      await this.endCall(callId, "completed");
      return;
    }
    call.index = next;
    queueMicrotask(() => this.emitTurn(callId, call));
  }

  async *audio(callId: string): AsyncIterable<Uint8Array> {
    const call = this.calls.get(callId);
    if (!call) return;
    for (;;) {
      const chunk = call.audioQueue.shift();
      if (chunk) {
        yield chunk;
        continue;
      }
      if (!call.alive) return;
      await new Promise<void>((resolve) => {
        call.audioWaiters.push(resolve);
      });
    }
  }

  async bridgeHolder(callId: string, holderPhone: string): Promise<void> {
    if (!this.calls.has(callId)) return;
    // Recorded even when the script already ended: the runner bridges while
    // working a turn, and the join still arrives on its own 2 s timer.
    this.holdersBridged.push({ callId, holderPhone });
    setTimeout(() => this.emit("holder_joined", { callId }), 2000);
  }

  async hangUp(callId: string): Promise<void> {
    this.hungUp.push(callId);
    await this.endCall(callId, "hung-up");
  }

  private pushAudio(call: LiveCall, chunk: Uint8Array): void {
    call.audioQueue.push(chunk);
    for (const resolve of call.audioWaiters.splice(0)) resolve();
  }

  private emitTurn(callId: string, call: LiveCall): void {
    if (!call.alive) return;
    const turn = this.fixture.turns[call.index];
    if (!turn) {
      void this.endCall(callId, "completed");
      return;
    }
    let text: string | null = turn.text;
    if (turn.audio) {
      try {
        // One chunk per turn: the runner pulls it and transcribes it.
        this.pushAudio(call, readAudioFile(turn.audio));
        text = null;
      } catch {
        // The spec's STT-down fallback: fixture text is the transcript.
        text = turn.text;
      }
    }
    const payload: TranscriptTurn = {
      callId,
      speaker: turn.speaker,
      text,
      durationS: turn.durationS ?? null,
      expectsDigits: turn.expectsDigits ?? false,
    };
    this.emit("transcript", payload);
    if (!payload.expectsDigits) {
      call.index += 1;
      queueMicrotask(() => this.emitTurn(callId, call));
    }
  }

  private async endCall(callId: string, reason: "completed" | "hung-up"): Promise<void> {
    const call = this.calls.get(callId);
    if (!call?.alive) return;
    call.alive = false;
    for (const resolve of call.audioWaiters.splice(0)) resolve();
    this.emit("ended", { callId, reason });
  }
}

function readAudioFile(name: string): Uint8Array {
  // Resolved from the working directory (a static import would make the
  // bundler chase a dynamic path); the basename guard keeps fixtures from
  // escaping `public/demo/`.
  const safe = basename(name);
  if (safe !== name || safe.length === 0) throw new Error("Bad audio fixture name");
  return new Uint8Array(readFileSync(join(process.cwd(), "public", "demo", safe)));
}
