import { describe, expect, it } from "vitest";
import { appRouter } from "~/server/api/root";
import { db } from "~/server/db";

describe("notes router integration", () => {
  const createCallerForUser = (userId: string) => {
    return appRouter.createCaller({
      db,
      ownerId: userId,
      headers: new Headers({ "x-user-id": userId }),
    });
  };

  it("create -> get round-trip works for owner", async () => {
    const caller = createCallerForUser("test-owner-1");
    const created = await caller.notes.create({
      title: "Test Note",
      body: "Test note body content",
    });

    expect(created.id).toBeDefined();
    expect(created.title).toBe("Test Note");
    expect(created.body).toBe("Test note body content");

    const fetched = await caller.notes.get({ id: created.id });
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe("Test Note");
    expect(fetched.body).toBe("Test note body content");
  });

  it("rejects invalid input (empty title or >200 chars)", async () => {
    const caller = createCallerForUser("test-owner-validation");

    // Empty title
    await expect(
      caller.notes.create({
        title: "",
        body: "empty",
      }),
    ).rejects.toThrow();

    // Title too long (>200 chars)
    await expect(
      caller.notes.create({
        title: "x".repeat(201),
        body: "too long",
      }),
    ).rejects.toThrow();
  });

  it("enforces tenant isolation: owner A cannot read, update, or delete owner B's note", async () => {
    const callerA = createCallerForUser("owner-alice");
    const callerB = createCallerForUser("owner-bob");

    const noteA = await callerA.notes.create({
      title: "Alice Private Note",
      body: "Confidential info",
    });

    // Bob cannot read Alice's note
    await expect(callerB.notes.get({ id: noteA.id })).rejects.toThrow();

    // Bob cannot update Alice's note
    await expect(
      callerB.notes.update({
        id: noteA.id,
        title: "Tampered by Bob",
      }),
    ).rejects.toThrow();

    // Bob cannot delete Alice's note
    await expect(callerB.notes.delete({ id: noteA.id })).rejects.toThrow();

    // Alice can still read her note
    const stillAlice = await callerA.notes.get({ id: noteA.id });
    expect(stillAlice.title).toBe("Alice Private Note");

    // Alice can delete her note
    const deleteRes = await callerA.notes.delete({ id: noteA.id });
    expect(deleteRes.success).toBe(true);
    await expect(callerA.notes.get({ id: noteA.id })).rejects.toThrow();
  });
});
