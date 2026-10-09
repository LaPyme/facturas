import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatConditionLegend,
  formatDate,
  formatDecimal,
  formatMoney,
  formatQuantity,
  formatTaxId,
  formatTitle,
  formatVatRate,
} from "./format";

describe("es-AR formatting", () => {
  it("formats minor units without floating point", () => {
    expect(formatAmount(0)).toBe("0,00");
    expect(formatAmount(5)).toBe("0,05");
    expect(formatAmount(123_456_789)).toBe("1.234.567,89");
    expect(formatAmount(-1050)).toBe("-10,50");
    expect(formatAmount(900_719_925_474_099)).toBe("9.007.199.254.740,99");
    expect(formatMoney(123_420, "PES")).toBe("$ 1.234,20");
    expect(formatMoney(100, "DOL")).toBe("USD 1,00");
    expect(formatMoney(100, "060")).toBe("060 1,00");
    expect(formatMoney(-1200, "PES")).toBe("-$ 12,00");
  });

  it("formats unit prices, quantities, dates, CUITs and rates", () => {
    expect(formatDecimal("605")).toBe("605,00");
    expect(formatDecimal("1234.5")).toBe("1.234,50");
    expect(formatDecimal("0.123456")).toBe("0,123456");
    expect(formatQuantity(1.5)).toBe("1,5");
    expect(formatDate("2026-09-05")).toBe("05/09/2026");
    expect(formatTaxId("20123456789")).toBe("20-12345678-9");
    expect(formatTaxId("30111222")).toBe("30111222");
    expect(formatVatRate(10.5)).toBe("10,5%");
    expect(formatVatRate("exempt")).toBe("Exento");
    expect(formatVatRate("untaxed")).toBe("No gravado");
  });

  it("writes VAT condition legends as ARCA prints them", () => {
    expect(formatConditionLegend("IVA RESPONSABLE INSCRIPTO")).toBe(
      "IVA Responsable Inscripto"
    );
    expect(formatConditionLegend("A CONSUMIDOR FINAL")).toBe(
      "A Consumidor Final"
    );
    expect(formatConditionLegend("PROVEEDOR DEL EXTERIOR")).toBe(
      "Proveedor del Exterior"
    );
    expect(formatConditionLegend("IVA LIBERADO - LEY Nº 19.640")).toBe(
      "IVA Liberado - Ley Nº 19.640"
    );
  });

  it("writes the voucher title in sentence case", () => {
    expect(formatTitle("FACTURA")).toBe("Factura");
    expect(formatTitle("NOTA DE DÉBITO")).toBe("Nota de débito");
    expect(formatTitle("NOTA DE CRÉDITO")).toBe("Nota de crédito");
  });
});
