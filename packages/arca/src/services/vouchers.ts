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
  type ArcaStore,
  attemptKey,
  canonicalHash,
  storeCall,
} from "../store/types";
import type { ArcaAuthorizationOutcome } from "./fiscal-evidence";
import type {
  IssuedVoucher,
  IssueOptions,
  IssueOutcome,
} from "./vouchers-types";
import {
  normalizeWsfeDateInput,
  normalizeWsfeVoucherInput,
  type WsfeDateInput,
  type WsfeService,
  type WsfeVoucherInput,
} from "./wsfe";
import { deriveWsfeCancellation } from "./wsfe-cancel";
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
} from "./wsfe-identity";

export type VouchersService = {
  /** Creates a full credit note associated to an authorized A, B or C invoice. */
  cancel<
    O extends IssueOptions & { date?: WsfeDateInput } = { include?: never },
  >(target: VoucherCoordinates, options?: O): Promise<IssueOutcome<O>>;
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
};

type IssueWsfeService = Pick<
  WsfeService,
  "getNextVoucherNumber" | "authorizeVoucherOutcome" | "lookupVoucher"
>;
type StoreContext = {
  store?: ArcaStore;
  environment: ArcaEnvironment;
  taxId: string;
};
type Prepared = ReturnType<typeof deriveWsfeInvoice>;

export function createVouchersService(
  wsfe: IssueWsfeService,
  context?: StoreContext
): VouchersService {
  return {
    cancel: async <
      O extends IssueOptions & { date?: WsfeDateInput } = { include?: never },
    >(
      target: VoucherCoordinates,
      options?: O
    ): Promise<IssueOutcome<O>> => {
      const result = await cancelInvoice(wsfe, target, options ?? {}, context);
      return result as IssueOutcome<O>;
    },
    issue: async <O extends IssueOptions = { include?: never }>(
      input: IssueInput,
      options?: O
    ): Promise<IssueOutcome<O>> => {
      const result = await issueInvoice(
        wsfe,
        input,
        options === undefined ? {} : options,
        context
      );
      // issueInvoice conditionally adds the fields specified by O at runtime.
      return result as IssueOutcome<O>;
    },
  };
}

async function issueInvoice(
  wsfe: IssueWsfeService,
  input: IssueInput,
  options: IssueOptions,
  context?: StoreContext
): Promise<IssueOutcome<IssueOptions>> {
  validateOptions(options);
  validateKeyStore(options, context);
  const prepared = deriveWsfeInvoice(input);
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
  const store = context?.store;
  if (options.idempotencyKey === undefined || !store || !context) {
    return runAuthorization(wsfe, await prepare(), options);
  }
  const key = attemptKey(
    context.environment,
    context.taxId,
    options.idempotencyKey
  );
  const representedTaxId =
    options.representedTaxId === undefined
      ? undefined
      : String(options.representedTaxId);
  const inputHash = canonicalHash({ input, representedTaxId });
  const existing = await storeCall(() => store.get(key));
  if (existing !== null) {
    return replay(existing);
  }
  const prepared = await prepare();
  const number = await nextNumber(wsfe, prepared.data, options);
  const record: ArcaAttemptRecord = {
    v: 1,
    operation,
    representedTaxId,
    inputHash,
    number,
    salesPoint: prepared.data.salesPoint,
    voucherType: prepared.data.voucherType,
    sent: prepared.data,
    createdAt: new Date().toISOString(),
  };
  if (await storeCall(() => store.add(key, JSON.stringify(record)))) {
    return runAuthorization(wsfe, prepared, options, number);
  }
  const winner = await storeCall(() => store.get(key));
  if (winner === null) {
    throw new ArcaConfigurationError(
      "ARCA reservation disappeared after atomic creation lost."
    );
  }
  return replay(winner);

  function replay(json: string) {
    const stored = readRecord(json);
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
    return runAuthorization(
      wsfe,
      {
        ...preparedFromRecord(stored),
        ...(replayAmounts ? { amounts: replayAmounts } : {}),
      },
      options,
      stored.number,
      true
    );
  }
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
      record.v !== 1 ||
      !["issue", "cancel"].includes(record.operation) ||
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
    voucherClass: [1, 3].includes(record.voucherType)
      ? "A"
      : [6, 8].includes(record.voucherType)
        ? "B"
        : "C",
    amounts: { computedTotal: sentTotal, sentTotal, vatAdjustment: 0 },
  };
}

