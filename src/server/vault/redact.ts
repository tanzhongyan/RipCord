/**
 * Pattern-only redaction: no database, no holder, safe to run on any string
 * (the server logger wraps every message with it). Known-secret replacement
 * lives in `./index.ts` and runs before this pass.
 */

const NRIC_RE = /\b[STFGM]\d{7}[A-Z]\b/g;
const PHONE_RE = /(?<![\d+])(?:\+65\s?)?[689]\d{3}\s?\d{4}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD_RE = /(?<!\d)(?:\d[\s-]?){12,18}\d(?!\d)/g;

/** Matches a full placeholder token so the pattern pass never touches one. */
const TOKEN_SPLIT_RE = /(\{\{vault:[A-Z_]+:[^}]*\}\})/g;

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

/**
 * Replace unknown PII with placeholders: NRIC/FIN, Singapore phones, emails
 * and Luhn-valid card-like runs. Placeholder tokens pass through untouched.
 */
export function redactPatterns(text: string): string {
  return text
    .split(TOKEN_SPLIT_RE)
    .map((part, index) => (index % 2 === 1 ? part : redactPatternsOnly(part)))
    .join("");
}
