import { describe, expect, it } from "vitest";
import { describeVoucherType } from "./issuance-fields";

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
