import {
  ArcaConfigurationError,
  ArcaInputError,
  ArcaServiceError,
  toArcaSafeErrorMetadata,
} from "../errors";
import { normalizeArcaAmountToMinorUnits } from "../internal/decimal";
import type { ArcaEnvironment } from "../internal/types";
import {
  type ArcaAttemptRecord,
  type ArcaSettledRecord,
  type ArcaStore,
  attemptKey,
  canonicalHash,
  settledKey,
  storeCall,
} from "../store/types";
import type { ArcaAuthorizationOutcome } from "./fiscal-evidence";
import { validateFiscalHeader, voucherFamily } from "./issuance-fields";
import {
  createWsmtxcaIssuanceService,
  type FiscalHeader,
  matchWsmtxcaDetails,
  wsmtxcaRequest,
} from "./issuance-wsmtxca";
import type {
  ExactIssueInput,
  IssuanceService,
  IssuedVoucher,
  IssueOptions,
  IssueOutcome,
  IssuePreview,
  ServiceFor,
} from "./vouchers-types";
import {
  normalizeWsfeDateInput,
  normalizeWsfeVoucherInput,
  type WsfeService,
  type WsfeVoucherInput,
} from "./wsfe";
import {
  assertCreditNoteInput,
  type CreditNoteInput,
  deriveWsfeFullCreditNote,
  deriveWsfePartialCreditNote,
} from "./wsfe-credit-note";
import {
  assertIssueKeys,
  assertIssueObject,
  deriveWsfeInvoice,
  type IssueInput,
  issueDocumentNumber,
} from "./wsfe-derive";
import {
  matchWsfeVoucherIdentity,
  toVoucherSummary,
  type VoucherCoordinates,
  type VoucherSummary,
} from "./wsfe-identity";
import type { WsmtxcaService } from "./wsmtxca";

export type PeriodNoteInput = IssueInput & {
  associatedPeriod: {
    from: import("./wsfe").WsfeDateInput;
    to: import("./wsfe").WsfeDateInput;
  };
  for?: never;
};
export type DebitNoteInput =
  | (CreditNoteInput & { all?: never })
  | PeriodNoteInput;
export type RecoveryOptions = Pick<
  IssueOptions,
  "representedTaxId" | "forceRefresh" | "include"
>;
export type VouchersService = {
  /** Consults a durable reservation. Never allocates or authorizes a voucher. */
  recover<O extends RecoveryOptions = { include?: never }>(
    idempotencyKey: string,
    options?: O
  ): Promise<IssueOutcome<O & { service?: IssuanceService }>>;
  /**
   * Issues a debit note against the same originals `issueCreditNote()` accepts,
   * or against a period with `associatedPeriod`. It has no `all: true` mode:
   * a debit note adds to the account, so its lines are always explicit.
   */
  issueDebitNote<O extends IssueOptions = { include?: never }>(
    input: DebitNoteInput,
    options?: O
  ): Promise<IssueOutcome<O>>;
  /**
   * Derives what issueCreditNote() would send. Unlike the zero-I/O preview(),
   * it consults the original once: one read, no write and no number reserved.
   * A period note carries its own business input and needs no lookup.
   */
  previewCreditNote<O extends PreviewOptions = { service?: never }>(
    input: CreditNoteInput | PeriodNoteInput,
    options?: O
  ): Promise<IssuePreview<ServiceFor<O>>>;
  /** Same contract as previewCreditNote(), for issueDebitNote() input. */
  previewDebitNote<O extends PreviewOptions = { service?: never }>(
    input: DebitNoteInput,
    options?: O
  ): Promise<IssuePreview<ServiceFor<O>>>;
  /**
   * Issues a credit note against an authorized invoice or debit note of the
   * ordinary, retention-legend or FCE families, or against a period with
   * `associatedPeriod`. The note credits the chosen `items` or reviewed
   * `amounts`, or the whole original with `all: true`.
   *
   * For a linked note everything except the credited lines, the note's sales
   * point and its date comes from the original: class, receiver, currency,
   * concept and service dates. ARCA has no cancellation; every mode writes a
   * real fiscal document.
   */
  issueCreditNote<O extends IssueOptions = { include?: never }>(
    input: CreditNoteInput | PeriodNoteInput,
    options?: O
  ): Promise<IssueOutcome<O>>;
  /**
   * Configure a store and pass idempotencyKey to recover retries after a crash.
   *
   * Without a key: one next-number read, one authorization and at most one lookup.
   * Keyed replay consults the reserved number; only not_found permits a write.
   * Local validation and next-number read failures throw before authorization.
   */
  issue<O extends IssueOptions = { include?: never }>(
    input: IssueInput,
    options?: O
  ): Promise<IssueOutcome<O>>;
  /**
   * Derives what issue() would send for the same input, with no I/O at all:
   * no store, no WSAA, no SOAP and no next-number read.
   *
   * It throws every input error issue() throws before its first call, so a
   * caller that previews and then issues sees no new local error.
   */
  preview<
    O extends Pick<PreviewOptions, "representedTaxId" | "service"> = {
      service?: never;
    },
  >(input: IssueInput, options?: O): IssuePreview<ServiceFor<O>>;
};

