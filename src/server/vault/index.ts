import { randomBytes } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database, Transaction } from "~/server/db";
import { vaultSecrets } from "~/server/db/schema";
import { logger } from "~/server/logger";
import { openEnvelope, sealEnvelope } from "./crypto";
import { redactPatterns } from "./redact";

export type VaultSecretKind = typeof vaultSecrets.$inferInsert.kind;

export { containsStrongPii, redactPatterns } from "./redact";
export type { ReleaseContext } from "./releases";
export { isSandboxAddress, resolveTokens, VaultReleaseError } from "./releases";

/** Placeholder token for a stored secret: `{{vault:<KIND>:<id>}}`. */
export function secretToken(kind: VaultSecretKind, id: string): string {
  return `{{vault:${kind}:${id}}}`;
}

/** Masked display of a secret value, for example `S****567D`. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.charAt(0)}****${value.slice(-4)}`;
}

export async function storeSecret(
  conn: Database | Transaction,
  input: { holderId: string; kind: VaultSecretKind; value: string },
): Promise<{ id: string; displayHint: string | null }> {
  if (!input.value) throw new Error("Cannot store an empty secret");
  const envelope = sealEnvelope(input.value);
  const displayHint = input.kind === "PIN" ? null : input.value.slice(-4);
  const [row] = await conn
    .insert(vaultSecrets)
    .values({
      holderId: input.holderId,
      kind: input.kind,
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      wrappedDek: envelope.wrappedDek,
      keyVersion: envelope.keyVersion,
      displayHint,
    })
    .returning({ id: vaultSecrets.id });
  if (!row) throw new Error("Failed to store secret");
  return { id: row.id, displayHint };
}

/**
 * Decrypt one secret for server-internal use (for example texting the holder
 * their own one-time code). Releases to provider channels go through
 * `resolveTokens`, which enforces the five release rules. Never expose this
 * to clients, logs or model prompts.
 */
export async function getSecretValue(
  conn: Database | Transaction,
  secretId: string,
): Promise<string> {
  const [row] = await conn
    .select()
    .from(vaultSecrets)
    .where(eq(vaultSecrets.id, secretId))
    .limit(1);
  if (!row || row.deletedAt) throw new Error("Secret not found");
  const value = openEnvelope({
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedDek: row.wrappedDek,
  });
  await conn
    .update(vaultSecrets)
    .set({ lastUsedAt: new Date() })
    .where(eq(vaultSecrets.id, secretId));
  return value;
}

/**
 * Decrypt several secrets at once, for exports. Throws when any id is missing
 * or deleted, like the singular read.
 */
export async function getSecretValues(
  conn: Database | Transaction,
  secretIds: string[],
): Promise<Map<string, string>> {
  const rows = await conn.select().from(vaultSecrets).where(inArray(vaultSecrets.id, secretIds));
  const values = new Map<string, string>();
  for (const id of secretIds) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row || row.deletedAt) throw new Error("Secret not found");
    values.set(
      id,
      openEnvelope({ ciphertext: row.ciphertext, iv: row.iv, wrappedDek: row.wrappedDek }),
    );
  }
  await conn
    .update(vaultSecrets)
    .set({ lastUsedAt: new Date() })
    .where(inArray(vaultSecrets.id, secretIds));
  return values;
}

/** Kinds the holder has at least one live secret of. */
export async function listSecretKinds(
  conn: Database | Transaction,
  holderId: string,
): Promise<VaultSecretKind[]> {
  const rows = await conn
    .select({ kind: vaultSecrets.kind })
    .from(vaultSecrets)
    .where(and(eq(vaultSecrets.holderId, holderId), isNull(vaultSecrets.deletedAt)));
  return [...new Set(rows.map((row) => row.kind))];
}

/**
 * Crypto-shred every secret of a holder: ciphertext and wrapped key are
 * overwritten with random bytes and `deleted_at` is set. Returns the count.
 */
