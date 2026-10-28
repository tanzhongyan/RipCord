import { mcpProtectedResourceMetadata } from "~/features/chat";

/**
 * `GET /.well-known/oauth-protected-resource/api/mcp`: RFC 9728 metadata
 * for the MCP resource server. Names the Better Auth issuer so clients
 * discover where to authorize.
 */
export async function GET(): Promise<Response> {
  return Response.json(mcpProtectedResourceMetadata());
}
