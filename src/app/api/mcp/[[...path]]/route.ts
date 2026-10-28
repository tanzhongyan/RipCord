import { createNextHandler } from "mcp-use/next";

import { mcpServer } from "~/features/chat";

export const runtime = "nodejs";
export const maxDuration = 300;

const handlers = createNextHandler(mcpServer());

export const { GET, DELETE, OPTIONS } = handlers;

/**
 * `POST /api/mcp`: the MCP Streamable-HTTP endpoint, stateless. A
 * `subscriptions/listen` call is declined with JSON-RPC "method not found"
 * instead of opening a stream, so no subscription holds the function open.
 * Everything else delegates to the `mcp-use` handler (OAuth gate included).
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = (await request.clone().json()) as unknown;
  } catch {
    return handlers.POST(request);
  }
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "subscriptions/listen"
  ) {
    const id = (body as { id?: unknown }).id;
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found: subscriptions/listen" },
        id: typeof id === "string" || typeof id === "number" ? id : null,
      },
      { status: 200 },
    );
  }
  return handlers.POST(request);
}
