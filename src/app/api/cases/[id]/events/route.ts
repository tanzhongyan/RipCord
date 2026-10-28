import { authorizeCaseRoute, streamCaseEvents } from "~/features/cases/server/events-stream";

/**
 * `GET /api/cases/[id]/events`: the case owner's live event stream
 * (`status`, `step`, `transcript`, `card`, `holder_joined`). The stream
 * opens with a `status` snapshot, then forwards the Valkey channel.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authed = await authorizeCaseRoute(req, id);
  if ("response" in authed) return authed.response;
  const caller = authed.caller;
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
