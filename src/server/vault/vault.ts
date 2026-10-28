import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { serverSecret } from "~/server/auth/auth";
import type { Database, Transaction } from "~/server/db";
import { vaultSecrets } from "~/server/db/schema";

export type VaultSecretKind = typeof vaultSecrets.$inferInsert.kind;

const AUTH_TAG_BYTES = 16;

// TODO(spec-0002): replace this stub with VAULT_MASTER_KEY envelope encryption.
// Temporary stands: the key derives from the auth secret, the auth tag rides on
// the ciphertext, wrapped_dek is random filler, and key_version is always 1.
function vaultKey(): Buffer {
  return createHash("sha256").update(serverSecret(), "utf8").digest();
}

export async function storeSecret(
  conn: Database | Transaction,
  input: { holderId: string; kind: VaultSecretKind; value: string },
): Promise<{ id: string; displayHint: string | null }> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(input.value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const displayHint = input.kind === "PIN" ? null : input.value.slice(-4);
  const [row] = await conn
    .insert(vaultSecrets)
    .values({
      holderId: input.holderId,
      kind: input.kind,
      ciphertext,
      iv,
      wrappedDek: randomBytes(32),
      keyVersion: 1,
      displayHint,
    })
    .returning({ id: vaultSecrets.id });
  if (!row) throw new Error("Failed to store secret");
  return { id: row.id, displayHint };
}

export async function getSecretValue(conn: Database, secretId: string): Promise<string> {
  const [row] = await conn
    .select()
    .from(vaultSecrets)
    .where(eq(vaultSecrets.id, secretId))
    .limit(1);
  if (!row || row.deletedAt) throw new Error("Secret not found");
  const tag = row.ciphertext.subarray(row.ciphertext.length - AUTH_TAG_BYTES);
  const data = row.ciphertext.subarray(0, row.ciphertext.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), row.iv);
  decipher.setAuthTag(tag);
  const value = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  await conn
    .update(vaultSecrets)
    .set({ lastUsedAt: new Date() })
    .where(eq(vaultSecrets.id, secretId));
  return value;
}
