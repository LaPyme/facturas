import { ArcaConfigurationError } from "./errors";
import type {
  ArcaClientConfig,
  ArcaClientOptions,
  ArcaEnvironment,
  ArcaLogLevel,
  ArcaServiceName,
  ArcaSoapVersion,
} from "./internal/types";

/** Valid ARCA environment names. */
export const ARCA_ENVIRONMENTS = ["production", "test"] as const;

/** Default environment variable names read by {@link createArcaClientConfigFromEnv}. */
export const ARCA_ENV_VARIABLES = {
  taxId: "ARCA_TAX_ID",
  certificatePem: "ARCA_CERTIFICATE_PEM",
  privateKeyPem: "ARCA_PRIVATE_KEY_PEM",
  environment: "ARCA_ENVIRONMENT",
} as const;

type ArcaClientConfigEnvironment = Record<string, string | undefined>;
/** Options for {@link createArcaClientConfigFromEnv}. */
export type CreateArcaClientConfigFromEnvOptions = {
  env?: ArcaClientConfigEnvironment;
  defaultEnvironment?: ArcaEnvironment;
  variableNames?: Partial<typeof ARCA_ENV_VARIABLES>;
};

const PRIVATE_KEY_PEM_PREFIXES = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
] as const;
const ENCRYPTED_PRIVATE_KEY_PEM_PREFIX =
  "-----BEGIN ENCRYPTED PRIVATE KEY-----";
const LEGACY_ENCRYPTED_RSA_PRIVATE_KEY_PATTERN =
  /^-----BEGIN RSA PRIVATE KEY-----[\s\S]*^Proc-Type:\s*4,\s*ENCRYPTED\s*$/m;
const VALID_ARCA_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const DEFAULT_ARCA_TIMEOUT_MS = 30_000;
const DEFAULT_ARCA_RETRIES = 0;
const DEFAULT_ARCA_RETRY_DELAY_MS = 500;

/** Returns `"production"` or `"test"` based on the boolean flag. */
export function resolveArcaEnvironment(production: boolean): ArcaEnvironment {
  return production ? "production" : "test";
}

/**
 * Builds an {@link ArcaClientConfig} from environment variables.
 * Reads `process.env` by default; override with `options.env`.
 *
 * @throws {ArcaConfigurationError} When required variables are missing or invalid.
 */
export function createArcaClientConfigFromEnv(
  options: CreateArcaClientConfigFromEnvOptions = {}
): ArcaClientConfig {
  const env = options.env ?? process.env;
  const variableNames = {
    ...ARCA_ENV_VARIABLES,
    ...options.variableNames,
  };
  const environmentInput = readEnv(env, variableNames.environment);
  const environmentValue = normalizeEnvironmentValue(environmentInput);

  const config: ArcaClientConfig = {
    taxId: readEnv(env, variableNames.taxId) ?? "",
    certificatePem: readEnv(env, variableNames.certificatePem) ?? "",
    privateKeyPem: readEnv(env, variableNames.privateKeyPem) ?? "",
    environment:
      environmentValue ??
      (environmentInput as ArcaEnvironment | undefined) ??
      options.defaultEnvironment ??
      "test",
  };

  assertArcaClientConfig(config);
  return normalizeArcaClientConfig(config);
}

/**
 * Validates an {@link ArcaClientConfig} and throws if any field is invalid.
 *
 * @throws {ArcaConfigurationError} With a list of invalid field names.
 */
