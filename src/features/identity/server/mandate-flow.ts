import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { ToolError, transition } from "~/features/cases";
import { writeAudit } from "~/server/audit";
import type { Database } from "~/server/db";
import { db } from "~/server/db";
import {
  accountHolders,
  caseDocuments,
  caseSteps,
  cases,
  mandates,
  organizations,
  providers,
  users,
  vaultSecrets,
} from "~/server/db/schema";
import { getSecretValue, storeSecret } from "~/server/vault";
import { env } from "~/shared/config/env";
import type { MandateAction } from "../schemas/mandate";
import { buildLoaLines, renderLoaPdf } from "./loa";
import { isValidNric } from "./nric";
import { type SmsSender, sendSms } from "./sms";
import {
  equalHex,
  OTP_MAX_ATTEMPTS,
  OTP_SENDS_PER_HOUR,
  OTP_TTL_SECONDS,
  otpSendsKey,
  randomOtp,
  randomToken,
  sha256HexBytes,
  sha256hex,
} from "./tokens";
import { type ValkeyClient, valkey } from "./valkey";

export const LINK_TTL_SECONDS = 604800;
const ACTIVE_MANDATE_CAP = 5;
const PENDING_TTL_DAYS = 7;
const SIGNED_TTL_DAYS = 30;

export const INVALID_LINK_MESSAGE = "This link is invalid or has expired";

const TERMINAL_CASE_STATUSES = new Set(["SUCCEEDED", "FAILED", "WITHDRAWN", "DISPUTED"]);

export type DomainCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "LIMIT_REACHED"
  | "INTERNAL_ERROR";

export class MandateError extends Error {
  readonly code: DomainCode;

  constructor(code: DomainCode, message: string) {
    super(message);
    this.name = "MandateError";
    this.code = code;
  }
}

const TRPC_CODES = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  LIMIT_REACHED: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_SERVER_ERROR",
} as const;

/** Map a flow error onto the closest tRPC code, keeping the domain code in the message. */
export function toTRPCError(error: unknown): TRPCError {
  if (error instanceof MandateError) {
    return new TRPCError({
      code: TRPC_CODES[error.code],
      message: `[${error.code}] ${error.message}`,
    });
  }
  if (error instanceof TRPCError) return error;
  throw error;
}

const HTTP_STATUSES: Record<DomainCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  RATE_LIMITED: 429,
  LIMIT_REACHED: 403,
  INTERNAL_ERROR: 500,
};

/** Map a flow error onto an HTTP response. NOT_FOUND hides behind the invalid-link message. */
export function toRouteResponse(error: unknown): Response {
  if (error instanceof MandateError) {
    const message = error.code === "NOT_FOUND" ? INVALID_LINK_MESSAGE : error.message;
    return Response.json({ code: error.code, message }, { status: HTTP_STATUSES[error.code] });
  }
  return Response.json(
    { code: "INTERNAL_ERROR", message: "Internal server error" },
    { status: 500 },
  );
}

export interface MandateDeps {
  db: Database;
  valkey: ValkeyClient;
  sms: SmsSender;
  now: () => Date;
}

function liveDeps(): MandateDeps {
  return { db, valkey: valkey(), sms: sendSms, now: () => new Date() };
}

export interface CallerIdentity {
  userId: string;
  orgIds: string[];
}

export function callerOwns(
  row: { ownerUserId: string; orgId: string | null },
  caller: CallerIdentity,
): boolean {
  return (
    row.ownerUserId === caller.userId || (row.orgId !== null && caller.orgIds.includes(row.orgId))
  );
}

const linkKey = (mandateId: string) => `mandate:link:${mandateId}`;
const otpKey = (mandateId: string) => `mandate:otp:${mandateId}`;

type MandateRow = typeof mandates.$inferSelect;
type CaseRow = typeof cases.$inferSelect;
type HolderRow = typeof accountHolders.$inferSelect;

async function loadMandate(conn: Database, mandateId: string): Promise<MandateRow> {
  const [row] = await conn.select().from(mandates).where(eq(mandates.id, mandateId)).limit(1);
  if (!row) throw new MandateError("NOT_FOUND", "Mandate not found");
  return row;
}

