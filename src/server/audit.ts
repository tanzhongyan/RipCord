import { createHash } from "node:crypto";

import { desc, sql } from "drizzle-orm";

import { type Database, db, type Transaction } from "~/server/db";
import { auditLogs } from "~/server/db/schema";

export type AuditActorType = typeof auditLogs.$inferInsert.actorType;

const GENESIS_HASH = "0".repeat(64);

/** How many of the newest rows the daily verify job re-checks. */
const VERIFY_WINDOW = 10_000;

export interface AuditInput {
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  caseId: string | null;
  metadata: Record<string, unknown>;
}

/** JSON with sorted keys and no whitespace. Metadata values must be JSON. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

interface ChainFields extends AuditInput {
  prevHash: string;
  createdAt: Date;
}

function chainHash(input: ChainFields): string {
  const canonical = canonicalJson({
    action: input.action,
    actor_id: input.actorId,
    actor_type: input.actorType,
    case_id: input.caseId,
    created_at: input.createdAt.toISOString(),
    metadata: input.metadata,
    prev_hash: input.prevHash,
    target_id: input.targetId,
    target_type: input.targetType,
  });
  return createHash("sha256")
    .update(input.prevHash + canonical, "utf8")
    .digest("hex");
}

/**
 * Append one audit row. The hash chains to the previous row:
 * `sha256(prev_hash || canonical_json(row))`. `created_at` is set explicitly
 * so the hashed value matches the stored one. The tail read and the insert
 * run under a transaction-scoped advisory lock, so concurrent writers cannot
 * chain two rows onto the same predecessor.
 */
export async function writeAudit(conn: Database | Transaction, input: AuditInput): Promise<void> {
  await conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit_logs'))`);
    const [last] = await tx
      .select({ hash: auditLogs.hash })
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const createdAt = new Date();
    const hash = chainHash({ ...input, prevHash, createdAt });
    await tx.insert(auditLogs).values({ ...input, prevHash, hash, createdAt });
  });
}

export type VerifyResult = { ok: true; checked: number } | { ok: false; breakAtId: number };

/**
 * Re-verify the newest rows (at most `limit`). Each row must hash correctly
 * and link to its predecessor. Returns the first break, oldest first.
 */
export async function verifyAuditChain(
  conn: Database,
  limit = VERIFY_WINDOW,
): Promise<VerifyResult> {
  const newestFirst = await conn.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(limit);
  const rows = newestFirst.reverse();
  let prevHash: string | null = null;
  for (const row of rows) {
    const self = chainHash({
      actorType: row.actorType,
      actorId: row.actorId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      caseId: row.caseId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      prevHash: row.prevHash,
      createdAt: row.createdAt,
    });
    if (self !== row.hash) return { ok: false, breakAtId: row.id };
    if (prevHash !== null && row.prevHash !== prevHash) {
      return { ok: false, breakAtId: row.id };
    }
    prevHash = row.hash;
  }
  return { ok: true, checked: rows.length };
}

/** Live cron entry: chain check over the process database. */
export async function verifyAuditChainJob(limit = VERIFY_WINDOW): Promise<VerifyResult> {
  return verifyAuditChain(db, limit);
}
