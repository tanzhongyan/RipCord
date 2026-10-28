import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { setValkeyOverride } from "~/features/identity";
import { db } from "~/server/db";
import { auditLogs, creditLedger, llmUsage } from "~/server/db/schema";
import { ToolError } from "../errors";
import {
  FakeValkey,
  seedCase,
  seedHolder,
  seedStep,
  seedUser,
  testToolContext,
} from "../test-support";
import {
  DISPATCH_READ_PER_MINUTE,
  DISPATCH_WRITE_PER_MINUTE,
  dispatchRateLimitKey,
  dispatchToolCall,
  summarizeToolCall,
} from "./dispatch";

afterEach(() => {
  setValkeyOverride(null);
});

function attachInput(caseId: string) {
  return {
    caseId,
    kind: "BILL",
    contentType: "application/pdf",
    contentLength: 100,
  };
}

describe("dispatchToolCall", () => {
  it("answers UNKNOWN_TOOL for unknown and executor-only names", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const ctx = testToolContext(user.id);
    for (const name of ["no-such-tool", "send-notice-email", "place-call", "hang-up"]) {
      await expect(
        dispatchToolCall({ name, input: {}, ctx, transport: "mcp" }),
      ).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });
    }
  });

  it("validates input before the PII guard", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const ctx = testToolContext(user.id);
    // Invalid uuid AND an NRIC: Zod (check 3) runs before the PII guard (check 4).
    await expect(
      dispatchToolCall({
        name: "create-case",
        input: { holderId: "not-a-uuid", note: "S1234567D" },
        ctx,
        transport: "chat",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("still rejects personal identifiers in valid input", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const ctx = testToolContext(user.id);
    await expect(
      dispatchToolCall({
        name: "create-case",
        input: { holderId: holder.id, note: "S1234567D" },
        ctx,
        transport: "chat",
      }),
    ).rejects.toMatchObject({ code: "PII_NOT_ALLOWED" });
  });

  it("returns CONFIRM_REQUIRED with a summary and consumes no credit", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    const ctx = testToolContext(user.id);
    const error = await dispatchToolCall({
      name: "start-case",
      input: { caseId: c.id },
      ctx,
      transport: "mcp",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect((error as ToolError).details).toEqual({ summary: expect.stringContaining("1 credit") });
    const [consumed] = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(and(eq(creditLedger.caseId, c.id), eq(creditLedger.reason, "CONSUME")))
      .limit(1);
    expect(consumed).toBeUndefined();
  });

  it("summarizes every confirm tool in one line", () => {
    expect(summarizeToolCall("start-case", { caseId: "c1" })).toContain("1 credit");
    expect(summarizeToolCall("request-mandate", { caseId: "c1", maxFeeCents: 500 })).toContain(
      "S$5.00",
    );
    expect(summarizeToolCall("approve-step", { caseId: "c1", stepId: "s1" })).toContain("s1");
    expect(summarizeToolCall("record-receipt", { caseId: "c1", referenceCode: "R1" })).toContain(
      "R1",
    );
    expect(summarizeToolCall("report-bill-check", { caseId: "c1", result: "NO_REBILL" })).toContain(
      "NO_REBILL",
    );
    expect(summarizeToolCall("withdraw-case", { caseId: "c1" })).toContain("no refund");
  });

  it("rate-limits MCP writes at 10 per minute with separate chat buckets", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DISCOVERY" });
    const ctx = testToolContext(user.id);
    for (let i = 0; i < DISPATCH_WRITE_PER_MINUTE; i++) {
      await expect(
        dispatchToolCall({
          name: "attach-document",
          input: attachInput(c.id),
          ctx,
          transport: "mcp",
        }),
      ).resolves.toMatchObject({ documentId: expect.any(String) });
    }
    await expect(
      dispatchToolCall({
        name: "attach-document",
        input: attachInput(c.id),
        ctx,
        transport: "mcp",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // The chat bucket is untouched: the same write succeeds there.
    await expect(
      dispatchToolCall({
        name: "attach-document",
        input: attachInput(c.id),
        ctx,
        transport: "chat",
      }),
    ).resolves.toMatchObject({ documentId: expect.any(String) });
  });

  it("keys rate limits by transport, budget and user", () => {
    expect(dispatchRateLimitKey("mcp", "write", "u1")).toBe("mcp-write:u1");
    expect(dispatchRateLimitKey("chat", "read", "u1")).toBe("chat-read:u1");
    expect(DISPATCH_READ_PER_MINUTE).toBe(60);
    expect(DISPATCH_WRITE_PER_MINUTE).toBe(10);
  });

  it("writes one audit row per write tool and none for reads", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DISCOVERY" });
    const ctx = testToolContext(user.id);
    await dispatchToolCall({ name: "list-cases", input: { page: 1 }, ctx, transport: "chat" });
    const before = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.actorId, user.id), eq(auditLogs.action, "TOOL_CALL")));
    expect(before).toHaveLength(0);
    await dispatchToolCall({
      name: "attach-document",
      input: attachInput(c.id),
      ctx,
      transport: "mcp",
    });
    const after = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorId, user.id), eq(auditLogs.action, "TOOL_CALL")));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      actorType: "AGENT",
      targetType: "tool",
      targetId: "attach-document",
      caseId: c.id,
      metadata: { transport: "mcp", budget: "write" },
    });
  });

  it("redacts personal identifiers from outputs", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DISCOVERY" });
    await seedStep(c.id, { args: { transcript: "rep asked for NRIC S1234567D" } });
    const ctx = testToolContext(user.id);
    const output = await dispatchToolCall({
      name: "get-case",
      input: { caseId: c.id },
      ctx,
      transport: "mcp",
    });
    expect(JSON.stringify(output)).not.toContain("S1234567D");
  });

  it("re-throws model budget errors with the contract code", async () => {
    setValkeyOverride(new FakeValkey());
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "EXECUTING" });
    const period = new Date().toISOString().slice(0, 7);
    await db.insert(llmUsage).values({
      ownerKey: `user:${user.id}`,
      period,
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 999_999_999,
    });
    const ctx = testToolContext(user.id);
    const error = await dispatchToolCall({
      name: "draft-chat-reply",
      input: { caseId: c.id, inboundText: "hello" },
      ctx,
      transport: "chat",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "MODEL_BUDGET_EXCEEDED" });
  });
});