export type PreviewOptions = {
  representedTaxId?: number | string;
  service?: "wsfe" | "wsmtxca";
  forceRefresh?: boolean;
};

type IssueWsfeService = {
  getNextVoucherNumber: WsfeService["getNextVoucherNumber"];
  issue: (
    input: Parameters<WsfeService["issue"]>[0]
  ) => Promise<ArcaAuthorizationOutcome>;
  lookupVoucher: (
    input: Parameters<WsfeService["lookupVoucher"]>[0]
  ) => Promise<
    import("./fiscal-evidence").ArcaVoucherLookupResult<
      import("./wsfe").WsfeVoucherInfo
    >
  >;
};
type StoreContext = {
  store?: ArcaStore;
  environment: ArcaEnvironment;
  taxId: string;
};
type Prepared = Omit<ReturnType<typeof deriveWsfeInvoice>, "data"> & {
  data: FiscalHeader;
};

export function createVouchersService(
  wsfe: IssueWsfeService,
  context?: StoreContext,
  wsmtxca?: WsmtxcaService
): VouchersService {
  const select = (options: IssueOptions = {}): IssueWsfeService => {
    validateOptions(options);
    if (options.service !== "wsmtxca") {
      return wsfe;
    }
    if (!wsmtxca) {
      throw new ArcaConfigurationError("WSMTXCA service is not configured");
    }
    return createWsmtxcaIssuanceService(wsmtxca);
  };
  return {
    recover: async (key, options) =>
      recoverOperation(
        select,
        key,
        options === undefined ? {} : options,
        context
      ) as Promise<IssueOutcome<typeof options & IssueOptions>>,
    issueDebitNote: async (input, options) =>
      issueCreditNote(
        select(options),
        input,
        options ?? {},
        context,
        "debitNote"
      ) as Promise<IssueOutcome<typeof options & IssueOptions>>,
    previewCreditNote: async <O extends PreviewOptions = { service?: never }>(
      input: CreditNoteInput | PeriodNoteInput,
      options?: O
    ) =>
      previewNote(
        select(options),
        input,
        options ?? {},
        context,
        "creditNote"
      ) as Promise<IssuePreview<ServiceFor<O>>>,
    previewDebitNote: async <O extends PreviewOptions = { service?: never }>(
      input: DebitNoteInput,
      options?: O
    ) =>
      previewNote(
        select(options),
        input,
        options ?? {},
        context,
        "debitNote"
      ) as Promise<IssuePreview<ServiceFor<O>>>,
    issueCreditNote: async <O extends IssueOptions = { include?: never }>(
      input: CreditNoteInput | PeriodNoteInput,
      options?: O
    ): Promise<IssueOutcome<O>> => {
      const result = await issueCreditNote(
        select(options),
        input,
        options === undefined ? {} : options,
        context
      );
      return result as IssueOutcome<O>;
    },
    issue: async <O extends IssueOptions = { include?: never }>(
      input: IssueInput,
      options?: O
    ): Promise<IssueOutcome<O>> => {
      const result = await issueInvoice(
        select(options),
        input,
        options === undefined ? {} : options,
        context
      );
      // issueInvoice conditionally adds the fields specified by O at runtime.
      return result as IssueOutcome<O>;
    },
    preview: <
      O extends Pick<PreviewOptions, "representedTaxId" | "service"> = {
        service?: never;
      },
    >(
      input: IssueInput,
      options?: O
    ) =>
      previewInvoice(
        input,
        options === undefined ? {} : options
      ) as IssuePreview<ServiceFor<O>>,
  };
}

/** Pure: the caller inspects the request and amounts before committing. */
function previewInvoice(
  input: IssueInput,
  options: PreviewOptions
): IssuePreview<IssuanceService> {
  assertIssueObject(options, "options");
  assertIssueKeys(options, ["representedTaxId", "service"], "options");
  validateOptions(options);
  if (options.representedTaxId !== undefined) {
    issueDocumentNumber(
      options.representedTaxId,
      "options.representedTaxId",
      11,
      11
    );
  }
  return toPreview(prepareInvoice(input, options), options);
}
function prepareInvoice(input: IssueInput, options: IssueOptions): Prepared {
  const prepared: Prepared = deriveWsfeInvoice(input);
  if (input.details !== undefined) {
    prepared.data.details = structuredClone(input.details);
  }
  validatePrepared(prepared, options);
  return prepared;
}
function validatePrepared(prepared: Prepared, options: IssueOptions): void {
  validateFiscalHeader(prepared.data);
  if (options.service === "wsmtxca") {
    wsmtxcaRequest(prepared.data);
  } else if (prepared.data.details !== undefined) {
    throw new ArcaInputError("Detailed items require service: wsmtxca", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "details",
    });
  }
}
function toPreview(
  prepared: Prepared,
  options: IssueOptions
): IssuePreview<IssuanceService> {
  const { data, voucherClass, amounts } = prepared;
  return {
    voucherClass,
    voucherType: data.voucherType,
    amounts,
    request: options.service === "wsmtxca" ? wsmtxcaRequest(data) : data,
    ...(options.service === "wsmtxca" ? { service: "wsmtxca" as const } : {}),
  };
}

