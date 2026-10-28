import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import {
  dispatchToolCall,
  listMcpTools,
  liveToolContext,
  loadAgentPrompt,
  ToolError,
} from "~/features/cases";
import { type Database, db, type Transaction } from "~/server/db";
import { cases, members } from "~/server/db/schema";
import { logger } from "~/server/logger";
import { type ChatMessage, stream } from "~/server/model/adapter";
import { ModelError } from "~/server/model/budget";
import { redactMany } from "~/server/vault";
import type { ChatApprovalInput, ChatEvent, ChatMessageInput } from "../schemas/chat";

/** Tool-call rounds per turn (0000 limits). */
const AGENT_MAX_TOOL_ROUNDS = 12;

interface ChatCaller {
  userId: string;
  orgIds: string[];
}

interface ChatContext {
  holderId: string | null;
  ownerKey: string;
}

/** The caller's identity for the chat loop: user plus org memberships. */
export async function loadChatCaller(userId: string): Promise<ChatCaller> {
  const rows = await db
    .select({ orgId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId));
  return { userId, orgIds: rows.map((row) => row.orgId) };
}

/**
 * Resolve the chat context before streaming: the owned case (when given)
 * sets the holder for redaction and the owner key for the model budget.
 * A missing or foreign case answers `NOT_FOUND`.
 */
export async function resolveChatContext(
  caseId: string | undefined,
  caller: ChatCaller,
): Promise<ChatContext> {
  if (!caseId) return { holderId: null, ownerKey: `user:${caller.userId}` };
  const ownership = [eq(cases.ownerUserId, caller.userId)];
  if (caller.orgIds.length > 0) ownership.push(inArray(cases.orgId, caller.orgIds));
  const [c] = await db
    .select({ holderId: cases.holderId, orgId: cases.orgId })
    .from(cases)
    .where(and(eq(cases.id, caseId), or(...ownership)))
    .limit(1);
  if (!c) throw new ToolError("NOT_FOUND", "Case not found");
  return { holderId: c.holderId, ownerKey: c.orgId ? `org:${c.orgId}` : `user:${caller.userId}` };
}

