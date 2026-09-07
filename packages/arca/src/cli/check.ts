import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ArcaClient } from "../client";
import {
  ARCA_WSAA_CONFIG,
  assertArcaClientConfig,
  discoverArcaClientConfig,
} from "../config";
import {
  ArcaConfigurationError,
  ArcaServiceError,
  ArcaSoapFaultError,
  isArcaAuthenticationError,
} from "../errors";
import type {
  ArcaAuthCredentials,
  ArcaClientConfig,
  ArcaEnvironment,
  ArcaWsaaSessionStore,
} from "../internal/types";
import type { WsfeSalesPoint } from "../services/wsfe";
import { createFileStore } from "../store/file";
import { createWsaaStoreAdapter } from "../wsaa/store-adapter";
import { privateKeyMatchesCertificate, readCertificateFacts } from "./csr";
import { describeTaxIdProblem, normalizeTaxId, TAX_ID_FIX } from "./cuit";
import {
  type CliDiagnosis,
  describeUnknownError,
  diagnose,
  diagnoseAuthenticationReason,
  diagnoseWsaaFaultCode,
  findSoapFault,
  findTransportError,
} from "./diagnose";
import {
  type CredentialDiscovery,
  type DiscoveredCredentials,
  discoverCredentials,
} from "./discover";
import { CLI_EXIT, type CliIo, type CliWriter } from "./output";

const EXPIRY_WARNING_DAYS = 30;
const EMPTY_IN_TEST_WARNING =
  "en homologación ARCA suele no informarlos; probá igual con issue";
const MILLISECONDS_PER_DAY = 86_400_000;

/** The five layers, in the order ARCA breaks them. */
export type CliLayerName =
  | "config"
  | "certificate"
  | "wsaa"
  | "wsfe"
  | "salesPoints";

const LAYER_LABELS: Record<CliLayerName, string> = {
  config: "configuración",
  certificate: "certificado y clave",
  wsaa: "WSAA",
  wsfe: "WSFE",
  salesPoints: "puntos de venta",
};

export type CliLayerReport = {
  name: CliLayerName;
  ok: boolean;
  detail?: string;
  expiresAt?: string;
  code?: string;
  reason?: string;
  diagnosis?: string;
  fix?: string;
  warning?: string;
};

export type CliSalesPointReport = {
  number: number;
  blocked: boolean;
  system?: string;
};

/** The whole `check` result. Layers never reached are absent, not false. */
export type CliCheckReport = {
  ok: boolean;
  environment?: ArcaEnvironment;
  taxId?: string;
  layers: CliLayerReport[];
  salesPoints?: CliSalesPointReport[];
};

export type CheckFlags = {
  cert?: string;
  key?: string;
  taxId?: string;
  env?: string;
  /** Where to look for `arca-<entorno>.crt` and `.key`. Defaults to the cwd. */
  dir?: string;
  salesPoint?: number;
  /** Skips the ticket cache: one forced login, kept in memory only. */
  noCache?: boolean;
};

/**
 * WSFE's `PtoVta` is an integer from 1 to 99999. Anything a number only starts
 * with —`3foo`, `3.5`, `1e2`— is a typo, not a sales point: parsing it would
 * silently work on a different one than the person typed.
 */
const SALES_POINT_MIN = 1;
const SALES_POINT_MAX = 99_999;

/** The sales point a string names, or `undefined` when it names none. */
export function parseSalesPoint(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return parsed >= SALES_POINT_MIN && parsed <= SALES_POINT_MAX
    ? parsed
    : undefined;
}

/** Why that string is not a sales point, in the words the CLI uses. */
export function describeSalesPointProblem(value: string): string {
  const reason = /^\d+$/.test(value)
    ? `Tiene que estar entre ${SALES_POINT_MIN} y ${SALES_POINT_MAX}`
    : "Tiene que ser un número entero";
  return `Punto de venta inválido: ${value}. ${reason}, por ejemplo --sales-point 3.`;
}

