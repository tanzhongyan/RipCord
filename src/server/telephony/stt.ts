import { env } from "~/shared/config/env";

/** Speech-to-text model (spec 0005). */
export const STT_MODEL = "muse-voice-transcribe-1.0";

export interface TranscribeResult {
  text: string;
}

export interface TranscribeDeps {
  fetch?: typeof fetch;
}

/**
 * Transcribe one audio turn: `POST /v1/asr/transcribe` on the Meta base
 * URL. Fixture audio files take this path. The caller redacts the text
 * before storage or model use; this module never stores anything.
 */
export async function transcribeFile(
  audio: Uint8Array,
  deps: TranscribeDeps = {},
): Promise<TranscribeResult> {
  const runFetch = deps.fetch ?? fetch;
  const base = env.META_BASE_URL.replace(/\/$/, "");
  const response = await runFetch(`${base}/asr/transcribe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.META_API_KEY ?? ""}`,
      "Content-Type": "audio/wav",
    },
    body: audio as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Transcription failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("Transcription response has no text");
  }
  return { text: payload.text };
}

/** Live-call realtime endpoint, derived from the Meta base URL. */
export function realtimeTranscribeUrl(): string {
  return `${env.META_BASE_URL.replace(/^http/, "ws").replace(/\/$/, "")}/asr/realtime`;
}

export interface RealtimeTurn {
  text: string;
  speaker: string | null;
  final: boolean;
}

export interface RealtimeTranscriberDeps {
  /** WebSocket constructor. Tests substitute a fake. */
  webSocket?: typeof WebSocket;
}

export interface RealtimeTranscriber {
  sendAudio(chunk: Uint8Array): void;
  close(): void;
}

/**
 * Live-call transcription over the realtime WebSocket, with the service's
 * turn detection and speaker labels. Frames flow caller-to-service as
 * binary; turns arrive as `{ text, speaker, final }` JSON messages.
 */
export function startRealtimeTranscription(
  onTurn: (turn: RealtimeTurn) => void,
  deps: RealtimeTranscriberDeps = {},
): RealtimeTranscriber {
  const WS = deps.webSocket ?? WebSocket;
  const socket = new WS(realtimeTranscribeUrl(), ["asr.meta.v1"]);
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const parsed = JSON.parse(event.data) as Partial<RealtimeTurn>;
      if (typeof parsed.text !== "string" || typeof parsed.final !== "boolean") return;
      onTurn({
        text: parsed.text,
        speaker: typeof parsed.speaker === "string" ? parsed.speaker : null,
        final: parsed.final,
      });
    } catch {
      return;
    }
  };
  return {
    sendAudio(chunk: Uint8Array): void {
      if (socket.readyState === 1) socket.send(chunk.slice().buffer);
    },
    close(): void {
      socket.close();
    },
  };
}