async function issueInvoice(
  wsfe: IssueWsfeService,
  input: IssueInput,
  inputOptions: IssueOptions,
  context?: StoreContext
): Promise<IssueOutcome<IssueOptions>> {
  const options = structuredClone(inputOptions);
  validateOptions(options);
  validateKeyStore(options, context);
  const prepared = prepareInvoice(input, options);
  return await runOperation(
    wsfe,
    "issue",
    input,
    () => Promise.resolve(prepared),
    options,
    context,
    prepared.amounts
  );
}

async function runOperation(
  wsfe: IssueWsfeService,
  operation: ArcaAttemptRecord["operation"],
  input: unknown,
  prepare: () => Promise<Prepared>,
  options: IssueOptions,
  context?: StoreContext,
  replayAmounts?: Prepared["amounts"]
): Promise<IssueOutcome<IssueOptions>> {
  if (options.idempotencyKey === undefined || !context?.store) {
    return runAuthorization(wsfe, await prepare(), options);
  }
  const store: ArcaStore = context.store;
  const key = attemptKey(
    context.environment,
    context.taxId,
    options.idempotencyKey
  );
  const representedTaxId =
    options.representedTaxId === undefined
      ? undefined
      : String(options.representedTaxId);
  const inputHash = canonicalHash({
    input,
    representedTaxId,
    ...(options.service === "wsmtxca" ? { service: "wsmtxca" } : {}),
    ...(options.number === undefined ? {} : { number: options.number }),
  });
  const settled = settledKey(
    context.environment,
    context.taxId,
    options.idempotencyKey
  );
  const existing = await storeCall(() => store.get(key));
  if (existing !== null) {
    return await replay(existing);
  }
  const prepared = await prepare();
  const number = await nextNumber(wsfe, prepared.data, options);
  // A WSMTXCA or detailed reservation is a v2 record: 0.10 accepts any v1 record
  // and would replay it through WSFE, so it must not be able to read this one.
  const service = options.service ?? "wsfe";
  const versioned =
    service === "wsmtxca" || prepared.data.details !== undefined;
  const record: ArcaAttemptRecord = {
    v: versioned ? 2 : 1,
    operation,
    ...(versioned ? { service } : {}),
    representedTaxId,
    inputHash,
    number,
    salesPoint: prepared.data.salesPoint,
    voucherType: prepared.data.voucherType,
    sent: prepared.data,
    createdAt: new Date().toISOString(),
  };
  if (await storeCall(() => store.add(key, JSON.stringify(record)))) {
    return await settle(runAuthorization(wsfe, prepared, options, number));
  }
  const winner = await storeCall(() => store.get(key));
  if (winner === null) {
    throw new ArcaConfigurationError(
      "ARCA reservation disappeared after atomic creation lost."
    );
  }
  return await replay(winner);

  async function replay(json: string) {
    const stored = readRecord(json);
    if (
      (stored.service ?? "wsfe") !== (options.service ?? "wsfe") ||
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
    const recorded = await storeCall(() => store.get(settled));
    if (recorded !== null) {
      return settledConflict(readSettledRecord(recorded), stored);
    }
    return await settle(
      runAuthorization(
        wsfe,
        {
          ...preparedFromRecord(stored),
          ...(replayAmounts ? { amounts: replayAmounts } : {}),
        },
        options,
        stored.number,
        true
      )
    );
  }
  /** Every conflict becomes durable before it reaches the caller. */
  async function settle(running: Promise<IssueOutcome<IssueOptions>>) {
    return await recordConflict(store, settled, await running);
  }
}

/**
 * Records a conflict once, so a retry answers from the store instead of
 * consulting a number a stranger already holds. Losing the atomic creation
 * means another call recorded the same conflict first.
 */
async function recordConflict(
  store: ArcaStore,
  key: string,
  outcome: IssueOutcome<IssueOptions>
): Promise<IssueOutcome<IssueOptions>> {
  if (outcome.kind !== "conflict") {
    return outcome;
  }
  const record: ArcaSettledRecord = {
    v: 1,
    kind: "conflict",
    number: outcome.attempted.number,
    found: Object.fromEntries(
      Object.entries(outcome.found).filter(([field]) => field !== "raw")
    ) as VoucherSummary,
    settledAt: new Date().toISOString(),
  };
  await storeCall(() => store.add(key, JSON.stringify(record)));
  return outcome;
}

function readSettledRecord(json: string): ArcaSettledRecord {
  try {
    const record = JSON.parse(json) as ArcaSettledRecord;
    if (
      !record ||
      record.v !== 1 ||
      record.kind !== "conflict" ||
      !record.found ||
      typeof record.found !== "object" ||
      !Number.isSafeInteger(record.number)
    ) {
      throw new Error("Invalid settled structure");
    }
    return record;
  } catch (cause) {
    throw new ArcaConfigurationError(
      "Invalid ARCA settled record; preserve it for reconciliation.",
      { cause }
    );
  }
}

function settledConflict(
  settled: ArcaSettledRecord,
  reservation: ArcaAttemptRecord
): IssueOutcome<IssueOptions> {
  return {
    kind: "conflict",
    attempted: {
      salesPoint: reservation.salesPoint,
      voucherType: reservation.voucherType,
      number: settled.number,
    },
    attempt: replayEvidence(reservation.service),
    found: settled.found,
    reason:
      "This key already recorded another voucher at the reserved number. Reconcile before issuing under a new key.",
  };
}

function validateKeyStore(options: IssueOptions, context?: StoreContext) {
  if (options.idempotencyKey === undefined) {
    return;
  }
  if (
    typeof options.idempotencyKey !== "string" ||
    options.idempotencyKey.length < 1 ||
    options.idempotencyKey.length > 255
  ) {
    throw new ArcaInputError(
      "idempotencyKey must contain 1 to 255 characters.",
      { code: "ARCA_INPUT_INVALID_VALUE", field: "options.idempotencyKey" }
    );
  }
  if (!context?.store) {
    throw new ArcaConfigurationError(
      'idempotencyKey requires a store. Add import { createPostgresStore } from "facturas"; and store: createPostgresStore({ query }) to createArcaClient().'
    );
  }
}

function readRecord(json: string): ArcaAttemptRecord {
  try {
    const record = JSON.parse(json) as ArcaAttemptRecord;
    if (
      !record ||
      (record.v !== 1 && record.v !== 2) ||
      (record.v === 2 && record.service === undefined) ||
      !["issue", "creditNote", "debitNote"].includes(record.operation) ||
      typeof record.inputHash !== "string" ||
      !record.sent ||
      !Number.isSafeInteger(record.number) ||
      record.number < 1 ||
      record.number > 99_999_999 ||
      record.sent.salesPoint !== record.salesPoint ||
      record.sent.voucherType !== record.voucherType
    ) {
      throw new Error("Invalid reservation structure");
    }
    normalizeWsfeVoucherInput(record.sent);
    if (
      record.service !== undefined &&
      record.service !== "wsfe" &&
      record.service !== "wsmtxca"
    ) {
      throw new Error("Invalid provider");
    }
    if (record.service === "wsmtxca") {
      wsmtxcaRequest(record.sent, record.number);
    }
    return record;
  } catch (cause) {
    throw new ArcaConfigurationError(
      "Invalid ARCA reservation record; preserve it for reconciliation.",
      { cause }
    );
  }
}

function preparedFromRecord(record: ArcaAttemptRecord): Prepared {
  const sentTotal = Number(
    normalizeArcaAmountToMinorUnits(record.sent.totalAmount, "totalAmount")
  );
  return {
    data: record.sent,
    voucherClass: voucherFamily(record.voucherType).voucherClass,
    amounts: { computedTotal: sentTotal, sentTotal, vatAdjustment: 0 },
  };
}

async function nextNumber(
  wsfe: IssueWsfeService,
  data: WsfeVoucherInput,
  options: IssueOptions
): Promise<number> {
  if (options.number !== undefined) {
    return options.number;
  }
  const number = await wsfe.getNextVoucherNumber({
    representedTaxId: options.representedTaxId,
    forceRefresh: options.forceRefresh,
    salesPoint: data.salesPoint,
    voucherType: data.voucherType,
  });
  if (!Number.isSafeInteger(number) || number < 1 || number > 99_999_999) {
    throw new ArcaServiceError(
      "ARCA returned an invalid next voucher number.",
      {
        service: options.service ?? "wsfe",
        operation:
          options.service === "wsmtxca"
            ? "consultarUltimoComprobanteAutorizado"
            : "FECompUltimoAutorizado",
      }
    );
  }
  return number;
}

async function runAuthorization(
  wsfe: IssueWsfeService,
  { data, voucherClass, amounts }: Prepared,
  options: IssueOptions,
  reservedNumber?: number,
  replay = false
): Promise<IssueOutcome<IssueOptions>> {
  const auth = {
    representedTaxId: options.representedTaxId,
    forceRefresh: options.forceRefresh,
  };
  const includeRaw = options.include?.raw === true;
  const includeExact = options.include?.exactInput === true;
  const number = reservedNumber ?? (await nextNumber(wsfe, data, options));
  const attempted = {
    salesPoint: data.salesPoint,
    voucherType: data.voucherType,
    number,
  };
  const exact = exactEvidence(data, number, options, includeExact);
  const voucher = (cae: string, caeExpiry: string): IssuedVoucher => ({
    ...attempted,
    voucherClass,
    date: data.voucherDate,
    cae,
    caeExpiry,
    amounts,
  });
  const recovery = {
    wsfe,
    auth,
    data,
    attempted,
    includeRaw,
    exact,
    voucher,
    service: options.service,
  };
  if (replay) {
    const attempt = replayEvidence(options.service);
    let lookup: Awaited<ReturnType<IssueWsfeService["lookupVoucher"]>>;
    try {
      lookup = await wsfe.lookupVoucher({ ...auth, ...attempted });
    } catch (error) {
      return {
        kind: "indeterminate",
        attempted,
        attempt,
        lookup: { kind: "failed", error: toArcaSafeErrorMetadata(error) },
      };
    }
    if (lookup.kind === "found") {
      return recoverInvoice({ ...recovery, attempt, lookup });
    }
  }
  // This is the only authorization call, including all transport/recovery branches.
  const authorization = await wsfe.issue({
    ...auth,
    data,
    voucherNumber: number,
  });
  if (
    authorization.kind === "authorized" &&
    authorization.caeExpiry &&
    authorization.voucherNumber === number
  ) {
    return {
      kind: "authorized",
      recoveredByMatch: false,
      voucher: voucher(authorization.cae, authorization.caeExpiry),
      authorization: projectEvidence(authorization, includeRaw),
      ...exact,
    };
  }
  if (authorization.kind === "rejected") {
    if (
      options.idempotencyKey !== undefined &&
      (options.service === "wsmtxca" ||
        [...authorization.errors, ...authorization.observations].some(
          (issue) => issue.code === "10016"
        ))
    ) {
      const recovered = await recoverInvoice({
        ...recovery,
        attempt: projectEvidence(
          {
            ...authorization,
            kind: "indeterminate",
            reason: "contradictory_response",
          },
          includeRaw
        ),
        // A number this call reserved and ARCA refused can only hold somebody
        // else's voucher, and identical fiscal data is not authorship. Only a
        // pre-existing reservation may recover its own lost write by identity.
        strangerAtNumber: !replay,
      });
      // A stranger at the reserved number is a conflict; a failed or empty
      // lookup keeps the provider rejection as the answer.
      if (recovered.kind === "authorized" || recovered.kind === "conflict") {
        return recovered;
      }
    }
    return {
      kind: "rejected",
      attempted,
      issues: [...authorization.errors, ...authorization.observations].map(
        projectIssue
      ),
      authorization: projectEvidence(authorization, includeRaw),
    };
  }
  // The exact outcome type permits an absent expiry. Keep that uncertainty visible.
  const uncertain =
    authorization.kind === "indeterminate"
      ? authorization
      : {
          ...authorization,
          kind: "indeterminate" as const,
          reason:
            authorization.voucherNumber === number
              ? ("incomplete_response" as const)
              : ("contradictory_response" as const),
        };
  const attempt = projectEvidence(uncertain, includeRaw);
  return recoverInvoice({
    wsfe,
    service: options.service,
    auth,
    data,
    attempted,
    attempt,
    includeRaw,
    exact,
    voucher,
  });
}

type RecoveryInput = {
  wsfe: IssueWsfeService;
  lookup?: Awaited<ReturnType<IssueWsfeService["lookupVoucher"]>>;
  auth: Pick<IssueOptions, "representedTaxId" | "forceRefresh">;
  data: FiscalHeader;
  service?: "wsfe" | "wsmtxca";
  attempted: VoucherCoordinates;
  attempt: Omit<
    Extract<ArcaAuthorizationOutcome, { kind: "indeterminate" }>,
    "raw"
  > & { raw?: Record<string, unknown> };
  includeRaw: boolean;
  exact: { sent?: ExactIssueInput<IssuanceService> };
  voucher: (cae: string, caeExpiry: string) => IssuedVoucher;
  /** The reserved number was claimed in this call: any voucher on it is foreign. */
  strangerAtNumber?: boolean;
};
async function recoverInvoice({
  wsfe,
  auth,
  data,
  attempted,
  attempt,
  includeRaw,
  exact,
  voucher,
  lookup: suppliedLookup,
  service,
  strangerAtNumber = false,
}: RecoveryInput): Promise<IssueOutcome<IssueOptions>> {
  let lookup: Awaited<ReturnType<IssueWsfeService["lookupVoucher"]>>;
  try {
    lookup =
      suppliedLookup ?? (await wsfe.lookupVoucher({ ...auth, ...attempted }));
  } catch (error) {
    return {
      kind: "indeterminate",
      attempted,
      attempt,
      lookup: { kind: "failed", error: toArcaSafeErrorMetadata(error) },
    };
  }
  const raw = includeRaw ? { raw: lookup.raw } : {};
  if (lookup.kind === "not_found") {
    return {
      kind: "indeterminate",
      attempted,
      attempt,
      lookup: { kind: "not_found", ...raw },
    };
  }
  if (strangerAtNumber) {
    return {
      kind: "conflict",
      attempted,
      attempt,
      found: { ...toVoucherSummary(lookup.voucher), ...raw },
      reason:
        "ARCA refused the number this call reserved and another voucher occupies it",
    };
  }
  const detailsMatch =
    service === "wsmtxca"
      ? matchWsmtxcaDetails(data, attempted.number, lookup.voucher.raw)
      : undefined;
  const matched =
    detailsMatch === undefined
      ? matchWsfeVoucherIdentity(data, attempted.number, lookup.voucher)
      : detailsMatch === "match" &&
          lookup.voucher.cae &&
          lookup.voucher.caeExpiry
        ? { matches: true as const }
        : {
            matches: false as const,
            evidence:
              detailsMatch === "conflict"
                ? ("conflict" as const)
                : ("incomplete" as const),
            reason:
              "WSMTXCA consultation does not match the complete reserved request",
          };
  if (!matched.matches) {
    if (matched.evidence === "conflict") {
      return {
        kind: "conflict",
        attempted,
        attempt,
        found: { ...toVoucherSummary(lookup.voucher), ...raw },
        reason: `${matched.reason}. Configure a store and pass idempotencyKey for retries.`,
      };
    }
    return {
      kind: "indeterminate",
      attempted,
      attempt,
      lookup: { kind: "incomplete", reason: matched.reason, ...raw },
    };
  }
  // The matcher requires both fields before declaring a complete match.
  return {
    kind: "authorized",
    recoveredByMatch: true,
    voucher: voucher(
      lookup.voucher.cae as string,
      lookup.voucher.caeExpiry as string
    ),
    attempt,
    lookup: { ...toVoucherSummary(lookup.voucher), ...raw },
    ...exact,
  };
}

function projectIssue(issue: ArcaAuthorizationOutcome["errors"][number]) {
  return {
    service: issue.service,
    operation: issue.operation,
    source: issue.source,
    category: issue.category,
    message: issue.message,
    ...(issue.code === undefined ? {} : { code: issue.code }),
    ...(issue.resultLevel === undefined
      ? {}
      : { resultLevel: issue.resultLevel }),
  };
}
function projectEvidence<T extends ArcaAuthorizationOutcome>(
  evidence: T,
  includeRaw: boolean
): Omit<T, "raw"> & { raw?: Record<string, unknown> } {
  const base = {
    kind: evidence.kind,
    service: evidence.service,
    operation: evidence.operation,
    results: {
      ...(evidence.results.header === undefined
        ? {}
        : { header: evidence.results.header }),
      ...(evidence.results.detail === undefined
        ? {}
        : { detail: evidence.results.detail }),
      ...(evidence.results.operation === undefined
        ? {}
        : { operation: evidence.results.operation }),
    },
    errors: evidence.errors.map(projectIssue),
    observations: evidence.observations.map(projectIssue),
    ...(includeRaw && evidence.raw !== undefined ? { raw: evidence.raw } : {}),
  };
  const projected: Record<string, unknown> = { ...base };
  for (const field of [
    "result",
    "resultLevel",
    "cae",
    "caeExpiry",
    "voucherNumber",
    "reason",
  ] as const) {
    if (field in evidence && evidence[field as keyof T] !== undefined) {
      projected[field] = evidence[field as keyof T];
    }
  }
  if (evidence.kind === "indeterminate" && evidence.authentication) {
    const { code, reason, providerCode } = evidence.authentication;
    projected.authentication = {
      code,
      reason,
      ...(providerCode === undefined ? {} : { providerCode }),
    };
  }
  return projected as Omit<T, "raw"> & { raw?: Record<string, unknown> };
}

function validateOptions(options: IssueOptions) {
  assertIssueObject(options, "options");
  assertIssueKeys(
    options,
    [
      "representedTaxId",
      "forceRefresh",
      "include",
      "idempotencyKey",
      "service",
      "number",
    ],
    "options"
  );
  if (
    options.service !== undefined &&
    options.service !== "wsfe" &&
    options.service !== "wsmtxca"
  ) {
    throw new ArcaInputError("Unknown fiscal service", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "options.service",
    });
  }
  if (
    options.number !== undefined &&
    (!Number.isSafeInteger(options.number) ||
      options.number < 1 ||
      options.number > 99_999_999)
  ) {
    throw new ArcaInputError("Invalid reserved number", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "options.number",
    });
  }
  if (options.representedTaxId !== undefined) {
    issueDocumentNumber(
      options.representedTaxId,
      "options.representedTaxId",
      11,
      11
    );
  }
  if (
    options.forceRefresh !== undefined &&
    typeof options.forceRefresh !== "boolean"
  ) {
    throw new ArcaInputError("options.forceRefresh must be a boolean.", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "options.forceRefresh",
    });
  }
  if (options.include !== undefined) {
    assertIssueObject(options.include, "options.include");
    assertIssueKeys(options.include, ["raw", "exactInput"], "options.include");
    for (const field of ["raw", "exactInput"] as const) {
      if (
        options.include[field] !== undefined &&
        typeof options.include[field] !== "boolean"
      ) {
        throw new ArcaInputError(
          `options.include.${field} must be a boolean.`,
          {
            code: "ARCA_INPUT_INVALID_VALUE",
            field: `options.include.${field}`,
          }
        );
      }
    }
  }
}

