import { randomBytes } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";

import { writeAudit } from "./audit";
import { type Database, db } from "./db";
import {
  accountHolders,
  caseDocuments,
  cases,
  communications,
  dataSubjectRequests,
  mandates,
  vaultReleases,
  vaultSecrets,
} from "./db/schema";
import { createStorage, type StorageClient } from "./storage";

/** Short-lived kinds: 30 days after the case closes. */
const SHORT_DOC_KINDS = ["BILL", "CONTRACT", "SCREENSHOT"] as const;
/** Long-lived kinds: 18 months after the case closes. */
const LONG_DOC_KINDS = ["LOA", "RECEIPT", "DISPUTE_PACKAGE"] as const;

const DAY_MS = 86_400_000;

export interface RetentionCounts {
  documents: number;
  communications: number;
  secretsDeleted: number;
  secretsShredded: number;
  holders: number;
}

function isObjectKey(storageKey: string): boolean {
  return !storageKey.startsWith("data:");
}

async function purgeDocuments(conn: Database, storage: StorageClient, now: Date): Promise<number> {
  const cutoff30d = new Date(now.getTime() - 30 * DAY_MS);
  const cutoff18m = new Date(now.getTime() - 548 * DAY_MS);
  const rows = await conn
    .select({ id: caseDocuments.id, storageKey: caseDocuments.storageKey })
    .from(caseDocuments)
    .innerJoin(cases, eq(cases.id, caseDocuments.caseId))
    .where(
      or(
        lt(caseDocuments.deleteAfter, now),
        and(inArray(caseDocuments.kind, SHORT_DOC_KINDS), lt(cases.closedAt, cutoff30d)),
        and(inArray(caseDocuments.kind, LONG_DOC_KINDS), lt(cases.closedAt, cutoff18m)),
      ),
    );
  if (rows.length === 0) return 0;
  const keys = rows.map((row) => row.storageKey).filter(isObjectKey);
  if (keys.length > 0) await storage.del(keys);
  await conn.delete(caseDocuments).where(
    inArray(
      caseDocuments.id,
      rows.map((row) => row.id),
    ),
  );
  return rows.length;
}

async function purgeCommunications(conn: Database, now: Date): Promise<number> {
  const cutoff18m = new Date(now.getTime() - 548 * DAY_MS);
  const rows = await conn
    .select({ id: communications.id })
    .from(communications)
    .innerJoin(cases, eq(cases.id, communications.caseId))
    .where(lt(cases.closedAt, cutoff18m));
  if (rows.length === 0) return 0;
  await conn.delete(communications).where(
    inArray(
      communications.id,
      rows.map((row) => row.id),
    ),
  );
  return rows.length;
}

/** Holders whose secrets are due: deleted holders past the DSR grace window, or last case closed 90+ days ago. */
async function secretHoldersDue(conn: Database, now: Date): Promise<string[]> {
  const cutoff90d = new Date(now.getTime() - 90 * DAY_MS);
  // A DSR delete soft-deletes the holder first and shreds its secrets
  // after; without a grace window a concurrent retention run hard-deletes
  // the live secrets in between. One day exceeds any DSR request while the
  // daily job still purges promptly.
  const cutoff1d = new Date(now.getTime() - DAY_MS);
  const deleted = await conn
    .select({ id: accountHolders.id })
    .from(accountHolders)
    .where(and(isNotNull(accountHolders.deletedAt), lt(accountHolders.deletedAt, cutoff1d)));
  const stale = await conn
    .select({ id: accountHolders.id })
    .from(accountHolders)
    .innerJoin(cases, eq(cases.holderId, accountHolders.id))
    .groupBy(accountHolders.id)
    .having(
      sql`max(${cases.closedAt}) < ${cutoff90d.toISOString()} and count(*) = count(${cases.closedAt})`,
    );
  return [...new Set([...deleted, ...stale].map((row) => row.id))];
}

