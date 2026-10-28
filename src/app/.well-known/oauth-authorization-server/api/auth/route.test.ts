import { describe, expect, it } from "vitest";

import { env } from "~/shared/config/env";
import { GET } from "./route";

describe("GET /.well-known/oauth-authorization-server/api/auth", () => {
  it("serves the Better Auth authorization-server metadata", async () => {
    const response = await GET(
      new Request("http://localhost/.well-known/oauth-authorization-server/api/auth"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
      scopes_supported?: string[];
    };
    expect(body.issuer).toBe(`${env.BETTER_AUTH_URL}/api/auth`);
    expect(body.authorization_endpoint).toContain("/oauth2/authorize");
    expect(body.token_endpoint).toContain("/oauth2/token");
    // Dynamic client registration is explicitly enabled for MCP clients.
    expect(body.registration_endpoint).toContain("/oauth2/register");
    expect(body.scopes_supported).toContain("ripcord");
  });
});
