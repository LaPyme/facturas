import {
  ArcaInputError,
  ArcaInvalidSoapResponseError,
  ArcaServiceError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";
import {
  classifyArcaAuthenticationError,
  classifyArcaAuthenticationIssues,
  createArcaAuthenticationEvidence,
  executeWithAuthenticationRecovery,
} from "../internal/authentication";
import type { ArcaClientConfig, ArcaRepresentedTaxId } from "../internal/types";
import type { SoapTransport } from "../soap";
import type { WsaaAuthModule } from "../wsaa";
import type {
  ArcaAuthorizationIndeterminateReason,
  ArcaAuthorizationOutcome,
  ArcaFiscalIssue,
  ArcaVoucherLookupResult,
} from "./fiscal-evidence";

/** Input data for one WSMTXCA voucher authorization. */
export type WsmtxcaAuthorizeVoucherInput = {
  representedTaxId?: ArcaRepresentedTaxId;
  data: Record<string, unknown>;
  forceRefresh?: boolean;
  /** Aborts login, submission and consultation with the caller's deadline. */
  signal?: AbortSignal;
};

/** Structured evidence from one exact WSMTXCA authorization attempt. */
export type WsmtxcaAuthorizationOutcome = ArcaAuthorizationOutcome<"wsmtxca">;

/** Result of querying the last authorized voucher number. */
export type WsmtxcaLastAuthorizedVoucherResult = {
  voucherNumber: number;
  raw: Record<string, unknown>;
};

/** A point of sale enabled for WSMTXCA. */
export type WsmtxcaSalesPoint = {
  number: number;
  blocked: boolean;
  deletedAt?: string;
};

/** Result of querying WSMTXCA points of sale. */
export type WsmtxcaSalesPointsResult = {
  salesPoints: WsmtxcaSalesPoint[];
  raw: Record<string, unknown>;
};

/** Typed provider fields used to match one exact WSMTXCA voucher. */
export type WsmtxcaVoucherInfo = {
  voucherNumber?: number;
  invoiceDate?: string;
  salesPoint?: number;
  voucherType?: number;
  concept?: number;
  documentType?: number;
  documentNumber?: string;
  receiverVatConditionId?: number;
  totalAmount?: number;
  subtotalAmount?: number;
  taxableAmount?: number;
  nonTaxableAmount?: number;
  exemptAmount?: number;
  taxAmount?: number;
  vatAmount?: number;
  currencyId?: string;
  exchangeRate?: number;
  cae?: string;
  caeExpiry?: string;
  raw: Record<string, unknown>;
};

/** Typed exact-voucher consultation result for WSMTXCA. */
export type WsmtxcaVoucherLookupOutcome = ArcaVoucherLookupResult<
  WsmtxcaVoucherInfo,
  "wsmtxca"
>;

/** Result of looking up a specific WSMTXCA voucher. */
export type WsmtxcaVoucherLookupResult = {
  invoiceDate: string;
  voucher: Record<string, unknown>;
  messages: string[];
  raw: Record<string, unknown>;
};

/** WSMTXCA electronic invoicing service (Factura de Crédito Electrónica). */
export type WsmtxcaService = {
  /**
   * Issues one exact voucher: a single autorizarComprobante without transport
   * retries, returning structured evidence instead of throwing.
   */
  issue(
    input: WsmtxcaAuthorizeVoucherInput
  ): Promise<WsmtxcaAuthorizationOutcome>;
  /** Returns the last authorized voucher number for the given sales point and type. */
  getLastAuthorizedVoucher(input: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<WsmtxcaLastAuthorizedVoucherResult>;
  /** Returns the points of sale enabled for WSMTXCA. */
  getSalesPoints(input: {
    representedTaxId?: ArcaRepresentedTaxId;
    forceRefresh?: boolean;
  }): Promise<WsmtxcaSalesPointsResult>;
  /** Consults one exact voucher and normalizes WSMTXCA error 1503 to `not_found`. */
  lookupVoucher(input: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    voucherNumber: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<WsmtxcaVoucherLookupOutcome>;
  /** Retrieves details for a specific voucher. */
  getVoucher(input: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    voucherNumber: number;
    forceRefresh?: boolean;
  }): Promise<WsmtxcaVoucherLookupResult>;
};

export type CreateWsmtxcaServiceOptions = {
  config: ArcaClientConfig;
  auth: WsaaAuthModule;
  soap: SoapTransport;
};

/** Creates a WSMTXCA service instance wired with authentication and SOAP transport. */
export function createWsmtxcaService(
  options: CreateWsmtxcaServiceOptions
): WsmtxcaService {
  async function executeWsmtxcaAuthenticatedOperation(
    operation: WsmtxcaOperation,
    input: {
      representedTaxId?: ArcaRepresentedTaxId;
      forceRefresh?: boolean;
      signal?: AbortSignal;
    },
    body: Record<string, unknown> = {},
    retries?: number
  ) {
    const auth = await options.auth.login("wsmtxca", {
      representedTaxId: input.representedTaxId,
      forceRefresh: input.forceRefresh,
      signal: input.signal,
    });
    const response = await options.soap.execute<
      Record<string, unknown>,
      Record<string, unknown>
    >({
      service: "wsmtxca",
      operation,
      ...(retries === undefined ? {} : { retries }),
      signal: input.signal,
      bodyElementName: `${operation}Request`,
      bodyElementNamespaceMode: "prefix",
      body: {
        // WSMTXCA request types use an XML sequence with authentication first.
        authRequest: createWsmtxcaAuth(
          input.representedTaxId ?? options.config.taxId,
          auth.token,
          auth.sign
        ),
        ...body,
      },
    });

    return unwrapWsmtxcaOperationResponse(response.result, operation);
  }

  async function executeWsmtxcaAuthorization({
    representedTaxId,
    data,
    forceRefresh,
    signal,
  }: WsmtxcaAuthorizeVoucherInput): Promise<{
    outcome: WsmtxcaAuthorizationOutcome;
    error?: unknown;
  }> {
    if (Object.hasOwn(data, "authRequest")) {
      throw new ArcaInputError(
        'WSMTXCA authorization data cannot include the reserved top-level field "authRequest".',
        {
          code: "ARCA_INPUT_RESERVED_FIELD",
          field: "data.authRequest",
          expected: "omitted because facturas manages authentication fields",
        }
      );
    }

    try {
      const raw = await executeWsmtxcaAuthenticatedOperation(
        "autorizarComprobante",
        { representedTaxId, forceRefresh, signal },
        data,
        0
      );
      return { outcome: classifyWsmtxcaAuthorization(raw) };
    } catch (error) {
      return {
        outcome: createWsmtxcaIndeterminateOutcome(error),
        error,
      };
    }
  }

  async function issue(
    input: WsmtxcaAuthorizeVoucherInput
  ): Promise<WsmtxcaAuthorizationOutcome> {
    return (await executeWsmtxcaAuthorization(input)).outcome;
  }

  function getLastAuthorizedVoucher({
    representedTaxId,
    voucherType,
    salesPoint,
    forceRefresh,
    signal,
  }: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<WsmtxcaLastAuthorizedVoucherResult> {
    return executeWithAuthenticationRecovery({
      service: "wsmtxca",
      operation: "consultarUltimoComprobanteAutorizado",
      forceRefresh,
      execute: (attemptForceRefresh) =>
        getLastAuthorizedVoucherOnce({
          representedTaxId,
          voucherType,
          salesPoint,
          forceRefresh: attemptForceRefresh,
          signal,
        }),
    });
  }

  async function getLastAuthorizedVoucherOnce({
    representedTaxId,
    voucherType,
    salesPoint,
    forceRefresh,
    signal,
  }: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<WsmtxcaLastAuthorizedVoucherResult> {
    const operation = "consultarUltimoComprobanteAutorizado";
    const raw = await executeWsmtxcaAuthenticatedOperation(
      operation,
      { representedTaxId, forceRefresh, signal },
      {
        consultaUltimoComprobanteAutorizadoRequest: {
          codigoTipoComprobante: voucherType,
          numeroPuntoVenta: salesPoint,
        },
      }
    );
    const errors = extractWsmtxcaIssues(raw, operation, "error");

    if (errors.length > 0 && errors.every((issue) => issue.code === "1502")) {
      return { voucherNumber: 0, raw };
    }
    if (errors.length > 0) {
      throw createWsmtxcaServiceError(operation, errors);
    }

    return {
      voucherNumber: parseWsmtxcaVoucherNumber(
        raw.numeroComprobante ?? raw.cbteNro ?? raw.nroComprobante,
        "WSMTXCA did not return the last authorized voucher number",
        true
      ),
      raw,
    };
  }

  function getSalesPoints({
    representedTaxId,
    forceRefresh,
  }: {
    representedTaxId?: ArcaRepresentedTaxId;
    forceRefresh?: boolean;
  }): Promise<WsmtxcaSalesPointsResult> {
    return executeWithAuthenticationRecovery({
      service: "wsmtxca",
      operation: "consultarPuntosVenta",
      forceRefresh,
      execute: (attemptForceRefresh) =>
        getSalesPointsOnce({
          representedTaxId,
          forceRefresh: attemptForceRefresh,
        }),
    });
  }

  async function getSalesPointsOnce({
    representedTaxId,
    forceRefresh,
  }: {
    representedTaxId?: ArcaRepresentedTaxId;
    forceRefresh?: boolean;
  }): Promise<WsmtxcaSalesPointsResult> {
    const operation = "consultarPuntosVenta";
    const raw = await executeWsmtxcaAuthenticatedOperation(operation, {
      representedTaxId,
      forceRefresh,
    });
    throwForWsmtxcaOperationErrors(operation, raw);
    const rawSalesPoints = toRecord(raw.arrayPuntosVenta)?.puntoVenta;
    const entries = Array.isArray(rawSalesPoints)
      ? rawSalesPoints
      : rawSalesPoints
        ? [rawSalesPoints]
        : [];
    const salesPoints = entries.flatMap((entry) => {
      const record = toRecord(entry);
      const number = parseOptionalPositiveInteger(record?.numeroPuntoVenta);
      if (number === undefined) {
        return [];
      }
      const deletedAt = normalizeWsmtxcaResponseDate(record?.fechaBaja);
      return [
        {
          number,
          blocked: String(record?.bloqueado ?? "N").toUpperCase() === "S",
          ...(deletedAt === undefined ? {} : { deletedAt }),
        },
      ];
    });

    return { salesPoints, raw };
  }

  function lookupVoucher({
    representedTaxId,
    voucherType,
    salesPoint,
    voucherNumber,
    forceRefresh,
    signal,
  }: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    voucherNumber: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<WsmtxcaVoucherLookupOutcome> {
    return executeWithAuthenticationRecovery({
      service: "wsmtxca",
      operation: "consultarComprobante",
      forceRefresh,
      execute: (attemptForceRefresh) =>
        lookupVoucherOnce({
          representedTaxId,
          voucherType,
          salesPoint,
          voucherNumber,
          forceRefresh: attemptForceRefresh,
          signal,
        }),
    });
  }

  async function lookupVoucherOnce({
    representedTaxId,
    voucherType,
    salesPoint,
    voucherNumber,
    forceRefresh,
    signal,
  }: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    voucherNumber: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<WsmtxcaVoucherLookupOutcome> {
    const operation = "consultarComprobante";
    const raw = await executeWsmtxcaAuthenticatedOperation(
      operation,
      { representedTaxId, forceRefresh, signal },
      {
        consultaComprobanteRequest: {
          codigoTipoComprobante: voucherType,
          numeroPuntoVenta: salesPoint,
          numeroComprobante: voucherNumber,
        },
      }
    );
    const errors = extractWsmtxcaIssues(raw, operation, "error");
    const observations = extractWsmtxcaIssues(raw, operation, "observation");

    if (errors.length > 0 && errors.every((issue) => issue.code === "1503")) {
      return {
        kind: "not_found",
        service: "wsmtxca",
        operation,
        errors,
        observations,
        raw,
      };
    }
    if (errors.length > 0) {
      throw createWsmtxcaServiceError(operation, errors);
    }

    const voucher = extractWsmtxcaVoucherPayload(raw);
    if (voucher === raw && !toRecord(raw.comprobante)) {
      throw new ArcaServiceError(
        "WSMTXCA did not return the voucher issue date",
        {
          service: "wsmtxca",
          operation,
          issues: observations,
        }
      );
    }

    return {
      kind: "found",
      service: "wsmtxca",
      operation,
      voucher: mapWsmtxcaVoucherInfo(voucher),
      observations,
      raw,
    };
  }

  async function getVoucher(input: {
    representedTaxId?: ArcaRepresentedTaxId;
    voucherType: number;
    salesPoint: number;
    voucherNumber: number;
    forceRefresh?: boolean;
  }): Promise<WsmtxcaVoucherLookupResult> {
    const lookup = await lookupVoucher(input);
    if (lookup.kind === "not_found") {
      throw createWsmtxcaServiceError(lookup.operation, lookup.errors);
    }

    const invoiceDate = lookup.voucher.invoiceDate;
    if (!invoiceDate) {
      throw new ArcaServiceError(
        formatWsmtxcaIssues(lookup.observations)[0] ??
          "WSMTXCA did not return the voucher issue date",
        {
          service: "wsmtxca",
          operation: lookup.operation,
          issues: lookup.observations,
        }
      );
    }

    return {
      invoiceDate,
      voucher: lookup.voucher.raw,
      messages: formatWsmtxcaIssues(lookup.observations),
      raw: lookup.raw,
    };
  }

  return {
    issue,
    getLastAuthorizedVoucher,
    getSalesPoints,
    lookupVoucher,
    getVoucher,
  };
}

function createWsmtxcaAuth(
  representedTaxId: number | string,
  token: string,
  sign: string
) {
  return {
    token,
    sign,
    cuitRepresentada: Number.parseInt(String(representedTaxId), 10),
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type WsmtxcaOperation =
  | "autorizarComprobante"
  | "consultarUltimoComprobanteAutorizado"
  | "consultarPuntosVenta"
  | "consultarComprobante";

function unwrapWsmtxcaOperationResponse(
  response: unknown,
  operation: WsmtxcaOperation
) {
  const responseRecord = toRecord(response) ?? {};

  if (operation === "autorizarComprobante") {
    return (
      toRecord(responseRecord.autorizarComprobanteResponse) ??
      toRecord(responseRecord.autorizarComprobanteResult) ??
      toRecord(responseRecord.comprobanteCAEResponse) ??
      toRecord(responseRecord.comprobanteCAEReponse) ??
      responseRecord
    );
  }

  if (operation === "consultarComprobante") {
    return (
      toRecord(responseRecord.consultarComprobanteResponse) ??
      toRecord(responseRecord.consultaComprobanteResponse) ??
      toRecord(responseRecord.consultarComprobanteResult) ??
      responseRecord
    );
  }

  if (operation === "consultarPuntosVenta") {
    return (
      toRecord(responseRecord.consultarPuntosVentaResponse) ??
      toRecord(responseRecord.consultarPuntosVentaResult) ??
      responseRecord
    );
  }

  return (
    toRecord(responseRecord.consultarUltimoComprobanteAutorizadoResponse) ??
    toRecord(responseRecord.consultaUltimoComprobanteAutorizadoResponse) ??
    toRecord(responseRecord.consultarUltimoComprobanteAutorizadoResult) ??
    responseRecord
  );
}

function extractWsmtxcaAuthorizationPayload(raw: Record<string, unknown>) {
  return (
    toRecord(raw.comprobanteResponse) ??
    toRecord(raw.comprobanteCAEResponse) ??
    toRecord(raw.comprobanteCAEReponse) ??
    raw
  );
}

function extractWsmtxcaVoucherPayload(raw: Record<string, unknown>) {
  return (
    toRecord(raw.comprobanteResponse) ??
    toRecord(raw.comprobante) ??
    toRecord(raw.cmp) ??
    raw
  );
}

function classifyWsmtxcaAuthorization(
  raw: Record<string, unknown>
): WsmtxcaAuthorizationOutcome {
  const operation = "autorizarComprobante";
  const payload = extractWsmtxcaAuthorizationPayload(raw);
  const result = normalizeWsmtxcaResult(raw.resultado ?? payload.resultado);
  const cae = normalizeWsmtxcaString(
    payload.CAE ?? payload.codigoAutorizacion ?? raw.codigoAutorizacion
  );
  const caeExpiry = normalizeWsmtxcaResponseDate(
    payload.fechaVencimientoCAE ??
      payload.fechaVencimiento ??
      raw.fechaVencimiento
  );
  const voucherNumber = parseOptionalPositiveInteger(
    payload.numeroComprobante ?? raw.numeroComprobante
  );
  const errors = extractWsmtxcaIssues(raw, operation, "error");
  const observations = extractWsmtxcaIssues(raw, operation, "observation");
  const base = {
    service: "wsmtxca" as const,
    operation,
    results: createWsmtxcaResults(result),
    errors,
    observations,
    raw,
  };

  const authenticationOutcome = createWsmtxcaAuthenticationOutcome({
    base,
    result,
    cae,
    voucherNumber,
  });
  if (authenticationOutcome) {
    return authenticationOutcome;
  }

  if (
    (result === "A" || result === "O") &&
    cae &&
    voucherNumber !== undefined &&
    errors.length === 0
  ) {
    return {
      ...base,
      kind: "authorized",
      result,
      resultLevel: "operation",
      cae,
      ...(caeExpiry === undefined ? {} : { caeExpiry }),
      voucherNumber,
    };
  }

  if (result === "R" && !cae && errors.length > 0) {
    return {
      ...base,
      kind: "rejected",
      result: "R",
      resultLevel: "operation",
    };
  }

  const outcome: WsmtxcaAuthorizationOutcome = {
    ...base,
    kind: "indeterminate",
    reason:
      (result === "R" && Boolean(cae)) ||
      ((result === "A" || result === "O") && Boolean(errors.length))
        ? "contradictory_response"
        : "incomplete_response",
    ...(result === undefined ? {} : { result }),
    ...(result === undefined ? {} : { resultLevel: "operation" }),
  };
  assignWsmtxcaValue(outcome, "cae", cae);
  assignWsmtxcaValue(outcome, "caeExpiry", caeExpiry);
  assignWsmtxcaValue(outcome, "voucherNumber", voucherNumber);
  return outcome;
}

function createWsmtxcaAuthenticationOutcome({
  base,
  result,
  cae,
  voucherNumber,
}: {
  base: {
    service: "wsmtxca";
    operation: string;
    results: ReturnType<typeof createWsmtxcaResults>;
    errors: ArcaFiscalIssue[];
    observations: ArcaFiscalIssue[];
    raw: Record<string, unknown>;
  };
  result?: string;
  cae?: string;
  voucherNumber?: number;
}): WsmtxcaAuthorizationOutcome | undefined {
  const authenticationError = classifyArcaAuthenticationIssues(base.errors, {
    service: base.service,
    operation: base.operation,
  });
  if (
    !authenticationError ||
    result === "A" ||
    result === "O" ||
    cae ||
    voucherNumber !== undefined
  ) {
    return undefined;
  }

  return {
    ...base,
    kind: "indeterminate",
    reason: "authentication_rejected",
    authentication: createArcaAuthenticationEvidence(authenticationError),
    ...(result === undefined ? {} : { result }),
    ...(result === undefined ? {} : { resultLevel: "operation" }),
  };
}

function createWsmtxcaIndeterminateOutcome(
  error: unknown
): WsmtxcaAuthorizationOutcome {
  const authenticationError = classifyArcaAuthenticationError(error, {
    service: "wsmtxca",
    operation: "autorizarComprobante",
  });
  return {
    kind: "indeterminate",
    service: "wsmtxca",
    operation: "autorizarComprobante",
    results: {},
    reason: authenticationError
      ? "authentication_rejected"
      : getWsmtxcaIndeterminateReason(error),
    ...(authenticationError
      ? {
          authentication: createArcaAuthenticationEvidence(authenticationError),
        }
      : {}),
    errors: [],
    observations: [],
  };
}

function getWsmtxcaIndeterminateReason(
  error: unknown
): ArcaAuthorizationIndeterminateReason {
  if (error instanceof ArcaTransportError) {
    return "transport_error";
  }
  if (error instanceof ArcaSoapFaultError) {
    return "soap_fault";
  }
  if (error instanceof ArcaInvalidSoapResponseError) {
    return "invalid_response";
  }
  return "unexpected_error";
}

function createWsmtxcaResults(operationResult?: string) {
  const results: { operation?: string } = {};
  assignWsmtxcaValue(results, "operation", operationResult);
  return results;
}

function createWsmtxcaServiceError(
  operation: string,
  issues: ArcaFiscalIssue[]
) {
  const authenticationError = classifyArcaAuthenticationIssues(issues, {
    service: "wsmtxca",
    operation,
  });
  if (authenticationError) {
    return authenticationError;
  }

  const firstIssue = issues[0];
  return new ArcaServiceError(
    formatWsmtxcaIssues(issues).join(" | ") ||
      "WSMTXCA returned a service error",
    {
      service: "wsmtxca",
      operation,
      ...(firstIssue?.code === undefined
        ? {}
        : { serviceCode: firstIssue.code }),
      issues,
    }
  );
}

function throwForWsmtxcaOperationErrors(
  operation: string,
  raw: Record<string, unknown>
): void {
  const errors = extractWsmtxcaIssues(raw, operation, "error");
  if (errors.length > 0) {
    throw createWsmtxcaServiceError(operation, errors);
  }
}

function extractWsmtxcaIssues(
  raw: Record<string, unknown>,
  operation: string,
  source: "error" | "observation"
): ArcaFiscalIssue[] {
  const container = toRecord(
    source === "error" ? raw.arrayErrores : raw.arrayObservaciones
  );
  return normalizeWsmtxcaIssueEntries(container?.codigoDescripcion).map(
    (entry) => ({
      service: "wsmtxca",
      operation,
      source,
      category:
        source === "observation"
          ? "observation"
          : operation === "autorizarComprobante"
            ? "business"
            : "unknown",
      ...(entry.code === undefined ? {} : { code: entry.code }),
      message: entry.message,
      ...(operation === "autorizarComprobante"
        ? { resultLevel: "operation" as const }
        : {}),
    })
  );
}

function normalizeWsmtxcaIssueEntries(value: unknown) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.map((entry) => {
    const record = toRecord(entry) ?? {};
    const code = record.codigo;
    const description = record.descripcion;
    return {
      ...(code === undefined || code === null ? {} : { code: String(code) }),
      message:
        description === undefined || description === null
          ? "Unknown WSMTXCA issue"
          : String(description),
    };
  });
}

function formatWsmtxcaIssues(issues: ArcaFiscalIssue[]): string[] {
  return issues.map((issue) => {
    const prefix = issue.source === "error" ? "Error" : "Obs";
    return `${prefix}${issue.code ? ` ${issue.code}` : ""}: ${issue.message}`;
  });
}

function mapWsmtxcaVoucherInfo(
  raw: Record<string, unknown>
): WsmtxcaVoucherInfo {
  const voucher: WsmtxcaVoucherInfo = { raw };
  const invoiceDate = normalizeWsmtxcaResponseDate(
    raw.fechaEmision ?? raw.fecha ?? raw.CbteFch
  );
  const cae = normalizeWsmtxcaString(raw.codigoAutorizacion ?? raw.CAE);
  const caeExpiry = normalizeWsmtxcaResponseDate(
    raw.fechaVencimiento ?? raw.fechaVencimientoCAE
  );
  const vatAmount = sumWsmtxcaVatAmounts(raw.arraySubtotalesIVA);

  assignWsmtxcaValue(
    voucher,
    "voucherNumber",
    parseOptionalPositiveInteger(raw.numeroComprobante)
  );
  assignWsmtxcaValue(voucher, "invoiceDate", invoiceDate);
  assignWsmtxcaValue(
    voucher,
    "salesPoint",
    parseOptionalPositiveInteger(raw.numeroPuntoVenta)
  );
  assignWsmtxcaValue(
    voucher,
    "voucherType",
    parseOptionalPositiveInteger(raw.codigoTipoComprobante)
  );
  assignWsmtxcaValue(
    voucher,
    "concept",
    parseOptionalNumber(raw.codigoConcepto)
  );
  assignWsmtxcaValue(
    voucher,
    "documentType",
    parseOptionalNumber(raw.codigoTipoDocumento)
  );
  assignWsmtxcaValue(
    voucher,
    "documentNumber",
    normalizeWsmtxcaString(raw.numeroDocumento)
  );
  assignWsmtxcaValue(
    voucher,
    "receiverVatConditionId",
    parseOptionalNumber(raw.condicionIVAReceptor)
  );
  assignWsmtxcaValue(
    voucher,
    "totalAmount",
    parseOptionalNumber(raw.importeTotal)
  );
  assignWsmtxcaValue(
    voucher,
    "subtotalAmount",
    parseOptionalNumber(raw.importeSubtotal)
  );
  assignWsmtxcaValue(
    voucher,
    "taxableAmount",
    parseOptionalNumber(raw.importeGravado)
  );
  assignWsmtxcaValue(
    voucher,
    "nonTaxableAmount",
    parseOptionalNumber(raw.importeNoGravado)
  );
  assignWsmtxcaValue(
    voucher,
    "exemptAmount",
    parseOptionalNumber(raw.importeExento)
  );
  assignWsmtxcaValue(
    voucher,
    "taxAmount",
    parseOptionalNumber(raw.importeOtrosTributos)
  );
  assignWsmtxcaValue(voucher, "vatAmount", vatAmount);
  assignWsmtxcaValue(
    voucher,
    "currencyId",
    normalizeWsmtxcaString(raw.codigoMoneda)
  );
  assignWsmtxcaValue(
    voucher,
    "exchangeRate",
    parseOptionalNumber(raw.cotizacionMoneda)
  );
  assignWsmtxcaValue(voucher, "cae", cae);
  assignWsmtxcaValue(voucher, "caeExpiry", caeExpiry);

  return voucher;
}

function sumWsmtxcaVatAmounts(value: unknown): number | undefined {
  const subtotals = toRecord(value)?.subtotalIVA;
  const entries = Array.isArray(subtotals)
    ? subtotals
    : subtotals
      ? [subtotals]
      : [];
  const amounts = entries
    .map((entry) => parseOptionalNumber(toRecord(entry)?.importe))
    .filter((amount): amount is number => amount !== undefined);
  return amounts.length > 0
    ? amounts.reduce((total, amount) => total + amount, 0)
    : undefined;
}

function parseWsmtxcaVoucherNumber(
  value: unknown,
  message: string,
  allowZero = false
) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new ArcaServiceError(message, {
      service: "wsmtxca",
    });
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeWsmtxcaResult(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
}

function normalizeWsmtxcaString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function assignWsmtxcaValue<TTarget, TKey extends keyof TTarget>(
  target: TTarget,
  key: TKey,
  value: TTarget[TKey] | undefined
) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function normalizeWsmtxcaResponseDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return formatCompactDateToIso(value);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d{8}$/.test(trimmed)) {
    return formatCompactDateToIso(Number.parseInt(trimmed, 10));
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  return undefined;
}

function formatCompactDateToIso(dateValue?: number | null): string | undefined {
  if (!dateValue) {
    return undefined;
  }

  const raw = String(dateValue);
  if (raw.length !== 8) {
    return undefined;
  }

  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}
