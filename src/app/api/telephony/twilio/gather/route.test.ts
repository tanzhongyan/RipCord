import { getExpectedTwilioSignature } from "twilio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setTwilioAuthTokenOverride, twilioCallbackUrl } from "~/server/telephony";
import { POST } from "./route";

const AUTH_TOKEN = "test-auth-token-000000000000000000";

beforeEach(() => {
  setTwilioAuthTokenOverride(AUTH_TOKEN);
});

afterEach(() => {
  setTwilioAuthTokenOverride(null);
});

function signedRequest(search: string, params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const signature = getExpectedTwilioSignature(
    AUTH_TOKEN,
    twilioCallbackUrl(`/api/telephony/twilio/gather${search}`),
    params,
  );
  return new Request(`http://localhost/api/telephony/twilio/gather${search}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
  });
}

describe("POST /api/telephony/twilio/gather", () => {
  it("rejects unsigned callbacks", async () => {
    const response = await POST(
      new Request("http://localhost/api/telephony/twilio/gather?conf=ripcord-CA1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Digits: "1" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("joins the conference on press-1", async () => {
    const response = await POST(signedRequest("?conf=ripcord-CAprovider1", { Digits: "1" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    const twiml = await response.text();
    expect(twiml).toContain("<Conference");
    expect(twiml).toContain("ripcord-CAprovider1");
    expect(twiml).toContain('startConferenceOnEnter="true"');
  });

  it("hangs up on any other digit or conference name", async () => {
    const wrongDigit = await POST(signedRequest("?conf=ripcord-CA1", { Digits: "2" }));
    expect(await wrongDigit.text()).toContain("<Hangup/>");

    const badConf = await POST(signedRequest("?conf=../evil", { Digits: "1" }));
    expect(await badConf.text()).toContain("<Hangup/>");
  });
});
