import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { type Database, db } from "~/server/db";
import { accountHolders, users, vaultSecrets } from "~/server/db/schema";
import { lastFakeRequest, setFakeResponses } from "~/server/model/fake";
import { storeSecret } from "~/server/vault";
import { runAgentLoop } from "./agent";

afterEach(() => {
  setFakeResponses([]);
});

/** A holder with one `ACCOUNT_NO` secret, seeded without cross-feature helpers. */
async function seedHolderWithSecret(value: string): Promise<{ holderId: string }> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    name: "Agent Test",
    email: `${randomUUID()}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const holderId = randomUUID();
  await db.transaction(async (tx) => {
    const phone = await storeSecret(tx, { holderId, kind: "PHONE", value: "+6591234567" });
    await tx.insert(accountHolders).values({
      id: holderId,
      ownerUserId: userId,
      alias: "Holder",
      phoneSecretId: phone.id,
    });
    await storeSecret(tx, { holderId, kind: "ACCOUNT_NO", value });
  });
  return { holderId };
}

/** A `db` double that counts `vault_secrets` SELECTs and runs everything else. */
function countingConn(counter: { vaultSelects: number }): Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "select") return Reflect.get(target, prop, receiver);
      const select = Reflect.get(target, prop, receiver) as (...args: []) => object;
      return (...args: []) => {
        const builder = select.apply(target, args) as { from: (table: object) => object };
        const originalFrom = builder.from.bind(builder);
        builder.from = ((table: object) => {
          if (table === vaultSecrets) counter.vaultSelects += 1;
          return originalFrom(table);
        }) as typeof builder.from;
        return builder;
      };
    },
  });
}

describe("runAgentLoop history redaction", () => {
  it("redacts every message against a single vault read", async () => {
    const { holderId } = await seedHolderWithSecret("ACC-42424242");
    setFakeResponses([{ text: "Done." }]);
    const counter = { vaultSelects: 0 };
    const frames: string[] = [];
    for await (const frame of runAgentLoop({
      messages: [
        { role: "user", content: "My account is ACC-42424242." },
        { role: "assistant", content: "Noted." },
        { role: "user", content: "Confirm ACC-42424242 again." },
      ],
      context: { holderId, ownerKey: `user:${holderId}` },
      caller: { userId: holderId, orgIds: [] },
      conn: countingConn(counter),
    })) {
      frames.push(frame);
    }
    expect(counter.vaultSelects).toBe(1);
    expect(frames.at(-1)).toContain('"done"');
    const sent = JSON.stringify(lastFakeRequest()?.messages ?? []);
    expect(sent).not.toContain("ACC-42424242");
    expect(sent).toContain("{{vault:ACCOUNT_NO:");
  });
});
