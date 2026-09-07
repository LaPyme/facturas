/**
 * CUIT validation for the CLI, so a wrong number is named as wrong instead of
 * being reported as missing. The SDK keeps its own, looser rule: it only asks
 * for eleven digits, and it is ARCA that decides whether a CUIT exists.
 */

/** The weights ARCA applies to the first ten digits, in order. */
const CHECK_DIGIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const TAX_ID_LENGTH = 11;
const MODULUS = 11;
const SEPARATORS = /[\s.-]/g;

/** What to do about a CUIT the CLI rejected. One line, same everywhere. */
export const TAX_ID_FIX =
  "Son 11 dígitos y el último es el verificador; podés escribirlo con guiones.";

/** Drops the separators people type: `20-12345678-6` and `20 12345678 6`. */
export function normalizeTaxId(raw: string): string {
  return raw.trim().replace(SEPARATORS, "");
}

/**
 * Why this CUIT cannot be used, or `undefined` when it is a well-formed one.
 * An empty value is reported as eleven digits missing; callers that can tell
 * "missing" from "wrong" should check for emptiness before calling.
 */
export function describeTaxIdProblem(raw: string): string | undefined {
  const digits = normalizeTaxId(raw);
  if (!/^\d*$/.test(digits)) {
    return `CUIT inválido: ${raw.trim()} tiene caracteres que no son dígitos.`;
  }
  if (digits.length !== TAX_ID_LENGTH) {
    const plural = digits.length === 1 ? "dígito" : "dígitos";
    return `CUIT inválido: ${digits} tiene ${digits.length} ${plural} y necesita ${TAX_ID_LENGTH}.`;
  }
  if (!hasValidCheckDigit(digits)) {
    return `CUIT inválido: ${digits} no pasa el dígito verificador.`;
  }
  return undefined;
}

/** True when the CUIT is well formed. Says nothing about it existing in ARCA. */
export function isValidTaxId(raw: string): boolean {
  return describeTaxIdProblem(raw) === undefined;
}

/**
 * The módulo 11 rule ARCA uses: the first ten digits weighted by
 * `5 4 3 2 7 6 5 4 3 2`, and the check digit is `11 - (suma % 11)`. A
 * remainder of 0 leaves 11, which is written as 0. A remainder of 1 would
 * need a 10, which is not a digit: ARCA issues those numbers under another
 * prefix (23) instead, so no real CUIT has one.
 */
function hasValidCheckDigit(digits: string): boolean {
  const sum = CHECK_DIGIT_WEIGHTS.reduce(
    (total, weight, index) => total + weight * Number(digits[index]),
    0
  );
  const remainder = sum % MODULUS;
  if (remainder === 1) {
    return false;
  }
  const expected = remainder === 0 ? 0 : MODULUS - remainder;
  return expected === Number(digits[TAX_ID_LENGTH - 1]);
}
