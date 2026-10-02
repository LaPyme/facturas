import { ARCA_CURRENCY_IDS, ARCA_VOUCHER_TYPES } from "../constants";
import {
  ArcaConfigurationError,
  ArcaInputError,
  ArcaLockTimeoutError,
  type ArcaSafeErrorMetadata,
  toArcaSafeErrorMetadata,
} from "../errors";
import { toIsoDate } from "../internal/dates";
import {
  isWithinArcaTolerance,
  roundHalfEvenRatio,
  serializeArcaExchangeRate,
} from "../internal/decimal";
import type { ArcaEnvironment } from "../internal/types";
import { MAX_WAIT_MS, throwIfAborted } from "../store/lock";
import {
  type ArcaStore,
  attemptKey,
  canonicalHash,
  storeCall,
} from "../store/types";
import type { ArcaFiscalIssue } from "./fiscal-evidence";
import { type ArcaQrPayload, arcaQrPayload, qrUrlForPayload } from "./qr";
import type { IssueOptions } from "./vouchers-types";
import { normalizeWsfeDateInput, type WsfeDateInput } from "./wsfe";
import type { IssueAmounts, ItemLine } from "./wsfe-amounts";
import {
  assertExportDateWindow,
  assertIssueKeys,
  assertIssueObject,
  buenosAiresDate,
} from "./wsfe-derive";
import type { VoucherCoordinates } from "./wsfe-identity";
import type {
  WsfexAuthorizationOutcome,
  WsfexExportType,
  WsfexItem,
  WsfexLanguage,
  WsfexService,
  WsfexVoucherInfo,
  WsfexVoucherInput,
} from "./wsfex";

/** Factura E (19), Nota de Débito E (20) and Nota de Crédito E (21). */
export type ExportVoucherType = 19 | 20 | 21;

/** A receiver abroad. ARCA needs `taxId`, `countryTaxId` or both (rule 1580). */
export type ExportReceiver = {
  /** ARCA destination country, from `wsfex.getCountries()`: 203 is Brasil. */
  country: number;
  name: string;
  address: string;
  /** The receiver's tax ID in its own country. */
  taxId?: string;
  /** ARCA's CUIT for the receiver's country, from `wsfex.getCountryTaxIds()`. */
  countryTaxId?: string;
};

/**
 * One exported line. `unit` is an ARCA unit of measure from
 * `wsfex.getUnits()`. Except for units 0, 97 and 99, `quantity` and
 * `unitPrice` are required and `amount` must equal their product less
 * `discount`. `amount` and `discount` are minor units; `amount` is negative
 * only for unit 99, a discount line, or 97, an advance.
 */
export type ExportItem = Pick<
  ItemLine,
  "quantity" | "unitPrice" | "discount" | "code"
> & {
  description: string;
  unit: number;
  amount: number;
};

export type ExportOfGoods = {
  kind: "goods";
  /** An Incoterm from `wsfex.getIncoterms()`, such as `FOB`. */
  incoterms: string;
  incotermsDetail?: string;
  /**
   * The shipping permits already issued, each with its destination. Omit it
   * while the goods have none yet: ARCA records that the permit is pending.
   */
  permits?: readonly { id: string; destination: number }[];
};
export type ExportOfServices = {
  /** Services, or `other` for exports that are neither goods nor services. */
  kind: "services" | "other";
  /** When the receiver pays, on or after the voucher date. */
  paymentDate: WsfeDateInput;
};

/**
 * A Factura E. ARCA authorizes it through WSFEX, never WSFE: `issue()` takes
 * this shape whenever `export` is present. The issuer's tax condition does
 * not change the class, so there is no `issuer`.
 */
export type ExportIssueInput = {
  salesPoint: number;
  to: ExportReceiver;
  export: ExportOfGoods | ExportOfServices;
  items: readonly ExportItem[];
  /** The reviewed total in minor units; must equal the sum of `items`. */
  total?: number;
  date?: WsfeDateInput;
  /** `ARS`, `USD`, or any ARCA currency id such as `{ id: "060" }` for euros. */
  currency?: "ARS" | "USD" | { id: string };
  /**
   * Pesos per unit, required for every currency but ARS. ARCA checks it
   * against its own rate: take it from `wsfex.getExchangeRate()`.
   */
  exchangeRate?: string;
  /** The receiver pays in the invoice's foreign currency (`CanMisMonExt`). */
  paidInForeignCurrency?: boolean;
  /** How the receiver pays, such as "Transferencia bancaria" (`Forma_pago`). */
  paymentTerms: string;
  /** The language of the printed voucher; Spanish when omitted. */
  language?: "es" | "en" | "pt";
  observations?: string;
  commercialObservations?: string;
};

type ExportNoteCommon = {
  /** The authorized export voucher the note adjusts. */
  for: VoucherCoordinates & { voucherType: ExportVoucherType };
  salesPoint?: number;
  date?: WsfeDateInput;
  /**
   * Overrides the original's rate. Services notes must keep the original's
   * rate (rule 2053), so it is refused for them.
   */
  exchangeRate?: string;
  observations?: string;
  commercialObservations?: string;
};
/** A Nota de Crédito E for chosen lines, or for every line with `all`. */
export type ExportCreditNoteInput = ExportNoteCommon &
  (
    | { items: readonly ExportItem[]; all?: never }
    | { all: true; items?: never }
  );
/** A Nota de Débito E always lists what it adds. */
export type ExportDebitNoteInput = ExportNoteCommon & {
  items: readonly ExportItem[];
  all?: never;
};

/** The normalized fiscal fields of an export voucher. Dates are `YYYY-MM-DD`. */
export type ExportHeader = {
  exportType: WsfexExportType;
  destination: number;
  receiverName: string;
  receiverAddress: string;
  receiverTaxId?: string;
  receiverCountryTaxId?: string;
  currencyId: string;
  exchangeRate?: string;
  paidInForeignCurrency?: boolean;
  language: WsfexLanguage;
  incoterms?: string;
  incotermsDetail?: string;
  /** Whether the voucher declared an issued shipping permit; absent on notes and services. */
  permitExists?: boolean;
  paymentTerms?: string;
  paymentDate?: string;
};

export type ExportIssuedVoucher = VoucherCoordinates & {
  voucherClass: "E";
  /** The request id (`Cmp.Id`) ARCA stored this voucher under. */
  requestId: number;
  date: string;
  header: ExportHeader;
  cae: string;
  caeExpiry: string;
  amounts: IssueAmounts;
  qr?: string;
  qrPayload?: ArcaQrPayload;
};

/** Raw-free consultation of one export voucher, money in minor units. */
export type ExportVoucherSummary = {
  number: number;
  salesPoint?: number;
  voucherType?: number;
  requestId?: number;
  date?: string;
  exportType?: number;
  destination?: number;
  receiverName?: string;
  receiverAddress?: string;
  receiverTaxId?: string;
  receiverCountryTaxId?: string;
  currencyId?: string;
  exchangeRate?: string;
  totalAmount?: number;
  result?: string;
  cae?: string;
  caeExpiry?: string;
};

export type ExportPreview = {
  voucherClass: "E";
  voucherType: ExportVoucherType;
  date: string;
  header: ExportHeader;
  amounts: IssueAmounts;
  request: WsfexVoucherInput;
  service: "wsfex";
  /** The original a note adjusts. */
  originals?: readonly ExportVoucherSummary[];
};

