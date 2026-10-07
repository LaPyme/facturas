import { ArcaInputError } from "../errors";
import { normalizeArcaAmountToMinorUnits } from "../internal/decimal";
import { describeVoucherType } from "./issuance-fields";
import type { IssuedVoucher, VoucherTotals } from "./vouchers-types";
import {
  type AmountItem,
  calculateWsfeAmounts,
  settleVatItems,
  type VatItem,
  type VatRate,
} from "./wsfe-amounts";

/**
 * Fixed texts a printed voucher carries, as the norms word them. Rule ids
 * refer to `.github/PRINTED_VOUCHER_SOURCES.md`.
 */
export const PRINTED_VOUCHER_TEXT = {
  /** L4, before the voucher type code. */
  code: "Código Nº",
  /** C7, before the start of activities. */
  activitiesStart: "INICIO DE ACTIVIDADES",
  /** C8 and L9, before the CAE. */
  cae: "C.A.E. N°",
  /** C9 and L9, before the CAE due date, in type of at least 12 pt. */
  caeDueDate: "Fecha Vto.:",
  /** L8, the title of the consumer transparency block. */
  transparencyTitle:
    "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)",
  /** L8, the VAT contained in the price. */
  vatContained: "IVA Contenido",
  /** L8 and C24, the other national indirect taxes. */
  otherNationalIndirectTaxes: "Otros Impuestos Nacionales Indirectos",
} as const;

/** L9 asks for at least this type size for the CAE due date. */
export const PRINTED_CAE_DUE_DATE_MIN_FONT_SIZE_PT = 12;

/** The issuer conditions a printed voucher can name (C5). */
export type PrintedIssuerCondition =
  | "responsable_inscripto"
  | "exento"
  | "no_alcanzado"
  | "monotributo"
  | "monotributo_social"
  | "monotributo_trabajador_independiente_promovido";

export type VoucherDocumentInput = {
  /** The voucher `issue()`, a note method or `recover()` answered authorized. */
  voucher: IssuedVoucher;
  /** The same items the voucher was issued from, each with its description. */
  items: readonly (VatItem | AmountItem)[];
  issuer: {
    /** C1. */
    legalName: string;
    /** L1, only when the issuer has one. */
    tradeName?: string;
    /** C2: where the voucher is issued, or the fiscal address for travelling sellers. */
    address: string;
    /** C3, checked against the voucher's QR. */
    taxId: string;
    /** C5. */
    condition: PrintedIssuerCondition;
    /** C4: the ingresos brutos number, or the non-contributor condition. */
    grossIncome: string;
    /**
     * C7 as `YYYY-MM-DD`. `null` only for university professionals billing
     * their fees and service providers without premises (Anexo II, A, V 6).
     */
    activitiesStartDate: string | null;
    /**
     * G5: the issuer opted to issue class A "PAGO EN CBU INFORMADA" (RG 5762,
     * art. 20 and 21). Only class A vouchers print it.
     */
    paymentToInformedCbu?: boolean;
  };
  /**
   * G3: the observations ARCA returned with the CAE, as
   * `authorization.observations` of an `authorized` outcome carries them. On a
   * class A voucher their codes are printed (RG 4291, art. 12 and 14 c)).
   */
  observations?: readonly { code?: string | number }[];
  /** C13 to C17. Name and address are required unless the receiver is a consumidor final. */
  receiver?: { name?: string; address?: string };
  /** L6: contado, cuenta corriente and so on. */
  saleConditions: string;
  /** C12: the remitos issued for the operation, when there are any. */
  remitos?: readonly string[];
};

export type VoucherDocumentLine = {
  code?: string;
  description: string;
  quantity: number;
  unit?: number;
  /** Major-unit decimal string: without VAT on class A, with VAT on class B. */
  unitPrice: string;
  discount?: number;
  /** Minor units: without VAT on class A, with VAT on class B, as issued on class C. */
  amount: number;
  /** Class A only: the line's rate, `exempt` or `untaxed`. */
  vatRate?: VatRate;
};

