import type { VoucherClass } from "../constants";
import { ArcaInputError } from "../errors";
import { normalizeArcaAmountToMinorUnits } from "../internal/decimal";
import {
  normalizeWsfeDateInput,
  normalizeWsfeVoucherInput,
  type WsfeDateInput,
  type WsfeVoucherInfo,
  type WsfeVoucherInput,
} from "./wsfe";
import { buenosAiresDate } from "./wsfe-derive";

const NOTES: Record<
  number,
  { voucherType: number; voucherClass: VoucherClass }
> = {
  1: { voucherType: 3, voucherClass: "A" },
  6: { voucherType: 8, voucherClass: "B" },
  11: { voucherType: 13, voucherClass: "C" },
};
function invalid(reason: string): never {
  throw new ArcaInputError(
    `Cannot cancel: ${reason}. Use wsfe.authorizeVoucherOutcome() for exact control.`,
    { code: "ARCA_INPUT_INVALID_VALUE" }
  );
}
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null) {
    invalid(`original is missing ${field}`);
  }
  return value;
}

/** Builds a full ordinary credit note using the original's consultation evidence. */
export function deriveWsfeCancellation(
  original: WsfeVoucherInfo,
  date?: WsfeDateInput,
  now = new Date()
) {
  const note = NOTES[original.voucherType ?? 0];
  if (!note) {
    invalid("original must be an invoice of type 1, 6 or 11");
  }
  if (
    !(
      ["A", "O"].includes(original.result ?? "") &&
      original.cae?.trim() &&
      original.caeExpiry?.trim()
    )
  ) {
    invalid("original is not authorized");
  }
  rejectExtensions(original);
  if (original.currencyId !== "PES" && original.currencyId !== "DOL") {
    invalid("unsupported currency; only ARS and USD are supported");
  }
  const voucherDate = normalizeWsfeDateInput(
    date ?? buenosAiresDate(now),
    "date"
  ) as WsfeDateInput;
  const originalDate = normalizeWsfeDateInput(
    required(original.voucherDate, "voucherDate") as WsfeDateInput,
    "original.voucherDate"
  ) as WsfeDateInput;
  if (
    originalDate > voucherDate &&
    originalDate.slice(0, 6) !== voucherDate.slice(0, 6)
  ) {
    invalid(
      "original date is later than the note and outside its month (10210)"
    );
  }
  const data: WsfeVoucherInput = {
    salesPoint: required(original.salesPoint, "salesPoint"),
    voucherType: note.voucherType,
    concept: required(original.concept, "concept"),
    documentType: required(original.documentType, "documentType"),
    documentNumber: Number(required(original.documentNumber, "documentNumber")),
    receiverVatConditionId: required(
      original.receiverVatConditionId,
      "receiverVatConditionId"
    ),
    currencyId: original.currencyId,
    exchangeRate: required(original.exchangeRate, "exchangeRate"),
    voucherDate,
    totalAmount: required(original.totalAmount, "totalAmount"),
    netAmount: required(original.netAmount, "netAmount"),
    vatAmount: required(original.vatAmount, "vatAmount"),
    exemptAmount: required(original.exemptAmount, "exemptAmount"),
    nonTaxableAmount: required(original.nonTaxableAmount, "nonTaxableAmount"),
    taxAmount: required(original.taxAmount, "taxAmount"),
    ...(original.vatRates === undefined
      ? {}
      : { vatRates: original.vatRates.map((rate) => ({ ...rate })) }),
    associatedVouchers: [
      {
        type: required(original.voucherType, "voucherType"),
        salesPoint: required(original.salesPoint, "salesPoint"),
        number: original.voucherNumber,
        voucherDate: originalDate,
      },
    ],
  };
  copyServiceDates(original, data);
  normalizeWsfeVoucherInput(data);
  const total = Number(
    normalizeArcaAmountToMinorUnits(data.totalAmount, "totalAmount")
  );
  return {
    data,
    voucherClass: note.voucherClass,
    amounts: { computedTotal: total, sentTotal: total, vatAdjustment: 0 },
  };
}

function rejectExtensions(original: WsfeVoucherInfo) {
  for (const [field, rawField] of [
    ["taxes", "Tributos"],
    ["optionalFields", "Opcionales"],
    ["buyers", "Compradores"],
    ["activities", "Actividades"],
    ["associatedPeriod", "PeriodoAsoc"],
  ]) {
    const value = (original as unknown as Record<string, unknown>)[field];
    const raw = original.raw[rawField];
    if (present(value) || present(raw)) {
      invalid(`unsupported original ${field}`);
    }
  }
  if ((original.taxAmount ?? 0) !== 0) {
    invalid("unsupported original taxes");
  }
}
function present(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0)
  );
}
function copyServiceDates(original: WsfeVoucherInfo, data: WsfeVoucherInput) {
  if (data.concept !== 2 && data.concept !== 3) {
    return;
  }
  data.serviceStartDate = required(
    original.serviceStartDate,
    "serviceStartDate"
  ) as WsfeDateInput;
  data.serviceEndDate = required(
    original.serviceEndDate,
    "serviceEndDate"
  ) as WsfeDateInput;
  const due = normalizeWsfeDateInput(
    required(original.paymentDueDate, "paymentDueDate") as WsfeDateInput,
    "original.paymentDueDate"
  ) as WsfeDateInput;
  data.paymentDueDate = due < data.voucherDate ? data.voucherDate : due;
}
