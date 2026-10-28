import { randomUUID } from "node:crypto";

import { makeSignature } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readConsentClient } from "~/features/identity/server/agents";
import { auth, serverSecret } from "~/server/auth/auth";
import ConsentPage from "./page";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("~/features/identity/server/agents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/features/identity/server/agents")>();
  return { ...mod, readConsentClient: vi.fn(mod.readConsentClient) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSession() {
  const userId = randomUUID();
  vi.spyOn(auth.api, "getSession").mockResolvedValue({
    session: {
      id: "session-id",
      userId,
      token: "session-token",
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: userId,
      name: "Consent User",
      email: "consent@example.com",
      emailVerified: true,
      banned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

/** All text in a rendered element tree, for asserting on page output. */
function renderedText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return renderedText(props?.children);
  }
  return "";
}

function canonicalQuery(params: URLSearchParams): string {
  const sorted = new URLSearchParams();
  const entries = [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
    keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0,
  );
  for (const [key, value] of entries) sorted.append(key, value);
  return sorted.toString();
}

/** A properly signed query that expired long ago. */
async function expiredParams(clientId: string): Promise<Record<string, string>> {
  const search = new URLSearchParams({
    client_id: clientId,
    scope: "ripcord",
    exp: "1",
    ba_iat: "1",
  });
  search.set("sig", await makeSignature(canonicalQuery(search), serverSecret()));
  return Object.fromEntries(search.entries());
}

describe("ConsentPage", () => {
  it("renders the invalid-request message for a tampered query", async () => {
    mockSession();
    const element = await ConsentPage({
      searchParams: Promise.resolve({
        client_id: "tampered-client",
        scope: "ripcord",
        sig: "bogus",
      }),
    });
    expect(renderedText(element)).toContain("expired or is invalid");
  });

  it("renders the invalid-request message for an expired query", async () => {
    mockSession();
    const element = await ConsentPage({
      searchParams: Promise.resolve(await expiredParams("expired-client")),
    });
    expect(renderedText(element)).toContain("expired or is invalid");
  });

  it("re-throws unexpected faults instead of rendering invalid", async () => {
    mockSession();
    vi.mocked(readConsentClient).mockRejectedValueOnce(new Error("database is down"));
    await expect(
      ConsentPage({
        searchParams: Promise.resolve({ client_id: "any-client", scope: "ripcord", sig: "x" }),
      }),
    ).rejects.toThrow("database is down");
  });
});
