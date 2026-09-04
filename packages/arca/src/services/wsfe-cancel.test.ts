import { describe, expect, it } from "vitest";
import { normalizeWsfeVoucherInput, type WsfeVoucherInfo } from "./wsfe";
import { deriveWsfeCancellation } from "./wsfe-cancel";
import { deriveWsfeInvoice, type IssueInput } from "./wsfe-derive";

function original(input: IssueInput): WsfeVoucherInfo {
  const data = deriveWsfeInvoice(input).data;
  return {
    ...data,
    documentNumber: String(data.documentNumber),
    exchangeRate: Number(data.exchangeRate),
    voucherNumber: 1,
    result: "A",
    cae: "123",
    caeExpiry: "20260914",
    raw: {},
  };
}
const invoice = original({
  issuer: "responsable_inscripto",
  salesPoint: 1,
  date: "20260904",
  to: { condition: "consumidor_final" },
  items: [
    { net: 10_000, vat: 21 },
    { net: 10_000, vat: 10.5 },
    { net: 200, vat: "exempt" },
    { net: 300, vat: "untaxed" },
  ],
});
describe("full cancellation derivation", () => {
  it.each([
    [1, 3, "A"],
    [6, 8, "B"],
    [11, 13, "C"],
  ] as const)("maps %s to %s", (voucherType, type, voucherClass) => {
    const data =
      voucherType === 11
        ? original({
            issuer: "monotributo",
            salesPoint: 1,
            date: "20260904",
            to: { condition: "consumidor_final" },
            items: [{ amount: 100 }],
          })
        : { ...invoice, voucherType };
    const result = deriveWsfeCancellation(data, "20260905");
    expect(result.voucherClass).toBe(voucherClass);
    expect(result.data.voucherType).toBe(type);
    expect(result.data.associatedVouchers).toEqual([
      { type: voucherType, salesPoint: 1, number: 1, voucherDate: "20260904" },
    ]);
    normalizeWsfeVoucherInput(result.data);
  });
  it("copies all monetary fields and VAT details without rounding", () => {
    const { data } = deriveWsfeCancellation(invoice, "20260905");
    for (const field of [
      "totalAmount",
      "netAmount",
      "vatAmount",
      "nonTaxableAmount",
      "exemptAmount",
      "taxAmount",
      "vatRates",
      "currencyId",
      "exchangeRate",
      "documentType",
      "receiverVatConditionId",
    ] as const) {
      expect(data[field]).toEqual(invoice[field]);
    }
    expect(data.vatRates).not.toBe(invoice.vatRates);
  });
  it.each([
    2, 3,
  ])("preserves service dates and raises due date for concept %s", (concept) => {
    const service = {
      ...invoice,
      concept,
      serviceStartDate: "20260901",
      serviceEndDate: "20260904",
      paymentDueDate: "20260904",
    };
    const { data } = deriveWsfeCancellation(service, "20260905");
    expect(data).toMatchObject({
      concept,
      serviceStartDate: "20260901",
      serviceEndDate: "20260904",
      paymentDueDate: "20260905",
    });
    expect(
      deriveWsfeCancellation(
        { ...service, paymentDueDate: "20260930" },
        "20260905"
      ).data.paymentDueDate
    ).toBe("20260930");
  });
  it.each([
    ["taxes", "Tributos"],
    ["optionalFields", "Opcionales"],
    ["buyers", "Compradores"],
    ["activities", "Actividades"],
    ["associatedPeriod", "PeriodoAsoc"],
  ])("rejects unsupported %s", (field, rawField) => {
    expect(() =>
      deriveWsfeCancellation(
        { ...invoice, raw: { [rawField]: { value: 1 } } },
        "20260905"
      )
    ).toThrow(field);
    expect(() =>
      deriveWsfeCancellation(
        { ...invoice, [field]: [{ value: 1 }] },
        "20260905"
      )
    ).toThrow("wsfe.authorizeVoucherOutcome()");
  });
  it("rejects missing required evidence and unsupported originals", () => {
    for (const change of [
      { result: "R" },
      { voucherType: 8 },
      { currencyId: "060" },
      { cae: undefined },
      { receiverVatConditionId: undefined },
      { taxAmount: 1 },
    ]) {
      expect(() =>
        deriveWsfeCancellation({ ...invoice, ...change }, "20260905")
      ).toThrow();
    }
    expect(() =>
      deriveWsfeCancellation({ ...invoice, concept: 2 }, "20260905")
    ).toThrow("serviceStartDate");
  });
  it("uses Buenos Aires date and respects association date rules", () => {
    expect(
      deriveWsfeCancellation(
        invoice,
        undefined,
        new Date("2026-09-06T01:00:00Z")
      ).data.voucherDate
    ).toBe("20260905");
    expect(() => deriveWsfeCancellation(invoice, "20260831")).toThrow("10210");
    expect(deriveWsfeCancellation(invoice, "20260903").data.voucherDate).toBe(
      "20260903"
    );
  });
});
