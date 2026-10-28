import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { setEventsOverride } from "~/features/cases/server/events";
import { FakeEvents, seedLiveCall, seedTerms } from "~/features/cases/server/test-support";
import { db } from "~/server/db";
import { caseSteps, cases } from "~/server/db/schema";
import { setFakeResponses } from "~/server/model/fake";
import type { TelephonyAdapter, TelephonyEvent, TelephonyEventMap } from "~/server/telephony";
import {
  abortLiveSession,
  createLiveSession,
  finishLiveSession,
  handleLiveTurn,
  type LiveSession,
  mapSpeakerLabel,
} from "./call-session";

afterEach(() => {
  setEventsOverride(null);
  setFakeResponses([]);
});

function stubAdapter() {
  const digits: Array<{ callId: string; digits: string }> = [];
  const bridged: Array<{ callId: string; holderPhone: string }> = [];
  const hungUp: string[] = [];
  const adapter: TelephonyAdapter = {
    placeCall: async (to: string) => {
      void to;
      return { callId: "CAlive1" };
    },
    sendDigits: async (callId: string, digitsSent: string) => {
      digits.push({ callId, digits: digitsSent });
    },
    audio: async function* () {},
    bridgeHolder: async (callId: string, holderPhone: string) => {
      bridged.push({ callId, holderPhone });
    },
    hangUp: async (callId: string) => {
      hungUp.push(callId);
    },
    on:
      <E extends TelephonyEvent>(
        _event: E,
        _handler: (payload: TelephonyEventMap[E]) => void,
      ): (() => void) =>
      () => {},
  };
  return { adapter, digits, bridged, hungUp };
}

async function setupLiveCall(ivrPath: Array<{ prompt: string; digits: string }> | null = null) {
  const seeded = await seedLiveCall({ ivrPath, callSid: "CAlive1", accountNo: "DT-88231-004" });
  await seedTerms(seeded.c.id, { noticeDays: 30 });
  return seeded;
}

async function openSession(adapter: TelephonyAdapter): Promise<LiveSession> {
  const session = await createLiveSession("CAlive1", "MZstream1", { adapter });
  if (!session) throw new Error("live session did not open");
  return session;
}

function cardsResponse() {
  return {
    text: JSON.stringify({
      cards: [{ kind: "INFO", say: "Please confirm in writing.", why: "Proof matters." }],
    }),
  };
}

describe("speaker labels", () => {
  it("maps known labels and punts on diarization ids", () => {
    expect(mapSpeakerLabel("agent-1")).toBe("REP");
    expect(mapSpeakerLabel("IVR menu")).toBe("IVR");
    expect(mapSpeakerLabel("caller")).toBe("HOLDER");
    expect(mapSpeakerLabel("speaker_0")).toBeNull();
    expect(mapSpeakerLabel(null)).toBeNull();
  });
});

