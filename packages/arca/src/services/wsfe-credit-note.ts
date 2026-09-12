import type { VoucherClass } from "../constants";
import { ArcaInputError } from "../errors";
import {
  assertArcaMinorUnits,
  normalizeArcaAmountToMinorUnits,
} from "../internal/decimal";
import {
  applyFceFields,
  applyIssuanceFields,
  type IssuanceFields,
  minor,
  tributeTotal,
  validateIssuanceFields,
  voucherFamily,
} from "./issuance-fields";
import {
  normalizeWsfeDateInput,
  normalizeWsfeVoucherInput,
  type WsfeDateInput,
  type WsfeVoucherInfo,
  type WsfeVoucherInput,
} from "./wsfe";
import {
  calculateWsfeAmounts,
  type IssueAmounts,
  type VatItem,
  type WsfeAmountsInput,
} from "./wsfe-amounts";
import {
  assertIssueKeys,
  assertIssueObject,
  buenosAiresDate,
  type IssueInput,
  reviewedInvoiceAmounts,
} from "./wsfe-derive";
import type { VoucherCoordinates } from "./wsfe-identity";

/**
 * The credited lines and, at most, the note's own sales point and date.
 * Class, receiver, currency, concept and service dates come from the originals.
 *
 * The mode is explicit: `items` or a reviewed `amounts` breakdown credits the
 * chosen lines, `all: true` credits the whole original. A forgotten field never
 * credits the whole invoice. A full note mirrors the original's tributes; a
 * partial note carries the `taxes` the caller chose, never a prorated share.
 */
export type CreditNoteInput = Pick<
  IssuanceFields,
  "taxes" | "optionalFields" | "fce"
> & {
  /**
   * The authorized invoice or debit note the note corrects, or a non-empty
   * list of them. Every original is consulted and every one is associated to
   * the note; they must agree on everything the note inherits.
   */
  for: VoucherCoordinates | readonly VoucherCoordinates[];
  salesPoint?: number;
  date?: WsfeDateInput;
} & (
    | {
        items: NonNullable<IssueInput["items"]>;
        total?: number;
        all?: never;
        amounts?: never;
      }
    | {
        amounts: import("./issuance-fields").VoucherAmounts;
        items?: never;
        total?: number;
        all?: never;
      }
    | { all: true; items?: never; total?: never; amounts?: never }
  );

type CreditNote = { voucherType: number; voucherClass: VoucherClass };
type CreditNoteHeader = Omit<
  WsfeVoucherInput,
  | "totalAmount"
  | "netAmount"
  | "vatAmount"
  | "nonTaxableAmount"
  | "exemptAmount"
  | "taxAmount"
  | "vatRates"
>;
type DerivedCreditNote = {
  data: WsfeVoucherInput;
  voucherClass: VoucherClass;
  amounts: IssueAmounts;
  /** The items the header came from, so provider lines derive from the same money. */
  lineSource?: WsfeAmountsInput;
};

function invalid(reason: string): never {
  throw new ArcaInputError(`issueCreditNote cannot proceed: ${reason}.`, {
    code: "ARCA_INPUT_INVALID_VALUE",
  });
}
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null) {
    invalid(`original is missing ${field}`);
  }
  return value;
}

/**
 * Mirrors the original line by line, which items cannot reproduce cent-exact.
 * There is only ever one original here: a full note of several has no total.
 */