function replayEvidence(
  service: "wsfe" | "wsmtxca" = "wsfe"
): RecoveryInput["attempt"] {
  return {
    kind: "indeterminate",
    service,
    operation: service === "wsfe" ? "FECAESolicitar" : "autorizarComprobante",
    reason: "incomplete_response",
    results: {},
    errors: [],
    observations: [],
  };
}

async function issueCreditNote(
  wsfe: IssueWsfeService,
  input: CreditNoteInput | PeriodNoteInput,
  inputOptions: IssueOptions,
  context?: StoreContext,
  kind: "creditNote" | "debitNote" = "creditNote"
): Promise<IssueOutcome<IssueOptions>> {
  const options = structuredClone(inputOptions);
  validateOptions(options);
  validateKeyStore(options, context);
  // Copy before the first await: caller mutation must not change the reservation.
  assertIssueObject(input, "input");
  const note =
    "associatedPeriod" in input && !("for" in input)
      ? structuredClone(input)
      : assertCreditNoteInput(input as CreditNoteInput);
  if (kind === "debitNote" && "all" in note && note.all) {
    throw new ArcaInputError("Debit notes require explicit items", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "items",
    });
  }
  return await runOperation(
    wsfe,
    kind,
    note,
    () => prepareNote(wsfe, note, options, context, kind),
    options,
    context
  );
}
async function previewNote(
  wsfe: IssueWsfeService,
  input: CreditNoteInput | PeriodNoteInput,
  inputOptions: PreviewOptions,
  context: StoreContext | undefined,
  kind: "creditNote" | "debitNote"
): Promise<IssuePreview<IssuanceService>> {
  const options = structuredClone(inputOptions);
  assertIssueKeys(
    options,
    ["representedTaxId", "service", "forceRefresh"],
    "options"
  );
  return toPreview(
    await prepareNote(wsfe, input, options, context, kind),
    options
  );
}

