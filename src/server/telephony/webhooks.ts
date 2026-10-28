import twilio from "twilio";

import { env } from "~/shared/config/env";

/** Public callback URL for a Twilio webhook path. */
export function twilioCallbackUrl(path: string): string {
  return `${env.BETTER_AUTH_URL.replace(/\/$/, "")}${path}`;
}

let tokenOverride: string | null | undefined;

/**
 * Test seam: substitute the Twilio auth token signatures verify against.
 * Pass `null` to restore the environment value.
 */
export function setTwilioAuthTokenOverride(token: string | null): void {
  tokenOverride = token;
}

/**
 * Verify a Twilio webhook (`X-Twilio-Signature` over the full public URL and
 * the form params). False when the auth token or the signature is missing,
 * so misconfiguration fails closed.
 */
export function validateTwilioSignature(req: Request, params: Record<string, string>): boolean {
  const token = tokenOverride ?? env.TWILIO_AUTH_TOKEN;
  const signature = req.headers.get("x-twilio-signature");
  if (!token || !signature) return false;
  const url = new URL(req.url);
  return twilio.validateRequest(
    token,
    signature,
    twilioCallbackUrl(url.pathname + url.search),
    params,
  );
}
