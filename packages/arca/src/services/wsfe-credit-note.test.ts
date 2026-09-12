import { describe, expect, it } from "vitest";
import {
  normalizeWsfeVoucherInput,
  type WsfeDateInput,
  type WsfeVoucherInfo,
} from "./wsfe";
import type { AmountItem, VatItem } from "./wsfe-amounts";
import {
  assertCreditNoteInput,
  type CreditNoteInput,
  deriveWsfeFullCreditNote,
  deriveWsfePartialCreditNote,
} from "./wsfe-credit-note";
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
const classA = original({
  issuer: "responsable_inscripto",
  salesPoint: 1,
  date: "20260904",
  to: { condition: "responsable_inscripto", cuit: "20123456789" },
  items: [{ net: 10_000, vat: 21 }],
});
const classC = original({
  issuer: "monotributo",
  salesPoint: 1,
  date: "20260904",
  to: { condition: "consumidor_final" },
  items: [{ amount: 100 }],
});
const target = { salesPoint: 1, voucherType: 11, number: 1 };
function full(date?: WsfeDateInput): CreditNoteInput {
  return { for: target, all: true, ...(date === undefined ? {} : { date }) };
}
function partial(
  items: readonly VatItem[] | readonly AmountItem[],
  extra: { total?: number; salesPoint?: number; date?: WsfeDateInput } = {}
): CreditNoteInput {
  return { for: target, items, date: "20260905", ...extra };
}

describe("full credit note derivation", () => {
  it.each([
    [1, 3, "A"],
    [6, 8, "B"],
    [11, 13, "C"],
  ] as const)("maps %s to %s", (voucherType, type, voucherClass) => {
    const data = voucherType === 11 ? classC : { ...invoice, voucherType };
    const result = deriveWsfeFullCreditNote(data, full("20260905"));
    expect(result.voucherClass).toBe(voucherClass);
    expect(result.data.voucherType).toBe(type);
    expect(result.data.associatedVouchers).toEqual([
      { type: voucherType, salesPoint: 1, number: 1, voucherDate: "20260904" },
    ]);
    normalizeWsfeVoucherInput(result.data);
  });
  it("copies all monetary fields and VAT details without rounding", () => {
    const { data } = deriveWsfeFullCreditNote(invoice, full("20260905"));
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
    const { data } = deriveWsfeFullCreditNote(service, full("20260905"));
    expect(data).toMatchObject({
      concept,
      serviceStartDate: "20260901",
      serviceEndDate: "20260904",
      paymentDueDate: "20260905",
    });
    expect(
      deriveWsfeFullCreditNote(
        { ...service, paymentDueDate: "20260930" },
        full("20260905")
      ).data.paymentDueDate
    ).toBe("20260930");
  });
  it.each([
    ["taxes", "Tributos"],
    ["optionalFields", "Opcionales"],
    ["buyers", "Compradores"],
    ["activities", "Actividades"],
    ["associatedPeriod", "PeriodoAsoc"],
  ])("rejects undecodable or malformed original %s", (field, rawField) => {
    expect(() =>
      deriveWsfeFullCreditNote(
        { ...invoice, raw: { [rawField]: { value: 1 } } },
        full("20260905")
      )
    ).toThrow(field);
    expect(() =>
      deriveWsfeFullCreditNote(
        { ...invoice, [field]: [{ value: 1 }] },
        full("20260905")
      )
    ).toThrow("incomplete or malformed");
    expect(() =>
      deriveWsfePartialCreditNote(
        [{ ...invoice, [field]: [{ value: 1 }] }],
        partial([{ gross: 100, vat: 21 }])
      )
    ).toThrow("incomplete or malformed");
  });
  it("rejects missing required evidence and unsupported originals", () => {
    for (const change of [
      { result: "R" },
      { voucherType: 8 },
      { cae: undefined },
      { receiverVatConditionId: undefined },
      { taxAmount: 1 },
    ]) {
      expect(() =>
        deriveWsfeFullCreditNote({ ...invoice, ...change }, full("20260905"))
      ).toThrow();
    }
    expect(() =>
      deriveWsfeFullCreditNote({ ...invoice, concept: 2 }, full("20260905"))
    ).toThrow("serviceStartDate");
  });
  it("uses Buenos Aires date and respects association date rules", () => {
    expect(
      deriveWsfeFullCreditNote(
        invoice,
        full(),
        new Date("2026-09-06T01:00:00Z")
      ).data.voucherDate
    ).toBe("20260905");
    expect(() => deriveWsfeFullCreditNote(invoice, full("20260831"))).toThrow(
      "10210"
    );
    expect(
      deriveWsfeFullCreditNote(invoice, full("20260903")).data.voucherDate
    ).toBe("20260903");
  });
  it("names issueCreditNote and never cancel in its errors", () => {
    expect(() =>
      deriveWsfeFullCreditNote({ ...invoice, voucherType: 8 }, full("20260905"))
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        message: expect.stringContaining("issueCreditNote"),
      })
    );
    expect(() =>
      deriveWsfeFullCreditNote({ ...invoice, voucherType: 8 }, full("20260905"))
    ).not.toThrow(/cancel/);
  });
});

