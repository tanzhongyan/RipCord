import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { type ApprovalDeps, approveStep, type ValkeyClient } from "~/features/identity";
import { db } from "~/server/db";
import {
  accountHolders,
  caseSteps,
  cases,
  communications,
  providerChannels,
  vaultSecrets,
} from "~/server/db/schema";
import { lastFakeRequest, setFakeResponses } from "~/server/model/fake";
import {
  SimulatedAdapter,
  type TelephonyAdapter,
  type TelephonyEvent,
  type TelephonyEventMap,
} from "~/server/telephony";
import { secretToken } from "~/server/vault";
import { tokenSetSimilarity } from "./call";
import { setEventsOverride } from "./events";
import { runNextStep } from "./executor";
import { setLiveModeOverride } from "./sandbox";
import {
  FakeEvents,
  seedAccountSecret,
  seedCase,
  seedChannel,
  seedHolder,
  seedMandate,
  seedProvider,
  seedStep,
  seedTerms,
  seedUser,
} from "./test-support";

afterEach(() => {
  setEventsOverride(null);
  setFakeResponses([]);
  setLiveModeOverride(null);
});

async function setupCallCase(
  input: { ivrPath?: Array<{ prompt: string; digits: string }> | null; address?: string } = {},
) {
  const user = await seedUser();
  const provider = await seedProvider({ name: "Demo Telco" });
  const holder = await seedHolder(user.id);
  await db.update(accountHolders).set({ userId: user.id }).where(eq(accountHolders.id, holder.id));
  const account = await seedAccountSecret(holder.id, "DT-88231-004");
  const c = await seedCase({
    ownerId: user.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceType: "MOBILE_POSTPAID",
    status: "EXECUTING",
  });
  const channel = await seedChannel(provider.id, {
    kind: "PHONE_IVR",
    serviceType: null,
    address: input.address ?? "+15005550006",
    ivrPath: input.ivrPath === undefined ? null : input.ivrPath,
    requiredSecrets: ["FULL_NAME", "NRIC", "ACCOUNT_NO"],
    noticeDays: 30,
  });
  await seedTerms(c.id, { noticeDays: 30 });
  await seedMandate({
    caseId: c.id,
    holderId: holder.id,
    providerId: provider.id,
    serviceSecretId: account.id,
    status: "ACTIVE",
  });
  const step = await seedStep(c.id, {
    seq: 1,
    tool: "place-call",
    args: { providerChannelId: channel.id, kind: "PHONE_IVR" },
    status: "AWAITING_APPROVAL",
    requiresApproval: true,
    approvedAt: new Date(),
    approvedByUserId: user.id,
  });
  return { user, c, channel, step, holder };
}

function cardsResponse(cards: Array<{ kind: string; say: string; why: string }>) {
  return { text: JSON.stringify({ cards }) };
}

/**
 * Approval plumbing for the call tests. The boundary rule keeps feature
 * test-support self-contained, so the tiny store lives here instead of
 * reusing the identity fakes. Self-service holders never touch it.
 */
function fakeApprovalDeps() {
  const store = new Map<string, string>();
  const messages: Array<{ to: string; body: string }> = [];
  const valkey: ValkeyClient = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    setNx: async (key, value) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    incr: async (key) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    ttl: async () => -1,
    del: async (key) => {
      store.delete(key);
    },
  };
  const approval: ApprovalDeps = {
    db,
    valkey,
    sms: async (to, body) => {
      messages.push({ to, body });
    },
    now: () => new Date(),
  };
  return { approval, messages };
}

function confirmedResponse() {
  return {
    text: JSON.stringify({
      reference_code: "DT-48213",
      effective_date: "2026-11-30",
      final_bill_estimate_cents: 1240,
      outcome: "CONFIRMED",
      requested_items: [],
    }),
  };
}

