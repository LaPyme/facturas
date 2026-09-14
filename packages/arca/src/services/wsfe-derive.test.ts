import { describe, expect, it } from "vitest";
import {
  ARCA_ISSUER_CONDITION_IDS,
  ARCA_RECEIVER_CONDITION_IDS,
  type IssuerCondition,
  type ReceiverCondition,
} from "../constants";
import { deriveWsfeInvoice, type IssueInput } from "./wsfe-derive";

const base: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  to: { condition: "consumidor_final" },
  items: [{ gross: 12_100, vat: 21 }],
  date: "20260904",
};
const derive = (input: unknown) => deriveWsfeInvoice(input as IssueInput);

describe("WSFE invoice derivation", () => {
  it("covers the complete issuer-first matrix with declared fixtures", () => {
    for (const issuer of Object.keys(
      ARCA_ISSUER_CONDITION_IDS
    ) as IssuerCondition[]) {
      for (const condition of Object.keys(
        ARCA_RECEIVER_CONDITION_IDS
      ) as ReceiverCondition[]) {
        const expected =
          issuer === "responsable_inscripto"
            ? ["responsable_inscripto", "monotributo"].includes(condition)
              ? "A"
              : "B"
            : "C";
        const result = derive({
          ...base,
          issuer,
          to: { condition, cuit: "20123456789" },
          items:
            issuer === "responsable_inscripto"
              ? [{ net: 10_000, vat: 21 }]
              : [{ amount: 10_000 }],
        });
        expect(result.voucherClass).toBe(expected);
        expect(result.data.voucherType).toBe({ A: 1, B: 6, C: 11 }[expected]);
        expect(result.data.receiverVatConditionId).toBe(
          ARCA_RECEIVER_CONDITION_IDS[condition]
        );
        expect(result.data).toMatchObject({
          documentType: 80,
          documentNumber: 20_123_456_789,
        });
      }
    }
  });
  it("derives unidentified and DNI final consumers", () => {
    expect(deriveWsfeInvoice(base).data).toMatchObject({
      documentType: 99,
      documentNumber: 0,
    });
    for (const dni of [12_345_678, "12345678", 123_456_789]) {
      expect(
        deriveWsfeInvoice({
          ...base,
          to: { condition: "consumidor_final", dni },
        }).data
      ).toMatchObject({ documentType: 96, documentNumber: Number(dni) });
    }
  });
  it.each(["responsable_inscripto", "monotributo", "exento", "no_alcanzado"])(
    "requires CUIT for %s",
    (condition) => {
      expect(() =>
        derive({ ...base, to: { condition, dni: 12_345_678 } })
      ).toThrowError(
        expect.objectContaining({
          code: "ARCA_INPUT_MISSING_FIELD",
          field: "to.cuit",
        })
      );
    }
  );
  it.each([
    { cuit: "" },
    { cuit: 0 },
    { cuit: "2012345678x" },
    { cuit: "20-12345678-9" },
    { cuit: "201234567890" },
    { dni: -1 },
    { dni: 1.5 },
    { dni: 123_456_789_012 },
    { dni: null },
    { cuit: "20123456789", dni: 12_345_678 },
  ])("rejects invalid receiver documents %j", (documents) => {
    expect(() =>
      derive({ ...base, to: { condition: "consumidor_final", ...documents } })
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_VALUE" })
    );
  });
  it("requires identification at the exact ARS threshold and respects asserted totals", () => {
    const at = { ...base, items: [{ gross: 1_000_000_000, vat: 21 }] };
    expect(() => derive(at)).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_MISSING_FIELD", field: "to" })
    );
    expect(() => derive({ ...at, total: 999_999_999 })).not.toThrow();
    expect(() =>
      derive({ ...at, to: { condition: "consumidor_final", dni: 12_345_678 } })
    ).not.toThrow();
    expect(() =>
      derive({
        ...base,
        items: [{ gross: 999_999_999, vat: 21 }],
        total: 1_000_000_000,
      })
    ).toThrowError(expect.objectContaining({ field: "to" }));
  });
  it("compares USD peso equivalents exactly across the threshold", () => {
    const usd = {
      ...base,
      currency: "USD",
      exchangeRate: "1000",
      items: [{ gross: 1_000_000, vat: 21 }],
    };
    expect(() => derive(usd)).toThrowError(
      expect.objectContaining({ field: "to" })
    );
    expect(() => derive({ ...usd, exchangeRate: "999.999999" })).not.toThrow();
    expect(() => derive({ ...usd, exchangeRate: "1000.000001" })).toThrowError(
      expect.objectContaining({ field: "to" })
    );
    expect(() =>
      derive({
        ...usd,
        to: { condition: "consumidor_final", cuit: "20123456789" },
      })
    ).not.toThrow();
  });
  it("maps ISO currency, defaulting to ARS and rate one", () => {
    expect(deriveWsfeInvoice(base).data).toMatchObject({
      currencyId: "PES",
      exchangeRate: "1",
    });
    expect(
      deriveWsfeInvoice({ ...base, currency: "ARS", exchangeRate: "1.000000" })
        .data
    ).toMatchObject({ currencyId: "PES", exchangeRate: "1" });
    expect(
      deriveWsfeInvoice({
        ...base,
        currency: "USD",
        exchangeRate: "1200.500000",
      }).data
    ).toMatchObject({ currencyId: "DOL", exchangeRate: "1200.5" });
  });
  it.each([undefined, "0", "-1", "1.0000001", "10000", "1e3", "", 1000, null])(
    "rejects missing or invalid USD exchange rate %s",
    (exchangeRate) => {
      expect(() =>
        derive({ ...base, currency: "USD", exchangeRate })
      ).toThrowError(expect.objectContaining({ field: "exchangeRate" }));
    }
  );
  it.each([
    ["2026-09-04T23:30:00Z", "20260904"],
    ["2026-09-04T00:30:00Z", "20260903"],
    ["2026-09-04T02:59:59Z", "20260903"],
    ["2026-09-04T03:00:00Z", "20260904"],
    ["2027-01-01T01:00:00Z", "20261231"],
  ])("uses Buenos Aires calendar dates at %s", (now, date) => {
    expect(
      deriveWsfeInvoice({ ...base, date: undefined }, new Date(now)).data
        .voucherDate
    ).toBe(date);
  });
  it("derives goods/services and normalizes the service dates", () => {
    expect(deriveWsfeInvoice(base).data.concept).toBe(1);
    expect(
      deriveWsfeInvoice({
        ...base,
        service: {
          from: "2026-09-01",
          to: "2026-09-30",
          dueDate: "2026-10-01",
        },
      }).data
    ).toMatchObject({
      concept: 2,
      serviceStartDate: "20260901",
      serviceEndDate: "20260930",
      paymentDueDate: "20261001",
    });
  });
  it.each([
    [null, "input"],
    [{ ...base, issuer: "other" }, "issuer"],
    [{ ...base, to: null }, "to"],
    [{ ...base, to: { condition: "other" } }, "to.condition"],
    [{ ...base, currency: "EUR" }, "currency"],
    [{ ...base, currency: "ARS", exchangeRate: "2" }, "exchangeRate"],
    [{ ...base, date: "20260230" }, "date"],
    [{ ...base, service: {} }, "service.from"],
    [{ ...base, service: null }, "service"],
    [
      {
        ...base,
        service: { from: "20260902", to: "20260901", dueDate: "20261001" },
      },
      "service.to",
    ],
    [
      {
        ...base,
        service: { from: "20260901", to: "20260930", dueDate: "20260903" },
      },
      "service.dueDate",
    ],
    [{ ...base, kind: "credit_note" }, "kind"],
    [{ ...base, taxes: {} }, "taxes"],
  ])("reports stable caller field paths for %j", (input, field) => {
    expect(() => derive(input)).toThrowError(
      expect.objectContaining({ field })
    );
  });
  it.each([undefined, 0, -1, 1.5, 100_000, Number.NaN, "1"])(
    "rejects invalid sales point %s",
    (salesPoint) => {
      expect(() => derive({ ...base, salesPoint })).toThrowError(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "salesPoint",
        })
      );
    }
  );
});
