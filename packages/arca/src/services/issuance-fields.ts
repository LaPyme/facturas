import type { VoucherClass } from "../constants";
import { ArcaInputError } from "../errors";
import {
  arcaMinorUnitsToNumber,
  assertArcaMinorUnits,
} from "../internal/decimal";
import { normalizeWsfeDateInput, type WsfeVoucherInput } from "./wsfe";

/** Monetary values in the high-level API are integer minor units. */
export type Tribute = {
  id: number;
  description?: string;
  base: number;
  rate: number;
  amount: number;
};
/** An already-reviewed fiscal breakdown; no recalculation of historical VAT. */
export type VoucherAmounts = {
  net: number;
  vat: number;
  exempt?: number;
  untaxed?: number;
  vatRates?: readonly { id: number; base: number; amount: number }[];
};
export type InvoiceFamily = "ordinary" | "retention_legend" | "fce";
export type IssuanceFields = {
  fce?: FceOptions;
  taxes?: readonly Tribute[];
  amounts?: VoucherAmounts;
  concept?: "products" | "services" | "products_and_services";
  dueDate?: import("./wsfe").WsfeDateInput;
  paidInForeignCurrency?: boolean;
  optionalFields?: WsfeVoucherInput["optionalFields"];
  buyers?: WsfeVoucherInput["buyers"];
  activities?: WsfeVoucherInput["activities"];
};

export const FAMILIES = {
  ordinary: { A: [1, 2, 3], B: [6, 7, 8], C: [11, 12, 13] },
  retention_legend: { A: [51, 52, 53] },
  fce: { A: [201, 202, 203], B: [206, 207, 208], C: [211, 212, 213] },
} as const;

export function voucherFamily(type: number): {
  family: InvoiceFamily;
  voucherClass: VoucherClass;
  types: readonly number[];
} {
  for (const [family, classes] of Object.entries(FAMILIES)) {
    for (const [voucherClass, types] of Object.entries(classes)) {
      if ((types as readonly number[]).includes(type)) {
        return {
          family: family as InvoiceFamily,
          voucherClass: voucherClass as VoucherClass,
          types,
        };
      }
    }
  }
  throw new ArcaInputError("Unsupported invoice or note type.", {
    code: "ARCA_INPUT_INVALID_VALUE",
    field: "voucherType",
  });
}
export function invoiceType(
  family: InvoiceFamily,
  voucherClass: VoucherClass
): number {
  const classes = FAMILIES[family];
  const types =
    classes &&
    (classes as Partial<Record<VoucherClass, readonly number[]>>)[voucherClass];
  if (!types) {
    throw new ArcaInputError("Invoice family does not support this class.", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "family",
    });
  }
  return types[0] as number;
}
export function minor(value: number, field: string): number {
  return arcaMinorUnitsToNumber(assertArcaMinorUnits(value, field), field);
}
export function applyIssuanceFields(
  data: WsfeVoucherInput,
  fields: IssuanceFields
): void {
  if (fields.taxes !== undefined) {
    if (!Array.isArray(fields.taxes)) {
      throw new ArcaInputError("taxes must be an array", {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "taxes",
      });
    }
    data.taxes = fields.taxes.map((tax) => ({
      id: tax.id,
      description: tax.description,
      baseAmount: minor(tax.base, "taxes.base"),
      rate: tax.rate,
      amount: minor(tax.amount, "taxes.amount"),
    }));
    data.taxAmount = minor(tributeTotal(fields.taxes), "taxes.total");
  }
  if (fields.amounts) {
    Object.assign(data, reviewedHeaderAmounts(fields.amounts));
  }
  if (fields.concept) {
    data.concept = { products: 1, services: 2, products_and_services: 3 }[
      fields.concept
    ];
  }
  if (fields.dueDate) {
    data.paymentDueDate = fields.dueDate;
  }
  if (fields.paidInForeignCurrency !== undefined) {
    if (typeof fields.paidInForeignCurrency !== "boolean") {
      throw new ArcaInputError("paidInForeignCurrency must be boolean", {
        code: "ARCA_INPUT_INVALID_VALUE",
      });
    }
    data.sameCurrencyForeignCancellation = fields.paidInForeignCurrency
      ? "S"
      : "N";
  }
  for (const key of ["optionalFields", "buyers", "activities"] as const) {
    if (fields[key] !== undefined) {
      Object.assign(data, { [key]: structuredClone(fields[key]) });
    }
  }
  applyFceFields(data, fields.fce);
}
/** Tributes are outside the item arithmetic; they add to the total in cents. */
export function tributeTotal(taxes: readonly Tribute[]): number {
  return taxes.reduce((sum, tax) => sum + tax.amount, 0);
}
/** A reviewed breakdown becomes the header verbatim: no VAT is recomputed. */
export function reviewedHeaderAmounts(
  amounts: VoucherAmounts
): Pick<
  WsfeVoucherInput,
  "netAmount" | "vatAmount" | "exemptAmount" | "nonTaxableAmount" | "vatRates"
