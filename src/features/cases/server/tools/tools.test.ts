import { randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { setValkeyOverride as setIdentityValkey, setSmsOverride } from "~/features/identity";
import { setValkeyOverride as setProvidersValkey } from "~/features/providers";
import { db } from "~/server/db";
import {
  accountHolders,
  auditLogs,
  caseDocuments,
  cases,
  creditLedger,
  mandates,
  providerPolicies,
  verifications,
} from "~/server/db/schema";
import { lastFakeRequest, setFakeResponses } from "~/server/model/fake";
import { env } from "~/shared/config/env";
import { setEventsOverride } from "../events";
import { ExtractionSchema } from "../extraction";
import {
  buildBillPdf,
  createSmsOutbox,
  FakeStorage,
  FakeValkey,
  seedAccountSecret,
  seedBillingCustomer,
  seedCase,
  seedChannel,
  seedCredit,
  seedHolder,
  seedMandate,
  seedProvider,
  seedStep,
  seedTerms,
  seedUser,
  testToolContext,
} from "../test-support";
import { liveToolContext } from "./context";
import { callTool, EXECUTOR_ONLY_TOOLS, listTools } from "./registry";

async function setupDraft() {
  const user = await seedUser();
  const holder = await seedHolder(user.id);
  const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
  return { user, holder, c };
}

async function consumeCount(caseId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(creditLedger)
    .where(and(eq(creditLedger.caseId, caseId), eq(creditLedger.reason, "CONSUME")));
  return row?.n ?? 0;
}

afterEach(() => {
  setFakeResponses([]);
  setIdentityValkey(null);
  setSmsOverride(null);
  setProvidersValkey(null);
  setEventsOverride(null);
});

describe("B6 Confirm gate", () => {
  it("refuses start-case without confirm and consumes no credit", async () => {
    const { user, c } = await setupDraft();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    const ctx = testToolContext(user.id, []);
    await expect(callTool("start-case", { caseId: c.id }, ctx)).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
    await expect(
      callTool("start-case", { caseId: c.id, confirm: false }, ctx),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect(await consumeCount(c.id)).toBe(0);
    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(row?.status).toBe("DRAFT");
  });
});

describe("B7 Scope", () => {
  it("hides another user's case behind NOT_FOUND", async () => {
    const { c } = await setupDraft();
    const stranger = await seedUser();
    await expect(
      callTool("get-case", { caseId: c.id }, testToolContext(stranger.id, [])),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const list = (await callTool("list-cases", {}, testToolContext(stranger.id, []))) as {
      cases: Array<{ id: string }>;
    };
    expect(list.cases.map((row) => row.id)).not.toContain(c.id);
  });
});

describe("B8 PII input guard", () => {
  it("rejects an NRIC in create-case and writes nothing", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const ctx = testToolContext(user.id, []);
    const [before] = await db
      .select({ n: count() })
      .from(cases)
      .where(eq(cases.ownerUserId, user.id));
    await expect(
      callTool("create-case", { holderId: holder.id, note: "holder S1234567D called" }, ctx),
    ).rejects.toMatchObject({ code: "PII_NOT_ALLOWED" });
    const [after] = await db
      .select({ n: count() })
      .from(cases)
      .where(eq(cases.ownerUserId, user.id));
    expect(after?.n).toBe(before?.n);
  });

  it("rejects card numbers and full phones but allows emails", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const ctx = testToolContext(user.id, []);
    await expect(
      callTool("create-case", { holderId: holder.id, note: "card 4111111111111111" }, ctx),
    ).rejects.toMatchObject({ code: "PII_NOT_ALLOWED" });
    await expect(
      callTool("create-case", { holderId: holder.id, note: "call +6591234567" }, ctx),
    ).rejects.toMatchObject({ code: "PII_NOT_ALLOWED" });
    const created = (await callTool(
      "create-case",
      { holderId: holder.id, note: "bill from hello@example.com" },
      ctx,
    )) as { caseId: string };
    expect(created.caseId).toBeDefined();
  });
});

describe("unknown and executor-only tools", () => {
  it("answers UNKNOWN_TOOL", async () => {
    expect([...EXECUTOR_ONLY_TOOLS].sort()).toEqual([
      "bridge-holder",
      "hang-up",
      "place-call",
      "send-digits",
      "send-notice-email",
    ]);
    const user = await seedUser();
    const ctx = testToolContext(user.id, []);
    for (const name of [...EXECUTOR_ONLY_TOOLS, "no-such-tool"]) {
      await expect(callTool(name, {}, ctx)).rejects.toMatchObject({ code: "UNKNOWN_TOOL" });
    }
  });

  it("builds a live context with storage and clock", () => {
    const ctx = liveToolContext("user-1", ["org-1"]);
    expect(ctx.userId).toBe("user-1");
    expect(ctx.orgIds).toEqual(["org-1"]);
    expect(typeof ctx.storage.presignUpload).toBe("function");
    expect(ctx.now()).toBeInstanceOf(Date);
  });

  it("does not trip the PII guard on random ids", async () => {
    // Pinned id whose digit runs look like a card number to the raw pattern.
    const cardLike = "07630642-1013-4d85-a764-4cd25c0dccd6";
    const user = await seedUser();
    await expect(
      callTool("withdraw-case", { caseId: cardLike, confirm: true }, testToolContext(user.id, [])),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("tool table", () => {
  it("declares the spec budget and confirm flag per tool", () => {
    const expected: Record<string, { budget: string; confirm: boolean }> = {
      "search-providers": { budget: "read", confirm: false },
      "get-provider": { budget: "read", confirm: false },
      "list-holders": { budget: "read", confirm: false },
      "create-case": { budget: "write", confirm: false },
      "start-case": { budget: "write", confirm: true },
      "get-case": { budget: "read", confirm: false },
      "list-cases": { budget: "read", confirm: false },
      "attach-document": { budget: "write", confirm: false },
      "extract-document": { budget: "write", confirm: false },
      "accept-recommendation": { budget: "write", confirm: false },
      "request-mandate": { budget: "write", confirm: true },
      "approve-step": { budget: "write", confirm: true },
      "draft-chat-reply": { budget: "write", confirm: false },
      "record-receipt": { budget: "write", confirm: true },
      "report-bill-check": { budget: "write", confirm: true },
      "withdraw-case": { budget: "write", confirm: true },
    };
    const tools = listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(expected).sort());
    for (const tool of tools) {
      expect({ budget: tool.budget, confirm: tool.confirm }).toEqual(expected[tool.name]);
    }
    const start = tools.find((tool) => tool.name === "start-case");
    expect(start?.statuses).toEqual(["DRAFT"]);
    const withdraw = tools.find((tool) => tool.name === "withdraw-case");
    expect(withdraw?.statuses).not.toContain("SUCCEEDED");
  });

  it("gates every confirm tool on confirm: true", async () => {
    const { user, c } = await setupDraft();
    const ctx = testToolContext(user.id, []);
    const calls: Array<[string, unknown]> = [
      ["start-case", { caseId: c.id }],
      ["request-mandate", { caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 0 }],
      ["approve-step", { caseId: c.id, stepId: randomUUID() }],
      ["record-receipt", { caseId: c.id, referenceCode: "R", effectiveDate: "2026-11-01" }],
      ["report-bill-check", { caseId: c.id, result: "NO_REBILL" }],
      ["withdraw-case", { caseId: c.id }],
    ];
    for (const [name, input] of calls) {
      await expect(callTool(name, input, ctx)).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    }
  });
});

describe("case tools", () => {
  it("creates a DRAFT case with an audit note and enforces daily limits", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const ctx = testToolContext(user.id, []);
    const created = (await callTool(
      "create-case",
      { holderId: holder.id, note: "cancel the gym" },
      ctx,
    )) as { caseId: string };
    const [row] = await db.select().from(cases).where(eq(cases.id, created.caseId)).limit(1);
    expect(row?.status).toBe("DRAFT");
    expect(row?.ownerUserId).toBe(user.id);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.caseId, created.caseId), eq(auditLogs.action, "CASE_CREATED")))
      .limit(1);
    expect(audit?.metadata).toMatchObject({ note: "cancel the gym" });

    for (let i = 0; i < 9; i++) {
      await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    }
    await expect(callTool("create-case", { holderId: holder.id }, ctx)).rejects.toMatchObject({
      code: "LIMIT_REACHED",
    });
  });

  it("starts a case on confirm and refuses the wrong status", async () => {
    const { user, c } = await setupDraft();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    const ctx = testToolContext(user.id, []);
    const started = (await callTool("start-case", { caseId: c.id, confirm: true }, ctx)) as {
      status: string;
    };
    expect(started.status).toBe("DISCOVERY");
    expect(await consumeCount(c.id)).toBe(1);
    await expect(callTool("accept-recommendation", { caseId: c.id }, ctx)).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
  });

  it("returns a redacted case view", async () => {
    const { user, holder, c } = await setupDraft();
    const secret = await seedAccountSecret(holder.id, "ACC-VIEW-999");
    await seedTerms(c.id, { equipment: ["router ACC-VIEW-999"] });
    const view = (await callTool("get-case", { caseId: c.id }, testToolContext(user.id, []))) as {
      terms: { equipment: unknown };
    };
    expect(JSON.stringify(view)).not.toContain("ACC-VIEW-999");
    expect(JSON.stringify(view.terms)).toContain(`{{vault:ACCOUNT_NO:${secret.id}}}`);
  });

  it("lists cases 25 per page", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    for (let i = 0; i < 26; i++) {
      await seedCase({ ownerId: user.id, holderId: holder.id, status: "DRAFT" });
    }
    const ctx = testToolContext(user.id, []);
    const first = (await callTool("list-cases", {}, ctx)) as {
      cases: unknown[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(first.cases).toHaveLength(25);
    expect(first.pageSize).toBe(25);
    expect(first.total).toBe(26);
    const second = (await callTool("list-cases", { page: 2 }, ctx)) as { cases: unknown[] };
    expect(second.cases).toHaveLength(1);
  });

  it("issues upload URLs in bill states only", async () => {
    const { user, c } = await setupDraft();
    const ctx = testToolContext(user.id, []);
    await expect(
      callTool(
        "attach-document",
        { caseId: c.id, kind: "BILL", contentType: "application/pdf", contentLength: 100 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await db.update(cases).set({ status: "DISCOVERY" }).where(eq(cases.id, c.id));
    await expect(
      callTool(
        "attach-document",
        { caseId: c.id, kind: "BILL", contentType: "text/plain", contentLength: 100 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const attached = (await callTool(
      "attach-document",
      { caseId: c.id, kind: "BILL", contentType: "application/pdf", contentLength: 100 },
      ctx,
    )) as { documentId: string; uploadUrl: string };
    expect(attached.uploadUrl).toContain(attached.documentId);
    const [doc] = await db
      .select()
      .from(caseDocuments)
      .where(eq(caseDocuments.id, attached.documentId))
      .limit(1);
    expect(doc?.kind).toBe("BILL");
  });
});

describe("extract-document tool", () => {
  async function setupBill() {
    const user = await seedUser();
    // A unique provider name keeps resolution hermetic: the shared test
    // database also holds the seeded demo providers.
    const provider = await seedProvider({ name: `Billtel ${randomUUID()}` });
    await db.insert(providerPolicies).values({
      providerId: provider.id,
      serviceType: null,
      kind: "EARLY_TERMINATION_FEE",
      rule: { formula: "REMAINING_MONTHS_X_MONTHLY_FEE" },
      excerpt: "Fee equals remaining months times the monthly fee.",
      sourceUrl: "https://billtel.test/terms",
      checkedAt: new Date(),
    });
    const holder = await seedHolder(user.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: null,
      status: "DISCOVERY",
    });
    const storage = new FakeStorage();
    const bytes = await buildBillPdf(["Demo Telco bill", "Account No: 1234-5678"]);
    const key = `cases/${c.id}/${randomUUID()}.pdf`;
    await storage.put(key, bytes, "application/pdf");
    const [doc] = await db
      .insert(caseDocuments)
      .values({ caseId: c.id, kind: "BILL", storageKey: key, sha256: "0".repeat(64) })
      .returning({ id: caseDocuments.id });
    if (!doc) throw new Error("document seed failed");
    return { user, provider, c, doc, storage };
  }

  function extractionFor(providerName: string) {
    return ExtractionSchema.parse({
      provider_name: providerName,
      service_type: "MOBILE_POSTPAID",
      account_no: "1234-5678",
      holder_full_name: null,
      monthly_fee_cents: 5000,
      contract_end_date: "2027-04-28",
      notice_days: 30,
      evidence: [{ page: 1, quote: "Account No: 1234-5678" }],
    });
  }

  it("extracts then moves to PRE_FLIGHT_AUDIT with a recommendation", async () => {
    const { user, provider, c, doc, storage } = await setupBill();
    setFakeResponses([{ text: JSON.stringify(extractionFor(provider.name)) }]);
    const result = (await callTool(
      "extract-document",
      { caseId: c.id, documentId: doc.id },
      testToolContext(user.id, [], { storage }),
    )) as { status: string; recommendation: { action: string } };
    expect(result.status).toBe("PRE_FLIGHT_AUDIT");
    expect(result.recommendation.action).toBe("WAIT_UNTIL");
    const accepted = (await callTool(
      "accept-recommendation",
      { caseId: c.id },
      testToolContext(user.id, []),
    )) as { status: string };
    expect(accepted.status).toBe("AWAITING_MANDATE");
  });

  it("fails unknown providers with PROVIDER_UNSUPPORTED and a refund", async () => {
    const { user, c, doc, storage } = await setupBill();
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    await seedCredit(customer.id, { delta: -1, reason: "CONSUME", caseId: c.id });
    setFakeResponses([{ text: JSON.stringify(extractionFor(`Unknown Telco ${randomUUID()}`)) }]);
    const result = (await callTool(
      "extract-document",
      { caseId: c.id, documentId: doc.id },
      testToolContext(user.id, [], { storage }),
    )) as { status: string; reason: string };
    expect(result).toEqual({ status: "FAILED", reason: "PROVIDER_UNSUPPORTED" });
    const [refunded] = await db
      .select({ n: count() })
      .from(creditLedger)
      .where(and(eq(creditLedger.caseId, c.id), eq(creditLedger.reason, "REFUND")));
    expect(refunded?.n).toBe(1);
  });
});

describe("mandate and execution tools", () => {
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
    return { user, provider, holder, c };
  }

  it("requests a mandate and warns when the fee exceeds the cap", async () => {
    const { user, c } = await setupMandateCase();
    const valkey = new FakeValkey();
    const outbox = createSmsOutbox();
    setIdentityValkey(valkey);
    setSmsOverride(outbox.sender);
    try {
      const result = (await callTool(
        "request-mandate",
        { caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 500, confirm: true },
        testToolContext(user.id, []),
      )) as { mandateId: string; etfExceedsMaxFee: boolean };
      expect(result.mandateId).toBeDefined();
      expect(result.etfExceedsMaxFee).toBe(true);
      expect(outbox.messages).toHaveLength(1);
    } finally {
      setIdentityValkey(null);
      setSmsOverride(null);
    }
  });

  it("approves one awaiting step", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    // Self-service holder: the owner approves without an SMS code.
    await db
      .update(accountHolders)
      .set({ userId: user.id })
      .where(eq(accountHolders.id, holder.id));
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "EXECUTING",
    });
    const step = await seedStep(c.id, { status: "AWAITING_APPROVAL" });
    const result = (await callTool(
      "approve-step",
      { caseId: c.id, stepId: step.id, confirm: true },
      testToolContext(user.id, []),
    )) as { approved: boolean };
    expect(result).toEqual({ approved: true });
    const other = await seedCase({ ownerId: user.id, holderId: holder.id, status: "EXECUTING" });
    await expect(
      callTool(
        "approve-step",
        { caseId: other.id, stepId: step.id, confirm: true },
        testToolContext(user.id, []),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("drafts replies on redacted text", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const secret = await seedAccountSecret(holder.id, "ACC-DRAFT-42");
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "EXECUTING",
    });
    setFakeResponses([{ text: "Please cancel account immediately." }]);
    const result = (await callTool(
      "draft-chat-reply",
      { caseId: c.id, inboundText: `we see account ACC-DRAFT-42 has an offer` },
      testToolContext(user.id, []),
    )) as { draft: string };
    expect(result.draft).toBe("Please cancel account immediately.");
    const request = lastFakeRequest();
    expect(request?.model).toBe(env.MODEL_CONTRIBUTOR);
    expect(JSON.stringify(request?.messages)).toContain(`{{vault:ACCOUNT_NO:${secret.id}}}`);
    expect(JSON.stringify(request?.messages)).not.toContain("ACC-DRAFT-42");
  });

  it("records receipts then reports the bill check", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const secret = await seedAccountSecret(holder.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "EXECUTING",
    });
    await seedMandate({
      caseId: c.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceSecretId: secret.id,
      status: "ACTIVE",
    });
    const ctx = testToolContext(user.id, []);
    const recorded = (await callTool(
      "record-receipt",
      { caseId: c.id, referenceCode: "RC-9", effectiveDate: "2026-11-01", confirm: true },
      ctx,
    )) as { status: string };
    expect(recorded.status).toBe("AWAITING_VERIFICATION");
    const [mandate] = await db
      .select({ status: mandates.status })
      .from(mandates)
      .where(eq(mandates.caseId, c.id))
      .limit(1);
    expect(mandate?.status).toBe("CONSUMED");
    const [verification] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.caseId, c.id))
      .limit(1);
    expect(verification?.dueAt).toEqual(new Date("2026-12-08T00:00:00Z"));
    await expect(
      callTool(
        "record-receipt",
        { caseId: c.id, referenceCode: "RC-10", effectiveDate: "2026-11-02", confirm: true },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    const reported = (await callTool(
      "report-bill-check",
      { caseId: c.id, result: "NO_REBILL", confirm: true },
      ctx,
    )) as { status: string };
    expect(reported.status).toBe("SUCCEEDED");
  });

  it("reports REBILLED as DISPUTED", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      status: "AWAITING_VERIFICATION",
    });
    await db.insert(verifications).values({ caseId: c.id, dueAt: new Date() });
    const reported = (await callTool(
      "report-bill-check",
      { caseId: c.id, result: "REBILLED", confirm: true },
      testToolContext(user.id, []),
    )) as { status: string };
    expect(reported.status).toBe("DISPUTED");
  });

  it("withdraws from non-terminal only", async () => {
    const { user, c } = await setupDraft();
    const withdrawn = (await callTool(
      "withdraw-case",
      { caseId: c.id, confirm: true },
      testToolContext(user.id, []),
    )) as { status: string };
    expect(withdrawn.status).toBe("WITHDRAWN");
    const done = await seedCase({
      ownerId: user.id,
      holderId: (await seedHolder(user.id)).id,
      status: "SUCCEEDED",
    });
    await expect(
      callTool("withdraw-case", { caseId: done.id, confirm: true }, testToolContext(user.id, [])),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });
});

