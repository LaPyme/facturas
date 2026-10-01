import { ArcaInvalidSoapResponseError } from "../errors";

type ResponseIntegerOptions = {
  service: "wsfe" | "wsmtxca";
  operation: string;
  field: string;
  min: number;
  max: number;
};

/** Lee un entero decimal explícito sin truncar ni convertir otros tipos. */
export function parseResponseInteger(
  value: unknown,
  { service, operation, field, min, max }: ResponseIntegerOptions
): number {
  if (
    (typeof value === "string" || typeof value === "number") &&
    /^\d+$/.test(String(value).trim())
  ) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) {
      return parsed;
    }
  }
  throw new ArcaInvalidSoapResponseError(
    `Invalid ${service.toUpperCase()} ${field}`,
    { service, operation }
  );
}

/** Solo un campo ausente es opcional. null y los valores vacíos son inválidos. */
export function parseOptionalResponseInteger(
  value: unknown,
  options: ResponseIntegerOptions
): number | undefined {
  return value === undefined ? undefined : parseResponseInteger(value, options);
}