export function deriveWsfeFullCreditNote(
  original: WsfeVoucherInfo,
  input: CreditNoteInput,
  now = new Date(),
  kind: "creditNote" | "debitNote" = "creditNote"
): DerivedCreditNote {
  const { note, header } = prepareCreditNote([original], input, now, kind);
  const data: WsfeVoucherInput = {
    ...header,
    ...(original.taxes ? { taxes: structuredClone(original.taxes) } : {}),
    totalAmount: required(original.totalAmount, "totalAmount"),
    netAmount: required(original.netAmount, "netAmount"),
    vatAmount: required(original.vatAmount, "vatAmount"),
    exemptAmount: required(original.exemptAmount, "exemptAmount"),
    nonTaxableAmount: required(original.nonTaxableAmount, "nonTaxableAmount"),
    taxAmount: required(original.taxAmount, "taxAmount"),
    ...(original.vatRates === undefined
      ? {}
      : { vatRates: original.vatRates.map((rate) => ({ ...rate })) }),
  };
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

/** Credits chosen lines through the same amount pipeline as issue(). */
export function deriveWsfePartialCreditNote(
  originals: readonly WsfeVoucherInfo[],
  input: CreditNoteInput,
  now = new Date(),
  kind: "creditNote" | "debitNote" = "creditNote"
): DerivedCreditNote {
  if (input.items === undefined && input.amounts === undefined) {
    invalid("items is required to credit chosen lines");
  }
  // A requested total is minor units like every other amount. It is checked
  // here, before the original is read, so a non-integer never reaches BigInt().
  const requestedTotal =
    input.total === undefined
      ? undefined
      : assertArcaMinorUnits(input.total, "total");
  const { note, header } = prepareCreditNote(originals, input, now, kind);
  // The class comes from the original, so the item shape must match it.
  // A reviewed breakdown takes the same path invoices take.
  const lineSource: WsfeAmountsInput | undefined = input.amounts
    ? undefined
    : {
        voucherClass: note.voucherClass,
        items: input.items as NonNullable<IssueInput["items"]>,
        total:
          input.total === undefined
            ? undefined
            : input.total - tributeTotal(input.taxes ?? []),
      };
  const { data: amountsData, amounts } =
    lineSource === undefined
      ? reviewedInvoiceAmounts(
          input.amounts as NonNullable<CreditNoteInput["amounts"]>,
          input.taxes
        )
      : calculateWsfeAmounts(lineSource);
  // The ceiling is the sum of every original the note is associated to.
  const originalTotal = originals.reduce(
    (sum, original) =>
      sum +
      normalizeArcaAmountToMinorUnits(
        required(original.totalAmount, "totalAmount"),
        "totalAmount"
      ),
    0n
  );
  const ceiling =
    originals.length === 1 ? "the original" : "the sum of the originals";
  if (
    kind === "creditNote" &&
    (requestedTotal ?? BigInt(amounts.sentTotal)) > originalTotal
  ) {
    invalid(
      `the note total is greater than ${ceiling}; the SDK does not track earlier notes against an original`
    );
  }
  const data: WsfeVoucherInput = { ...header, ...amountsData };
  applyIssuanceFields(data, {
    ...input,
    fce: undefined,
    optionalFields: undefined,
  });
  const total = Number(
    [
      data.netAmount,
      data.vatAmount,
      data.exemptAmount,
      data.nonTaxableAmount,
      data.taxAmount,
    ].reduce(
      (sum, amount) => sum + normalizeArcaAmountToMinorUnits(amount, "amount"),
      0n
    )
  );
  const sentTotal =
    input.amounts && requestedTotal !== undefined
      ? Number(requestedTotal)
      : total;
  if (kind === "creditNote" && BigInt(sentTotal) > originalTotal) {
    invalid(`the note total is greater than ${ceiling}`);
  }
  data.totalAmount = minor(sentTotal, "total");
  amounts.computedTotal += total - amounts.sentTotal;
  amounts.sentTotal = sentTotal;
  normalizeWsfeVoucherInput(data);
  return {
    data,
    voucherClass: note.voucherClass,
    amounts,
    ...(lineSource === undefined ? {} : { lineSource }),
  };
}

/**
 * Shared evidence: everything except the amounts comes from the originals.
 * Each original derives a header of its own and they must come out identical,
 * because the note has one of each inherited field and several sources for it.
 * Only the associations accumulate.
 */
function prepareCreditNote(
  originals: readonly WsfeVoucherInfo[],
  input: CreditNoteInput,
  now: Date,
  kind: "creditNote" | "debitNote"
): { note: CreditNote; header: CreditNoteHeader } {
  const derived = originals.map((original) =>
    prepareOneCreditNote(original, input, now, kind)
  );
  const [first, ...rest] = derived;
  if (first === undefined) {
    invalid("for must name at least one original");
  }
  for (const other of rest) {
    assertInheritedHeader(first.header, other.header);
  }
  return {
    note: first.note,
    header: {
      ...first.header,
      associatedVouchers: derived.flatMap(
        (one) => one.header.associatedVouchers ?? []
      ),
    },
  };
}

/**
 * Everything the note inherits must be the same for every original. A field
 * that differs has no single value on the note, so the note is not derivable
 * and the caller issues one note per group instead.
 */
function assertInheritedHeader(
  first: CreditNoteHeader,
  other: CreditNoteHeader
): void {
  for (const field of new Set([...Object.keys(first), ...Object.keys(other)])) {
    if (field === "associatedVouchers") {
      continue;
    }
    const left = first[field as keyof CreditNoteHeader];
    const right = other[field as keyof CreditNoteHeader];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      invalid(
        `the originals disagree on ${field}, which the note inherits from them`
      );
    }
  }
}