/** The outcome without `raw`, kept per kind so `reason` and `cae` survive. */
type Evidence = (WsfexAuthorizationOutcome extends infer T
  ? T extends unknown
    ? Omit<T, "raw">
    : never
  : never) & { rawResponse?: Record<string, unknown> };
/** What `issue()` sent: the voucher with the request id and number it took. */
export type ExportIssueRequest = WsfexVoucherInput & {
  id: number;
  number: number;
};
/** `request` is always present when `include.request` is `true`. */
export type ExportIssueOutcome<O extends IssueOptions = { include?: never }> = (
  | {
      kind: "authorized";
      recoveredByMatch: false;
      voucher: ExportIssuedVoucher;
      authorization: Evidence;
    }
  | {
      kind: "authorized";
      recoveredByMatch: true;
      voucher: ExportIssuedVoucher;
      attempt: Evidence;
      lookup: ExportVoucherSummary;
    }
  | {
      kind: "rejected";
      attempted: VoucherCoordinates;
      issues: ArcaFiscalIssue[];
      authorization: Evidence;
    }
  | {
      kind: "indeterminate";
      attempted: VoucherCoordinates;
      attempt: Evidence;
      lookup:
        | { kind: "not_found" }
        /** ARCA has this voucher but reports no approval, CAE or expiry. */
        | { kind: "incomplete"; reason: string }
        | { kind: "failed"; error: ArcaSafeErrorMetadata }
        | { kind: "aborted" };
    }
  | {
      kind: "conflict";
      attempted: VoucherCoordinates;
      attempt: Evidence;
      found: ExportVoucherSummary;
      reason: string;
    }
) &
  (O extends { include: { request: true } }
    ? { request: ExportIssueRequest }
    : { request?: ExportIssueRequest });

type ExportOperation = "issue" | "creditNote" | "debitNote";
type Prepared = { data: WsfexVoucherInput; amounts: IssueAmounts };
type Context = {
  store?: ArcaStore;
  environment: ArcaEnvironment;
  taxId: string;
};
/** Version 2 with `service: "wsfex"`: WSFE readers refuse it by its service. */
type ExportAttemptRecord = {
  v: 2;
  operation: ExportOperation;
  service: "wsfex";
  representedTaxId?: string;
  salesPoint: number;
  voucherType: number;
  number: number;
  requestId: number;
  inputHash: string;
  sent: WsfexVoucherInput;
  createdAt: string;
};

const EXPORT_TYPES: readonly number[] = [
  ARCA_VOUCHER_TYPES.FACTURA_E,
  ARCA_VOUCHER_TYPES.NOTA_DEBITO_E,
  ARCA_VOUCHER_TYPES.NOTA_CREDITO_E,
];
const LANGUAGES = { es: 1, en: 2, pt: 3 } as const;
const EXPORT_KINDS = { goods: 1, services: 2, other: 4 } as const;
/** Units whose lines carry no quantity or price (rule 1775). */
const UNPRICED_UNITS: readonly number[] = [0, 97, 99];

export function isExportVoucherType(voucherType: unknown): boolean {
  return typeof voucherType === "number" && EXPORT_TYPES.includes(voucherType);
}

export function isExportInput(input: unknown): input is ExportIssueInput {
  return input !== null && typeof input === "object" && "export" in input;
}

export function isExportNoteInput(
  input: unknown
): input is ExportCreditNoteInput {
  if (input === null || typeof input !== "object" || !("for" in input)) {
    return false;
  }
  const target = (input as { for: unknown }).for;
  return (
    target !== null &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    isExportVoucherType((target as { voucherType?: unknown }).voucherType)
  );
}

/** No I/O: every caller error throws before the first ARCA call. */
export function deriveExportInvoice(
  input: ExportIssueInput,
  now = new Date()
): Prepared {
  assertIssueObject(input, "input");
  assertIssueKeys(
    input,
    [
      "salesPoint",
      "to",
      "export",
      "items",
      "total",
      "date",
      "currency",
      "exchangeRate",
      "paidInForeignCurrency",
      "paymentTerms",
      "language",
      "observations",
      "commercialObservations",
    ],
    "input"
  );
  assertSalesPoint(input.salesPoint, "salesPoint");
  const receiver = deriveReceiver(input.to);
  const exported = deriveExport(input.export);
  const voucherDate = normalizeWsfeDateInput(
    input.date ?? buenosAiresDate(now),
    "date"
  ) as string;
  if (
    exported.paymentDate !== undefined &&
    exported.paymentDate < voucherDate
  ) {
    invalid("export.paymentDate", "on or after the voucher date");
  }
  const currency = deriveCurrency(input.currency, input.exchangeRate);
  if (input.paidInForeignCurrency !== undefined) {
    if (typeof input.paidInForeignCurrency !== "boolean") {
      invalid("paidInForeignCurrency", "a boolean");
    }
    if (currency.currencyId === ARCA_CURRENCY_IDS.ARS) {
      invalid("paidInForeignCurrency", "absent for an invoice in pesos");
    }
  }
  const { items, total } = deriveItems(input.items, "items");
  const reviewed = reviewedTotal(input.total, total);
  const data: WsfexVoucherInput = {
    voucherType: ARCA_VOUCHER_TYPES.FACTURA_E,
    salesPoint: input.salesPoint,
    voucherDate,
    exportType: exported.exportType,
    ...(exported.permitExists === undefined
      ? {}
      : { permitExists: exported.permitExists }),
    ...(exported.permits === undefined ? {} : { permits: exported.permits }),
    ...receiver,
    ...currency,
    ...(input.paidInForeignCurrency === undefined
      ? {}
      : {
          sameCurrencyForeignCancellation: input.paidInForeignCurrency
            ? "S"
            : "N",
        }),
    ...optionalText(
      input.commercialObservations,
      "commercialObservations",
      4000
    ),
    totalAmount: reviewed / 100,
    ...optionalText(input.observations, "observations", 1000),
    paymentTerms: text(input.paymentTerms, "paymentTerms", 50),
    ...(exported.incoterms === undefined
      ? {}
      : { incoterms: exported.incoterms }),
    ...(exported.incotermsDetail === undefined
      ? {}
      : { incotermsDetail: exported.incotermsDetail }),
    language: deriveLanguage(input.language),
    items,
    ...(exported.paymentDate === undefined
      ? {}
      : { paymentDate: exported.paymentDate }),
  };
  return {
    data,
    amounts: { computedTotal: total, sentTotal: reviewed, vatAdjustment: 0 },
  };
}

/**
 * A note inherits everything from its original but its lines, sales point,
 * date and observations. ARCA associates exactly one export voucher.
 */
