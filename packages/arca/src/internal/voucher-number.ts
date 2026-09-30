import { ArcaInvalidSoapResponseError } from "../errors";

/**
 * The last authorized number both services answer: an explicit decimal integer
 * from 0 to 99.999.999. Anything else is an invalid response, never a number
 * to increment.
 */
export function parseLastAuthorizedNumber(
  value: unknown,
  { service, operation }: { service: "wsfe" | "wsmtxca"; operation: string }
): number {
  // Digits only, so the parsed number is already a non-negative integer.
  if (
    (typeof value === "string" || typeof value === "number") &&
    /^\d+$/.test(String(value).trim()) &&
    Number(value) <= 99_999_999
  ) {
    return Number(value);
  }
  throw new ArcaInvalidSoapResponseError(
    `Invalid ${service.toUpperCase()} last authorized number`,
    { service, operation }
  );
}
