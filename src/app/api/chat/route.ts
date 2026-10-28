import { ToolError } from "~/features/cases";
import {
  chatRequestSchema,
  loadChatCaller,
  resolveChatContext,
  runAgentLoop,
} from "~/features/chat";
import { auth } from "~/server/auth/auth";
import { logger } from "~/server/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorFrame = (code: string, message: string): string =>
  `data: ${JSON.stringify({ type: "error", code, message })}\n\n`;

/**
 * `POST /api/chat`: the in-app chat agent stream. Takes `{ messages (≤ 40),
 * caseId?, approvals? }`, runs the agent loop with `transport: "chat"`, and
 * streams SSE (`token`, `tool_call`, `tool_result`, `confirm_request`,
 * `done`, `error`). Needs a Better Auth session. Nothing is stored: the
 * conversation lives in the browser, and tools write only cases, steps and
 * audit rows.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return Response.json(
      { code: "UNAUTHORIZED", message: "Authentication required" },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return Response.json(
      { code: "VALIDATION", message: "Request body is not JSON" },
      { status: 400 },
    );
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      { code: "VALIDATION", message: issue?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const caller = await loadChatCaller(session.user.id);
  let context: { holderId: string | null; ownerKey: string };
  try {
    context = await resolveChatContext(parsed.data.caseId, caller);
  } catch (error) {
    if (error instanceof ToolError && error.code === "NOT_FOUND") {
      return Response.json({ code: "NOT_FOUND", message: "Case not found" }, { status: 404 });
    }
    throw error;
  }
  const frames = runAgentLoop({
    messages: parsed.data.messages,
    approvals: parsed.data.approvals,
    context,
    caller,
    signal: req.signal,
  });
  const encode = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of frames) {
          controller.enqueue(encode.encode(frame));
        }
        controller.close();
      } catch (error) {
        // The loop maps expected errors to frames itself; only the
        // unexpected lands here, with details kept server-side.
        logger.error("Chat turn failed unexpectedly", error instanceof Error ? error : undefined);
        controller.enqueue(encode.encode(errorFrame("INTERNAL_ERROR", "Internal server error")));
        controller.close();
      }
    },
    cancel() {
      // The loop watches `req.signal`; nothing to close.
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
