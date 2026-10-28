import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setStorageOverride } from "~/features/cases";
import {
  FakeStorage,
  seedBillingCustomer,
  seedCase,
  seedCredit,
  seedHolder,
} from "~/features/cases/server/test-support";
import { setValkeyOverride } from "~/features/identity";
import { FakeValkey, seedUser } from "~/features/identity/server/test-support";
import { auth } from "~/server/auth/auth";
import { env } from "~/shared/config/env";
import { GET, POST } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
  setValkeyOverride(null);
  setStorageOverride(null);
});

function mockSession(userId: string) {
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
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      banned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

describe("B10 Log hygiene", () => {
  it("never logs request PII when a request fails", async () => {
    const user = await seedUser();
    vi.spyOn(auth.api, "getSession").mockResolvedValue({
      session: {
        id: "session-id",
        userId: user.id,
        token: "session-token",
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: true,
        banned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(
      new Request("http://localhost/api/trpc/holders.S1234567D?batch=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "0": { json: { alias: "Dad", phone: "S1234567D" } },
        }),
      }) as NextRequest,
    );
    expect(res.status).toBe(404);
    const payload = JSON.stringify(await res.json());
    expect(payload).toContain("S1234567D");

    const logged = error.mock.calls
      .flat()
      .map((arg) => String(arg))
      .join("\n");
    expect(error).toHaveBeenCalled();
    expect(logged).not.toContain("1234567");
    expect(logged).toContain("[NRIC]");
  });
});

describe("chat router over HTTP", () => {
  it("status reports credits and the AI allowance", async () => {
    const user = await seedUser();
    mockSession(user.id);
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 3, reason: "PURCHASE" });
    const res = (await GET(
      new Request(
        `http://localhost/api/trpc/chat.status?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: {} } }))}`,
      ) as NextRequest,
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ result?: { data?: { json?: unknown } } }>;
    expect(body[0]?.result?.data?.json).toEqual({
      credits: 3,
      aiSpentMicros: 0,
      aiBudgetMicros: env.MODEL_BUDGET_USER_MICROS,
    });
  });

  it("attachDocument runs through the dispatcher with transport chat", async () => {
    setValkeyOverride(new FakeValkey());
    setStorageOverride(new FakeStorage());
    const user = await seedUser();
    mockSession(user.id);
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DISCOVERY" });
    const res = (await POST(
      new Request("http://localhost/api/trpc/chat.attachDocument?batch=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "0": {
            json: {
              caseId: c.id,
              kind: "BILL",
              contentType: "application/pdf",
              contentLength: 100,
            },
          },
        }),
      }) as NextRequest,
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ result?: { data?: { json?: unknown } } }>;
    expect(body[0]?.result?.data?.json).toMatchObject({
      documentId: expect.any(String),
      uploadUrl: expect.stringContaining("https://"),
    });
  });

  it("attachDocument refuses a foreign case", async () => {
    setValkeyOverride(new FakeValkey());
    setStorageOverride(new FakeStorage());
    const user = await seedUser();
    mockSession(user.id);
    const other = await seedUser();
    const holder = await seedHolder(other.id);
    const c = await seedCase({ ownerId: other.id, holderId: holder.id, status: "DISCOVERY" });
    const res = (await POST(
      new Request("http://localhost/api/trpc/chat.attachDocument?batch=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "0": {
            json: {
              caseId: c.id,
              kind: "BILL",
              contentType: "application/pdf",
              contentLength: 100,
            },
          },
        }),
      }) as NextRequest,
    )) as Response;
    expect(res.status).toBe(404);
    const body = (await res.json()) as Array<{
      error?: { json?: { message?: string; data?: { code?: string } } };
    }>;
    expect(body[0]?.error?.json?.data?.code).toBe("NOT_FOUND");
  });
});
