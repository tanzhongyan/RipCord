/** Domain codes the case engine and tools raise. All are 0000 contract codes. */
export type ToolErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFIRM_REQUIRED"
  | "PII_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "LIMIT_REACHED"
  | "PAYMENT_REQUIRED"
  | "ILLEGAL_TRANSITION"
  | "UNKNOWN_TOOL"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ToolError";
    this.code = code;
  }
}
