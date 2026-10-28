import { eq } from "drizzle-orm";
import { extractText } from "unpdf";
import { afterEach, describe, expect, it } from "vitest";
import { FakeStripeClient, setStripeOverride } from "~/features/billing";
import { setValkeyOverride } from "~/features/identity";
import { db } from "~/server/db";
import { caseDocuments, cases, receipts, verifications } from "~/server/db/schema";
import { storeSecret } from "~/server/vault";
import { setEventsOverride } from "./events";
import { setMailOverride } from "./mailer";
import {
  FakeEvents,
  FakeMailTransport,
  FakeStorage,
  FakeValkey,
  seedBillingCustomer,
  seedCase,
  seedCredit,
  seedHolder,
  seedProvider,
  seedUser,
  testToolContext,
} from "./test-support";
import { callTool } from "./tools/registry";
import { runVerificationsCron } from "./verifications";

afterEach(() => {
  setValkeyOverride(null);
  setMailOverride(null);
  setEventsOverride(null);
  setStripeOverride(null);
});

async function setupAwaiting(dueAt: Date) {
  const user = await seedUser();
  const provider = await seedProvider();
  const holder = await seedHolder(user.id);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceType: "MOBILE_POSTPAID",
    status: "AWAITING_VERIFICATION",
  });
  await db.insert(receipts).values({
    caseId: c.id,
    referenceCode: "RC-7",
    effectiveDate: "2026-09-01",
  });
  await db.insert(verifications).values({ caseId: c.id, dueAt });
  return { user, c };
}

describe("B8 Verification due", () => {
  it("emails once per verification", async () => {
    setValkeyOverride(new FakeValkey() as never);
    const mail = new FakeMailTransport();
    setMailOverride(mail);
    setEventsOverride(new FakeEvents());
    const yesterday = new Date(Date.now() - 86_400_000);
    await setupAwaiting(yesterday);
    const first = await runVerificationsCron();
    expect(first.emailed).toBeGreaterThanOrEqual(1);
    expect(mail.sent.length).toBeGreaterThanOrEqual(1);
    const sent = mail.sent.length;
    const second = await runVerificationsCron();
    expect(second.emailed).toBe(0);
    expect(mail.sent.length).toBe(sent);
  });
});

describe("B9 Silent success", () => {
  it("marks UNKNOWN and SUCCEEDED 30 days past due", async () => {
    setValkeyOverride(new FakeValkey() as never);
    setMailOverride(new FakeMailTransport());
    setEventsOverride(new FakeEvents());
    const past = new Date(Date.now() - 31 * 86_400_000);
    const { c } = await setupAwaiting(past);
    await runVerificationsCron();
    const [verification] = await db
      .select()
      .from(verifications)
      .where(eq(verifications.caseId, c.id))
      .limit(1);
    expect(verification?.result).toBe("UNKNOWN");
    const [row] = await db.select({ status: cases.status }).from(cases).where(eq(cases.id, c.id));
    expect(row?.status).toBe("SUCCEEDED");
  });
});

describe("B10 Dispute", () => {
  it("stores a tokenized DISPUTE_PACKAGE and moves to DISPUTED", async () => {
    setStripeOverride(new FakeStripeClient());
    setEventsOverride(new FakeEvents());
    const storage = new FakeStorage();
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const fullName = "Alexander Dispute Test";
    const accountNo = "ACC-DISPUTE-999";
    await storeSecret(db, { holderId: holder.id, kind: "FULL_NAME", value: fullName });
    await storeSecret(db, { holderId: holder.id, kind: "ACCOUNT_NO", value: accountNo });
    const customer = await seedBillingCustomer({ userId: user.id });
    await seedCredit(customer.id, { delta: 1 });
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceType: "MOBILE_POSTPAID",
      status: "AWAITING_VERIFICATION",
    });
    await db.insert(receipts).values({
      caseId: c.id,
      referenceCode: "RC-DISPUTE",
      effectiveDate: "2026-09-01",
    });
    await db.insert(verifications).values({ caseId: c.id, dueAt: new Date() });
    const ctx = testToolContext(user.id, [], { storage });
    const out = (await callTool(
      "report-bill-check",
      { caseId: c.id, result: "REBILLED", disputedChargeCents: 199, confirm: true },
      ctx,
    )) as { status: string };
    expect(out.status).toBe("DISPUTED");
    const docs = await db.select().from(caseDocuments).where(eq(caseDocuments.caseId, c.id));
    const dispute = docs.find((doc) => doc.kind === "DISPUTE_PACKAGE");
    expect(dispute).toBeDefined();
    if (!dispute) throw new Error("dispute package missing");
    const bytes = storage.objects.get(dispute.storageKey);
    expect(bytes).toBeDefined();
    if (!bytes) throw new Error("dispute bytes missing");
    const { text } = await extractText(bytes.bytes.slice(), { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : String(text);
    expect(joined).toContain("{{vault:");
    expect(joined).not.toContain(fullName);
    expect(joined).not.toContain(accountNo);
  });
});
