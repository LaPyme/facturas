import { describe, expect, it } from "vitest";
import type { WsfeVoucherInfo, WsfeVoucherInput } from "./wsfe";
import { matchWsfeVoucherIdentity, toVoucherSummary } from "./wsfe-identity";

const sent: WsfeVoucherInput = {
  salesPoint: 1,
  voucherType: 6,
  concept: 2,
  documentType: 99,
  documentNumber: 0,
  receiverVatConditionId: 5,
  voucherDate: "20260904",
  currencyId: "PES",
  exchangeRate: "1",
  totalAmount: 231.49,
  netAmount: 200,
  vatAmount: 31.49,
  exemptAmount: 0,
  nonTaxableAmount: 0,
  taxAmount: 0,
  vatRates: [
    { id: 5, baseAmount: 100, amount: 21 },
    { id: 4, baseAmount: 100, amount: 10.5 },
  ],
  serviceStartDate: "20260901",
  serviceEndDate: "20260930",
  paymentDueDate: "20261001",
};
function voucher(): WsfeVoucherInfo {
  return {
    ...sent,
    voucherNumber: 77,
    documentNumber: "0",
    exchangeRate: 1,
    result: "A",
    cae: "74123456789012",
    caeExpiry: "20260914",
    raw: { secret: "not projected" },
    vatRates: sent.vatRates?.map((rate) => ({ ...rate })),
  };
}

describe("WSFE identity matcher", () => {
  it("matches an authorized identity with reordered rates, normalized dates and decimal forms", () => {
    const found = voucher();
    found.voucherDate = "2026-09-04";
    found.documentNumber = "000";
    found.vatRates?.reverse();
    expect(matchWsfeVoucherIdentity(sent, 77, found)).toEqual({
      matches: true,
    });
  });

  it.each([
    ["voucherType", 1],
    ["salesPoint", 2],
    ["voucherNumber", 78],
    ["voucherDate", "20260905"],
    ["concept", 1],
    ["documentType", 80],
    ["documentNumber", "1"],
    ["receiverVatConditionId", 1],
    ["currencyId", "DOL"],
    ["exchangeRate", 1.000_001],
    ["totalAmount", 231.5],
    ["netAmount", 200.01],
    ["vatAmount", 31.5],
    ["exemptAmount", 0.01],
    ["nonTaxableAmount", 0.01],
    ["taxAmount", 0.01],
    ["serviceStartDate", "20260902"],
    ["serviceEndDate", "20260929"],
    ["paymentDueDate", "20261002"],
  ] as const)("detects %s conflicts and missing fields", (field, value) => {
    expect(
      matchWsfeVoucherIdentity(sent, 77, { ...voucher(), [field]: value })
    ).toMatchObject({ matches: false, evidence: "conflict" });
    const missing = {
      ...voucher(),
      [field]: undefined,
    } as unknown as WsfeVoucherInfo;
    expect(matchWsfeVoucherIdentity(sent, 77, missing)).toMatchObject({
      matches: false,
      evidence: "incomplete",
    });
    // The comparison is bidirectional; changes in what was sent also conflict.
    const inputField = field === "voucherNumber" ? undefined : field;
    if (inputField) {
      expect(
        matchWsfeVoucherIdentity(
          { ...sent, [inputField]: value },
          77,
          voucher()
        )
      ).toMatchObject({ matches: false, evidence: "conflict" });
    }
  });

  it.each([
    0,
    -1,
    77.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    100_000_000,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "treats invalid voucher number %s as incomplete evidence",
    (voucherNumber) => {
      expect(
        matchWsfeVoucherIdentity(sent, 77, { ...voucher(), voucherNumber })
      ).toEqual({
        matches: false,
        evidence: "incomplete",
        reason: "Cannot verify number",
      });
    }
  );

  it.each([1, 99_999_999])(
    "matches valid voucher number boundary %s",
    (number) => {
      expect(
        matchWsfeVoucherIdentity(sent, number, {
          ...voucher(),
          voucherNumber: number,
        })
      ).toEqual({ matches: true });
    }
  );

  it.each(["baseAmount", "amount"] as const)(
    "detects a one-cent VAT %s mismatch",
    (field) => {
      const found = voucher();
      const rate = found.vatRates?.[0];
      if (rate) {
        rate[field] += 0.01;
      }
      expect(matchWsfeVoucherIdentity(sent, 77, found)).toMatchObject({
        evidence: "conflict",
        reason: expect.stringContaining(field),
      });
    }
  );

  it("requires complete rate details and rejects missing, extra and duplicate ids", () => {
    expect(
      matchWsfeVoucherIdentity(sent, 77, { ...voucher(), vatRates: undefined })
    ).toMatchObject({ evidence: "incomplete" });
    for (const vatRates of [
      [],
      [{ id: 5, baseAmount: 100, amount: 21 }],
      [
        { id: 5, baseAmount: 100, amount: 21 },
        { id: 5, baseAmount: 100, amount: 10.5 },
      ],
    ]) {
      expect(
        matchWsfeVoucherIdentity(sent, 77, { ...voucher(), vatRates })
      ).toMatchObject({ evidence: "conflict" });
    }
  });

  it.each([
    { cae: undefined },
    { caeExpiry: undefined },
    { cae: " " },
    { result: "R" },
    { result: undefined },
    { exchangeRate: Number.NaN },
    { totalAmount: 1.001 },
  ])("does not recover incomplete authorization evidence %j", (override) => {
    expect(
      matchWsfeVoucherIdentity(sent, 77, { ...voucher(), ...override })
    ).toMatchObject({ matches: false, evidence: "incomplete" });
  });

  it("compares C without VAT or service dates, and does not claim to compare unsupported exact extensions", () => {
    const data = {
      ...sent,
      concept: 1,
      voucherType: 11,
      vatRates: undefined,
      vatAmount: 0,
      totalAmount: 200,
    };
    const found = {
      ...voucher(),
      ...data,
      documentNumber: "0",
      exchangeRate: 1,
    };
    expect(matchWsfeVoucherIdentity(data, 77, found)).toEqual({
      matches: true,
    });
    expect(
      matchWsfeVoucherIdentity(
        { ...data, optionalFields: [{ id: "27", value: "SCA" }] },
        77,
        found
      )
    ).toMatchObject({
      evidence: "incomplete",
      reason: expect.stringContaining("optionalFields"),
    });
  });

  it("projects only normalized evidence and clones VAT rows", () => {
    const found = voucher();
    const summary = toVoucherSummary(found);
    expect(summary).not.toHaveProperty("raw");
    expect(summary).not.toHaveProperty("voucherNumber");
    expect(summary).toMatchObject({
      number: 77,
      date: "2026-09-04",
      concept: 2,
      serviceStartDate: "2026-09-01",
    });
    expect(summary.vatRates).not.toBe(found.vatRates);
    expect(
      toVoucherSummary({
        ...found,
        vatRates: [{ id: 5, baseAmount: 100, amount: 21.001 }],
      })
    ).not.toHaveProperty("vatRates");
    expect(toVoucherSummary({ voucherNumber: 77, raw: {} })).toEqual({
      number: 77,
    });
  });
});
