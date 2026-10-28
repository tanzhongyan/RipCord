import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { writeAudit } from "~/server/audit";
import type { Database } from "~/server/db";
import { db } from "~/server/db";
import {
  accountHolders,
  caseDocuments,
  cases,
  dataSubjectRequests,
  vaultSecrets,
} from "~/server/db/schema";
import { createStorage, type StorageClient } from "~/server/storage";
import { deleteHolderSecrets, getSecretValues, maskSecret } from "~/server/vault";
import { exportSchema, requestAccessSchema, requestDeleteSchema } from "../schemas/privacy";
import { type CallerIdentity, callerOwns } from "./mandate-flow";

export interface PrivacyDeps {
  db: Database;
  storage: StorageClient;
  now: () => Date;
}

function liveDeps(): PrivacyDeps {
  return { db, storage: createStorage(), now: () => new Date() };
}

type HolderRow = typeof accountHolders.$inferSelect;

async function loadOwnedHolder(
  conn: Database,
  holderId: string,
  caller: CallerIdentity,
): Promise<HolderRow> {
  const [holder] = await conn
    .select()
    .from(accountHolders)
    .where(and(eq(accountHolders.id, holderId), isNull(accountHolders.deletedAt)))
    .limit(1);
  if (!holder || !callerOwns(holder, caller)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Holder not found" });
  }
  return holder;
}

/** Personal holders of the caller (organisation holders belong to the org). */
async function loadPersonalHolders(conn: Database, caller: CallerIdentity): Promise<HolderRow[]> {
  return conn
    .select()
    .from(accountHolders)
    .where(
      and(
        eq(accountHolders.ownerUserId, caller.userId),
        isNull(accountHolders.orgId),
        isNull(accountHolders.deletedAt),
      ),
    );
}

const SHORT_DOC_KINDS = ["BILL", "CONTRACT", "SCREENSHOT"] as const;

/**
 * Complete a DELETE request for one holder now: soft-delete the holder,
 * crypto-shred its secrets, delete short-lived documents from the object
 * store, and mark the remaining documents for purge within 30 days.
 */
async function deleteHolderData(deps: PrivacyDeps, holder: HolderRow): Promise<void> {
  const now = deps.now();
  await deps.db
    .update(accountHolders)
    .set({ deletedAt: now })
    .where(eq(accountHolders.id, holder.id));
  await deleteHolderSecrets(deps.db, holder.id);

  const docs = await deps.db
    .select({
      id: caseDocuments.id,
      kind: caseDocuments.kind,
      storageKey: caseDocuments.storageKey,
    })
    .from(caseDocuments)
    .innerJoin(cases, eq(cases.id, caseDocuments.caseId))
    .where(eq(cases.holderId, holder.id));
  const shortIds: string[] = [];
  const shortKeys: string[] = [];
  const longIds: string[] = [];
  for (const doc of docs) {
    if ((SHORT_DOC_KINDS as readonly string[]).includes(doc.kind)) {
      shortIds.push(doc.id);
      if (!doc.storageKey.startsWith("data:")) shortKeys.push(doc.storageKey);
    } else {
      longIds.push(doc.id);
    }
  }
  if (shortKeys.length > 0) await deps.storage.del(shortKeys);
  if (shortIds.length > 0) {
    await deps.db.delete(caseDocuments).where(inArray(caseDocuments.id, shortIds));
  }
  if (longIds.length > 0) {
    await deps.db
      .update(caseDocuments)
      .set({ deleteAfter: new Date(now.getTime() + 30 * 86_400_000) })
      .where(inArray(caseDocuments.id, longIds));
  }
}

export async function requestAccess(
  input: { holderId?: string },
  caller: CallerIdentity,
  deps: PrivacyDeps = liveDeps(),
): Promise<{ requestId: string }> {
  let holder: HolderRow | null = null;
  if (input.holderId) holder = await loadOwnedHolder(deps.db, input.holderId, caller);
  const now = deps.now();
  const [row] = await deps.db
    .insert(dataSubjectRequests)
    .values({
      userId: holder ? null : caller.userId,
      holderId: holder?.id ?? null,
      kind: "ACCESS",
      status: "COMPLETED",
      completedAt: now,
    })
    .returning({ id: dataSubjectRequests.id });
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Request failed" });
  await writeAudit(deps.db, {
    actorType: "USER",
    actorId: caller.userId,
    action: "DSR_ACCESS_COMPLETED",
    targetType: "data_subject_request",
    targetId: row.id,
    caseId: null,
    metadata: holder ? { holder_id: holder.id } : {},
  });
  return { requestId: row.id };
}

