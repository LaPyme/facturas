import { describe, expect, it } from "vitest";
import { describeTaxIdProblem, isValidTaxId, normalizeTaxId } from "./cuit";

/**
 * Public CUIT, verified against ARCA's own constancia de inscripción. They are
 * here because the módulo 11 rule has to be checked against numbers ARCA
 * actually issued, not against numbers this file made up.
 */
const REAL = [
  "33693450239", // ARCA (ex AFIP)
  "30703088534", // MercadoLibre S.R.L.
  "30500010912", // Banco de la Nación Argentina
  "20123456786", // the sample CUIT the docs use
];

describe("isValidTaxId", () => {
  it("accepts CUIT that ARCA issued", () => {
    for (const taxId of REAL) {
      expect(isValidTaxId(taxId)).toBe(true);
    }
  });

  it("accepts the same numbers written with hyphens or spaces", () => {
    expect(isValidTaxId("33-69345023-9")).toBe(true);
    expect(isValidTaxId("30 70308853 4")).toBe(true);
    expect(isValidTaxId("  20123456786  ")).toBe(true);
  });

  it("rejects every other check digit for a valid CUIT", () => {
    for (const taxId of REAL) {
      const wrong = Array.from(
        { length: 10 },
        (_unused, digit) => `${taxId.slice(0, 10)}${digit}`
      ).filter((candidate) => candidate !== taxId);

      for (const candidate of wrong) {
        expect(isValidTaxId(candidate)).toBe(false);
      }
    }
  });

  it("rejects a remainder of one, which ARCA reissues under prefix 23", () => {
    // 2000000001x: the weighted sum is 12, so 11 - (12 % 11) would be 10.
    for (let digit = 0; digit < 10; digit += 1) {
      expect(isValidTaxId(`2000000001${digit}`)).toBe(false);
    }
  });
});

describe("describeTaxIdProblem", () => {
  it("says nothing about a valid one", () => {
    expect(describeTaxIdProblem("20123456786")).toBeUndefined();
  });

  it("counts the digits it got", () => {
    expect(describeTaxIdProblem("2012345678")).toBe(
      "CUIT inválido: 2012345678 tiene 10 dígitos y necesita 11."
    );
    expect(describeTaxIdProblem("201234567860")).toBe(
      "CUIT inválido: 201234567860 tiene 12 dígitos y necesita 11."
    );
    expect(describeTaxIdProblem("2")).toBe(
      "CUIT inválido: 2 tiene 1 dígito y necesita 11."
    );
  });

  it("counts the digits after dropping the hyphens", () => {
    expect(describeTaxIdProblem("20-1234567-8")).toBe(
      "CUIT inválido: 2012345678 tiene 10 dígitos y necesita 11."
    );
  });

  it("names the check digit when the length is right", () => {
    expect(describeTaxIdProblem("20123456789")).toBe(
      "CUIT inválido: 20123456789 no pasa el dígito verificador."
    );
    expect(describeTaxIdProblem("33-69345023-1")).toBe(
      "CUIT inválido: 33693450231 no pasa el dígito verificador."
    );
  });

  it("names what is not a digit, as the user typed it", () => {
    expect(describeTaxIdProblem("20abc456786")).toBe(
      "CUIT inválido: 20abc456786 tiene caracteres que no son dígitos."
    );
    expect(describeTaxIdProblem(" CUIT 20123456786 ")).toBe(
      "CUIT inválido: CUIT 20123456786 tiene caracteres que no son dígitos."
    );
  });
});

describe("normalizeTaxId", () => {
  it("keeps only what ARCA stores", () => {
    expect(normalizeTaxId("20-12345678-6")).toBe("20123456786");
    expect(normalizeTaxId(" 20 12345678 6 ")).toBe("20123456786");
    expect(normalizeTaxId("20.12345678.6")).toBe("20123456786");
  });
});
