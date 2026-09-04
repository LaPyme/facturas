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
import { serializeArcaExchangeRate } from "../internal/decimal";
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
} from "./wsfe-amounts";

export type Receiver =
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
export type IssueCommon = {
  salesPoint: number;
  to: Receiver;
  total?: number;
  date?: WsfeDateInput;
  currency?: "ARS" | "USD";
  exchangeRate?: string;
  service?: { from: WsfeDateInput; to: WsfeDateInput; dueDate: WsfeDateInput };
};
export type IssueInput = IssueCommon &
  (
    | { issuer: "responsable_inscripto"; items: readonly VatItem[] }
    | {
        issuer: "monotributo" | "exento" | "no_alcanzado";
        items: readonly AmountItem[];
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
} {
  assertIssueObject(input, "input");
  assertIssueKeys(
    input,
    [
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
  if (
    typeof input.issuer !== "string" ||
    !Object.hasOwn(ARCA_ISSUER_CONDITION_IDS, input.issuer)
  ) {
    invalid(
      "issuer",
      "responsable_inscripto, monotributo, exento, or no_alcanzado"
    );
  }
  if (
    !Number.isSafeInteger(input.salesPoint) ||
    input.salesPoint < 1 ||
    input.salesPoint > 99_999
  ) {
    invalid("salesPoint", "an integer from 1 through 99999");
  }
  const receiver = deriveReceiver(input.to);
  const voucherClass =
    ARCA_INVOICE_CLASS_BY_ISSUER[input.issuer][input.to.condition];
  const { data: amountsData, amounts } = calculateWsfeAmounts(input);
  const currency = deriveCurrency(input);
  if (
    input.to.condition === "consumidor_final" &&
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
  const voucherDate = normalizeWsfeDateInput(
    input.date === undefined ? buenosAiresDate(now) : input.date,
    "date"
  ) as WsfeDateInput;
  const data: WsfeVoucherInput = {
    salesPoint: input.salesPoint,
    voucherType: INVOICE_TYPES[voucherClass],
    voucherDate,
    ...receiver,
    ...currency,
    ...amountsData,
    ...deriveService(input.service, voucherDate),
  };
  try {
    normalizeWsfeVoucherInput(data);
  } catch (cause) {
    throw new ArcaError(
      "The derived invoice failed exact WSFE validation. This is an SDK invariant failure.",
      "ARCA_ISSUE_INVARIANT",
      { cause }
    );
  }
  return { data, voucherClass, amounts };
}

function deriveReceiver(to: Receiver) {
  assertIssueObject(to, "to");
  assertIssueKeys(to, ["condition", "cuit", "dni"], "to");
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
  prefix: string
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      const field = prefix === "input" ? key : `${prefix}.${key}`;
      throw new ArcaInputError(
        `${field} is not supported by vouchers.issue().`,
        {
          code: "ARCA_INPUT_RESERVED_FIELD",
          field,
          expected:
            "a supported facade field; use the exact API for other fiscal fields",
        }
      );
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
