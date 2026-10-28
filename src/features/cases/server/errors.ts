/** Domain codes the case engine and tools raise. All are 0000 contract codes. */
export type ToolErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFIRM_REQUIRED"
  | "PII_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "LIMIT_REACHED"
  | "PAYMENT_REQUIRED"
  | "MODEL_BUDGET_EXCEEDED"
  | "ILLEGAL_TRANSITION"
  | "UNKNOWN_TOOL"
  | "VAULT_RELEASE_DENIED"
  | "SANDBOX_DESTINATION_BLOCKED"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** Extra payload, for example the one-line summary on `CONFIRM_REQUIRED`. */
  readonly details: unknown;

  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}
