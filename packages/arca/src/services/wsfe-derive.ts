import {
  ARCA_CURRENCY_IDS,
  ARCA_DOCUMENT_TYPES,
  ARCA_FINAL_CONSUMER_IDENTIFICATION_THRESHOLD_MINOR_UNITS,
  ARCA_INVOICE_CLASS_BY_ISSUER,
  ARCA_ISSUER_CONDITION_IDS,
  ARCA_RECEIVER_CONDITION_IDS,
  ARCA_VOUCHER_TYPES,
  type ReceiverCondition,
  type VoucherClass,
} from "../constants";
import { ArcaError, ArcaInputError } from "../errors";
import {
  normalizeArcaAmountToMinorUnits,
  serializeArcaExchangeRate,
} from "../internal/decimal";
import {
  applyIssuanceFields,
  type InvoiceFamily,
  ISSUANCE_KEYS,
  type IssuanceFields,
  invoiceType,
  minor,
  reviewedHeaderAmounts,
  type Tribute,
  tributeTotal,
  type VoucherAmounts,
  validateFiscalHeader,
  validateIssuanceFields,
} from "./issuance-fields";
import {
  normalizeWsfeDateInput,
  normalizeWsfeVoucherInput,
  type WsfeDateInput,
  type WsfeVoucherInput,
} from "./wsfe";
import {
  type AmountItem,
  calculateWsfeAmounts,
  type IssueAmounts,
  type VatItem,
  type WsfeAmountsInput,
} from "./wsfe-amounts";

export type Receiver =
  | {
      condition: number;
      cuit?: string | number;
      dni?: string | number;
      document?: { type: number; number: string | number };
    }
  | {
      condition: "consumidor_final";
      cuit?: number | string;
      dni?: number | string;
    }
  | {
      condition: Exclude<ReceiverCondition, "consumidor_final">;
      cuit: number | string;
      dni?: never;
    };
export type IssueCommon = IssuanceFields & {
  family?: InvoiceFamily;
  salesPoint: number;
  to: Receiver;
  total?: number;
  date?: WsfeDateInput;
  currency?: "ARS" | "USD" | { id: string };
  exchangeRate?: string;
  service?: { from: WsfeDateInput; to: WsfeDateInput; dueDate: WsfeDateInput };
};
export type IssueInput = IssueCommon &
  (
    | {
        issuer: "responsable_inscripto";
        items: readonly VatItem[];
        amounts?: never;
      }
    | {
        issuer: "monotributo" | "exento" | "no_alcanzado";
        items: readonly AmountItem[];
        amounts?: never;
      }
    | {
        issuer: import("../constants").IssuerCondition;
        amounts: import("./issuance-fields").VoucherAmounts;
        items?: never;
      }
  );

const INVOICE_TYPES = {
  A: ARCA_VOUCHER_TYPES.FACTURA_A,
  B: ARCA_VOUCHER_TYPES.FACTURA_B,
  C: ARCA_VOUCHER_TYPES.FACTURA_C,
};

