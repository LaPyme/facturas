import { ARCA_VAT_RATES, type VoucherClass } from "../constants";
import { ArcaInputError } from "../errors";
import {
  arcaMinorUnitsToNumber,
  assertArcaMinorUnits,
  roundHalfEvenRatio,
  type SupportedVatRate,
} from "../internal/decimal";
import type { WsfeVatRate, WsfeVoucherInput } from "./wsfe";

export type VatRate = SupportedVatRate | "exempt" | "untaxed";
export type VatItem =
  | { net: number; gross?: never; amount?: never; vat: VatRate }
  | { gross: number; net?: never; amount?: never; vat: VatRate };
export type AmountItem = {
  amount: number;
  vat?: never;
  net?: never;
  gross?: never;
};
export type IssueAmounts = {
  computedTotal: number;
  sentTotal: number;
  vatAdjustment: number;
};
/** The class, not the issuer, fixes the accepted item shape and the arithmetic. */
export type WsfeAmountsInput = {
  voucherClass: VoucherClass;
  items: readonly (VatItem | AmountItem)[];
  total?: number;
};
type ExactAmounts = Pick<
  WsfeVoucherInput,
  | "totalAmount"
  | "netAmount"
  | "vatAmount"
  | "nonTaxableAmount"
  | "exemptAmount"
  | "taxAmount"
  | "vatRates"
>;

const RATES: Record<SupportedVatRate, { id: number; basisPoints: bigint }> = {
  0: { id: ARCA_VAT_RATES.IVA_0, basisPoints: 0n },
  2.5: { id: ARCA_VAT_RATES.IVA_2_5, basisPoints: 250n },
  5: { id: ARCA_VAT_RATES.IVA_5, basisPoints: 500n },
  10.5: { id: ARCA_VAT_RATES.IVA_10_5, basisPoints: 1050n },
  21: { id: ARCA_VAT_RATES.IVA_21, basisPoints: 2100n },
  27: { id: ARCA_VAT_RATES.IVA_27, basisPoints: 2700n },
};

/**
 * Pure integer money core. Amount fields are provider major units.
 * Invoices and credit notes share it: both resolve a class first.
 */
export function calculateWsfeAmounts(input: WsfeAmountsInput): {
  data: ExactAmounts;
  amounts: IssueAmounts;
} {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    invalidItem("items", "a non-empty array of items");
  }
  const isVat = input.voucherClass === "A" || input.voucherClass === "B";
  if (!(isVat || input.voucherClass === "C")) {
    invalidItem("voucherClass", "A, B or C");
  }
  const totals = collectItems(input.items, isVat);
  let net = totals.net;
  let vat = 0n;
  const { exempt, untaxed, groups } = totals;
  const vatRates: WsfeVatRate[] = [];
  // 10022: totalize by rate before rounding; never round each line.
  for (const [rate, group] of groups) {
    const { id, basisPoints } = RATES[rate];
    const netFromGross = roundHalfEvenRatio(
      group.gross * 10_000n,
      10_000n + basisPoints
    );
    const base = group.net + netFromGross;
    const tax =
      roundHalfEvenRatio(group.net * basisPoints, 10_000n) +
      group.gross -
      netFromGross;
    if (base === 0n) {
      continue;
    }
    net += base;
    vat += tax;
    vatRates.push({
      id,
      baseAmount: arcaMinorUnitsToNumber(base, "netAmount"),
      amount: arcaMinorUnitsToNumber(tax, "vatAmount"),
    });
  }
  // 10047: class C has only ImpNeto; 10048: exact header decomposition.
  const computed = net + vat + exempt + untaxed;
  arcaMinorUnitsToNumber(computed, "totalAmount");
  const sent =
    input.total === undefined
      ? computed
      : assertArcaMinorUnits(input.total, "total");
  const adjustment = sent - computed;
  // 10023: the high-level API deliberately uses only the absolute cents-per-rate allowance.
  const allowance = BigInt(vatRates.length);
  if (
    adjustment < -allowance ||
    adjustment > allowance ||
    vat + adjustment < 0n
  ) {
    throw new ArcaInputError(
      "total does not match the computed amount within the VAT allowance.",
      {
        code: "ARCA_INPUT_AMOUNT_MISMATCH",
        field: "total",
        expected: `${computed} minor units (at most ${allowance} minor units of VAT adjustment, with non-negative VAT)`,
      }
    );
  }
  return {
    data: {
      totalAmount: arcaMinorUnitsToNumber(sent, "totalAmount"),
      netAmount: arcaMinorUnitsToNumber(net, "netAmount"),
      vatAmount: arcaMinorUnitsToNumber(vat + adjustment, "vatAmount"),
      nonTaxableAmount: arcaMinorUnitsToNumber(untaxed, "nonTaxableAmount"),
      exemptAmount: arcaMinorUnitsToNumber(exempt, "exemptAmount"),
      taxAmount: 0,
      ...(isVat ? { vatRates } : {}),
    },
    amounts: {
      computedTotal: Number(computed),
      sentTotal: Number(sent),
      vatAdjustment: Number(adjustment),
    },
  };
}

function collectItems(
  items: readonly (VatItem | AmountItem)[],
  isVat: boolean
) {
  let net = 0n;
  let exempt = 0n;
  let untaxed = 0n;
  const groups = new Map<SupportedVatRate, { net: bigint; gross: bigint }>();
  for (const [index, item] of items.entries()) {
    const path = `items[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      invalidItem(path, "an item object");
    }
    if (!isVat) {
      net += classCAmount(item, path);
      continue;
    }
    const { amount, field, rate } = vatItemAmount(item, path);
    if (rate === "exempt") {
      exempt += amount;
      continue;
    }
    if (rate === "untaxed") {
      untaxed += amount;
      continue;
    }
    const group = groups.get(rate) ?? { net: 0n, gross: 0n };
    group[field] += amount;
    groups.set(rate, group);
  }
  return { net, exempt, untaxed, groups };
}

function classCAmount(item: VatItem | AmountItem, path: string): bigint {
  if ("vat" in item || "net" in item || "gross" in item) {
    invalidItem("items", "amount items for a class C voucher");
  }
  return assertArcaMinorUnits(item.amount as number, `${path}.amount`);
}

function vatItemAmount(item: VatItem | AmountItem, path: string) {
  if ("amount" in item || "net" in item === "gross" in item) {
    invalidItem(
      "items",
      "exactly one of net or gross, and vat, for a class A or B voucher"
    );
  }
  const field: "net" | "gross" = "net" in item ? "net" : "gross";
  const amount = assertArcaMinorUnits(
    item[field] as number,
    `${path}.${field}`
  );
  const rate = item.vat;
  if (
    rate !== "exempt" &&
    rate !== "untaxed" &&
    (typeof rate !== "number" || !Object.hasOwn(RATES, rate))
  ) {
    invalidItem(`${path}.vat`, "0, 2.5, 5, 10.5, 21, 27, exempt, or untaxed");
  }
  return { amount, field, rate };
}

function invalidItem(field: string, expected: string): never {
  throw new ArcaInputError(`${field} must be ${expected}.`, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
    expected,
  });
}
