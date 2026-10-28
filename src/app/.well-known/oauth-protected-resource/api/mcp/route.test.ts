import { describe, expect, it } from "vitest";

import { env } from "~/shared/config/env";
import { GET } from "./route";

describe("GET /.well-known/oauth-protected-resource/api/mcp", () => {
  it("B1 names the Better Auth issuer for /api/mcp", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toBe(`${env.APP_URL}/api/mcp`);
    expect(body.authorization_servers).toEqual([`${env.BETTER_AUTH_URL}/api/auth`]);
    expect(body.scopes_supported).toContain("ripcord");
  });
});
