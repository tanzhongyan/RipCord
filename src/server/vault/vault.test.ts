import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  seedCase,
  seedChannel,
  seedHolder,
  seedMandate,
  seedProvider,
  seedStep,
  seedUser,
} from "~/features/identity/server/test-support";
import { db } from "~/server/db";
import { vaultSecrets } from "~/server/db/schema";
import {
  deleteHolderSecrets,
  getSecretValue,
  listSecretKinds,
  redactMany,
  resolveTokens,
  secretToken,
  storeSecret,
} from "~/server/vault";

const NRIC = "S1234567D";

async function seedReleaseContext() {
  const user = await seedUser();
  const provider = await seedProvider();
  const holder = await seedHolder(user.id);
  const secret = await storeSecret(db, { holderId: holder.id, kind: "NRIC", value: NRIC });
  const channel = await seedChannel(provider.id);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    status: "EXECUTING",
  });
  await db.execute(sql`update cases set sandbox = false where id = ${c.id}`);
  const mandate = await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: (
      await storeSecret(db, { holderId: holder.id, kind: "ACCOUNT_NO", value: "ACC-1" })
    ).id,
    delegateUserId: user.id,
    status: "ACTIVE",
  });
  const step = await seedStep(c.id, { approvedByUserId: user.id, approvedAt: new Date() });
  return { user, holder, secret, channel, c, mandate, step };
}

describe("B1 Round trip", () => {
  it("reads a stored NRIC back through a valid release, with no plaintext in the row", async () => {
    const { secret, channel, c, mandate, step } = await seedReleaseContext();
    const out = await resolveTokens(db, `holder ic ${secretToken("NRIC", secret.id)} end`, {
      caseId: c.id,
      stepId: step.id,
      mandateId: mandate.id,
      providerChannelId: channel.id,
    });
    expect(out).toBe(`holder ic ${NRIC} end`);

    const [row] = await db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, secret.id))
      .limit(1);
    const stored = Buffer.concat([
      row?.ciphertext ?? Buffer.of(),
      row?.iv ?? Buffer.of(),
      row?.wrappedDek ?? Buffer.of(),
    ]);
    expect(stored.includes(Buffer.from(NRIC, "utf8"))).toBe(false);
    expect(row?.keyVersion).toBe(1);
  });
});

describe("B2 Tampering", () => {
  it("throws when one ciphertext byte is flipped, returning no value", async () => {
    const { secret } = await seedReleaseContext();
    await db.execute(
      sql`update vault_secrets set ciphertext = set_byte(ciphertext, 0, (get_byte(ciphertext, 0) + 1) % 256) where id = ${secret.id}`,
    );
    await expect(getSecretValue(db, secret.id)).rejects.toThrow();
  });

  it("throws when one wrapped-key byte is flipped", async () => {
    const { secret } = await seedReleaseContext();
    await db.execute(
      sql`update vault_secrets set wrapped_dek = set_byte(wrapped_dek, 20, (get_byte(wrapped_dek, 20) + 1) % 256) where id = ${secret.id}`,
    );
    await expect(getSecretValue(db, secret.id)).rejects.toThrow();
  });
});

describe("storeSecret", () => {
  it("stores a last-4 hint, and none for PIN", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const phone = await storeSecret(db, {
      holderId: holder.id,
      kind: "PHONE",
      value: "+6591234567",
    });
    expect(phone.displayHint).toBe("4567");
    const pin = await storeSecret(db, { holderId: holder.id, kind: "PIN", value: "123456" });
    expect(pin.displayHint).toBeNull();
  });

  it("refuses an empty value", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    await expect(
      storeSecret(db, { holderId: holder.id, kind: "EMAIL", value: "" }),
    ).rejects.toThrow("Cannot store an empty secret");
  });

  it("encrypts the same value to different bytes each time", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const first = await storeSecret(db, { holderId: holder.id, kind: "EMAIL", value: "a@b.co" });
    const second = await storeSecret(db, { holderId: holder.id, kind: "EMAIL", value: "a@b.co" });
    const rows = await db.select().from(vaultSecrets).where(eq(vaultSecrets.holderId, holder.id));
    const bodies = rows
      .filter((row) => row.id === first.id || row.id === second.id)
      .map((row) => row.ciphertext.toString("hex"));
    expect(bodies[0]).not.toBe(bodies[1]);
  });
});

describe("getSecretValue", () => {
  it("round-trips and stamps last_used_at", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const secret = await storeSecret(db, { holderId: holder.id, kind: "DOB", value: "1990-01-01" });
    await expect(getSecretValue(db, secret.id)).resolves.toBe("1990-01-01");
    const [row] = await db
      .select()
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, secret.id))
      .limit(1);
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("throws for a missing or deleted secret", async () => {
    await expect(getSecretValue(db, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      "Secret not found",
    );
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const secret = await storeSecret(db, { holderId: holder.id, kind: "DOB", value: "1990-01-01" });
    await deleteHolderSecrets(db, holder.id);
    await expect(getSecretValue(db, secret.id)).rejects.toThrow("Secret not found");
  });
});

describe("listSecretKinds", () => {
  it("lists each live kind once", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    await storeSecret(db, { holderId: holder.id, kind: "ACCOUNT_NO", value: "ACC-1" });
    await storeSecret(db, { holderId: holder.id, kind: "ACCOUNT_NO", value: "ACC-2" });
    await storeSecret(db, { holderId: holder.id, kind: "EMAIL", value: "a@b.co" });
    // The seeded holder phone is a third kind.
    expect(await listSecretKinds(db, holder.id)).toEqual(
      expect.arrayContaining(["ACCOUNT_NO", "EMAIL", "PHONE"]),
    );
    expect(await listSecretKinds(db, holder.id)).toHaveLength(3);
  });
});

describe("redactMany", () => {
  it("redacts every text against the holder's secrets", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    await storeSecret(db, { holderId: holder.id, kind: "ACCOUNT_NO", value: "ACC-98765432" });
    const [first, second, third] = await redactMany(
      db,
      ["account ACC-98765432 here", "nothing secret", "ACC-98765432 plus S1234567D"],
      holder.id,
    );
    expect(first).toContain("{{vault:ACCOUNT_NO:");
    expect(first).not.toContain("ACC-98765432");
    expect(second).toBe("nothing secret");
    expect(third).not.toContain("ACC-98765432");
    expect(third).not.toContain("S1234567D");
    expect(third).toContain("{{vault:ACCOUNT_NO:");
    expect(third).toContain("[NRIC]");
  });

  it("redacts by pattern only without a holder, and keeps empty input empty", async () => {
    const [only] = await redactMany(db, ["call S1234567D"], null);
    expect(only).toBe("call [NRIC]");
    await expect(redactMany(db, [], null)).resolves.toEqual([]);
  });
});

describe("deleteHolderSecrets", () => {
  it("overwrites ciphertext, sets deleted_at and returns the count", async () => {
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    await storeSecret(db, { holderId: holder.id, kind: "EMAIL", value: "a@b.co" });
    const before = await db.select().from(vaultSecrets).where(eq(vaultSecrets.holderId, holder.id));
    expect(await deleteHolderSecrets(db, holder.id)).toBe(before.length);
    const after = await db.select().from(vaultSecrets).where(eq(vaultSecrets.holderId, holder.id));
    for (const row of after) {
      expect(row.deletedAt).toBeInstanceOf(Date);
      const original = before.find((candidate) => candidate.id === row.id);
      expect(row.ciphertext.equals(original?.ciphertext ?? Buffer.of())).toBe(false);
    }
  });
});