export function deriveExportNote(
  original: WsfexVoucherInfo,
  input: ExportCreditNoteInput | ExportDebitNoteInput,
  kind: "creditNote" | "debitNote",
  now = new Date()
): Prepared {
  assertIssueKeys(
    input,
    [
      "for",
      "salesPoint",
      "date",
      "exchangeRate",
      "observations",
      "commercialObservations",
      "items",
      ...(kind === "creditNote" ? ["all"] : []),
    ],
    "input",
    kind === "creditNote" ? "issueCreditNote()" : "issueDebitNote()"
  );
  const exportType = noteExportType(original, kind);
  const salesPoint = input.salesPoint ?? original.salesPoint;
  assertSalesPoint(salesPoint, "salesPoint");
  const voucherDate = normalizeWsfeDateInput(
    input.date ?? buenosAiresDate(now),
    "date"
  ) as string;
  if (
    exportType === 2 &&
    original.voucherDate !== undefined &&
    voucherDate < original.voucherDate
  ) {
    invalid("date", "on or after the original's date for services");
  }
  const exchangeRate = noteRate(original, input.exchangeRate, exportType);
  const lines = noteLines(original, input);
  const data: WsfexVoucherInput = {
    voucherType:
      kind === "creditNote"
        ? ARCA_VOUCHER_TYPES.NOTA_CREDITO_E
        : ARCA_VOUCHER_TYPES.NOTA_DEBITO_E,
    salesPoint,
    voucherDate,
    exportType,
    ...inheritedReceiver(original),
    currencyId: original.currencyId,
    ...(exchangeRate === undefined ? {} : { exchangeRate }),
    ...optionalText(
      input.commercialObservations,
      "commercialObservations",
      4000
    ),
    totalAmount: lines.total / 100,
    ...optionalText(input.observations, "observations", 1000),
    associatedVouchers: [
      {
        voucherType: original.voucherType,
        salesPoint: original.salesPoint,
        number: original.number,
      },
    ],
    ...(original.incoterms === undefined
      ? {}
      : { incoterms: original.incoterms }),
    language:
      original.language === 2 || original.language === 3
        ? original.language
        : 1,
    items: lines.items,
  };
  return {
    data,
    amounts: {
      computedTotal: lines.total,
      sentTotal: lines.total,
      vatAdjustment: 0,
    },
  };
}

/** A credit note adjusts an invoice or a debit note, a debit note an invoice. */
function noteExportType(
  original: WsfexVoucherInfo,
  kind: "creditNote" | "debitNote"
): WsfexExportType {
  if (original.result !== undefined && original.result !== "A") {
    invalid("for", "an authorized voucher");
  }
  const allowed: readonly number[] =
    kind === "creditNote"
      ? [ARCA_VOUCHER_TYPES.FACTURA_E, ARCA_VOUCHER_TYPES.NOTA_DEBITO_E]
      : [ARCA_VOUCHER_TYPES.FACTURA_E];
  if (!allowed.includes(original.voucherType)) {
    invalid(
      "for.voucherType",
      kind === "creditNote" ? "19 or 20" : "19, a Factura E"
    );
  }
  const exportType = original.exportType;
  if (exportType !== 1 && exportType !== 2 && exportType !== 4) {
    throw new ArcaConfigurationError(
      "The original voucher reports no export type."
    );
  }
  return exportType;
}

/** Services notes keep the original's rate (rule 2053); others may set one. */
function noteRate(
  original: WsfexVoucherInfo,
  rate: string | undefined,
  exportType: WsfexExportType
): string | undefined {
  if (rate === undefined) {
    return original.exchangeRate;
  }
  if (exportType === 2) {
    invalid("exchangeRate", "absent: services notes keep the original's");
  }
  return deriveCurrency(
    original.currencyId === ARCA_CURRENCY_IDS.ARS
      ? "ARS"
      : { id: original.currencyId },
    rate
  ).exchangeRate;
}

function noteLines(
  original: WsfexVoucherInfo,
  input: ExportCreditNoteInput | ExportDebitNoteInput
): { items: readonly WsfexItem[]; total: number } {
  const all = "all" in input ? input.all : undefined;
  if ((input.items === undefined) === (all === undefined)) {
    throw new ArcaInputError(
      "issueCreditNote needs exactly one mode: items for a partial note, or all: true for the whole original.",
      {
        code: "ARCA_INPUT_INVALID_VALUE",
        field: input.items === undefined ? "items" : "all",
        expected: "exactly one of items or all: true",
      }
    );
  }
  if (all === undefined) {
    return deriveItems(input.items as readonly ExportItem[], "items");
  }
  if (all !== true) {
    invalid("all", "true");
  }
  return { items: original.items, total: originalTotal(original) };
}

function inheritedReceiver(original: WsfexVoucherInfo) {
  return {
    destination: original.destination,
    receiverName: original.receiverName,
    ...(original.receiverCountryTaxId === undefined
      ? {}
      : { receiverCountryTaxId: original.receiverCountryTaxId }),
    receiverAddress: original.receiverAddress,
    ...(original.receiverTaxId === undefined
      ? {}
      : { receiverTaxId: original.receiverTaxId }),
  };
}

/** Checked where a new voucher would be sent, never on replay. */
export function assertExportWindow(data: WsfexVoucherInput, now = new Date()) {
  assertExportDateWindow(
    (data.voucherDate ?? buenosAiresDate(now)) as WsfeDateInput,
    data.exportType === 2,
    buenosAiresDate(now)
  );
}

export function exportPreview(
  prepared: Prepared,
  originals?: readonly ExportVoucherSummary[]
): ExportPreview {
  return {
    voucherClass: "E",
    voucherType: prepared.data.voucherType,
    date: isoDate(prepared.data.voucherDate) as string,
    header: exportHeader(prepared.data),
    amounts: { ...prepared.amounts },
    request: structuredClone(prepared.data) as WsfexVoucherInput,
    service: "wsfex",
    ...(originals === undefined ? {} : { originals }),
  };
}

export type ExportIssuance = {
  issue(
    prepared: Prepared,
    operation: ExportOperation,
    hashInput: unknown,
    options: IssueOptions
  ): Promise<ExportIssueOutcome>;
  /** Consults the original a note adjusts; `null` when ARCA has none. */
  original(
    coordinates: VoucherCoordinates,
    options: IssueOptions
  ): Promise<WsfexVoucherInfo | null>;
  lookup(
    coordinates: VoucherCoordinates,
    options: IssueOptions
  ): Promise<ExportVoucherSummary | null>;
  lastAuthorized(
    sequence: Omit<VoucherCoordinates, "number">,
    options: IssueOptions
  ): Promise<number>;
  /**
   * Settles an export reservation from ARCA's record of its number. Reads
   * only: it never sends the voucher, so it never authorizes one.
   */
  recover(
    key: string,
    record: string,
    options: IssueOptions
  ): Promise<ExportIssueOutcome>;
};

/**
 * Keyed export issuance rests on WSFEX's own request id: resending the same
 * `Cmp.Id` returns ARCA's stored answer instead of a second voucher. The id
 * belongs to the whole CUIT, not to one sales point, so the id and the number
 * are read and the voucher sent under one lock per CUIT.
 */
export function createExportIssuance(
  wsfex: WsfexService,
  context: Context
): ExportIssuance {
  return {
    issue: (prepared, operation, hashInput, options) =>
      issueExport(wsfex, context, prepared, operation, hashInput, options),
    async original(coordinates, options) {
      const result = await wsfex.lookupVoucher({
        ...auth(options),
        ...coordinates,
      });
      return result.kind === "found" ? result.voucher : null;
    },
    async lookup(coordinates, options) {
      const result = await wsfex.lookupVoucher({
        ...auth(options),
        ...coordinates,
      });
      return result.kind === "found" ? exportSummary(result.voucher) : null;
    },
    lastAuthorized: (sequence, options) =>
      wsfex.getLastVoucherNumber({ ...auth(options), ...sequence }),
    recover: (key, json, options) =>
      recoverExport(wsfex, context, key, json, options),
  };
}

