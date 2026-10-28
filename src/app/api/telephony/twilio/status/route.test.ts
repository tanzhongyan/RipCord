import { getExpectedTwilioSignature } from "twilio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setEventsOverride } from "~/features/cases/server/events";
import {
  FakeEvents,
  FakeValkey,
  readCaseStatus,
  readStep,
  seedLiveCall,
  succeedStep,
} from "~/features/cases/server/test-support";
import { setValkeyOverride } from "~/features/identity";
import { holderLegKey, setTwilioAuthTokenOverride, twilioCallbackUrl } from "~/server/telephony";
import { POST } from "./route";

const AUTH_TOKEN = "test-auth-token-000000000000000000";

beforeEach(() => {
  setTwilioAuthTokenOverride(AUTH_TOKEN);
});

afterEach(() => {
  setEventsOverride(null);
  setValkeyOverride(null);
  setTwilioAuthTokenOverride(null);
});

function signedRequest(path: string, params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const signature = getExpectedTwilioSignature(AUTH_TOKEN, twilioCallbackUrl(path), params);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
  });
}

describe("POST /api/telephony/twilio/status", () => {
  it("rejects unsigned callbacks", async () => {
    const response = await POST(
      new Request("http://localhost/api/telephony/twilio/status", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CAx", CallStatus: "completed" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("publishes step events for provider-leg progress", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    setValkeyOverride(new FakeValkey());
    const { c, step, callSid } = await seedLiveCall();

    const response = await POST(
      signedRequest("/api/telephony/twilio/status", {
        CallSid: callSid,
        CallStatus: "in-progress",
      }),
    );

    expect(response.status).toBe(200);
    const stepEvents = events.published
      .map((event) => JSON.parse(event.message) as Record<string, unknown>)
      .filter((event) => event.type === "step");
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]).toMatchObject({
      caseId: c.id,
      stepId: step.id,
      callStatus: "in-progress",
    });
    expect((await readStep(step.id))?.status).toBe("RUNNING");
  });

  it("fails a still-running step on a terminal status", async () => {
    setEventsOverride(new FakeEvents());
    setValkeyOverride(new FakeValkey());
    const { c, step, callSid } = await seedLiveCall();

    const response = await POST(
      signedRequest("/api/telephony/twilio/status", { CallSid: callSid, CallStatus: "no-answer" }),
    );

    expect(response.status).toBe(200);
    expect((await readStep(step.id))?.status).toBe("FAILED");
    // Single channel, already tried: no viable re-plan, case failed.
    expect(await readCaseStatus(c.id)).toBe("FAILED");
  });

  it("ignores terminal statuses for settled steps", async () => {
    setEventsOverride(new FakeEvents());
    setValkeyOverride(new FakeValkey());
    const { step, callSid } = await seedLiveCall();
    await succeedStep(step.id, { outcome: "CONFIRMED" });

    const response = await POST(
      signedRequest("/api/telephony/twilio/status", { CallSid: callSid, CallStatus: "completed" }),
    );

    expect(response.status).toBe(200);
    const settled = await readStep(step.id);
    expect(settled?.status).toBe("SUCCEEDED");
    expect(settled?.result).toMatchObject({ outcome: "CONFIRMED" });
  });

  it("publishes holder_joined when the holder leg answers", async () => {
    const events = new FakeEvents();
    setEventsOverride(events);
    const valkey = new FakeValkey();
    setValkeyOverride(valkey);
    const { c, step, callSid } = await seedLiveCall();
    await valkey.set(
      holderLegKey("CAholderleg1"),
      JSON.stringify({ providerCallSid: callSid }),
      "EX",
      3600,
    );

    const response = await POST(
      signedRequest("/api/telephony/twilio/status", {
        CallSid: "CAholderleg1",
        CallStatus: "in-progress",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, leg: "holder" });
    const joins = events.published
      .map((event) => JSON.parse(event.message) as Record<string, unknown>)
      .filter((event) => event.type === "holder_joined");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ caseId: c.id, stepId: step.id, callId: callSid });
  });

  it("acknowledges unknown call SIDs without failing", async () => {
    setEventsOverride(new FakeEvents());
    setValkeyOverride(new FakeValkey());

    const response = await POST(
      signedRequest("/api/telephony/twilio/status", {
        CallSid: "CAunknown0000000000000000000000",
        CallStatus: "completed",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, unknown: true });
  });
});
