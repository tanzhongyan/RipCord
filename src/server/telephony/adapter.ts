import { env } from "~/shared/config/env";

/** Who is speaking on a transcript turn. */
export type TurnSpeaker = "IVR" | "REP" | "HOLDER";

/** One transcribed speaker turn, redacted by the caller before storage. */
export interface TranscriptTurn {
  callId: string;
  speaker: TurnSpeaker;
  /** Null when the turn's audio must be transcribed first. */
  text: string | null;
  /** Turn length in seconds, when the adapter knows it. */
  durationS: number | null;
  /** True when the turn waits for the runner to send digits. */
  expectsDigits: boolean;
}

export interface CallAnswered {
  callId: string;
}

export interface CallEnded {
  callId: string;
  reason: "completed" | "hung-up" | "failed" | "timeout";
}

export interface HolderJoined {
  callId: string;
}

export type TelephonyEventMap = {
  answered: CallAnswered;
  ended: CallEnded;
  transcript: TranscriptTurn;
  holder_joined: HolderJoined;
};

export type TelephonyEvent = keyof TelephonyEventMap;

/**
 * Phone backend (spec 0005). `audio` yields PCM 16 kHz chunks, one per turn
 * for fixture audio; live adapters feed it from the media stream. Events
 * always carry the `callId`, so one runner can serve many calls.
 */
export interface TelephonyAdapter {
  placeCall(to: string): Promise<{ callId: string }>;
  sendDigits(callId: string, digits: string): Promise<void>;
  audio(callId: string): AsyncIterable<Uint8Array>;
  bridgeHolder(callId: string, holderPhone: string): Promise<void>;
  hangUp(callId: string): Promise<void>;
  on<E extends TelephonyEvent>(
    event: E,
    handler: (payload: TelephonyEventMap[E]) => void,
  ): () => void;
}

let override: TelephonyAdapter | null = null;

/** Test seam: substitute a fake adapter. Pass null to restore the factory. */
export function setTelephonyOverride(adapter: TelephonyAdapter | null): void {
  override = adapter;
}

/**
 * The configured adapter: `simulated` fixtures by default, `twilio` for
 * live calls. Only a live case may use `twilio`, and the caller passes
 * that in; sandbox cases always get `simulated`. The test override wins
 * over both.
 */
export async function getTelephonyAdapter(
  opts: { live: boolean } = { live: false },
): Promise<TelephonyAdapter> {
  if (override) return override;
  if (opts.live && env.TELEPHONY_PROVIDER === "twilio") {
    const { TwilioAdapter } = await import("./twilio");
    return new TwilioAdapter();
  }
  const { SimulatedAdapter, loadDemoFixture } = await import("./simulated");
  return new SimulatedAdapter(loadDemoFixture());
}