async function recoverExport(
  wsfex: WsfexService,
  context: Context,
  key: string,
  json: string,
  options: IssueOptions
): Promise<ExportIssueOutcome> {
  const first = readExportRecord(json);
  const issuer = first.representedTaxId ?? context.taxId;
  if (
    options.representedTaxId !== undefined &&
    String(options.representedTaxId) !== issuer
  ) {
    throw new ArcaInputError(
      "Reservation belongs to another represented taxpayer",
      { code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" }
    );
  }
  const consulted: IssueOptions = {
    ...options,
    ...(first.representedTaxId === undefined
      ? {}
      : { representedTaxId: first.representedTaxId }),
  };
  // A retry of this key resends under the CUIT lock and may move its request
  // id there. Waiting for the lock and reading the reservation again keeps
  // this consultation on the id and number the retry left.
  return await exportLock(
    context,
    issuer,
    options
  )(async () => {
    const store = context.store;
    const latest = store
      ? await storeCall(() =>
          store.get(attemptKey(context.environment, context.taxId, key))
        )
      : null;
    const record = latest === null ? first : readExportRecord(latest);
    const outcome = await consultReservation(wsfex, record, consulted, issuer);
    return options.include?.request
      ? {
          ...outcome,
          request: {
            ...structuredClone(record.sent),
            id: record.requestId,
            number: record.number,
          },
        }
      : outcome;
  });
}

async function consultReservation(
  wsfex: WsfexService,
  record: ExportAttemptRecord,
  options: IssueOptions,
  issuer: string
): Promise<ExportIssueOutcome> {
  const attempted = {
    salesPoint: record.salesPoint,
    voucherType: record.voucherType,
    number: record.number,
  };
  // No write was observed here: the attempt is the reservation itself.
  const attempt: Evidence = {
    service: "wsfex",
    operation: "FEXAuthorize",
    kind: "indeterminate",
    reason: "incomplete_response",
    results: {},
    errors: [],
    observations: [],
  };
  const total = Math.round(record.sent.totalAmount * 100);
  const amounts = { computedTotal: total, sentTotal: total, vatAdjustment: 0 };
  let found: WsfexVoucherInfo | null;
  try {
    const result = await wsfex.lookupVoucher({
      ...auth(options),
      ...attempted,
    });
    found = result.kind === "found" ? result.voucher : null;
  } catch (error) {
    return {
      kind: "indeterminate",
      attempted,
      attempt,
      lookup: options.abortSignal?.aborted
        ? { kind: "aborted" }
        : { kind: "failed", error: toArcaSafeErrorMetadata(error) },
    };
  }
  return settled(
    attempt as WsfexAuthorizationOutcome,
    attempt,
    found,
    record.requestId,
    attempted,
    record.sent,
    (authorization) =>
      issuedVoucher(
        record.sent,
        attempted,
        record.requestId,
        authorization,
        amounts,
        issuer
      )
  );
}

/** One lock per CUIT: its request ids and every export sequence share it. */
function exportLock(context: Context, issuer: string, options: IssueOptions) {
  const key = `arca:v1:lock:wsfex:${context.environment}:${issuer}`;
  return <T>(fn: () => Promise<T>) =>
    context.store?.withLock
      ? context.store.withLock(key, fn, { signal: options.abortSignal })
      : withLocalLock(key, fn, options.abortSignal);
}

function auth(options: IssueOptions) {
  return {
    ...(options.representedTaxId === undefined
      ? {}
      : { representedTaxId: options.representedTaxId }),
    ...(options.forceRefresh === undefined
      ? {}
      : { forceRefresh: options.forceRefresh }),
    ...(options.abortSignal === undefined
      ? {}
      : { abortSignal: options.abortSignal }),
  };
}

async function issueExport(
  wsfex: WsfexService,
  context: Context,
  prepared: Prepared,
  operation: ExportOperation,
  hashInput: unknown,
  options: IssueOptions
): Promise<ExportIssueOutcome> {
  if (options.service !== undefined) {
    invalid("options.service", "absent: export vouchers always use WSFEX");
  }
  if (options.number !== undefined) {
    invalid("options.number", "absent: WSFEX numbers are read under a lock");
  }
  const representedTaxId =
    options.representedTaxId === undefined
      ? undefined
      : String(options.representedTaxId);
  const issuer = representedTaxId ?? context.taxId;
  const lock = exportLock(context, issuer, options);
  const idempotencyKey = options.idempotencyKey;
  if (idempotencyKey === undefined || !context.store) {
    assertExportWindow(prepared.data);
    return lock(() => fresh());
  }
  const store = context.store;
  const recordKey = attemptKey(
    context.environment,
    context.taxId,
    idempotencyKey
  );
  const inputHash = canonicalHash({
    input: hashInput,
    representedTaxId,
    service: "wsfex",
  });
  const existing = await storeCall(() => store.get(recordKey));
  if (existing !== null) {
    // Read again under the lock: a fresh claim may have moved its request id.
    return lock(async () =>
      replay((await storeCall(() => store.get(recordKey))) ?? existing)
    );
  }
  assertExportWindow(prepared.data);
  return lock(async () => {
    const prior = await storeCall(() => store.get(recordKey));
    return prior === null ? fresh() : replay(prior);
  });

  async function fresh(): Promise<ExportIssueOutcome> {
    const { data } = prepared;
    const number =
      (await wsfex.getLastVoucherNumber({
        ...auth(options),
        salesPoint: data.salesPoint,
        voucherType: data.voucherType,
      })) + 1;
    const id = await nextRequestId();
    if (idempotencyKey === undefined || !context.store) {
      return submit({ id, number, data, fresh: true });
    }
    const record: ExportAttemptRecord = {
      v: 2,
      operation,
      service: "wsfex",
      ...(representedTaxId === undefined ? {} : { representedTaxId }),
      salesPoint: data.salesPoint,
      voucherType: data.voucherType,
      number,
      requestId: id,
      inputHash,
      sent: data,
      createdAt: new Date().toISOString(),
    };
    const store = context.store;
    if (await storeCall(() => store.add(recordKey, JSON.stringify(record)))) {
      return submit({ id, number, data, fresh: true, record });
    }
    const winner = await storeCall(() => store.get(recordKey));
    if (winner === null) {
      throw new ArcaConfigurationError(
        "ARCA reservation disappeared after atomic creation lost."
      );
    }
    return replay(winner);
  }

  function replay(json: string): Promise<ExportIssueOutcome> {
    const stored = readExportRecord(json);
    if (
      stored.operation !== operation ||
      stored.inputHash !== inputHash ||
      stored.representedTaxId !== representedTaxId
    ) {
      throw new ArcaInputError(
        "The idempotency key was already used with different input or operation.",
        {
          code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH",
          field: "options.idempotencyKey",
        }
      );
    }
    return submit({
      id: stored.requestId,
      number: stored.number,
      data: stored.sent,
      fresh: false,
      record: stored,
    });
  }

  async function submit(claim: {
    id: number;
    number: number;
    data: WsfexVoucherInput;
    fresh: boolean;
    record?: ExportAttemptRecord;
  }): Promise<ExportIssueOutcome> {
    const first = await attemptOnce(claim, claim.id, claim.fresh);
    if (first !== "collided") {
      return first;
    }
    // A reused id answered another request's voucher, so ARCA never processed
    // this one: a fresh claim takes a new id, once.
    const id = await nextRequestId();
    await moveRecord(claim.record, id);
    const second = await attemptOnce(claim, id, true);
    if (second === "collided") {
      throw new ArcaConfigurationError("WSFEX answered a reused id twice.");
    }
    return second;
  }

  async function attemptOnce(
    claim: { number: number; data: WsfexVoucherInput },
    id: number,
    mayCollide: boolean
  ): Promise<ExportIssueOutcome | "collided"> {
    const { number, data } = claim;
    const attempted = {
      salesPoint: data.salesPoint,
      voucherType: data.voucherType,
      number,
    };
    const finish = (outcome: ExportIssueOutcome): ExportIssueOutcome =>
      options.include?.request
        ? { ...outcome, request: { ...structuredClone(data), id, number } }
        : outcome;
    const outcome = await send(data, id, number);
    const attempt = evidence(outcome);
    const direct = answered(outcome, attempt, id, attempted);
    if (direct !== undefined) {
      return finish(
        direct.kind === "authorized"
          ? { ...direct, voucher: issued(data, attempted, id, direct.voucher) }
          : direct
      );
    }
    // Reprocessed, contradictory, out of sequence or unanswered: ARCA's
    // record of this number decides, matched by the request id it stored.
    const consulted = await consult(outcome, attempt, attempted);
    if ("outcome" in consulted) {
      return finish(consulted.outcome);
    }
    const { found } = consulted;
    if (
      mayCollide &&
      outcome.kind === "authorized" &&
      outcome.reprocessed === true &&
      found === null
    ) {
      return "collided";
    }
    return finish(
      settled(outcome, attempt, found, id, attempted, data, (voucher) =>
        issued(data, attempted, id, voucher)
      )
    );
  }

  async function consult(
    outcome: WsfexAuthorizationOutcome,
    attempt: Evidence,
    attempted: VoucherCoordinates
  ): Promise<
    { found: WsfexVoucherInfo | null } | { outcome: ExportIssueOutcome }
  > {
    const aborted = () => ({
      outcome: {
        kind: "indeterminate" as const,
        attempted,
        attempt,
        lookup: { kind: "aborted" as const },
      },
    });
    if (options.abortSignal?.aborted && outcome.kind !== "authorized") {
      return aborted();
    }
    try {
      const result = await wsfex.lookupVoucher({
        ...auth(options),
        ...attempted,
      });
      return { found: result.kind === "found" ? result.voucher : null };
    } catch (error) {
      return options.abortSignal?.aborted
        ? aborted()
        : {
            outcome: {
              kind: "indeterminate",
              attempted,
              attempt,
              lookup: { kind: "failed", error: toArcaSafeErrorMetadata(error) },
            },
          };
    }
  }

  /**
   * ARCA's last id only counts requests it received. A reservation whose send
   * never arrived keeps its id, so the next one starts past every id this
   * store handed out, and a replay can never meet another key's voucher. Read
   * and written under the CUIT lock, before the reservation that uses it.
   */
  async function nextRequestId(): Promise<number> {
    const received = await wsfex.getLastRequestId(auth(options));
    const key = requestIdKey(context.environment, issuer);
    const store = context.store;
    const issued = store
      ? readRequestIdMarker(await storeCall(() => store.get(key)))
      : (localRequestIds.get(key) ?? 0);
    const id = Math.max(received, issued) + 1;
    if (id > MAX_REQUEST_ID) {
      throw new ArcaConfigurationError("WSFEX request ids are exhausted.");
    }
    if (store) {
      const marker: RequestIdMarker = { v: 1, id };
      await storeCall(() => store.set(key, JSON.stringify(marker)));
    } else {
      localRequestIds.set(key, id);
    }
    return id;
  }

  function send(data: WsfexVoucherInput, id: number, number: number) {
    const once = (forceRefresh?: boolean) =>
      wsfex.issue({
        ...data,
        id,
        number,
        ...auth({
          ...options,
          ...(forceRefresh ? { forceRefresh: true } : {}),
        }),
      });
    return once().then((outcome) =>
      outcome.kind === "indeterminate" &&
      outcome.reason === "authentication_rejected"
        ? once(true)
        : outcome
    );
  }

  async function moveRecord(
    record: ExportAttemptRecord | undefined,
    id: number
  ) {
    const store = context.store;
    if (record === undefined || store === undefined) {
      return;
    }
    const moved: ExportAttemptRecord = { ...record, requestId: id };
    await storeCall(() => store.set(recordKey, JSON.stringify(moved)));
  }

  function issued(
    data: WsfexVoucherInput,
    attempted: VoucherCoordinates,
    id: number,
    authorization: Authorized
  ): ExportIssuedVoucher {
    return issuedVoucher(
      data,
      attempted,
      id,
      authorization,
      prepared.amounts,
      issuer
    );
  }

  function evidence(outcome: WsfexAuthorizationOutcome): Evidence {
    const { raw, ...rest } = outcome;
    return options.include?.rawResponse && raw !== undefined
      ? { ...rest, rawResponse: raw }
      : rest;
  }
}

type Authorized = { cae: string; caeExpiry?: string };

function issuedVoucher(
  data: WsfexVoucherInput,
  attempted: VoucherCoordinates,
  id: number,
  authorization: Authorized,
  amounts: IssueAmounts,
  issuer: string
): ExportIssuedVoucher {
  const date = isoDate(data.voucherDate) as string;
  return {
    ...attempted,
    voucherClass: "E",
    requestId: id,
    date,
    header: exportHeader(data),
    cae: authorization.cae,
    caeExpiry: isoDate(authorization.caeExpiry) ?? "",
    amounts: { ...amounts },
    ...exportQr(issuer, attempted, data, date, authorization.cae),
  };
}

/**
 * An answer that needs no lookup: a plain authorization that names this
 * request, or a rejection other than an out-of-sequence number.
 */
function answered(
  outcome: WsfexAuthorizationOutcome,
  attempt: Evidence,
  id: number,
  attempted: VoucherCoordinates
):
  | {
      kind: "authorized";
      recoveredByMatch: false;
      voucher: Authorized;
      authorization: Evidence;
    }
  | Extract<ExportIssueOutcome, { kind: "rejected" }>
  | undefined {
  if (
    outcome.kind === "authorized" &&
    !outcome.reprocessed &&
    echoes(outcome, id, attempted)
  ) {
    return {
      kind: "authorized",
      recoveredByMatch: false,
      voucher: { cae: outcome.cae, caeExpiry: outcome.caeExpiry },
      authorization: attempt,
    };
  }
  if (outcome.kind === "rejected" && !hasError(outcome, "1535")) {
    return {
      kind: "rejected",
      attempted,
      issues: [...outcome.errors, ...outcome.observations],
      authorization: attempt,
    };
  }
  return undefined;
}

/** What ARCA's record of the number says about this request. */
function settled(
  outcome: WsfexAuthorizationOutcome,
  attempt: Evidence,
  found: WsfexVoucherInfo | null,
  id: number,
  attempted: VoucherCoordinates,
  sent: WsfexVoucherInput,
  issue: (authorization: Authorized) => ExportIssuedVoucher
): ExportIssueOutcome {
  if (found !== null && found.id === id && sameVoucher(found, sent)) {
    const authorized = outcome.kind === "authorized" ? outcome : undefined;
    const cae = found.cae ?? authorized?.cae;
    const caeExpiry = found.caeExpiry ?? authorized?.caeExpiry;
    // Matching fields prove whose voucher it is, never that ARCA approved it.
    if (found.result !== "A" || !cae || !caeExpiry) {
      return {
        kind: "indeterminate",
        attempted,
        attempt,
        lookup: {
          kind: "incomplete",
          reason: "ARCA reports no approved result, CAE and CAE expiry",
        },
      };
    }
    const voucher = issue({ cae, caeExpiry });
    return authorized
      ? {
          kind: "authorized",
          recoveredByMatch: false,
          voucher,
          authorization: attempt,
        }
      : {
          kind: "authorized",
          recoveredByMatch: true,
          voucher,
          attempt,
          lookup: exportSummary(found),
        };
  }
  if (found !== null) {
    return {
      kind: "conflict",
      attempted,
      attempt,
      found: exportSummary(found),
      reason:
        found.id === id
          ? "ARCA stored different fiscal fields under this request id"
          : "Another request holds this voucher number",
    };
  }
  if (outcome.kind === "rejected") {
    return {
      kind: "rejected",
      attempted,
      issues: [...outcome.errors, ...outcome.observations],
      authorization: attempt,
    };
  }
  return {
    kind: "indeterminate",
    attempted,
    attempt,
    lookup: { kind: "not_found" },
  };
}

function echoes(
  outcome: WsfexAuthorizationOutcome,
  id: number,
  attempted: VoucherCoordinates
): boolean {
  const echo = outcome.echo ?? {};
  return (
    (echo.id === undefined || echo.id === id) &&
    (echo.salesPoint === undefined ||
      echo.salesPoint === attempted.salesPoint) &&
    (echo.voucherType === undefined ||
      echo.voucherType === attempted.voucherType) &&
    (echo.number === undefined || echo.number === attempted.number)
  );
}

function hasError(outcome: WsfexAuthorizationOutcome, code: string): boolean {
  return outcome.errors.some((issue) => issue.code === code);
}

/**
 * The stored id names the request, but another system on the same CUIT may
 * reuse an id. ARCA answers the fields as they were sent, so the voucher is
 * this one only if its date, receiver, money and every line match too.
 */
function sameVoucher(found: WsfexVoucherInfo, sent: WsfexVoucherInput) {
  const lines = (items: readonly WsfexItem[] | undefined) =>
    (items ?? []).map((item) => [item.description.trim(), item.amount]);
  const text = (value: string | undefined) => value?.trim() || undefined;
  return (
    found.voucherType === sent.voucherType &&
    found.voucherDate === sent.voucherDate &&
    found.exportType === sent.exportType &&
    found.destination === sent.destination &&
    text(found.receiverName) === text(sent.receiverName) &&
    text(found.receiverTaxId) === text(sent.receiverTaxId) &&
    text(found.receiverCountryTaxId) === text(sent.receiverCountryTaxId) &&
    found.totalAmount === sent.totalAmount &&
    found.currencyId === sent.currencyId &&
    JSON.stringify(lines(found.items)) === JSON.stringify(lines(sent.items))
  );
}

/** `Cmp.Id` is N15. */
const MAX_REQUEST_ID = 999_999_999_999_999;
/** The highest request id this store handed out for a CUIT. */
type RequestIdMarker = { v: 1; id: number };
const localRequestIds = new Map<string, number>();

function requestIdKey(environment: ArcaEnvironment, issuer: string) {
  return `arca:v1:wsfex:request-id:${environment}:${issuer}`;
}

function readRequestIdMarker(json: string | null): number {
  if (json === null) {
    return 0;
  }
  try {
    const marker = JSON.parse(json) as RequestIdMarker;
    if (marker?.v === 1 && Number.isSafeInteger(marker.id) && marker.id >= 0) {
      return marker.id;
    }
  } catch {
    // Reported below.
  }
  throw new ArcaConfigurationError(
    "Invalid WSFEX request id marker; preserve it for reconciliation."
  );
}

const localLocks = new Map<string, Promise<void>>();
/**
 * Without a store lock, serializes the CUIT inside this process at least. Like
 * the store lock, the caller's signal and the same deadline stop only the
 * wait: a call that gives up never runs `fn`, and the queue behind it moves on.
 */
async function withLocalLock<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
) {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  localLocks.set(key, chained);
  // The entry leaves only once every holder before it and this call are done:
  // a waiter that gives up still keeps later callers behind the holder.
  chained.then(() => {
    if (localLocks.get(key) === chained) {
      localLocks.delete(key);
    }
  });
  try {
    await waitForTurn(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal) {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ArcaLockTimeoutError(
            "ARCA store lock stayed held; no work was attempted.",
            { reason: "held" }
          )
        ),
      MAX_WAIT_MS
    );
    timer.unref?.();
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([previous, stopped]).finally(() => {
    clearTimeout(timer);
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
  });
}

