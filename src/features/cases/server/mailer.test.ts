import { afterEach, describe, expect, it } from "vitest";

import { EMAIL_RETRY_DELAYS_MS, type MailMessage, sendMail, setMailOverride } from "./mailer";
import { FakeMailTransport } from "./test-support";

afterEach(() => {
  setMailOverride(null);
});

function message(): MailMessage {
  return {
    from: "RipCord <noreply@ripcord.local>",
    to: "cancel@demo-telco.test",
    subject: "Termination request",
    text: "Please cancel.",
    attachments: [],
  };
}

describe("mailer", () => {
  it("retries twice with the spec back-off", () => {
    expect(EMAIL_RETRY_DELAYS_MS).toEqual([5000, 30000]);
  });

  it("sends through the override transport and returns the Message-ID", async () => {
    const outbox = new FakeMailTransport();
    setMailOverride(outbox);

    const { messageId } = await sendMail(message(), { sandbox: true, delaysMs: [0, 0] });

    expect(messageId).toBe("<fake-1@ripcord.test>");
    expect(outbox.sent).toHaveLength(1);
  });

  it("retries a failing send, then succeeds", async () => {
    const outbox = new FakeMailTransport();
    outbox.failuresLeft = 1;
    setMailOverride(outbox);

    await sendMail(message(), { sandbox: true, delaysMs: [0, 0] });

    expect(outbox.sent).toHaveLength(1);
  });

  it("throws after the retries run out", async () => {
    const outbox = new FakeMailTransport();
    outbox.failuresLeft = 3;
    setMailOverride(outbox);

    await expect(sendMail(message(), { sandbox: true, delaysMs: [0, 0] })).rejects.toThrow(
      "FakeMailTransport: send failed",
    );
    expect(outbox.sent).toHaveLength(0);
  });
});
