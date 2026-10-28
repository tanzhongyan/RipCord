import nodemailer from "nodemailer";

import { sendWithRetry } from "~/features/identity";
import { env } from "~/shared/config/env";

export interface MailAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface MailMessage {
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<{ messageId: string }>;
}

/** SMTP retry delays after the first attempt: 5 s then 30 s (spec 0005). */
export const EMAIL_RETRY_DELAYS_MS = [5000, 30000];

let override: MailTransport | null = null;

/** Test seam: substitute a fake mail transport. Pass null to restore SMTP. */
export function setMailOverride(transport: MailTransport | null): void {
  override = transport;
}

export interface SendMailOpts {
  /** Sandbox mail goes to `SANDBOX_SMTP_URL`; live mail to `SMTP_URL`. */
  sandbox: boolean;
  /** Retry delays. Tests pass zeros; production uses `EMAIL_RETRY_DELAYS_MS`. */
  delaysMs?: number[];
}

function liveTransport(sandbox: boolean): MailTransport {
  const transporter = nodemailer.createTransport(sandbox ? env.SANDBOX_SMTP_URL : env.SMTP_URL);
  return {
    async sendMail(message: MailMessage): Promise<{ messageId: string }> {
      const info = await transporter.sendMail({
        from: message.from,
        to: message.to,
        cc: message.cc,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: Buffer.from(attachment.content),
          contentType: attachment.contentType,
        })),
      });
      return { messageId: info.messageId };
    },
  };
}

/**
 * Send one email, retrying twice with back-off. Returns the `Message-ID`
 * the executor saves in `communications.external_ref`.
 */
export async function sendMail(
  message: MailMessage,
  opts: SendMailOpts,
): Promise<{ messageId: string }> {
  const transport = override ?? liveTransport(opts.sandbox);
  let messageId = "";
  await sendWithRetry(async () => {
    messageId = (await transport.sendMail(message)).messageId;
  }, opts.delaysMs ?? EMAIL_RETRY_DELAYS_MS);
  return { messageId };
}
