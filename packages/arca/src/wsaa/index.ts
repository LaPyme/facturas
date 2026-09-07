import { createHash } from "node:crypto";
import forge from "node-forge";
import { ARCA_WSAA_CONFIG } from "../config";
import {
  ArcaConfigurationError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";
import { abortable } from "../internal/abort";
import { postXmlWithMetadata } from "../internal/http";
import type { ArcaLogger } from "../internal/logger";
import { createSafeErrorDiagnostic } from "../internal/redaction";
import type {
  ArcaAuthCredentials,
  ArcaAuthOptions,
  ArcaClientConfig,
  ArcaWsaaServiceId,
  ArcaWsaaSessionKey,
} from "../internal/types";
import {
  buildSoapEnvelope,
  getSingleBodyEntry,
  parseSoapBody,
  parseXmlDocument,
} from "../internal/xml";
import {
  isWsaaCredentialValid,
  serializeWsaaSessionKey,
} from "./session-store";

export type WsaaAuthModule = {
  login(
    service: ArcaWsaaServiceId,
    options?: ArcaAuthOptions
  ): Promise<ArcaAuthCredentials>;
};

export type CreateWsaaAuthModuleOptions = {
  config: ArcaClientConfig;
  logger?: ArcaLogger;
};

type ForgeSignerOptions = Parameters<
  forge.pkcs7.PkcsSignedData["addSigner"]
>[0];
type ForgeAuthenticatedAttribute = NonNullable<
  ForgeSignerOptions["authenticatedAttributes"]
>[number];
type WsaaAuthenticatedAttribute = Omit<ForgeAuthenticatedAttribute, "value"> & {
  value?: string | Date;
};

export function createWsaaAuthModule(
  options: CreateWsaaAuthModuleOptions
): WsaaAuthModule {
  const cache = new Map<string, ArcaAuthCredentials>();
  const ordinaryInFlight = new Map<string, Promise<ArcaAuthCredentials>>();
  const forcedInFlight = new Map<string, Promise<ArcaAuthCredentials>>();

  function trackLogin(
    target: Map<string, Promise<ArcaAuthCredentials>>,
    cacheKey: string,
    login: () => Promise<ArcaAuthCredentials>
  ): Promise<ArcaAuthCredentials> {
    const promise = login();
    target.set(cacheKey, promise);
    const cleanup = () => {
      if (target.get(cacheKey) === promise) {
        target.delete(cacheKey);
      }
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function requestOrReuseWsaaCredentials(
    service: ArcaWsaaServiceId,
    sessionKey: ArcaWsaaSessionKey,
    cacheKey: string,
    forceRefresh: boolean
  ): Promise<ArcaAuthCredentials> {
    const reuse = await getReusableCredentials({
      config: options.config,
      cache,
      cacheKey,
      sessionKey,
      logger: options.logger,
      service,
      allowStore: !forceRefresh,
      allowCache: !forceRefresh,
    });
    if (reuse) {
      return reuse;
    }

    const refresh = () =>
      refreshWsaaCredentials({
        config: options.config,
        cache,
        cacheKey,
        sessionKey,
        logger: options.logger,
        service,
        forceRefresh,
      });

    if (options.config.wsaaSessionStore?.withLock) {
      return await withWsaaSessionStoreLock(
        options.config,
        sessionKey,
        service,
        refresh
      );
    }

    return await refresh();
  }

  async function performLogin(
    service: ArcaWsaaServiceId,
    sessionKey: ArcaWsaaSessionKey,
    cacheKey: string,
    forceRefresh: boolean
  ): Promise<ArcaAuthCredentials> {
    try {
      return await requestOrReuseWsaaCredentials(
        service,
        sessionKey,
        cacheKey,
        forceRefresh
      );
    } catch (error) {
      if (
        error instanceof ArcaSoapFaultError &&
        error.faultCode === "ns1:coe.alreadyAuthenticated"
      ) {
        const recovered = await getReusableCredentials({
          config: options.config,
          cache,
          cacheKey,
          sessionKey,
          logger: options.logger,
          service,
          allowStore: true,
          allowCache: true,
        });
        if (recovered) {
          options.logger?.warn(
            "Recovered WSAA coe.alreadyAuthenticated fault",
            {
              service,
              faultCode: error.faultCode,
            }
          );
          return recovered;
        }

        if (!options.config.wsaaSessionStore) {
          throw new ArcaConfigurationError(
            "WSAA login failed because another process likely owns a valid TA. Configure a durable wsaaSessionStore for multi-process or serverless deployments.",
            { cause: error }
          );
        }
      }

      if (error instanceof ArcaSoapFaultError) {
        options.logger?.error("WSAA SOAP fault response", {
          service,
          operation: "loginCms",
          url: ARCA_WSAA_CONFIG.endpoint[options.config.environment],
          ...createSafeErrorDiagnostic(error),
        });
      }

      throw error;
    }
  }

  return {
    login(service, authOptions = {}) {
      // A deduplicated login is shared: the caller stops waiting on its own
      // deadline, and the request keeps running for the other waiters.
      return abortable(runLogin(service, authOptions), authOptions.signal);
    },
  };

  function runLogin(
    service: ArcaWsaaServiceId,
    authOptions: ArcaAuthOptions
  ): Promise<ArcaAuthCredentials> {
    const sessionKey = buildWsaaSessionKey(options.config, service);
    const cacheKey = serializeWsaaSessionKey(sessionKey);

    if (authOptions.forceRefresh) {
      const runningForced = forcedInFlight.get(cacheKey);
      if (runningForced) {
        return runningForced;
      }

      const runningOrdinary = ordinaryInFlight.get(cacheKey);
      return trackLogin(forcedInFlight, cacheKey, async () => {
        await runningOrdinary?.catch(() => undefined);
        return await performLogin(service, sessionKey, cacheKey, true);
      });
    }

    const runningOrdinary = ordinaryInFlight.get(cacheKey);
    if (runningOrdinary) {
      return runningOrdinary;
    }

    const runningForced = forcedInFlight.get(cacheKey);
    if (runningForced) {
      return runningForced;
    }

    return trackLogin(ordinaryInFlight, cacheKey, () =>
      performLogin(service, sessionKey, cacheKey, false)
    );
  }
}

async function requestCredentials(
  config: ArcaClientConfig,
  service: ArcaWsaaServiceId,
  options?: {
    logger?: ArcaLogger;
  }
): Promise<ArcaAuthCredentials> {
  const loginTicketRequestXml = buildLoginTicketRequest(service);
  const signedCms = signLoginTicketRequest(loginTicketRequestXml, {
    certificatePem: config.certificatePem,
    privateKeyPem: config.privateKeyPem,
  });

  const requestXml = buildSoapEnvelope(
    ARCA_WSAA_CONFIG.soapVersion,
    "loginCms",
    ARCA_WSAA_CONFIG.namespace,
    { in0: signedCms }
  );

  const url = ARCA_WSAA_CONFIG.endpoint[config.environment];
  const response = await postXmlWithMetadata({
    url: ARCA_WSAA_CONFIG.endpoint[config.environment],
    body: requestXml,
    contentType: 'text/xml; charset="utf-8"',
    soapAction: ARCA_WSAA_CONFIG.soapActionBase,
    timeout: config.timeout,
    retries: config.retries,
    retryDelay: config.retryDelay,
    logger: options?.logger,
    service: "wsaa",
    operation: "loginCms",
  });
  const parseContext = {
    service: "wsaa" as const,
    operation: "loginCms",
    endpointUrl: url,
    statusCode: response.statusCode,
    contentType: response.contentType,
    responseBody: response.body,
  };

  const soapBody = parseSoapBody(response.body, parseContext);
  const [, responseBody] = getSingleBodyEntry<Record<string, unknown>>(
    soapBody,
    parseContext
  );
  const loginCmsReturn = responseBody.loginCmsReturn;

  if (typeof loginCmsReturn !== "string" || loginCmsReturn.trim().length < 1) {
    throw new ArcaTransportError(
      "WSAA response did not include loginCmsReturn XML"
    );
  }

  return parseLoginTicketResponse(loginCmsReturn);
}

function buildWsaaSessionKey(
  config: ArcaClientConfig,
  service: ArcaWsaaServiceId
): ArcaWsaaSessionKey {
  return {
    environment: config.environment,
    service,
    certificateFingerprint: getCertificateFingerprint(config),
  };
}

function getCertificateFingerprint(config: ArcaClientConfig): string {
  return createHash("sha256").update(config.certificatePem).digest("hex");
}

function getCachedCredentials(
  cache: Map<string, ArcaAuthCredentials>,
  cacheKey: string
): ArcaAuthCredentials | null {
  const localCached = cache.get(cacheKey);
  if (localCached && isWsaaCredentialValid(localCached)) {
    return localCached;
  }

  return null;
}

async function getReusableCredentials(options: {
  config: ArcaClientConfig;
  cache: Map<string, ArcaAuthCredentials>;
  cacheKey: string;
  sessionKey: ArcaWsaaSessionKey;
  logger?: ArcaLogger;
  service: ArcaWsaaServiceId;
  allowStore: boolean;
  allowCache: boolean;
}): Promise<ArcaAuthCredentials | null> {
  if (options.allowCache) {
    const cached = getCachedCredentials(options.cache, options.cacheKey);
    if (cached) {
      options.logger?.debug("Attempting WSAA login", {
        service: options.service,
        source: "cached",
      });
      return cached;
    }
  }

  if (!(options.allowStore && options.config.wsaaSessionStore)) {
    return null;
  }

  const stored = await getStoredCredentials(
    options.config,
    options.sessionKey,
    options.service
  );
  if (!stored) {
    return null;
  }

  options.cache.set(options.cacheKey, stored);
  options.logger?.debug("Attempting WSAA login", {
    service: options.service,
    source: "store",
  });
  return stored;
}

async function refreshWsaaCredentials(options: {
  config: ArcaClientConfig;
  cache: Map<string, ArcaAuthCredentials>;
  cacheKey: string;
  sessionKey: ArcaWsaaSessionKey;
  logger?: ArcaLogger;
  service: ArcaWsaaServiceId;
  forceRefresh: boolean;
}): Promise<ArcaAuthCredentials> {
  if (!options.forceRefresh) {
    const reuse = await getReusableCredentials({
      config: options.config,
      cache: options.cache,
      cacheKey: options.cacheKey,
      sessionKey: options.sessionKey,
      logger: options.logger,
      service: options.service,
      allowStore: true,
      allowCache: true,
    });
    if (reuse) {
      return reuse;
    }
  }

  options.logger?.debug("Attempting WSAA login", {
    service: options.service,
    source: "fresh",
  });

  const credentials = await requestCredentials(
    options.config,
    options.service,
    {
      logger: options.logger,
    }
  );
  options.logger?.info("WSAA login succeeded", {
    service: options.service,
    expiresAt: credentials.expiresAt,
  });
  options.cache.set(options.cacheKey, credentials);
  await setStoredCredentials(options.config, options.sessionKey, credentials);
  return credentials;
}

async function getStoredCredentials(
  config: ArcaClientConfig,
  key: ArcaWsaaSessionKey,
  service: ArcaWsaaServiceId
): Promise<ArcaAuthCredentials | null> {
  if (!config.wsaaSessionStore) {
    return null;
  }

  try {
    const credentials = await config.wsaaSessionStore.get(key);
    if (!(credentials && isWsaaCredentialValid(credentials))) {
      return null;
    }

    return credentials;
  } catch (error) {
    throw new ArcaConfigurationError(
      `WSAA session store get failed for service ${service}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

async function setStoredCredentials(
  config: ArcaClientConfig,
  key: ArcaWsaaSessionKey,
  credentials: ArcaAuthCredentials
): Promise<void> {
  if (!config.wsaaSessionStore) {
    return;
  }

  try {
    await config.wsaaSessionStore.set(key, credentials);
  } catch (error) {
    throw new ArcaConfigurationError(
      `WSAA session store set failed for service ${key.service}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

async function withWsaaSessionStoreLock<T>(
  config: ArcaClientConfig,
  key: ArcaWsaaSessionKey,
  service: ArcaWsaaServiceId,
  fn: () => Promise<T>
): Promise<T> {
  const store = config.wsaaSessionStore;
  if (!store?.withLock) {
    return await fn();
  }

  let entered = false;
  try {
    return await store.withLock(key, async () => {
      entered = true;
      return await fn();
    });
  } catch (error) {
    if (entered) {
      throw error;
    }

    if (error instanceof ArcaConfigurationError) {
      throw error;
    }

    throw new ArcaConfigurationError(
      `WSAA session store lock failed for service ${service}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

function buildLoginTicketRequest(service: ArcaWsaaServiceId): string {
  const uniqueId = Math.floor(Date.now() / 1000);
  const generationTime = new Date(Date.now() - 5 * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  const expirationTime = new Date(Date.now() + 5 * 60_000)
    .toISOString()
    .replace(".000Z", "Z");

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generationTime}</generationTime>
    <expirationTime>${expirationTime}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

function signLoginTicketRequest(
  loginTicketRequestXml: string,
  options: Pick<ArcaClientConfig, "certificatePem" | "privateKeyPem">
): string {
  const certificate = forge.pki.certificateFromPem(options.certificatePem);
  const privateKey = forge.pki.privateKeyFromPem(options.privateKeyPem);
  const signedData = forge.pkcs7.createSignedData();

  signedData.content = forge.util.createBuffer(loginTicketRequestXml, "utf8");
  signedData.addCertificate(certificate);
  const authenticatedAttributes: WsaaAuthenticatedAttribute[] = [
    {
      type: String(forge.pki.oids.contentType),
      value: String(forge.pki.oids.data),
    },
    {
      type: String(forge.pki.oids.messageDigest),
    },
    {
      type: String(forge.pki.oids.signingTime),
      value: new Date(),
    },
  ];

  const signerOptions: ForgeSignerOptions = {
    key: privateKey,
    certificate,
    digestAlgorithm: String(forge.pki.oids.sha1),
    authenticatedAttributes:
      authenticatedAttributes as unknown as ForgeSignerOptions["authenticatedAttributes"],
  };

  signedData.addSigner(signerOptions);
  signedData.sign();

  const der = forge.asn1.toDer(signedData.toAsn1()).getBytes();
  return Buffer.from(der, "binary").toString("base64");
}

function parseLoginTicketResponse(xml: string): ArcaAuthCredentials {
  const parsed = parseXmlDocument<Record<string, unknown>>(xml);
  const response =
    (parsed.loginTicketResponse as Record<string, unknown> | undefined) ??
    parsed;
  const header = response.header as Record<string, unknown> | undefined;
  const credentials = response.credentials as
    | Record<string, unknown>
    | undefined;
  const token = credentials?.token;
  const sign = credentials?.sign;
  const expiresAt = header?.expirationTime;

  if (
    typeof token !== "string" ||
    typeof sign !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new ArcaTransportError(
      "Invalid WSAA login ticket response structure"
    );
  }

  return {
    token,
    sign,
    expiresAt,
  };
}