describe("live sessions", () => {
  it("opens for a handed-off call and rejects unknown SIDs", async () => {
    setEventsOverride(new FakeEvents());
    await setupLiveCall();
    const { adapter } = stubAdapter();

    expect(await createLiveSession("CAunknown", "MZx", { adapter })).toBeNull();
    const session = await openSession(adapter);
    expect(session.callSid).toBe("CAlive1");
    expect(session.streamSid).toBe("MZstream1");
  });

  it("sends ivr_path digits on a menu turn, then stops after the bridge", async () => {
    setEventsOverride(new FakeEvents());
    await setupLiveCall([{ prompt: "for account matters press 3", digits: "3" }]);
    const { adapter, digits, bridged } = stubAdapter();
    const session = await openSession(adapter);
    setFakeResponses([{ text: JSON.stringify({ expects_digits: true }) }, cardsResponse()]);

    await handleLiveTurn(
      session,
      { text: "For account matters, press 3", speakerLabel: "ivr" },
      { adapter },
    );
    expect(digits).toEqual([{ callId: "CAlive1", digits: "3" }]);

    await handleLiveTurn(
      session,
      { text: "We can offer a discount.", speakerLabel: "agent" },
      { adapter },
    );
    expect(bridged).toHaveLength(1);

    // After the bridge the holder talks; menus no longer take digits.
    await handleLiveTurn(
      session,
      { text: "For account matters, press 3", speakerLabel: "ivr" },
      { adapter },
    );
    expect(digits).toHaveLength(1);
  });

  it("skips digits for non-menu IVR turns", async () => {
    setEventsOverride(new FakeEvents());
    await setupLiveCall([{ prompt: "for account matters press 3", digits: "3" }]);
    const { adapter, digits } = stubAdapter();
    const session = await openSession(adapter);
    setFakeResponses([{ text: JSON.stringify({ expects_digits: false }) }]);

    await handleLiveTurn(session, { text: "Please hold.", speakerLabel: "ivr" }, { adapter });

    expect(digits).toHaveLength(0);
  });

  it("hangs up and fails the step on a blocked menu", async () => {
    setEventsOverride(new FakeEvents());
    const { step } = await setupLiveCall();
    const { adapter, hungUp } = stubAdapter();
    const session = await openSession(adapter);
    setFakeResponses([
      { text: JSON.stringify({ expects_digits: true }) },
      { text: JSON.stringify({ digit: "2", option_label: "billing and new upgrades" }) },
    ]);

    await handleLiveTurn(
      session,
      { text: "Press 2 for new plans and upgrades.", speakerLabel: "ivr" },
      { adapter },
    );

    expect(hungUp).toEqual(["CAlive1"]);
    const [failed] = await db
      .select({ status: caseSteps.status })
      .from(caseSteps)
      .where(eq(caseSteps.id, step.id))
      .limit(1);
    expect(failed?.status).toBe("FAILED");
  });

  it("classifies unknown speaker labels through the model", async () => {
    setEventsOverride(new FakeEvents());
    await setupLiveCall();
    const { adapter, bridged } = stubAdapter();
    const session = await openSession(adapter);
    setFakeResponses([{ text: JSON.stringify({ verdict: "HUMAN_AGENT" }) }, cardsResponse()]);

    await handleLiveTurn(
      session,
      { text: "Hello, how can I help?", speakerLabel: "speaker_0" },
      { adapter },
    );

    expect(bridged).toHaveLength(1);
  });

  it("aborts with TIMEOUT past the call cap", async () => {
    setEventsOverride(new FakeEvents());
    const { c, step } = await setupLiveCall();
    const { adapter, hungUp } = stubAdapter();
    const session = await openSession(adapter);
    session.startMs = Date.now() - 46 * 60 * 1000;

    await handleLiveTurn(session, { text: "Hello?", speakerLabel: "ivr" }, { adapter });

    expect(hungUp).toEqual(["CAlive1"]);
    const [failed] = await db
      .select({ status: cases.status, reason: cases.failureReason })
      .from(cases)
      .where(eq(cases.id, c.id))
      .limit(1);
    expect(failed).toMatchObject({ status: "FAILED", reason: "TIMEOUT" });
    const [stepRow] = await db
      .select({ status: caseSteps.status })
      .from(caseSteps)
      .where(eq(caseSteps.id, step.id))
      .limit(1);
    expect(stepRow?.status).toBe("FAILED");
  });

  it("settles a finished call from the transcript", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    await setupLiveCall();
    const { adapter } = stubAdapter();
    const session = await openSession(adapter);
    session.transcript.push({
      speaker: "REP",
      text: "Confirmed. Reference: DT-48213, effective 30 Nov 2026.",
    });
    setFakeResponses([
      {
        text: JSON.stringify({
          reference_code: "DT-48213",
          effective_date: "2026-11-30",
          final_bill_estimate_cents: 1240,
          outcome: "CONFIRMED",
          requested_items: [],
        }),
      },
    ]);

    await finishLiveSession(session, { adapter });

    const [updated] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, session.caseId))
      .limit(1);
    expect(updated?.status).toBe("RECEIPT_ACQUISITION");
  });

  it("aborts close the stream exactly once", async () => {
    setEventsOverride(new FakeEvents());
    await setupLiveCall();
    const { adapter } = stubAdapter();
    let closes = 0;
    const session = await createLiveSession("CAlive1", "MZstream1", {
      adapter,
      close: () => {
        closes += 1;
      },
    });
    if (!session) throw new Error("live session did not open");

    await abortLiveSession(session, "INTERNAL_ERROR", "boom");

    expect(closes).toBe(1);
  });
});