/**
 * Everything a printed voucher shows, derived and checked. Money is in minor
 * units of the voucher currency and dates are `YYYY-MM-DD`. Formatting and
 * layout belong to the renderer.
 */
export type VoucherDocument = {
  voucherClass: "A" | "B" | "C";
  voucherType: number;
  /** L4: the type code, three digits. */
  code: string;
  /** G4 and G5: the legend printed next to the letter A, when there is one. */
  letterLegend?: "OPERACIÓN SUJETA A RETENCIÓN" | "PAGO EN CBU INFORMADA";
  title: "FACTURA" | "NOTA DE DÉBITO" | "NOTA DE CRÉDITO";
  /** C6: sales point and number, `00003-00000041`. */
  number: string;
  /** C11. */
  issueDate: string;
  issuer: {
    tradeName?: string;
    legalName: string;
    address: string;
    taxId: string;
    conditionLegend: string;
    grossIncome: string;
    activitiesStartDate?: string;
  };
  receiver: {
    conditionLegend: string;
    name?: string;
    address?: string;
    /** Absent for an unidentified consumidor final. */
    document?: { type: number; label?: string; number: string };
  };
  saleConditions: string;
  remitos: string[];
  /** Concepts 2 and 3. */
  servicePeriod?: { from: string; to: string };
  paymentDueDate?: string;
  /** C22: the exchange rate is present for any currency but pesos. */
  currency: { id: string; exchangeRate?: string };
  lines: VoucherDocumentLine[];
  totals: {
    /** Class A: net taxed. Class B: the lines with VAT. Class C: the lines. */
    subtotal: number;
    exempt: number;
    untaxed: number;
    /** C25 and L7, class A only: one row per rate, as authorized. */
    vatRates: { id: number; rate?: number; base: number; amount: number }[];
    /** C23: ARCA's Tributos. */
    otherTaxes: { id: number; description: string; amount: number }[];
    /** C23: a VAT adjustment of the header that no line could carry. */
    adjustment: number;
    total: number;
  };
  /** L8 and G2, class B only. */
  transparency?: { vatContained: number; otherNationalIndirectTaxes: number };
  /** C8, C9 and L9. */
  authorization: { kind: "CAE"; code: string; dueDate: string };
  /** Q1 and Q2. */
  qr: string;
  /** Conditional legends, in order, each with its rule id. */
  legends: { rule: "G1" | "G3"; text: string }[];
};

const ISSUER_LEGENDS: Record<PrintedIssuerCondition, string> = {
  responsable_inscripto: "IVA RESPONSABLE INSCRIPTO",
  exento: "IVA EXENTO",
  no_alcanzado: "NO RESPONSABLE IVA",
  monotributo: "RESPONSABLE MONOTRIBUTO",
  monotributo_social: "MONOTRIBUTISTA SOCIAL",
  monotributo_trabajador_independiente_promovido:
    "MONOTRIBUTO TRABAJADOR INDEPENDIENTE PROMOVIDO",
};

/** ARCA receiver IVA condition ids and their C13 to C17 legends. */
const RECEIVER_LEGENDS: Record<number, string> = {
  1: "IVA RESPONSABLE INSCRIPTO",
  4: "IVA EXENTO",
  5: "A CONSUMIDOR FINAL",
  6: "RESPONSABLE MONOTRIBUTO",
  7: "SUJETO NO CATEGORIZADO",
  // Apartado A names no legend for these: ARCA's own condition names.
  8: "PROVEEDOR DEL EXTERIOR",
  9: "CLIENTE DEL EXTERIOR",
  10: "IVA LIBERADO - LEY Nº 19.640",
  13: "MONOTRIBUTISTA SOCIAL",
  15: "NO RESPONSABLE IVA",
  16: "MONOTRIBUTO TRABAJADOR INDEPENDIENTE PROMOVIDO",
};
const CONSUMIDOR_FINAL = 5;
/** C26 and G2: exento, consumidor final and no alcanzado. */
const VAT_CONTAINED_RECEIVERS = new Set([4, 5, 15]);
const MONOTRIBUTO_RECEIVERS = new Set([6, 13, 16]);

