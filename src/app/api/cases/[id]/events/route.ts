import { ToolError } from "~/features/cases/server/errors";
import {
  loadCallerForEvents,
  loadOwnedCaseForEvents,
  streamCaseEvents,
} from "~/features/cases/server/events-stream";
import { auth } from "~/server/auth/auth";

/**
 * `GET /api/cases/[id]/events`: the case owner's live event stream
 * (`status`, `step`, `transcript`, `card`, `holder_joined`). The stream
 * opens with a `status` snapshot, then forwards the Valkey channel.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return Response.json(
      { code: "UNAUTHORIZED", message: "Authentication required" },
      { status: 401 },
    );
  }
  const caller = await loadCallerForEvents(session.user.id);
  try {
    await loadOwnedCaseForEvents(id, caller);
  } catch (error) {
    if (error instanceof ToolError && error.code === "NOT_FOUND") {
      return Response.json({ code: "NOT_FOUND", message: "Case not found" }, { status: 404 });
    }
    throw error;
  }
  const stream = new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const frame of streamCaseEvents(id, caller, { signal: req.signal })) {
          controller.enqueue(frame);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      // The generator's `signal` aborts through `req.signal`; nothing to close.
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
