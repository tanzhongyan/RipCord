import { eq, inArray } from "drizzle-orm";

import { writeAudit } from "~/server/audit";
import type { Database, Transaction } from "~/server/db";
import {
  caseSteps,
  cases,
  mandates,
  providerChannels,
  vaultReleases,
  vaultSecrets,
} from "~/server/db/schema";
import { openEnvelope } from "./crypto";
import type { VaultSecretKind } from "./index";

export type ReleaseDenial = "VAULT_RELEASE_DENIED" | "SANDBOX_DESTINATION_BLOCKED";

export class VaultReleaseError extends Error {
  readonly code: ReleaseDenial;

  constructor(code: ReleaseDenial, message: string) {
    super(`[${code}] ${message}`);
    this.name = "VaultReleaseError";
    this.code = code;
  }
}

export interface ReleaseContext {
  caseId: string;
  stepId: string;
  mandateId: string;
  providerChannelId: string;
}

const TOKEN_RE = /\{\{vault:([A-Z_]+):([0-9a-fA-F-]{36})\}\}/g;

/** Kinds that need holder approval before any release (data contract rule 4). */
const SENSITIVE_KINDS: ReadonlySet<string> = new Set(["NRIC", "PIN", "ACCOUNT_NO"]);

/**
 * Sandbox allowlist (data contract rule 5): sandbox cases release only to
 * `.test` destinations (spec 0005), localhost URLs for local channels, or
 * Twilio test numbers (`+1500555…`), which never reach the phone network.
 */
