import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { db } from "~/server/db";
import { llmUsage } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import {
  type ChatMessage,
  complete,
  completeJson,
  hasImagePart,
  resolveModel,
  stream,
} from "./adapter";
import {
  budgetForOwnerKey,
  costMicrosForUsage,
  currentPeriod,
  ModelError,
  parsePrices,
  priceFor,
} from "./budget";
import { lastFakeRequest, setFakeResponses } from "./fake";
import { MODEL_RETRY_DELAY_MS, MODEL_TIMEOUT_MS } from "./meta";

const REDACTED_TEXT: ChatMessage = { role: "user", content: "summarise this bill", redacted: true };
const RAW_TEXT: ChatMessage = { role: "user", content: "summarise this bill", redacted: false };
const IMAGE: ChatMessage = {
  role: "user",
  content: [{ type: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
  redacted: true,
};

const MODELS = { standard: "std-model", contributor: "con-model" };

function ownerKey(): string {
  return `user:${randomUUID()}`;
}

describe("B1 Tier rule", () => {
  it("forces an image request to the standard model", async () => {
    setFakeResponses([{ text: "seen" }]);
    const result = await complete(
      { tier: "contributor", messages: [IMAGE], ownerKey: null },
      { provider: "fake" },
    );
    expect(result.model).toBe(env.MODEL_STANDARD);
    expect(lastFakeRequest()?.model).toBe(env.MODEL_STANDARD);
  });

  it("forces unredacted text to the standard model", () => {
    expect(resolveModel("contributor", [RAW_TEXT], MODELS)).toBe("std-model");
    expect(resolveModel("contributor", [REDACTED_TEXT, RAW_TEXT], MODELS)).toBe("std-model");
  });

  it("keeps fully redacted text on the contributor tier", () => {
    expect(resolveModel("contributor", [REDACTED_TEXT], MODELS)).toBe("con-model");
    expect(resolveModel("standard", [REDACTED_TEXT], MODELS)).toBe("std-model");
  });

  it("spots image parts", () => {
    expect(hasImagePart(IMAGE)).toBe(true);
    expect(hasImagePart(REDACTED_TEXT)).toBe(false);
  });
});

describe("B2 Budget", () => {
  it("defaults to US$2 per individual and US$20 per org", () => {
    expect(env.MODEL_BUDGET_USER_MICROS).toBe(2000000);
    expect(env.MODEL_BUDGET_ORG_MICROS).toBe(20000000);
    expect(budgetForOwnerKey("user:1", { userMicros: 2, orgMicros: 20 })).toBe(2);
    expect(budgetForOwnerKey("org:1", { userMicros: 2, orgMicros: 20 })).toBe(20);
  });

  it("refuses an over-budget owner before any transport work", async () => {
    const key = ownerKey();
    const period = currentPeriod(new Date());
    await db.insert(llmUsage).values({
      ownerKey: key,
      period,
      tokensIn: 100,
      tokensOut: 100,
      costMicros: env.MODEL_BUDGET_USER_MICROS,
    });
    setFakeResponses([{ text: "must not be consumed" }]);
    await expect(
      complete(
        { tier: "contributor", messages: [REDACTED_TEXT], ownerKey: key },
        { provider: "fake" },
      ),
    ).rejects.toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
    // The scripted answer is untouched: no transport call happened.
    const result = await complete(
      { tier: "contributor", messages: [REDACTED_TEXT], ownerKey: null },
      { provider: "fake" },
    );
    expect(result.text).toBe("must not be consumed");
  });

  it("records spend per owner and month", async () => {
    const key = ownerKey();
    const period = currentPeriod(new Date());
    setFakeResponses([{ text: "ok", tokensIn: 10, tokensOut: 5 }]);
    const result = await complete(
      { tier: "contributor", messages: [REDACTED_TEXT], ownerKey: key },
      { provider: "fake" },
    );
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.ownerKey, key)).limit(1);
    expect(row?.period).toBe(period);
    expect(row?.tokensIn).toBe(10);
    expect(row?.tokensOut).toBe(5);
    expect(row?.costMicros).toBe(result.usage.costMicros);
    expect(result.usage.costMicros).toBeGreaterThan(0);
  });
});

describe("model pricing", () => {
  it("prices tokens in micro-dollars from USD-per-million rates", () => {
    const prices = parsePrices('{"default":{"input":1,"output":3}}');
    expect(costMicrosForUsage(prices, "anything", 10, 5)).toBe(25);
    expect(
      priceFor(parsePrices('{"m":{"input":2,"output":4},"default":{"input":1,"output":1}}'), "m"),
    ).toEqual({
      input: 2,
      output: 4,
    });
  });

  it("rejects bad price config instead of serving free calls", () => {
    expect(() => parsePrices("nope")).toThrow(ModelError);
    expect(() => parsePrices('{"default":{"input":-1,"output":1}}')).toThrow(ModelError);
    expect(() => priceFor(parsePrices("{}"), "m")).toThrow(ModelError);
  });
});

function chatCompletionResponse(text: string): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  });
}

describe("meta transport", () => {
  it("retries once on HTTP 429 after 2 s", async () => {
    expect(MODEL_TIMEOUT_MS).toBe(30000);
    expect(MODEL_RETRY_DELAY_MS).toBe(2000);
    const slept: number[] = [];
    let calls = 0;
    const stubFetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { message: "slow down", type: "rate_limit" } }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return chatCompletionResponse("recovered");
    }) as typeof fetch;
    const result = await complete(
      { tier: "standard", messages: [RAW_TEXT], ownerKey: null },
      {
        provider: "meta",
        apiKey: "test-key",
        fetch: stubFetch,
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(result.text).toBe("recovered");
    expect(calls).toBe(2);
    expect(slept).toEqual([2000]);
    expect(result.usage.tokensIn).toBe(5);
    expect(result.usage.tokensOut).toBe(7);
  });

  it("times out slow calls", async () => {
    const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    await expect(
      complete(
        { tier: "standard", messages: [RAW_TEXT], ownerKey: null },
        { provider: "meta", apiKey: "test-key", fetch: hangingFetch, timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});

describe("completeJson", () => {
  const schema = z.object({ a: z.number() });

  it("retries once on a parse failure, then validates with Zod", async () => {
    setFakeResponses([{ text: "not json" }, { text: '{"a":1}' }]);
    const result = await completeJson(
      { tier: "contributor", messages: [REDACTED_TEXT], ownerKey: null },
      schema,
      { provider: "fake" },
    );
    expect(result.data).toEqual({ a: 1 });
    expect(result.attempts).toBe(2);
  });

  it("fails after two bad answers", async () => {
    setFakeResponses([{ text: "nope" }, { text: "still nope" }]);
    await expect(
      completeJson({ tier: "contributor", messages: [REDACTED_TEXT], ownerKey: null }, schema, {
        provider: "fake",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("stream", () => {
  it("yields chunks and records usage once drained", async () => {
    const key = ownerKey();
    setFakeResponses([{ text: "hello", chunks: ["he", "llo"], tokensIn: 4, tokensOut: 6 }]);
    const live = await stream(
      { tier: "contributor", messages: [REDACTED_TEXT], ownerKey: key },
      { provider: "fake" },
    );
    let text = "";
    for await (const piece of live.chunks) text += piece;
    expect(text).toBe("hello");
    const usage = await live.usage();
    expect(usage.tokensIn).toBe(4);
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.ownerKey, key)).limit(1);
    expect(row?.tokensOut).toBe(6);
  });
});