async function nextNumber(
  wsfe: IssueWsfeService,
  data: WsfeVoucherInput,
  options: IssueOptions
): Promise<number> {
  const number = await wsfe.getNextVoucherNumber({
    representedTaxId: options.representedTaxId,
    forceRefresh: options.forceRefresh,
    salesPoint: data.salesPoint,
    voucherType: data.voucherType,
  });
  if (!Number.isSafeInteger(number) || number < 1 || number > 99_999_999) {
    throw new ArcaServiceError(
      "WSFE returned an invalid next voucher number.",
      { service: "wsfe", operation: "FECompUltimoAutorizado" }
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
  const exact = includeExact ? { sent: data } : {};
  const voucher = (cae: string, caeExpiry: string): IssuedVoucher => ({
    ...attempted,
    voucherClass,
    date: data.voucherDate,
    cae,
    caeExpiry,
    amounts,
  });
  const recovery = { wsfe, auth, data, attempted, includeRaw, exact, voucher };
  if (replay) {
    const attempt = replayEvidence();
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
  const authorization = await wsfe.authorizeVoucherOutcome({
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
      [...authorization.errors, ...authorization.observations].some(
        (issue) => issue.code === "10016"
      )
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
      });
      if (recovered.kind === "authorized") {
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
  data: WsfeVoucherInput;
  attempted: VoucherCoordinates;
  attempt: Omit<
    Extract<ArcaAuthorizationOutcome<"wsfe">, { kind: "indeterminate" }>,
    "raw"
  > & { raw?: Record<string, unknown> };
  includeRaw: boolean;
  exact: { sent?: WsfeVoucherInput };
  voucher: (cae: string, caeExpiry: string) => IssuedVoucher;
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
  const matched = matchWsfeVoucherIdentity(
    data,
    attempted.number,
    lookup.voucher
  );
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
function projectEvidence<T extends ArcaAuthorizationOutcome<"wsfe">>(
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
    ["representedTaxId", "forceRefresh", "include", "idempotencyKey"],
    "options"
  );
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

function replayEvidence(): RecoveryInput["attempt"] {
  return {
    kind: "indeterminate",
    service: "wsfe",
    operation: "FECAESolicitar",
    reason: "incomplete_response",
    results: {},
    errors: [],
    observations: [],
  };
}

async function cancelInvoice(
  wsfe: IssueWsfeService,
  target: VoucherCoordinates,
  options: IssueOptions & { date?: WsfeDateInput },
  context?: StoreContext
): Promise<IssueOutcome<IssueOptions>> {
  assertIssueObject(options, "options");
  const { date, ...issueOptions } = options;
  validateOptions(issueOptions);
  validateKeyStore(issueOptions, context);
  assertIssueObject(target, "target");
  for (const [field, max] of [
    ["salesPoint", 99_999],
    ["voucherType", 999],
    ["number", 99_999_999],
  ] as const) {
    if (
      !Number.isSafeInteger(target[field]) ||
      target[field] < 1 ||
      target[field] > max
    ) {
      throw new ArcaInputError(`Invalid cancel target ${field}.`, {
        code: "ARCA_INPUT_INVALID_VALUE",
        field,
      });
    }
  }
  if (![1, 6, 11].includes(target.voucherType)) {
    throw new ArcaInputError(
      "cancel requires an invoice of type 1, 6 or 11; use wsfe.authorizeVoucherOutcome() for exact control.",
      { code: "ARCA_INPUT_INVALID_VALUE" }
    );
  }
  if (date !== undefined) {
    normalizeWsfeDateInput(date, "date");
  }
  return await runOperation(
    wsfe,
    "cancel",
    { target, date },
    async () => {
      const original = await wsfe.lookupVoucher({
        representedTaxId: issueOptions.representedTaxId,
        forceRefresh: issueOptions.forceRefresh,
        salesPoint: target.salesPoint,
        voucherType: target.voucherType,
        number: target.number,
      });
      if (original.kind === "not_found") {
        throw new ArcaInputError("original voucher not found", {
          code: "ARCA_INPUT_INVALID_VALUE",
        });
      }
      if (
        original.voucher.salesPoint !== target.salesPoint ||
        original.voucher.voucherType !== target.voucherType ||
        original.voucher.voucherNumber !== target.number
      ) {
        throw new ArcaInputError(
          "Original lookup coordinates do not match the cancel target.",
          { code: "ARCA_INPUT_INVALID_VALUE" }
        );
      }
      return deriveWsfeCancellation(original.voucher, date);
    },
    issueOptions,
    context
  );
}