function prepareOneCreditNote(
  original: WsfeVoucherInfo,
  input: CreditNoteInput,
  now: Date,
  kind: "creditNote" | "debitNote"
): { note: CreditNote; header: CreditNoteHeader } {
  assertOriginalExtensions(original);
  const family = voucherFamily(original.voucherType ?? 0);
  if (family.types[2] === original.voucherType) {
    invalid("original must be an invoice or debit note");
  }
  const note = {
    voucherClass: family.voucherClass,
    voucherType: family.types[kind === "creditNote" ? 2 : 1] as number,
  };
  if (
    !(
      ["A", "O"].includes(original.result ?? "") &&
      original.cae?.trim() &&
      original.caeExpiry?.trim()
    )
  ) {
    invalid("original is not authorized");
  }

  const voucherDate = normalizeWsfeDateInput(
    input.date ?? buenosAiresDate(now),
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
  const header: CreditNoteHeader = {
    salesPoint: input.salesPoint ?? required(original.salesPoint, "salesPoint"),
    voucherType: note.voucherType,
    concept: required(original.concept, "concept"),
    documentType: required(original.documentType, "documentType"),
    documentNumber: Number(required(original.documentNumber, "documentNumber")),
    receiverVatConditionId: required(
      original.receiverVatConditionId,
      "receiverVatConditionId"
    ),
    currencyId: required(original.currencyId, "currencyId"),
    ...(original.sameCurrencyForeignCancellation === undefined
      ? {}
      : {
          sameCurrencyForeignCancellation:
            original.sameCurrencyForeignCancellation,
        }),
    ...(original.buyers ? { buyers: structuredClone(original.buyers) } : {}),
    ...(original.activities
      ? { activities: structuredClone(original.activities) }
      : {}),
    ...(input.optionalFields
      ? { optionalFields: structuredClone(input.optionalFields) }
      : {}),
    exchangeRate: required(original.exchangeRate, "exchangeRate"),
    voucherDate,
    associatedVouchers: [
      {
        type: required(original.voucherType, "voucherType"),
        salesPoint: required(original.salesPoint, "salesPoint"),
        number: original.voucherNumber,
        voucherDate: originalDate,
      },
    ],
  };
  applyFceFields(header, input.fce);
  copyServiceDates(original, header);
  return { note, header };
}

function copyServiceDates(original: WsfeVoucherInfo, header: CreditNoteHeader) {
  if (header.concept !== 2 && header.concept !== 3) {
    return;
  }
  header.serviceStartDate = required(
    original.serviceStartDate,
    "serviceStartDate"
  ) as WsfeDateInput;
  header.serviceEndDate = required(
    original.serviceEndDate,
    "serviceEndDate"
  ) as WsfeDateInput;
  const due = normalizeWsfeDateInput(
    required(original.paymentDueDate, "paymentDueDate") as WsfeDateInput,
    "original.paymentDueDate"
  ) as WsfeDateInput;
  header.paymentDueDate = due < header.voucherDate ? header.voucherDate : due;
}

const CREDIT_NOTE_KEYS = [
  "for",
  "salesPoint",
  "date",
  "items",
  "total",
  "all",
  "taxes",
  "amounts",
  "optionalFields",
  "fce",
];
const TARGET_BOUNDS = [
  ["salesPoint", 99_999],
  ["voucherType", 999],
  ["number", 99_999_999],
] as const;

/** Zero I/O: rejects an ambiguous mode and copies the lines the caller owns. */
export function assertCreditNoteInput(input: CreditNoteInput): CreditNoteInput {
  assertIssueObject(input, "input");
  validateIssuanceFields(input);
  if ("associatedPeriod" in input) {
    throw new ArcaInputError(
      "issueCreditNote adjusts either the originals named in for or a period, never both; drop one of them.",
      {
        code: "ARCA_INPUT_RESERVED_FIELD",
        field: "associatedPeriod",
        expected: "an associated invoice through for",
      }
    );
  }
  assertIssueKeys(input, CREDIT_NOTE_KEYS, "input", "issueCreditNote()");
  const target = assertCreditNoteTargets(input.for);
  if (input.salesPoint !== undefined) {
    assertCreditNoteBound(input.salesPoint, 99_999, "salesPoint");
  }
  const date =
    input.date === undefined
      ? undefined
      : (normalizeWsfeDateInput(input.date, "date") as WsfeDateInput);
  const common = {
    ...(input.fce === undefined ? {} : { fce: structuredClone(input.fce) }),
    ...(input.taxes === undefined
      ? {}
      : { taxes: structuredClone(input.taxes) }),
    ...(input.optionalFields === undefined
      ? {}
      : { optionalFields: structuredClone(input.optionalFields) }),
    for: target,
    ...(input.salesPoint === undefined ? {} : { salesPoint: input.salesPoint }),
    ...(date === undefined ? {} : { date }),
  };
  if (input.items !== undefined && input.amounts !== undefined) {
    invalid("use items or amounts, never both");
  }
  if (
    (input.items === undefined && input.amounts === undefined) ===
    (input.all === undefined)
  ) {
    throw new ArcaInputError(
      "issueCreditNote needs exactly one mode: items or amounts for a partial note, or all: true for the whole original.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: input.items === undefined ? "input.items" : "input.all",
        expected: "exactly one of items, amounts or all: true",
      }
    );
  }
  if (input.all !== undefined) {
    assertFullMode(input);
    return { ...common, all: true };
  }
  if (input.amounts !== undefined) {
    return {
      ...common,
      amounts: structuredClone(input.amounts),
      ...(input.total === undefined ? {} : { total: input.total }),
    };
  }
  return {
    ...common,
    amounts: undefined,
    items: copyCreditNoteItems(input.items as NonNullable<IssueInput["items"]>),
    ...(input.total === undefined ? {} : { total: input.total }),
  };
}

