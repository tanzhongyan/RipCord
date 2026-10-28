import twilio from "twilio";

import { env } from "~/shared/config/env";

export type SmsSender = (to: string, body: string) => Promise<void>;

/** Retry delays after the first attempt: 2s then 8s (spec 0001). */
export const SMS_RETRY_DELAYS_MS = [2000, 8000];

let override: SmsSender | null = null;

/** Test seam: substitute a fake SMS sender. Pass null to restore the real one. */
export function setSmsOverride(sender: SmsSender | null): void {
  override = sender;
}

/**
 * Send one SMS. Without Twilio configured, non-production logs the message to
 * the console; production refuses to send.
 */
export const sendSms: SmsSender = async (to, body) => {
  if (override) return override(to, body);
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_SMS_FROM;
  if (!sid || !token || !from) {
    if (env.NODE_ENV === "production") throw new Error("Twilio is not configured");
    console.log(`SMS to ****${to.slice(-4)}: ${body}`);
    return;
  }
  const client = twilio(sid, token);
  try {
    await sendWithRetry(() => client.messages.create({ to, from, body }), SMS_RETRY_DELAYS_MS);
  } catch (error) {
    throw new Error("Could not send code", { cause: error });
  }
};

/** Run `send` once, then once more per delay. Rejects with the last error. */
export async function sendWithRetry(send: () => unknown, delaysMs: number[]): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) await sleep(delaysMs[attempt - 1] ?? 0);
    try {
      await send();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