const DOCUMENT_LABELS: Record<number, string> = {
  80: "CUIT",
  86: "CUIL",
  87: "CDI",
  94: "Pasaporte",
  96: "DNI",
};
const UNIDENTIFIED_DOCUMENT = 99;

/** G3: precedes the codes of the observations ARCA returned with the CAE. */
const ARCA_OBSERVATIONS_LABEL = "Observaciones de ARCA:";

/** G1: RG 1415, art. 15, inc. a), as replaced by RG 5003, art. 20. */
export const MONOTRIBUTO_CREDIT_LEGEND =
  "El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley Nº 27.618";

/** ARCA tributo ids read as national indirect taxes: Impuestos nacionales and Impuestos internos. */
const NATIONAL_INDIRECT_TAX_IDS = new Set([1, 4]);
const TAX_NAMES: Record<number, string> = {
  1: "Impuestos nacionales",
  2: "Impuestos provinciales",
  3: "Impuestos municipales",
  4: "Impuestos internos",
  5: "Ingresos brutos",
  6: "Percepción de IVA",
  7: "Percepción de ingresos brutos",
  8: "Percepciones por impuestos municipales",
  9: "Otras percepciones",
  13: "Percepción de IVA a no categorizado",
  99: "Otros tributos",
};

/** RG 5762 replaced class M by class A with retention legend on this date. */
const RETENTION_LEGEND_FROM = "2025-12-01";

const TITLES = {
  invoice: "FACTURA",
  debit_note: "NOTA DE DÉBITO",
  credit_note: "NOTA DE CRÉDITO",
} as const;

/**
 * Derives what a printed class A, B or C voucher must show from the
 * authorized voucher, the items it was issued from and the issuer's profile.
 * Pure. It throws `ArcaInputError` when a required datum is missing, when the
 * items do not add up to the authorized money, or for a voucher it does not
 * render: FCE, and class M vouchers issued before 2025-12-01.
 */
