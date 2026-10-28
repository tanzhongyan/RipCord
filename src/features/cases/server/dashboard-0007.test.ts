import { describe, expect, it } from "vitest";
import { listCases } from "./listing";
import { seedCase, seedHolder, seedProvider, seedUser } from "./test-support";

/** B11 Dashboard isolation: A sees only A's and A's orgs' cases. */
describe("B11 Dashboard isolation", () => {
  it("lists only the caller's cases via the dashboard handler", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const aliceHolder = await seedHolder(alice.id);
    const bobHolder = await seedHolder(bob.id);
    const aliceCase = await seedCase({
      ownerId: alice.id,
      holderId: aliceHolder.id,
      status: "DISCOVERY",
    });
    const bobCase = await seedCase({
      ownerId: bob.id,
      holderId: bobHolder.id,
      status: "DISCOVERY",
    });
    const listed = await listCases({ limit: 25 }, { userId: alice.id, orgIds: [] });
    const ids = listed.cases.map((row) => row.id);
    expect(ids).toContain(aliceCase.id);
    expect(ids).not.toContain(bobCase.id);
  });
});

/** F1: dashboard rows carry the holder alias and provider name. */
describe("F1 dashboard rows", () => {
  it("returns holderAlias and providerName from the joined tables", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id, { alias: "F1 Holder" });
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "DISCOVERY",
    });
    const listed = await listCases({ limit: 25 }, { userId: user.id, orgIds: [] });
    const row = listed.cases.find((entry) => entry.id === c.id);
    expect(row?.holderAlias).toBe("F1 Holder");
    expect(row?.providerName).toBe(provider.name);
  });
});
