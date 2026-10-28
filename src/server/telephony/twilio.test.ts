import { afterEach, describe, expect, it } from "vitest";
import { FakeValkey } from "~/features/cases/server/test-support";
import { setValkeyOverride } from "~/features/identity";
import { holderLegKey, TwilioAdapter, type TwilioCalls } from "./twilio";

afterEach(() => {
  setValkeyOverride(null);
});

interface CreatedCall {
  to: string;
  from: string;
  twiml: string;
  statusCallback?: string;
  statusCallbackEvent?: string[];
}

interface UpdatedCall {
  sid: string;
  status?: string;
  twiml?: string;
}

function fakeClient(sids: string[] = ["CAprovider1"]) {
  const created: CreatedCall[] = [];
  const updated: UpdatedCall[] = [];
  const queue = [...sids];
  const calls = ((sid: string) => ({
    update: async (params: { status?: "completed" | "canceled"; twiml?: string }) => {
      updated.push({ sid, ...params });
      return {};
    },
  })) as unknown as TwilioCalls;
  calls.create = async (params: CreatedCall) => {
    created.push(params);
    const sid = queue.shift() ?? `CAfake${created.length}`;
    return { sid };
  };
  return { calls, created, updated };
}

const DEPS = {
  from: "+15005550000",
  streamUrl: "wss://worker.test/twilio/stream",
  statusCallbackUrl: "https://app.test/api/telephony/twilio/status",
  gatherUrl: "https://app.test/api/telephony/twilio/gather",
};

describe("Twilio adapter", () => {
  it("opens outbound legs with a media-stream TwiML document", async () => {
    const { calls, created } = fakeClient(["CAprovider1"]);
    const adapter = new TwilioAdapter({ client: calls, ...DEPS });

    const { callId } = await adapter.placeCall("+15005550006");

    expect(callId).toBe("CAprovider1");
    expect(created).toHaveLength(1);
    expect(created[0]?.to).toBe("+15005550006");
    expect(created[0]?.from).toBe("+15005550000");
    expect(created[0]?.twiml).toContain('<Stream url="wss://worker.test/twilio/stream"/>');
    expect(created[0]?.statusCallback).toBe("https://app.test/api/telephony/twilio/status");
    expect(created[0]?.statusCallbackEvent).toContain("answered");
    expect(created[0]?.statusCallbackEvent).toContain("completed");
  });

  it("sends digits as a Play update", async () => {
    const { calls, updated } = fakeClient();
    const adapter = new TwilioAdapter({ client: calls, ...DEPS });

    await adapter.sendDigits("CAprovider1", "3");

    expect(updated).toHaveLength(1);
    expect(updated[0]?.sid).toBe("CAprovider1");
    expect(updated[0]?.twiml).toContain('digits="3"');
  });

  it("hangs up by completing the call", async () => {
    const { calls, updated } = fakeClient();
    const adapter = new TwilioAdapter({ client: calls, ...DEPS });

    await adapter.hangUp("CAprovider1");

    expect(updated).toEqual([{ sid: "CAprovider1", status: "completed" }]);
  });

  it("bridges the holder through a press-1 conference", async () => {
    const { calls, created, updated } = fakeClient(["CAholder9"]);
    const valkey = new FakeValkey();
    const adapter = new TwilioAdapter({
      client: calls,
      valkey,
      providerNameForCall: async () => "Demo Telco",
      ...DEPS,
    });

    await adapter.bridgeHolder("CAprovider1", "+6590000000");

    expect(created).toHaveLength(1);
    expect(created[0]?.to).toBe("+6590000000");
    expect(created[0]?.twiml).toContain("press 1 to join");
    expect(created[0]?.twiml).toContain("Demo Telco");
    expect(created[0]?.twiml).toContain("conf=ripcord-CAprovider1");
    expect(await valkey.get(holderLegKey("CAholder9"))).toBe(
      JSON.stringify({ providerCallSid: "CAprovider1" }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.sid).toBe("CAprovider1");
    expect(updated[0]?.twiml).toContain("ripcord-CAprovider1");
    expect(updated[0]?.twiml).toContain('startConferenceOnEnter="false"');
  });

  it("streams worker-fed audio chunks", async () => {
    const { calls } = fakeClient();
    const adapter = new TwilioAdapter({ client: calls, ...DEPS });
    adapter.ingestAudio("CA1", new Uint8Array([1]));
    adapter.ingestAudio("CA1", new Uint8Array([2]));
    adapter.endAudio("CA1");

    const chunks: number[][] = [];
    for await (const chunk of adapter.audio("CA1")) {
      chunks.push([...chunk]);
    }
    expect(chunks).toEqual([[1], [2]]);
  });

  it("emits no events: leg statuses arrive on the callback route", async () => {
    const { calls } = fakeClient();
    const adapter = new TwilioAdapter({ client: calls, ...DEPS });
    let fired = 0;
    const off = adapter.on("answered", () => {
      fired += 1;
    });
    off();
    await adapter.placeCall("+15005550006");
    expect(fired).toBe(0);
  });

  it("fails closed without a sender number", async () => {
    const { calls } = fakeClient();
    const adapter = new TwilioAdapter({ client: calls });
    await expect(adapter.placeCall("+15005550006")).rejects.toThrow(
      "TWILIO_VOICE_FROM is not configured",
    );
  });
});