async function purgeSecrets(
  conn: Database,
  holderIds: string[],
): Promise<{
  deleted: number;
  shredded: number;
}> {
  if (holderIds.length === 0) return { deleted: 0, shredded: 0 };
  // Phone secrets die with their holder (see purgeHolders); every other due
  // secret is deleted, or shredded when a release references it.
  const phoneSecretIds = conn.select({ id: accountHolders.phoneSecretId }).from(accountHolders);
  const rows = await conn
    .select()
    .from(vaultSecrets)
    .where(
      and(
        inArray(vaultSecrets.holderId, holderIds),
        isNull(vaultSecrets.deletedAt),
        notInArray(vaultSecrets.id, phoneSecretIds),
      ),
    );
  if (rows.length === 0) return { deleted: 0, shredded: 0 };
  const released = await conn
    .select({ secretId: vaultReleases.secretId })
    .from(vaultReleases)
    .where(
      inArray(
        vaultReleases.secretId,
        rows.map((row) => row.id),
      ),
    );
  const releasedIds = new Set(released.map((row) => row.secretId));
  const deletable = rows.filter((row) => !releasedIds.has(row.id));
  if (deletable.length > 0) {
    await conn.delete(vaultSecrets).where(
      inArray(
        vaultSecrets.id,
        deletable.map((row) => row.id),
      ),
    );
  }
  // Shredding needs distinct random bytes per row, so it stays per-row;
  // releases are append-only, so these rows stay with dead ciphertext.
  const now = new Date();
  let shredded = 0;
  for (const row of rows) {
    if (!releasedIds.has(row.id)) continue;
    await conn
      .update(vaultSecrets)
      .set({
        ciphertext: randomBytes(row.ciphertext.length),
        wrappedDek: randomBytes(row.wrappedDek.length),
        deletedAt: now,
      })
      .where(eq(vaultSecrets.id, row.id));
    shredded++;
  }
  return { deleted: deletable.length, shredded };
}

async function purgeHolders(conn: Database, now: Date): Promise<number> {
  const cutoff30d = new Date(now.getTime() - 30 * DAY_MS);
  const candidates = await conn
    .select({ id: accountHolders.id })
    .from(accountHolders)
    .where(lt(accountHolders.deletedAt, cutoff30d));
  if (candidates.length === 0) return 0;
  const ids = candidates.map((candidate) => candidate.id);
  const [caseHits, mandateHits, dsrHits, releaseHits] = await Promise.all([
    conn.select({ holderId: cases.holderId }).from(cases).where(inArray(cases.holderId, ids)),
    conn
      .select({ holderId: mandates.holderId })
      .from(mandates)
      .where(inArray(mandates.holderId, ids)),
    conn
      .select({ holderId: dataSubjectRequests.holderId })
      .from(dataSubjectRequests)
      .where(inArray(dataSubjectRequests.holderId, ids)),
    conn
      .select({ holderId: vaultSecrets.holderId })
      .from(vaultReleases)
      .innerJoin(vaultSecrets, eq(vaultSecrets.id, vaultReleases.secretId))
      .where(inArray(vaultSecrets.holderId, ids)),
  ]);
  const blocked = new Set([
    ...caseHits.map((row) => row.holderId),
    ...mandateHits.map((row) => row.holderId),
    ...dsrHits.map((row) => row.holderId).filter((holderId) => holderId !== null),
    ...releaseHits.map((row) => row.holderId),
  ]);
  // Releases are append-only, so a holder with releases keeps its (already
  // shredded) rows; the alias is not personal data.
  const survivors = ids.filter((id) => !blocked.has(id));
  if (survivors.length === 0) return 0;
  // One transaction: holders and their secrets reference each other, and the
  // deferred foreign keys are checked at commit.
  await conn.transaction(async (tx) => {
    await tx.delete(vaultSecrets).where(inArray(vaultSecrets.holderId, survivors));
    await tx.delete(accountHolders).where(inArray(accountHolders.id, survivors));
  });
  return survivors.length;
}

/**
 * Daily retention job, exactly as the data contract's Retention table says.
 * Short-lived documents go 30 days after the case closes, long-lived ones and
 * communications after 18 months, secrets a day after the holder deletes
 * them (so a DSR delete finishes shredding first) or 90 days after their
 * last case closes, and soft-deleted holders after 30 days.
 * Documents past `delete_after` (set by a DELETE request) go regardless of
 * kind. Each purge writes an `audit_logs` row with counts only.
 *
 * `audit_logs` (5 years) is deliberately not purged here: the append-only
 * trigger rejects DELETE, so the 5-year purge is a manual DBA task.
 */
export async function runRetention(
  conn: Database,
  opts: { storage: StorageClient; now: Date },
): Promise<RetentionCounts> {
  const documents = await purgeDocuments(conn, opts.storage, opts.now);
  const comms = await purgeCommunications(conn, opts.now);
  const secrets = await purgeSecrets(conn, await secretHoldersDue(conn, opts.now));
  const holders = await purgeHolders(conn, opts.now);
  const counts: RetentionCounts = {
    documents,
    communications: comms,
    secretsDeleted: secrets.deleted,
    secretsShredded: secrets.shredded,
    holders,
  };
  await writeAudit(conn, {
    actorType: "SYSTEM",
    actorId: "retention",
    action: "RETENTION_PURGE",
    targetType: "retention",
    targetId: "daily",
    caseId: null,
    metadata: { ...counts },
  });
  return counts;
}

/** Live cron entry: retention over the process database and storage. */
export async function runRetentionJob(now: Date = new Date()): Promise<RetentionCounts> {
  return runRetention(db, { storage: createStorage(), now });
}