const toolCallJson = z.object({
  name: z.string().min(1).max(80),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** The last ```tool-call block, or null when absent or invalid. */
function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const matches = [...text.matchAll(/```tool-call\s*\n([\s\S]*?)```/g)];
  const last = matches[matches.length - 1]?.[1];
  if (last === undefined) return null;
  try {
    return toolCallJson.parse(JSON.parse(last) as unknown);
  } catch {
    return null;
  }
}

function hasToolCallBlock(text: string): boolean {
  return text.includes("```tool-call");
}

function toolCatalog(): string {
  return listMcpTools()
    .map((def) => {
      let schema: unknown;
      try {
        schema = z.toJSONSchema(def.input as z.ZodType);
      } catch {
        schema = {};
      }
      return `- ${def.name}${def.confirm ? " (needs confirmation)" : ""}: ${def.description} Input: ${JSON.stringify(schema)}`;
    })
    .join("\n");
}

function systemPrompt(): string {
  return (
    `${loadAgentPrompt()}\n\n` +
    "You can call tools. To call one, end your message with a fenced block:\n" +
    "```tool-call\n" +
    '{"name": "<tool>", "args": { ... }}\n' +
    "```\n" +
    "Call one tool per message. After the result arrives, continue with the next step. " +
    "For tools marked as needing confirmation, state exactly what will happen and call the tool " +
    "anyway: the chat shows the user a confirm card and runs the call only after approval.\n" +
    "Available tools:\n" +
    `${toolCatalog()}`
  );
}

interface RunAgentOpts {
  messages: ChatMessageInput[];
  approvals?: ChatApprovalInput[];
  context: ChatContext;
  caller: ChatCaller;
  signal?: AbortSignal;
  /** Connection for the history redaction; `db` unless a test counts queries. */
  conn?: Database | Transaction;
}

function frame(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function stripCodePrefix(message: string): string {
  return message.replace(/^\[[A-Z_]+\] /, "");
}

/**
 * The in-app chat agent loop (specs 0004 and 0006): at most 12 tool rounds
 * per turn over the shared dispatcher (`transport: "chat"`), streaming SSE
 * frames. Confirm tools pause the turn with `confirm_request`; the client
 * resends with `approvals` after the user confirms. Nothing is stored: the
 * case page stays the durable record.
 */
export async function* runAgentLoop(opts: RunAgentOpts): AsyncGenerator<string> {
  const ctx = liveToolContext(opts.caller.userId, opts.caller.orgIds);
  const history: ChatMessage[] = [{ role: "system", content: systemPrompt(), redacted: true }];
  // One batched redaction for the whole history: a per-message loop would
  // re-run the identical vault fetch and decryption for every message.
  const contents = await redactMany(
    opts.conn ?? db,
    opts.messages.map((message) => message.content),
    opts.context.holderId,
  );
  for (const [index, message] of opts.messages.entries()) {
    history.push({ role: message.role, content: contents[index] ?? "", redacted: true });
  }

  let calls = 0;
  const nextCallId = () => {
    calls += 1;
    return `c${calls}`;
  };

  for (const approval of opts.approvals ?? []) {
    const callId = nextCallId();
    yield frame({ type: "tool_call", callId, name: approval.name, args: approval.args });
    try {
      const result = await dispatchToolCall({
        name: approval.name,
        input: { ...approval.args, confirm: true },
        ctx,
        transport: "chat",
      });
      yield frame({ type: "tool_result", callId, name: approval.name, ok: true, result });
      history.push(
        {
          role: "assistant",
          content: `Running ${approval.name} with your confirmation.`,
          redacted: true,
        },
        {
          role: "user",
          content: `Tool ${approval.name} result: ${JSON.stringify(result)}`,
          redacted: true,
        },
      );
    } catch (error) {
      if (error instanceof ToolError) {
        yield frame({
          type: "tool_result",
          callId,
          name: approval.name,
          ok: false,
          code: error.code,
          message: stripCodePrefix(error.message),
        });
        history.push({
          role: "user",
          content: `Tool ${approval.name} failed: [${error.code}] ${stripCodePrefix(error.message)}`,
          redacted: true,
        });
        continue;
      }
      throw error;
    }
  }

  for (let round = 0; round < AGENT_MAX_TOOL_ROUNDS; round++) {
    if (opts.signal?.aborted) return;
    let text = "";
    try {
      const completion = await stream({
        tier: "contributor",
        messages: history,
        ownerKey: opts.context.ownerKey,
      });
      for await (const chunk of completion.chunks) {
        text += chunk;
        yield frame({ type: "token", text: chunk });
      }
      await completion.usage();
    } catch (error) {
      if (error instanceof ModelError) {
        yield frame({ type: "error", code: error.code, message: stripCodePrefix(error.message) });
        return;
      }
      throw error;
    }
    const call = parseToolCall(text);
    if (!call) {
      if (hasToolCallBlock(text)) {
        history.push(
          { role: "assistant", content: text, redacted: true },
          {
            role: "user",
            content:
              "That tool call was not valid JSON. Reply again with one valid ```tool-call block or a plain answer.",
            redacted: true,
          },
        );
        continue;
      }
      yield frame({ type: "done" });
      return;
    }
    const callId = nextCallId();
    yield frame({ type: "tool_call", callId, name: call.name, args: call.args });
    try {
      const result = await dispatchToolCall({
        name: call.name,
        input: call.args,
        ctx,
        transport: "chat",
      });
      yield frame({ type: "tool_result", callId, name: call.name, ok: true, result });
      history.push(
        { role: "assistant", content: text, redacted: true },
        {
          role: "user",
          content: `Tool ${call.name} result: ${JSON.stringify(result)}`,
          redacted: true,
        },
      );
    } catch (error) {
      if (error instanceof ToolError && error.code === "CONFIRM_REQUIRED") {
        const details = error.details as { summary?: unknown } | undefined;
        const summary =
          typeof details?.summary === "string" ? details.summary : stripCodePrefix(error.message);
        yield frame({ type: "confirm_request", callId, name: call.name, args: call.args, summary });
        yield frame({ type: "done" });
        return;
      }
      if (error instanceof ToolError) {
        yield frame({
          type: "tool_result",
          callId,
          name: call.name,
          ok: false,
          code: error.code,
          message: stripCodePrefix(error.message),
        });
        history.push(
          { role: "assistant", content: text, redacted: true },
          {
            role: "user",
            content: `Tool ${call.name} failed: [${error.code}] ${stripCodePrefix(error.message)}`,
            redacted: true,
          },
        );
        continue;
      }
      throw error;
    }
  }
  const notice =
    "I hit my tool limit for this turn. Ask me to continue and I will pick up where I left off.";
  yield frame({ type: "token", text: notice });
  yield frame({ type: "done" });
  logger.info("Chat turn exhausted its tool rounds");
}