async function prepareNote(
  wsfe: IssueWsfeService,
  input: CreditNoteInput | PeriodNoteInput,
  options: IssueOptions,
  context: StoreContext | undefined,
  kind: "creditNote" | "debitNote"
): Promise<Prepared> {
  validateOptions(options);
  assertIssueObject(input, "input");
  if ("associatedPeriod" in input && !("for" in input)) {
    return preparePeriodNote(input, options, kind);
  }
  const note = assertCreditNoteInput(input as CreditNoteInput);
  if (kind === "debitNote" && note.all) {
    throw new ArcaInputError("Debit notes require explicit items", {
      code: "ARCA_INPUT_INVALID_VALUE",
    });
  }
  const target = note.for;
  const original = await wsfe.lookupVoucher({
    representedTaxId: options.representedTaxId,
    forceRefresh: options.forceRefresh,
    ...target,
  });
  if (original.kind !== "found") {
    throw new ArcaInputError(
      "issueCreditNote failed: original voucher not found",
      { code: "ARCA_INPUT_INVALID_VALUE", field: "input.for" }
    );
  }
  if (
    original.voucher.salesPoint !== target.salesPoint ||
    original.voucher.voucherType !== target.voucherType ||
    original.voucher.voucherNumber !== target.number
  ) {
    throw new ArcaInputError(
      "Original lookup coordinates do not match input.for",
      { code: "ARCA_INPUT_INVALID_VALUE", field: "input.for" }
    );
  }
  const prepared: Prepared =
    note.all === true
      ? deriveWsfeFullCreditNote(original.voucher, note)
      : deriveWsfePartialCreditNote(original.voucher, note, new Date(), kind);
  if (note.details !== undefined) {
    prepared.data.details = structuredClone(note.details);
  } else if (note.all && "details" in original.voucher) {
    prepared.data.details = structuredClone(
      original.voucher.details as FiscalHeader["details"]
    );
  }
  if (voucherFamily(prepared.data.voucherType).family === "fce") {
    const taxId = options.representedTaxId ?? context?.taxId;
    if (!taxId) {
      throw new ArcaInputError("FCE association requires the issuer tax ID", {
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "representedTaxId",
      });
    }
    for (const associated of prepared.data.associatedVouchers ?? []) {
      associated.taxId = String(taxId);
    }
  }
  validatePrepared(prepared, options);
  return prepared;
}

