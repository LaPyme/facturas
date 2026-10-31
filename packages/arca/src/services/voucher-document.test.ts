import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVoucherDocument,
  MONOTRIBUTO_CREDIT_LEGEND,
  type VoucherDocument,
  type VoucherDocumentInput,
} from "./voucher-document";
import { createVouchersService } from "./vouchers";
import type { IssuedVoucher } from "./vouchers-types";
import {
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeIssueInput,
} from "./wsfe";
import type { IssueInput } from "./wsfe-derive";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const authorized: WsfeAuthorizationOutcome = {
  service: "wsfe",
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
  kind: "authorized",
  result: "A",
  resultLevel: "detail",
  cae: "74123456789012",
  caeExpiry: "20260914",
  voucherNumber: 41,
};

async function issued(input: IssueInput): Promise<IssuedVoucher> {
  const wsfe = {
    getNextVoucherNumber: vi.fn().mockResolvedValue(41),
    issue: vi.fn(({ data }: WsfeIssueInput) => {
      normalizeWsfeVoucherInput(data);
      return Promise.resolve(authorized);
    }),
    lookupVoucher: vi.fn(),
  };
  const service = createVouchersService(wsfe, {
    environment: "test",
    taxId: "20123456789",
  });
  const result = await service.issue(input);
  if (result.kind !== "authorized") {
    throw new Error(result.kind);
  }
  return result.voucher;
}

const registered = {
  legalName: "Ferretería del Sur SRL",
  tradeName: "Ferretería del Sur",
  address: "Av. Rivadavia 1234, CABA",
  taxId: "20-12345678-9",
  condition: "responsable_inscripto",
  grossIncome: "901-123456-7",
  activitiesStartDate: "2019-10-01",
} as const satisfies VoucherDocumentInput["issuer"];

function document(
  voucher: IssuedVoucher,
  items: IssueInput["items"] & object,
  overrides: Partial<VoucherDocumentInput> = {}
): VoucherDocument {
  return buildVoucherDocument({
    voucher,
    items,
    issuer: registered,
    saleConditions: "Contado",
    ...overrides,
  });
}

/** Every printed money figure adds up to the authorized total. */
function expectBalanced(doc: VoucherDocument) {
  const { totals } = doc;
  const vat = totals.vatRates.reduce((sum, row) => sum + row.amount, 0);
  const taxes = totals.otherTaxes.reduce((sum, tax) => sum + tax.amount, 0);
  const lines = doc.lines.reduce((sum, line) => sum + line.amount, 0);
  const adjustments = (totals.adjustments ?? []).reduce(
    (sum, row) => sum + row.amount,
    0
  );
  if (doc.voucherClass === "A") {
    const net = doc.lines
      .filter((line) => typeof line.vatRate === "number")
      .reduce((sum, line) => sum + line.amount, 0);
    expect(net - totals.globalDiscount + adjustments).toBe(totals.subtotal);
    expect(
      totals.subtotal +
        totals.exempt +
        totals.untaxed +
        vat +
        totals.adjustment +
        taxes
    ).toBe(totals.total);
  } else {
    expect(lines - totals.globalDiscount + adjustments).toBe(totals.subtotal);
    expect(totals.subtotal + totals.adjustment + taxes).toBe(totals.total);
  }
}

