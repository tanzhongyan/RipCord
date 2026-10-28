import twilio from "twilio";

import { validateTwilioSignature } from "~/server/telephony";

const CONFERENCE_RE = /^[\w-]+$/;

function twimlResponse(
  build: (voice: InstanceType<typeof twilio.twiml.VoiceResponse>) => void,
): Response {
  const voice = new twilio.twiml.VoiceResponse();
  build(voice);
  return new Response(voice.toString(), { headers: { "Content-Type": "text/xml" } });
}

/**
 * `POST /api/telephony/twilio/gather`: the holder-bridge press-1 handler.
 * A `1` joins the conference named in `?conf=`; anything else (or a bad
 * signature) hangs up. The provider leg waits silently until the holder
 * joins.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return Response.json({ code: "VALIDATION", message: "Invalid request" }, { status: 400 });
  }
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") params[key] = value;
  });
  if (!validateTwilioSignature(req, params)) {
    return Response.json({ code: "FORBIDDEN", message: "Invalid signature" }, { status: 403 });
  }
  const conf = new URL(req.url).searchParams.get("conf") ?? "";
  if (params.Digits !== "1" || !CONFERENCE_RE.test(conf)) {
    return twimlResponse((voice) => {
      voice.hangup();
    });
  }
  return twimlResponse((voice) => {
    voice.dial().conference({ startConferenceOnEnter: true, endConferenceOnExit: true }, conf);
  });
}
