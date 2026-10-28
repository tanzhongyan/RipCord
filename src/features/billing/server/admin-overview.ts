import { count, desc, eq } from "drizzle-orm";
import { adminListReview, liveAdminDeps } from "~/features/providers";
import { verifyAuditChain } from "~/server/audit";
import type { Database } from "~/server/db";
import { auditLogs, cases, dataSubjectRequests, llmUsage, providers } from "~/server/db/schema";
import { currentPeriod } from "~/server/model/budget";

/** Admin dashboard metrics: queue, DSRs, audit chain, spend, case counts. */
export async function adminOverview(conn: Database) {
  const queue = await adminListReview(liveAdminDeps());
  const dsrs = await conn
    .select({
      id: dataSubjectRequests.id,
      kind: dataSubjectRequests.kind,
      status: dataSubjectRequests.status,
      createdAt: dataSubjectRequests.createdAt,
    })
    .from(dataSubjectRequests)
    .orderBy(desc(dataSubjectRequests.createdAt))
    .limit(50);
  const audit = await verifyAuditChain(conn, 100);
  const period = currentPeriod(new Date());
  const spend = await conn
    .select({
      ownerKey: llmUsage.ownerKey,
      costMicros: llmUsage.costMicros,
      tokensIn: llmUsage.tokensIn,
      tokensOut: llmUsage.tokensOut,
    })
    .from(llmUsage)
    .where(eq(llmUsage.period, period))
    .orderBy(desc(llmUsage.costMicros))
    .limit(100);
  const byStatus = await conn
    .select({ status: cases.status, n: count() })
    .from(cases)
    .groupBy(cases.status);
  const byProvider = await conn
    .select({ providerId: cases.providerId, name: providers.name, n: count() })
    .from(cases)
    .leftJoin(providers, eq(providers.id, cases.providerId))
    .groupBy(cases.providerId, providers.name);
  const [auditCount] = await conn.select({ n: count() }).from(auditLogs);
  return {
    queue,
    dsrs,
    audit: { ...audit, total: auditCount?.n ?? 0 },
    spend: { period, rows: spend },
    counts: {
      byStatus: byStatus.map((row) => ({ status: row.status, count: Number(row.n) })),
      byProvider: byProvider.map((row) => ({
        providerId: row.providerId,
        name: row.name,
        count: Number(row.n),
      })),
    },
  };
}