describe("lookup tools", () => {
  it("searches providers and fetches detail", async () => {
    const user = await seedUser();
    // A unique name ranks first on its own: the shared database collects
    // same-name rows across runs, and search returns only the top 5.
    const name = `Zzxj Searchprobe ${randomUUID()}`;
    const provider = await seedProvider({ name, slug: `zzxj-${randomUUID()}` });
    await seedChannel(provider.id);
    const valkey = new FakeValkey();
    setProvidersValkey(valkey);
    try {
      const ctx = testToolContext(user.id, []);
      const hits = (await callTool("search-providers", { query: name }, ctx)) as Array<{
        slug: string;
      }>;
      expect(hits.map((hit) => hit.slug)).toContain(provider.slug);
      const detail = (await callTool("get-provider", { id: provider.id }, ctx)) as {
        channels: unknown[];
      };
      expect(detail.channels).toHaveLength(1);
      await expect(callTool("get-provider", { id: randomUUID() }, ctx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      setProvidersValkey(null);
    }
  });

  it("lists holders with hints only", async () => {
    const user = await seedUser();
    await seedHolder(user.id, { alias: "Dad", phone: "+6591112222" });
    const holders = (await callTool("list-holders", {}, testToolContext(user.id, []))) as Array<
      Record<string, unknown>
    >;
    expect(holders).toHaveLength(1);
    expect(Object.keys(holders[0] ?? {}).sort()).toEqual([
      "alias",
      "createdAt",
      "displayHint",
      "id",
      "orgId",
    ]);
    expect(holders[0]?.displayHint).toBe("2222");
    expect(JSON.stringify(holders)).not.toContain("+6591112222");
  });
});