async function loadCase(conn: Database, caseId: string): Promise<CaseRow> {
  const [row] = await conn.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!row) throw new MandateError("NOT_FOUND", "Case not found");
  return row;
}

async function loadHolder(conn: Database, holderId: string): Promise<HolderRow> {
  const [row] = await conn
    .select()
    .from(accountHolders)
    .where(eq(accountHolders.id, holderId))
    .limit(1);
  if (!row) throw new MandateError("INTERNAL_ERROR", "Holder not found");
  return row;
}

/** A PENDING mandate past expiry moves to EXPIRED and fails its case. Throws NOT_FOUND. */
async function expireIfOverdue(deps: MandateDeps, mandate: MandateRow, c: CaseRow): Promise<void> {
  if (mandate.status !== "PENDING" || mandate.expiresAt.getTime() > deps.now().getTime()) return;
  await deps.db.update(mandates).set({ status: "EXPIRED" }).where(eq(mandates.id, mandate.id));
  if (!TERMINAL_CASE_STATUSES.has(c.status)) {
    await transition(c.id, "FAILED", {
      reason: "MANDATE_EXPIRED",
      actor: { type: "SYSTEM", id: "system" },
      now: deps.now,
    });
  }
  await writeAudit(deps.db, {
    actorType: "SYSTEM",
    actorId: "system",
    action: "MANDATE_EXPIRED",
    targetType: "mandate",
    targetId: mandate.id,
    caseId: c.id,
    metadata: {},
  });
  throw new MandateError("NOT_FOUND", INVALID_LINK_MESSAGE);
}

/**
 * The link token authorises the holder. Self-service holders (whose record
 * points at their own login) authenticate by session instead.
 */
async function checkLinkAccess(
  deps: MandateDeps,
  mandate: MandateRow,
  holder: HolderRow,
  token: string | undefined,
  sessionUserId: string | null,
): Promise<boolean> {
  if (sessionUserId && holder.userId === sessionUserId) return true;
  if (!token) return false;
  const stored = await deps.valkey.get(linkKey(mandate.id));
  if (!stored) return false;
  return equalHex(sha256hex(token), stored);
}

async function resolveDelegateName(
  conn: Database,
  delegateUserId: string | null,
  delegateOrgId: string | null,
): Promise<string> {
  if (delegateOrgId) {
    const [org] = await conn
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, delegateOrgId))
      .limit(1);
    if (org?.name.trim()) return org.name;
  }
  if (delegateUserId) {
    const [user] = await conn
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, delegateUserId))
      .limit(1);
    if (user?.name.trim()) return user.name;
  }
  return "A RipCord user";
}

