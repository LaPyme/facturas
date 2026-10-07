import {
  arcaQrPayload,
  arcaQrUrl,
  buildVoucherDocument,
  type IssuedVoucher,
  type VoucherDocument,
  type VoucherDocumentInput,
} from "facturas";

/** Authorized vouchers as `issue()` answers them, for rendering tests. */

const ISSUER = {
  legalName: "Ferretería del Sur SRL",
  tradeName: "Ferretería del Sur",
  address: "Av. Rivadavia 1234, CABA",
  taxId: "20123456789",
  condition: "responsable_inscripto",
  grossIncome: "901-123456-7",
  activitiesStartDate: "2019-10-01",
} as const satisfies VoucherDocumentInput["issuer"];

function voucher(
  overrides: Pick<IssuedVoucher, "voucherType" | "voucherClass" | "totals"> & {
    header?: Partial<IssuedVoucher["header"]>;
  }
): IssuedVoucher {
  const header: IssuedVoucher["header"] = {
    concept: 1,
    documentType: 99,
    documentNumber: "0",
    receiverVatConditionId: 5,
    currencyId: "PES",
    ...overrides.header,
  };
  const qrInput = {
    taxId: ISSUER.taxId,
    salesPoint: 3,
    voucherType: overrides.voucherType,
    number: 41,
    date: "2026-09-05",
    total: overrides.totals.total,
    cae: "74123456789012",
    document: {
      type: header.documentType,
      number: header.documentNumber,
    },
  };
  return {
    salesPoint: 3,
    number: 41,
    voucherType: overrides.voucherType,
    voucherClass: overrides.voucherClass,
    date: "2026-09-05",
    header,
    cae: "74123456789012",
    caeExpiry: "2026-09-15",
    amounts: {
      computedTotal: overrides.totals.total - overrides.totals.otherTaxes,
      sentTotal: overrides.totals.total - overrides.totals.otherTaxes,
      vatAdjustment: 0,
    },
    totals: overrides.totals,
    qr: arcaQrUrl(qrInput),
    qrPayload: arcaQrPayload(qrInput),
  };
}

/** Class B to a consumidor final: transparency block, gross lines. */
export function classBDocument(): VoucherDocument {
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
  return buildVoucherDocument({
    voucher: voucher({
      voucherType: 6,
      voucherClass: "B",
      totals: {
        total: 123_420,
        netTaxed: 102_190,
        untaxed: 0,
        exempt: 0,
        vat: 21_230,
        otherTaxes: 0,
        vatRates: [
          { id: 5, rate: 21, base: 100_000, amount: 21_000 },
          { id: 4, rate: 10.5, base: 2190, amount: 230 },
        ],
        taxes: [],
      },
    }),
    items,
    issuer: ISSUER,
    saleConditions: "Contado",
    remitos: ["0003-00000012"],
  });
}

/** Class A to a monotributo receiver: VAT by rate, G1, a tribute. */
export function classADocument(): VoucherDocument {
  const items = [
    {
      description: "Servicio de instalación",
      code: "SRV-01",
      net: 10_000,
      vat: 21,
    },
    { description: "Repuestos", code: "REP-07", net: 4000, vat: 10.5 },
  ] as const;
  return buildVoucherDocument({
    voucher: voucher({
      voucherType: 1,
      voucherClass: "A",
      header: {
        documentType: 80,
        documentNumber: "20111111112",
        receiverVatConditionId: 6,
      },
      totals: {
        total: 16_820,
        netTaxed: 14_000,
        untaxed: 0,
        exempt: 0,
        vat: 2520,
        otherTaxes: 300,
        vatRates: [
          { id: 5, rate: 21, base: 10_000, amount: 2100 },
          { id: 4, rate: 10.5, base: 4000, amount: 420 },
        ],
        taxes: [
          { id: 2, description: "IIBB", base: 10_000, rate: 3, amount: 300 },
        ],
      },
    }),
    items,
    issuer: ISSUER,
    receiver: { name: "Juan Pérez", address: "Calle 1, Rosario" },
    saleConditions: "Cuenta corriente",
    observations: [{ code: "10217" }],
  });
}

/** Class C from a monotributo issuer, without start of activities. */
export function classCDocument(): VoucherDocument {
  const items = [{ description: "Consulta", amount: 50_000 }] as const;
  return buildVoucherDocument({
    voucher: voucher({
      voucherType: 11,
      voucherClass: "C",
      header: { documentType: 96, documentNumber: "30111222" },
      totals: {
        total: 50_000,
        netTaxed: 50_000,
        untaxed: 0,
        exempt: 0,
        vat: 0,
        otherTaxes: 0,
        vatRates: [],
        taxes: [],
      },
    }),
    items,
    issuer: { ...ISSUER, condition: "monotributo", activitiesStartDate: null },
    saleConditions: "Contado",
  });
}

/** A long class B voucher that spills onto a second page. */
export function longDocument(): VoucherDocument {
  const items = Array.from({ length: 60 }, (_, index) => ({
    description: `Artículo ${index + 1}`,
    gross: 1210,
    vat: 21 as const,
  }));
  return buildVoucherDocument({
    voucher: voucher({
      voucherType: 6,
      voucherClass: "B",
      totals: {
        total: 72_600,
        netTaxed: 60_000,
        untaxed: 0,
        exempt: 0,
        vat: 12_600,
        otherTaxes: 0,
        vatRates: [{ id: 5, rate: 21, base: 60_000, amount: 12_600 }],
        taxes: [],
      },
    }),
    items,
    issuer: ISSUER,
    saleConditions: "Contado",
  });
}