describe("partial credit note derivation", () => {
  it("credits chosen amount items against a class C original", () => {
    const result = deriveWsfePartialCreditNote(
      [classC],
      partial([{ amount: 40 }])
    );
    expect(result.voucherClass).toBe("C");
    expect(result.data).toMatchObject({
      voucherType: 13,
      salesPoint: 1,
      concept: 1,
      documentType: 99,
      documentNumber: 0,
      receiverVatConditionId: 5,
      currencyId: "PES",
      exchangeRate: 1,
      voucherDate: "20260905",
      totalAmount: 0.4,
      netAmount: 0.4,
      vatAmount: 0,
      associatedVouchers: [
        { type: 11, salesPoint: 1, number: 1, voucherDate: "20260904" },
      ],
    });
    expect(result.data).not.toHaveProperty("vatRates");
    expect(result.amounts).toEqual({
      computedTotal: 40,
      sentTotal: 40,
      vatAdjustment: 0,
    });
    normalizeWsfeVoucherInput(result.data);
  });
  it.each([
    ["A", classA, 3],
    ["B", invoice, 8],
  ] as const)("credits VAT items against a class %s original", (voucherClass, source, voucherType) => {
    const items: VatItem[] = [
      { gross: 6050, vat: 21 },
      { net: 1000, vat: 10.5 },
      { gross: 500, vat: "exempt" },
    ];
    const result = deriveWsfePartialCreditNote([source], partial(items));
    expect(result.voucherClass).toBe(voucherClass);
    expect(result.data.voucherType).toBe(voucherType);
    expect(result.amounts).toEqual({
      computedTotal: 7655,
      sentTotal: 7655,
      vatAdjustment: 0,
    });
    // The amount pipeline is the invoice's: same items, same numbers.
    expect(result.data.vatRates).toEqual(
      deriveWsfeInvoice({
        issuer: "responsable_inscripto",
        salesPoint: 1,
        date: "20260905",
        to: { condition: "consumidor_final" },
        items,
      }).data.vatRates
    );
    expect(result.data).toMatchObject({
      totalAmount: 76.55,
      exemptAmount: 5,
      documentType: source.documentType,
      documentNumber: Number(source.documentNumber),
      receiverVatConditionId: source.receiverVatConditionId,
    });
    normalizeWsfeVoucherInput(result.data);
  });
  it("derives amounts exactly as issue() does, including the total tolerance", () => {
    const items: VatItem[] = [
      { net: 3333, vat: 21 },
      { net: 3333, vat: 10.5 },
    ];
    const asInvoice = deriveWsfeInvoice({
      issuer: "responsable_inscripto",
      salesPoint: 1,
      date: "20260905",
      to: { condition: "consumidor_final" },
      items,
      total: 7717,
    });
    const asNote = deriveWsfePartialCreditNote(
      [invoice],
      partial(items, { total: 7717 })
    );
    expect(asNote.amounts).toEqual(asInvoice.amounts);
    for (const field of [
      "totalAmount",
      "netAmount",
      "vatAmount",
      "exemptAmount",
      "nonTaxableAmount",
      "taxAmount",
      "vatRates",
    ] as const) {
      expect(asNote.data[field]).toEqual(asInvoice.data[field]);
    }
    expect(() =>
      deriveWsfePartialCreditNote([invoice], partial(items, { total: 7720 }))
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_AMOUNT_MISMATCH" })
    );
  });
  it("credits a reviewed breakdown the way issue() derives one", () => {
    const result = deriveWsfePartialCreditNote([invoice], {
      for: target,
      date: "20260905",
      amounts: {
        net: 10_000,
        vat: 2100,
        vatRates: [{ id: 5, base: 10_000, amount: 2100 }],
      },
      taxes: [{ id: 99, base: 10_000, rate: 1, amount: 100 }],
    });
    expect(result.data).toMatchObject({
      voucherType: 8,
      totalAmount: 122,
      netAmount: 100,
      vatAmount: 21,
      taxAmount: 1,
      vatRates: [{ id: 5, baseAmount: 100, amount: 21 }],
    });
    expect(result.amounts).toEqual({
      computedTotal: 12_200,
      sentTotal: 12_200,
      vatAdjustment: 0,
    });
    normalizeWsfeVoucherInput(result.data);
  });
  it.each([
    100.5,
    Number.NaN,
  ])("rejects the reviewed total %s before reading the original", (total) => {
    expect(() =>
      deriveWsfePartialCreditNote([invoice], {
        for: target,
        date: "20260905",
        amounts: { net: 10_000, vat: 2100 },
        total,
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ArcaInputError",
        code: "ARCA_INPUT_INVALID_AMOUNT",
        field: "total",
      })
    );
  });
  it("rejects an item shape that does not match the original's class", () => {
    expect(() =>
      deriveWsfePartialCreditNote([classC], partial([{ gross: 100, vat: 21 }]))
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "items",
        message: expect.stringContaining("class C"),
      })
    );
    for (const source of [classA, invoice]) {
      expect(() =>
        deriveWsfePartialCreditNote([source], partial([{ amount: 100 }]))
      ).toThrowError(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "items",
          message: expect.stringContaining("class A or B"),
        })
      );
    }
  });
  it("refuses a note greater than the original and allows the exact total", () => {
    expect(() =>
      deriveWsfePartialCreditNote([classC], partial([{ amount: 101 }]))
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        message: expect.stringContaining("greater than the original"),
      })
    );
    expect(
      deriveWsfePartialCreditNote([classC], partial([{ amount: 100 }])).amounts
        .sentTotal
    ).toBe(100);
    expect(() =>
      deriveWsfePartialCreditNote(
        [invoice],
        partial([{ gross: 30_000, vat: 21 }])
      )
    ).toThrow("greater than the original");
  });
  it("keeps the original's service dates, currency and rate", () => {
    const services = {
      ...invoice,
      concept: 2,
      serviceStartDate: "20260901",
      serviceEndDate: "20260904",
      paymentDueDate: "20260901",
      currencyId: "DOL",
      exchangeRate: 1200.5,
    };
    const { data } = deriveWsfePartialCreditNote(
      [services],
      partial([{ gross: 12_100, vat: 21 }])
    );
    expect(data).toMatchObject({
      concept: 2,
      serviceStartDate: "20260901",
      serviceEndDate: "20260904",
      paymentDueDate: "20260905",
      currencyId: "DOL",
      exchangeRate: 1200.5,
    });
    normalizeWsfeVoucherInput(data);
  });
  it("issues the note from its own sales point when asked", () => {
    expect(
      deriveWsfePartialCreditNote(
        [classC],
        partial([{ amount: 40 }], { salesPoint: 7 })
      ).data
    ).toMatchObject({
      salesPoint: 7,
      associatedVouchers: [
        { type: 11, salesPoint: 1, number: 1, voucherDate: "20260904" },
      ],
    });
  });
  it("requires items", () => {
    expect(() =>
      deriveWsfePartialCreditNote([classC], { for: target, all: true })
    ).toThrowError(
      expect.objectContaining({ code: "ARCA_INPUT_INVALID_VALUE" })
    );
  });
});

