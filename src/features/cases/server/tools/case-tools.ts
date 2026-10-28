import { randomUUID } from "node:crypto";

import { and, count, desc, eq, gte, inArray, or } from "drizzle-orm";
import { z } from "zod";

import {
  approveStep,
  MandateError,
  requestMandate,
  requestMandateSchema,
} from "~/features/identity";
import { documentKindSchema } from "~/features/providers";
import { writeAudit } from "~/server/audit";
import { db } from "~/server/db";
import {
  accountHolders,
  caseDocuments,
  caseSteps,
  cases,
  contractTerms,
  providers,
  receipts,
  verifications,
} from "~/server/db/schema";
import { complete } from "~/server/model/adapter";
import { ALLOWED_UPLOAD_TYPES, documentKey, MAX_UPLOAD_BYTES } from "~/server/storage";
import { redact } from "~/server/vault";
import { caseIdSchema, LIST_PAGE_SIZE, listCasesSchema } from "../../schemas/case";
import {
  ALL_CASE_STATUSES,
  type CaseStatus,
  isTerminalStatus,
  NON_TERMINAL_STATUSES,
  type TransitionActor,
  transition,
} from "../engine";
import { ToolError } from "../errors";
import { runNextStep } from "../executor";
import { extractDocument } from "../extraction";
import { etfExceedsMandate } from "../recommendation";
import { type CaseRow, ownerKeyFor, type ToolContext } from "./context";
import type { ToolDef } from "./registry";

/** Cases a user may create per day (0000 limits). */
const CASES_PER_DAY = 10;
/** Open cases an owner may hold (0000 limits). */
const OPEN_CASES_PER_OWNER = 20;

const confirmField = z.boolean().optional();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const contentTypeSchema = z
  .string()
  .refine(
    (value): value is (typeof ALLOWED_UPLOAD_TYPES)[number] =>
      (ALLOWED_UPLOAD_TYPES as readonly string[]).includes(value),
    {
      message: "Upload must be PDF, PNG or JPEG",
    },
  );

const DRAFT_SYSTEM =
  "Draft one short reply for a cancellation call or chat. " +
  "Decline any retention offer politely, restate the cancellation request, and never " +
  "accept an offer or change the service. Use short sentences. Reply with the draft only.";

function actorFor(ctx: ToolContext): TransitionActor {
  return { type: "USER", id: ctx.userId };
}

