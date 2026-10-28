import { redactPatterns } from "./vault/redact";

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return redactPatterns(value);
  if (value instanceof Error) {
    const scrubbed = new Error(redactPatterns(value.message));
    scrubbed.name = value.name;
    if (value.stack) scrubbed.stack = redactPatterns(value.stack);
    return scrubbed;
  }
  return value;
}

/**
 * Server logger. Every string and Error passes pattern-only redaction before
 * it reaches the console, so NRICs, phones, emails and card numbers never
 * land in logs. Callers must still keep bodies and query strings out of log
 * calls entirely: redaction is a backstop, not a licence to log requests.
 */
export const logger = {
  debug: (...args: unknown[]): void => {
    console.debug(...args.map(scrubValue));
  },
  info: (...args: unknown[]): void => {
    console.info(...args.map(scrubValue));
  },
  warn: (...args: unknown[]): void => {
    console.warn(...args.map(scrubValue));
  },
  error: (...args: unknown[]): void => {
    console.error(...args.map(scrubValue));
  },
};