type TicketCache = {
  sessionStore: ArcaWsaaSessionStore;
  /** True once a stored ticket was handed back instead of a fresh login. */
  wasReused(): boolean;
};

/** The report plus the client the passing layers built, for `issue` to reuse. */
export type CliCheckResult = {
  report: CliCheckReport;
  client?: ArcaClient;
};

/** Runs `check` and prints it. Never writes to ARCA. */
export async function runCheck(
  io: CliIo,
  flags: CheckFlags,
  writer: CliWriter,
  json: boolean
): Promise<number> {
  const { report } = await runCheckLayers(io, flags);
  if (json) {
    writer.json(report);
  } else {
    writeCheckReport(writer, report);
  }
  return report.ok ? CLI_EXIT.ok : CLI_EXIT.failed;
}

/** Runs the layers in order and stops at the first failure. */
export async function runCheckLayers(
  io: CliIo,
  flags: CheckFlags
): Promise<CliCheckResult> {
  const layers: CliLayerReport[] = [];
  const resolved = resolveConfigLayer(io, flags);
  layers.push(resolved.layer);
  if (!(resolved.layer.ok && resolved.config)) {
    return { report: { ok: false, layers } };
  }

  const config = resolved.config;
  const report: CliCheckReport = {
    ok: false,
    environment: config.environment,
    taxId: config.taxId,
    layers,
  };

  const certificate = checkCertificate(config, io.now());
  layers.push(certificate);
  if (!certificate.ok) {
    return { report };
  }

  const cache =
    flags.noCache === true ? undefined : createTicketCache(io.cacheDir);
  const wsaa = await checkWsaa(io, config, cache);
  layers.push(wsaa.layer);
  if (!(wsaa.layer.ok && wsaa.credentials)) {
    return { report };
  }

  // WSFE reuses the ticket layer 3 obtained: a second login would collide with
  // it as coe.alreadyAuthenticated.
  const client = io.createClient({
    ...config,
    wsaaSessionStore:
      cache?.sessionStore ?? createEphemeralSessionStore(wsaa.credentials),
  });
  const wsfe = await checkWsfe(client);
  layers.push(wsfe.layer);
  if (!wsfe.layer.ok) {
    return { report, client };
  }

  const salesPoints = wsfe.salesPoints ?? [];
  report.salesPoints = salesPoints.map(toSalesPointReport);
  const layer = checkSalesPoints(
    report.salesPoints,
    config.environment,
    flags.salesPoint
  );
  layers.push(layer);
  report.ok = layer.ok;
  return { report, client };
}

/** Renders the report the way a shell would: one line per fact. */
export function writeCheckReport(
  writer: CliWriter,
  report: CliCheckReport
): void {
  for (const layer of report.layers) {
    const label = LAYER_LABELS[layer.name];
    if (layer.ok) {
      writer.ok(label, layer.detail);
    } else {
      writer.fail(label);
      if (layer.diagnosis !== undefined) {
        writer.note(layer.diagnosis);
      }
      if (layer.fix !== undefined) {
        writer.note(layer.fix);
      }
    }
    if (layer.name === "salesPoints") {
      for (const point of report.salesPoints ?? []) {
        writer.note(describeSalesPoint(point));
      }
    }
    if (layer.warning !== undefined) {
      writer.warn(label, layer.warning);
    }
  }
}

/**
 * The environment `check` would use, found without touching ARCA: the flag,
 * the variable, or the name of the pair sitting in the directory. `issue` asks
 * first, because it refuses to write anywhere but homologación. `undefined`
 * means nothing said so yet; the layers will name whatever is wrong.
 */