function readExportRecord(json: string): ExportAttemptRecord {
  let record: ExportAttemptRecord;
  try {
    record = JSON.parse(json) as ExportAttemptRecord;
  } catch (cause) {
    throw new ArcaConfigurationError(
      "Invalid ARCA reservation record; preserve it for reconciliation.",
      { cause }
    );
  }
  if (record?.service !== "wsfex") {
    throw new ArcaInputError(
      "The idempotency key was already used with different input or operation.",
      {
        code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH",
        field: "options.idempotencyKey",
      }
    );
  }
  if (
    record.v !== 2 ||
    !["issue", "creditNote", "debitNote"].includes(record.operation) ||
    typeof record.inputHash !== "string" ||
    !record.sent ||
    !Number.isSafeInteger(record.number) ||
    !Number.isSafeInteger(record.requestId) ||
    record.sent.salesPoint !== record.salesPoint ||
    record.sent.voucherType !== record.voucherType
  ) {
    throw new ArcaConfigurationError(
      "Invalid ARCA reservation record; preserve it for reconciliation."
    );
  }
  return record;
}

function exportHeader(data: WsfexVoucherInput): ExportHeader {
  const header: ExportHeader = {
    exportType: data.exportType,
    destination: data.destination,
    receiverName: data.receiverName,
    receiverAddress: data.receiverAddress,
    currencyId: data.currencyId,
    language: data.language,
  };
  assign(header, "receiverTaxId", data.receiverTaxId);
  assign(header, "receiverCountryTaxId", data.receiverCountryTaxId);
  assign(header, "exchangeRate", data.exchangeRate);
  assign(
    header,
    "paidInForeignCurrency",
    data.sameCurrencyForeignCancellation === undefined
      ? undefined
      : data.sameCurrencyForeignCancellation === "S"
  );
  assign(header, "incoterms", data.incoterms);
  assign(header, "incotermsDetail", data.incotermsDetail);
  assign(
    header,
    "permitExists",
    data.permitExists === undefined ? undefined : data.permitExists === "S"
  );
  assign(header, "paymentTerms", data.paymentTerms);
  assign(header, "paymentDate", isoDate(data.paymentDate));
  return header;
}