export function assertArcaClientConfig(config: ArcaClientConfig): void {
  const invalidFields: string[] = [];
  const normalized = normalizeArcaClientConfig(config);
  const timeout = normalized.timeout ?? DEFAULT_ARCA_TIMEOUT_MS;
  const retries = normalized.retries ?? DEFAULT_ARCA_RETRIES;
  const retryDelay = normalized.retryDelay ?? DEFAULT_ARCA_RETRY_DELAY_MS;

  if (
    normalized.privateKeyPem.startsWith(ENCRYPTED_PRIVATE_KEY_PEM_PREFIX) ||
    LEGACY_ENCRYPTED_RSA_PRIVATE_KEY_PATTERN.test(normalized.privateKeyPem)
  ) {
    throw new ArcaConfigurationError(
      "Encrypted private keys are not supported. Provide an unencrypted PKCS#8 or RSA private key PEM."
    );
  }

  invalidFields.push(...invalidCredentialFields(normalized));

  if (!ARCA_ENVIRONMENTS.includes(normalized.environment)) {
    invalidFields.push("environment");
  }

  if (!Number.isFinite(timeout) || timeout <= 0) {
    invalidFields.push("timeout");
  }

  if (!Number.isInteger(retries) || retries < 0) {
    invalidFields.push("retries");
  }

  if (!Number.isFinite(retryDelay) || retryDelay < 0) {
    invalidFields.push("retryDelay");
  }

  const loggerLevel = normalized.logger?.level;
  if (
    loggerLevel !== undefined &&
    !VALID_ARCA_LOG_LEVELS.includes(loggerLevel)
  ) {
    invalidFields.push("logger.level");
  }

  if (
    normalized.logger?.log !== undefined &&
    typeof normalized.logger.log !== "function"
  ) {
    invalidFields.push("logger.log");
  }

  invalidFields.push(...getInvalidWsaaSessionStoreFields(normalized));

  if (invalidFields.length > 0) {
    throw new ArcaConfigurationError(
      `Missing or invalid ARCA client config fields: ${invalidFields.join(", ")}`
    );
  }
}

function getInvalidWsaaSessionStoreFields(config: ArcaClientConfig): string[] {
  const store = config.wsaaSessionStore;
  if (store === undefined) {
    return [];
  }

  const invalidFields: string[] = [];
  if (typeof store.get !== "function") {
    invalidFields.push("wsaaSessionStore.get");
  }
  if (typeof store.set !== "function") {
    invalidFields.push("wsaaSessionStore.set");
  }
  if (store.delete !== undefined && typeof store.delete !== "function") {
    invalidFields.push("wsaaSessionStore.delete");
  }
  if (store.withLock !== undefined && typeof store.withLock !== "function") {
    invalidFields.push("wsaaSessionStore.withLock");
  }

  return invalidFields;
}

export type ArcaServiceConfig = {
  namespace: string;
  endpoint: Record<ArcaEnvironment, string>;
  soapVersion: ArcaSoapVersion;
  soapActionBase: string;
  usesEmptySoapAction?: boolean;
  useLegacyTlsSecurityLevel0?: boolean;
};

export const ARCA_WSAA_CONFIG: ArcaServiceConfig = {
  namespace: "http://wsaa.view.sua.dvadac.desein.afip.gov",
  endpoint: {
    production: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    test: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  },
  soapVersion: "1.1",
  soapActionBase: "",
  usesEmptySoapAction: true,
};

export const ARCA_SERVICE_CONFIG: Record<ArcaServiceName, ArcaServiceConfig> = {
  wsaa: ARCA_WSAA_CONFIG,
  wsfe: {
    namespace: "http://ar.gov.afip.dif.FEV1/",
    endpoint: {
      production: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
      test: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
    },
    soapVersion: "1.2",
    soapActionBase: "http://ar.gov.afip.dif.FEV1/",
    useLegacyTlsSecurityLevel0: true,
  },
  wsmtxca: {
    namespace: "http://impl.service.wsmtxca.afip.gov.ar/service/",
    endpoint: {
      production:
        "https://serviciosjava.afip.gov.ar/wsmtxca/services/MTXCAService",
      test: "https://fwshomo.afip.gov.ar/wsmtxca/services/MTXCAService",
    },
    soapVersion: "1.1",
    soapActionBase: "http://impl.service.wsmtxca.afip.gov.ar/service/",
  },
  "padron-a5": {
    namespace: "http://a5.soap.ws.server.puc.sr/",
    endpoint: {
      production:
        "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
      test: "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5",
    },
    soapVersion: "1.1",
    soapActionBase: "",
    usesEmptySoapAction: true,
  },
  "padron-a13": {
    namespace: "http://a13.soap.ws.server.puc.sr/",
    endpoint: {
      production:
        "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13",
      test: "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13",
    },
    soapVersion: "1.1",
    soapActionBase: "",
    usesEmptySoapAction: true,
  },
};