export function resolveCheckEnvironment(
  io: CliIo,
  flags: CheckFlags
): string | undefined {
  const chosen =
    flags.env?.trim().toLowerCase() || io.env.ARCA_ENVIRONMENT?.trim();
  if (chosen) {
    return chosen;
  }
  if (flags.cert?.trim() || io.env.ARCA_CERTIFICATE_PEM?.trim()) {
    return undefined;
  }
  try {
    const discovery = discoverCredentials(resolveDirectory(io, flags.dir));
    return discovery.kind === "found"
      ? discovery.credentials.environment
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where every value came from. Flags win, then the environment variables, then
 * the files `init` left in the directory. The parts the line does not need are
 * absent: when the environment comes from the file name, saying it twice adds
 * nothing.
 */
type ConfigOrigin = {
  credentials?: string;
  taxId: string;
  environment?: string;
};

function resolveConfigLayer(
  io: CliIo,
  flags: CheckFlags
): { layer: CliLayerReport; config?: ArcaClientConfig } {
  const chosenEnvironment =
    flags.env?.trim().toLowerCase() || io.env.ARCA_ENVIRONMENT?.trim();

  let certificatePem: string | undefined;
  let privateKeyPem: string | undefined;
  let discovery: CredentialDiscovery = { kind: "none" };
  try {
    certificatePem = readPem(io, flags.cert, io.env.ARCA_CERTIFICATE_PEM);
    privateKeyPem = readPem(io, flags.key, io.env.ARCA_PRIVATE_KEY_PEM);
    if (!(certificatePem && privateKeyPem)) {
      discovery = discoverCredentials(
        resolveDirectory(io, flags.dir),
        toEnvironment(chosenEnvironment)
      );
    }
  } catch (error) {
    const unknown = describeUnknownError(error);
    return {
      layer: failedLayer(
        "config",
        { diagnosis: unknown.diagnosis },
        unknown.code
      ),
    };
  }

  const failure = describeDiscoveryFailure(discovery);
  if (failure) {
    return { layer: failedLayer("config", failure) };
  }

  const found = discovery.kind === "found" ? discovery.credentials : undefined;
  const certificate = certificatePem || found?.certificatePem;
  const privateKey = privateKeyPem || found?.privateKeyPem;

  const taxId = resolveTaxId(io, flags, certificate);
  if ("layer" in taxId) {
    return { layer: taxId.layer };
  }

  const environment = chosenEnvironment || found?.environment;
  if (!environment) {
    return { layer: failedLayer("config", diagnose("config.environment")) };
  }
  if (!(certificate && privateKey)) {
    return { layer: failedLayer("config", diagnose("config.pem")) };
  }

  try {
    const config = discoverArcaClientConfig({
      taxId: taxId.taxId,
      certificatePem: certificate,
      privateKeyPem: privateKey,
      environment: environment as ArcaEnvironment,
    });
    assertArcaClientConfig(config);
    return {
      layer: {
        name: "config",
        ok: true,
        detail: describeSources({
          ...describeCredentialSource(flags, found),
          taxId: taxId.source,
          ...describeEnvironmentSource(io, flags, config.environment),
        }),
      },
      config,
    };
  } catch (error) {
    return { layer: failedLayer("config", toConfigDiagnosis(error)) };
  }
}

/**
 * The CUIT, in order: the flag, the variable, and last the `serialNumber` ARCA
 * wrote in the certificate. Without any of the three there is nothing to ask
 * ARCA about.
 */
function resolveTaxId(
  io: CliIo,
  flags: CheckFlags,
  certificatePem: string | undefined
): { taxId: string; source: string } | { layer: CliLayerReport } {
  const given = flags.taxId?.trim() || io.env.ARCA_TAX_ID?.trim();
  if (given) {
    const problem = describeTaxIdProblem(given);
    if (problem !== undefined) {
      return {
        layer: failedLayer("config", { diagnosis: problem, fix: TAX_ID_FIX }),
      };
    }
    return {
      taxId: normalizeTaxId(given),
      source: flags.taxId?.trim() ? "--tax-id" : "ARCA_TAX_ID",
    };
  }
  if (certificatePem === undefined) {
    return { layer: failedLayer("config", diagnose("config.taxId")) };
  }

  const fromCertificate = readCertificateTaxId(certificatePem);
  if (fromCertificate === undefined) {
    return { layer: failedLayer("config", diagnose("config.taxIdUnknown")) };
  }
  return {
    taxId: fromCertificate,
    source: `CUIT ${fromCertificate} del certificado`,
  };
}

/** The CUIT in the certificate, or nothing when the PEM does not even parse. */
function readCertificateTaxId(certificatePem: string): string | undefined {
  try {
    return readCertificateFacts(certificatePem).taxId;
  } catch {
    // Layer 2 is where a PEM that does not parse gets its own row.
    return undefined;
  }
}

function describeDiscoveryFailure(
  discovery: CredentialDiscovery
): CliDiagnosis | undefined {
  if (discovery.kind === "ambiguous") {
    return diagnose("config.files.ambiguous", {
      files: discovery.files.join(" y "),
    });
  }
  if (discovery.kind === "incomplete") {
    return diagnose(
      discovery.missingKind === "certificate"
        ? "config.files.missingCertificate"
        : "config.files.missingKey",
      { file: discovery.present, missingFile: discovery.missing }
    );
  }
  return undefined;
}

function resolveDirectory(io: CliIo, directory: string | undefined): string {
  return isAbsolute(directory ?? "")
    ? (directory as string)
    : resolve(io.cwd, directory ?? ".");
}

function toEnvironment(value: string | undefined): ArcaEnvironment | undefined {
  return value === "test" || value === "production" ? value : undefined;
}

function readPem(
  io: CliIo,
  file: string | undefined,
  fromEnv: string | undefined
): string | undefined {
  if (file === undefined || file === "") {
    return fromEnv?.trim() || undefined;
  }
  const path = isAbsolute(file) ? file : resolve(io.cwd, file);
  return readFileSync(path, "utf8").trim();
}

/**
 * Only a file is worth naming. PEMs that came from the environment are the
 * default and stay unsaid, which keeps the old line for the old setup.
 */
function describeCredentialSource(
  flags: CheckFlags,
  found: DiscoveredCredentials | undefined
): { credentials?: string } {
  if (found !== undefined) {
    return { credentials: `${found.certificateFile} en este directorio` };
  }
  const named = [
    ...(flags.cert?.trim() ? ["--cert"] : []),
    ...(flags.key?.trim() ? ["--key"] : []),
  ];
  return named.length === 0 ? {} : { credentials: named.join(" y ") };
}

/** The file name already says the environment, so nothing is added for it. */
function describeEnvironmentSource(
  io: CliIo,
  flags: CheckFlags,
  environment: ArcaEnvironment
): { environment?: string } {
  if (flags.env?.trim()) {
    return { environment: `--env=${environment}` };
  }
  if (io.env.ARCA_ENVIRONMENT?.trim()) {
    return { environment: `ARCA_ENVIRONMENT=${environment}` };
  }
  return {};
}

function describeSources(origin: ConfigOrigin): string {
  return [origin.credentials, origin.taxId, origin.environment]
    .filter((part): part is string => part !== undefined)
    .join(", ");
}

function toConfigDiagnosis(error: unknown): CliDiagnosis {
  if (!(error instanceof ArcaConfigurationError)) {
    return { diagnosis: describeUnknownError(error).diagnosis };
  }
  if (error.message.includes("taxId")) {
    return diagnose("config.taxId");
  }
  if (error.message.includes("environment")) {
    return diagnose("config.environment");
  }
  if (
    error.message.includes("certificatePem") ||
    error.message.includes("privateKeyPem") ||
    error.message.includes("Encrypted private keys")
  ) {
    return diagnose("cert.invalid");
  }
  return { diagnosis: error.message };
}

function checkCertificate(config: ArcaClientConfig, now: Date): CliLayerReport {
  let facts: ReturnType<typeof readCertificateFacts>;
  let matches: boolean;
  try {
    facts = readCertificateFacts(config.certificatePem);
    matches = privateKeyMatchesCertificate(
      config.certificatePem,
      config.privateKeyPem
    );
  } catch {
    return failedLayer("certificate", diagnose("cert.invalid"));
  }

  // A certificate for another CUIT is a misconfiguration, not something ARCA
  // forgives: WSAA answers for whoever the certificate belongs to.
  if (facts.taxId !== undefined && facts.taxId !== config.taxId) {
    return failedLayer(
      "certificate",
      diagnose("cert.taxIdMismatch", {
        certificateTaxId: facts.taxId,
        taxId: config.taxId,
      })
    );
  }

  const expiresAt = toIsoDate(facts.notAfter);
  if (facts.notAfter.getTime() <= now.getTime()) {
    return failedLayer(
      "certificate",
      diagnose("cert.expired", { date: expiresAt })
    );
  }
  if (!matches) {
    return failedLayer("certificate", diagnose("cert.mismatch"));
  }

  const daysLeft = Math.floor(
    (facts.notAfter.getTime() - now.getTime()) / MILLISECONDS_PER_DAY
  );
  return {
    name: "certificate",
    ok: true,
    detail: `coinciden, vence ${expiresAt}`,
    expiresAt,
    ...(daysLeft < EXPIRY_WARNING_DAYS
      ? { warning: `vence en ${daysLeft} ${daysLeft === 1 ? "día" : "días"}` }
      : {}),
  };
}

async function checkWsaa(
  io: CliIo,
  config: ArcaClientConfig,
  cache: TicketCache | undefined
): Promise<{ layer: CliLayerReport; credentials?: ArcaAuthCredentials }> {
  try {
    const auth = io.createAuth({
      ...config,
      ...(cache === undefined ? {} : { wsaaSessionStore: cache.sessionStore }),
    });
    const credentials = await auth.login("wsfe", {
      forceRefresh: cache === undefined,
    });
    return {
      layer: {
        name: "wsaa",
        ok: true,
        detail:
          cache?.wasReused() === true ? "ticket vigente" : "ticket obtenido",
      },
      credentials,
    };
  } catch (error) {
    return { layer: toWsaaFailure(error, config.environment) };
  }
}

function toWsaaFailure(
  error: unknown,
  environment: ArcaEnvironment
): CliLayerReport {
  const fault = findSoapFault(error);
  const key = diagnoseWsaaFaultCode(fault?.faultCode);
  if (key !== undefined) {
    return failedLayer("wsaa", diagnose(key), fault?.code);
  }

  const transport = findTransportError(error);
  if (transport) {
    const host = new URL(ARCA_WSAA_CONFIG.endpoint[environment]).host;
    return failedLayer(
      "wsaa",
      diagnose("wsaa.transport", { host }),
      transport.code
    );
  }

  const unknown = describeUnknownError(error);
  return failedLayer("wsaa", { diagnosis: unknown.diagnosis }, unknown.code);
}

async function checkWsfe(
  client: ArcaClient
): Promise<{ layer: CliLayerReport; salesPoints?: WsfeSalesPoint[] }> {
  try {
    const status = await client.wsfe.getServerStatus();
    const down = [
      ["appServer", status.appServer],
      ["dbServer", status.dbServer],
      ["authServer", status.authServer],
    ].filter(([, value]) => value.toUpperCase() !== "OK");
    if (down.length > 0) {
      const message = down
        .map(([name, value]) => `${name}=${value}`)
        .join(", ");
      return {
        layer: failedLayer("wsfe", diagnose("wsfe.serviceError", { message })),
      };
    }

    const salesPoints = await client.wsfe.getSalesPoints({});
    return {
      layer: { name: "wsfe", ok: true, detail: "servidor ok" },
      salesPoints,
    };
  } catch (error) {
    return { layer: toWsfeFailure(error) };
  }
}

function toWsfeFailure(error: unknown): CliLayerReport {
  if (isArcaAuthenticationError(error)) {
    return {
      ...failedLayer(
        "wsfe",
        diagnoseAuthenticationReason(error.reason),
        error.code
      ),
      reason: error.reason,
    };
  }
  if (
    error instanceof ArcaServiceError ||
    error instanceof ArcaSoapFaultError
  ) {
    return failedLayer(
      "wsfe",
      diagnose("wsfe.serviceError", { message: error.message }),
      error.code
    );
  }
  const unknown = describeUnknownError(error);
  return failedLayer("wsfe", { diagnosis: unknown.diagnosis }, unknown.code);
}

function checkSalesPoints(
  points: CliSalesPointReport[],
  environment: ArcaEnvironment,
  requested: number | undefined
): CliLayerReport {
  if (requested !== undefined) {
    const found = points.find((point) => point.number === requested);
    if (!found) {
      // Homologación often reports no points at all for ones that work.
      if (points.length === 0 && environment === "test") {
        return {
          name: "salesPoints",
          ok: true,
          detail: `${requested} (no informado)`,
          warning: EMPTY_IN_TEST_WARNING,
        };
      }
      return failedLayer(
        "salesPoints",
        diagnose("salesPoint.missing", { salesPoint: requested })
      );
    }
    if (found.blocked) {
      return failedLayer(
        "salesPoints",
        diagnose("salesPoint.blocked", { salesPoint: requested })
      );
    }
    return {
      name: "salesPoints",
      ok: true,
      detail: describeSalesPoint(found),
    };
  }

  if (points.length === 0) {
    // In homologación ARCA often reports nothing for points that work. In
    // production an empty list is the whole answer: no invoice can be issued.
    if (environment === "test") {
      return {
        name: "salesPoints",
        ok: true,
        detail: "ninguno informado",
        warning: EMPTY_IN_TEST_WARNING,
      };
    }
    return failedLayer("salesPoints", diagnose("salesPoint.none"));
  }

  return {
    name: "salesPoints",
    ok: true,
    detail: `${points.length} ${points.length === 1 ? "informado" : "informados"}`,
  };
}

/**
 * The WSAA ticket, kept in the system temp directory so `check` and `issue`
 * can be run again inside the 12 hours ARCA keeps it valid. The file store
 * creates the directory 0700 and writes 0600. Nothing else is ever stored.
 */
function createTicketCache(directory: string): TicketCache {
  const store = createWsaaStoreAdapter(createFileStore(directory));
  let reused = false;
  const remove = store.delete?.bind(store);
  return {
    sessionStore: {
      get: async (key) => {
        const credentials = await store.get(key);
        if (credentials) {
          reused = true;
        }
        return credentials;
      },
      set: (key, credentials) => store.set(key, credentials),
      ...(remove === undefined ? {} : { delete: remove }),
    },
    wasReused: () => reused,
  };
}

/** Keeps the ticket from the WSAA layer in memory so WSFE reuses it. */
function createEphemeralSessionStore(
  credentials: ArcaAuthCredentials
): ArcaWsaaSessionStore {
  return {
    get: () => Promise.resolve(credentials),
    set: () => Promise.resolve(),
  };
}

function toSalesPointReport(point: WsfeSalesPoint): CliSalesPointReport {
  return {
    number: point.number,
    blocked: (point.blocked ?? "N").trim().toUpperCase().startsWith("S"),
    ...(point.emissionType === undefined ? {} : { system: point.emissionType }),
  };
}

function describeSalesPoint(point: CliSalesPointReport): string {
  const state = point.blocked ? "bloqueado" : "habilitado";
  return point.system === undefined
    ? `${point.number} (${state})`
    : `${point.number} (${state}, ${point.system})`;
}

function failedLayer(
  name: CliLayerName,
  row: CliDiagnosis,
  code?: string
): CliLayerReport {
  return {
    name,
    ok: false,
    diagnosis: row.diagnosis,
    ...(row.fix === undefined ? {} : { fix: row.fix }),
    ...(code === undefined ? {} : { code }),
  };
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
