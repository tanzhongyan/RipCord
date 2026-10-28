import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { env } from "~/shared/config/env";

export const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The 32-byte master key. Outside production it falls back to a fixed dev key
 * (a hash, not a literal) so tests and local development need no secret;
 * production refuses to start without `VAULT_MASTER_KEY`.
 */
export function masterKey(): Buffer {
  if (env.VAULT_MASTER_KEY) return Buffer.from(env.VAULT_MASTER_KEY, "base64");
  if (env.NODE_ENV === "production") {
    throw new Error("VAULT_MASTER_KEY is required in production");
  }
  return createHash("sha256").update("ripcord-dev-vault-key-v1", "utf8").digest();
}

export function currentKeyVersion(): number {
  return env.VAULT_KEY_VERSION ?? 1;
}

export interface Envelope {
  ciphertext: Buffer;
  iv: Buffer;
  wrappedDek: Buffer;
  keyVersion: number;
}

/**
 * Seal one secret: AES-256-GCM with a fresh 32-byte data key, whose key is
 * itself wrapped with AES-256-GCM under the master key. Layouts:
 * `ciphertext = enc(value) || tag`, `wrapped_dek = wrap_iv || enc(dek) || tag`.
 */
export function sealEnvelope(plaintext: string): Envelope {
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const wrapIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv("aes-256-gcm", masterKey(), wrapIv);
  const wrappedDek = Buffer.concat([
    wrapIv,
    wrapper.update(dek),
    wrapper.final(),
    wrapper.getAuthTag(),
  ]);
  return { ciphertext, iv, wrappedDek, keyVersion: currentKeyVersion() };
}

/** Open a sealed envelope. Throws when any byte was tampered with. */
export function openEnvelope(input: {
  ciphertext: Buffer;
  iv: Buffer;
  wrappedDek: Buffer;
}): string {
  const wrapIv = input.wrappedDek.subarray(0, IV_BYTES);
  const wrapTag = input.wrappedDek.subarray(input.wrappedDek.length - TAG_BYTES);
  const wrapData = input.wrappedDek.subarray(IV_BYTES, input.wrappedDek.length - TAG_BYTES);
  const unwrapper = createDecipheriv("aes-256-gcm", masterKey(), wrapIv);
  unwrapper.setAuthTag(wrapTag);
  const dek = Buffer.concat([unwrapper.update(wrapData), unwrapper.final()]);

  const tag = input.ciphertext.subarray(input.ciphertext.length - TAG_BYTES);
  const data = input.ciphertext.subarray(0, input.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", dek, input.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
