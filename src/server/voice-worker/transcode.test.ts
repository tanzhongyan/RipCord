import { describe, expect, it } from "vitest";

import { mulaw8kToPcm16k, mulawDecodeSample, mulawToPcm16, upsample8kTo16k } from "./transcode";

describe("mu-law transcode", () => {
  it("decodes silence and extremes", () => {
    // Both zero codes decode to silence.
    expect(mulawDecodeSample(0xff)).toBe(0);
    expect(mulawDecodeSample(0x7f)).toBe(0);
    // Maximum codes carry the largest magnitudes, opposite signs.
    expect(mulawDecodeSample(0x00)).toBeLessThan(-30000);
    expect(mulawDecodeSample(0x80)).toBeGreaterThan(30000);
  });

  it("decodes frames sample by sample", () => {
    const samples = mulawToPcm16(new Uint8Array([0xff, 0x00]));
    expect(samples.length).toBe(2);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(mulawDecodeSample(0x00));
  });

  it("upsamples 8 kHz to 16 kHz by doubling", () => {
    const upsampled = upsample8kTo16k(new Int16Array([100, -50]));
    expect([...upsampled]).toEqual([100, 100, -50, -50]);
  });

  it("converts one media payload to little-endian PCM 16 kHz", () => {
    const bytes = mulaw8kToPcm16k(new Uint8Array([0xff, 0x00]));
    expect(bytes.length).toBe(8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(4, true)).toBe(mulawDecodeSample(0x00));
  });
});
