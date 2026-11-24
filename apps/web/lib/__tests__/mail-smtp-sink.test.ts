/**
 * lib/mail.ts with the REAL nodemailer, against a local SMTP sink.
 *
 * mail-connect-pinning.test.ts mocks nodemailer to read the options mail.ts passes. This file
 * checks that the installed nodemailer still does what mail.ts expects with those options: it
 * dials the pinned address (never the host name), logs in with the app password or with an
 * XOAUTH2 token, sends the reply headers, returns the Message-ID it wrote, and marks a refused
 * login with code EAUTH, which mail.ts turns into "SMTP login failed". Only the host guard is
 * replaced (it refuses loopback, where the sink listens) and IMAP is mocked.
 */
import { createServer, type Server, type Socket } from "node:net";

jest.mock("../mail-host-guard", () => ({
  ...jest.requireActual("../mail-host-guard"),
  resolvePublicMailHost: jest.fn(async (host: string) => ({ address: "127.0.0.1", servername: host })),
}));
jest.mock("imapflow", () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect: jest.fn(async () => undefined),
    logout: jest.fn(async () => undefined),
  })),
}));
jest.mock("mailparser", () => ({ simpleParser: jest.fn() }));
// The real module. ts-jest compiles `import nodemailer from "nodemailer"` without
// esModuleInterop, so the CommonJS export is handed over as the default export here.
jest.mock("nodemailer", () => ({ __esModule: true, default: jest.requireActual("nodemailer") }));

import { sendMail, verifyConnection, type MailConfig } from "../mail";

type SinkSession = { auth?: string; mailFrom?: string; rcptTo: string[]; data: string; quit: boolean };

/** A minimal ESMTP server: AUTH PLAIN/LOGIN/XOAUTH2 offered, no STARTTLS, every message kept. */
function startSink(opts: { refuseAuth?: boolean } = {}) {
  const sessions: SinkSession[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const s: SinkSession = { rcptTo: [], data: "", quit: false };
    sessions.push(s);
    let buffer = "";
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    socket.setEncoding("utf8");
    reply("220 sink.test ESMTP");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            reply("250 2.0.0 queued");
          } else {
            s.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) socket.write("250-sink.test\r\n250-AUTH PLAIN LOGIN XOAUTH2\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("AUTH ")) {
          s.auth = line.slice(5);
          reply(opts.refuseAuth ? "535 5.7.8 Authentication credentials invalid" : "235 2.7.0 Accepted");
        } else if (cmd.startsWith("MAIL FROM:")) {
          s.mailFrom = line.slice(10);
          reply("250 2.1.0 OK");
        } else if (cmd.startsWith("RCPT TO:")) {
          s.rcptTo.push(line.slice(8));
          reply("250 2.1.5 OK");
        } else if (cmd === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "QUIT") {
          s.quit = true;
          reply("221 2.0.0 Bye");
          socket.end();
        } else if (cmd === "RSET" || cmd === "NOOP") reply("250 2.0.0 OK");
        else reply("502 5.5.2 Command not implemented");
      }
    });
  });
  return new Promise<{ port: number; sessions: SinkSession[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        sessions,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function config(port: number, auth: { password?: string; accessToken?: string }): MailConfig {
  return {
    email: "me@example.com",
    username: "me@example.com",
    ...auth,
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    // Not resolvable: the send only works if nodemailer dials the pinned 127.0.0.1.
    smtpHost: "smtp.example.invalid",
    smtpPort: port,
    smtpSecure: false,
  };
}

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

describe("real nodemailer against a local SMTP sink", () => {
  it("sends a reply with the app password and returns the Message-ID it wrote", async () => {
    const sink = await startSink();
    try {
      const messageId = await sendMail(config(sink.port, { password: "app-password" }), {
        to: "them@example.org",
        subject: "Re: your role",
        text: "Thanks, here is my CV.",
        inReplyTo: "<orig@example.org>",
        references: "<orig@example.org>",
      });
      const s = sink.sessions[0]!;
      const [method, payload] = (s.auth ?? "").split(" ");
      expect(method).toBe("PLAIN");
      expect(decode(payload!)).toBe("\0me@example.com\0app-password");
      expect(s.mailFrom).toBe("<me@example.com>");
      expect(s.rcptTo).toEqual(["<them@example.org>"]);
      expect(s.data).toMatch(/^Subject: Re: your role$/m);
      expect(s.data).toMatch(/^In-Reply-To: <orig@example\.org>$/m);
      expect(s.data).toMatch(/^References: <orig@example\.org>$/m);
      expect(s.data).toContain("Thanks, here is my CV.");
      expect(messageId).toMatch(/^<.+@example\.com>$/);
      expect(s.data).toContain(`Message-ID: ${messageId}`);
    } finally {
      await sink.close();
    }
  });

  it("logs in with XOAUTH2 when the account has an access token", async () => {
    const sink = await startSink();
    try {
      await sendMail(config(sink.port, { accessToken: "token-123" }), { to: "them@example.org", subject: "hi", text: "x" });
      const [method, payload] = (sink.sessions[0]!.auth ?? "").split(" ");
      expect(method).toBe("XOAUTH2");
      expect(decode(payload!)).toBe("user=me@example.com\x01auth=Bearer token-123\x01\x01");
    } finally {
      await sink.close();
    }
  });

  it("verifyConnection logs in over SMTP and resolves", async () => {
    const sink = await startSink();
    try {
      await expect(verifyConnection(config(sink.port, { password: "app-password" }))).resolves.toBeUndefined();
      expect(sink.sessions[0]!.auth).toMatch(/^PLAIN /);
    } finally {
      await sink.close();
    }
  });

  it("a refused login comes back as EAUTH, which mail.ts reports as a failed login", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = await startSink({ refuseAuth: true });
    try {
      await expect(verifyConnection(config(sink.port, { password: "wrong" }))).rejects.toThrow(
        /^SMTP login failed\. Check your email address and app password\.$/,
      );
      expect(warn).toHaveBeenCalledWith("[mail] SMTP check failed:", "EAUTH");
    } finally {
      warn.mockRestore();
      await sink.close();
    }
  });
});
