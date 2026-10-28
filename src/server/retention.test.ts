import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  FakeStorage,
  seedCase,
  seedHolder,
  seedProvider,
  seedUser,
} from "~/features/identity/server/test-support";
import { db } from "~/server/db";
import {
  accountHolders,
  auditLogs,
  caseDocuments,
  cases,
  communications,
  vaultSecrets,
} from "~/server/db/schema";
import { runRetention } from "~/server/retention";
import { storeSecret } from "~/server/vault";

const NOW = new Date("2026-10-28T00:00:00Z");

async function seedDoc(caseId: string, kind: "BILL" | "LOA", storageKey: string) {
  const [row] = await db
    .insert(caseDocuments)
    .values({ caseId, kind, storageKey, sha256: "0".repeat(64) })
    .returning({ id: caseDocuments.id });
  if (!row) throw new Error("seedDoc failed");
  return row;
}

describe("retention job", () => {
  it("purges short-lived documents 30 days after close, from rows and store", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id });
    const storage = new FakeStorage();
    await storage.put("cases/x/bill.pdf", new Uint8Array([9]), "application/pdf");
    const doc = await seedDoc(c.id, "BILL", "cases/x/bill.pdf");
    await db
      .update(cases)
      .set({ status: "SUCCEEDED", closedAt: new Date(NOW.getTime() - 31 * 86_400_000) })
      .where(eq(cases.id, c.id));
    const counts = await runRetention(db, { storage, now: NOW });
    expect(counts.documents).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.id, doc.id))).toHaveLength(
      0,
    );
    expect(storage.objects.has("cases/x/bill.pdf")).toBe(false);
  });

  it("keeps short-lived documents of open cases", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id });
    const doc = await seedDoc(c.id, "BILL", "cases/y/bill.pdf");
    await runRetention(db, { storage: new FakeStorage(), now: NOW });
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.id, doc.id))).toHaveLength(
      1,
    );
  });

  it("purges long-lived documents and communications after 18 months", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id });
    const doc = await seedDoc(c.id, "LOA", "data:application/pdf;base64,JVBERi0=");
    const [comm] = await db
      .insert(communications)
      .values({
        caseId: c.id,
        channel: "EMAIL",
        direction: "OUTBOUND",
        body: "redacted body",
        occurredAt: NOW,
      })
      .returning({ id: communications.id });
    await db
      .update(cases)
      .set({ status: "SUCCEEDED", closedAt: new Date(NOW.getTime() - 549 * 86_400_000) })
      .where(eq(cases.id, c.id));
    const counts = await runRetention(db, { storage: new FakeStorage(), now: NOW });
    expect(counts.documents).toBeGreaterThanOrEqual(1);
    expect(counts.communications).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.id, doc.id))).toHaveLength(
      0,
    );
    expect(
      await db
        .select()
        .from(communications)
        .where(eq(communications.id, comm?.id ?? "")),
    ).toHaveLength(0);
  });

  it("purges documents past delete_after regardless of kind", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id });
    const doc = await seedDoc(c.id, "LOA", "cases/z/loa.pdf");
    await db
      .update(caseDocuments)
      .set({ deleteAfter: new Date(NOW.getTime() - 1000) })
      .where(eq(caseDocuments.id, doc.id));
    await runRetention(db, { storage: new FakeStorage(), now: NOW });
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.id, doc.id))).toHaveLength(
      0,
    );
  });

  it("purges secrets of deleted holders and of holders idle 90 days", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    // Deleted holder: rows are gone.
    const gone = await seedHolder(user.id);
    const goneSecret = await storeSecret(db, { holderId: gone.id, kind: "EMAIL", value: "g@x.co" });
    await db.update(accountHolders).set({ deletedAt: NOW }).where(eq(accountHolders.id, gone.id));
    // Idle holder: last case closed 91 days ago.
    const idle = await seedHolder(user.id);
    const idleSecret = await storeSecret(db, { holderId: idle.id, kind: "EMAIL", value: "i@x.co" });
    const idleCase = await seedCase({
      ownerId: user.id,
      holderId: idle.id,
      providerId: provider.id,
    });
    await db
      .update(cases)
      .set({ status: "SUCCEEDED", closedAt: new Date(NOW.getTime() - 91 * 86_400_000) })
      .where(eq(cases.id, idleCase.id));
    // Active holder: open case keeps its secrets.
    const active = await seedHolder(user.id);
    const activeSecret = await storeSecret(db, {
      holderId: active.id,
      kind: "EMAIL",
      value: "a@x.co",
    });
    await seedCase({ ownerId: user.id, holderId: active.id, providerId: provider.id });

    const counts = await runRetention(db, { storage: new FakeStorage(), now: NOW });
    expect(counts.secretsDeleted).toBeGreaterThanOrEqual(2);
    expect(
      await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, goneSecret.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(vaultSecrets).where(eq(vaultSecrets.id, idleSecret.id)),
    ).toHaveLength(0);
    const [kept] = await db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, activeSecret.id))
      .limit(1);
    expect(kept?.deletedAt).toBeNull();
  });

  it("purges soft-deleted holders with no references after 30 days", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    await db
      .update(accountHolders)
      .set({ deletedAt: new Date(NOW.getTime() - 31 * 86_400_000) })
      .where(eq(accountHolders.id, holder.id));
    const counts = await runRetention(db, { storage: new FakeStorage(), now: NOW });
    expect(counts.holders).toBeGreaterThanOrEqual(1);
    expect(
      await db.select().from(accountHolders).where(eq(accountHolders.id, holder.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(vaultSecrets).where(eq(vaultSecrets.holderId, holder.id)),
    ).toHaveLength(0);
  });

  it("writes one audit row with counts only", async () => {
    const before = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.action, "RETENTION_PURGE"));
    await runRetention(db, { storage: new FakeStorage(), now: NOW });
    const after = await db.select().from(auditLogs).where(eq(auditLogs.action, "RETENTION_PURGE"));
    expect(after.length).toBeGreaterThan(before.length);
    const latest = after[after.length - 1];
    expect(Object.keys((latest?.metadata ?? {}) as object).sort()).toEqual(
      ["communications", "documents", "holders", "secretsDeleted", "secretsShredded"].sort(),
    );
  });

  it("does not fail when another run already purged the same rows", async () => {
    const counts = await runRetention(db, { storage: new FakeStorage(), now: NOW });
    expect(counts.documents).toBeGreaterThanOrEqual(0);
  });
});