/** No I/O: all caller validation finishes before the next-number read. */
export function deriveWsfeInvoice(
  input: IssueInput,
  now = new Date()
): {
  data: WsfeVoucherInput;
  voucherClass: VoucherClass;
  amounts: IssueAmounts;
  /** The items the header came from, so provider lines derive from the same money. */
  lineSource?: WsfeAmountsInput;
} {
  assertIssueObject(input, "input");
  assertIssueKeys(
    input,
    [
      ...ISSUANCE_KEYS,
      "family",
      "issuer",
      "items",
      "salesPoint",
      "to",
      "total",
      "date",
      "currency",
      "exchangeRate",
      "service",
    ],
    "input"
  );
  validateIssuanceFields(input);
  if (input.amounts !== undefined && input.items !== undefined) {
    invalid("amounts", "used instead of items, never with items");
  }
  assertIssuerCondition(input.issuer);
  assertSalesPoint(input.salesPoint);
  const receiver = deriveReceiver(input.to);
  const voucherClass = resolveInvoiceClass(input.issuer, input.to.condition);
  const lineSource: WsfeAmountsInput | undefined = input.amounts
    ? undefined
    : {
        voucherClass,
        items: input.items,
        total:
          input.total === undefined
            ? undefined
            : input.total - tributeTotal(input.taxes ?? []),
      };
  const { data: amountsData, amounts } =
    lineSource === undefined
      ? reviewedInvoiceAmounts(input.amounts as VoucherAmounts, input.taxes)
      : calculateWsfeAmounts(lineSource);
  const currency = deriveCurrency(input);
  const voucherDate = normalizeWsfeDateInput(
    input.date === undefined ? buenosAiresDate(now) : input.date,
    "date"
  ) as WsfeDateInput;
  const data: WsfeVoucherInput = {
    salesPoint: input.salesPoint,
    voucherType:
      input.family === undefined
        ? INVOICE_TYPES[voucherClass]
        : invoiceType(input.family, voucherClass),
    voucherDate,
    ...receiver,
    ...currency,
    ...amountsData,
    ...deriveService(input.service, voucherDate),
  };
  applyIssuanceFields(data, input);
  // Tributes reach the header after the item arithmetic, so the sent total is
  // reconciled from the header itself.
  const headerTotal = Number(
    normalizeArcaAmountToMinorUnits(data.netAmount, "net") +
      normalizeArcaAmountToMinorUnits(data.vatAmount, "vat") +
      normalizeArcaAmountToMinorUnits(data.exemptAmount, "exempt") +
      normalizeArcaAmountToMinorUnits(data.nonTaxableAmount, "untaxed") +
      normalizeArcaAmountToMinorUnits(data.taxAmount, "tax")
  );
  const reviewedTotal = input.amounts ? input.total : undefined;
  data.totalAmount =
    reviewedTotal === undefined
      ? headerTotal / 100
      : minor(reviewedTotal, "total");
  amounts.computedTotal += headerTotal - amounts.sentTotal;
  amounts.sentTotal = reviewedTotal ?? headerTotal;
  if (
    receiver.receiverVatConditionId === 5 &&
    receiver.documentType === ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL
  ) {
    const [whole, fraction = ""] = currency.exchangeRate.split(".");
    const rate = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
    // Compare exact peso equivalents; rounding below the threshold must not hide it.
    if (
      BigInt(amounts.sentTotal) * rate >=
      ARCA_FINAL_CONSUMER_IDENTIFICATION_THRESHOLD_MINOR_UNITS * 1_000_000n
    ) {
      throw new ArcaInputError(
        "The final consumer must be identified for this amount.",
        {
          code: "ARCA_INPUT_MISSING_FIELD",
          field: "to",
          expected:
            "cuit or dni for operations at or above ARS 10,000,000 (RG 5866)",
        }
      );
    }
  }
  validateFiscalHeader(data);
  try {
    normalizeWsfeVoucherInput(data);
  } catch (cause) {
    if (cause instanceof ArcaInputError) {
      throw cause;
    }
    throw new ArcaError(
      "The derived invoice failed WSFE validation. This is an SDK invariant failure.",
      "ARCA_ISSUE_INVARIANT",
      { cause }
    );
  }
  return {
    data,
    voucherClass,
    amounts,
    ...(lineSource === undefined ? {} : { lineSource }),
  };
}

type HeaderAmounts = Pick<
  WsfeVoucherInput,
  | "totalAmount"
  | "netAmount"
  | "vatAmount"
  | "nonTaxableAmount"
  | "exemptAmount"
  | "taxAmount"
  | "vatRates"
>;
/**
 * Reviewed mode: the caller's breakdown and tributes are the header as given.
 * Nothing is recomputed, so there is never a VAT adjustment; an explicit
 * `total` is applied by the caller of this function and is not rewritten here.
 * Invoices and notes share it, so both derive a reviewed header the same way.
 */
export function reviewedInvoiceAmounts(
  amounts: VoucherAmounts,
  taxes: readonly Tribute[] | undefined
): { data: HeaderAmounts; amounts: IssueAmounts } {
  const taxTotal = taxes === undefined ? 0 : tributeTotal(taxes);
  const total =
    amounts.net +
    amounts.vat +
    (amounts.exempt ?? 0) +
    (amounts.untaxed ?? 0) +
    taxTotal;
  return {
    data: {
      totalAmount: minor(total, "total"),
      taxAmount: minor(taxTotal, "taxes.total"),
      ...reviewedHeaderAmounts(amounts),
    },
    amounts: { computedTotal: total, sentTotal: total, vatAdjustment: 0 },
  };
}

