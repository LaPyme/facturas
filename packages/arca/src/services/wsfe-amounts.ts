import { ARCA_VAT_RATES, type VoucherClass } from "../constants";
import { ArcaError, ArcaInputError } from "../errors";
import {
  arcaMinorUnitsToNumber,
  assertArcaMinorUnits,
  roundHalfEvenRatio,
  type SupportedVatRate,
} from "../internal/decimal";
import type { WsmtxcaLine } from "./issuance-wsmtxca";
import type { WsfeVatRate, WsfeVoucherInput } from "./wsfe";

/**
 * The line an item describes. WSFE ignores every field here and derives its
 * header from the money alone; WSMTXCA requires `description`, `quantity`,
 * `unit` and `unitPrice` and sends the line as it is. The line never carries
 * its own VAT amount: that follows from the item's `vat` and its money.
 */
export type ItemLine = {
  description?: string;
  quantity?: number;
  unit?: number;
  /** A major-unit decimal string with up to six decimals, unlike every other amount. */
  unitPrice?: string;
  discount?: number;
  code?: string;
  matrixCode?: string;
  matrixUnits?: number;
};
export type VatRate = SupportedVatRate | "exempt" | "untaxed";
export type VatItem = ItemLine &
  (
    | { net: number; gross?: never; amount?: never; vat: VatRate }
    | { gross: number; net?: never; amount?: never; vat: VatRate }
  );
