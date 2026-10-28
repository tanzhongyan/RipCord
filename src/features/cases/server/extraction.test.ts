import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { db } from "~/server/db";
import {
  caseDocuments,
  cases,
  contractTerms,
  providerPolicies,
  vaultSecrets,
} from "~/server/db/schema";
import { lastFakeRequest, setFakeResponses } from "~/server/model/fake";
import { getSecretValues } from "~/server/vault";
import { env } from "~/shared/config/env";
import { ExtractionSchema, extractDocument } from "./extraction";
import {
  buildBillPdf,
  FakeStorage,
  seedCase,
  seedHolder,
  seedProvider,
  seedUser,
} from "./test-support";

const ACCOUNT_NO = "1234-5678";
const HOLDER_NAME = "Tan Ah Kow";

function billExtraction(providerName: string) {
  return ExtractionSchema.parse({
    provider_name: providerName,
    service_type: "MOBILE_POSTPAID",
    account_no: ACCOUNT_NO,
    holder_full_name: HOLDER_NAME,
    monthly_fee_cents: 5000,
    contract_start: "2025-05-01",
    contract_end_date: "2027-04-28",
    min_term_months: 24,
    etf_clause_text: "Early termination fee equals remaining months times the monthly fee.",
    notice_days: 30,
    equipment: ["router"],
    bundle_links: [],
    evidence: [{ page: 1, quote: "Account No: 1234-5678" }],
  });
}

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
  const bytes = await buildBillPdf([
    "Demo Telco monthly bill",
    `Account No: ${ACCOUNT_NO}`,
    `Holder: ${HOLDER_NAME}`,
    "Monthly fee S$50, 30 days notice",
  ]);
  const key = `cases/${c.id}/${randomUUID()}.pdf`;
  await storage.put(key, bytes, "application/pdf");
  const [doc] = await db
    .insert(caseDocuments)
    .values({ caseId: c.id, kind: "BILL", storageKey: key, sha256: "0".repeat(64) })
    .returning({ id: caseDocuments.id });
  if (!doc) throw new Error("document seed failed");
  return { user, provider, holder, c, doc, storage };
}

afterEach(() => {
  setFakeResponses([]);
  vi.restoreAllMocks();
});

describe("B3 Extraction vaults PII", () => {
  it("fills terms, vaults the account number, and keeps it out of storage and logs", async () => {
    const { provider, c, doc, storage } = await setupBill();
    setFakeResponses([{ text: JSON.stringify(billExtraction(provider.name)) }]);
    const seen: string[] = [];
    for (const method of ["debug", "info", "warn", "error", "log"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        seen.push(args.map(String).join(" "));
      });
    }

    const result = await extractDocument(
      { caseId: c.id, documentId: doc.id, ownerKey: null },
      { storage, model: { provider: "fake" } },
    );

    expect(result.providerMatched).toBe(true);
    expect(result.confidence).toBe(100);
    expect(result.recommendation?.action).toBe("WAIT_UNTIL");

    const [terms] = await db
      .select()
      .from(contractTerms)
      .where(eq(contractTerms.caseId, c.id))
      .limit(1);
    expect(terms?.monthlyFeeCents).toBe(5000);
    expect(terms?.contractEndDate).toBe("2027-04-28");
    expect(terms?.noticeDays).toBe(30);
    expect(terms?.confidence).toBe(100);

    const secrets = await db
      .select({ id: vaultSecrets.id, kind: vaultSecrets.kind })
      .from(vaultSecrets)
      .where(eq(vaultSecrets.holderId, terms ? c.holderId : ""));
    expect(secrets.map((row) => row.kind)).toContain("ACCOUNT_NO");
    const values = await getSecretValues(
      db,
      secrets.map((row) => row.id),
    );
    expect([...values.values()]).toContain(ACCOUNT_NO);

    const [updated] = await db
      .select()
      .from(caseDocuments)
      .where(eq(caseDocuments.id, doc.id))
      .limit(1);
    const extractedJson = JSON.stringify(updated?.extracted ?? {});
    expect(extractedJson).not.toContain(ACCOUNT_NO);
    expect(extractedJson).not.toContain(HOLDER_NAME);
    expect(extractedJson).toContain("{{vault:ACCOUNT_NO:");
    expect(extractedJson).toContain("{{vault:FULL_NAME:");
    expect(updated?.sha256).not.toBe("0".repeat(64));

    const [updatedCase] = await db
      .select({ providerId: cases.providerId, serviceType: cases.serviceType })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(updatedCase?.providerId).toBe(provider.id);
    expect(updatedCase?.serviceType).toBe("MOBILE_POSTPAID");

    expect(seen.join("\n")).not.toContain(ACCOUNT_NO);
    expect(seen.join("\n")).not.toContain(HOLDER_NAME);
  });
});

describe("extraction paths", () => {
  it("sends bill photos to the standard tier as images", async () => {
    const { provider, c, doc, storage } = await setupBill();
    // A 1x1 PNG: magic bytes plus a minimal body.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde,
    ]);
    await db
      .update(caseDocuments)
      .set({ storageKey: `cases/${c.id}/photo.png` })
      .where(eq(caseDocuments.id, doc.id));
    await storage.put(`cases/${c.id}/photo.png`, png, "image/png");
    setFakeResponses([{ text: JSON.stringify(billExtraction(provider.name)) }]);

    await extractDocument({ caseId: c.id, documentId: doc.id, ownerKey: null }, { storage });
    expect(lastFakeRequest()?.model).toBe(env.MODEL_STANDARD);
  });

  it("drops confidence by 30 without evidence", async () => {
    const { provider, c, doc, storage } = await setupBill();
    const bare = { ...billExtraction(provider.name), evidence: [] };
    setFakeResponses([{ text: JSON.stringify(bare) }]);
    const result = await extractDocument(
      { caseId: c.id, documentId: doc.id, ownerKey: null },
      { storage },
    );
    expect(result.confidence).toBe(70);
  });

  it("reports an unknown provider without matching", async () => {
    const { provider, c, doc, storage } = await setupBill();
    const unknown = {
      ...billExtraction(provider.name),
      provider_name: `Unknown Telco ${randomUUID()}`,
    };
    setFakeResponses([{ text: JSON.stringify(unknown) }]);
    const result = await extractDocument(
      { caseId: c.id, documentId: doc.id, ownerKey: null },
      { storage },
    );
    expect(result.providerMatched).toBe(false);
    expect(result.recommendation).toBeNull();
  });

  it("refuses a PDF without a text layer", async () => {
    const { c, doc, storage } = await setupBill();
    const { PDFDocument } = await import("pdf-lib");
    const blank = await PDFDocument.create();
    blank.addPage();
    const bytes = await blank.save();
    await db
      .update(caseDocuments)
      .set({ storageKey: `cases/${c.id}/blank.pdf` })
      .where(eq(caseDocuments.id, doc.id));
    await storage.put(`cases/${c.id}/blank.pdf`, bytes, "application/pdf");
    await expect(
      extractDocument({ caseId: c.id, documentId: doc.id, ownerKey: null }, { storage }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