export async function requestDelete(
  input: { holderId?: string },
  caller: CallerIdentity,
  deps: PrivacyDeps = liveDeps(),
): Promise<{ requestId: string }> {
  const holders = input.holderId
    ? [await loadOwnedHolder(deps.db, input.holderId, caller)]
    : await loadPersonalHolders(deps.db, caller);
  const now = deps.now();
  const [row] = await deps.db
    .insert(dataSubjectRequests)
    .values({
      userId: input.holderId ? null : caller.userId,
      holderId: input.holderId ?? null,
      kind: "DELETE",
      status: holders.length === 0 ? "COMPLETED" : "IN_PROGRESS",
      completedAt: holders.length === 0 ? now : null,
    })
    .returning({ id: dataSubjectRequests.id });
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Request failed" });
  for (const holder of holders) {
    await deleteHolderData(deps, holder);
  }
  await deps.db
    .update(dataSubjectRequests)
    .set({ status: "COMPLETED", completedAt: deps.now() })
    .where(eq(dataSubjectRequests.id, row.id));
  await writeAudit(deps.db, {
    actorType: "USER",
    actorId: caller.userId,
    action: "DSR_DELETE_COMPLETED",
    targetType: "data_subject_request",
    targetId: row.id,
    caseId: null,
    metadata: { holders: holders.length },
  });
  return { requestId: row.id };
}

export interface DsrExport {
  requestId: string;
  exportedAt: Date;
  holders: Array<{
    id: string;
    alias: string;
    orgId: string | null;
    createdAt: Date;
    secrets: Array<{
      kind: string;
      masked: string;
      displayHint: string | null;
      lastUsedAt: Date | null;
    }>;
  }>;
  cases: Array<{
    id: string;
    holderId: string;
    status: string;
    serviceType: string | null;
    createdAt: Date;
    closedAt: Date | null;
  }>;
  requests: Array<{
    id: string;
    kind: string;
    status: string;
    completedAt: Date | null;
    createdAt: Date;
  }>;
}

export async function exportDsr(
  input: { requestId: string },
  caller: CallerIdentity,
  deps: PrivacyDeps = liveDeps(),
): Promise<DsrExport> {
  const [request] = await deps.db
    .select()
    .from(dataSubjectRequests)
    .where(eq(dataSubjectRequests.id, input.requestId))
    .limit(1);
  if (request?.kind !== "ACCESS" || request?.status !== "COMPLETED") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Export not found" });
  }
  let holders: HolderRow[];
  if (request.holderId) {
    holders = [await loadOwnedHolder(deps.db, request.holderId, caller)];
  } else {
    if (request.userId !== caller.userId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Export not found" });
    }
    holders = await loadPersonalHolders(deps.db, caller);
  }
  const out: DsrExport = {
    requestId: request.id,
    exportedAt: deps.now(),
    holders: [],
    cases: [],
    requests: [],
  };
  for (const holder of holders) {
    const secrets = await deps.db
      .select({
        id: vaultSecrets.id,
        kind: vaultSecrets.kind,
        displayHint: vaultSecrets.displayHint,
        lastUsedAt: vaultSecrets.lastUsedAt,
      })
      .from(vaultSecrets)
      .where(and(eq(vaultSecrets.holderId, holder.id), isNull(vaultSecrets.deletedAt)));
    const values = await getSecretValues(
      deps.db,
      secrets.map((secret) => secret.id),
    );
    const maskedSecrets: DsrExport["holders"][number]["secrets"] = [];
    for (const secret of secrets) {
      maskedSecrets.push({
        kind: secret.kind,
        masked: maskSecret(values.get(secret.id) ?? ""),
        displayHint: secret.displayHint,
        lastUsedAt: secret.lastUsedAt,
      });
    }
    out.holders.push({
      id: holder.id,
      alias: holder.alias,
      orgId: holder.orgId,
      createdAt: holder.createdAt,
      secrets: maskedSecrets,
    });
    const holderCases = await deps.db
      .select({
        id: cases.id,
        holderId: cases.holderId,
        status: cases.status,
        serviceType: cases.serviceType,
        createdAt: cases.createdAt,
        closedAt: cases.closedAt,
      })
      .from(cases)
      .where(eq(cases.holderId, holder.id));
    out.cases.push(...holderCases);
  }
  const history = await deps.db
    .select({
      id: dataSubjectRequests.id,
      kind: dataSubjectRequests.kind,
      status: dataSubjectRequests.status,
      completedAt: dataSubjectRequests.completedAt,
      createdAt: dataSubjectRequests.createdAt,
    })
    .from(dataSubjectRequests)
    .where(
      request.holderId
        ? eq(dataSubjectRequests.holderId, request.holderId)
        : eq(dataSubjectRequests.userId, caller.userId),
    );
  out.requests.push(...history);
  return out;
}

export const privacyRouter = createTRPCRouter({
  requestAccess: protectedProcedure.input(requestAccessSchema).mutation(async ({ ctx, input }) => {
    return requestAccess(input, { userId: ctx.userId, orgIds: ctx.orgIds });
  }),

  requestDelete: protectedProcedure.input(requestDeleteSchema).mutation(async ({ ctx, input }) => {
    return requestDelete(input, { userId: ctx.userId, orgIds: ctx.orgIds });
  }),

  export: protectedProcedure.input(exportSchema).query(async ({ ctx, input }) => {
    return exportDsr(input, { userId: ctx.userId, orgIds: ctx.orgIds });
  }),
});