export async function requestMandate(
  input: { caseId: string; actions: MandateAction[]; maxFeeCents: number },
  caller: CallerIdentity,
  deps: MandateDeps = liveDeps(),
): Promise<{ mandateId: string }> {
  const [c] = await deps.db.select().from(cases).where(eq(cases.id, input.caseId)).limit(1);
  if (!c || !callerOwns(c, caller)) throw new MandateError("NOT_FOUND", "Case not found");
  if (c.status !== "AWAITING_MANDATE") {
    throw new MandateError("VALIDATION", "Case is not awaiting a mandate");
  }
  if (!c.providerId) throw new MandateError("VALIDATION", "Provider is not identified yet");
  const holder = await loadHolder(deps.db, c.holderId);
  const [active] = await deps.db
    .select({ n: count() })
    .from(mandates)
    .where(and(eq(mandates.holderId, holder.id), eq(mandates.status, "ACTIVE")));
  if ((active?.n ?? 0) >= ACTIVE_MANDATE_CAP) {
    throw new MandateError("LIMIT_REACHED", "Holder already has 5 active mandates");
  }
  const [accountSecret] = await deps.db
    .select()
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.holderId, holder.id),
        eq(vaultSecrets.kind, "ACCOUNT_NO"),
        isNull(vaultSecrets.deletedAt),
      ),
    )
    .orderBy(desc(vaultSecrets.createdAt))
    .limit(1);
  if (!accountSecret) {
    throw new MandateError("VALIDATION", "Upload a bill that shows the account number first");
  }
  const [provider] = await deps.db
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.id, c.providerId))
    .limit(1);
  // The SMS goes out before anything is stored, so a send failure leaves no residue.
  const mandateId = randomUUID();
  const token = randomToken();
  const phone = await getSecretValue(deps.db, holder.phoneSecretId);
  const delegateName = await resolveDelegateName(deps.db, c.orgId ? null : caller.userId, c.orgId);
  const service = c.serviceType ? ` ${c.serviceType}` : "";
  try {
    await deps.sms(
      phone,
      `RipCord: ${delegateName} requests authorisation for your ${provider?.name ?? "provider"}${service} account. Review: ${env.BETTER_AUTH_URL}/m/${mandateId}?t=${token}`,
    );
  } catch {
    throw new MandateError("INTERNAL_ERROR", "Could not send code");
  }
  const [mandate] = await deps.db
    .insert(mandates)
    .values({
      id: mandateId,
      caseId: c.id,
      holderId: holder.id,
      delegateUserId: c.orgId ? null : caller.userId,
      delegateOrgId: c.orgId,
      providerId: c.providerId,
      serviceSecretId: accountSecret.id,
      actions: input.actions,
      maxFeeCents: input.maxFeeCents,
      expiresAt: new Date(deps.now().getTime() + PENDING_TTL_DAYS * 86_400_000),
    })
    .returning({ id: mandates.id });
  if (!mandate) throw new MandateError("INTERNAL_ERROR", "Failed to create mandate");
  await deps.valkey.set(linkKey(mandate.id), sha256hex(token), "EX", LINK_TTL_SECONDS);
  return { mandateId: mandate.id };
}

export interface OwnerMandateView {
  mandateId: string;
  status: MandateRow["status"];
  actions: MandateAction[];
  maxFeeCents: number;
  expiresAt: Date;
  signedAt: Date | null;
  liveModeApproved: boolean;
  providerName: string;
  serviceType: string | null;
  accountHint: string | null;
  caseStatus: CaseRow["status"];
}

export async function getMandate(
  input: { mandateId: string },
  caller: CallerIdentity,
  deps: MandateDeps = liveDeps(),
): Promise<OwnerMandateView> {
  const mandate = await loadMandate(deps.db, input.mandateId);
  const c = await loadCase(deps.db, mandate.caseId);
  if (!callerOwns(c, caller)) throw new MandateError("NOT_FOUND", "Mandate not found");
  const [provider] = await deps.db
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.id, mandate.providerId))
    .limit(1);
  const [secret] = await deps.db
    .select({ displayHint: vaultSecrets.displayHint })
    .from(vaultSecrets)
    .where(eq(vaultSecrets.id, mandate.serviceSecretId))
    .limit(1);
  return {
    mandateId: mandate.id,
    status: mandate.status,
    actions: [...mandate.actions] as MandateAction[],
    maxFeeCents: mandate.maxFeeCents,
    expiresAt: mandate.expiresAt,
    signedAt: mandate.signedAt,
    liveModeApproved: mandate.liveModeApproved,
    providerName: provider?.name ?? "Unknown provider",
    serviceType: c.serviceType,
    accountHint: secret?.displayHint ?? null,
    caseStatus: c.status,
  };
}

export interface MandateView {
  mandateId: string;
  requesterName: string;
  providerName: string;
  serviceType: string | null;
  accountHint: string | null;
  actions: MandateAction[];
  maxFeeCents: number;
  expiresAt: Date;
  sandbox: boolean;
  status: MandateRow["status"];
  liveModeApproved: boolean;
  needsIdentity: boolean;
}

export type MandateViewResult = { ok: true; view: MandateView } | { ok: false };