describe("B5 Sales options blocked", () => {
  it("hangs up and fails the step when the model picks a sales option", async () => {
    setEventsOverride(new FakeEvents());
    const { c, step } = await setupCallCase();
    const adapter = new SimulatedAdapter({
      slug: "sales-test",
      turns: [
        {
          speaker: "IVR",
          text: "Press 1 to cancel. Press 2 for new plans and upgrades.",
          durationS: 5,
          expectsDigits: true,
          nextOnDigits: {},
        },
      ],
    });
    setFakeResponses([
      // Passes the allow-list ("billing") but hits the block-list ("new", "upgrades").
      { text: JSON.stringify({ digit: "2", option_label: "billing and new upgrades" }) },
    ]);

    const outcome = await runNextStep(c.id, { call: { adapter } });

    expect(outcome.status).toBe("failed");
    expect(adapter.digitsSent).toEqual([]);
    expect(adapter.hungUp).toHaveLength(1);
    const [failed] = await db
      .select({ status: caseSteps.status, result: caseSteps.result })
      .from(caseSteps)
      .where(eq(caseSteps.id, step.id))
      .limit(1);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.result).toMatchObject({ outcome: "MENU_OPTION_BLOCKED" });
    expect(lastFakeRequest()?.model).toBe("muse-spark-1.3-contributor");
  });
});

describe("B6 Known path", () => {
  it("sends the ivr_path digits on a matching prompt", async () => {
    setEventsOverride(new FakeEvents());
    const { c } = await setupCallCase({
      ivrPath: [{ prompt: "for account matters press 3", digits: "3" }],
    });
    const adapter = new SimulatedAdapter({
      slug: "known-path",
      turns: [
        {
          speaker: "IVR",
          text: "For account matters, press 3",
          durationS: 4,
          expectsDigits: true,
          nextOnDigits: { "3": 1 },
        },
        {
          speaker: "REP",
          text: "Confirmed. Reference: DT-48213, effective 30 Nov 2026.",
          durationS: 8,
        },
      ],
    });
    setFakeResponses([
      cardsResponse([
        {
          kind: "INFO",
          say: "Thanks, please confirm the reference and date in writing.",
          why: "Written confirmation proves the termination.",
        },
      ]),
      confirmedResponse(),
    ]);

    expect(
      tokenSetSimilarity("For account matters, press 3", "for account matters press 3"),
    ).toBeGreaterThanOrEqual(0.6);
    await runNextStep(c.id, { call: { adapter, bridgeWaitMs: 50 } });

    expect(adapter.digitsSent.map((entry) => entry.digits)).toEqual(["3"]);
    const [updated] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(updated?.status).toBe("RECEIPT_ACQUISITION");
    expect(adapter.holdersBridged).toHaveLength(1);
  });
});

describe("B7 Cards", () => {
  it("publishes a COUNTER card that declines the retention offer", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    const { c } = await setupCallCase();
    const adapter = new SimulatedAdapter({
      slug: "retention-test",
      turns: [
        { speaker: "REP", text: "We can give you 50% off for 6 months", durationS: 6 },
        {
          speaker: "REP",
          text: "Fine, it is cancelled. Reference: DT-1, effective 30 Nov 2026.",
          durationS: 6,
        },
      ],
    });
    setFakeResponses([
      cardsResponse([
        {
          kind: "COUNTER",
          say: "No thanks, please cancel the service as requested.",
          why: "The mandate authorises termination only, no offers.",
        },
      ]),
      cardsResponse([
        {
          kind: "INFO",
          say: "Thanks, please confirm the reference in writing.",
          why: "Written confirmation proves the termination.",
        },
      ]),
      confirmedResponse(),
    ]);

    await runNextStep(c.id, { call: { adapter, bridgeWaitMs: 50 } });

    const cards = events.published
      .map(
        (event) =>
          JSON.parse(event.message) as {
            type?: string;
            card?: { kind: string; say: string; why: string };
          },
      )
      .filter((event) => event.type === "card");
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const counter = cards.find((event) => event.card?.kind === "COUNTER")?.card;
    expect(counter).toBeDefined();
    expect(counter?.say).toMatch(/cancel/i);
    expect(counter?.say.length).toBeLessThanOrEqual(200);
    expect(counter?.why.length).toBeLessThanOrEqual(160);
  });
});

