import { desc } from "drizzle-orm";

import type { Database } from "~/server/db";
import { auditLogs } from "~/server/db/schema";
import { sha256hex } from "./tokens";

export type AuditActorType = typeof auditLogs.$inferInsert.actorType;

const GENESIS_HASH = "0".repeat(64);

export interface AuditInput {
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  caseId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Append one audit row. The hash chains to the previous row:
 * SHA-256 of prev_hash and the row fields, joined by "|". `created_at` is set
 * explicitly so the hashed value matches the stored one.
 */
export async function writeAudit(conn: Database, input: AuditInput): Promise<void> {
  const [last] = await conn
    .select({ hash: auditLogs.hash })
    .from(auditLogs)
    .orderBy(desc(auditLogs.id))
    .limit(1);
  const prevHash = last?.hash ?? GENESIS_HASH;
  const createdAt = new Date();
  const hash = sha256hex(
    [
      prevHash,
      input.actorType,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.caseId ?? "",
      JSON.stringify(input.metadata),
      createdAt.toISOString(),
    ].join("|"),
  );
  await conn.insert(auditLogs).values({ ...input, prevHash, hash, createdAt });
}