function preparePeriodNote(
  input: PeriodNoteInput,
  options: IssueOptions,
  kind: "creditNote" | "debitNote"
): Prepared {
  const { associatedPeriod, ...invoice } = input;
  assertIssueObject(associatedPeriod, "associatedPeriod");
  assertIssueKeys(associatedPeriod, ["from", "to"], "associatedPeriod");
  if (
    normalizeWsfeDateInput(associatedPeriod.from, "associatedPeriod.from") >
    normalizeWsfeDateInput(associatedPeriod.to, "associatedPeriod.to")
  ) {
    throw new ArcaInputError("Associated period starts after its end", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "associatedPeriod",
    });
  }
  const prepared = prepareInvoice(invoice, options);
  const family = voucherFamily(prepared.data.voucherType);
  if (family.family === "fce") {
    throw new ArcaInputError("FCE notes require an associated invoice", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "associatedPeriod",
    });
  }
  prepared.data.voucherType = family.types[
    kind === "creditNote" ? 2 : 1
  ] as number;
  prepared.data.associatedPeriod = {
    startDate: associatedPeriod.from,
    endDate: associatedPeriod.to,
  };
  normalizeWsfeVoucherInput(prepared.data);
  validatePrepared(prepared, options);
  return prepared;
}

function exactEvidence(
  data: FiscalHeader,
  number: number,
  options: IssueOptions,
  include: boolean
): { sent?: ExactIssueInput<IssuanceService> } {
  return include
    ? {
        sent:
          options.service === "wsmtxca" ? wsmtxcaRequest(data, number) : data,
      }
    : {};
}

