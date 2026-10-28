import { describe, expect, it } from "vitest";

import { setFakeResponses } from "~/server/model/fake";
import {
  createScrapeExtractor,
  extractWithModel,
  fakeExtractWithModel,
  modelExtractionSchema,
  parseModelExtraction,
  SCRAPE_RUN_SPEND_CAP_MICROS,
} from "./model";

describe("model extraction seam", () => {
  it("routes the default through the 0004 adapter on the contributor tier", async () => {
    expect(SCRAPE_RUN_SPEND_CAP_MICROS).toBe(1000000);
    setFakeResponses([{ text: JSON.stringify({ channels: [], policies: [] }) }]);
    const extraction = await extractWithModel({ url: "https://example.com", text: "hi" });
    expect(extraction).toEqual({ channels: [], policies: [] });
  });

  it("validates answers with the schema and retries once", async () => {
    const extract = createScrapeExtractor();
    setFakeResponses([
      { text: "not json" },
      { text: JSON.stringify({ channels: [], policies: [] }) },
    ]);
    const extraction = await extract({ url: "https://example.com", text: "hi" });
    expect(extraction.policies).toEqual([]);
  });

  it("aborts on the shared spend cap before calling the model", async () => {
    const state = { spentMicros: SCRAPE_RUN_SPEND_CAP_MICROS };
    const extract = createScrapeExtractor({ state });
    setFakeResponses([{ text: JSON.stringify({ channels: [], policies: [] }) }]);
    await expect(extract({ url: "https://example.com", text: "hi" })).rejects.toMatchObject({
      code: "MODEL_BUDGET_EXCEEDED",
    });
    // The scripted answer is untouched: the cap fired before the model call.
    setFakeResponses([]);
    const fresh = createScrapeExtractor({ state: { spentMicros: 0 } });
    setFakeResponses([{ text: JSON.stringify({ channels: [], policies: [] }) }]);
    await expect(fresh({ url: "https://example.com", text: "hi" })).resolves.toEqual({
      channels: [],
      policies: [],
    });
  });

  it("accumulates spend across calls on shared state", async () => {
    const state = { spentMicros: 0 };
    const extract = createScrapeExtractor({ state });
    setFakeResponses([
      { text: JSON.stringify({ channels: [], policies: [] }), tokensIn: 10, tokensOut: 5 },
      { text: JSON.stringify({ channels: [], policies: [] }), tokensIn: 10, tokensOut: 5 },
    ]);
    await extract({ url: "https://a.example.com", text: "a" });
    const afterFirst = state.spentMicros;
    expect(afterFirst).toBeGreaterThan(0);
    await extract({ url: "https://b.example.com", text: "b" });
    expect(state.spentMicros).toBe(afterFirst * 2);
  });

  it("returns a fresh copy of the canned extraction per call", async () => {
    const canned = parseModelExtraction({ channels: [], policies: [] });
    const fake = fakeExtractWithModel(canned);
    const first = await fake({ url: "https://a.example.com", text: "a" });
    const second = await fake({ url: "https://b.example.com", text: "b" });
    expect(first).toEqual({ channels: [], policies: [] });
    expect(second).not.toBe(first);
  });

  it("validates the schema and fills defaults", () => {
    const parsed = modelExtractionSchema.parse({
      channels: [{ kind: "EMAIL", address: "a@example.com", acceptsLoa: "YES", confidence: 80 }],
    });
    expect(parsed.channels[0]?.serviceType).toBeNull();
    expect(parsed.channels[0]?.quote).toBe("");
    expect(parsed.policies).toEqual([]);
    expect(() => parseModelExtraction({ channels: [{ kind: "PIGEON" }] })).toThrow();
  });
});
