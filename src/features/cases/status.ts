import type { caseStatus } from "~/server/db/schema";

type CaseStatus = (typeof caseStatus.enumValues)[number];

/** The one status-to-label map: badges, the case page and stories all read it. */
export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  DRAFT: "Draft",
  DISCOVERY: "Discovery",
  PRE_FLIGHT_AUDIT: "Pre-flight audit",
  AWAITING_MANDATE: "Awaiting mandate",
  CHANNEL_PLANNING: "Channel planning",
  EXECUTING: "Executing",
  RECEIPT_ACQUISITION: "Receipt acquisition",
  AWAITING_VERIFICATION: "Awaiting verification",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  WITHDRAWN: "Withdrawn",
  DISPUTED: "Disputed",
};

/** Plain-words label for a status; an unknown value shows as given. */
export function statusLabel(status: string): string {
  return (CASE_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** Why a case failed, in plain words (data contract `failure_reason`). */
const FAILURE_REASONS: Record<string, string> = {
  PROVIDER_UNSUPPORTED: "We do not support this provider yet. Your credit was refunded.",
  NO_VIABLE_CHANNEL: "We could not find a way to reach this provider. Your credit was refunded.",
  MANDATE_EXPIRED: "The account holder did not sign in time.",
  MANDATE_REVOKED: "The account holder withdrew their permission.",
  PROVIDER_REFUSED: "The provider refused the request.",
  TIMEOUT: "The case ran out of time before it finished.",
  INTERNAL_ERROR: "Something went wrong on our side. Your credit was refunded.",
};

export function failureReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return FAILURE_REASONS[reason] ?? reason;
}
