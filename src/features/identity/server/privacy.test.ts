import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import {
  accountHolders,
  caseDocuments,
  dataSubjectRequests,
  vaultSecrets,
} from "~/server/db/schema";
import { storeSecret } from "~/server/vault";
import { exportDsr, type PrivacyDeps, requestAccess, requestDelete } from "./privacy";
import {
  callerFor,
  FakeStorage,
  seedCase,
  seedHolder,
  seedProvider,
  seedUser,
} from "./test-support";

const NOW = new Date("2026-10-28T00:00:00Z");

function testDeps(storage: FakeStorage): PrivacyDeps {
  return { db, storage, now: () => NOW };
}

describe("privacy.requestAccess", () => {
  it("completes an access request for an owned holder", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const { requestId } = await requestAccess(
      { holderId: holder.id },
      { userId: user.id, orgIds: [] },
      testDeps(new FakeStorage()),
    );
    const [row] = await db
      .select()
      .from(dataSubjectRequests)
      .where(eq(dataSubjectRequests.id, requestId))
      .limit(1);
    expect(row?.kind).toBe("ACCESS");
    expect(row?.status).toBe("COMPLETED");
    expect(row?.holderId).toBe(holder.id);
  });

  it("hides another user's holder behind NOT_FOUND", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const holder = await seedHolder(alice.id);
    const bobCaller = callerFor(bob.id, []);
    await expect(bobCaller.privacy.requestAccess({ holderId: holder.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("B9 Delete request", () => {
  it("shreds secrets, deletes short docs from the object store", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const nric = await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: "S1234567D" });
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "SUCCEEDED",
    });
    const storage = new FakeStorage();
    await storage.put("cases/old/bill.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
    const [bill] = await db
      .insert(caseDocuments)
      .values({
        caseId: c.id,
        kind: "BILL",
        storageKey: "cases/old/bill.pdf",
        sha256: "0".repeat(64),
      })
      .returning({ id: caseDocuments.id });
    const [shot] = await db
      .insert(caseDocuments)
      .values({
        caseId: c.id,
        kind: "SCREENSHOT",
        storageKey: "data:image/png;base64,iVBORw0KGgo=",
        sha256: "1".repeat(64),
      })
      .returning({ id: caseDocuments.id });
    const [loa] = await db
      .insert(caseDocuments)
      .values({
        caseId: c.id,
        kind: "LOA",
        storageKey: "data:application/pdf;base64,JVBERi0=",
        sha256: "2".repeat(64),
      })
      .returning({ id: caseDocuments.id });

    const before = await db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, nric.id))
      .limit(1);
    const { requestId } = await requestDelete(
      { holderId: holder.id },
      { userId: user.id, orgIds: [] },
      testDeps(storage),
    );

    const [secret] = await db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, nric.id))
      .limit(1);
    expect(secret?.deletedAt).toBeInstanceOf(Date);
    expect(secret?.ciphertext.equals(before[0]?.ciphertext ?? Buffer.of())).toBe(false);
    const [deletedHolder] = await db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.id, holder.id))
      .limit(1);
    expect(deletedHolder?.deletedAt).toBeInstanceOf(Date);

    expect(storage.objects.has("cases/old/bill.pdf")).toBe(false);
    expect(
      await db
        .select()
        .from(caseDocuments)
        .where(eq(caseDocuments.id, bill?.id ?? "")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(caseDocuments)
        .where(eq(caseDocuments.id, shot?.id ?? "")),
    ).toHaveLength(0);
    const [keptLoa] = await db
      .select()
      .from(caseDocuments)
      .where(eq(caseDocuments.id, loa?.id ?? ""))
      .limit(1);
    expect(keptLoa?.deleteAfter).toBeInstanceOf(Date);

    const [request] = await db
      .select()
      .from(dataSubjectRequests)
      .where(eq(dataSubjectRequests.id, requestId))
      .limit(1);
    expect(request?.status).toBe("COMPLETED");
  });

  it("deletes personal holders on a self request", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const storage = new FakeStorage();
    await requestDelete({}, { userId: user.id, orgIds: [] }, testDeps(storage));
    const [row] = await db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.id, holder.id))
      .limit(1);
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("privacy.export", () => {
  it("returns masked secrets and never raw values", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id, { phone: "+6591112222" });
    await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: "S1234567D" });
    const deps = testDeps(new FakeStorage());
    const { requestId } = await requestAccess(
      { holderId: holder.id },
      { userId: user.id, orgIds: [] },
      deps,
    );
    const exported = await exportDsr({ requestId }, { userId: user.id, orgIds: [] }, deps);
    const nric = exported.holders[0]?.secrets.find((secret) => secret.kind === "NRIC");
    expect(nric?.masked).toBe("S****567D");
    const phone = exported.holders[0]?.secrets.find((secret) => secret.kind === "PHONE");
    expect(phone?.masked).toBe("+****2222");
    const raw = JSON.stringify(exported);
    expect(raw).not.toContain("S1234567D");
    expect(raw).not.toContain("6591112222");
    expect(raw).not.toContain("91112222");
  });

  it("hides another user's export behind NOT_FOUND", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const holder = await seedHolder(alice.id);
    const deps = testDeps(new FakeStorage());
    const { requestId } = await requestAccess(
      { holderId: holder.id },
      { userId: alice.id, orgIds: [] },
      deps,
    );
    await expect(
      exportDsr({ requestId }, { userId: bob.id, orgIds: [] }, deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
