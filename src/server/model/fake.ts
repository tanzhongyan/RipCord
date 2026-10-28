import type { ChatMessage } from "./adapter";
import { ModelError } from "./budget";

/** One scripted model answer. Usage defaults to zero tokens. */
export interface FakeResponse {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Streamed pieces; defaults to the whole text at once. */
  chunks?: string[];
}

export interface FakeRequest {
  model: string;
  tier: "standard" | "contributor";
  messages: ChatMessage[];
}

const queue: FakeResponse[] = [];
let lastRequest: FakeRequest | null = null;

/** Queue scripted answers for the `fake` provider. Tests reset with `[]`. */
export function setFakeResponses(responses: FakeResponse[]): void {
  queue.length = 0;
  queue.push(...responses.map((response) => ({ ...response })));
}

/** The last request the fake transport received, or null before the first call. */
export function lastFakeRequest(): FakeRequest | null {
  return lastRequest;
}

export function takeFakeResponse(request: FakeRequest): {
  text: string;
  tokensIn: number;
  tokensOut: number;
  chunks: string[];
} {
  lastRequest = request;
  const next = queue.shift();
  if (!next) {
    throw new ModelError("INTERNAL_ERROR", "No fake model response queued");
  }
  return {
    text: next.text,
    tokensIn: next.tokensIn ?? 0,
    tokensOut: next.tokensOut ?? 0,
    chunks: next.chunks ?? [next.text],
  };
}
