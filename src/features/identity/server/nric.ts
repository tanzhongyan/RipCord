const NRIC_RE = /^[STFGM]\d{7}[A-Z]$/;
const WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
const OFFSETS: Record<string, number> = { S: 0, T: 4, F: 0, G: 4, M: 3 };
const ST_TABLE = "JZIHGFEDCBA";
const FG_TABLE = "XWUTRQPNMLK";
const M_TABLE = "XWUTRQPNJLK";

/**
 * Validate an NRIC/FIN: format `^[STFGM]\d{7}[A-Z]$` plus the mod-11 checksum
 * (weights 2,7,6,5,4,3,2; offsets S=0, T=4, F=0, G=4, M=3).
 */
export function isValidNric(value: string): boolean {
  if (!NRIC_RE.test(value)) return false;
  const prefix = value.charAt(0);
  let sum = OFFSETS[prefix] ?? 0;
  const digits = value.slice(1, 8);
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits.charAt(i)) * (WEIGHTS[i] ?? 0);
  }
  const table = prefix === "S" || prefix === "T" ? ST_TABLE : prefix === "M" ? M_TABLE : FG_TABLE;
  return value.charAt(8) === table.charAt(sum % 11);
}