function toToolError(error: unknown): never {
  if (error instanceof ToolError) throw error;
  if (error instanceof MandateError) {
    throw new ToolError(error.code, error.message.replace(/^\[[A-Z_]+\] /, ""));
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function startOfUtcDay(now: Date): Date {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

async function requireHolder(holderId: string, ctx: ToolContext) {
  const ownership = [eq(accountHolders.ownerUserId, ctx.userId)];
  if (ctx.orgIds.length > 0) ownership.push(inArray(accountHolders.orgId, ctx.orgIds));
  const [holder] = await db
    .select()
    .from(accountHolders)
    .where(and(eq(accountHolders.id, holderId), or(...ownership)))
    .limit(1);
  if (!holder || holder.deletedAt) throw new ToolError("NOT_FOUND", "Holder not found");
  return holder;
}

async function requireCaseDocument(caseId: string, documentId: string) {
  const [doc] = await db
    .select({ id: caseDocuments.id })
    .from(caseDocuments)
    .where(and(eq(caseDocuments.caseId, caseId), eq(caseDocuments.id, documentId)))
    .limit(1);
  if (!doc) throw new ToolError("NOT_FOUND", "Document not found");
}

async function createCase(
  input: { holderId: string; providerId?: string | null; note?: string },
  ctx: ToolContext,
) {
  const holder = await requireHolder(input.holderId, ctx);
  if (input.providerId) {
    const [provider] = await db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.id, input.providerId))
      .limit(1);
    if (!provider) throw new ToolError("NOT_FOUND", "Provider not found");
  }
  const createdFilter = holder.orgId
    ? eq(cases.orgId, holder.orgId)
    : eq(cases.ownerUserId, ctx.userId);
  const [created] = await db
    .select({ n: count() })
    .from(cases)
    .where(and(createdFilter, gte(cases.createdAt, startOfUtcDay(ctx.now()))));
  if ((created?.n ?? 0) >= CASES_PER_DAY) {
    throw new ToolError("LIMIT_REACHED", "Too many cases created today");
  }
  const openStatuses = NON_TERMINAL_STATUSES as CaseStatus[];
  const [open] = await db
    .select({ n: count() })
    .from(cases)
    .where(and(createdFilter, inArray(cases.status, openStatuses)));
  if ((open?.n ?? 0) >= OPEN_CASES_PER_OWNER) {
    throw new ToolError("LIMIT_REACHED", "Too many open cases");
  }

  const [row] = await db
    .insert(cases)
    .values({
      ownerUserId: ctx.userId,
      orgId: holder.orgId,
      holderId: holder.id,
      providerId: input.providerId ?? null,
    })
    .returning({ id: cases.id });
  if (!row) throw new ToolError("INTERNAL_ERROR", "Could not create the case");
  await writeAudit(db, {
    actorType: "USER",
    actorId: ctx.userId,
    action: "CASE_CREATED",
    targetType: "case",
    targetId: row.id,
    caseId: row.id,
    metadata: { ...(input.note ? { note: input.note } : {}) },
  });
  return { caseId: row.id };
}

async function getCaseView(c: CaseRow) {
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

export function caseToolDefs(): ToolDef[] {
  return [
    {
      name: "create-case",
      budget: "write",
      confirm: false,
      statuses: null,
      input: z.object({
        holderId: z.uuid(),
        providerId: z.uuid().nullish(),
        note: z.string().max(2000).optional(),
      }),
      handler: async (raw, ctx) => {
        const input = raw as { holderId: string; providerId?: string | null; note?: string };
        return createCase(input, ctx);
      },
    },
    {
      name: "start-case",
      budget: "write",
      confirm: true,
      statuses: ["DRAFT"],
      input: caseIdSchema.extend({ confirm: confirmField }),
      handler: async (raw, ctx) => {
        const { caseId } = raw as { caseId: string };
        const move = await transition(caseId, "DISCOVERY", { actor: actorFor(ctx) });
        return { caseId, status: move.to };
      },
    },
    {
      name: "get-case",
      budget: "read",
      confirm: false,
      statuses: ALL_CASE_STATUSES,
      input: caseIdSchema,
      handler: async (_raw, _ctx, c) => {
        if (!c) throw new ToolError("NOT_FOUND", "Case not found");
        return getCaseView(c);
      },
    },
    {
      name: "list-cases",
      budget: "read",
      confirm: false,
      statuses: null,
      input: listCasesSchema,
      handler: async (raw, ctx) => {
        const { page } = raw as { page: number };
        const ownership = [eq(cases.ownerUserId, ctx.userId)];
        if (ctx.orgIds.length > 0) ownership.push(inArray(cases.orgId, ctx.orgIds));
        const filter = or(...ownership);
        const rows = await db
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
          .where(filter)
          .orderBy(desc(cases.updatedAt))
          .limit(LIST_PAGE_SIZE)
          .offset((page - 1) * LIST_PAGE_SIZE);
        const [total] = await db.select({ n: count() }).from(cases).where(filter);
        return { cases: rows, page, pageSize: LIST_PAGE_SIZE, total: total?.n ?? 0 };
      },
    },
    {
      name: "attach-document",
      budget: "write",
      confirm: false,
      statuses: ["DISCOVERY", "PRE_FLIGHT_AUDIT", "RECEIPT_ACQUISITION", "AWAITING_VERIFICATION"],
      input: caseIdSchema.extend({
        kind: documentKindSchema,
        contentType: contentTypeSchema,
        contentLength: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
      }),
      handler: async (raw, ctx, c) => {
        const input = raw as {
          caseId: string;
          kind: (typeof documentKindSchema.options)[number];
          contentType: string;
          contentLength: number;
        };
        if (!c) throw new ToolError("NOT_FOUND", "Case not found");
        const extension =
          input.contentType === "application/pdf"
            ? "pdf"
            : input.contentType === "image/png"
              ? "png"
              : "jpg";
        const documentId = randomUUID();
        const key = documentKey(input.caseId, documentId, extension);
        const { url } = await ctx.storage.presignUpload(key, input.contentType);
        await db.insert(caseDocuments).values({
          id: documentId,
          caseId: input.caseId,
          kind: input.kind,
          storageKey: key,
          // Placeholder until the upload lands; extraction refreshes it.
          sha256: "0".repeat(64),
        });
        return { documentId, uploadUrl: url };
      },
    },
    {
      name: "extract-document",
      budget: "write",
      confirm: false,
      statuses: ["DISCOVERY", "PRE_FLIGHT_AUDIT"],
      input: caseIdSchema.extend({ documentId: z.uuid() }),
      handler: async (raw, ctx, c) => {
        const input = raw as { caseId: string; documentId: string };
        if (!c) throw new ToolError("NOT_FOUND", "Case not found");
        const result = await extractDocument(
          { caseId: input.caseId, documentId: input.documentId, ownerKey: ownerKeyFor(ctx, c) },
          { storage: ctx.storage },
        );
        if (!result.providerMatched) {
          await transition(input.caseId, "FAILED", {
            reason: "PROVIDER_UNSUPPORTED",
            actor: actorFor(ctx),
          });
          return { status: "FAILED" as const, reason: "PROVIDER_UNSUPPORTED" as const };
        }
        const status =
          c.status === "DISCOVERY"
            ? (await transition(input.caseId, "PRE_FLIGHT_AUDIT", { actor: actorFor(ctx) })).to
            : c.status;
        return { status, confidence: result.confidence, recommendation: result.recommendation };
      },
    },
    {
      name: "accept-recommendation",
      budget: "write",
      confirm: false,
      statuses: ["PRE_FLIGHT_AUDIT"],
      input: caseIdSchema,
      handler: async (raw, ctx) => {
        const { caseId } = raw as { caseId: string };
        const move = await transition(caseId, "AWAITING_MANDATE", { actor: actorFor(ctx) });
        return { caseId, status: move.to };
      },
    },
    {
      name: "request-mandate",
      budget: "write",
      confirm: true,
      statuses: ["AWAITING_MANDATE"],
      input: requestMandateSchema.extend({ confirm: confirmField }),
      handler: async (raw, ctx) => {
        const input = raw as {
          caseId: string;
          actions: Array<"CANCEL_SERVICE" | "REQUEST_FINAL_BILL" | "ARRANGE_EQUIPMENT_RETURN">;
          maxFeeCents: number;
        };
        try {
          const { mandateId } = await requestMandate(
            { caseId: input.caseId, actions: input.actions, maxFeeCents: input.maxFeeCents },
            { userId: ctx.userId, orgIds: ctx.orgIds },
          );
          const [terms] = await db
            .select({ etfEstimateCents: contractTerms.etfEstimateCents })
            .from(contractTerms)
            .where(eq(contractTerms.caseId, input.caseId))
            .limit(1);
          return {
            mandateId,
            etfExceedsMaxFee: etfExceedsMandate(terms?.etfEstimateCents ?? null, input.maxFeeCents),
          };
        } catch (error) {
          toToolError(error);
        }
      },
    },
    {
      name: "approve-step",
      budget: "write",
      confirm: true,
      statuses: ["EXECUTING"],
      input: caseIdSchema.extend({
        stepId: z.uuid(),
        code: z.string().optional(),
        confirm: confirmField,
      }),
      handler: async (raw, ctx) => {
        const input = raw as { caseId: string; stepId: string; code?: string };
        const [step] = await db
          .select({ id: caseSteps.id })
          .from(caseSteps)
          .where(and(eq(caseSteps.id, input.stepId), eq(caseSteps.caseId, input.caseId)))
          .limit(1);
        if (!step) throw new ToolError("NOT_FOUND", "Step not found");
        try {
          const approved = await approveStep(
            { stepId: input.stepId, code: input.code },
            { userId: ctx.userId, orgIds: ctx.orgIds },
          );
          // The executor runs in-process from the approving request: the
          // newly approved step (and whatever follows it) runs now.
          await runNextStep(input.caseId, { actor: actorFor(ctx) });
          return approved;
        } catch (error) {
          toToolError(error);
        }
      },
    },
    {
      name: "draft-chat-reply",
      budget: "write",
      confirm: false,
      statuses: ["EXECUTING"],
      input: caseIdSchema.extend({ inboundText: z.string().min(1).max(4000) }),
      handler: async (raw, ctx, c) => {
        const input = raw as { caseId: string; inboundText: string };
        if (!c) throw new ToolError("NOT_FOUND", "Case not found");
        const redacted = await redact(db, input.inboundText, c.holderId);
        const result = await complete({
          tier: "contributor",
          messages: [
            { role: "system", content: DRAFT_SYSTEM, redacted: true },
            { role: "user", content: redacted, redacted: true },
          ],
          ownerKey: ownerKeyFor(ctx, c),
        });
        return { draft: result.text.trim() };
      },
    },
    {
      name: "record-receipt",
      budget: "write",
      confirm: true,
      statuses: ["EXECUTING", "RECEIPT_ACQUISITION"],
      input: caseIdSchema.extend({
        referenceCode: z.string().min(1).max(80),
        effectiveDate: dateSchema,
        finalBillEstimateCents: z.number().int().min(0).optional(),
        evidenceDocumentId: z.uuid().optional(),
        confirm: confirmField,
      }),
      handler: async (raw, ctx, c) => {
        const input = raw as {
          caseId: string;
          referenceCode: string;
          effectiveDate: string;
          finalBillEstimateCents?: number;
          evidenceDocumentId?: string;
        };
        if (!c) throw new ToolError("NOT_FOUND", "Case not found");
        if (input.evidenceDocumentId) {
          await requireCaseDocument(input.caseId, input.evidenceDocumentId);
        }
        const [existing] = await db
          .select({ caseId: receipts.caseId })
          .from(receipts)
          .where(eq(receipts.caseId, input.caseId))
          .limit(1);
        if (existing) throw new ToolError("VALIDATION", "A receipt is already recorded");
        try {
          await db.insert(receipts).values({
            caseId: input.caseId,
            referenceCode: input.referenceCode,
            effectiveDate: input.effectiveDate,
            finalBillEstimateCents: input.finalBillEstimateCents ?? null,
            evidenceDocumentId: input.evidenceDocumentId ?? null,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ToolError("VALIDATION", "A receipt is already recorded");
          }
          throw error;
        }
        const dueAt = new Date(`${input.effectiveDate}T00:00:00Z`);
        dueAt.setUTCDate(dueAt.getUTCDate() + 37);
        await db
          .insert(verifications)
          .values({ caseId: input.caseId, dueAt })
          .onConflictDoNothing();
        if (!isTerminalStatus(c.status) && c.status === "EXECUTING") {
          await transition(input.caseId, "RECEIPT_ACQUISITION", { actor: actorFor(ctx) });
        }
        const move = await transition(input.caseId, "AWAITING_VERIFICATION", {
          actor: actorFor(ctx),
        });
        return { caseId: input.caseId, status: move.to };
      },
    },
    {
      name: "report-bill-check",
      budget: "write",
      confirm: true,
      statuses: ["AWAITING_VERIFICATION"],
      input: caseIdSchema.extend({
        result: z.enum(["NO_REBILL", "REBILLED"]),
        documentId: z.uuid().optional(),
        confirm: confirmField,
      }),
      handler: async (raw, ctx) => {
        const input = raw as {
          caseId: string;
          result: "NO_REBILL" | "REBILLED";
          documentId?: string;
        };
        if (input.documentId) await requireCaseDocument(input.caseId, input.documentId);
        const [verification] = await db
          .select({ caseId: verifications.caseId })
          .from(verifications)
          .where(eq(verifications.caseId, input.caseId))
          .limit(1);
        if (!verification) throw new ToolError("VALIDATION", "No verification is pending");
        await db
          .update(verifications)
          .set({
            result: input.result,
            evidenceDocumentId: input.documentId ?? null,
            resolvedAt: ctx.now(),
          })
          .where(eq(verifications.caseId, input.caseId));
        const move = await transition(
          input.caseId,
          input.result === "NO_REBILL" ? "SUCCEEDED" : "DISPUTED",
          { actor: actorFor(ctx) },
        );
        return { caseId: input.caseId, status: move.to };
      },
    },
    {
      name: "withdraw-case",
      budget: "write",
      confirm: true,
      statuses: NON_TERMINAL_STATUSES,
      input: caseIdSchema.extend({ confirm: confirmField }),
      handler: async (raw, ctx) => {
        const { caseId } = raw as { caseId: string };
        const move = await transition(caseId, "WITHDRAWN", { actor: actorFor(ctx) });
        return { caseId, status: move.to };
      },
    },
  ];
}
