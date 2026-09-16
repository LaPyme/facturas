import { ArcaInputError } from "../errors";
import { toIsoDate } from "../internal/dates";
import { assertArcaMinorUnits } from "../internal/decimal";
import { normalizeWsfeDateInput, type WsfeDateInput } from "./wsfe";

/** Where every printed voucher's QR points, per ARCA's QR specification v1. */
export const ARCA_QR_URL = "https://www.arca.gob.ar/fe/qr/";

/** What the QR of a printed voucher encodes. Amounts are minor units. */
export type ArcaQrInput = {
  /** The issuer's CUIT. */
  taxId: number | string;
  salesPoint: number;
  voucherType: number;
  number: number;
  /** `YYYY-MM-DD` or `YYYYMMDD`. */
  date: string;
  /** The total in the voucher's currency, in minor units. */
  total: number;
  /** ARCA currency id; `PES` when omitted. */
  currency?: string;
  /** Pesos per unit of `currency`; 1 for pesos. */
  exchangeRate?: number | string;
  /** The CAE, or the CAEA when `authorization` is `"CAEA"`. */
  cae: string;
  authorization?: "CAE" | "CAEA";
  /** The receiver's document. Omitted, or type 99, means an unidentified consumidor final. */
  document?: { type: number; number: number | string };
};

/** The JSON the QR carries, in the field order of ARCA's specification. */
export type ArcaQrPayload = {
  ver: 1;
  fecha: string;
  cuit: number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda: string;
  ctz: number;
  tipoDocRec?: number;
  nroDocRec?: number;
  tipoCodAut: "E" | "A";
  codAut: number;
};

/** Builds the URL a printed voucher's QR must encode. Pure, no I/O. */
export function arcaQrUrl(input: ArcaQrInput): string {
  const json = JSON.stringify(arcaQrPayload(input));
  return `${ARCA_QR_URL}?p=${Buffer.from(json, "utf8").toString("base64")}`;
}

export function arcaQrPayload(input: ArcaQrInput): ArcaQrPayload {
  const fecha = isoCalendarDate(input.date);
  const cuit = digits(input.taxId, "taxId", 11, 11);
  for (const [field, max] of [
    ["salesPoint", 99_999],
    ["voucherType", 999],
    ["number", 99_999_999],
  ] as const) {
    const value = input[field];
    if (!(Number.isSafeInteger(value) && value >= 1 && value <= max)) {
      invalid(field, `an integer from 1 through ${max}`);
    }
  }
  const total = Number(assertArcaMinorUnits(input.total, "total"));
  const currency = (input.currency ?? "PES").trim().toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(currency)) {
    invalid("currency", "a three-character ARCA currency id");
  }
  const ctz = currency === "PES" ? 1 : exchangeRate(input.exchangeRate);
  const codAut = digits(input.cae, "cae", 14, 14);
  const document = receiverDocument(input.document);
  return {
    ver: 1,
    fecha,
    cuit,
    ptoVta: input.salesPoint,
    tipoCmp: input.voucherType,
    nroCmp: input.number,
    importe: Number((total / 100).toFixed(2)),
    moneda: currency,
    ctz,
    ...document,
    tipoCodAut: input.authorization === "CAEA" ? "A" : "E",
    codAut,
  };
}

/** `toIsoDate` only checks the shape, so the calendar is checked here too. */
function isoCalendarDate(value: string): string {
  let compact: string;
  try {
    compact = normalizeWsfeDateInput(value as WsfeDateInput, "date");
  } catch {
    invalid("date", "a YYYY-MM-DD or YYYYMMDD calendar date");
  }
  const iso = toIsoDate(compact);
  if (iso === undefined) {
    invalid("date", "a YYYY-MM-DD or YYYYMMDD calendar date");
  }
  return iso;
}

/** Pesos per unit of a non-peso currency: the specification never defaults it. */
function exchangeRate(value: ArcaQrInput["exchangeRate"]): number {
  if (value === undefined) {
    invalid("exchangeRate", "a positive exchange rate for a non-peso currency");
  }
  const rate = Number(value);
  if (!(Number.isFinite(rate) && rate > 0)) {
    invalid("exchangeRate", "a positive number");
  }
  return rate;
}

/** Type 99 with number 0 is "unidentified"; the specification then omits both. */
function receiverDocument(
  document: ArcaQrInput["document"]
): Pick<ArcaQrPayload, "tipoDocRec" | "nroDocRec"> {
  if (document === undefined) {
    return {};
  }
  if (
    !(
      Number.isSafeInteger(document.type) &&
      document.type >= 0 &&
      document.type <= 99
    )
  ) {
    invalid("document.type", "an ARCA document type");
  }
  const number = digits(document.number, "document.number", 0, 20);
  if (document.type === 99 || number === 0) {
    return {};
  }
  return { tipoDocRec: document.type, nroDocRec: number };
}

function digits(
  value: number | string,
  field: string,
  min: number,
  max: number
): number {
  const text = String(value).trim();
  if (!/^\d*$/.test(text) || text.length < min || text.length > max) {
    invalid(field, min === max ? `${min} digits` : `${min} to ${max} digits`);
  }
  if (text === "") {
    return 0;
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    invalid(field, "a safe integer");
  }
  return parsed;
}

function invalid(field: string, expected: string): never {
  throw new ArcaInputError(`qr.${field} must be ${expected}.`, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
    expected,
  });
}