export function buildVoucherDocument(
  input: VoucherDocumentInput
): VoucherDocument {
  const { voucher, issuer } = input;
  const info = describeVoucherType(voucher.voucherType);
  if (info.family === "fce") {
    invalid(
      "voucher.voucherType",
      "a class A, B or C invoice or note: FCE vouchers are not rendered yet"
    );
  }
  if (
    info.family === "retention_legend" &&
    voucher.date < RETENTION_LEGEND_FROM
  ) {
    invalid(
      "voucher.voucherType",
      "a voucher issued from 2025-12-01: types 51 to 53 were class M before RG 5762"
    );
  }
  const voucherClass = voucher.voucherClass;
  assertIssuerMatchesClass(issuer.condition, voucherClass);
  if (voucher.qr === undefined) {
    invalid("voucher.qr", "the QR every printed voucher carries");
  }
  const taxId = digits(issuer.taxId);
  if (
    taxId.length !== 11 ||
    (voucher.qrPayload !== undefined &&
      String(voucher.qrPayload.cuit) !== taxId)
  ) {
    invalid("issuer.taxId", "the 11-digit CUIT the voucher was issued under");
  }
  const lines = documentLines(input, voucherClass);
  const header = voucher.header;
  const receiver = documentReceiver(input, header);
  return {
    voucherClass,
    voucherType: voucher.voucherType,
    code: String(voucher.voucherType).padStart(3, "0"),
    ...letterLegend(info.family, voucherClass, issuer.paymentToInformedCbu),
    title: TITLES[info.kind],
    number: `${String(voucher.salesPoint).padStart(5, "0")}-${String(voucher.number).padStart(8, "0")}`,
    issueDate: voucher.date,
    issuer: {
      ...(issuer.tradeName
        ? { tradeName: required(issuer.tradeName, "issuer.tradeName") }
        : {}),
      legalName: required(issuer.legalName, "issuer.legalName"),
      address: required(issuer.address, "issuer.address"),
      taxId,
      conditionLegend: ISSUER_LEGENDS[issuer.condition],
      grossIncome: required(issuer.grossIncome, "issuer.grossIncome"),
      ...activitiesStart(issuer.activitiesStartDate),
    },
    receiver,
    saleConditions: required(input.saleConditions, "saleConditions"),
    remitos: (input.remitos ?? []).map((remito, index) =>
      required(remito, `remitos[${index}]`)
    ),
    ...(header.serviceStartDate && header.serviceEndDate
      ? {
          servicePeriod: {
            from: header.serviceStartDate,
            to: header.serviceEndDate,
          },
        }
      : {}),
    ...(header.paymentDueDate ? { paymentDueDate: header.paymentDueDate } : {}),
    currency: {
      id: header.currencyId,
      ...(header.currencyId !== "PES" && header.exchangeRate !== undefined
        ? { exchangeRate: header.exchangeRate }
        : {}),
    },
    lines: lines.lines,
    totals: {
      subtotal: lines.subtotal,
      exempt: voucher.totals.exempt,
      untaxed: voucher.totals.untaxed,
      vatRates: voucherClass === "A" ? voucher.totals.vatRates : [],
      otherTaxes: voucher.totals.taxes.map((tax) => ({
        id: tax.id,
        description: tax.description ?? TAX_NAMES[tax.id] ?? "Otros tributos",
        amount: tax.amount,
      })),
      adjustment: lines.adjustment,
      total: voucher.totals.total,
    },
    ...(voucherClass === "B" &&
    VAT_CONTAINED_RECEIVERS.has(header.receiverVatConditionId)
      ? {
          transparency: {
            vatContained: voucher.totals.vat,
            otherNationalIndirectTaxes: voucher.totals.taxes
              .filter((tax) => NATIONAL_INDIRECT_TAX_IDS.has(tax.id))
              .reduce((sum, tax) => sum + tax.amount, 0),
          },
        }
      : {}),
    authorization: {
      kind: "CAE",
      code: voucher.cae,
      dueDate: voucher.caeExpiry,
    },
    qr: voucher.qr,
    legends: legends(input, voucherClass),
  };
}

function letterLegend(
  family: string,
  voucherClass: "A" | "B" | "C",
  paymentToInformedCbu: boolean | undefined
): Pick<VoucherDocument, "letterLegend"> {
  if (family === "retention_legend") {
    return { letterLegend: "OPERACIÓN SUJETA A RETENCIÓN" };
  }
  return voucherClass === "A" && paymentToInformedCbu === true
    ? { letterLegend: "PAGO EN CBU INFORMADA" }
    : {};
}

function legends(
  input: VoucherDocumentInput,
  voucherClass: "A" | "B" | "C"
): VoucherDocument["legends"] {
  if (voucherClass !== "A") {
    return [];
  }
  const found: VoucherDocument["legends"] = [];
  if (MONOTRIBUTO_RECEIVERS.has(input.voucher.header.receiverVatConditionId)) {
    found.push({ rule: "G1", text: MONOTRIBUTO_CREDIT_LEGEND });
  }
  const codes = [
    ...new Set(
      (input.observations ?? [])
        .map((observation) => String(observation.code ?? "").trim())
        .filter((code) => code !== "")
    ),
  ];
  if (codes.length > 0) {
    found.push({
      rule: "G3",
      text: `${ARCA_OBSERVATIONS_LABEL} ${codes.join(", ")}`,
    });
  }
  return found;
}

function assertIssuerMatchesClass(
  condition: PrintedIssuerCondition,
  voucherClass: "A" | "B" | "C"
): void {
  if (!Object.hasOwn(ISSUER_LEGENDS, condition)) {
    invalid("issuer.condition", Object.keys(ISSUER_LEGENDS).join(", "));
  }
  const vatRegistered = condition === "responsable_inscripto";
  if (vatRegistered !== (voucherClass !== "C")) {
    invalid(
      "issuer.condition",
      vatRegistered
        ? "a condition that issues class C vouchers"
        : "responsable_inscripto, the only condition that issues class A and B vouchers"
    );
  }
}

