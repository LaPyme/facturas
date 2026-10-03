import {
  ArcaAuthenticationError,
  type ArcaAuthenticationReason,
  ArcaServiceError,
  ArcaSoapFaultError,
  isArcaAuthenticationError,
} from "../errors";
import type {
  ArcaAuthenticationEvidence,
  ArcaFiscalIssue,
} from "../services/fiscal-evidence";
import type { ArcaServiceName } from "./types";

type AuthenticationContext = {
  service: ArcaServiceName;
  operation: string;
};

type AuthenticationCandidate = AuthenticationContext & {
  providerCode?: string | number;
  message?: string;
  cause?: unknown;
};

type AuthenticationRecoveryOptions<T> = AuthenticationContext & {
  forceRefresh?: boolean;
  allowRetry?: boolean;
  execute(forceRefresh?: boolean): Promise<T>;
};

const WSFE_AUTHENTICATION_CODES: Readonly<
  Record<string, ArcaAuthenticationReason>
> = {
  "600": "invalid_token",
  "601": "missing_relationship",
};

// WSFEX answers every operation's token check with 1000 and a CUIT outside the
// ticket's represented taxpayers with 1001.
const WSFEX_AUTHENTICATION_CODES: Readonly<
  Record<string, ArcaAuthenticationReason>
> = {
  "1000": "invalid_token",
  "1001": "missing_relationship",
};

const STRUCTURED_AUTHENTICATION_CODES: Partial<
  Record<ArcaServiceName, Readonly<Record<string, ArcaAuthenticationReason>>>
> = {
  wsfe: WSFE_AUTHENTICATION_CODES,
  wsfex: WSFEX_AUTHENTICATION_CODES,
};

/** Classifies one safe provider code/message pair without inspecting object graphs. */
export function classifyArcaAuthenticationCandidate(
  candidate: AuthenticationCandidate
): ArcaAuthenticationError | undefined {
  const providerCode = normalizeProviderCode(candidate.providerCode);
  const reason =
    getStructuredAuthenticationReason(candidate.service, providerCode) ??
    getTextAuthenticationReason(candidate.message);

  if (!reason) {
    return undefined;
  }

  return new ArcaAuthenticationError(
    formatAuthenticationMessage(candidate.service, candidate.operation, reason),
    {
      reason,
      service: candidate.service,
      operation: candidate.operation,
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(candidate.cause === undefined ? {} : { cause: candidate.cause }),
    }
  );
}

/** Classifies supported public ARCA errors while ignoring arbitrary errors and causes. */
export function classifyArcaAuthenticationError(
  error: unknown,
  context: AuthenticationContext
): ArcaAuthenticationError | undefined {
  if (isArcaAuthenticationError(error)) {
    return error;
  }

  if (error instanceof ArcaSoapFaultError) {
    return classifyArcaAuthenticationCandidate({
      ...context,
      providerCode: error.faultCode,
      message: error.message,
      cause: error,
    });
  }

  if (error instanceof ArcaServiceError) {
    const issueError = classifyArcaAuthenticationIssues(
      error.issues ?? [],
      context
    );
    if (issueError) {
      return new ArcaAuthenticationError(issueError.message, {
        reason: issueError.reason,
        service: issueError.service,
        operation: issueError.operation,
        ...(issueError.providerCode === undefined
          ? {}
          : { providerCode: issueError.providerCode }),
        cause: error,
      });
    }

    return classifyArcaAuthenticationCandidate({
      ...context,
      providerCode: error.serviceCode,
      message: error.message,
      cause: error,
    });
  }

  return undefined;
}

/** Classifies structured service issues in provider order. */
export function classifyArcaAuthenticationIssues(
  issues: readonly ArcaFiscalIssue[],
  context: AuthenticationContext
): ArcaAuthenticationError | undefined {
  for (const issue of issues) {
    const authenticationError = classifyArcaAuthenticationCandidate({
      ...context,
      providerCode: issue.code,
      message: issue.message,
    });
    if (authenticationError) {
      return authenticationError;
    }
  }
  return undefined;
}

/** Converts the public error to safe serializable exact-attempt evidence. */
export function createArcaAuthenticationEvidence(
  error: ArcaAuthenticationError
): ArcaAuthenticationEvidence {
  return {
    code: "ARCA_AUTHENTICATION_ERROR",
    reason: error.reason,
    ...(error.providerCode === undefined
      ? {}
      : { providerCode: error.providerCode }),
  };
}