export function exportSummary(voucher: WsfexVoucherInfo): ExportVoucherSummary {
  const summary: ExportVoucherSummary = { number: voucher.number };
  assign(summary, "salesPoint", voucher.salesPoint);
  assign(summary, "voucherType", voucher.voucherType);
  assign(summary, "requestId", voucher.id);
  assign(summary, "date", isoDate(voucher.voucherDate));
  assign(summary, "exportType", voucher.exportType);
  assign(summary, "destination", voucher.destination);
  assign(summary, "receiverName", voucher.receiverName);
  assign(summary, "receiverAddress", voucher.receiverAddress);
  assign(summary, "receiverTaxId", voucher.receiverTaxId);
  assign(summary, "receiverCountryTaxId", voucher.receiverCountryTaxId);
  assign(summary, "currencyId", voucher.currencyId);
  assign(summary, "exchangeRate", voucher.exchangeRate);
  assign(
    summary,
    "totalAmount",
    voucher.totalAmount === undefined
      ? undefined
      : Math.round(voucher.totalAmount * 100)
  );
  assign(summary, "result", voucher.result);
  assign(summary, "cae", voucher.cae);
  assign(summary, "caeExpiry", isoDate(voucher.caeExpiry));
  return summary;
}

function exportQr(
  taxId: string,
  attempted: VoucherCoordinates,
  data: WsfexVoucherInput,
  date: string,
  cae: string
): Pick<ExportIssuedVoucher, "qr" | "qrPayload"> {
  try {
    const qrPayload = arcaQrPayload({
      taxId,
      ...attempted,
      date,
      total: Math.round(data.totalAmount * 100),
      currency: data.currencyId,
      ...(data.exchangeRate === undefined
        ? {}
        : { exchangeRate: data.exchangeRate }),
      cae,
    });
    return { qr: qrUrlForPayload(qrPayload), qrPayload };
  } catch {
    return {};
  }
}

