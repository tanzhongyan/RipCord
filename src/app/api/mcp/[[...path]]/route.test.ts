import { afterEach, describe, expect, it } from "vitest";
import { setStorageOverride } from "~/features/cases";
import {
  FakeStorage,
  seedAccountSecret,
  seedBillingCustomer,
  seedCase,
  seedChannel,
  seedCredit,
  seedHolder,
  seedPolicy,
  seedProvider,
  seedStep,
  seedUser,
} from "~/features/cases/server/test-support";
import { isDevBypass, mcpAuthMode, setMcpAuthStub } from "~/features/chat";
import { setValkeyOverride } from "~/features/identity";
import {
  callerFor,
  FakeValkey as IdentityFakeValkey,
  seedOauthGrant,
} from "~/features/identity/server/test-support";
import { GET, OPTIONS, POST } from "./route";

afterEach(() => {
  setMcpAuthStub(null);
  setValkeyOverride(null);
  setStorageOverride(null);
});

/** Seed an OAuth client + consent grant and stub its Bearer [REDACTED] */
async function stubGrant(userId: string, token: string, clientName = "Test Agent") {
  const { clientId } = await seedOauthGrant(userId, clientName);
  setMcpAuthStub((candidate) =>
    candidate === token ? { userId, clientId, scopes: ["ripcord"] } : null,
  );
  return { clientId };
}

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** Parse the JSON-RPC envelope out of a JSON or SSE response body. */
async function readEnvelope(response: Response): Promise<JsonRpcEnvelope> {
  const text = await response.text();
  if (!text.includes("\n")) return JSON.parse(text) as JsonRpcEnvelope;
  const entries = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);
  return (entries.find(
    (entry) =>
      typeof entry === "object" && entry !== null && ("result" in entry || "error" in entry),
  ) ?? {}) as JsonRpcEnvelope;
}

/** Parse a JSON-RPC result out of a JSON or SSE response body. */
async function readResult(
  response: Response,
): Promise<
  { tools?: Array<{ name: string; annotations?: Record<string, unknown> }> } & Record<
    string,
    unknown
  >
> {
  const envelope = await readEnvelope(response);
  return (envelope.result ?? {}) as {
    tools?: Array<{ name: string; annotations?: Record<string, unknown> }>;
  } & Record<string, unknown>;
}

