/**
 * Pattern-only redaction: no database, no holder, safe to run on any string
 * (the server logger wraps every message with it). Known-secret replacement
 * lives in `./index.ts` and runs before this pass.
 */

const NRIC_RE = /\b[STFGM]\d{7}[A-Z]\b/g;
const PHONE_RE = /(?<![\d+])(?:\+65\s?)?[689]\d{3}\s?\d{4}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD_RE = /(?<!\d)(?:\d[\s-]?){12,18}\d(?!\d)/g;

/**
 * Matches a vault placeholder token or a UUID so the pattern pass never
 * touches either. Random ids can hold digit runs that look like a phone
 * number or a Luhn-valid card number; real PII is never UUID-shaped, so
 * skipping them only removes false hits. Odd split indexes are skipped.
 */
const SKIP_SPLIT_RE =
  /(\{\{vault:[A-Z_]+:[^}]*\}\}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits.charAt(i));
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactCardRuns(text: string): string {
  return text.replace(CARD_RE, (match) => {
    const digits = match.replace(/[\s-]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    return luhn(digits) ? "[CARD]" : match;
  });
}

function redactPatternsOnly(text: string): string {
  return redactCardRuns(
    text.replace(NRIC_RE, "[NRIC]").replace(PHONE_RE, "[PHONE]").replace(EMAIL_RE, "[EMAIL]"),
  );
}

function containsCardRun(text: string): boolean {
  CARD_RE.lastIndex = 0;
  for (const match of text.matchAll(CARD_RE)) {
    const digits = match[0].replace(/[\s-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function containsStrongPiiText(text: string): boolean {
  NRIC_RE.lastIndex = 0;
  PHONE_RE.lastIndex = 0;
  return NRIC_RE.test(text) || PHONE_RE.test(text) || containsCardRun(text);
}

/**
 * True when the value holds an NRIC/FIN, a full phone number or a
 * Luhn-valid card number. The tool input guard (spec 0004) uses this: emails
 * are redacted elsewhere but do not trip the guard. Placeholder tokens and
 * UUIDs are skipped, so vaulted values and random ids never trip it.
 */
export function containsStrongPii(value: unknown): boolean {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text
    .split(SKIP_SPLIT_RE)
    .some((part, index) => index % 2 === 0 && containsStrongPiiText(part));
}

/**
 * Replace unknown PII with placeholders: NRIC/FIN, Singapore phones, emails
 * and Luhn-valid card-like runs. Placeholder tokens pass through untouched.
 */
export function redactPatterns(text: string): string {
  return text
    .split(SKIP_SPLIT_RE)
    .map((part, index) => (index % 2 === 1 ? part : redactPatternsOnly(part)))
    .join("");
}
