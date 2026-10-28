import { and, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { POST as postDecline } from "~/app/api/mandates/[mandateId]/decline/route";
import { POST as postOtp } from "~/app/api/mandates/[mandateId]/otp/route";
import { POST as postRevoke } from "~/app/api/mandates/[mandateId]/revoke/route";
import { POST as postSign } from "~/app/api/mandates/[mandateId]/sign/route";
import { db } from "~/server/db";
import {
  auditLogs,
  caseDocuments,
  caseSteps,
  cases,
  mandates,
  vaultSecrets,
} from "~/server/db/schema";
import {
  INVALID_LINK_MESSAGE,
  LINK_TTL_SECONDS,
  loadMandateView,
  type MandateDeps,
  MandateError,
  requestMandate,
} from "./mandate-flow";
import { setSmsOverride } from "./sms";
import {
  callerFor,
  createSmsOutbox,
  FakeValkey,
  seedAccountSecret,
  seedCase,
  seedHolder,
  seedMandate,
  seedProvider,
  seedUser,
} from "./test-support";
import { sha256hex } from "./tokens";
import { setValkeyOverride } from "./valkey";

async function setupPendingCase(phone = "+6591234500") {
  const user = await seedUser();
  const provider = await seedProvider();
  const holder = await seedHolder(user.id, { phone });
  await seedAccountSecret(holder.id);
  const c = await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id });
  return { user, provider, holder, c };
}

function testDeps(valkey: FakeValkey, sms: ReturnType<typeof createSmsOutbox>): MandateDeps {
  return { db, valkey, sms: sms.sender, now: () => new Date() };
}

function extractToken(body: string): string {
  const match = /[?&]t=([A-Za-z0-9_-]+)/.exec(body);
  if (!match?.[1]) throw new Error("no token in SMS body");
  return match[1];
}

