import { describe, expect, it } from "vitest";
import {
  ARCA_CONCEPT_TYPES,
  ARCA_CURRENCY_IDS,
  ARCA_DOCUMENT_TYPES,
  ARCA_RECEIVER_VAT_CONDITIONS,
  ARCA_VAT_RATES,
  ARCA_VOUCHER_TYPES,
  ISO_CURRENCIES,
} from "./constants";

describe("constants", () => {
  it("exports representative WSFE reference values", () => {
    expect(ARCA_VOUCHER_TYPES).toMatchObject({
      FACTURA_A: 1,
      FACTURA_B: 6,
      FACTURA_C: 11,
      NOTA_CREDITO_A: 3,
      NOTA_CREDITO_B: 8,
      NOTA_CREDITO_C: 13,
      NOTA_DEBITO_C: 12,
    });
    expect(ARCA_DOCUMENT_TYPES).toMatchObject({
      CUIT: 80,
      DNI: 96,
      CONSUMIDOR_FINAL: 99,
    });
    expect(ARCA_RECEIVER_VAT_CONDITIONS).toEqual({
      RESPONSABLE_INSCRIPTO: 1,
      EXENTO: 4,
      CONSUMIDOR_FINAL: 5,
      MONOTRIBUTISTA: 6,
      IVA_NO_ALCANZADO: 15,
    });
    expect(ARCA_CONCEPT_TYPES).toMatchObject({
      PRODUCTOS: 1,
      SERVICIOS: 2,
      PRODUCTOS_Y_SERVICIOS: 3,
    });
    expect(ARCA_VAT_RATES).toMatchObject({
      IVA_0: 3,
      IVA_10_5: 4,
      IVA_21: 5,
      IVA_27: 6,
      IVA_5: 8,
      IVA_2_5: 9,
    });
    expect(ISO_CURRENCIES).toEqual({ ARS: "ARS", USD: "USD" });
    expect(ARCA_CURRENCY_IDS).toEqual({ ARS: "PES", USD: "DOL" });
  });
});
