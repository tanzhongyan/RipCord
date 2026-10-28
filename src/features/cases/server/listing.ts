import { and, count, desc, eq, inArray, lt, or } from "drizzle-orm";

import { db } from "~/server/db";
import { caseSteps, cases, contractTerms, receipts } from "~/server/db/schema";
import { redact } from "~/server/vault";
import { LIST_PAGE_SIZE } from "../schemas/case";
import type { CaseRow } from "./tools/context";

export interface ListCasesInput {
  page?: number;
  status?: string;
  holderId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface ListCasesRow {
  id: string;
  status: string;
  providerId: string | null;
  serviceType: string | null;
  holderId: string;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date | null;
}

/** Decode a cursor of `updated_at|id`. Returns null when absent or malformed. */
function decodeCursor(cursor: string | null | undefined): { updatedAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  if (!at || !id) return null;
  const updatedAt = new Date(at);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, id };
}

function encodeCursor(row: ListCasesRow): string {
  return `${(row.updatedAt ?? row.createdAt).toISOString()}|${row.id}`;
}

/**
 * List the caller's cases, newest first. Cursor pagination on
 * `(updated_at DESC, id)`, 25 per page, with optional status and holder
 * filters. The `page` form stays for the `list-cases` tool's backwards
 * compat; dashboard callers pass `cursor`.
 */
export async function listCases(
  input: ListCasesInput,
  ctx: { userId: string; orgIds: string[] },
): Promise<{
  cases: ListCasesRow[];
  page: number;
  pageSize: number;
  total: number;
  nextCursor: string | null;
}> {
  const ownership = [eq(cases.ownerUserId, ctx.userId)];
  if (ctx.orgIds.length > 0) ownership.push(inArray(cases.orgId, ctx.orgIds));
  const filters = [or(...ownership)];
  if (input.status)
    filters.push(eq(cases.status, input.status as typeof cases.$inferSelect.status));
  if (input.holderId) filters.push(eq(cases.holderId, input.holderId));
  const where = and(...filters);

  const cursor = decodeCursor(input.cursor);
  if (cursor) {
    const paged = and(
      where,
      or(
        lt(cases.updatedAt, cursor.updatedAt),
        and(eq(cases.updatedAt, cursor.updatedAt), lt(cases.id, cursor.id)),
      ),
    );
    const limit = input.limit ?? LIST_PAGE_SIZE;
    const rows = (await db
      .select({
        id: cases.id,
        status: cases.status,
        providerId: cases.providerId,
        serviceType: cases.serviceType,
        holderId: cases.holderId,
        orgId: cases.orgId,
        createdAt: cases.createdAt,
        updatedAt: cases.updatedAt,
      })
      .from(cases)
      .where(paged)
      .orderBy(desc(cases.updatedAt), desc(cases.id))
      .limit(limit + 1)) as ListCasesRow[];
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeCursor(page[page.length - 1] as ListCasesRow)
        : null;
    const [total] = await db.select({ n: count() }).from(cases).where(where);
    return { cases: page, page: 1, pageSize: limit, total: Number(total?.n ?? 0), nextCursor };
  }

  const page = input.page ?? 1;
  const rows = (await db
    .select({
      id: cases.id,
      status: cases.status,
      providerId: cases.providerId,
      serviceType: cases.serviceType,
      holderId: cases.holderId,
      orgId: cases.orgId,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(where)
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(LIST_PAGE_SIZE)
    .offset((page - 1) * LIST_PAGE_SIZE)) as ListCasesRow[];
  const [total] = await db.select({ n: count() }).from(cases).where(where);
  const nextCursor =
    rows.length === LIST_PAGE_SIZE ? encodeCursor(rows[rows.length - 1] as ListCasesRow) : null;
  return { cases: rows, page, pageSize: LIST_PAGE_SIZE, total: Number(total?.n ?? 0), nextCursor };
}

/** Full case view with steps, terms and receipt. Tokens only, never raw PII. */
export async function getCaseView(c: CaseRow) {
  const steps = await db
    .select()
    .from(caseSteps)
    .where(eq(caseSteps.caseId, c.id))
    .orderBy(caseSteps.seq);
  const [terms] = await db
    .select()
    .from(contractTerms)
    .where(eq(contractTerms.caseId, c.id))
    .limit(1);
  const [receipt] = await db.select().from(receipts).where(eq(receipts.caseId, c.id)).limit(1);
  const view = {
    case: {
      id: c.id,
      status: c.status,
      providerId: c.providerId,
      serviceType: c.serviceType,
      holderId: c.holderId,
      orgId: c.orgId,
      sandbox: c.sandbox,
      recommendation: c.recommendation,
      failureReason: c.failureReason,
      chosenChannelId: c.chosenChannelId,
      closedAt: c.closedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    },
    steps,
    terms: terms ?? null,
    receipt: receipt ?? null,
  };
  return JSON.parse(await redact(db, JSON.stringify(view), c.holderId)) as typeof view;
}
