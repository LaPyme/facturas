import { describe, expect, it } from "vitest";
import {
  arcaMinorUnitsToNumber,
  assertArcaMinorUnits,
  calculateVatMinorUnits,
  isWithinArcaTolerance,
  normalizeArcaAmountToMinorUnits,
  roundHalfEvenRatio,
  type SupportedVatRate,
  serializeArcaAmount,
  serializeArcaExchangeRate,
  serializeArcaMinorUnits,
} from "./decimal";

describe("ARCA decimal helpers", () => {
  it("normalizes harmless binary noise and preserves exact cents", () => {
    expect(serializeArcaAmount(0.1 + 0.2, "totalAmount")).toBe("0.30");
    expect(serializeArcaAmount(1234.56, "totalAmount")).toBe("1234.56");
    expect(normalizeArcaAmountToMinorUnits(1234.56, "totalAmount")).toBe(
      123_456n
    );
  });

  it("rejects materially over-precise and invalid money values", () => {
    expect(() => serializeArcaAmount(259.2576, "totalAmount")).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_AMOUNT_PRECISION",
        field: "totalAmount",
      })
    );

    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => serializeArcaAmount(value, "totalAmount")).toThrowError(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_AMOUNT",
          field: "totalAmount",
        })
      );
    }

    expect(() =>
      serializeArcaAmount(Number.MAX_SAFE_INTEGER + 1, "totalAmount")
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_AMOUNT" })
    );
    expect(() =>
      serializeArcaAmount(10_000_000_000_000, "totalAmount")
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_AMOUNT" })
    );
    expect(() =>
      assertArcaMinorUnits(1_000_000_000_000_000, "amount")
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_AMOUNT" })
    );
    expect(() =>
      assertArcaMinorUnits(Number.MAX_SAFE_INTEGER + 1, "amount")
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_AMOUNT" })
    );
  });

  it.each([
    [0, 10_000n, 0n],
    [2.5, 10_000n, 250n],
    [5, 10_000n, 500n],
    [10.5, 10_000n, 1050n],
    [21, 10_000n, 2100n],
    [27, 10_000n, 2700n],
  ] as const)(
    "calculates %s%% VAT with integer basis points",
    (rate, net, vat) => {
      expect(calculateVatMinorUnits(net, rate, "vatRate")).toBe(vat);
    }
  );

  it("rounds exact half-cent VAT boundaries to the even cent", () => {
    expect(calculateVatMinorUnits(10n, 5, "vatRate")).toBe(0n);
    expect(calculateVatMinorUnits(30n, 5, "vatRate")).toBe(2n);
    expect(calculateVatMinorUnits(50n, 21, "vatRate")).toBe(10n);
    expect(calculateVatMinorUnits(150n, 21, "vatRate")).toBe(32n);
    expect(calculateVatMinorUnits(49n, 21, "vatRate")).toBe(10n);
    expect(calculateVatMinorUnits(51n, 21, "vatRate")).toBe(11n);
  });

  it.each([
    [0n, 4n, 0n],
    [2n, 4n, 0n],
    [6n, 4n, 2n],
    [10n, 4n, 2n],
    [14n, 4n, 4n],
    [7n, 4n, 2n],
    [9n, 4n, 2n],
    [11n, 4n, 3n],
  ] as const)(
    "roundHalfEvenRatio(%s, %s) = %s",
    (numerator, denominator, expected) => {
      expect(roundHalfEvenRatio(numerator, denominator)).toBe(expected);
    }
  );

  it("rejects an invalid ratio", () => {
    expect(() => roundHalfEvenRatio(-1n, 4n)).toThrowError(RangeError);
    expect(() => roundHalfEvenRatio(1n, 0n)).toThrowError(RangeError);
  });

  it("rejects unsupported VAT rates", () => {
    expect(() =>
      calculateVatMinorUnits(10_000n, 19 as SupportedVatRate, "vatRate")
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "vatRate",
      })
    );
  });

  it("validates and canonicalizes exchange rates", () => {
    expect(serializeArcaExchangeRate("1.234567", "exchangeRate")).toBe(
      "1.234567"
    );
    expect(serializeArcaExchangeRate("1095.500000", "exchangeRate")).toBe(
      "1095.5"
    );
    expect(serializeArcaExchangeRate(1095.5, "exchangeRate")).toBe("1095.5");

    for (const value of ["0", "1.2345678", "10000", 0]) {
      expect(() =>
        serializeArcaExchangeRate(value, "exchangeRate")
      ).toThrowError(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_EXCHANGE_RATE",
          field: "exchangeRate",
        })
      );
    }
  });

  it("converts safe builder minor units and applies ARCA tolerances", () => {
    expect(serializeArcaMinorUnits(12_345, "amount")).toBe("123.45");
    expect(arcaMinorUnitsToNumber(12_345n, "amount")).toBe(123.45);
    expect(assertArcaMinorUnits(12_345, "amount")).toBe(12_345n);
    expect(isWithinArcaTolerance(10_001n, 10_000n)).toBe(true);
    expect(isWithinArcaTolerance(10_002n, 10_000n)).toBe(false);
    expect(isWithinArcaTolerance(20_002n, 20_000n, 2)).toBe(true);
  });
});