function originalTotal(original: WsfexVoucherInfo): number {
  return Math.round(original.totalAmount * 100);
}

function deriveReceiver(to: unknown) {
  assertIssueObject(to, "to");
  assertIssueKeys(
    to,
    ["country", "name", "address", "taxId", "countryTaxId"],
    "to"
  );
  const receiver = to as ExportReceiver;
  if (
    !(
      Number.isSafeInteger(receiver.country) &&
      receiver.country >= 1 &&
      receiver.country <= 999
    )
  ) {
    invalid("to.country", "an ARCA destination country code");
  }
  if (receiver.taxId === undefined && receiver.countryTaxId === undefined) {
    throw new ArcaInputError("to.taxId or to.countryTaxId is required.", {
      code: "ARCA_INPUT_MISSING_FIELD",
      field: "to.taxId",
      expected: "the receiver's tax ID abroad, ARCA's country CUIT, or both",
    });
  }
  if (
    receiver.countryTaxId !== undefined &&
    !(
      typeof receiver.countryTaxId === "string" &&
      /^\d{11}$/.test(receiver.countryTaxId)
    )
  ) {
    invalid("to.countryTaxId", "an 11-digit string");
  }
  return {
    destination: receiver.country,
    receiverName: text(receiver.name, "to.name", 200),
    ...(receiver.countryTaxId === undefined
      ? {}
      : { receiverCountryTaxId: receiver.countryTaxId }),
    receiverAddress: text(receiver.address, "to.address", 300),
    ...optionalText(receiver.taxId, "receiverTaxId", 50, "to.taxId"),
  };
}

function deriveExport(value: unknown): {
  exportType: WsfexExportType;
  permitExists?: "S" | "N";
  permits?: { id: string; destination: number }[];
  incoterms?: string;
  incotermsDetail?: string;
  paymentDate?: string;
} {
  assertIssueObject(value, "export");
  const exported = value as ExportOfGoods | ExportOfServices;
  if (exported.kind === "goods") {
    assertIssueKeys(
      exported,
      ["kind", "incoterms", "incotermsDetail", "permits"],
      "export"
    );
    if (
      typeof exported.incoterms !== "string" ||
      !/^[A-Z]{3}$/.test(exported.incoterms)
    ) {
      invalid("export.incoterms", "a three-letter Incoterm such as FOB");
    }
    let permits: { id: string; destination: number }[] | undefined;
    if (exported.permits !== undefined) {
      if (!Array.isArray(exported.permits) || exported.permits.length === 0) {
        invalid("export.permits", "a non-empty list, or absent while pending");
      }
      const seen = new Set<string>();
      permits = exported.permits.map((entry, index) => {
        const field = `export.permits[${index}]`;
        const permit = entry as { id: unknown; destination: unknown };
        assertIssueObject(permit, field);
        assertIssueKeys(permit, ["id", "destination"], field);
        if (
          typeof permit.id !== "string" ||
          !/^\d{5}[A-Z0-9]{4}\d{6}[A-Z]$/.test(permit.id)
        ) {
          invalid(`${field}.id`, "a shipping permit such as 09052EC01006154G");
        }
        if (
          !(
            typeof permit.destination === "number" &&
            Number.isSafeInteger(permit.destination) &&
            permit.destination >= 1 &&
            permit.destination <= 999
          )
        ) {
          invalid(`${field}.destination`, "an ARCA destination country code");
        }
        const pair = `${permit.id}:${permit.destination}`;
        if (seen.has(pair)) {
          invalid(field, "a permit and destination listed once");
        }
        seen.add(pair);
        return {
          id: permit.id as string,
          destination: permit.destination as number,
        };
      });
    }
    return {
      exportType: 1,
      permitExists: permits === undefined ? "N" : "S",
      ...(permits === undefined ? {} : { permits }),
      incoterms: exported.incoterms,
      ...optionalText(
        exported.incotermsDetail,
        "incotermsDetail",
        20,
        "export.incotermsDetail"
      ),
    };
  }
  if (exported.kind === "services" || exported.kind === "other") {
    assertIssueKeys(exported, ["kind", "paymentDate"], "export");
    if (exported.paymentDate === undefined) {
      throw new ArcaInputError("export.paymentDate is required.", {
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "export.paymentDate",
        expected: "the date the receiver pays",
      });
    }
    return {
      exportType: EXPORT_KINDS[exported.kind],
      paymentDate: normalizeWsfeDateInput(
        exported.paymentDate,
        "export.paymentDate"
      ) as string,
    };
  }
  return invalid("export.kind", "goods, services or other");
}

