import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { accountHolders, vaultSecrets } from "~/server/db/schema";
import { requestMandate } from "./mandate-flow";
import {
  callerFor,
  createSmsOutbox,
  FakeValkey,
  seedAccountSecret,
  seedCase,
  seedOrg,
  seedProvider,
  seedUser,
} from "./test-support";

const NOW = new Date("2026-10-28T00:00:00Z");

describe("B2 Holder PII stays in the vault", () => {
  it("stores the phone as a vault secret with a last-4 hint", async () => {
    const user = await seedUser();
    const caller = callerFor(user.id, []);
    const { id } = await caller.holders.create({ alias: "Dad", phone: "+6591234567" });

    const [holder] = await db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.id, id))
      .limit(1);
    expect(JSON.stringify(holder)).not.toContain("91234567");

    const [secret] = await db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, holder?.phoneSecretId ?? ""))
      .limit(1);
    expect(secret?.kind).toBe("PHONE");
    expect(secret?.displayHint).toBe("4567");
  });

  it("rejects a non-E.164 phone", async () => {
    const user = await seedUser();
    const caller = callerFor(user.id, []);
    await expect(caller.holders.create({ alias: "Dad", phone: "91234567" })).rejects.toThrow();
  });
});

describe("B8 Ownership", () => {
  it("hides another user's holder behind NOT_FOUND", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const aliceCaller = callerFor(alice.id, []);
    const bobCaller = callerFor(bob.id, []);

    const { id } = await aliceCaller.holders.create({ alias: "Dad", phone: "+6591111111" });

    await expect(bobCaller.holders.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listed = await bobCaller.holders.list();
    expect(listed.find((row) => row.id === id)).toBeUndefined();

    const provider = await seedProvider();
    const [holder] = await db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.id, id))
      .limit(1);
    await seedAccountSecret(holder?.id ?? "");
    const c = await seedCase({ ownerId: alice.id, holderId: id, providerId: provider.id });
    const { mandateId } = await requestMandate(
      { caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 100 },
      { userId: alice.id, orgIds: [] },
      { db, valkey: new FakeValkey(), sms: createSmsOutbox().sender, now: () => NOW },
    );
    await expect(bobCaller.mandates.get({ mandateId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("B9 Org access", () => {
  it("shares an org holder with members and hides it from non-members", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const carol = await seedUser();
    const org = await seedOrg(alice.id, [bob.id]);

    const aliceCaller = callerFor(alice.id, [org.id]);
    const { id } = await aliceCaller.holders.create({
      alias: "Shared",
      phone: "+6592222222",
      orgId: org.id,
    });

    const bobCaller = callerFor(bob.id, [org.id]);
    const listed = await bobCaller.holders.list();
    expect(listed.find((row) => row.id === id)?.alias).toBe("Shared");

    const carolCaller = callerFor(carol.id, []);
    const carolListed = await carolCaller.holders.list();
    expect(carolListed.find((row) => row.id === id)).toBeUndefined();
    await expect(carolCaller.holders.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to create a holder inside an org the caller left", async () => {
    const alice = await seedUser();
    const org = await seedOrg(alice.id);
    const outsider = await seedUser();
    const caller = callerFor(outsider.id, []);
    await expect(
      caller.holders.create({ alias: "Nope", phone: "+6593333333", orgId: org.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("soft-deletes for the owner", async () => {
    const user = await seedUser();
    const caller = callerFor(user.id, []);
    const { id } = await caller.holders.create({ alias: "Temp", phone: "+6594444444" });
    await expect(caller.holders.delete({ id })).resolves.toEqual({ success: true });
    const [holder] = await db
      .select()
      .from(accountHolders)
      .where(eq(accountHolders.id, id))
      .limit(1);
    expect(holder?.deletedAt).not.toBeNull();
    expect(
      await caller.holders.list().then((rows) => rows.find((row) => row.id === id)),
    ).toBeUndefined();
  });
});