export async function deleteHolderSecrets(
  conn: Database | Transaction,
  holderId: string,
): Promise<number> {
  const rows = await conn
    .select({
      id: vaultSecrets.id,
      ciphertext: vaultSecrets.ciphertext,
      wrappedDek: vaultSecrets.wrappedDek,
    })
    .from(vaultSecrets)
    .where(and(eq(vaultSecrets.holderId, holderId), isNull(vaultSecrets.deletedAt)));
  const now = new Date();
  for (const row of rows) {
    await conn
      .update(vaultSecrets)
      .set({
        ciphertext: randomBytes(row.ciphertext.length),
        wrappedDek: randomBytes(row.wrappedDek.length),
        deletedAt: now,
      })
      .where(eq(vaultSecrets.id, row.id));
  }
  return rows.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a known secret value. `NRIC`, `PHONE` and `ACCOUNT_NO` ignore spaces
 * and dashes, so `S1234567D` also matches `s 1234567 d`. Values shorter than
 * 4 characters never match. Returns null when the value cannot match safely.
 */
function knownSecretPattern(kind: VaultSecretKind, value: string): RegExp | null {
  const compact = value.replace(/[\s-]/g, "");
  if (compact.length < 4) return null;
  if (kind === "NRIC" || kind === "PHONE" || kind === "ACCOUNT_NO") {
    return new RegExp([...compact].map(escapeRegExp).join("[\\s-]*"), "gi");
  }
  return new RegExp(escapeRegExp(value), "gi");
}

interface KnownSecret {
  kind: VaultSecretKind;
  id: string;
  value: string;
}

/** The holder's live secrets, decrypted once, longest values first. */
async function loadKnownSecrets(
  conn: Database | Transaction,
  holderId: string,
): Promise<KnownSecret[]> {
  const rows = await conn
    .select()
    .from(vaultSecrets)
    .where(and(eq(vaultSecrets.holderId, holderId), isNull(vaultSecrets.deletedAt)));
  const known: KnownSecret[] = [];
  for (const row of rows) {
    // openEnvelope only throws when the bytes do not decrypt; anything else
    // (a missing row shape, a driver fault) bubbles up.
    let value: string;
    try {
      value = openEnvelope({
        ciphertext: row.ciphertext,
        iv: row.iv,
        wrappedDek: row.wrappedDek,
      });
    } catch {
      logger.warn(`Skipping undecryptable ${row.kind} secret ${row.id} in redact`);
      continue;
    }
    known.push({ kind: row.kind, id: row.id, value });
  }
  known.sort((a, b) => b.value.length - a.value.length);
  return known;
}

function replaceKnownSecrets(text: string, known: KnownSecret[]): string {
  let out = text;
  for (const secret of known) {
    const pattern = knownSecretPattern(secret.kind, secret.value);
    if (pattern) out = out.replace(pattern, secretToken(secret.kind, secret.id));
  }
  return out;
}

/**
 * Replace every known secret of the holder with its token, then redact
 * unknown PII by pattern. A null holder redacts by pattern only (the server
 * logger). Secrets that fail to decrypt are skipped, never thrown.
 */
export async function redact(
  conn: Database | Transaction,
  text: string,
  holderId: string | null,
): Promise<string> {
  if (!holderId) return redactPatterns(text);
  const known = await loadKnownSecrets(conn, holderId);
  return redactPatterns(replaceKnownSecrets(text, known));
}

/**
 * Redact many texts against one fetch of the holder's secrets: a single
 * `vault_secrets` SELECT and one decryption per secret, then every text is
 * redacted against the cached set. A null holder redacts by pattern only.
 */
export async function redactMany(
  conn: Database | Transaction,
  texts: string[],
  holderId: string | null,
): Promise<string[]> {
  if (!holderId) return texts.map(redactPatterns);
  const known = await loadKnownSecrets(conn, holderId);
  return texts.map((text) => redactPatterns(replaceKnownSecrets(text, known)));
}