function documentReceiver(
  input: VoucherDocumentInput,
  header: IssuedVoucher["header"]
): VoucherDocument["receiver"] {
  const condition = header.receiverVatConditionId;
  const conditionLegend = RECEIVER_LEGENDS[condition];
  if (conditionLegend === undefined) {
    invalid(
      "voucher.header.receiverVatConditionId",
      "a receiver condition the SDK renders: 1, 4 to 10, 13, 15 or 16"
    );
  }
  const name = input.receiver?.name?.trim();
  const address = input.receiver?.address?.trim();
  if (condition !== CONSUMIDOR_FINAL) {
    required(name, "receiver.name");
    required(address, "receiver.address");
  }
  const identified =
    header.documentType !== UNIDENTIFIED_DOCUMENT &&
    /[1-9]/.test(header.documentNumber);
  if (!identified && condition !== CONSUMIDOR_FINAL) {
    throw new ArcaInputError(
      "Only a consumidor final may be unidentified on a printed voucher.",
      {
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "voucher.header.documentNumber",
        expected: "the receiver's document (C13 to C17)",
      }
    );
  }
  const label = DOCUMENT_LABELS[header.documentType];
  return {
    conditionLegend,
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(identified
      ? {
          document: {
            type: header.documentType,
            ...(label === undefined ? {} : { label }),
            number: header.documentNumber,
          },
        }
      : {}),
  };
}

/**
 * The items must describe the authorized money: the same net, exempt and
 * untaxed amounts and the same VAT bases. The printed lines then use the
 * per-item Half Even split, so they add up to the authorized header.
 */
function documentLines(
  input: VoucherDocumentInput,
  voucherClass: "A" | "B" | "C"
): { lines: VoucherDocumentLine[]; subtotal: number; adjustment: number } {
  const { items } = input;
  const totals = input.voucher.totals;
  if (!Array.isArray(items) || items.length === 0) {
    invalid("items", "the items the voucher was issued from");
  }
  let computed: ReturnType<typeof calculateWsfeAmounts>;
  try {
    computed = calculateWsfeAmounts({
      voucherClass,
      items,
      total: totals.total - totals.otherTaxes,
    });
  } catch (error) {
    if (
      error instanceof ArcaInputError &&
      error.code === "ARCA_INPUT_AMOUNT_MISMATCH"
    ) {
      mismatch("total");
    }
    throw error;
  }
  assertItemsMatchTotals(computed.data, totals, voucherClass);
  const settled =
    voucherClass === "C"
      ? undefined
      : settleVatItems({ voucherClass, items }, computed.amounts.vatAdjustment);
  const lines = items.map((item, index): VoucherDocumentLine => {
    const path = `items[${index}]`;
    const money = settled?.items[index];
    const amount =
      money === undefined
        ? (item.amount as number)
        : voucherClass === "A"
          ? money.amount - money.vat
          : money.amount;
    return {
      ...(item.code === undefined ? {} : { code: item.code }),
      description: required(item.description, `${path}.description`),
      ...lineQuantity(item, amount, path),
      ...(item.unit === undefined ? {} : { unit: item.unit }),
      ...(item.discount ? { discount: item.discount } : {}),
      amount,
      ...(voucherClass === "A" && money !== undefined
        ? { vatRate: money.rate }
        : {}),
    };
  });
  const sum = lines.reduce((total, line) => total + line.amount, 0);
  if (voucherClass === "A") {
    // The rows keep their computed VAT; an asserted total moves only the header.
    const rows = totals.vatRates.reduce((total, row) => total + row.amount, 0);
    return {
      lines,
      subtotal: totals.netTaxed,
      adjustment: totals.vat - rows,
    };
  }
  return { lines, subtotal: sum, adjustment: settled?.unabsorbed ?? 0 };
}

