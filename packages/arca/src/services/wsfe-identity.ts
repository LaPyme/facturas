import {
  normalizeArcaAmountToMinorUnits,
  serializeArcaExchangeRate,
} from "../internal/decimal";
import type { WsfeVatRate, WsfeVoucherInfo, WsfeVoucherInput } from "./wsfe";
import { normalizeWsfeDateInput } from "./wsfe";

export type VoucherCoordinates = {
  salesPoint: number;
  voucherType: number;
  number: number;
};

/** Raw-free consultation evidence. Missing provider fields remain absent. */
export type VoucherSummary = {
  number: number;
  salesPoint?: number;
  voucherType?: number;
  date?: string;
  concept?: number;
  documentType?: number;
  documentNumber?: string;
  receiverVatConditionId?: number;
  currencyId?: string;
  exchangeRate?: number;
  totalAmount?: number;
  netAmount?: number;
  vatAmount?: number;
  exemptAmount?: number;
  nonTaxableAmount?: number;
  taxAmount?: number;
  vatRates?: { id: number; baseAmount: number; amount: number }[];
  serviceStartDate?: string;
  serviceEndDate?: string;
  paymentDueDate?: string;
  result?: string;
  cae?: string;
  caeExpiry?: string;
};

export type WsfeIdentityMatch =
  | { matches: true }
  | { matches: false; evidence: "conflict" | "incomplete"; reason: string };

/**
 * Compares the invoice subset supported by vouchers.issue(). This proves
 * consistency, not authorship. Configure a store and pass idempotencyKey for retries.
 * Unsupported exact-API extensions are incomplete.
 */
export function matchWsfeVoucherIdentity(
  sent: WsfeVoucherInput,
  number: number,
  found: WsfeVoucherInfo
): WsfeIdentityMatch {
  let missing: string | undefined;
  const compare = (
    field: string,
    expected: unknown,
    actual: unknown,
    normalize?: (value: never) => unknown
  ): WsfeIdentityMatch | undefined => {
    if (actual === undefined || actual === null || expected === undefined) {
      missing ??= field;
      return undefined;
    }
    try {
      const left = normalize ? normalize(expected as never) : expected;
      const right = normalize ? normalize(actual as never) : actual;
      if (left !== right) {
        return {
          matches: false,
          evidence: "conflict",
          reason: `${field} differs from the sent input`,
        };
      }
    } catch {
      missing ??= field;
    }
    return undefined;
  };
  const checks: [string, unknown, unknown, ((value: never) => unknown)?][] = [
    ["voucherType", sent.voucherType, found.voucherType],
    ["salesPoint", sent.salesPoint, found.salesPoint],
    ["number", number, found.voucherNumber, normalizeVoucherNumber],
    [
      "date",
      sent.voucherDate,
      found.voucherDate,
      (value) => normalizeWsfeDateInput(value, "date"),
    ],
    ["concept", sent.concept, found.concept],
    ["documentType", sent.documentType, found.documentType],
    [
      "documentNumber",
      sent.documentNumber,
      found.documentNumber,
      normalizeDocument,
    ],
    [
      "receiverVatConditionId",
      sent.receiverVatConditionId,
      found.receiverVatConditionId,
    ],
    ["currencyId", sent.currencyId, found.currencyId],
    [
      "exchangeRate",
      sent.exchangeRate ?? (sent.currencyId === "PES" ? 1 : undefined),
      found.exchangeRate,
      (value) => serializeArcaExchangeRate(value, "exchangeRate"),
    ],
  ];
  for (const field of [
    "totalAmount",
    "netAmount",
    "vatAmount",
    "exemptAmount",
    "nonTaxableAmount",
    "taxAmount",
  ] as const) {
    checks.push([
      field,
      sent[field],
      found[field],
      (value) => normalizeArcaAmountToMinorUnits(value, field),
    ]);
  }
  if (sent.concept === 2 || sent.concept === 3) {
    for (const field of [
      "serviceStartDate",
      "serviceEndDate",
      "paymentDueDate",
    ] as const) {
      checks.push([
        field,
        sent[field],
        found[field],
        (value) => normalizeWsfeDateInput(value, field),
      ]);
    }
  }
  for (const check of checks) {
    const result = compare(...check);
    if (result) {
      return result;
    }
  }
  const rates = compareVatRates(sent.vatRates ?? [], found.vatRates);
  if (!rates.matches) {
    if (rates.evidence === "conflict") {
      return rates;
    }
    missing ??= rates.reason;
  }
  if (sent.associatedVouchers?.length) {
    if (!found.associatedVouchers) {
      missing ??= "associatedVouchers";
    } else if (
      associationIdentity(sent.associatedVouchers) !==
      associationIdentity(found.associatedVouchers)
    ) {
      return {
        matches: false,
        evidence: "conflict",
        reason: "associatedVouchers differ from the sent input",
      };
    }
  }
  missing ??= incompleteAuthorization(sent, found);
  return missing
    ? {
        matches: false,
        evidence: "incomplete",
        reason: `Cannot verify ${missing}`,
      }
    : { matches: true };
}

