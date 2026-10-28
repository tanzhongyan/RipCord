import { handleTwilioStatus } from "~/features/cases/server/telephony-status";
import { validateTwilioSignature } from "~/server/telephony";

/**
 * `POST /api/telephony/twilio/status`: Twilio call-progress callbacks.
 * The signature is checked with `twilio.validateRequest`; the verified
 * params route through the case server.
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
  return Response.json(await handleTwilioStatus(params));
}
