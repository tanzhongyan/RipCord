import OpenAI from "openai";

import type { ChatMessage } from "./adapter";
import { ModelError } from "./budget";

/** Per-call timeout: 30 s. */
export const MODEL_TIMEOUT_MS = 30_000;
/** Pause before the single retry on HTTP 429 or 5xx. */
export const MODEL_RETRY_DELAY_MS = 2000;

export interface MetaTransportOpts {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface MetaCall {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
}

export interface MetaResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }
    // Image parts only ever ride on user messages; the SDK types the
    // three roles separately, so the parts array casts to the union.
    const content = message.content.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image_url" as const, image_url: { url: part.dataUrl } },
    );
    return { role: message.role, content } as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

function isAbort(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError") ||
    error instanceof OpenAI.APIConnectionTimeoutError
  );
}

function statusOf(error: unknown): number | null {
  if (error instanceof OpenAI.APIError) return error.status;
  return null;
}

function isRetriable(error: unknown): boolean {
  const status = statusOf(error);
  return status !== null && (status === 429 || status >= 500);
}

function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (isAbort(error)) return new ModelError("INTERNAL_ERROR", "Model call timed out");
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return new ModelError("INTERNAL_ERROR", "Model authentication failed");
  }
  return new ModelError(
    "INTERNAL_ERROR",
    error instanceof Error ? `Model call failed: ${error.message}` : "Model call failed",
  );
}

function createClient(call: MetaCall, opts: MetaTransportOpts): OpenAI {
  if (!call.apiKey) {
    throw new ModelError("INTERNAL_ERROR", "META_API_KEY is not set");
  }
  return new OpenAI({
    apiKey: call.apiKey,
    baseURL: call.baseUrl,
    maxRetries: 0,
    fetch: opts.fetch,
  });
}

function extractText(choice: OpenAI.Chat.ChatCompletion["choices"][number] | undefined): string {
  return choice?.message?.content ?? "";
}

/**
 * One chat completion against the Meta endpoint. A single retry follows an
 * HTTP 429 or 5xx after 2 s; anything else throws at once. Abort (timeout)
 * never retries.
 */
export async function metaComplete(
  call: MetaCall,
  opts: MetaTransportOpts = {},
): Promise<MetaResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? MODEL_TIMEOUT_MS;
  const client = createClient(call, opts);
  const params = {
    model: call.model,
    messages: toOpenAIMessages(call.messages),
    ...(call.maxTokens === undefined ? {} : { max_tokens: call.maxTokens }),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await client.chat.completions.create(params, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return {
        text: extractText(response.choices[0]),
        tokensIn: response.usage?.prompt_tokens ?? 0,
        tokensOut: response.usage?.completion_tokens ?? 0,
      };
    } catch (error) {
      clearTimeout(timer);
      if (attempt === 0 && isRetriable(error)) {
        await sleep(MODEL_RETRY_DELAY_MS);
        continue;
      }
      throw toModelError(error);
    }
  }
  throw new ModelError("INTERNAL_ERROR", "Model call failed");
}

export interface MetaStreamResult {
  chunks: AsyncIterable<string>;
  usage: () => Promise<{ tokensIn: number; tokensOut: number }>;
}

/**
 * Streaming completion. Usage arrives on the final chunk
 * (`stream_options.include_usage`); the caller awaits `usage()` after the
 * stream ends to record it. No retry: a broken stream restarts from the top
 * at the caller's level, not mid-stream.
 */
export async function metaStream(
  call: MetaCall,
  opts: MetaTransportOpts = {},
): Promise<MetaStreamResult> {
  const timeoutMs = opts.timeoutMs ?? MODEL_TIMEOUT_MS;
  const client = createClient(call, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
  try {
    stream = await client.chat.completions.create(
      {
        model: call.model,
        messages: toOpenAIMessages(call.messages),
        ...(call.maxTokens === undefined ? {} : { max_tokens: call.maxTokens }),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: controller.signal },
    );
  } catch (error) {
    clearTimeout(timer);
    throw toModelError(error);
  }

  let tokensIn = 0;
  let tokensOut = 0;
  async function* chunks(): AsyncGenerator<string> {
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens ?? 0;
          tokensOut = chunk.usage.completion_tokens ?? 0;
        }
      }
    } catch (error) {
      throw toModelError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { chunks: chunks(), usage: async () => ({ tokensIn, tokensOut }) };
}
