import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "~/server/db";
import { cases } from "~/server/db/schema";
import { env } from "~/shared/config/env";
import { setEventsOverride } from "./events";
import { planChannel } from "./planner";
import { isLiveCase, liveModeEnabled, setLiveModeOverride } from "./sandbox";
import {
  FakeEvents,
  seedAccountSecret,
  seedCase,
  seedChannel,
  seedHolder,
  seedMandate,
  seedProvider,
  seedUser,
} from "./test-support";

const ACTOR = { type: "USER" as const, id: "user-1" };

afterEach(() => {
  setEventsOverride(null);
  setLiveModeOverride(null);
});

async function setupPlanning(liveModeApproved: boolean) {
  const user = await seedUser();
  const provider = await seedProvider({ name: "Demo Telco" });
  const holder = await seedHolder(user.id);
  const account = await seedAccountSecret(holder.id);
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceType: "MOBILE_POSTPAID",
    status: "CHANNEL_PLANNING",
  });
  const channel = await seedChannel(provider.id, {
    kind: "EMAIL",
    serviceType: null,
    address: "cancel@demo-telco.test",
    requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
  });
  await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: account.id,
    status: "ACTIVE",
    liveModeApproved,
  });
  return { c, channel };
}

async function sandboxOf(caseId: string): Promise<boolean | null> {
  const [row] = await db
    .select({ sandbox: cases.sandbox })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  return row?.sandbox ?? null;
}

describe("B3 Live gate", () => {
  it("keeps sandbox cases sandboxed when the mandate did not approve live mode", async () => {
    setEventsOverride(new FakeEvents());
    setLiveModeOverride(true);
    const { c } = await setupPlanning(false);

    const outcome = await planChannel(c.id, ACTOR);

    expect(outcome.planned).toBe(true);
    expect(await sandboxOf(c.id)).toBe(true);
  });

  it("leaves the sandbox only with the flag and the mandate approval together", async () => {
    setEventsOverride(new FakeEvents());
    setLiveModeOverride(true);
    const allowed = await setupPlanning(true);
    expect(await planChannel(allowed.c.id, ACTOR)).toMatchObject({ planned: true });
    expect(await sandboxOf(allowed.c.id)).toBe(false);

    setLiveModeOverride(null);
    const denied = await setupPlanning(true);
    expect(await planChannel(denied.c.id, ACTOR)).toMatchObject({ planned: true });
    expect(await sandboxOf(denied.c.id)).toBe(true);
  });
});

describe("live gate truth table", () => {
  it("needs the flag, a live case and the mandate approval", () => {
    expect(env.LIVE_MODE_ENABLED).toBe(false);
    expect(liveModeEnabled()).toBe(false);
    setLiveModeOverride(true);
    expect(liveModeEnabled()).toBe(true);
    expect(isLiveCase({ sandbox: false }, { liveModeApproved: true })).toBe(true);
    expect(isLiveCase({ sandbox: true }, { liveModeApproved: true })).toBe(false);
    expect(isLiveCase({ sandbox: false }, { liveModeApproved: false })).toBe(false);
    expect(isLiveCase({ sandbox: false }, null)).toBe(false);
    setLiveModeOverride(false);
    expect(isLiveCase({ sandbox: false }, { liveModeApproved: true })).toBe(false);
  });
});
