import { z } from "zod";

import { valkey } from "~/features/identity";
import { writeAudit } from "~/server/audit";
import { db } from "~/server/db";
import { ModelError } from "~/server/model/budget";
import { redact } from "~/server/vault";
import { ToolError } from "../errors";
import type { ToolContext } from "./context";
import { callTool, getToolDef, type ToolBudget } from "./registry";

type DispatchTransport = "mcp" | "chat";

/** MCP and chat read tools: 60 per minute per user (0000 limits). */
export const DISPATCH_READ_PER_MINUTE = 60;
/** MCP and chat write tools: 10 per minute per user (0000 limits). */
export const DISPATCH_WRITE_PER_MINUTE = 10;

const RATE_WINDOW_SECONDS = 60;

/**
 * Fixed-window rate-limit key. Chat and MCP use separate buckets, so an
 * outside agent cannot drain the in-app chat.
 */
export function dispatchRateLimitKey(
  transport: DispatchTransport,
  budget: ToolBudget,
  userId: string,
): string {
  return `${transport}-${budget}:${userId}`;
}

async function checkRateLimit(
  transport: DispatchTransport,
  budget: ToolBudget,
  userId: string,
): Promise<void> {
  const limit = budget === "read" ? DISPATCH_READ_PER_MINUTE : DISPATCH_WRITE_PER_MINUTE;
  const key = dispatchRateLimitKey(transport, budget, userId);
  const calls = await valkey().incr(key);
  if (calls === 1) await valkey().expire(key, RATE_WINDOW_SECONDS);
  if (calls > limit) {
    throw new ToolError(
      "RATE_LIMITED",
      `${transport} ${budget} tools allow ${limit} calls per minute`,
    );
  }
}

function field(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "?";
}

/**
 * One line saying what a confirm-tool call would do, for the
 * `CONFIRM_REQUIRED` result. Field values come from validated input; only
 * identifiers and counts appear, never personal data.
 */
export function summarizeToolCall(name: string, input: unknown): string {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const caseId = field(record, "caseId");
  switch (name) {
    case "start-case":
      return `Would start case ${caseId}, consuming 1 credit.`;
    case "request-mandate": {
      const maxFee = record.maxFeeCents;
      const fee = typeof maxFee === "number" ? `S$${(maxFee / 100).toFixed(2)}` : "?";
      return `Would ask the holder to sign a mandate for case ${caseId} with fee cap ${fee}.`;
    }
    case "approve-step":
      return `Would approve step ${field(record, "stepId")} on case ${caseId} and run it.`;
    case "record-receipt":
      return `Would record receipt ${field(record, "referenceCode")} for case ${caseId}.`;
    case "report-bill-check":
      return `Would report ${field(record, "result")} for case ${caseId}.`;
    case "withdraw-case":
      return `Would withdraw case ${caseId} with no refund.`;
    default:
      return `Would run ${name} on case ${caseId}.`;
  }
}

interface DispatchInput {
  name: string;
  input: unknown;
  ctx: ToolContext;
  transport: DispatchTransport;
}

/**
 * The shared chat/MCP entry point (spec 0006). Both transports run the same
 * 8 checks in order, so they cannot drift apart:
 *
 * 1. look up the tool (`UNKNOWN_TOOL` for unknown and executor-only names)
 * 2. rate limit in Valkey (fixed one-minute windows, separate chat/MCP buckets)
 * 3. Zod validation
 * 4. PII input guard
 * 5. confirm gate (`CONFIRM_REQUIRED` with a one-line summary)
 * 6. the handler
 * 7. redact the output
 * 8. an `audit_logs` row for every write tool
 *
 * Errors use only 0000 contract codes. Model errors from handlers are
 * re-thrown as `ToolError` with the same code.
 */
export async function dispatchToolCall({
  name,
  input,
  ctx,
  transport,
}: DispatchInput): Promise<unknown> {
  const def = getToolDef(name);
  if (!def) throw new ToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
  await checkRateLimit(transport, def.budget, ctx.userId);
  let parsed: unknown;
  try {
    parsed = def.input.parse(input);
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : "Invalid input";
    throw new ToolError("VALIDATION", message ?? "Invalid input");
  }
  let output: unknown;
  try {
    // The raw input goes to `callTool`, so its PII guard sees exactly what
    // the caller sent; the parse above only orders VALIDATION before it.
    output = await callTool(name, input, ctx);
  } catch (error) {
    if (error instanceof ToolError && error.code === "CONFIRM_REQUIRED") {
      const summary = summarizeToolCall(name, parsed);
      throw new ToolError("CONFIRM_REQUIRED", summary, { summary });
    }
    if (error instanceof ModelError) {
      throw new ToolError(error.code, error.message.replace(/^\[[A-Z_]+\] /, ""));
    }
    throw error;
  }
  const redacted = JSON.parse(await redact(db, JSON.stringify(output), null)) as unknown;
  if (def.budget === "write") {
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    const caseId = typeof record.caseId === "string" ? record.caseId : null;
    await writeAudit(db, {
      actorType: transport === "mcp" ? "AGENT" : "USER",
      actorId: ctx.userId,
      action: "TOOL_CALL",
      targetType: "tool",
      targetId: name,
      caseId,
      metadata: { transport, budget: def.budget },
    });
  }
  return redacted;
}
