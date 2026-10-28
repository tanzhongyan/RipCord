import { describe, expect, it } from "vitest";

import {
  type RealtimeTurn,
  realtimeTranscribeUrl,
  STT_MODEL,
  startRealtimeTranscription,
  transcribeFile,
} from "./stt";

describe("speech-to-text", () => {
  it("names the Muse Voice Transcribe model", () => {
    expect(STT_MODEL).toBe("muse-voice-transcribe-1.0");
  });

  it("derives the realtime URL from the Meta base URL", () => {
    expect(realtimeTranscribeUrl()).toBe("wss://api.meta.ai/v1/asr/realtime");
  });

  it("posts fixture audio to the transcribe endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const stubFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ text: "Press 3 to cancel." }), { status: 200 });
    }) as unknown as typeof fetch;

    const { text } = await transcribeFile(new Uint8Array([1, 2, 3]), { fetch: stubFetch });

    expect(text).toBe("Press 3 to cancel.");
    expect(calls).toHaveLength(1);
    const first = calls[0];
    if (!first) throw new Error("transcribe call missing");
    expect(first.url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect((first.init.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
  });

  it("throws on HTTP errors and bad payloads", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(transcribeFile(new Uint8Array([1]), { fetch: failing })).rejects.toThrow(
      "Transcription failed with HTTP 500",
    );
    const mistyped = (async () =>
      new Response(JSON.stringify({ words: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(transcribeFile(new Uint8Array([1]), { fetch: mistyped })).rejects.toThrow(
      "Transcription response has no text",
    );
  });

  it("streams live turns over the realtime socket", () => {
    const turns: RealtimeTurn[] = [];
    const sent: unknown[] = [];
    let closed = false;
    const sockets: Array<{
      readyState: number;
      send: (data: unknown) => void;
      close: () => void;
      onmessage: ((event: { data: unknown }) => void) | null;
      url: string;
      protocols: string[];
    }> = [];
    const FakeWebSocket = class {
      readyState = 1;
      onmessage: ((event: { data: unknown }) => void) | null = null;

      constructor(
        readonly url: string,
        readonly protocols: string[],
      ) {
        sockets.push(this);
      }

      send(data: unknown): void {
        sent.push(data);
      }

      close(): void {
        closed = true;
      }
    };

    const transcriber = startRealtimeTranscription((turn) => turns.push(turn), {
      webSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    expect(sockets[0]?.url).toBe("wss://api.meta.ai/v1/asr/realtime");
    transcriber.sendAudio(new Uint8Array([9]));
    expect(sent).toHaveLength(1);
    sockets[0]?.onmessage?.({
      data: JSON.stringify({ text: "hello", speaker: "REP", final: true }),
    });
    sockets[0]?.onmessage?.({ data: "not json" });
    sockets[0]?.onmessage?.({ data: JSON.stringify({ text: "partial" }) });
    expect(turns).toEqual([{ text: "hello", speaker: "REP", final: true }]);
    transcriber.close();
    expect(closed).toBe(true);
  });
});
