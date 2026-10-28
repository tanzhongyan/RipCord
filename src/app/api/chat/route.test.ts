import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSmsOutbox,
  findMandateForCase,
  seedAccountSecret,
  seedCase,
  seedHolder,
  seedProvider,
  seedTerms,
  seedUser,
} from "~/features/cases/server/test-support";
import { type ChatEvent, chatEventSchema } from "~/features/chat/schemas/chat";
import { setSmsOverride, setValkeyOverride } from "~/features/identity";
import { FakeValkey } from "~/features/identity/server/test-support";
import { auth } from "~/server/auth/auth";
import { setFakeResponses } from "~/server/model/fake";
import { POST } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
  setValkeyOverride(null);
  setSmsOverride(null);
  setFakeResponses([]);
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
      name: "Chat User",
      email: "chat@example.com",
      emailVerified: true,
      banned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

async function readEvents(response: Response): Promise<ChatEvent[]> {
  const text = await response.text();
  const events: ChatEvent[] = [];
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const parsed = chatEventSchema.safeParse(JSON.parse(line.slice("data: ".length)));
      if (parsed.success) events.push(parsed.data);
    }
  }
  return events;
}

function chatRequest(body: unknown) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setupMandateCase() {
  const user = await seedUser();
  const provider = await seedProvider();
  const holder = await seedHolder(user.id);
  await seedAccountSecret(holder.id);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    status: "AWAITING_MANDATE",
  });
  await seedTerms(c.id, { etfEstimateCents: 30000 });
  return { user, c };
}

describe("POST /api/chat", () => {
  it("rejects callers without a session", async () => {
    const response = await POST(chatRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects empty and oversized message lists", async () => {
    const user = await seedUser();
    mockSession(user.id);
    const empty = await POST(chatRequest({ messages: [] }));
    expect(empty.status).toBe(400);
    const many = await POST(
      chatRequest({
        messages: Array.from({ length: 41 }, () => ({ role: "user", content: "hi" })),
      }),
    );
    expect(many.status).toBe(400);
  });

  it("answers NOT_FOUND for a foreign case", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const holder = await seedHolder(other.id);
    const c = await seedCase({ ownerId: other.id, holderId: holder.id });
    mockSession(user.id);
    const response = await POST(
      chatRequest({ messages: [{ role: "user", content: "hi" }], caseId: c.id }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("B9 pauses a confirm tool for approval, then runs it after Confirm", async () => {
    const { user, c } = await setupMandateCase();
    setValkeyOverride(new FakeValkey());
    setSmsOverride(createSmsOutbox().sender);
    mockSession(user.id);
    const toolText =
      `I will request the mandate now.\n` +
      "```tool-call\n" +
      JSON.stringify({
        name: "request-mandate",
        args: { caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 500 },
      }) +
      "\n```";
    setFakeResponses([
      { text: toolText },
      { text: "The mandate request is sent. I will wait for the signature." },
    ]);

    const first = await POST(
      chatRequest({
        messages: [{ role: "user", content: "Please cancel this service." }],
        caseId: c.id,
      }),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const firstEvents = await readEvents(first);
    const confirm = firstEvents.find((event) => event.type === "confirm_request");
    expect(confirm).toMatchObject({ name: "request-mandate" });
    expect(firstEvents.at(-1)).toMatchObject({ type: "done" });
    expect(await findMandateForCase(c.id)).toBeUndefined();

    // The user clicks Confirm: the client resends with the approval.
    const second = await POST(
      chatRequest({
        messages: [
          { role: "user", content: "Please cancel this service." },
          { role: "assistant", content: toolText },
        ],
        caseId: c.id,
        approvals: [
          {
            name: "request-mandate",
            args: { caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 500 },
          },
        ],
      }),
    );
    expect(second.status).toBe(200);
    const secondEvents = await readEvents(second);
    const result = secondEvents.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ name: "request-mandate", ok: true });
    expect(secondEvents.at(-1)).toMatchObject({ type: "done" });
    expect(await findMandateForCase(c.id)).toMatchObject({ status: "PENDING" });
  });
});
