import { describe, expect, it } from "vitest";
import { describeVoucherType, validateFiscalHeader } from "./issuance-fields";
import type { WsfeVoucherInput } from "./wsfe";

describe("describeVoucherType", () => {
  it.each([
    [1, { family: "ordinary", voucherClass: "A", kind: "invoice" }],
    [7, { family: "ordinary", voucherClass: "B", kind: "debit_note" }],
    [13, { family: "ordinary", voucherClass: "C", kind: "credit_note" }],
    [51, { family: "retention_legend", voucherClass: "A", kind: "invoice" }],
    [206, { family: "fce", voucherClass: "B", kind: "invoice" }],
    [213, { family: "fce", voucherClass: "C", kind: "credit_note" }],
  ])("describes type %i", (voucherType, expected) => {
    expect(describeVoucherType(voucherType)).toEqual(expected);
  });

  it.each([0, 4, 99, 1.5, Number.NaN])("rejects type %s", (voucherType) => {
    expect(() => describeVoucherType(voucherType)).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "voucherType",
      })
    );
  });
});

describe("FCE service note fiscal validation", () => {
  const note: WsfeVoucherInput = {
    salesPoint: 1,
    voucherType: 203,
    concept: 2,
    documentType: 80,
    documentNumber: 20_123_456_789,
    receiverVatConditionId: 1,
    voucherDate: "20260905",
    serviceStartDate: "20260901",
    serviceEndDate: "20260904",
    totalAmount: 121,
    netAmount: 100,
    vatAmount: 21,
    exemptAmount: 0,
    nonTaxableAmount: 0,
    taxAmount: 0,
    currencyId: "PES",
    exchangeRate: 1,
    optionalFields: [{ id: "22", value: "N" }],
  };

  it("rejects a payment due date on a note without annulment", () => {
    expect(() =>
      validateFiscalHeader({ ...note, paymentDueDate: "20260905" })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "dueDate",
      })
    );
  });

  it.each([
    [{ serviceStartDate: undefined }, "service"],
    [{ serviceEndDate: undefined }, "service"],
    [{ serviceEndDate: "20260831" }, "service.to"],
  ] as const)("still validates the service window %j", (changes, field) => {
    expect(() => validateFiscalHeader({ ...note, ...changes })).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_VALUE", field })
    );
  });

  it("keeps the WSFE due date requirement for an annulment", () => {
    const annulment = {
      ...note,
      optionalFields: [{ id: "22", value: "S" }],
    };
    expect(() => validateFiscalHeader(annulment)).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "service",
      })
    );
    expect(() =>
      validateFiscalHeader({ ...annulment, paymentDueDate: "20260905" })
    ).not.toThrow();
  });
});
