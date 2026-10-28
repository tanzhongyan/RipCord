import { describe, expect, it } from "vitest";

import {
  extractWithModel,
  fakeExtractWithModel,
  modelExtractionSchema,
  parseModelExtraction,
} from "./model";

describe("model extraction seam", () => {
  it("points the default at spec 0004", async () => {
    await expect(extractWithModel({ url: "https://example.com", text: "hi" })).rejects.toThrow(
      /spec 0004/,
    );
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
