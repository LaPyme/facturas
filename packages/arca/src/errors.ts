import { redactDiagnosticPreview } from "./internal/redaction";
import type { ArcaServiceName } from "./internal/types";
import type {
  ArcaFiscalIssue,
  ArcaFiscalResultLevel,
  ArcaFiscalResults,
} from "./services/fiscal-evidence";

/** Base error class for all ARCA-related errors. */
export class ArcaError extends Error {
  readonly code: string;
  override readonly name: string = "ArcaError";

  constructor(message: string, code = "ARCA_ERROR", options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Thrown when the ARCA client configuration is missing or invalid. */
export class ArcaConfigurationError extends ArcaError {
  override readonly name: string = "ArcaConfigurationError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, "ARCA_CONFIGURATION_ERROR", options);
  }
}

/** Stable routing codes for caller-provided input failures. */
export type ArcaInputErrorCode =
  | "ARCA_INPUT_IDEMPOTENCY_MISMATCH"
  | "ARCA_INPUT_INVALID_DATE"
  | "ARCA_INPUT_INVALID_AMOUNT"
  | "ARCA_INPUT_AMOUNT_PRECISION"
  | "ARCA_INPUT_AMOUNT_MISMATCH"
  | "ARCA_INPUT_INVALID_EXCHANGE_RATE"
  | "ARCA_INPUT_INVALID_VALUE"
  | "ARCA_INPUT_MISSING_FIELD"
  | "ARCA_INPUT_RESERVED_FIELD";

export type ArcaInputErrorOptions = ErrorOptions & {
  code: ArcaInputErrorCode;
  field?: string;
  expected?: string;
};

/** Thrown when caller-provided input data is missing or invalid. */
export class ArcaInputError extends ArcaError {
  declare readonly code: ArcaInputErrorCode;
  override readonly name: string = "ArcaInputError";
  readonly field?: string;
  readonly expected?: string;

  constructor(message: string, options: ArcaInputErrorOptions) {
    super(message, options.code, options);
    this.field = options.field;
    this.expected = options.expected;
  }
}

/** Stable reasons exposed for explicit ARCA authentication rejections. */
export type ArcaAuthenticationReason =
  | "invalid_token"
  | "unauthorized_computer"
  | "missing_relationship"
  | "authentication_rejected";

export type ArcaAuthenticationErrorOptions = ErrorOptions & {
  reason: ArcaAuthenticationReason;
  service: ArcaServiceName;
  operation: string;
  providerCode?: string | number;
};

/** Thrown when ARCA explicitly rejects credentials before an operation runs. */
export class ArcaAuthenticationError extends ArcaError {
  declare readonly code: "ARCA_AUTHENTICATION_ERROR";
  override readonly name: string = "ArcaAuthenticationError";
  readonly reason: ArcaAuthenticationReason;
  readonly service: ArcaServiceName;
  readonly operation: string;
  readonly providerCode?: string | number;

  constructor(message: string, options: ArcaAuthenticationErrorOptions) {
    super(
      redactDiagnosticPreview(message),
      "ARCA_AUTHENTICATION_ERROR",
      options
    );
    this.reason = options.reason;
    this.service = options.service;
    this.operation = options.operation;
    this.providerCode = normalizeProviderCode(options.providerCode);
  }
}

/** Narrows unknown failures to the explicit authentication error contract. */
export function isArcaAuthenticationError(
  error: unknown
): error is ArcaAuthenticationError {
  return error instanceof ArcaAuthenticationError;
}

/** Thrown when an HTTP request to an ARCA endpoint fails at the transport level. */
export class ArcaTransportError extends ArcaError {
  override readonly name: string = "ArcaTransportError";
  readonly statusCode?: number;
  readonly contentType?: string;
  readonly responseBodyLength?: number;
  readonly responseBodyPreview?: string;