function assertIssuerCondition(issuer: IssueInput["issuer"]) {
  if (
    typeof issuer !== "string" ||
    !Object.hasOwn(ARCA_ISSUER_CONDITION_IDS, issuer)
  ) {
    invalid(
      "issuer",
      "responsable_inscripto, monotributo, exento, or no_alcanzado"
    );
  }
}

function assertSalesPoint(salesPoint: number) {
  if (
    !Number.isSafeInteger(salesPoint) ||
    salesPoint < 1 ||
    salesPoint > 99_999
  ) {
    invalid("salesPoint", "an integer from 1 through 99999");
  }
}

/** Class resolution: the issuer's condition and the receiver's condition fix it. */
function resolveInvoiceClass(
  issuer: IssueInput["issuer"],
  condition: ReceiverCondition | number
): VoucherClass {
  if (typeof condition === "number") {
    return issuer === "responsable_inscripto"
      ? [1, 6, 13, 16].includes(condition)
        ? "A"
        : "B"
      : "C";
  }
  return ARCA_INVOICE_CLASS_BY_ISSUER[issuer][condition];
}

function deriveReceiver(to: Receiver) {
  assertIssueObject(to, "to");
  assertIssueKeys(to, ["condition", "cuit", "dni", "document"], "to");
  if (typeof to.condition === "number") {
    return deriveNumericReceiver(
      to as Extract<Receiver, { condition: number }>
    );
  }
  if (
    typeof to.condition !== "string" ||
    !Object.hasOwn(ARCA_RECEIVER_CONDITION_IDS, to.condition)
  ) {
    invalid("to.condition", "one of the five supported receiver conditions");
  }
  if (to.cuit !== undefined && to.dni !== undefined) {
    invalid("to", "either cuit or dni, never both");
  }
  if (to.condition !== "consumidor_final" && to.cuit === undefined) {
    throw new ArcaInputError(
      "to.cuit is required for this receiver (WSFE 10063 for class A).",
      {
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "to.cuit",
        expected: "an 11-digit CUIT",
      }
    );
  }
  const documentType =
    to.cuit === undefined
      ? to.dni === undefined
        ? ARCA_DOCUMENT_TYPES.CONSUMIDOR_FINAL
        : ARCA_DOCUMENT_TYPES.DNI
      : ARCA_DOCUMENT_TYPES.CUIT;
  // WSFE DocNro is Long(11); do not impose an undocumented DNI-only width.
  const documentNumber =
    to.cuit === undefined
      ? to.dni === undefined
        ? 0
        : issueDocumentNumber(to.dni, "to.dni", 1, 11)
      : issueDocumentNumber(to.cuit, "to.cuit", 11, 11);
  return {
    documentType,
    documentNumber,
    receiverVatConditionId: ARCA_RECEIVER_CONDITION_IDS[to.condition],
  };
}

export function issueDocumentNumber(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number" && typeof value !== "string") {
    invalid(field, `a positive document number with ${min} to ${max} digits`);
  }
  const text = String(value);
  if (
    !/^\d+$/.test(text) ||
    text.length < min ||
    text.length > max ||
    !Number.isSafeInteger(Number(text)) ||
    Number(text) <= 0
  ) {
    invalid(field, `a positive document number with ${min} to ${max} digits`);
  }
  return Number(text);
}

function deriveCurrency(input: IssueCommon) {
  const currency = input.currency === undefined ? "ARS" : input.currency;
  if (typeof currency === "object" && currency !== null) {
    assertIssueKeys(currency, ["id"], "currency");
    if (!/^[A-Z0-9]{3}$/.test(currency.id)) {
      invalid("currency.id", "a three-character ARCA currency code");
    }
    if (input.exchangeRate === undefined) {
      invalid("exchangeRate", "an explicit rate for this currency");
    }
    return {
      currencyId: currency.id,
      exchangeRate: serializeArcaExchangeRate(
        input.exchangeRate,
        "exchangeRate"
      ),
    };
  }
  if (currency !== "ARS" && currency !== "USD") {
    invalid("currency", "ARS or USD");
  }
  if (
    input.exchangeRate !== undefined &&
    typeof input.exchangeRate !== "string"
  ) {
    invalid("exchangeRate", "a decimal string");
  }
  if (currency === "USD" && input.exchangeRate === undefined) {
    throw new ArcaInputError("exchangeRate is required for USD.", {
      code: "ARCA_INPUT_MISSING_FIELD",
      field: "exchangeRate",
      expected: "a positive decimal string",
    });
  }
  const exchangeRate = serializeArcaExchangeRate(
    input.exchangeRate ?? "1",
    "exchangeRate"
  );
  if (currency === "ARS" && exchangeRate !== "1") {
    throw new ArcaInputError("exchangeRate must be 1 for ARS.", {
      code: "ARCA_INPUT_INVALID_EXCHANGE_RATE",
      field: "exchangeRate",
      expected: "1 for ARS",
    });
  }
  return { currencyId: ARCA_CURRENCY_IDS[currency], exchangeRate };
}