/** One object stays one object; a list stays a list, so the input hash does. */
function assertCreditNoteTargets(
  value: CreditNoteInput["for"]
): VoucherCoordinates | VoucherCoordinates[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new ArcaInputError(
        "issueCreditNote requires for to name at least one authorized original.",
        {
          code: "ARCA_INPUT_MISSING_FIELD",
          field: "input.for",
          expected: "a non-empty array of { salesPoint, voucherType, number }",
        }
      );
    }
    return value.map((target, index) =>
      assertCreditNoteTarget(target, `for[${index}]`)
    );
  }
  return assertCreditNoteTarget(value as VoucherCoordinates, "for");
}

function assertCreditNoteTarget(
  value: VoucherCoordinates,
  path: string
): VoucherCoordinates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArcaInputError(
      "issueCreditNote requires for: the coordinates of the authorized invoice the note corrects.",
      {
        code: "ARCA_INPUT_MISSING_FIELD",
        field: `input.${path}`,
        expected: "{ salesPoint, voucherType, number }",
      }
    );
  }
  assertIssueKeys(
    value,
    ["salesPoint", "voucherType", "number"],
    `input.${path}`,
    "issueCreditNote()"
  );
  for (const [field, max] of TARGET_BOUNDS) {
    assertCreditNoteBound(value[field], max, `${path}.${field}`);
  }
  if (
    ![1, 2, 6, 7, 11, 12, 51, 52, 201, 202, 206, 207, 211, 212].includes(
      value.voucherType
    )
  ) {
    throw new ArcaInputError(
      "issueCreditNote requires an authorized invoice or debit note in a supported family in for.voucherType.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: `input.${path}.voucherType`,
        expected: "1, 6 or 11",
      }
    );
  }
  return {
    salesPoint: value.salesPoint,
    voucherType: value.voucherType,
    number: value.number,
  };
}