export function isSandboxAddress(address: string): boolean {
  const trimmed = address.trim();
  if (/^\+[\d\s-]+$/.test(trimmed)) {
    return trimmed.replace(/[\s-]/g, "").startsWith("+1500555");
  }
  const withoutScheme = trimmed.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = (withoutScheme.split(/[#?/]/, 1)[0] ?? "").split("@").pop()?.split(":")[0] ?? "";
  return host.endsWith(".test") || host === "localhost" || host === "127.0.0.1";
}

async function failStep(conn: Database | Transaction, stepId: string): Promise<void> {
  await conn
    .update(caseSteps)
    .set({ status: "FAILED", finishedAt: new Date() })
    .where(eq(caseSteps.id, stepId));
}

/**
 * Swap placeholder tokens for real values when all five data-contract release
 * rules hold. Writes one `vault_releases` row and one `audit_logs` row per
 * secret released. Any failed check fails the step and throws; the plaintext
 * result is returned to the caller and never stored or logged here.
 */
export async function resolveTokens(
  conn: Database | Transaction,
  text: string,
  ctx: ReleaseContext,
): Promise<string> {
  const tokens = new Map<string, VaultSecretKind>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const kind = match[1] as VaultSecretKind;
    const id = match[2] as string;
    if (!tokens.has(id)) tokens.set(id, kind);
  }
  if (tokens.size === 0) return text;

  const deny = async (code: ReleaseDenial, message: string): Promise<never> => {
    await failStep(conn, ctx.stepId);
    throw new VaultReleaseError(code, message);
  };

  const [c] = await conn.select().from(cases).where(eq(cases.id, ctx.caseId)).limit(1);
  const [mandate] = await conn
    .select()
    .from(mandates)
    .where(eq(mandates.id, ctx.mandateId))
    .limit(1);
  const [step] = await conn.select().from(caseSteps).where(eq(caseSteps.id, ctx.stepId)).limit(1);
  const [channel] = await conn
    .select()
    .from(providerChannels)
    .where(eq(providerChannels.id, ctx.providerChannelId))
    .limit(1);
  if (!c || !mandate || !step || !channel) {
    return deny("VAULT_RELEASE_DENIED", "Release context not found");
  }
  if (mandate.caseId !== c.id || step.caseId !== c.id) {
    return deny("VAULT_RELEASE_DENIED", "Release context does not match the case");
  }

  // Rule 1: the case is EXECUTING and its mandate is ACTIVE and not expired.
  if (c.status !== "EXECUTING") return deny("VAULT_RELEASE_DENIED", "Case is not executing");
  if (mandate.status !== "ACTIVE") return deny("VAULT_RELEASE_DENIED", "Mandate is not active");
  if (mandate.expiresAt.getTime() <= Date.now()) {
    return deny("VAULT_RELEASE_DENIED", "Mandate has expired");
  }
  // Rule 2: verified destination on the mandate's provider.
  if (!channel.isVerifiedDestination) {
    return deny("VAULT_RELEASE_DENIED", "Channel is not a verified destination");
  }
  if (channel.providerId !== mandate.providerId) {
    return deny("VAULT_RELEASE_DENIED", "Channel is not on the mandate provider");
  }
  // Rule 5 (checked before decryption): sandbox cases stay on the allowlist.
  if (c.sandbox && !isSandboxAddress(channel.address)) {
    return deny("SANDBOX_DESTINATION_BLOCKED", "Sandbox case cannot use this destination");
  }

  const required = channel.requiredSecrets;
  const rows = await conn
    .select()
    .from(vaultSecrets)
    .where(inArray(vaultSecrets.id, [...tokens.keys()]));
  const byId = new Map(rows.map((secret) => [secret.id, secret]));

  // Phase 1: check every secret and decrypt into memory. Any failure denies
  // the whole call before a single row is written.
  const values = new Map<string, string>();
  for (const [secretId, tokenKind] of tokens) {
    const secret = byId.get(secretId);
    if (!secret || secret.deletedAt) return deny("VAULT_RELEASE_DENIED", "Secret not found");
    if (secret.kind !== tokenKind) {
      return deny("VAULT_RELEASE_DENIED", "Token kind does not match the secret");
    }
    if (secret.holderId !== c.holderId || mandate.holderId !== c.holderId) {
      return deny("VAULT_RELEASE_DENIED", "Secret does not belong to the case holder");
    }
    // Rule 3: the channel asked for this kind.
    if (!Array.isArray(required) || !required.includes(secret.kind)) {
      return deny("VAULT_RELEASE_DENIED", "Channel does not require this secret kind");
    }
    // Rule 4: sensitive kinds need holder approval on this step.
    if (SENSITIVE_KINDS.has(secret.kind) && !step.approvedAt) {
      return deny("VAULT_RELEASE_DENIED", "Holder approval required for this secret kind");
    }
    try {
      values.set(
        secretId,
        openEnvelope({
          ciphertext: secret.ciphertext,
          iv: secret.iv,
          wrappedDek: secret.wrappedDek,
        }),
      );
    } catch {
      return deny("VAULT_RELEASE_DENIED", "Secret cannot be decrypted");
    }
  }

  // Phase 2: record the release. Audit rows stay serial: the hash chain
  // requires each row to see its predecessor.
  const now = new Date();
  const releasedIds = [...values.keys()];
  await conn
    .update(vaultSecrets)
    .set({ lastUsedAt: now })
    .where(inArray(vaultSecrets.id, releasedIds));
  for (const [secretId] of values) {
    const secret = byId.get(secretId);
    if (!secret) continue;
    await conn.insert(vaultReleases).values({
      secretId,
      caseId: c.id,
      stepId: step.id,
      providerChannelId: channel.id,
      mandateId: mandate.id,
      holderApprovedAt: SENSITIVE_KINDS.has(secret.kind) ? step.approvedAt : null,
      releasedAt: now,
    });
    await writeAudit(conn, {
      actorType: "AGENT",
      actorId: mandate.id,
      action: "VAULT_RELEASE",
      targetType: "vault_secret",
      targetId: secretId,
      caseId: c.id,
      metadata: { kind: secret.kind, provider_channel_id: channel.id, step_id: step.id },
    });
  }

  return text.replace(TOKEN_RE, (match, _kind: string, id: string) => values.get(id) ?? match);
}
