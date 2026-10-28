import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";

import { auth } from "~/server/auth/auth";

const metadata = oauthProviderAuthServerMetadata(auth);

/**
 * `GET /.well-known/oauth-authorization-server/api/auth`: RFC 8414
 * metadata for the Better Auth authorization server, served from the
 * plugin's own config (issuer, endpoints, supported scopes and grants).
 */
export async function GET(request: Request): Promise<Response> {
  return metadata(request);
}