describe("notes against several originals", () => {
  const second = { ...classC, voucherNumber: 2 };
  const targets = [
    { salesPoint: 1, voucherType: 11, number: 1 },
    { salesPoint: 1, voucherType: 11, number: 2 },
  ];
  function many(
    items: readonly AmountItem[],
    extra: { total?: number } = {}
  ): CreditNoteInput {
    return { for: targets, items, date: "20260905", ...extra };
  }
  it("associates every original and inherits their common header", () => {
    const { data, voucherClass, amounts } = deriveWsfePartialCreditNote(
      [classC, second],
      many([{ amount: 150 }])
    );
    expect(voucherClass).toBe("C");
    expect(data).toMatchObject({
      voucherType: 13,
      salesPoint: 1,
      documentType: 99,
      receiverVatConditionId: 5,
      currencyId: "PES",
      totalAmount: 1.5,
    });
    expect(data.associatedVouchers).toEqual([
      { type: 11, salesPoint: 1, number: 1, voucherDate: "20260904" },
      { type: 11, salesPoint: 1, number: 2, voucherDate: "20260904" },
    ]);
    expect(amounts.sentTotal).toBe(150);
    normalizeWsfeVoucherInput(data);
  });
  it("caps the note at the sum of the originals, not at one of them", () => {
    expect(
      deriveWsfePartialCreditNote([classC, second], many([{ amount: 200 }]))
        .amounts.sentTotal
    ).toBe(200);
    expect(() =>
      deriveWsfePartialCreditNote([classC, second], many([{ amount: 201 }]))
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        message: expect.stringContaining(
          "greater than the sum of the originals"
        ),
      })
    );
  });
  it.each([
    ["documentNumber", { documentNumber: "20123456789" }],
    ["receiverVatConditionId", { receiverVatConditionId: 1 }],
    ["currencyId", { currencyId: "DOL", exchangeRate: 1200 }],
    ["voucherType", { voucherType: 1 }],
    [
      "concept",
      {
        concept: 3,
        serviceStartDate: "20260901",
        serviceEndDate: "20260904",
        paymentDueDate: "20260905",
      },
    ],
  ])("rejects originals that disagree on %s", (field, change) => {
    expect(() =>
      deriveWsfePartialCreditNote(
        [classC, { ...second, ...change }],
        many([{ amount: 50 }])
      )
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        message: expect.stringContaining(`disagree on ${field}`),
      })
    );
  });
  it("takes the note sales point from the input when the originals differ", () => {
    const elsewhere = { ...second, salesPoint: 4 };
    expect(() =>
      deriveWsfePartialCreditNote([classC, elsewhere], many([{ amount: 50 }]))
    ).toThrow("disagree on salesPoint");
    expect(
      deriveWsfePartialCreditNote([classC, elsewhere], {
        ...many([{ amount: 50 }]),
        salesPoint: 9,
      }).data
    ).toMatchObject({ salesPoint: 9 });
  });
});

describe("credit note input with several originals", () => {
  const targets = [
    { salesPoint: 1, voucherType: 11, number: 1 },
    { salesPoint: 1, voucherType: 11, number: 2 },
  ];
  it("keeps one object an object and a list a list", () => {
    expect(
      assertCreditNoteInput({ for: target, items: [{ amount: 1 }] }).for
    ).toEqual(target);
    expect(
      assertCreditNoteInput({ for: targets, items: [{ amount: 1 }] }).for
    ).toEqual(targets);
  });
  it("refuses all: true against several originals", () => {
    expect(() =>
      assertCreditNoteInput({ for: targets, all: true })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "input.all",
        message: expect.stringContaining("no single total"),
      })
    );
    expect(assertCreditNoteInput({ for: [target], all: true }).all).toBe(true);
  });
  it("refuses an empty list and names the offending entry", () => {
    expect(() =>
      assertCreditNoteInput({ for: [], items: [{ amount: 1 }] })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "input.for",
      })
    );
    expect(() =>
      assertCreditNoteInput({
        for: [target, { ...target, voucherType: 3 }],
        items: [{ amount: 1 }],
      })
    ).toThrowError(
      expect.objectContaining({ field: "input.for[1].voucherType" })
    );
  });
});