function incompleteAuthorization(
  sent: WsfeVoucherInput,
  found: WsfeVoucherInfo
): string | undefined {
  let missing: string | undefined;
  // These fields have no complete consultation identity contract in this facade.
  if (sent.concept !== 1 && sent.concept !== 2 && sent.concept !== 3) {
    missing ??= "unsupported concept";
  }
  for (const field of [
    "taxes",
    "associatedPeriod",
    "optionalFields",
    "buyers",
    "activities",
    "sameCurrencyForeignCancellation",
  ] as const) {
    const value = sent[field];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      missing ??= `unsupported exact field ${field}`;
    }
  }
  if (!(found.result === "A" || found.result === "O")) {
    missing ??= "authorized result";
  }
  if (!found.cae?.trim()) {
    missing ??= "cae";
  }
  if (!found.caeExpiry?.trim()) {
    missing ??= "caeExpiry";
  }
  return missing;
}

function normalizeVoucherNumber(value: number): number {
  // The exact lookup mapper maps missing/malformed numbers to 0 or NaN.
  // Neither is evidence that a different voucher occupies the attempted number.
  if (!Number.isSafeInteger(value) || value < 1 || value > 99_999_999) {
    throw new Error("Invalid voucher number");
  }
  return value;
}

function normalizeDocument(value: string | number): bigint {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("Invalid document number");
  }
  return BigInt(text);
}

function compareVatRates(
  expected: WsfeVatRate[],
  actual: WsfeVatRate[] | undefined
): WsfeIdentityMatch {
  if (actual === undefined) {
    return expected.length === 0
      ? { matches: true }
      : { matches: false, evidence: "incomplete", reason: "vatRates" };
  }
  if (
    actual.length !== expected.length ||
    new Set(actual.map((rate) => rate.id)).size !== actual.length
  ) {
    return {
      matches: false,
      evidence: "conflict",
      reason: "vatRates ids differ from the sent input",
    };
  }
  for (const rate of expected) {
    const found = actual.find((item) => item.id === rate.id);
    if (!found) {
      return {
        matches: false,
        evidence: "conflict",
        reason: `vatRates id ${rate.id} differs from the sent input`,
      };
    }
    for (const field of ["baseAmount", "amount"] as const) {
      try {
        if (
          normalizeArcaAmountToMinorUnits(rate[field], field) !==
          normalizeArcaAmountToMinorUnits(found[field], field)
        ) {
          return {
            matches: false,
            evidence: "conflict",
            reason: `vatRates[${rate.id}].${field} differs from the sent input`,
          };
        }
      } catch {
        return {
          matches: false,
          evidence: "incomplete",
          reason: `vatRates[${rate.id}].${field}`,
        };
      }
    }
  }
  return { matches: true };
}

export function toVoucherSummary(found: WsfeVoucherInfo): VoucherSummary {
  const summary: VoucherSummary = { number: found.voucherNumber };
  for (const field of [
    "salesPoint",
    "voucherType",
    "concept",
    "documentType",
    "documentNumber",
    "receiverVatConditionId",
    "currencyId",
    "exchangeRate",
    "totalAmount",
    "netAmount",
    "vatAmount",
    "exemptAmount",
    "nonTaxableAmount",
    "taxAmount",
    "serviceStartDate",
    "serviceEndDate",
    "paymentDueDate",
    "result",
    "cae",
    "caeExpiry",
  ] as const) {
    if (found[field] !== undefined) {
      Object.assign(summary, { [field]: found[field] });
    }
  }
  if (found.voucherDate !== undefined) {
    summary.date = found.voucherDate;
  }
  if (found.vatRates !== undefined) {
    summary.vatRates = found.vatRates.map(({ id, baseAmount, amount }) => ({
      id,
      baseAmount,
      amount,
    }));
  }
  return summary;
}

function associationIdentity(
  vouchers: NonNullable<WsfeVoucherInput["associatedVouchers"]>
): string {
  return JSON.stringify(
    vouchers
      .map(({ type, salesPoint, number }) => `${type}:${salesPoint}:${number}`)
      .sort()
  );
}