export type AmountItem = ItemLine & {
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

/** WSMTXCA condition codes for the item rates WSFE has no rate id for. */
const UNTAXED_CONDITION = 1;
const EXEMPT_CONDITION = 2;

type LineDraft = {
  line: WsmtxcaLine;
  vat: bigint;
  amount: bigint;
  rate?: SupportedVatRate;
  field?: "net" | "gross";
};

/**
 * Derives the WSMTXCA provider lines from the same items the header came from,
 * so the two can never describe different money. Per-line VAT is reconciled
 * against the grouped Half Even arithmetic of `calculateWsfeAmounts()`: the
 * rounding residual of a rate, and the header's VAT adjustment, land on lines
 * of that rate, so the lines sum to the header exactly.
 */
export function deriveWsmtxcaLines(
  input: WsfeAmountsInput,
  vatAdjustment: number
): WsmtxcaLine[] {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    invalidItem("items", "a non-empty array of items");
  }
  const isVat = input.voucherClass === "A" || input.voucherClass === "B";
  const drafts: LineDraft[] = [];
  const groups = new Map<SupportedVatRate, { net: bigint; gross: bigint }>();
  for (const [index, item] of input.items.entries()) {
    const path = `items[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      invalidItem(path, "an item object");
    }
    drafts.push(lineDraft(item, path, isVat, groups));
  }
  reconcileGroups(drafts, groups);
  absorbAdjustment(drafts, BigInt(vatAdjustment));
  return drafts.map(({ line, vat, amount }) => ({
    ...line,
    amount: Number(amount),
    ...(input.voucherClass === "A" ? { vatAmount: Number(vat) } : {}),
  }));
}

function lineDraft(
  item: VatItem | AmountItem,
  path: string,
  isVat: boolean,
  groups: Map<SupportedVatRate, { net: bigint; gross: bigint }>
): LineDraft {
  const line = assertItemLine(item, path);
  if (!isVat) {
    // A class C line bears no VAT at all, so it reports the 0% condition.
    return {
      line: { ...line, vatCondition: RATES[0].id, amount: 0 },
      vat: 0n,
      amount: classCAmount(item, path),
    };
  }
  const { amount, field, rate } = vatItemAmount(item, path);
  if (rate === "exempt" || rate === "untaxed") {
    return {
      line: {
        ...line,
        vatCondition: rate === "exempt" ? EXEMPT_CONDITION : UNTAXED_CONDITION,
        amount: 0,
      },
      vat: 0n,
      amount,
    };
  }
  const { id, basisPoints } = RATES[rate];
  const group = groups.get(rate) ?? { net: 0n, gross: 0n };
  group[field] += amount;
  groups.set(rate, group);
  // A gross line already includes its VAT; a net line adds it.
  const vat =
    field === "gross"
      ? amount - roundHalfEvenRatio(amount * 10_000n, 10_000n + basisPoints)
      : roundHalfEvenRatio(amount * basisPoints, 10_000n);
  return {
    line: { ...line, vatCondition: id, amount: 0 },
    vat,
    amount: field === "gross" ? amount : amount + vat,
    rate,
    field,
  };
}

/**
 * The header totalizes by rate before rounding, so the line VATs of one rate
 * can miss the rate's VAT by cents. The difference is spread back over the
 * lines of that rate, a cent at a time, so no line ends with negative VAT.
 */
function reconcileGroups(
  drafts: readonly LineDraft[],
  groups: ReadonlyMap<SupportedVatRate, { net: bigint; gross: bigint }>
): void {
  for (const [rate, group] of groups) {
    const { basisPoints } = RATES[rate];
    const netFromGross = roundHalfEvenRatio(
      group.gross * 10_000n,
      10_000n + basisPoints
    );
    settle(
      drafts,
      (draft) => draft.rate === rate && draft.field === "net",
      roundHalfEvenRatio(group.net * basisPoints, 10_000n) -
        sumVat(drafts, (d) => d.rate === rate && d.field === "net"),
      true
    );
    // A gross line's own amount is fixed: its VAT moves inside that amount.
    settle(
      drafts,
      (draft) => draft.rate === rate && draft.field === "gross",
      group.gross -
        netFromGross -
        sumVat(drafts, (d) => d.rate === rate && d.field === "gross"),
      false
    );
  }
}

function sumVat(
  drafts: readonly LineDraft[],
  of: (draft: LineDraft) => boolean
): bigint {
  return drafts.reduce((sum, draft) => (of(draft) ? sum + draft.vat : sum), 0n);
}

/**
 * Moves `amount` cents of VAT onto the matching lines, one at a time, never
 * taking a line below zero. There is always such a line while cents remain:
 * the total being distributed is itself non-negative.
 */
function settle(
  drafts: readonly LineDraft[],
  of: (draft: LineDraft) => boolean,
  amount: bigint,
  movesItem: boolean
): void {
  let remaining = amount;
  while (remaining !== 0n) {
    const step = remaining > 0n ? 1n : -1n;
    const target = drafts.find(
      (draft) => of(draft) && (step > 0n || draft.vat > 0n)
    );
    if (target === undefined) {
      throw new ArcaError(
        "The derived WSMTXCA VAT does not fit its lines. This is an SDK invariant failure.",
        "ARCA_ISSUE_INVARIANT"
      );
    }
    target.vat += step;
    if (movesItem) {
      target.amount += step;
    }
    remaining -= step;
  }
}

/**
 * An asserted `total` shifts the header VAT by at most one cent per rate. The
 * lines carry that shift too, on lines that stay non-negative, which exist
 * because the header keeps its own VAT non-negative.
 */
function absorbAdjustment(drafts: readonly LineDraft[], adjustment: bigint) {
  settle(drafts, (draft) => draft.rate !== undefined, adjustment, true);
}

const ITEM_KEYS = [
  "net",
  "gross",
  "amount",
  "vat",
  "description",
  "quantity",
  "unit",
  "unitPrice",
  "discount",
  "code",
  "matrixCode",
  "matrixUnits",
];

/** WSMTXCA needs the line fields on every item; the index names the offender. */
function assertItemLine(
  item: VatItem | AmountItem,
  path: string
): Omit<WsmtxcaLine, "amount" | "vatAmount" | "vatCondition"> {
  assertRequiredLineFields(item, path);
  for (const key of ["code", "matrixCode"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "string") {
      invalidItem(`${path}.${key}`, "a string");
    }
  }
  if (item.matrixUnits !== undefined && !Number.isFinite(item.matrixUnits)) {
    invalidItem(`${path}.matrixUnits`, "a number");
  }
  return {
    ...(item.matrixUnits === undefined
      ? {}
      : { matrixUnits: item.matrixUnits }),
    ...(item.matrixCode === undefined ? {} : { matrixCode: item.matrixCode }),
    ...(item.code === undefined ? {} : { code: item.code }),
    description: item.description as string,
    quantity: item.quantity as number,
    unit: item.unit as number,
    unitPrice: item.unitPrice as string,
    discount: Number(
      assertArcaMinorUnits(item.discount ?? 0, `${path}.discount`)
    ),
  };
}

function assertRequiredLineFields(
  item: VatItem | AmountItem,
  path: string
): void {
  for (const key of Object.keys(item)) {
    if (!ITEM_KEYS.includes(key)) {
      invalidItem(`${path}.${key}`, "a supported item field");
    }
  }
  const { description, quantity, unit, unitPrice } = item;
  if (typeof description !== "string" || description.trim() === "") {
    invalidItem(`${path}.description`, "a non-empty description");
  }
  if (!Number.isFinite(quantity) || (quantity as number) <= 0) {
    invalidItem(`${path}.quantity`, "a positive quantity");
  }
  if (!Number.isInteger(unit) || (unit as number) < 0) {
    invalidItem(`${path}.unit`, "an ARCA unit of measure code");
  }
  if (typeof unitPrice !== "string" || !/^\d+(\.\d{1,6})?$/.test(unitPrice)) {
    invalidItem(
      `${path}.unitPrice`,
      "a major-unit decimal string with at most six decimals"
    );
  }
}