/** Recreates the throwable contract from safe exact-attempt evidence. */
export function createArcaAuthenticationErrorFromEvidence(
  evidence: ArcaAuthenticationEvidence,
  context: AuthenticationContext
): ArcaAuthenticationError {
  return new ArcaAuthenticationError(
    formatAuthenticationMessage(
      context.service,
      context.operation,
      evidence.reason
    ),
    {
      reason: evidence.reason,
      service: context.service,
      operation: context.operation,
      ...(evidence.providerCode === undefined
        ? {}
        : { providerCode: evidence.providerCode }),
    }
  );
}

/** Runs one convenience operation and permits one proven-safe forced refresh. */
export async function executeWithAuthenticationRecovery<T>(
  options: AuthenticationRecoveryOptions<T>
): Promise<T> {
  const executeAttempt = async (forceRefresh?: boolean): Promise<T> => {
    try {
      return await options.execute(forceRefresh);
    } catch (error) {
      throw classifyArcaAuthenticationError(error, options) ?? error;
    }
  };

  try {
    return await executeAttempt(options.forceRefresh);
  } catch (error) {
    const allowRetry =
      options.allowRetry !== false && options.forceRefresh !== true;
    if (!(allowRetry && isArcaAuthenticationError(error))) {
      throw error;
    }
    return executeAttempt(true);
  }
}

function getStructuredAuthenticationReason(
  service: ArcaServiceName,
  providerCode: string | number | undefined
): ArcaAuthenticationReason | undefined {
  const codes = STRUCTURED_AUTHENTICATION_CODES[service];
  if (!codes || providerCode === undefined) {
    return undefined;
  }
  return codes[String(providerCode).trim()];
}

function getTextAuthenticationReason(
  message: string | undefined
): ArcaAuthenticationReason | undefined {
  if (!message) {
    return undefined;
  }
  const normalized = normalizeAuthenticationText(message);

  if (
    includesWholePhrase(
      normalized,
      "no aparecio cuit en lista de relaciones"
    ) ||
    includesWholePhrase(normalized, "cuit representada no incluida en token")
  ) {
    return "missing_relationship";
  }
  if (includesWholePhrase(normalized, "computador no autorizado")) {
    return "unauthorized_computer";
  }
  if (
    includesWholePhrase(normalized, "validaciondetoken") ||
    includesWholePhrase(normalized, "token vencido") ||
    includesWholePhrase(normalized, "no se corresponden token y firma")
  ) {
    return "invalid_token";
  }
  if (
    includesWholePhrase(normalized, "no autorizado a acceder al servicio") ||
    includesWholePhrase(normalized, "no autorizado a acceder a los servicios")
  ) {
    return "authentication_rejected";
  }
  return undefined;
}

function normalizeAuthenticationText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesWholePhrase(value: string, phrase: string): boolean {
  let searchFrom = 0;
  while (searchFrom <= value.length - phrase.length) {
    const index = value.indexOf(phrase, searchFrom);
    if (index < 0) {
      return false;
    }
    const before = value[index - 1];
    const after = value[index + phrase.length];
    if (!(isWordCharacter(before) || isWordCharacter(after))) {
      return true;
    }
    searchFrom = index + phrase.length;
  }
  return false;
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9]/.test(value);
}

function normalizeProviderCode(
  providerCode: string | number | undefined
): string | number | undefined {
  if (typeof providerCode === "number") {
    return Number.isFinite(providerCode) ? providerCode : undefined;
  }
  if (typeof providerCode === "string") {
    const normalized = providerCode.trim();
    return normalized || undefined;
  }
  return undefined;
}

function formatAuthenticationMessage(
  service: ArcaServiceName,
  operation: string,
  reason: ArcaAuthenticationReason
): string {
  const descriptions: Record<ArcaAuthenticationReason, string> = {
    invalid_token: "the token or signature was rejected",
    unauthorized_computer: "the certificate or computer is not authorized",
    missing_relationship: "the represented taxpayer relationship is missing",
    authentication_rejected: "the service denied authenticated access",
  };
  return `ARCA rejected authentication for ${service}.${operation}: ${descriptions[reason]}.`;
}