  constructor(
    message: string,
    options?: ErrorOptions & {
      statusCode?: number;
      contentType?: string;
      responseBodyLength?: number;
      responseBodyPreview?: string;
    }
  ) {
    super(message, "ARCA_TRANSPORT_ERROR", options);
    this.statusCode = options?.statusCode;
    this.contentType = options?.contentType;
    this.responseBodyLength = options?.responseBodyLength;
    this.responseBodyPreview =
      options?.responseBodyPreview === undefined
        ? undefined
        : redactDiagnosticPreview(options.responseBodyPreview);
  }
}

/** Thrown when the SOAP response contains a Fault element. */
export class ArcaSoapFaultError extends ArcaError {
  override readonly name: string = "ArcaSoapFaultError";
  readonly faultCode?: string;

  constructor(
    message: string,
    options?: ErrorOptions & {
      faultCode?: string;
    }
  ) {
    super(redactDiagnosticPreview(message), "ARCA_SOAP_FAULT", options);
    this.faultCode =
      options?.faultCode === undefined
        ? undefined
        : redactDiagnosticPreview(options.faultCode);
  }
}

/** Thrown when a response cannot be parsed as a valid SOAP envelope. */
export class ArcaInvalidSoapResponseError extends ArcaError {
  override readonly name: string = "ArcaInvalidSoapResponseError";
  readonly service?: ArcaServiceName;
  readonly operation?: string;
  readonly endpointUrl?: string;
  readonly statusCode?: number;
  readonly contentType?: string;
  readonly responseBodyLength?: number;
  readonly responseBodyPreview?: string;

  constructor(
    message: string,
    options?: ErrorOptions & {
      service?: ArcaServiceName;
      operation?: string;
      endpointUrl?: string;
      statusCode?: number;
      contentType?: string;
      responseBodyLength?: number;
      responseBodyPreview?: string;
    }
  ) {
    super(message, "ARCA_INVALID_SOAP_RESPONSE", options);
    this.service = options?.service;
    this.operation = options?.operation;
    this.endpointUrl = options?.endpointUrl;
    this.statusCode = options?.statusCode;
    this.contentType = options?.contentType;
    this.responseBodyLength = options?.responseBodyLength;
    this.responseBodyPreview =
      options?.responseBodyPreview === undefined
        ? undefined
        : redactDiagnosticPreview(options.responseBodyPreview);
  }
}

/** Thrown when an ARCA service (WSFE, WSMTXCA, Padron) returns a domain-level error. */
export class ArcaServiceError extends ArcaError {
  override readonly name: string = "ArcaServiceError";
  readonly serviceCode?: string | number;
  readonly service?: ArcaServiceName;
  readonly operation?: string;
  readonly result?: string;
  readonly resultLevel?: ArcaFiscalResultLevel;
  readonly results?: ArcaFiscalResults;
  readonly cae?: string;
  readonly issues?: readonly ArcaFiscalIssue[];

  constructor(
    message: string,
    options?: ErrorOptions & {
      serviceCode?: string | number;
      service?: ArcaServiceName;
      operation?: string;
      result?: string;
      resultLevel?: ArcaFiscalResultLevel;
      results?: ArcaFiscalResults;
      cae?: string;
      issues?: readonly ArcaFiscalIssue[];
    }
  ) {
    super(message, "ARCA_SERVICE_ERROR", options);
    this.serviceCode = options?.serviceCode;
    this.service = options?.service;
    this.operation = options?.operation;
    this.result = options?.result;
    this.resultLevel = options?.resultLevel;
    this.results = options?.results;
    this.cae = options?.cae;
    this.issues = options?.issues;
  }
}

function normalizeProviderCode(
  providerCode: string | number | undefined
): string | number | undefined {
  if (typeof providerCode === "number") {
    return Number.isFinite(providerCode) ? providerCode : undefined;
  }
  if (typeof providerCode === "string") {
    return redactDiagnosticPreview(providerCode, 512);
  }
  return undefined;
}

/** Narrow error evidence: never includes a cause, raw response or stack. */
export type ArcaSafeErrorMetadata = {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
};

export function toArcaSafeErrorMetadata(error: unknown): ArcaSafeErrorMetadata {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof ArcaError ? { code: error.code } : {}),
    ...(error instanceof ArcaTransportError && error.statusCode !== undefined
      ? { statusCode: error.statusCode }
      : {}),
  };
}