describe("call runner extras", () => {
  it("bridges on a model HUMAN_AGENT verdict when the turn has no duration", async () => {
    setEventsOverride(new FakeEvents());
    const { c } = await setupCallCase();
    const adapter = new SimulatedAdapter({
      slug: "classify-test",
      turns: [
        { speaker: "REP", text: "Hello, how can I help you today?" },
        {
          speaker: "REP",
          text: "Confirmed. Reference: DT-48213, effective 30 Nov 2026.",
          durationS: 8,
        },
      ],
    });
    setFakeResponses([
      cardsResponse([
        { kind: "INFO", say: "Please cancel the service.", why: "The mandate says so." },
      ]),
      { text: JSON.stringify({ verdict: "HUMAN_AGENT" }) },
      cardsResponse([{ kind: "INFO", say: "Thanks for confirming.", why: "The call is ending." }]),
      confirmedResponse(),
    ]);

    await runNextStep(c.id, { call: { adapter, bridgeWaitMs: 50 } });

    expect(adapter.holdersBridged).toHaveLength(1);
  });

  it("redacts transcribed audio before storage", async () => {
    setEventsOverride(new FakeEvents());
    const { c, holder } = await setupCallCase();
    const handlers = new Map<TelephonyEvent, Set<(payload: never) => void>>();
    const stub: TelephonyAdapter = {
      placeCall: async () => {
        queueMicrotask(() => {
          for (const handler of handlers.get("answered") ?? [])
            handler({ callId: "stub-1" } as never);
          for (const handler of handlers.get("transcript") ?? []) {
            handler({
              callId: "stub-1",
              speaker: "REP",
              text: null,
              durationS: 8,
              expectsDigits: false,
            } as never);
          }
          for (const handler of handlers.get("ended") ?? []) {
            handler({ callId: "stub-1", reason: "completed" } as never);
          }
        });
        return { callId: "stub-1" };
      },
      sendDigits: async () => {},
      audio: async function* () {
        yield new Uint8Array([1, 2, 3]);
      },
      bridgeHolder: async () => {},
      hangUp: async () => {},
      on: <E extends TelephonyEvent>(
        event: E,
        handler: (payload: TelephonyEventMap[E]) => void,
      ): (() => void) => {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        const fn = handler as (payload: never) => void;
        set.add(fn);
        return () => {
          handlers.get(event)?.delete(fn);
        };
      },
    };
    setFakeResponses([
      cardsResponse([{ kind: "INFO", say: "Please confirm in writing.", why: "Proof matters." }]),
      confirmedResponse(),
    ]);

    await runNextStep(c.id, {
      call: {
        adapter: stub,
        transcribe: async () => ({ text: `Your account DT-88231-004 is confirmed, ${holder.id}` }),
        bridgeWaitMs: 10,
      },
    });

    const rows = await db
      .select({ body: communications.body })
      .from(communications)
      .where(eq(communications.caseId, c.id));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.body).not.toContain("DT-88231-004");
    }
    expect(rows.some((row) => row.body.includes("{{vault:ACCOUNT_NO:"))).toBe(true);
  });

  it("holds sensitive token digits for a fresh holder approval", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    const { user, c, channel, step, holder } = await setupCallCase();
    const [account] = await db
      .select({ id: vaultSecrets.id })
      .from(vaultSecrets)
      .where(
        and(
          eq(vaultSecrets.holderId, holder.id),
          eq(vaultSecrets.kind, "ACCOUNT_NO"),
          isNull(vaultSecrets.deletedAt),
        ),
      )
      .limit(1);
    if (!account) throw new Error("account secret missing");
    await db
      .update(providerChannels)
      .set({
        ivrPath: [
          { prompt: "enter your account number", digits: secretToken("ACCOUNT_NO", account.id) },
        ],
      })
      .where(eq(providerChannels.id, channel.id));
    const adapter = new SimulatedAdapter({
      slug: "token-digits",
      turns: [
        {
          speaker: "IVR",
          text: "Please enter your account number",
          durationS: 4,
          expectsDigits: true,
          nextOnDigits: { "DT-88231-004": 1 },
        },
        {
          speaker: "REP",
          text: "Confirmed. Reference: DT-48213, effective 30 Nov 2026.",
          durationS: 8,
        },
      ],
    });
    setFakeResponses([
      cardsResponse([
        { kind: "INFO", say: "Thanks, please confirm in writing.", why: "Proof matters." },
      ]),
      confirmedResponse(),
    ]);
    const { approval, messages } = fakeApprovalDeps();

    const run = runNextStep(c.id, { call: { adapter, bridgeWaitMs: 50, approval } });
    // Wait for the runner to supersede the placement approval, then tap
    // approve as the self-service holder (no SMS code).
    for (let i = 0; i < 400; i++) {
      const [row] = await db
        .select({ approvedAt: caseSteps.approvedAt })
        .from(caseSteps)
        .where(eq(caseSteps.id, step.id))
        .limit(1);
      if (row && row.approvedAt === null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await approveStep({ stepId: step.id }, { userId: user.id, orgIds: [] }, approval);
    await run;

    expect(adapter.digitsSent.map((entry) => entry.digits)).toEqual(["DT-88231-004"]);
    expect(messages).toHaveLength(0);
    const approvalEvent = events.published
      .map((event) => JSON.parse(event.message) as Record<string, unknown>)
      .find((event) => event.type === "step" && event.approvalRequested === true);
    expect(approvalEvent).toMatchObject({ stepId: step.id, status: "RUNNING" });
  });

  it("denies sensitive token digits when the fresh approval never arrives", async () => {
    setEventsOverride(new FakeEvents());
    const { c, channel, step, holder } = await setupCallCase();
    const [account] = await db
      .select({ id: vaultSecrets.id })
      .from(vaultSecrets)
      .where(
        and(
          eq(vaultSecrets.holderId, holder.id),
          eq(vaultSecrets.kind, "ACCOUNT_NO"),
          isNull(vaultSecrets.deletedAt),
        ),
      )
      .limit(1);
    if (!account) throw new Error("account secret missing");
    await db
      .update(providerChannels)
      .set({
        ivrPath: [
          { prompt: "enter your account number", digits: secretToken("ACCOUNT_NO", account.id) },
        ],
      })
      .where(eq(providerChannels.id, channel.id));
    const adapter = new SimulatedAdapter({
      slug: "token-digits-denied",
      turns: [
        {
          speaker: "IVR",
          text: "Please enter your account number",
          durationS: 4,
          expectsDigits: true,
          nextOnDigits: { "DT-88231-004": 1 },
        },
        {
          speaker: "REP",
          text: "Confirmed. Reference: DT-48213, effective 30 Nov 2026.",
          durationS: 8,
        },
      ],
    });
    const { approval } = fakeApprovalDeps();

    const outcome = await runNextStep(c.id, {
      call: {
        adapter,
        bridgeWaitMs: 50,
        approval,
        approvalWaitMs: 30,
        sleep: () => Promise.resolve(),
      },
    });

    expect(outcome.status).toBe("failed");
    expect(adapter.digitsSent).toEqual([]);
    const [failed] = await db
      .select({ status: caseSteps.status, result: caseSteps.result })
      .from(caseSteps)
      .where(eq(caseSteps.id, step.id))
      .limit(1);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.result).toMatchObject({ code: "VAULT_RELEASE_DENIED" });
  });
});
