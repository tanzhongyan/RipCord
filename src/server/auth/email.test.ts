import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { extractAddress, smtpSend } from "./email";

let servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
});

/** A scripted SMTP server that records the conversation. */
function startFakeSmtp(handler: (commands: string[]) => void): Promise<{ port: number }> {
  const commands: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake ESMTP\r\n");
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 OK\r\n");
            commands.push("DATA-END");
          } else {
            commands.push(`DATA: ${line}`);
          }
          index = buffer.indexOf("\r\n");
          continue;
        }
        if (line.startsWith("EHLO")) {
          socket.write("250-fake\r\n250 HELP\r\n");
        } else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) {
          socket.write("250 OK\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 Go ahead\r\n");
        } else if (line === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("500 Unrecognised\r\n");
        }
        commands.push(line);
        index = buffer.indexOf("\r\n");
      }
    });
    socket.on("close", () => handler(commands));
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port });
    });
  });
}

describe("smtpSend", () => {
  it("delivers a message through plain SMTP", async () => {
    const seen = new Promise<string[]>((resolve) => {
      void startFakeSmtp(resolve).then(async ({ port }) => {
        await smtpSend({
          host: "127.0.0.1",
          port,
          from: "sender@example.com",
          to: "user@example.com",
          message: "Subject: hi\r\n\r\nhello\r\n",
        });
      });
    });
    const commands = await seen;
    expect(commands).toContain("EHLO ripcord");
    expect(commands).toContain("MAIL FROM:<sender@example.com>");
    expect(commands).toContain("RCPT TO:<user@example.com>");
    expect(commands).toContain("DATA");
    expect(commands).toContain("DATA: Subject: hi");
    expect(commands).toContain("QUIT");
  });

  it("fails when the server is gone", async () => {
    await expect(
      smtpSend({
        host: "127.0.0.1",
        port: 1,
        from: "a@example.com",
        to: "b@example.com",
        message: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("extractAddress", () => {
  it("unwraps display names", () => {
    expect(extractAddress("RipCord <noreply@ripcord.local>")).toBe("noreply@ripcord.local");
    expect(extractAddress("plain@example.com")).toBe("plain@example.com");
  });
});