> {
  return {
    netAmount: minor(amounts.net, "amounts.net"),
    vatAmount: minor(amounts.vat, "amounts.vat"),
    exemptAmount: minor(amounts.exempt ?? 0, "amounts.exempt"),
    nonTaxableAmount: minor(amounts.untaxed ?? 0, "amounts.untaxed"),
    vatRates: amounts.vatRates?.map((rate) => ({
      id: rate.id,
      baseAmount: minor(rate.base, "amounts.vatRates.base"),
      amount: minor(rate.amount, "amounts.vatRates.amount"),
    })),
  };
}
export const ISSUANCE_KEYS = [
  "fce",
  "taxes",
  "amounts",
  "concept",
  "dueDate",
  "paidInForeignCurrency",
  "optionalFields",
  "buyers",
  "activities",
];

export function validateIssuanceFields(fields: IssuanceFields): void {
  validateRows(
    fields.taxes,
    "taxes",
    ["id", "description", "base", "rate", "amount"],
    (row) => {
      positiveId(row.id, "taxes.id");
      if (
        row.description !== undefined &&
        typeof row.description !== "string"
      ) {
        bad("taxes.description");
      }
      minor(row.base as number, "taxes.base");
      minor(row.amount as number, "taxes.amount");
      if (
        typeof row.rate !== "number" ||
        !Number.isFinite(row.rate) ||
        row.rate < 0
      ) {
        bad("taxes.rate");
      }
    }
  );
  if (fields.amounts !== undefined) {
    objectKeys(fields.amounts, "amounts", [
      "net",
      "vat",
      "exempt",
      "untaxed",
      "vatRates",
    ]);
    minor(fields.amounts.net, "amounts.net");
    minor(fields.amounts.vat, "amounts.vat");
    validateRows(
      fields.amounts.vatRates,
      "amounts.vatRates",
      ["id", "base", "amount"],
      (row) => {
        if (![3, 4, 5, 6, 8, 9].includes(row.id as number)) {
          bad("amounts.vatRates.id");
        }
        minor(row.base as number, "amounts.vatRates.base");
        minor(row.amount as number, "amounts.vatRates.amount");
      }
    );
    const ids = fields.amounts.vatRates?.map((r) => r.id) ?? [];
    if (new Set(ids).size !== ids.length) {
      bad("amounts.vatRates");
    }
  }
  validateRows(
    fields.optionalFields,
    "optionalFields",
    ["id", "value"],
    (row) => {
      if (
        typeof row.id !== "string" ||
        !/^\d+$/.test(row.id) ||
        typeof row.value !== "string"
      ) {
        bad("optionalFields");
      }
    }
  );
  validateRows(
    fields.buyers,
    "buyers",
    ["documentType", "documentNumber", "percentage"],
    (row) => {
      positiveId(row.documentType, "buyers.documentType");
      positiveId(row.documentNumber, "buyers.documentNumber");
      if (
        typeof row.percentage !== "number" ||
        !Number.isFinite(row.percentage) ||
        row.percentage <= 0 ||
        row.percentage > 100
      ) {
        bad("buyers.percentage");
      }
    }
  );
  validateRows(fields.activities, "activities", ["id"], (row) =>
    positiveId(row.id, "activities.id")
  );
  if (
    fields.concept !== undefined &&
    !["products", "services", "products_and_services"].includes(fields.concept)
  ) {
    bad("concept");
  }
  if (fields.fce !== undefined) {
    objectKeys(fields.fce, "fce", [
      "cbu",
      "alias",
      "transfer",
      "annulment",
      "reference",
    ]);
    validateFceOptions(fields.fce);
  }
  normalizedFceAnnulment(fields);
}
function positiveId(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    bad(field);
  }
}
function bad(field: string): never {
  throw new ArcaInputError(`Invalid ${field}`, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
  });
}
function objectKeys(
  value: unknown,
  field: string,
  keys: readonly string[]
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    bad(field);
  }
}
function validateRows(
  value: unknown,
  field: string,
  keys: readonly string[],
  check: (row: Record<string, unknown>) => void
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    bad(field);
  }
  for (const row of value) {
    objectKeys(row, field, keys);
    check(row);
  }
}