/** The originals a note input names, in the order the caller gave them. */
export function creditNoteTargets(
  input: CreditNoteInput
): readonly VoucherCoordinates[] {
  return Array.isArray(input.for)
    ? input.for
    : [input.for as VoucherCoordinates];
}

function assertCreditNoteBound(value: number, max: number, path: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ArcaInputError(
      `issueCreditNote requires input.${path} to be an integer from 1 through ${max}.`,
      { code: "ARCA_INPUT_INVALID_VALUE", field: `input.${path}` }
    );
  }
}

// The caller keeps the array it passed; a later mutation must not reach ARCA.
function copyCreditNoteItems<T extends readonly VatItem[] | readonly object[]>(
  items: T
): T {
  if (!Array.isArray(items)) {
    throw new ArcaInputError(
      "issueCreditNote requires items to be a non-empty array of items.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "input.items",
        expected: "a non-empty array of items",
      }
    );
  }
  return items.map((item) =>
    item === null || typeof item !== "object" ? item : { ...item }
  ) as unknown as T;
}

function assertOriginalExtensions(original: WsfeVoucherInfo) {
  for (const [field, rawField] of [
    ["taxes", "Tributos"],
    ["optionalFields", "Opcionales"],
    ["buyers", "Compradores"],
    ["activities", "Actividades"],
    ["associatedPeriod", "PeriodoAsoc"],
  ] as const) {
    if (original.raw[rawField] && original[field] === undefined) {
      invalid(`original ${field} could not be decoded`);
    }
  }
  try {
    validateIssuanceFields({
      taxes: original.taxes?.map((t) => ({
        id: t.id,
        description: t.description,
        base: Number(
          normalizeArcaAmountToMinorUnits(t.baseAmount, "taxes.base")
        ),
        rate: t.rate,
        amount: Number(
          normalizeArcaAmountToMinorUnits(t.amount, "taxes.amount")
        ),
      })),
      optionalFields: original.optionalFields,
      buyers: original.buyers,
      activities: original.activities,
    });
    if (original.associatedPeriod) {
      normalizeWsfeDateInput(
        original.associatedPeriod.startDate,
        "associatedPeriod.startDate"
      );
      normalizeWsfeDateInput(
        original.associatedPeriod.endDate,
        "associatedPeriod.endDate"
      );
    }
  } catch {
    invalid("original extension fields are incomplete or malformed");
  }
}

function assertFullMode(input: CreditNoteInput): void {
  if (input.all !== true) {
    throw new ArcaInputError(
      "issueCreditNote accepts only all: true; pass items to credit chosen lines.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "input.all",
        expected: "the literal true",
      }
    );
  }
  if (
    input.total !== undefined ||
    input.taxes !== undefined ||
    input.amounts !== undefined
  ) {
    throw new ArcaInputError(
      "issueCreditNote takes total only with items; all: true credits the original's own total.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "input.total",
        expected: "no total when all is true",
      }
    );
  }
  if (Array.isArray(input.for) && input.for.length > 1) {
    throw new ArcaInputError(
      "issueCreditNote takes all: true against one original; a full note of several originals has no single total. Pass items or amounts instead.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: "input.all",
        expected: "one original in for when all is true",
      }
    );
  }
}