function extractCode(body: string): string {
  const match = /(\d{6})/.exec(body);
  if (!match?.[1]) throw new Error("no code in SMS body");
  return match[1];
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/mandates/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const paramsFor = (mandateId: string) => Promise.resolve({ mandateId });

async function requestLink(phone: string) {
  const setup = await setupPendingCase(phone);
  const valkey = new FakeValkey();
  const outbox = createSmsOutbox();
  const { mandateId } = await requestMandate(
    { caseId: setup.c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 500 },
    { userId: setup.user.id, orgIds: [] },
    testDeps(valkey, outbox),
  );
  const token = extractToken(outbox.messages[0]?.body ?? "");
  return { ...setup, valkey, outbox, mandateId, token };
}

describe("B3 Mandate link", () => {
  it("sends exactly one SMS and stores the token hash with a 7-day TTL", async () => {
    const { mandateId, token, outbox, valkey, holder } = await requestLink("+6591300001");

    expect(outbox.messages).toHaveLength(1);
    expect(outbox.messages[0]?.to).toBeDefined();
    expect(outbox.messages[0]?.body).toContain(`/m/${mandateId}?t=${token}`);
    expect(await valkey.get(`mandate:link:${mandateId}`)).toBe(sha256hex(token));
    expect(await valkey.ttl(`mandate:link:${mandateId}`)).toBe(LINK_TTL_SECONDS);
    expect(LINK_TTL_SECONDS).toBe(604800);

    const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId)).limit(1);
    expect(mandate?.status).toBe("PENDING");
    expect(mandate?.holderId).toBe(holder.id);
    const ttlMs = (mandate?.expiresAt.getTime() ?? 0) - (mandate?.createdAt.getTime() ?? 0);
    expect(Math.abs(ttlMs - 7 * 86_400_000)).toBeLessThan(60_000);
  });

  it("refuses a case without an extracted account number", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    const c = await seedCase({ ownerId: user.id, holderId: holder.id, providerId: provider.id });
    const caller = callerFor(user.id, []);
    await expect(
      caller.mandates.request({ caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 0 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "[VALIDATION] Upload a bill that shows the account number first",
    });
  });

  it("refuses a case that is not awaiting a mandate", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id);
    await seedAccountSecret(holder.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "DRAFT",
    });
    const caller = callerFor(user.id, []);
    await expect(
      caller.mandates.request({ caseId: c.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("B4 Code limits", () => {
  it("returns HTTP 429 on the 4th code within an hour", async () => {
    const { mandateId, token, valkey, outbox } = await requestLink("+6591300002");
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      for (let i = 0; i < 3; i++) {
        const response = await postOtp(postRequest({ token }), { params: paramsFor(mandateId) });
        expect(response.status).toBe(200);
      }
      const fourth = await postOtp(postRequest({ token }), { params: paramsFor(mandateId) });
      expect(fourth.status).toBe(429);
      expect(await fourth.json()).toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });

  it("invalidates the code after 5 wrong attempts", async () => {
    const { mandateId, token, valkey, outbox } = await requestLink("+6591300003");
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      const sent = await postOtp(postRequest({ token }), { params: paramsFor(mandateId) });
      expect(sent.status).toBe(200);
      const realCode = extractCode(outbox.messages[outbox.messages.length - 1]?.body ?? "");
      const signBody = (code: string) => ({ token, code, typedName: "Holder", allowLive: false });
      for (let i = 0; i < 4; i++) {
        const wrong = await postSign(postRequest(signBody("000000")), {
          params: paramsFor(mandateId),
        });
        expect(wrong.status).toBe(400);
        expect(await wrong.json()).toMatchObject({ message: "Invalid code" });
      }
      const fifth = await postSign(postRequest(signBody("000000")), {
        params: paramsFor(mandateId),
      });
      expect(await fifth.json()).toMatchObject({
        message: "Too many wrong codes. Request a new one.",
      });
      expect(await valkey.get(`mandate:otp:${mandateId}`)).toBeNull();
      const after = await postSign(postRequest(signBody(realCode)), {
        params: paramsFor(mandateId),
      });
      expect(await after.json()).toMatchObject({ message: "Code has expired. Request a new one." });
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });
});

describe("B5 Activation", () => {
  it("signs the mandate, stores the LOA and moves the case", async () => {
    const { mandateId, token, valkey, outbox, c, holder } = await requestLink("+6591300004");
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      const sent = await postOtp(postRequest({ token }), { params: paramsFor(mandateId) });
      expect(sent.status).toBe(200);
      const code = extractCode(outbox.messages[outbox.messages.length - 1]?.body ?? "");
      const signed = await postSign(
        postRequest({
          token,
          code,
          typedName: "Dad",
          allowLive: true,
          fullName: "Dad Example",
          nric: "S1234567D",
        }),
        { params: paramsFor(mandateId) },
      );
      expect(signed.status).toBe(200);

      const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId)).limit(1);
      expect(mandate?.status).toBe("ACTIVE");
      expect(mandate?.liveModeApproved).toBe(true);
      expect(mandate?.otpVerifiedAt).not.toBeNull();
      expect((mandate?.expiresAt.getTime() ?? 0) - (mandate?.signedAt?.getTime() ?? 0)).toBe(
        30 * 86_400_000,
      );
      expect(mandate?.signatureEvidence?.typed_name_sha256).toBe(sha256hex("Dad"));

      const [doc] = await db
        .select()
        .from(caseDocuments)
        .where(and(eq(caseDocuments.caseId, c.id), eq(caseDocuments.kind, "LOA")))
        .limit(1);
      expect(doc?.id).toBe(mandate?.loaDocumentId);
      expect(doc?.sha256).toHaveLength(64);
      const payload = (doc?.storageKey ?? "").split(",")[1] ?? "";
      expect(Buffer.from(payload, "base64").subarray(0, 4).toString()).toBe("%PDF");

      const [updatedCase] = await db.select().from(cases).where(eq(cases.id, c.id)).limit(1);
      expect(updatedCase?.status).toBe("CHANNEL_PLANNING");

      const [audit] = await db
        .select({ n: count() })
        .from(auditLogs)
        .where(and(eq(auditLogs.caseId, c.id), eq(auditLogs.action, "MANDATE_SIGNED")));
      expect(audit?.n).toBe(1);

      const identityKinds = await db
        .select({ kind: vaultSecrets.kind })
        .from(vaultSecrets)
        .where(eq(vaultSecrets.holderId, holder.id));
      expect(identityKinds.map((row) => row.kind)).toContain("FULL_NAME");
      expect(identityKinds.map((row) => row.kind)).toContain("NRIC");
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });

  it("rejects a bad NRIC", async () => {
    const { mandateId, token, valkey, outbox } = await requestLink("+6591300005");
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      await postOtp(postRequest({ token }), { params: paramsFor(mandateId) });
      const code = extractCode(outbox.messages[outbox.messages.length - 1]?.body ?? "");
      const signed = await postSign(
        postRequest({ token, code, typedName: "Dad", allowLive: false, nric: "S1234567X" }),
        { params: paramsFor(mandateId) },
      );
      expect(await signed.json()).toMatchObject({ code: "VALIDATION", message: "Invalid NRIC" });
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });
});

describe("B6 Bad token", () => {
  it("reveals nothing about the case", async () => {
    const { mandateId, valkey } = await requestLink("+6591300006");
    setValkeyOverride(valkey);
    try {
      expect(await loadMandateView({ mandateId, token: "wrong-token" }, null)).toEqual({
        ok: false,
      });
      expect(
        await loadMandateView({ mandateId: "00000000-0000-0000-0000-000000000000" }, null),
      ).toEqual({ ok: false });
      expect(INVALID_LINK_MESSAGE).toBe("This link is invalid or has expired");
    } finally {
      setValkeyOverride(null);
    }
  });

  it("answers holder routes with 404 and no case data", async () => {
    const { mandateId, valkey, outbox } = await requestLink("+6591300007");
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      const response = await postOtp(postRequest({ token: "wrong-token" }), {
        params: paramsFor(mandateId),
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["code", "message"]);
      expect(body).toEqual({ code: "NOT_FOUND", message: "This link is invalid or has expired" });
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });
});

describe("B7 Revoke", () => {
  it("revokes the mandate, fails the case and stops running steps", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id, { phone: "+6591300008" });
    const secret = await seedAccountSecret(holder.id);
    const c = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
      status: "EXECUTING",
    });
    const mandate = await seedMandate({
      caseId: c.id,
      holderId: holder.id,
      providerId: provider.id,
      serviceSecretId: secret.id,
      delegateUserId: user.id,
      status: "ACTIVE",
    });
    await db.insert(caseSteps).values({
      caseId: c.id,
      seq: 1,
      tool: "send_email",
      args: {},
      status: "RUNNING",
      requiresApproval: false,
    });

    const valkey = new FakeValkey();
    const outbox = createSmsOutbox();
    await valkey.set(`mandate:link:${mandate.id}`, sha256hex("holder-token"), "EX", 604800);
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      const response = await postRevoke(postRequest({ token: "holder-token" }), {
        params: paramsFor(mandate.id),
      });
      expect(response.status).toBe(200);

      const [revoked] = await db
        .select()
        .from(mandates)
        .where(eq(mandates.id, mandate.id))
        .limit(1);
      expect(revoked?.status).toBe("REVOKED");
      expect(revoked?.revokedAt).not.toBeNull();

      const [failed] = await db.select().from(cases).where(eq(cases.id, c.id)).limit(1);
      expect(failed?.status).toBe("FAILED");
      expect(failed?.failureReason).toBe("MANDATE_REVOKED");
      expect(failed?.closedAt).not.toBeNull();

      const [step] = await db
        .select()
        .from(caseSteps)
        .where(and(eq(caseSteps.caseId, c.id), eq(caseSteps.seq, 1)))
        .limit(1);
      expect(step?.status).toBe("FAILED");
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });

  it("declines a pending mandate", async () => {
    const { mandateId, token, valkey, outbox, c } = await requestLink("+6591300009");
    setValkeyOverride(valkey);
    setSmsOverride(outbox.sender);
    try {
      const response = await postDecline(postRequest({ token }), { params: paramsFor(mandateId) });
      expect(response.status).toBe(200);
      const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId)).limit(1);
      expect(mandate?.status).toBe("REVOKED");
      const [failed] = await db.select().from(cases).where(eq(cases.id, c.id)).limit(1);
      expect(failed?.status).toBe("FAILED");
      expect(failed?.failureReason).toBe("MANDATE_REVOKED");
    } finally {
      setValkeyOverride(null);
      setSmsOverride(null);
    }
  });
});