export async function loadMandateView(
  input: { mandateId: string; token?: string },
  sessionUserId: string | null,
  deps: MandateDeps = liveDeps(),
): Promise<MandateViewResult> {
  try {
    const mandate = await loadMandate(deps.db, input.mandateId);
    const c = await loadCase(deps.db, mandate.caseId);
    const holder = await loadHolder(deps.db, mandate.holderId);
    await expireIfOverdue(deps, mandate, c);
    if (!(await checkLinkAccess(deps, mandate, holder, input.token, sessionUserId))) {
      return { ok: false };
    }
    const [provider] = await deps.db
      .select({ name: providers.name })
      .from(providers)
      .where(eq(providers.id, mandate.providerId))
      .limit(1);
    const [secret] = await deps.db
      .select({ displayHint: vaultSecrets.displayHint })
      .from(vaultSecrets)
      .where(eq(vaultSecrets.id, mandate.serviceSecretId))
      .limit(1);
    const identitySecrets = await deps.db
      .select({ kind: vaultSecrets.kind })
      .from(vaultSecrets)
      .where(
        and(
          eq(vaultSecrets.holderId, holder.id),
          inArray(vaultSecrets.kind, ["FULL_NAME", "NRIC"]),
          isNull(vaultSecrets.deletedAt),
        ),
      );
    const kinds = new Set(identitySecrets.map((row) => row.kind));
    return {
      ok: true,
      view: {
        mandateId: mandate.id,
        requesterName: await resolveDelegateName(
          deps.db,
          mandate.delegateUserId,
          mandate.delegateOrgId,
        ),
        providerName: provider?.name ?? "Unknown provider",
        serviceType: c.serviceType,
        accountHint: secret?.displayHint ?? null,
        actions: [...mandate.actions] as MandateAction[],
        maxFeeCents: mandate.maxFeeCents,
        expiresAt: mandate.expiresAt,
        sandbox: c.sandbox,
        status: mandate.status,
        liveModeApproved: mandate.liveModeApproved,
        needsIdentity: !kinds.has("FULL_NAME") || !kinds.has("NRIC"),
      },
    };
  } catch (error) {
    if (error instanceof MandateError) return { ok: false };
    throw error;
  }
}

export async function requestOtp(
  input: { mandateId: string; token?: string },
  sessionUserId: string | null,
  deps: MandateDeps = liveDeps(),
): Promise<void> {
  const mandate = await loadMandate(deps.db, input.mandateId);
  const c = await loadCase(deps.db, mandate.caseId);
  const holder = await loadHolder(deps.db, mandate.holderId);
  await expireIfOverdue(deps, mandate, c);
  if (!(await checkLinkAccess(deps, mandate, holder, input.token, sessionUserId))) {
    throw new MandateError("NOT_FOUND", INVALID_LINK_MESSAGE);
  }
  if (mandate.status !== "PENDING") {
    throw new MandateError("VALIDATION", "This mandate is no longer pending");
  }
  const sends = await deps.valkey.incr(otpSendsKey(holder.id));
  if (sends === 1) await deps.valkey.expire(otpSendsKey(holder.id), 3600);
  if (sends > OTP_SENDS_PER_HOUR) {
    throw new MandateError("RATE_LIMITED", "Too many codes sent. Try again later.");
  }
  const code = randomOtp();
  await deps.valkey.set(
    otpKey(mandate.id),
    JSON.stringify({ hash: sha256hex(code), attempts: 0 }),
    "EX",
    OTP_TTL_SECONDS,
  );
  const phone = await getSecretValue(deps.db, holder.phoneSecretId);
  try {
    await deps.sms(phone, `Your RipCord code is: ${code}`);
  } catch {
    throw new MandateError("INTERNAL_ERROR", "Could not send code");
  }
}

interface OtpRecord {
  hash: string;
  attempts: number;
}

function parseOtpRecord(raw: string | null): OtpRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OtpRecord>;
    if (typeof parsed.hash !== "string" || typeof parsed.attempts !== "number") return null;
    return { hash: parsed.hash, attempts: parsed.attempts };
  } catch {
    return null;
  }
}

const sgDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const sgDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export async function signMandate(
  input: {
    mandateId: string;
    token?: string;
    code: string;
    typedName: string;
    allowLive: boolean;
    fullName?: string;
    nric?: string;
  },
  request: { ip: string; userAgent: string; sessionUserId: string | null },
  deps: MandateDeps = liveDeps(),
): Promise<void> {
  const mandate = await loadMandate(deps.db, input.mandateId);
  const c = await loadCase(deps.db, mandate.caseId);
  const holder = await loadHolder(deps.db, mandate.holderId);
  await expireIfOverdue(deps, mandate, c);
  if (!(await checkLinkAccess(deps, mandate, holder, input.token, request.sessionUserId))) {
    throw new MandateError("NOT_FOUND", INVALID_LINK_MESSAGE);
  }
  if (mandate.status !== "PENDING") {
    throw new MandateError("VALIDATION", "This mandate is no longer pending");
  }
  if (c.status !== "AWAITING_MANDATE") {
    throw new MandateError("VALIDATION", "Case is no longer awaiting a mandate");
  }
  const record = parseOtpRecord(await deps.valkey.get(otpKey(mandate.id)));
  if (!record) throw new MandateError("VALIDATION", "Code has expired. Request a new one.");
  if (!equalHex(sha256hex(input.code), record.hash)) {
    const attempts = record.attempts + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await deps.valkey.del(otpKey(mandate.id));
      throw new MandateError("VALIDATION", "Too many wrong codes. Request a new one.");
    }
    await deps.valkey.set(
      otpKey(mandate.id),
      JSON.stringify({ hash: record.hash, attempts }),
      "EX",
      OTP_TTL_SECONDS,
    );
    throw new MandateError("VALIDATION", "Invalid code");
  }
  if (input.nric !== undefined && !isValidNric(input.nric)) {
    throw new MandateError("VALIDATION", "Invalid NRIC");
  }
  const now = deps.now();
  const [provider] = await deps.db
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.id, mandate.providerId))
    .limit(1);
  const identitySecrets = await deps.db
    .select({ id: vaultSecrets.id, kind: vaultSecrets.kind })
    .from(vaultSecrets)
    .where(
      and(
        eq(vaultSecrets.holderId, holder.id),
        inArray(vaultSecrets.kind, ["FULL_NAME", "NRIC"]),
        isNull(vaultSecrets.deletedAt),
      ),
    )
    .orderBy(desc(vaultSecrets.createdAt));
  let fullNameSecretId = identitySecrets.find((row) => row.kind === "FULL_NAME")?.id ?? null;
  let nricSecretId = identitySecrets.find((row) => row.kind === "NRIC")?.id ?? null;
  if (input.fullName !== undefined) {
    fullNameSecretId = (
      await storeSecret(deps.db, { holderId: holder.id, kind: "FULL_NAME", value: input.fullName })
    ).id;
  }
  if (input.nric !== undefined) {
    nricSecretId = (
      await storeSecret(deps.db, { holderId: holder.id, kind: "NRIC", value: input.nric })
    ).id;
  }
  const tokenFor = (kind: string, id: string | null) =>
    id ? `{{vault:${kind}:${id}}}` : `{{vault:${kind}}}`;
  const lines = buildLoaLines({
    signedDate: sgDate.format(now),
    providerName: provider?.name ?? "Unknown provider",
    delegateName: await resolveDelegateName(deps.db, mandate.delegateUserId, mandate.delegateOrgId),
    serviceType: c.serviceType ?? "UNKNOWN",
    fullNameToken: tokenFor("FULL_NAME", fullNameSecretId),
    nricToken: tokenFor("NRIC", nricSecretId),
    accountToken: tokenFor("ACCOUNT_NO", mandate.serviceSecretId),
    actions: [...mandate.actions] as MandateAction[],
    expiresDate: sgDate.format(new Date(now.getTime() + SIGNED_TTL_DAYS * 86_400_000)),
    typedName: input.typedName,
    signedAt: sgDateTime.format(now),
    mandateId: mandate.id,
  });
  const pdf = await renderLoaPdf(lines, input.typedName);
  // TODO(spec-0003): store the PDF via ~/server/storage (the S3 upload path
  // exists since 0002; the LOA keeps its inline data URL until intake uploads
  // land, so the 0001 route tests need no S3). Until then the bytes ride
  // inline in storage_key as a data URL.
  const [doc] = await deps.db
    .insert(caseDocuments)
    .values({
      caseId: c.id,
      kind: "LOA",
      storageKey: `data:application/pdf;base64,${Buffer.from(pdf).toString("base64")}`,
      sha256: sha256HexBytes(pdf),
    })
    .returning({ id: caseDocuments.id });
  if (!doc) throw new MandateError("INTERNAL_ERROR", "Failed to store authorisation letter");
  const expiresAt = new Date(now.getTime() + SIGNED_TTL_DAYS * 86_400_000);
  const [signed] = await deps.db
    .update(mandates)
    .set({
      status: "ACTIVE",
      otpVerifiedAt: now,
      signedAt: now,
      expiresAt,
      liveModeApproved: input.allowLive,
      signatureEvidence: {
        typed_name_sha256: sha256hex(input.typedName),
        ip_sha256: sha256hex(request.ip),
        user_agent_sha256: sha256hex(request.userAgent),
      },
      loaDocumentId: doc.id,
    })
    .where(and(eq(mandates.id, mandate.id), eq(mandates.status, "PENDING")))
    .returning({ id: mandates.id });
  if (!signed) throw new MandateError("VALIDATION", "This mandate is no longer pending");
  try {
    await transition(c.id, "CHANNEL_PLANNING", {
      actor: { type: "HOLDER", id: holder.id },
      now: deps.now,
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === "ILLEGAL_TRANSITION") {
      throw new MandateError("VALIDATION", "Case is no longer awaiting a mandate");
    }
    throw error;
  }
  await writeAudit(deps.db, {
    actorType: "HOLDER",
    actorId: holder.id,
    action: "MANDATE_SIGNED",
    targetType: "mandate",
    targetId: mandate.id,
    caseId: c.id,
    metadata: { live_mode_approved: input.allowLive },
  });
  await deps.valkey.del(otpKey(mandate.id));
}

