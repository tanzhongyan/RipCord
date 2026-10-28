import { eq } from "drizzle-orm";

import { db } from "~/server/db";
import { caseSteps } from "~/server/db/schema";
import {
  type RealtimeTranscriber,
  startRealtimeTranscription,
  TwilioAdapter,
} from "~/server/telephony";
import { env } from "~/shared/config/env";
import {
  abortLiveSession,
  createLiveSession,
  handleLiveTurn,
  type LiveSession,
  settleLiveSession,
} from "./call-session";
import { mulaw8kToPcm16k } from "./transcode";

/** The slice of `Bun.serve` this worker uses (the runtime provides it). */
declare const Bun: {
  serve(opts: {
    port: number;
    fetch(
      req: Request,
      server: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
    ): Response | undefined;
    websocket: {
      message(ws: WorkerSocket, raw: string | Uint8Array): void | Promise<void>;
      close(ws: WorkerSocket): void | Promise<void>;
    };
  }): { port: number | string; stop(): void };
};

interface WorkerSocket {
  data: unknown;
  close(): void;
}

type StreamMessage =
  | { event: "connected" }
  | { event: "start"; callSid: string; streamSid: string }
  | { event: "media"; payload: string }
  | { event: "stop" }
  | { event: "other" };

/** Parse one Twilio media-stream frame; anything unexpected is `other`. */
export function parseStreamMessage(data: unknown): StreamMessage {
  if (typeof data !== "object" || data === null) return { event: "other" };
  const record = data as Record<string, unknown>;
  switch (record.event) {
    case "connected":
      return { event: "connected" };
    case "start": {
      const start = record.start as Record<string, unknown> | undefined;
      if (typeof start?.callSid === "string" && typeof start?.streamSid === "string") {
        return { event: "start", callSid: start.callSid, streamSid: start.streamSid };
      }
      return { event: "other" };
    }
    case "media": {
      const media = record.media as Record<string, unknown> | undefined;
      if (typeof media?.payload === "string") return { event: "media", payload: media.payload };
      return { event: "other" };
    }
    case "stop":
      return { event: "stop" };
    default:
      return { event: "other" };
  }
}

interface SocketState {
  session: LiveSession | null;
  stt: RealtimeTranscriber | null;
  /** Turns handle in arrival order, one at a time. */
  chain: Promise<void>;
  settled: boolean;
}

function freshState(): SocketState {
  return { session: null, stt: null, chain: Promise.resolve(), settled: false };
}

async function settleSocket(state: SocketState): Promise<void> {
  if (state.settled) return;
  state.settled = true;
  state.stt?.close();
  const session = state.session;
  if (!session) return;
  await state.chain;
  const [step] = await db.select().from(caseSteps).where(eq(caseSteps.id, session.stepId)).limit(1);
  // An aborted or failed step already ran its aftermath; anything else
  // settles from the transcript now, failing the step when it throws.
  if (step && step.status !== "RUNNING") return;
  await settleLiveSession(session, { adapter: session.adapter });
}

/**
 * Voice worker (`bun run voice-worker`): serves the Twilio media-stream
 * WebSocket at `/twilio/stream`. Media frames transcode μ-law 8 kHz to PCM
 * 16 kHz for realtime transcription; final turns drive the shared call
 * session (menus, cards, holder bridge, receipt extraction). Call audio is
 * never stored: frames stream through and are discarded.
 */
export function serveVoiceWorker(port: number): { stop: () => void } {
  const adapter = new TwilioAdapter();
  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/twilio/stream" && server.upgrade(req, { data: freshState() })) {
        return undefined;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      async message(ws, raw) {
        const state = ws.data as SocketState;
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
        } catch {
          return;
        }
        const message = parseStreamMessage(parsed);
        if (message.event === "start") {
          const session = await createLiveSession(message.callSid, message.streamSid, {
            adapter,
            close: () => {
              try {
                ws.close();
              } catch {
                // Already closed.
              }
            },
          });
          if (!session) {
            ws.close();
            return;
          }
          state.session = session;
          state.stt = startRealtimeTranscription((turn) => {
            if (!turn.final || state.settled) return;
            const sessionNow = state.session;
            if (!sessionNow) return;
            state.chain = state.chain.then(() =>
              handleLiveTurn(
                sessionNow,
                { text: turn.text, speakerLabel: turn.speaker },
                { adapter },
              ).catch(() => abortLiveSession(sessionNow, "INTERNAL_ERROR", "The call failed")),
            );
          });
          return;
        }
        if (message.event === "media") {
          if (!state.session || state.settled) return;
          try {
            const pcm = mulaw8kToPcm16k(new Uint8Array(Buffer.from(message.payload, "base64")));
            state.stt?.sendAudio(pcm);
          } catch {
            return;
          }
          return;
        }
        if (message.event === "stop") {
          await settleSocket(state);
        }
      },
      async close(ws) {
        await settleSocket(ws.data as SocketState);
      },
    },
  });
  console.log(`voice-worker listening on :${server.port}`);
  return { stop: () => server.stop() };
}

// Serving starts only for `bun run voice-worker`; imports (tests, knip)
// get the pure message parser without binding the port.
if (import.meta.main) {
  const workerUrl = new URL(env.VOICE_WORKER_URL);
  serveVoiceWorker(Number(workerUrl.port) || 3101);
}