export function getArcaServiceConfig(
  service: ArcaServiceName
): ArcaServiceConfig {
  const serviceConfig = ARCA_SERVICE_CONFIG[service];
  if (!serviceConfig) {
    throw new ArcaConfigurationError(
      `Unsupported ARCA service configuration: ${service}`
    );
  }
  return serviceConfig;
}

export function normalizeArcaClientConfig(
  config: ArcaClientConfig
): ResolvedArcaClientConfig {
  const normalizedEnvironment =
    normalizeEnvironmentValue(String(config.environment)) ?? config.environment;
  const normalizedLoggerLevel = normalizeLogLevelValue(config.logger?.level);

  return {
    taxId: config.taxId?.trim() ?? "",
    certificatePem: config.certificatePem?.trim() ?? "",
    privateKeyPem: config.privateKeyPem?.trim() ?? "",
    environment: normalizedEnvironment ?? "test",
    ...(config.store === undefined ? {} : { store: config.store }),
    timeout: config.timeout ?? DEFAULT_ARCA_TIMEOUT_MS,
    retries: config.retries ?? DEFAULT_ARCA_RETRIES,
    retryDelay: config.retryDelay ?? DEFAULT_ARCA_RETRY_DELAY_MS,
    ...(config.logger === undefined
      ? {}
      : {
          logger: {
            ...config.logger,
            ...(normalizedLoggerLevel === undefined
              ? {}
              : { level: normalizedLoggerLevel }),
          },
        }),
    ...(config.wsaaSessionStore === undefined
      ? {}
      : { wsaaSessionStore: config.wsaaSessionStore }),
  };
}

function normalizeEnvironmentValue(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (ARCA_ENVIRONMENTS.includes(normalized as ArcaEnvironment)) {
    return normalized as ArcaEnvironment;
  }

  return undefined;
}

function readEnv(
  env: ArcaClientConfigEnvironment,
  variableName: string
): string | undefined {
  return env[variableName]?.trim() || undefined;
}

function normalizeLogLevelValue(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (VALID_ARCA_LOG_LEVELS.includes(normalized as ArcaLogLevel)) {
    return normalized as ArcaLogLevel;
  }

  return value as ArcaLogLevel;
}

export type ResolvedArcaClientConfig = ArcaClientConfig & {
  taxId: string;
  certificatePem: string;
  privateKeyPem: string;
  environment: ArcaEnvironment;
};

export function discoverArcaClientConfig(
  config: ArcaClientOptions
): ArcaClientConfig {
  return {
    ...config,
    taxId: config.taxId ?? readEnv(process.env, ARCA_ENV_VARIABLES.taxId) ?? "",
    certificatePem:
      config.certificatePem ??
      readEnv(process.env, ARCA_ENV_VARIABLES.certificatePem) ??
      "",
    privateKeyPem:
      config.privateKeyPem ??
      readEnv(process.env, ARCA_ENV_VARIABLES.privateKeyPem) ??
      "",
    environment:
      config.environment ??
      (readEnv(process.env, ARCA_ENV_VARIABLES.environment) as
        | ArcaEnvironment
        | undefined) ??
      "test",
  };
}

function invalidCredentialFields(
  normalized: ResolvedArcaClientConfig
): string[] {
  const invalidFields: string[] = [];
  if (!/^\d{11}$/.test(normalized.taxId)) {
    invalidFields.push(normalized.taxId ? "taxId" : "taxId (ARCA_TAX_ID)");
  }

  if (!normalized.certificatePem.startsWith("-----BEGIN CERTIFICATE-----")) {
    invalidFields.push(
      normalized.certificatePem
        ? "certificatePem"
        : "certificatePem (ARCA_CERTIFICATE_PEM)"
    );
  }

  if (
    !PRIVATE_KEY_PEM_PREFIXES.some((prefix) =>
      normalized.privateKeyPem.startsWith(prefix)
    )
  ) {
    invalidFields.push(
      normalized.privateKeyPem
        ? "privateKeyPem"
        : "privateKeyPem (ARCA_PRIVATE_KEY_PEM)"
    );
  }

  return invalidFields;
}
