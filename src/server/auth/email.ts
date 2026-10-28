import net from "node:net";

import { env } from "~/shared/config/env";

export type EmailSender = (to: string, subject: string, text: string) => Promise<void>;

const SMTP_TIMEOUT_MS = 5000;

/** Plain SMTP sender. Speaks unauthenticated SMTP to `SMTP_URL` (Mailpit in development). */
export const sendEmail: EmailSender = async (to, subject, text) => {
  const url = new URL(env.SMTP_URL);
  if (url.protocol !== "smtp:") throw new Error(`Unsupported SMTP_URL protocol: ${url.protocol}`);
  const from = extractAddress(env.MAIL_FROM);
  const message = [
    `From: ${env.MAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "",
  ].join("\r\n");
  await smtpSend({
    host: url.hostname,
    port: url.port ? Number(url.port) : 25,
    from,
    to,
    message,
  });
};

export function extractAddress(mailbox: string): string {
  const match = mailbox.match(/<([^<>]+)>/);
  return (match?.[1] ?? mailbox).trim();
}

export async function smtpSend(args: {
  host: string;
  port: number;
  from: string;
  to: string;
  message: string;
}): Promise<void> {
  const socket = net.createConnection({ host: args.host, port: args.port });
  socket.setEncoding("utf8");
  socket.setTimeout(SMTP_TIMEOUT_MS);
  const nextLine = createLineReader(socket);
  const run = async () => {
    await expectCode(nextLine, "220");
    await command(socket, nextLine, "EHLO ripcord\r\n", "250");
    await command(socket, nextLine, `MAIL FROM:<${args.from}>\r\n`, "250");
    await command(socket, nextLine, `RCPT TO:<${args.to}>\r\n`, "250");
    await command(socket, nextLine, "DATA\r\n", "354");
    await command(socket, nextLine, `${args.message}.\r\n`, "250");
    await command(socket, nextLine, "QUIT\r\n", "221");
  };
  try {
    await run();
  } finally {
    socket.destroy();
  }
}

type LineReader = () => Promise<string>;

/** One reader per socket. Rejects every pending read when the socket fails. */
function createLineReader(socket: net.Socket): LineReader {
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let buffer = "";
  let failed: Error | null = null;
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  socket.on("error", fail);
  socket.on("timeout", () => fail(new Error("SMTP timeout")));
  socket.on("close", () => fail(new Error("SMTP connection closed")));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\r\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
      index = buffer.indexOf("\r\n");
    }
  });
  return () => {
    if (failed) return Promise.reject(failed);
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };
}

/** Read a reply, following multiline continuations, and require `code`. */
async function expectCode(nextLine: LineReader, code: string): Promise<void> {
  for (;;) {
    const line = await nextLine();
    if (line.startsWith(`${code} `)) return;
    if (line.startsWith(`${code}-`)) continue;
    throw new Error(`SMTP error: expected ${code}, got: ${line}`);
  }
}

async function command(
  socket: net.Socket,
  nextLine: LineReader,
  text: string,
  code: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(text, (error) => (error ? reject(error) : resolve()));
  });
  await expectCode(nextLine, code);
}
