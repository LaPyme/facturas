import { describe, expect, it } from "vitest";
import { ArcaInvalidSoapResponseError } from "../errors";
import {
  parseOptionalResponseInteger,
  parseResponseInteger,
} from "./response-integer";

const options = {
  service: "wsmtxca" as const,
  operation: "consultarComprobante",
  field: "numeroComprobante",
  min: 1,
  max: 99_999_999,
};

describe("enteros explícitos en respuestas SOAP", () => {
  it.each([
    [1, 1],
    ["00012", 12],
    [" 12 ", 12],
    [99_999_999, 99_999_999],
    ["99999999", 99_999_999],
  ])("acepta %s sin perder su valor", (value, expected) => {
    expect(parseResponseInteger(value, options)).toBe(expected);
    expect(parseOptionalResponseInteger(value, options)).toBe(expected);
  });

  it.each([
    null,
    "",
    "   ",
    true,
    false,
    0,
    "0",
    -1,
    "-1",
    "+1",
    1.5,
    "1.5",
    "12abc",
    "1e2",
    "0x10",
    "1 2",
    100_000_000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    [],
    [12],
    {},
  ])("rechaza el valor presente %j", (value) => {
    expect(() => parseOptionalResponseInteger(value, options)).toThrow(
      ArcaInvalidSoapResponseError
    );
    expect(() => parseResponseInteger(value, options)).toThrow(
      expect.objectContaining({
        message: "Invalid WSMTXCA numeroComprobante",
        service: "wsmtxca",
        operation: "consultarComprobante",
      })
    );
  });

  it("distingue la ausencia de un valor mal formado", () => {
    expect(parseOptionalResponseInteger(undefined, options)).toBeUndefined();
    expect(() => parseResponseInteger(undefined, options)).toThrow(
      ArcaInvalidSoapResponseError
    );
  });

  it("admite cero solo cuando el dominio lo permite y exige enteros seguros", () => {
    const catalogOptions = { ...options, min: 0, max: Number.MAX_SAFE_INTEGER };
    expect(parseResponseInteger("0", catalogOptions)).toBe(0);
    expect(parseResponseInteger(Number.MAX_SAFE_INTEGER, catalogOptions)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(() =>
      parseResponseInteger("9007199254740992", {
        ...catalogOptions,
        max: Number.POSITIVE_INFINITY,
      })
    ).toThrow(ArcaInvalidSoapResponseError);
  });
});