export function validateFiscalHeader(data: WsfeVoucherInput): void {
  const family = voucherFamily(data.voucherType);
  validateFceHeader(data);
  if (
    family.voucherClass === "C" &&
    (data.vatAmount !== 0 ||
      data.vatRates?.length ||
      data.exemptAmount !== 0 ||
      data.nonTaxableAmount !== 0)
  ) {
    bad("amounts");
  }
  if (![1, 2, 3].includes(data.concept)) {
    bad("concept");
  }
  const date = normalizeWsfeDateInput(data.voucherDate, "date");
  if (data.concept === 1 && (data.serviceStartDate || data.serviceEndDate)) {
    bad("service");
  }
  if (data.concept === 2 || data.concept === 3) {
    if (
      !(data.serviceStartDate && data.serviceEndDate && data.paymentDueDate)
    ) {
      bad("service");
    }
    const start = normalizeWsfeDateInput(data.serviceStartDate, "service.from");
    const end = normalizeWsfeDateInput(data.serviceEndDate, "service.to");
    if (start > end) {
      bad("service.to");
    }
  }
  if (
    data.paymentDueDate &&
    normalizeWsfeDateInput(data.paymentDueDate, "dueDate") < date
  ) {
    bad("dueDate");
  }
  if (
    data.currencyId === "PES" &&
    data.sameCurrencyForeignCancellation !== undefined
  ) {
    bad("paidInForeignCurrency");
  }
}

/** FCE business fields; the SDK encodes each provider's different option layout. */
export type FceOptions = {
  cbu?: string;
  alias?: string;
  transfer?: "ADC" | "SCA";
  annulment?: boolean;
  reference?: string;
};
export function applyFceFields(
  data: Pick<WsfeVoucherInput, "voucherType" | "optionalFields">,
  fce: FceOptions | undefined
): void {
  if (fce === undefined) {
    return;
  }
  objectKeys(fce, "fce", [
    "cbu",
    "alias",
    "transfer",
    "annulment",
    "reference",
  ]);
  if (voucherFamily(data.voucherType).family !== "fce") {
    bad("fce");
  }
  validateFceOptions(fce);
  normalizedFceAnnulment({ fce, optionalFields: data.optionalFields });
  const extra = [
    ...(fce.cbu === undefined ? [] : [{ id: "2101", value: fce.cbu }]),
    ...(fce.alias === undefined ? [] : [{ id: "2102", value: fce.alias }]),
    ...(fce.transfer === undefined ? [] : [{ id: "27", value: fce.transfer }]),
    ...(fce.annulment === undefined
      ? []
      : [{ id: "22", value: fce.annulment ? "S" : "N" }]),
    ...(fce.reference === undefined
      ? []
      : [{ id: "23", value: fce.reference }]),
  ];
  const options = [...(data.optionalFields ?? []), ...extra];
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    bad("fce");
  }
  data.optionalFields = options;
}

/** Reads the two accepted FCE annulment encodings and rejects ambiguity. */
export function normalizedFceAnnulment(
  fields: Pick<IssuanceFields, "fce" | "optionalFields">
): boolean | undefined {
  const encoded = (fields.optionalFields ?? []).filter(
    (field) => field.id === "22"
  );
  if (encoded.length > 1) {
    bad("optionalFields");
  }
  const encodedValue = encoded[0]?.value;
  if (encodedValue !== undefined && !["S", "N"].includes(encodedValue)) {
    bad("fce.annulment");
  }
  const direct = fields.fce?.annulment;
  if (direct !== undefined && encodedValue !== undefined) {
    throw new ArcaInputError(
      direct === (encodedValue === "S")
        ? "FCE annulment is duplicated in fce and optionalFields."
        : "FCE annulment conflicts between fce and optionalFields.",
      { code: "ARCA_INPUT_INVALID_VALUE", field: "fce.annulment" }
    );
  }
  return (
    direct ?? (encodedValue === undefined ? undefined : encodedValue === "S")
  );
}

function validateFceHeader(data: WsfeVoucherInput): void {
  const family = voucherFamily(data.voucherType);
  if (family.family === "fce") {
    const options = new Map(
      (data.optionalFields ?? []).map((o) => [o.id, o.value])
    );
    if (family.types[0] === data.voucherType) {
      if (!/^\d{22}$/.test(options.get("2101") ?? "") || options.has("22")) {
        bad("fce.cbu");
      }
      if (!data.paymentDueDate) {
        bad("dueDate");
      }
    } else if (
      !["S", "N"].includes(options.get("22") ?? "") ||
      options.has("2101") ||
      options.has("2102") ||
      options.has("27")
    ) {
      bad("fce.annulment");
    }
  }
}

function validateFceOptions(fce: FceOptions): void {
  if (
    fce.cbu !== undefined &&
    (typeof fce.cbu !== "string" || !/^\d{22}$/.test(fce.cbu))
  ) {
    bad("fce.cbu");
  }
  if (
    fce.alias !== undefined &&
    (typeof fce.alias !== "string" || !/^[A-Za-z0-9.-]{6,20}$/.test(fce.alias))
  ) {
    bad("fce.alias");
  }
  if (fce.transfer !== undefined && !["ADC", "SCA"].includes(fce.transfer)) {
    bad("fce.transfer");
  }
  if (fce.annulment !== undefined && typeof fce.annulment !== "boolean") {
    bad("fce.annulment");
  }
  if (
    fce.reference !== undefined &&
    (typeof fce.reference !== "string" || !fce.reference.trim())
  ) {
    bad("fce.reference");
  }
}
