import { and, eq } from "drizzle-orm";

import { writeAudit } from "~/server/audit";
import { db, type Transaction } from "~/server/db";
import {
  type auditLogs,
  caseSteps,
  cases,
  contractTerms,
  mandates,
  receipts,
  verifications,
} from "~/server/db/schema";
import { consumeCredit, refundCredit } from "./credits";
import { ToolError } from "./errors";
import { caseChannel, caseEvents } from "./events";

export type CaseStatus = typeof cases.$inferSelect.status;
export type CaseFailureReason = typeof cases.$inferSelect.failureReason;
export type TransitionActorType = typeof auditLogs.$inferInsert.actorType;

const TERMINAL_STATUSES: ReadonlySet<CaseStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "WITHDRAWN",
  "DISPUTED",
]);

export function isTerminalStatus(status: CaseStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const ALL_CASE_STATUSES: ReadonlyArray<CaseStatus> = [
  "DRAFT",
  "DISCOVERY",
  "PRE_FLIGHT_AUDIT",
  "AWAITING_MANDATE",
  "CHANNEL_PLANNING",
  "EXECUTING",
  "RECEIPT_ACQUISITION",
  "AWAITING_VERIFICATION",
  "SUCCEEDED",
  "FAILED",
  "WITHDRAWN",
  "DISPUTED",
];

export const NON_TERMINAL_STATUSES: ReadonlyArray<CaseStatus> = ALL_CASE_STATUSES.filter(
  (status) => !TERMINAL_STATUSES.has(status),
);

export interface TransitionActor {
  type: TransitionActorType;
  id: string;
}

export interface TransitionOpts {
  actor: TransitionActor;
  /**
   * The `failure_reason` for a move to `FAILED`. Required there, ignored
   * elsewhere.
   */
  reason?: string;
  now?: () => Date;
}

const DAY_MS = 86_400_000;

type CaseRow = typeof cases.$inferSelect;

/** Failure reasons each non-terminal status may move to `FAILED` with. */
function allowedFailureReasons(from: CaseStatus): ReadonlySet<string> {
  switch (from) {
    case "DISCOVERY":
      return new Set(["PROVIDER_UNSUPPORTED", "MANDATE_REVOKED"]);
    case "AWAITING_MANDATE":
      return new Set(["MANDATE_EXPIRED", "MANDATE_REVOKED"]);
    case "CHANNEL_PLANNING":
      return new Set(["NO_VIABLE_CHANNEL", "MANDATE_REVOKED"]);
    case "EXECUTING":
      return new Set(["PROVIDER_REFUSED", "TIMEOUT", "INTERNAL_ERROR", "MANDATE_REVOKED"]);
    default:
      // DRAFT, PRE_FLIGHT_AUDIT, RECEIPT_ACQUISITION, AWAITING_VERIFICATION:
      // only a revoked mandate fails the case out of band.
      return new Set(["MANDATE_REVOKED"]);
  }
}

async function guard(
  tx: Transaction,
  c: CaseRow,
  to: CaseStatus,
  reason: string | undefined,
  now: Date,
): Promise<void> {
  const illegal = (message: string): ToolError => new ToolError("ILLEGAL_TRANSITION", message);
  switch (`${c.status}->${to}`) {
    case "DRAFT->DISCOVERY": {
      await consumeCredit(tx, { userId: c.ownerUserId, orgId: c.orgId, caseId: c.id, now });
      return;
    }
    case "DISCOVERY->PRE_FLIGHT_AUDIT": {
      if (!c.providerId || !c.serviceType) {
        throw illegal("Provider and service must be identified first");
      }
      return;
    }
    case "PRE_FLIGHT_AUDIT->AWAITING_MANDATE": {
      const [terms] = await tx
        .select({ caseId: contractTerms.caseId })
        .from(contractTerms)
        .where(eq(contractTerms.caseId, c.id))
        .limit(1);
      if (!terms) throw illegal("Contract terms are missing");
      return;
    }
    case "AWAITING_MANDATE->CHANNEL_PLANNING": {
      const [active] = await tx
        .select({ id: mandates.id })
        .from(mandates)
        .where(and(eq(mandates.caseId, c.id), eq(mandates.status, "ACTIVE")))
        .limit(1);
      if (!active) throw illegal("The mandate is not active");
      return;
    }
    case "CHANNEL_PLANNING->EXECUTING": {
      if (!c.chosenChannelId) throw illegal("No channel was chosen");
      const [step] = await tx
        .select({ id: caseSteps.id })
        .from(caseSteps)
        .where(eq(caseSteps.caseId, c.id))
        .limit(1);
      if (!step) throw illegal("No plan was saved");
      return;
    }
    case "EXECUTING->RECEIPT_ACQUISITION":
    case "EXECUTING->CHANNEL_PLANNING":
      return;
    case "RECEIPT_ACQUISITION->AWAITING_VERIFICATION": {
      const [receipt] = await tx
        .select({ caseId: receipts.caseId })
        .from(receipts)
        .where(eq(receipts.caseId, c.id))
        .limit(1);
      if (!receipt) throw illegal("The receipt is missing");
      await tx
        .update(mandates)
        .set({ status: "CONSUMED" })
        .where(and(eq(mandates.caseId, c.id), eq(mandates.status, "ACTIVE")));
      return;
    }
    case "AWAITING_VERIFICATION->SUCCEEDED": {
      const [verification] = await tx
        .select()
        .from(verifications)
        .where(eq(verifications.caseId, c.id))
        .limit(1);
      if (!verification?.result) throw illegal("The bill check is not reported yet");
      if (verification.result === "NO_REBILL") return;
      if (
        verification.result === "UNKNOWN" &&
        now.getTime() >= verification.dueAt.getTime() + 30 * DAY_MS
      ) {
        return;
      }
      throw illegal("The bill check does not allow success");
    }
    case "AWAITING_VERIFICATION->DISPUTED": {
      const [verification] = await tx
        .select({ result: verifications.result })
        .from(verifications)
        .where(eq(verifications.caseId, c.id))
        .limit(1);
      // The dispute package rides with the 0005 executor; the rebill verdict
      // is the 0004 half of the guard.
      if (verification?.result !== "REBILLED") throw illegal("The bill was not rebilled");
      return;
    }
    default:
      break;
  }

  if (to === "WITHDRAWN" && !isTerminalStatus(c.status)) return;
  if (to === "FAILED" && !isTerminalStatus(c.status) && reason) {
    if (!allowedFailureReasons(c.status).has(reason)) {
      throw illegal(`Cannot fail a ${c.status} case with ${reason}`);
    }
    await refundCredit(tx, { userId: c.ownerUserId, orgId: c.orgId, caseId: c.id, reason });
    return;
  }
  if (to === "FAILED" && !reason) throw illegal("A failure reason is required");
  throw illegal(`Cannot move a case from ${c.status} to ${to}`);
}

/**
 * The only code that writes `cases.status`. It checks the 0000 lifecycle
 * table, runs the move and its guard in one transaction, writes one
 * `audit_logs` row, and publishes the move on the Valkey channel `case:<id>`
 * for live UI updates.
 */
export async function transition(
  caseId: string,
  to: CaseStatus,
  opts: TransitionOpts,
): Promise<{ from: CaseStatus; to: CaseStatus }> {
  const now = (opts.now ?? (() => new Date()))();
  const from = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(cases).where(eq(cases.id, caseId)).for("update").limit(1);
    if (!c) throw new ToolError("NOT_FOUND", "Case not found");
    await guard(tx, c, to, opts.reason, now);
    await tx
      .update(cases)
      .set({
        status: to,
        failureReason: to === "FAILED" ? (opts.reason as CaseFailureReason) : null,
        executionPhase: to === "EXECUTING" ? "CONTACTING" : null,
        closedAt: isTerminalStatus(to) ? now : null,
      })
      .where(eq(cases.id, caseId));
    await writeAudit(tx, {
      actorType: opts.actor.type,
      actorId: opts.actor.id,
      action: "CASE_TRANSITION",
      targetType: "case",
      targetId: caseId,
      caseId,
      metadata: { from: c.status, to, ...(opts.reason ? { reason: opts.reason } : {}) },
    });
    return c.status;
  });

  await caseEvents().publish(
    caseChannel(caseId),
    JSON.stringify({ caseId, from, to, at: now.toISOString() }),
  );
  return { from, to };
}
