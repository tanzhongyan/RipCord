import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { cases } from "~/server/db/schema";
import { caseChannel, caseEvents, setEventsOverride } from "./events";
import { loadOwnedCaseForEvents, streamCaseEvents, toCaseEventData } from "./events-stream";
import { FakeEvents, seedCase, seedHolder, seedUser } from "./test-support";

afterEach(() => {
  setEventsOverride(null);
});

describe("case event translation", () => {
  it("passes typed envelopes through", () => {
    const envelope = JSON.stringify({ type: "card", caseId: "c", card: { kind: "INFO" } });
    expect(toCaseEventData(envelope)).toBe(envelope);
  });

  it("translates legacy transitions into status events", () => {
    const data = toCaseEventData(
      JSON.stringify({ caseId: "c", from: "EXECUTING", to: "RECEIPT_ACQUISITION", at: "t" }),
    );
    expect(data && JSON.parse(data)).toEqual({
      type: "status",
      caseId: "c",
      from: "EXECUTING",
      to: "RECEIPT_ACQUISITION",
      at: "t",
    });
  });

  it("skips garbage and unknown payloads", () => {
    expect(toCaseEventData("not json")).toBeNull();
    expect(toCaseEventData(JSON.stringify({ type: "mystery" }))).toBeNull();
    expect(toCaseEventData(JSON.stringify([1, 2]))).toBeNull();
  });
});

describe("case event ownership", () => {
  it("loads the owner's case and rejects strangers", async () => {
    const user = await seedUser();
    const stranger = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "EXECUTING" });

    const owned = await loadOwnedCaseForEvents(c.id, { userId: user.id, orgIds: [] });
    expect(owned.id).toBe(c.id);
    await expect(
      loadOwnedCaseForEvents(c.id, { userId: stranger.id, orgIds: [] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("case event stream", () => {
  it("opens with a status snapshot, then forwards channel messages", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    const user = await seedUser();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, status: "EXECUTING" });
    const caller = { userId: user.id, orgIds: [] as string[] };
    const controller = new AbortController();
    const frames: string[] = [];

    const draining = (async () => {
      for await (const frame of streamCaseEvents(c.id, caller, { signal: controller.signal })) {
        frames.push(frame);
        if (frames.length === 3) controller.abort();
      }
    })();
    // Let the generator subscribe before publishing.
    for (let i = 0; i < 100 && frames.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await caseEvents().publish(
      caseChannel(c.id),
      JSON.stringify({ type: "transcript", text: "hello" }),
    );
    await caseEvents().publish(caseChannel(c.id), "garbage never streams");
    await caseEvents().publish(
      caseChannel(c.id),
      JSON.stringify({ caseId: c.id, from: "EXECUTING", to: "RECEIPT_ACQUISITION" }),
    );
    await draining;

    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[0]?.replace(/^data: /, "") ?? "{}")).toMatchObject({
      type: "status",
      status: "EXECUTING",
    });
    expect(JSON.parse(frames[1]?.replace(/^data: /, "") ?? "{}")).toMatchObject({
      type: "transcript",
      text: "hello",
    });
    expect(JSON.parse(frames[2]?.replace(/^data: /, "") ?? "{}")).toMatchObject({
      type: "status",
      from: "EXECUTING",
      to: "RECEIPT_ACQUISITION",
    });
    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(row?.status).toBe("EXECUTING");
  });
});