async function endMandate(
  input: { mandateId: string; token?: string },
  sessionUserId: string | null,
  requireStatus: "ACTIVE" | "PENDING",
  deps: MandateDeps,
): Promise<void> {
  const mandate = await loadMandate(deps.db, input.mandateId);
  const c = await loadCase(deps.db, mandate.caseId);
  const holder = await loadHolder(deps.db, mandate.holderId);
  await expireIfOverdue(deps, mandate, c);
  if (!(await checkLinkAccess(deps, mandate, holder, input.token, sessionUserId))) {
    throw new MandateError("NOT_FOUND", INVALID_LINK_MESSAGE);
  }
  const [ended] = await deps.db
    .update(mandates)
    .set({ status: "REVOKED", revokedAt: deps.now() })
    .where(and(eq(mandates.id, mandate.id), eq(mandates.status, requireStatus)))
    .returning({ id: mandates.id });
  if (!ended) {
    throw new MandateError(
      "VALIDATION",
      requireStatus === "PENDING"
        ? "This mandate is no longer pending"
        : "This mandate is not active",
    );
  }
  if (!TERMINAL_CASE_STATUSES.has(c.status)) {
    await transition(c.id, "FAILED", {
      reason: "MANDATE_REVOKED",
      actor: { type: "HOLDER", id: holder.id },
      now: deps.now,
    });
    await deps.db
      .update(caseSteps)
      .set({ status: "FAILED", finishedAt: deps.now() })
      .where(and(eq(caseSteps.caseId, c.id), eq(caseSteps.status, "RUNNING")));
  }
  await writeAudit(deps.db, {
    actorType: "HOLDER",
    actorId: holder.id,
    action: "MANDATE_REVOKED",
    targetType: "mandate",
    targetId: mandate.id,
    caseId: c.id,
    metadata: {},
  });
  await deps.valkey.del(otpKey(mandate.id));
}

export async function revokeMandate(
  input: { mandateId: string; token?: string },
  sessionUserId: string | null,
  deps: MandateDeps = liveDeps(),
): Promise<void> {
  await endMandate(input, sessionUserId, "ACTIVE", deps);
}

export async function declineMandate(
  input: { mandateId: string; token?: string },
  sessionUserId: string | null,
  deps: MandateDeps = liveDeps(),
): Promise<void> {
  await endMandate(input, sessionUserId, "PENDING", deps);
}