function assertItemsMatchTotals(
  data: ReturnType<typeof calculateWsfeAmounts>["data"],
  totals: VoucherTotals,
  voucherClass: "A" | "B" | "C"
): void {
  const minor = (value: number) =>
    Number(normalizeArcaAmountToMinorUnits(value, "items"));
  for (const [field, value, authorized] of [
    ["netTaxed", data.netAmount, totals.netTaxed],
    ["exempt", data.exemptAmount, totals.exempt],
    ["untaxed", data.nonTaxableAmount, totals.untaxed],
    ["vat", data.vatAmount, totals.vat],
  ] as const) {
    if (minor(value) !== authorized) {
      mismatch(field);
    }
  }
  if (voucherClass === "C") {
    return;
  }
  const bases = (rows: readonly { id: number; base: number }[]) =>
    rows
      .filter((row) => row.base !== 0)
      .map((row) => `${row.id}:${row.base}`)
      .sort()
      .join(",");
  const computedBases = (data.vatRates ?? []).map((row) => ({
    id: row.id,
    base: minor(row.baseAmount),
  }));
  if (bases(computedBases) !== bases(totals.vatRates)) {
    mismatch("vatRates");
  }
}

/** C20 and C21: a line without quantity is one unit at its amount. */
function lineQuantity(
  item: VatItem | AmountItem,
  amount: number,
  path: string
): { quantity: number; unitPrice: string } {
  const discount = item.discount ?? 0;
  if (!(Number.isSafeInteger(discount) && discount >= 0)) {
    invalid(`${path}.discount`, "a non-negative safe integer in minor units");
  }
  if (item.quantity === undefined && item.unitPrice === undefined) {
    // The line amount is net of the discount: the unit price is not.
    return { quantity: 1, unitPrice: majorUnits(amount + discount) };
  }
  const { quantity, unitPrice } = item;
  if (
    !(typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0)
  ) {
    invalid(`${path}.quantity`, "a positive quantity, given with unitPrice");
  }
  if (typeof unitPrice !== "string" || !/^\d+(\.\d{1,6})?$/.test(unitPrice)) {
    invalid(
      `${path}.unitPrice`,
      "a major-unit decimal string with at most six decimals, given with quantity"
    );
  }
  const printed = Math.round(quantity * Number(unitPrice) * 100) - discount;
  if (Math.abs(printed - amount) > 1) {
    throw new ArcaInputError(
      `${path}: quantity × unitPrice − discount does not match the line amount.`,
      {
        code: "ARCA_INPUT_AMOUNT_MISMATCH",
        field: `${path}.unitPrice`,
        expected: `${amount} minor units, within one: without VAT on class A, with VAT on class B`,
      }
    );
  }
  return { quantity, unitPrice };
}

function activitiesStart(date: string | null): {
  activitiesStartDate?: string;
} {
  if (date === null) {
    return {};
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    invalid(
      "issuer.activitiesStartDate",
      "YYYY-MM-DD, or null for the exceptions of RG 1415, Anexo II, A, V 6"
    );
  }
  return { activitiesStartDate: date };
}

function majorUnits(minor: number): string {
  const cents = String(minor).padStart(3, "0");
  return `${cents.slice(0, -2)}.${cents.slice(-2)}`;
}

function digits(value: string): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArcaInputError(`${field} is required on a printed voucher.`, {
      code: "ARCA_INPUT_MISSING_FIELD",
      field,
    });
  }
  return value.trim();
}

function mismatch(field: string): never {
  throw new ArcaInputError("items do not add up to the authorized voucher.", {
    code: "ARCA_INPUT_AMOUNT_MISMATCH",
    field: `items (${field})`,
    expected: "the items the voucher was issued from",
  });
}

function invalid(field: string, expected: string): never {
  throw new ArcaInputError(`${field} must be ${expected}.`, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
    expected,
  });
}