describe("buildVoucherDocument", () => {
  it("derives a class B consumer invoice with the transparency block", async () => {
    const items = [
      {
        description: "Taladro percutor 13 mm",
        quantity: 2,
        unitPrice: "605.00",
        gross: 121_000,
        vat: 21,
      },
      { description: "Mechas para metal", gross: 2420, vat: 10.5 },
    ] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items,
    });
    const doc = document(voucher, items, { remitos: ["0003-00000012"] });
    expect(doc).toMatchObject({
      voucherClass: "B",
      voucherType: 6,
      code: "006",
      title: "FACTURA",
      number: "00003-00000041",
      issueDate: "2026-09-05",
      issuer: {
        tradeName: "Ferretería del Sur",
        legalName: "Ferretería del Sur SRL",
        taxId: "20123456789",
        conditionLegend: "IVA RESPONSABLE INSCRIPTO",
        grossIncome: "901-123456-7",
        activitiesStartDate: "2019-10-01",
      },
      receiver: { conditionLegend: "A CONSUMIDOR FINAL" },
      saleConditions: "Contado",
      remitos: ["0003-00000012"],
      currency: { id: "PES" },
      lines: [
        {
          description: "Taladro percutor 13 mm",
          quantity: 2,
          unitPrice: "605.00",
          amount: 121_000,
        },
        {
          description: "Mechas para metal",
          quantity: 1,
          unitPrice: "24.20",
          amount: 2420,
        },
      ],
      transparency: {
        vatContained: 21_230,
        otherNationalIndirectTaxes: 0,
      },
      authorization: {
        kind: "CAE",
        code: "74123456789012",
        dueDate: "2026-09-14",
      },
      legends: [],
    });
    expect(doc.receiver).not.toHaveProperty("document");
    expect(doc.lines[0]).not.toHaveProperty("vatRate");
    expect(doc.totals.vatRates).toEqual([]);
    expect(doc.qr).toBe(voucher.qr);
    expectBalanced(doc);
  });

  it("breaks VAT out by rate on class A and adds the Ley 27.618 legend for a monotributo receiver", async () => {
    const items = [
      { description: "Servicio de instalación", net: 10_000, vat: 21 },
      { description: "Repuestos", net: 4000, vat: 10.5 },
      { description: "Libros", net: 500, vat: "exempt" },
    ] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "monotributo", cuit: "20111111112" },
      items,
      taxes: [
        { id: 2, description: "IIBB", base: 10_000, rate: 3, amount: 300 },
      ],
    });
    const doc = document(voucher, items, {
      receiver: { name: "Juan Pérez", address: "Calle 1, Rosario" },
      saleConditions: "Cuenta corriente",
    });
    expect(doc).toMatchObject({
      voucherClass: "A",
      code: "001",
      receiver: {
        conditionLegend: "RESPONSABLE MONOTRIBUTO",
        name: "Juan Pérez",
        address: "Calle 1, Rosario",
        document: { type: 80, label: "CUIT", number: "20111111112" },
      },
      lines: [
        { amount: 10_000, vatRate: 21 },
        { amount: 4000, vatRate: 10.5 },
        { amount: 500, vatRate: "exempt" },
      ],
      totals: {
        subtotal: 14_000,
        exempt: 500,
        untaxed: 0,
        vatRates: [
          { id: 5, rate: 21, base: 10_000, amount: 2100 },
          { id: 4, rate: 10.5, base: 4000, amount: 420 },
        ],
        otherTaxes: [{ id: 2, description: "IIBB", amount: 300 }],
        adjustment: 0,
        total: 17_320,
      },
      legends: [{ rule: "G1", text: MONOTRIBUTO_CREDIT_LEGEND }],
    });
    expect(doc).not.toHaveProperty("transparency");
    expectBalanced(doc);
  });

  it("splits gross class A lines so their net adds up to the authorized base", async () => {
    const items = [1, 2, 3].map((n) => ({
      description: `Ítem ${n}`,
      gross: 3333,
      vat: 21 as const,
    }));
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "responsable_inscripto", cuit: "20111111112" },
      items,
    });
    const doc = document(voucher, items, {
      receiver: { name: "Cliente SA", address: "Calle 2" },
    });
    expect(doc.totals.vatRates).toHaveLength(1);
    expectBalanced(doc);
  });

  it("shows a header VAT adjustment that no line can carry", async () => {
    const items = [{ description: "Servicio", net: 10_000, vat: 21 }] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "responsable_inscripto", cuit: "20111111112" },
      items,
      total: 12_101,
    });
    const doc = document(voucher, items, {
      receiver: { name: "Cliente SA", address: "Calle 2" },
    });
    expect(doc.totals.adjustment).toBe(1);
    expectBalanced(doc);
  });

  it("counts national indirect taxes in the class B transparency block", async () => {
    const items = [{ description: "Bebida", gross: 10_000, vat: 21 }] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items,
      taxes: [
        { id: 4, base: 10_000, rate: 8, amount: 800 },
        { id: 2, description: "IIBB", base: 10_000, rate: 3, amount: 300 },
      ],
    });
    const doc = document(voucher, items);
    expect(doc.transparency).toEqual({
      vatContained: 1736,
      otherNationalIndirectTaxes: 800,
    });
    expect(doc.totals.otherTaxes).toEqual([
      { id: 4, description: "Impuestos internos", amount: 800 },
      { id: 2, description: "IIBB", amount: 300 },
    ]);
    expectBalanced(doc);
  });

  it("derives a class C voucher without VAT and omits an exempt start of activities", async () => {
    const items = [{ description: "Consulta", amount: 50_000 }] as const;
    const voucher = await issued({
      issuer: "monotributo",
      salesPoint: 3,
      to: { condition: "consumidor_final", dni: "30111222" },
      items,
    });
    const doc = document(voucher, items, {
      issuer: {
        ...registered,
        condition: "monotributo",
        activitiesStartDate: null,
      },
    });
    expect(doc).toMatchObject({
      voucherClass: "C",
      code: "011",
      issuer: { conditionLegend: "RESPONSABLE MONOTRIBUTO" },
      receiver: {
        conditionLegend: "A CONSUMIDOR FINAL",
        document: { type: 96, label: "DNI", number: "30111222" },
      },
      lines: [{ quantity: 1, unitPrice: "500.00", amount: 50_000 }],
      totals: { subtotal: 50_000, vatRates: [], total: 50_000 },
      legends: [],
    });
    expect(doc.issuer).not.toHaveProperty("activitiesStartDate");
    expect(doc).not.toHaveProperty("transparency");
    expectBalanced(doc);
  });

  it("renders every receiver condition issue() accepts, with the transparency block only where VAT contained applies", async () => {
    const items = [
      { description: "Servicio", gross: 12_100, vat: 21 },
    ] as const;
    const receiver = { name: "Cliente", address: "Calle 3" };
    for (const [condition, legend, transparency] of [
      [4, "IVA EXENTO", true],
      [5, "A CONSUMIDOR FINAL", true],
      [7, "SUJETO NO CATEGORIZADO", false],
      [8, "PROVEEDOR DEL EXTERIOR", false],
      [9, "CLIENTE DEL EXTERIOR", false],
      [10, "IVA LIBERADO - LEY Nº 19.640", false],
      [15, "NO RESPONSABLE IVA", true],
    ] as const) {
      const voucher = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition, cuit: "20111111112" },
        items,
      });
      const doc = document(voucher, items, { receiver });
      expect(doc.voucherClass).toBe("B");
      expect(doc.receiver.conditionLegend).toBe(legend);
      expect("transparency" in doc).toBe(transparency);
    }
  });

  it("refuses an unidentified receiver that is not a consumidor final", async () => {
    const items = [
      { description: "Servicio", gross: 12_100, vat: 21 },
    ] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: 7, document: { type: 99, number: 0 } },
      items,
    });
    expect(() =>
      document(voucher, items, {
        receiver: { name: "Cliente", address: "Calle 3" },
      })
    ).toThrow(
      expect.objectContaining({
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "voucher.header.documentNumber",
      })
    );
  });

  it("adds the discount back into a synthesized unit price", async () => {
    const items = [
      {
        description: "Servicio con bonificación",
        gross: 9000,
        vat: 21,
        discount: 1000,
      },
    ] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items,
    });
    expect(document(voucher, items).lines).toEqual([
      {
        description: "Servicio con bonificación",
        quantity: 1,
        unitPrice: "100.00",
        discount: 1000,
        amount: 9000,
      },
    ]);
    expect(() => document(voucher, [{ ...items[0], discount: -1 }])).toThrow(
      expect.objectContaining({
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "items[0].discount",
      })
    );
  });

  it("carries the exchange rate of a foreign-currency voucher and the note titles", async () => {
    const items = [
      { description: "Licencia", gross: 12_100, vat: 21 },
    ] as const;
    const voucher = await issued({
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "consumidor_final" },
      items,
      currency: "USD",
      exchangeRate: "1450.5",
    });
    expect(document(voucher, items).currency).toEqual({
      id: "DOL",
      exchangeRate: "1450.5",
    });
    for (const [voucherType, title] of [
      [7, "NOTA DE DÉBITO"],
      [8, "NOTA DE CRÉDITO"],
    ] as const) {
      expect(document({ ...voucher, voucherType }, items).title).toBe(title);
    }
  });

  describe("a global discount", () => {
    const company = {
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "responsable_inscripto", cuit: "20111111112" },
    } as const;
    const receiver = { name: "Cliente SA", address: "Calle 2" };

    it("prints class A lines before it and checks each rate against its authorized base", async () => {
      // The issuer took 10% off and split it its own way: 333, 333 and 334.
      const before = [
        { description: "Tornillos", net: 3333, vat: 21 },
        { description: "Tuercas", net: 3333, vat: 21 },
        { description: "Arandelas", net: 3334, vat: 21 },
        { description: "Manual", net: 2000, vat: 10.5 },
        { description: "Libro", net: 500, vat: "exempt" },
      ] as const;
      const voucher = await issued({
        ...company,
        items: [
          { net: 3000, vat: 21 },
          { net: 3000, vat: 21 },
          { net: 3000, vat: 21 },
          { net: 1800, vat: 10.5 },
          { net: 500, vat: "exempt" },
        ],
      });
      const doc = document(voucher, before, {
        receiver,
        globalDiscount: { 5: 1000, 4: 200 },
      });
      expect(doc.lines.map((line) => line.amount)).toEqual([
        3333, 3333, 3334, 2000, 500,
      ]);
      expect(doc.totals).toMatchObject({
        globalDiscount: 1200,
        subtotal: 10_800,
        exempt: 500,
        vatRates: [
          { id: 5, base: 9000, amount: 1890 },
          { id: 4, base: 1800, amount: 189 },
        ],
        adjustment: 0,
        total: 13_379,
      });
      expectBalanced(doc);
      // One cent moved to another rate is not what ARCA authorized.
      expect(() =>
        document(voucher, before, {
          receiver,
          globalDiscount: { 5: 999, 4: 201 },
        })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_AMOUNT_MISMATCH",
          field: "globalDiscount[5]",
        })
      );
    });

    it("prints class B lines and the discount with VAT", async () => {
      const before = [
        { description: "Remera", gross: 3333, vat: 21 },
        { description: "Remera", gross: 3333, vat: 21 },
        { description: "Remera", gross: 3333, vat: 21 },
      ] as const;
      const voucher = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items: [{ gross: 8999, vat: 21 }],
        taxes: [{ id: 4, base: 7437, rate: 8, amount: 595 }],
      });
      const doc = document(voucher, before, { globalDiscount: { 5: 1000 } });
      expect(doc.lines.map((line) => line.amount)).toEqual([3333, 3333, 3333]);
      expect(doc.totals).toMatchObject({
        globalDiscount: 1000,
        subtotal: 8999,
        adjustment: 0,
        total: 9594,
      });
      expect(doc.transparency).toEqual({
        vatContained: 1562,
        otherNationalIndirectTaxes: 595,
      });
      expectBalanced(doc);
    });

    it("prints a class C discount as one amount", async () => {
      const before = [
        { description: "Consulta", amount: 50_000 },
        { description: "Informe", amount: 20_000 },
      ] as const;
      const voucher = await issued({
        issuer: "monotributo",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items: [{ amount: 63_000 }],
      });
      const monotributo = {
        issuer: { ...registered, condition: "monotributo" },
      } as const;
      const doc = document(voucher, before, {
        ...monotributo,
        globalDiscount: 7000,
      });
      expect(doc.totals).toMatchObject({
        globalDiscount: 7000,
        subtotal: 63_000,
        total: 63_000,
      });
      expectBalanced(doc);
      expect(() =>
        document(voucher, before, { ...monotributo, globalDiscount: 6999 })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_AMOUNT_MISMATCH",
          field: "globalDiscount",
        })
      );
      expect(() =>
        document(voucher, before, {
          ...monotributo,
          globalDiscount: { 5: 7000 },
        })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "globalDiscount",
        })
      );
    });

    it("takes none off exempt lines, and reads a zero discount as none", async () => {
      const items = [
        { description: "Servicio", net: 10_000, vat: 21 },
        { description: "Libro", net: 500, vat: "exempt" },
      ] as const;
      const voucher = await issued({
        ...company,
        items: [
          { net: 9000, vat: 21 },
          { net: 450, vat: "exempt" },
        ],
      });
      expect(() =>
        document(voucher, items, { receiver, globalDiscount: { 5: 1000 } })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_AMOUNT_MISMATCH",
          field: "items (exempt)",
        })
      );
      const plain = await issued({ ...company, items });
      expect(
        document(plain, items, { receiver, globalDiscount: { 5: 0 } }).totals
          .globalDiscount
      ).toBe(0);
    });

    it.each([
      ["one amount on class A", 1000, "globalDiscount", "INVALID_VALUE"],
      [
        "a key that is no VAT rate id",
        { 21: 1000 },
        "globalDiscount[21]",
        "INVALID_VALUE",
      ],
      [
        "a rate the items do not carry",
        { 4: 0, 6: 1000 },
        "globalDiscount[6]",
        "INVALID_VALUE",
      ],
      ["a negative amount", { 5: -1000 }, "globalDiscount[5]", "INVALID_VALUE"],
      [
        "a fractional amount",
        { 5: 10.5 },
        "globalDiscount[5]",
        "INVALID_VALUE",
      ],
    ] as const)("refuses %s", async (_, globalDiscount, field, code) => {
      const items = [
        { description: "Servicio", net: 10_000, vat: 21 },
      ] as const;
      const voucher = await issued({
        ...company,
        items: [{ net: 9000, vat: 21 }],
      });
      expect(() =>
        document(voucher, items, { receiver, globalDiscount })
      ).toThrow(expect.objectContaining({ code: `ARCA_INPUT_${code}`, field }));
    });
  });

  describe("labeled adjustments", () => {
    const receiver = { name: "Cliente SA", address: "Calle 2" };

    it.each(["A", "B", "C"] as const)(
      "keeps class %s prices and signed rows on invoices, credit and debit notes",
      async (voucherClass) => {
        for (const amount of [50, -55]) {
          const items =
            voucherClass === "C"
              ? [{ description: "Consulta", amount: 10_000 }]
              : voucherClass === "A"
                ? [{ description: "Servicio", net: 10_000, vat: 21 as const }]
                : [
                    {
                      description: "Servicio",
                      gross: 10_000,
                      vat: 21 as const,
                    },
                  ];
          const voucher = await issued(
            voucherClass === "C"
              ? {
                  issuer: "monotributo",
                  salesPoint: 3,
                  to: { condition: "consumidor_final" },
                  items: [{ amount: 10_000 + amount }],
                }
              : {
                  issuer: "responsable_inscripto",
                  salesPoint: 3,
                  to:
                    voucherClass === "A"
                      ? {
                          condition: "responsable_inscripto",
                          cuit: "20111111112",
                        }
                      : { condition: "consumidor_final" },
                  items:
                    voucherClass === "A"
                      ? [{ net: 10_000 + amount, vat: 21 }]
                      : [{ gross: 10_000 + amount, vat: 21 }],
                }
          );
          for (const offset of [0, 1, 2]) {
            const doc = document(
              { ...voucher, voucherType: voucher.voucherType + offset },
              items,
              {
                issuer: {
                  ...registered,
                  condition:
                    voucherClass === "C"
                      ? "monotributo"
                      : "responsable_inscripto",
                },
                receiver,
                adjustments: [
                  {
                    label: " Ajuste por redondeo ",
                    amount: voucherClass === "C" ? amount : { 5: amount },
                  },
                ],
              }
            );
            expect(doc.lines[0]).toMatchObject({
              amount: 10_000,
              unitPrice: "100.00",
            });
            expect(doc.totals.adjustments).toEqual([
              { label: "Ajuste por redondeo", amount },
            ]);
            expect(doc.totals.subtotal).toBe(10_000 + amount);
            expect(doc.totals.adjustment).toBe(0);
            expectBalanced(doc);
          }
        }
      }
    );

    it.each(["A", "B"] as const)(
      "reconciles multiple signed changes with a global discount per rate on %s",
      async (voucherClass) => {
        const money = (
          amount: number,
          vat: 21 | 10.5 | "exempt" | "untaxed"
        ) =>
          voucherClass === "A" ? { net: amount, vat } : { gross: amount, vat };
        const items = [
          { description: "Servicio", ...money(10_000, 21) },
          { description: "Repuesto", ...money(4000, 10.5) },
          { description: "Libro", ...money(500, "exempt") },
          { description: "No gravado", ...money(200, "untaxed") },
        ];
        const voucher = await issued({
          issuer: "responsable_inscripto",
          salesPoint: 3,
          to:
            voucherClass === "A"
              ? { condition: "responsable_inscripto", cuit: "20111111112" }
              : { condition: "consumidor_final" },
          items: [
            money(9100, 21),
            money(3750, 10.5),
            money(500, "exempt"),
            money(200, "untaxed"),
          ],
          taxes: [{ id: 2, base: 10_000, rate: 3, amount: 300 }],
        });
        const options = {
          receiver,
          globalDiscount: { 5: 1000, 4: 200 },
          adjustments: [
            { label: "Ajuste por redondeo", amount: { 5: 200, 4: -100 } },
            { label: "Corrección", amount: { 5: -100, 4: 50 } },
          ],
        };
        const doc = document(voucher, items, options);
        expect(doc.lines.map((line) => line.amount)).toEqual([
          10_000, 4000, 500, 200,
        ]);
        expect(doc.totals.adjustments).toEqual([
          { label: "Ajuste por redondeo", amount: 100 },
          { label: "Corrección", amount: -50 },
        ]);
        expectBalanced(doc);
        // The aggregate is unchanged, but one cent belongs to the wrong rate.
        expect(() =>
          document(voucher, items, {
            ...options,
            adjustments: [{ label: "Ajuste", amount: { 5: 101, 4: -51 } }],
          })
        ).toThrow(
          expect.objectContaining({
            code: "ARCA_INPUT_AMOUNT_MISMATCH",
            field: "adjustments (VAT rate 5)",
          })
        );
        if (voucherClass === "B") {
          expect(doc.transparency?.vatContained).toBe(voucher.totals.vat);
        }
      }
    );

    it("combines a class C discount and positive and negative adjustments", async () => {
      const voucher = await issued({
        issuer: "monotributo",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items: [{ amount: 9150 }],
      });
      const items = [{ description: "Consulta", amount: 10_000 }];
      const options = {
        issuer: { ...registered, condition: "monotributo" as const },
        globalDiscount: 1000,
        adjustments: [
          { label: "Ajuste", amount: 200 },
          { label: "Corrección", amount: -50 },
        ],
      };
      expectBalanced(document(voucher, items, options));
      expect(() =>
        document(voucher, items, {
          ...options,
          adjustments: [{ label: "Ajuste", amount: 151 }],
        })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_AMOUNT_MISMATCH",
          field: "adjustments",
        })
      );
      expect(() =>
        document(voucher, items, {
          ...options,
          adjustments: [{ label: "Ajuste", amount: { 5: 150 } }],
        })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "adjustments[0].amount",
        })
      );
    });

    it("prints the test sale's shelf prices and each partial credit's rounding share", async () => {
      for (const [amounts, rounding] of [
        [[45_000, 5_460_000], 5000],
        [[45_000], 41],
        [[5_460_000], 4959],
      ] as const) {
        const items = amounts.map((gross) => ({
          description: "Artículo",
          gross,
          vat: 21 as const,
        }));
        const voucher = await issued({
          issuer: "responsable_inscripto",
          salesPoint: 3,
          to: { condition: "consumidor_final" },
          items: [
            {
              gross: amounts.reduce((sum, gross) => sum + gross, 0) + rounding,
              vat: 21,
            },
          ],
        });
        const doc = document(
          { ...voucher, voucherType: amounts.length === 1 ? 8 : 6 },
          items,
          {
            adjustments: [
              { label: "Ajuste por redondeo", amount: { 5: rounding } },
            ],
          }
        );
        expect(doc.lines.map((line) => line.amount)).toEqual(amounts);
        expect(doc.totals.adjustments).toEqual([
          { label: "Ajuste por redondeo", amount: rounding },
        ]);
        expectBalanced(doc);
      }
    });

    it("keeps a zero-sum change between rates and rejects cancellation on an absent rate", async () => {
      const items = [
        { description: "Servicio", gross: 10_000, vat: 21 },
        { description: "Repuesto", gross: 4000, vat: 10.5 },
      ] as const;
      const voucher = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items: [
          { gross: 10_100, vat: 21 },
          { gross: 3900, vat: 10.5 },
        ],
      });
      const doc = document(voucher, items, {
        adjustments: [{ label: "Redistribución", amount: { 5: 100, 4: -100 } }],
      });
      expect(doc.totals.adjustments).toEqual([
        { label: "Redistribución", amount: 0 },
      ]);
      expectBalanced(doc);
      expect(() =>
        document(voucher, items, {
          adjustments: [
            { label: "Ajuste", amount: { 5: 100, 4: -100, 6: 1 } },
            { label: "Reversión", amount: { 6: -1 } },
          ],
        })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "adjustments[0].amount[6]",
        })
      );
    });

    it("preserves documents with no adjustments, an empty array or all-zero amounts", async () => {
      const items = [
        { description: "Servicio", gross: 12_100, vat: 21 },
      ] as const;
      const voucher = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items,
        total: 12_101,
      });
      const plain = document(voucher, items);
      expect(plain.totals).not.toHaveProperty("adjustments");
      expect(document(voucher, items, { adjustments: [] })).toEqual(plain);
      expect(
        document(voucher, items, {
          adjustments: [{ label: "Ajuste", amount: { 5: 0 } }],
        })
      ).toEqual(plain);
    });

    it.each([
      [
        "a scalar on B",
        [{ label: "Ajuste", amount: 10 }],
        "adjustments[0].amount",
      ],
      [
        "a percentage as key",
        [{ label: "Ajuste", amount: { 21: 10 } }],
        "adjustments[0].amount[21]",
      ],
      [
        "a fractional amount",
        [{ label: "Ajuste", amount: { 5: -0.5 } }],
        "adjustments[0].amount[5]",
      ],
      [
        "an unsafe amount",
        [{ label: "Ajuste", amount: { 5: Number.MAX_SAFE_INTEGER + 1 } }],
        "adjustments[0].amount[5]",
      ],
      [
        "an unsafe sum",
        [{ label: "Ajuste", amount: { 5: Number.MAX_SAFE_INTEGER, 4: 1 } }],
        "adjustments[0].amount",
      ],
      [
        "a null amount",
        [{ label: "Ajuste", amount: null }],
        "adjustments[0].amount",
      ],
      ["a null row", [null], "adjustments[0]"],
      ["a non-array", {}, "adjustments"],
    ])("refuses %s", async (_, adjustments, field) => {
      const items = [
        { description: "Servicio", gross: 12_100, vat: 21 },
      ] as const;
      const voucher = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items,
      });
      expect(() =>
        document(voucher, items, {
          adjustments: adjustments as VoucherDocumentInput["adjustments"],
        })
      ).toThrow(
        expect.objectContaining({ code: "ARCA_INPUT_INVALID_VALUE", field })
      );
      expect(() =>
        document(voucher, items, {
          adjustments: [{ label: " ", amount: { 5: 1 } }],
        })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_MISSING_FIELD",
          field: "adjustments[0].label",
        })
      );
    });
  });

  describe("refuses what it cannot print correctly", () => {
    const items = [
      { description: "Servicio", gross: 12_100, vat: 21 },
    ] as const;
    let voucher: IssuedVoucher;
    beforeEach(async () => {
      voucher = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition: "consumidor_final" },
        items,
      });
    });

    it.each([
      [
        "items that are not the issued ones",
        () =>
          document(voucher, [{ description: "Otro", gross: 12_000, vat: 21 }]),
        "ARCA_INPUT_AMOUNT_MISMATCH",
      ],
      [
        "an item without description",
        () => document(voucher, [{ gross: 12_100, vat: 21 }]),
        "ARCA_INPUT_MISSING_FIELD",
      ],
      [
        "a unit price that does not give the line amount",
        () =>
          document(voucher, [{ ...items[0], quantity: 2, unitPrice: "50.00" }]),
        "ARCA_INPUT_AMOUNT_MISMATCH",
      ],
      [
        "an issuer that cannot issue class B",
        () =>
          document(voucher, items, {
            issuer: { ...registered, condition: "monotributo" },
          }),
        "ARCA_INPUT_INVALID_VALUE",
      ],
      [
        "another issuer's CUIT",
        () =>
          document(voucher, items, {
            issuer: { ...registered, taxId: "30-71234567-1" },
          }),
        "ARCA_INPUT_INVALID_VALUE",
      ],
      [
        "a missing ingresos brutos number",
        () =>
          document(voucher, items, {
            issuer: { ...registered, grossIncome: " " },
          }),
        "ARCA_INPUT_MISSING_FIELD",
      ],
      [
        "missing sale conditions",
        () => document(voucher, items, { saleConditions: "" }),
        "ARCA_INPUT_MISSING_FIELD",
      ],
      [
        "an FCE voucher",
        () => document({ ...voucher, voucherType: 206 }, items),
        "ARCA_INPUT_INVALID_VALUE",
      ],
      [
        "a voucher without QR",
        () => document({ ...voucher, qr: undefined }, items),
        "ARCA_INPUT_INVALID_VALUE",
      ],
    ])("%s", (_, build, code) => {
      expect(build).toThrow(expect.objectContaining({ code }));
    });

    it("an identified receiver without name and address", async () => {
      const toCompany = await issued({
        issuer: "responsable_inscripto",
        salesPoint: 3,
        to: { condition: "responsable_inscripto", cuit: "20111111112" },
        items: [{ description: "Servicio", net: 10_000, vat: 21 }],
      });
      expect(() =>
        document(toCompany, [{ description: "Servicio", net: 10_000, vat: 21 }])
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_MISSING_FIELD",
          field: "receiver.name",
        })
      );
    });
  });

  describe("legends next to the letter and ARCA observations", () => {
    const items = [{ description: "Servicio", net: 10_000, vat: 21 }] as const;
    const receiver = { name: "Cliente SA", address: "Calle 2" };
    const toCompany = {
      issuer: "responsable_inscripto",
      salesPoint: 3,
      to: { condition: "responsable_inscripto", cuit: "20111111112" },
      items,
    } as const;

    it("prints OPERACIÓN SUJETA A RETENCIÓN on types 51 to 53 (RG 5762, art. 10)", async () => {
      const voucher = await issued({
        ...toCompany,
        family: "retention_legend",
      });
      const doc = document(voucher, items, { receiver });
      expect(doc).toMatchObject({
        voucherClass: "A",
        code: "051",
        title: "FACTURA",
        letterLegend: "OPERACIÓN SUJETA A RETENCIÓN",
      });
      expect(() =>
        document({ ...voucher, date: "2025-11-30" }, items, { receiver })
      ).toThrow(
        expect.objectContaining({
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "voucher.voucherType",
        })
      );
    });

    it("prints PAGO EN CBU INFORMADA on class A only, for an issuer that opted for it (RG 5762, art. 21)", async () => {
      const issuer = { ...registered, paymentToInformedCbu: true };
      const classA = await issued(toCompany);
      expect(document(classA, items, { issuer, receiver }).letterLegend).toBe(
        "PAGO EN CBU INFORMADA"
      );
      expect(document(classA, items, { receiver })).not.toHaveProperty(
        "letterLegend"
      );
      const consumerItems = [
        { description: "Servicio", gross: 12_100, vat: 21 },
      ] as const;
      const classB = await issued({
        ...toCompany,
        to: { condition: "consumidor_final" },
        items: consumerItems,
      });
      expect(document(classB, consumerItems, { issuer })).not.toHaveProperty(
        "letterLegend"
      );
    });

    it("prints the codes of ARCA's observations on class A (RG 4291, art. 14 c))", async () => {
      const voucher = await issued({
        ...toCompany,
        to: { condition: "monotributo", cuit: "20111111112" },
      });
      const observations = [
        { code: "10217", message: "El crédito fiscal…" },
        { code: 10_217 },
        { code: "10063" },
        { message: "sin código" },
      ];
      expect(
        document(voucher, items, { receiver, observations }).legends
      ).toEqual([
        { rule: "G1", text: MONOTRIBUTO_CREDIT_LEGEND },
        { rule: "G3", text: "Observaciones de ARCA: 10217, 10063" },
      ]);
      const consumerItems = [
        { description: "Servicio", gross: 12_100, vat: 21 },
      ] as const;
      const classB = await issued({
        ...toCompany,
        to: { condition: "consumidor_final" },
        items: consumerItems,
      });
      expect(document(classB, consumerItems, { observations }).legends).toEqual(
        []
      );
    });
  });
});