describe("B10 Active mandate cap", () => {
  it("refuses a 6th active mandate with LIMIT_REACHED", async () => {
    const user = await seedUser();
    const provider = await seedProvider();
    const holder = await seedHolder(user.id, { phone: "+6591300010" });
    const secret = await seedAccountSecret(holder.id);
    for (let i = 0; i < 5; i++) {
      const c = await seedCase({
        ownerId: user.id,
        holderId: holder.id,
        providerId: provider.id,
        status: "EXECUTING",
      });
      await seedMandate({
        caseId: c.id,
        holderId: holder.id,
        providerId: provider.id,
        serviceSecretId: secret.id,
        delegateUserId: user.id,
        status: "ACTIVE",
      });
    }
    const fresh = await seedCase({
      ownerId: user.id,
      holderId: holder.id,
      providerId: provider.id,
    });
    const caller = callerFor(user.id, []);
    await expect(
      caller.mandates.request({ caseId: fresh.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 0 }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("LIMIT_REACHED"),
    });
    await expect(
      requestMandate(
        { caseId: fresh.id, actions: ["CANCEL_SERVICE"], maxFeeCents: 0 },
        { userId: user.id, orgIds: [] },
        testDeps(new FakeValkey(), createSmsOutbox()),
      ),
    ).rejects.toThrow(MandateError);
  });
});
