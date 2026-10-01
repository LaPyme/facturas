import { parseResponseInteger } from "./response-integer";

/**
 * The last authorized number both services answer: an explicit decimal integer
 * from 0 to 99.999.999. Anything else is an invalid response, never a number
 * to increment.
 */
export function parseLastAuthorizedNumber(
  value: unknown,
  { service, operation }: { service: "wsfe" | "wsmtxca"; operation: string }
): number {
  return parseResponseInteger(value, {
    service,
    operation,
    field: "last authorized number",
    min: 0,
    max: 99_999_999,
  });
}