function deriveCurrency(
  currency: ExportIssueInput["currency"],
  rate: unknown
): { currencyId: string; exchangeRate: string } {
  const value = currency ?? "ARS";
  let currencyId: string;
  if (typeof value === "object" && value !== null) {
    assertIssueKeys(value, ["id"], "currency");
    if (typeof value.id !== "string" || !/^[A-Z0-9]{3}$/.test(value.id)) {
      invalid("currency.id", "a three-character ARCA currency code");
    }
    currencyId = value.id;
  } else if (value === "ARS" || value === "USD") {
    currencyId = ARCA_CURRENCY_IDS[value];
  } else {
    return invalid("currency", "ARS, USD or { id }");
  }
  if (rate !== undefined && typeof rate !== "string") {
    invalid("exchangeRate", "a decimal string");
  }
  if (currencyId === ARCA_CURRENCY_IDS.ARS) {
    const exchangeRate = serializeArcaExchangeRate(rate ?? "1", "exchangeRate");
    if (Number(exchangeRate) !== 1) {
      invalid("exchangeRate", "1 for pesos");
    }
    return { currencyId, exchangeRate };
  }
  if (rate === undefined) {
    throw new ArcaInputError("exchangeRate is required for this currency.", {
      code: "ARCA_INPUT_MISSING_FIELD",
      field: "exchangeRate",
      expected: "ARCA's rate, from wsfex.getExchangeRate()",
    });
  }
  return {
    currencyId,
    exchangeRate: serializeArcaExchangeRate(rate, "exchangeRate"),
  };
}

function deriveLanguage(language: unknown): WsfexLanguage {
  if (language === undefined) {
    return 1;
  }
  if (typeof language !== "string" || !Object.hasOwn(LANGUAGES, language)) {
    return invalid("language", "es, en or pt");
  }
  return LANGUAGES[language as keyof typeof LANGUAGES];
}

const SCALE_6 = 1_000_000n;

function deriveItems(
  value: unknown,
  path: string
): { items: WsfexItem[]; total: number } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9999) {
    invalid(path, "a list of 1 to 9999 items");
  }
  let total = 0n;
  const items = (value as readonly ExportItem[]).map((item, index) => {
    const line = deriveItem(item, `${path}[${index}]`);
    total += BigInt(item.amount);
    return line;
  });
  if (total < 0n) {
    invalid(path, "lines whose total is zero or positive");
  }
  return { items, total: Number(total) };
}

function deriveItem(item: ExportItem, field: string): WsfexItem {
  assertIssueObject(item, field);
  assertIssueKeys(
    item,
    [
      "description",
      "unit",
      "quantity",
      "unitPrice",
      "discount",
      "code",
      "amount",
    ],
    field
  );
  if (!(Number.isSafeInteger(item.unit) && item.unit >= 0 && item.unit <= 99)) {
    invalid(`${field}.unit`, "an ARCA unit of measure");
  }
  assertItemAmount(item, field);
  const line: WsfexItem = {
    ...optionalText(item.code, "code", 50, `${field}.code`),
    description: text(item.description, `${field}.description`, 4000),
    unit: item.unit,
    amount: item.amount / 100,
  };
  if (!UNPRICED_UNITS.includes(item.unit)) {
    return { ...line, ...pricedLine(item, field) };
  }
  // Rule 1775: these units carry no quantity, price or discount.
  for (const key of ["quantity", "unitPrice", "discount"] as const) {
    if (item[key] !== undefined && Number(item[key]) !== 0) {
      invalid(`${field}.${key}`, `absent for unit ${item.unit}`);
    }
  }
  return line;
}

/** Rule 1810: unit 99 discounts, 97 advances of either sign, the rest not negative. */
function assertItemAmount(item: ExportItem, field: string) {
  if (!Number.isSafeInteger(item.amount)) {
    invalid(`${field}.amount`, "an integer amount in minor units");
  }
  if (item.unit === 99 && item.amount >= 0) {
    invalid(`${field}.amount`, "negative for a discount line");
  }
  if (item.unit !== 97 && item.unit !== 99 && item.amount < 0) {
    invalid(`${field}.amount`, "zero or positive for this unit");
  }
  if (Math.abs(item.amount) > 999_999_999_999_999) {
    invalid(`${field}.amount`, "at most 13 integer digits");
  }
}

/** Rule 1815: the line equals quantity × unitPrice less its discount. */
function pricedLine(
  item: ExportItem,
  field: string
): Pick<WsfexItem, "quantity" | "unitPrice" | "discount"> {
  const quantity = scaledQuantity(item.quantity, `${field}.quantity`);
  const price = scaledPrice(item.unitPrice, `${field}.unitPrice`);
  const discount = item.discount ?? 0;
  if (!(Number.isSafeInteger(discount) && discount >= 0)) {
    invalid(`${field}.discount`, "a non-negative amount in minor units");
  }
  // quantity × price is scaled 10^12; minor units are 10^2.
  const gross = roundHalfEvenRatio(quantity * price, 10_000_000_000n);
  if (BigInt(discount) > gross) {
    invalid(`${field}.discount`, "at most the line's quantity × unitPrice");
  }
  const expected = gross - BigInt(discount);
  if (!isWithinArcaTolerance(BigInt(item.amount), expected)) {
    throw new ArcaInputError(
      `${field}.amount must equal quantity × unitPrice less discount.`,
      {
        code: "ARCA_INPUT_AMOUNT_MISMATCH",
        field: `${field}.amount`,
        expected: String(expected),
      }
    );
  }
  return {
    quantity: item.quantity as number,
    unitPrice: item.unitPrice as string,
    ...(discount > 0 ? { discount: discount / 100 } : {}),
  };
}

function scaledQuantity(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return invalid(field, "a positive number");
  }
  const fixed = value.toFixed(6);
  if (Number(fixed) !== value || fixed.split(".")[0].length > 12) {
    invalid(field, "at most 12 integer digits and 6 decimals");
  }
  const [whole, fraction = ""] = fixed.split(".");
  return BigInt(whole) * SCALE_6 + BigInt(fraction.padEnd(6, "0"));
}

function scaledPrice(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d{1,12}(\.\d{1,6})?$/.test(value)) {
    return invalid(field, "a decimal string with at most 6 decimals");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE_6 + BigInt(fraction.padEnd(6, "0"));
}

function reviewedTotal(total: unknown, computed: number): number {
  if (total === undefined) {
    return computed;
  }
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    invalid("total", "a non-negative integer amount in minor units");
  }
  if (total !== computed) {
    throw new ArcaInputError("total must equal the sum of items.", {
      code: "ARCA_INPUT_AMOUNT_MISMATCH",
      field: "total",
      expected: String(computed),
    });
  }
  return computed;
}

function assertSalesPoint(value: unknown, field: string) {
  if (
    !(
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 99_998
    )
  ) {
    invalid(field, "an integer from 1 through 99998");
  }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ArcaInputError(`${field} is required.`, {
      code: "ARCA_INPUT_MISSING_FIELD",
      field,
      expected: `a non-empty string of at most ${max} characters`,
    });
  }
  if (value.length > max) {
    invalid(field, `at most ${max} characters`);
  }
  return value;
}

function optionalText<K extends string>(
  value: unknown,
  key: K,
  max: number,
  field: string = key
): { [P in K]?: string } {
  if (value === undefined) {
    return {};
  }
  return { [key]: text(value, field, max) } as { [P in K]?: string };
}

function isoDate(value: string | undefined): string | undefined {
  return value === undefined ? undefined : (toIsoDate(value) ?? value);
}

function assign<T, K extends keyof T>(target: T, key: K, value: T[K]) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function invalid(field: string, expected: string): never {
  throw new ArcaInputError(`${field} must be ${expected}.`, {
    code: "ARCA_INPUT_INVALID_VALUE",
    field,
    expected,
  });
}
