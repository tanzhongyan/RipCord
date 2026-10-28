import { describe, expect, it } from "vitest";

import type { TranscriptTurn } from "./adapter";
import { loadDemoFixture, parseFixture, SimulatedAdapter } from "./simulated";

describe("simulated adapter", () => {
  it("loads the demo-telco fixture", () => {
    const fixture = loadDemoFixture();
    expect(fixture.slug).toBe("demo-telco");
    expect(fixture.turns.length).toBeGreaterThanOrEqual(4);
    expect(fixture.turns[0]?.expectsDigits).toBe(true);
  });

  it("rejects bad fixtures", () => {
    expect(() => parseFixture({})).toThrow();
    expect(() => parseFixture({ slug: "x", turns: [] })).toThrow();
    expect(() => parseFixture({ slug: "x", turns: [{ speaker: "ALIEN", text: "hi" }] })).toThrow();
  });

  it("answers, plays turns in digit order, and ends", async () => {
    const adapter = new SimulatedAdapter({
      slug: "menu",
      turns: [
        {
          speaker: "IVR",
          text: "Press 3.",
          durationS: 2,
          expectsDigits: true,
          nextOnDigits: { "3": 1 },
        },
        { speaker: "REP", text: "Hello.", durationS: 3 },
      ],
    });
    const seen: Array<{ event: string; payload: unknown }> = [];
    adapter.on("answered", (payload) => seen.push({ event: "answered", payload }));
    adapter.on("transcript", (payload) =>
      seen.push({ event: `transcript:${(payload as TranscriptTurn).speaker}`, payload }),
    );
    adapter.on("ended", (payload) => seen.push({ event: "ended", payload }));
    const { callId } = await adapter.placeCall("+15005550006");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen.map((entry) => entry.event)).toEqual(["answered", "transcript:IVR"]);
    await adapter.sendDigits(callId, "3");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.map((entry) => entry.event)).toEqual([
      "answered",
      "transcript:IVR",
      "transcript:REP",
      "ended",
    ]);
    expect(adapter.callsPlaced).toEqual(["+15005550006"]);
    expect(adapter.digitsSent).toEqual([{ callId, digits: "3" }]);
  });

  it("ends the call on an unmapped digit", async () => {
    const adapter = new SimulatedAdapter({
      slug: "menu",
      turns: [
        { speaker: "IVR", text: "Press 3.", expectsDigits: true, nextOnDigits: { "3": 1 } },
        { speaker: "REP", text: "Hello." },
      ],
    });
    let ended = 0;
    adapter.on("ended", () => {
      ended += 1;
    });
    const { callId } = await adapter.placeCall("+15005550006");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await adapter.sendDigits(callId, "9");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toBe(1);
  });

  it("emits holder_joined after bridgeHolder", async () => {
    const adapter = new SimulatedAdapter(loadDemoFixture());
    let joined = 0;
    adapter.on("holder_joined", () => {
      joined += 1;
    });
    const { callId } = await adapter.placeCall("+15005550006");
    await adapter.bridgeHolder(callId, "+6590000000");
    expect(adapter.holdersBridged).toEqual([{ callId, holderPhone: "+6590000000" }]);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(joined).toBe(1);
  });

  it("falls back to fixture text when the audio file is missing", async () => {
    const adapter = new SimulatedAdapter({
      slug: "audio",
      turns: [{ speaker: "IVR", text: "Spoken menu.", audio: "no-such-file.wav" }],
    });
    const transcripts: TranscriptTurn[] = [];
    adapter.on("transcript", (payload) => transcripts.push(payload));
    await adapter.placeCall("+15005550006");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.text).toBe("Spoken menu.");
  });
});
