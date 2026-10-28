import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url-encoded (spec 0001 mandate links). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256HexBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time hex comparison. Returns false when lengths differ. */
export function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 6-digit one-time code (spec 0000). */
export function randomOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