async function recoverOperation(
  select: (options: IssueOptions) => IssueWsfeService,
  key: string,
  inputOptions: RecoveryOptions,
  context?: StoreContext
): Promise<IssueOutcome<IssueOptions>> {
  const options = structuredClone(inputOptions);
  assertIssueObject(options, "options");
  assertIssueKeys(
    options,
    ["representedTaxId", "forceRefresh", "include"],
    "options"
  );
  validateOptions(options);
  validateKeyStore({ ...options, idempotencyKey: key }, context);
  const json = await storeCall(() =>
    (context as StoreContext & { store: ArcaStore }).store.get(
      attemptKey(
        (context as StoreContext).environment,
        (context as StoreContext).taxId,
        key
      )
    )
  );
  if (json === null) {
    throw new ArcaInputError("No reservation exists for this idempotency key", {
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "idempotencyKey",
    });
  }
  const record = readRecord(json);
  const store = (context as StoreContext & { store: ArcaStore }).store;
  const settled = settledKey(
    (context as StoreContext).environment,
    (context as StoreContext).taxId,
    key
  );
  if (
    options.representedTaxId !== undefined &&
    String(options.representedTaxId) !==
      (record.representedTaxId ?? context?.taxId)
  ) {
    throw new ArcaInputError(
      "Reservation belongs to another represented taxpayer",
      { code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" }
    );
  }
  const recorded = await storeCall(() => store.get(settled));
  if (recorded !== null) {
    return settledConflict(readSettledRecord(recorded), record);
  }
  const storedOptions = {
    ...options,
    service: record.service ?? ("wsfe" as const),
    representedTaxId: record.representedTaxId,
  };
  const prepared = preparedFromRecord(record);
  return await recordConflict(
    store,
    settled,
    await recoverInvoice({
      wsfe: select(storedOptions),
      service: storedOptions.service,
      auth: storedOptions,
      data: prepared.data,
      attempted: {
        salesPoint: record.salesPoint,
        voucherType: record.voucherType,
        number: record.number,
      },
      attempt: replayEvidence(storedOptions.service),
      includeRaw: options.include?.raw === true,
      exact: exactEvidence(
        prepared.data,
        record.number,
        storedOptions,
        options.include?.exactInput === true
      ),
      voucher: (cae, caeExpiry) => ({
        salesPoint: record.salesPoint,
        voucherType: record.voucherType,
        number: record.number,
        voucherClass: prepared.voucherClass,
        date: prepared.data.voucherDate,
        amounts: prepared.amounts,
        cae,
        caeExpiry,
      }),
    })
  );
}