function deriveService(service: IssueCommon["service"], date: WsfeDateInput) {
  if (service === undefined) {
    return { concept: 1 };
  }
  assertIssueObject(service, "service");
  assertIssueKeys(service, ["from", "to", "dueDate"], "service");
  for (const field of ["from", "to", "dueDate"] as const) {
    if (service[field] === undefined) {
      throw new ArcaInputError(`service.${field} is required.`, {
        code: "ARCA_INPUT_MISSING_FIELD",
        field: `service.${field}`,
        expected: "a calendar date",
      });
    }
  }
  const serviceStartDate = normalizeWsfeDateInput(
    service.from,
    "service.from"
  ) as WsfeDateInput;
  const serviceEndDate = normalizeWsfeDateInput(
    service.to,
    "service.to"
  ) as WsfeDateInput;
  const paymentDueDate = normalizeWsfeDateInput(
    service.dueDate,
    "service.dueDate"
  ) as WsfeDateInput;
  if (serviceEndDate < serviceStartDate) {
    invalid("service.to", "a date on or after service.from");
  }
  if (paymentDueDate < date) {
    invalid("service.dueDate", "a date on or after date");
  }
  return { concept: 2, serviceStartDate, serviceEndDate, paymentDueDate };
}

export function buenosAiresDate(now: Date): WsfeDateInput {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((part) => parts.find((entry) => entry.type === part)?.value)
    .join("") as WsfeDateInput;
}

export function assertIssueObject(
  value: unknown,
  field: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "an object");
  }
}
export function assertIssueKeys(
  value: object,
  keys: readonly string[],
  prefix: string,
  method = "issue()"
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      const field = prefix === "input" ? key : `${prefix}.${key}`;
      throw new ArcaInputError(`${field} is not supported by ${method}.`, {
        code: "ARCA_INPUT_RESERVED_FIELD",
        field,
        expected: "a field the facade supports",
      });
    }
  }
}
function invalid(field: string, expected: string): never {
  throw new ArcaInputError(`${field} must be ${expected}.`, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
    expected,
  });
}

function deriveNumericReceiver(to: Extract<Receiver, { condition: number }>) {
  if (![1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16].includes(to.condition)) {
    invalid("to.condition", "an ARCA receiver condition");
  }
  const document = "document" in to ? to.document : undefined;
  if (document) {
    assertIssueKeys(document, ["type", "number"], "to.document");
    if (to.cuit !== undefined || to.dni !== undefined) {
      invalid("to", "one document identity");
    }
    if (
      !Number.isInteger(document.type) ||
      document.type < 0 ||
      document.type > 99 ||
      !/^\d{1,11}$/.test(String(document.number)) ||
      !Number.isSafeInteger(Number(document.number))
    ) {
      invalid("to.document", "a valid document type and number");
    }
    if (document.type === 80 && String(document.number).length !== 11) {
      invalid("to.document.number", "an 11-digit CUIT");
    }
    return {
      documentType: document.type,
      documentNumber: Number(document.number),
      receiverVatConditionId: to.condition,
    };
  }
  if (to.cuit === undefined && to.dni === undefined) {
    invalid("to", "an explicit document");
  }
  if (to.cuit !== undefined && to.dni !== undefined) {
    invalid("to", "one document identity");
  }
  return {
    documentType: to.cuit === undefined ? 96 : 80,
    documentNumber: issueDocumentNumber(
      to.cuit ?? to.dni,
      "to.document",
      to.cuit === undefined ? 1 : 11,
      11
    ),
    receiverVatConditionId: to.condition,
  };
}