interface ToolCallText {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** The text payload of a `tools/call` result. */
function toolText(result: Record<string, unknown>): { text: string; isError: boolean } {
  const call = result as unknown as ToolCallText;
  return { text: call.content?.[0]?.text ?? "", isError: call.isError === true };
}

function mcpRequest(method: string, params: unknown, init: { token?: string } = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("POST /api/mcp", () => {
  it("B2 answers 401 with WWW-Authenticate when no token is sent", async () => {
    const response = await POST(mcpRequest("tools/list", {}));
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata");
  });

  it("B3 lists exactly the non-executor registry tools", async () => {
    const user = await seedUser();
    await stubGrant(user.id, "b3-token");
    const response = await POST(mcpRequest("tools/list", {}, { token: "b3-token" }));
    expect(response.status).toBe(200);
    const result = await readResult(response);
    const names = (result.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "accept-recommendation",
        "approve-step",
        "attach-document",
        "create-case",
        "draft-chat-reply",
        "extract-document",
        "get-case",
        "get-provider",
        "list-cases",
        "list-holders",
        "record-receipt",
        "report-bill-check",
        "request-mandate",
        "search-providers",
        "start-case",
        "withdraw-case",
      ].sort(),
    );
    for (const absent of [
      "send-notice-email",
      "place-call",
      "send-digits",
      "bridge-holder",
      "hang-up",
    ]) {
      expect(names).not.toContain(absent);
    }
    const byName = new Map((result.tools ?? []).map((tool) => [tool.name, tool.annotations ?? {}]));
    expect(byName.get("search-providers")).toMatchObject({ readOnlyHint: true });
    expect(byName.get("start-case")).toMatchObject({ destructiveHint: true });
    expect(byName.get("get-case")).toMatchObject({ readOnlyHint: true });
  });

  it("B4 rejects start-case without confirm and consumes no credit", async () => {
    setValkeyOverride(new IdentityFakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1, reason: "PURCHASE" });
    await stubGrant(user.id, "b4-token");
    const response = await POST(
      mcpRequest(
        "tools/call",
        { name: "start-case", arguments: { caseId: c.id } },
        { token: "b4-token" },
      ),
    );
    expect(response.status).toBe(200);
    const { text, isError } = toolText(await readResult(response));
    expect(isError).toBe(true);
    expect(JSON.parse(text) as unknown).toMatchObject({
      code: "CONFIRM_REQUIRED",
      summary: expect.stringContaining("1 credit"),
    });
    const status = await callerFor(user.id, []).chat.status();
    expect(status.credits).toBe(1);
  });

  it("B6 rate-limits the 11th MCP write call within a minute", async () => {
    setValkeyOverride(new IdentityFakeValkey());
    setStorageOverride(new FakeStorage());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DISCOVERY" });
    await stubGrant(user.id, "b6-token");
    const call = () =>
      POST(
        mcpRequest(
          "tools/call",
          {
            name: "attach-document",
            arguments: {
              caseId: c.id,
              kind: "BILL",
              contentType: "application/pdf",
              contentLength: 100,
            },
          },
          { token: "b6-token" },
        ),
      );
    for (let i = 0; i < 10; i++) {
      const response = await call();
      expect(response.status).toBe(200);
      expect(toolText(await readResult(response)).isError).toBe(false);
    }
    const limited = await call();
    expect(limited.status).toBe(200);
    const { text, isError } = toolText(await readResult(limited));
    expect(isError).toBe(true);
    expect(JSON.parse(text) as unknown).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("B7 redacts vault values from MCP outputs", async () => {
    setValkeyOverride(new IdentityFakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    await seedAccountSecret(holder.id, "ACC-77777777");
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DISCOVERY" });
    await seedStep(c.id, { args: { reference: "ACC-77777777" } });
    await stubGrant(user.id, "b7-token");
    const response = await POST(
      mcpRequest(
        "tools/call",
        { name: "get-case", arguments: { caseId: c.id } },
        { token: "b7-token" },
      ),
    );
    expect(response.status).toBe(200);
    const { text, isError } = toolText(await readResult(response));
    expect(isError).toBe(false);
    expect(text).not.toContain("ACC-77777777");
    expect(text).toContain("{{vault:ACCOUNT_NO:");
  });

  it("B8 keeps OAuth required outside development, even with the bypass flag", () => {
    expect(isDevBypass("development", true)).toBe(true);
    expect(isDevBypass("development", false)).toBe(false);
    expect(isDevBypass("test", true)).toBe(false);
    expect(isDevBypass("production", true)).toBe(false);
    // This suite runs with NODE_ENV=test: the route below was built with OAuth.
    expect(mcpAuthMode()).toBe("oauth");
  });

  it("B10 answers 401 after the user revokes the client", async () => {
    const user = await seedUser();
    const { clientId } = await stubGrant(user.id, "b10-token");
    const list = () => POST(mcpRequest("tools/list", {}, { token: "b10-token" }));
    expect((await list()).status).toBe(200);
    await callerFor(user.id, []).agents.revoke({ clientId });
    const revoked = await list();
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("reads a provider resource with verified channels and policies only", async () => {
    const user = await seedUser();
    await stubGrant(user.id, "resource-token");
    const provider = await seedProvider({ slug: `resource-${user.id.slice(0, 8)}` });
    const verified = await seedChannel(provider.id, { isVerifiedDestination: true });
    await seedChannel(provider.id, { isVerifiedDestination: false });
    await seedPolicy(provider.id);
    const response = await POST(
      mcpRequest(
        "resources/read",
        { uri: `ripcord://providers/${provider.slug}` },
        { token: "resource-token" },
      ),
    );
    expect(response.status).toBe(200);
    const envelope = await readEnvelope(response);
    const contents = (envelope.result as { contents?: Array<{ text?: string }> } | undefined)
      ?.contents;
    const text = contents?.[0]?.text ?? "";
    const body = JSON.parse(text) as {
      slug: string;
      channels: Array<{ id: string }>;
      policies: Array<{ kind: string }>;
    };
    expect(body.slug).toBe(provider.slug);
    expect(body.channels.map((channel) => channel.id)).toEqual([verified.id]);
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0]).toMatchObject({ kind: "NOTICE_PERIOD" });
  });

  it("answers a resource error for an unknown provider slug", async () => {
    const user = await seedUser();
    await stubGrant(user.id, "resource-404-token");
    const response = await POST(
      mcpRequest(
        "resources/read",
        { uri: "ripcord://providers/no-such-provider" },
        { token: "resource-404-token" },
      ),
    );
    expect(response.status).toBe(200);
    const envelope = await readEnvelope(response);
    expect(envelope.error).toBeDefined();
    expect(envelope.result).toBeUndefined();
  });

  it("declines subscriptions/listen instead of holding a stream open", async () => {
    const response = await POST(mcpRequest("subscriptions/listen", {}));
    expect(response.status).toBe(200);
    const envelope = await readEnvelope(response);
    expect(envelope.error).toMatchObject({ code: -32601 });
  });

  it("gates GET with OAuth and answers OPTIONS preflights", async () => {
    const get = await GET(new Request("http://localhost/api/mcp"));
    expect(get.status).toBe(401);
    const options = await OPTIONS(new Request("http://localhost/api/mcp", { method: "OPTIONS" }));
    expect(options.status).toBe(204);
  });
});
