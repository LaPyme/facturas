import {
  assertArcaClientConfig,
  discoverArcaClientConfig,
  normalizeArcaClientConfig,
} from "./config";
import { createArcaLogger } from "./internal/logger";
import type { ArcaClientOptions, ArcaEnvironment } from "./internal/types";
import { createPadronService, type PadronService } from "./services/padron";
import {
  createVouchersService,
  type VouchersService,
} from "./services/vouchers";
import { createWsfeService, type WsfeService } from "./services/wsfe";
import { createWsmtxcaService, type WsmtxcaService } from "./services/wsmtxca";
import { createSoapTransport } from "./soap";
import { createWsaaAuthModule } from "./wsaa";
import { createWsaaStoreAdapter } from "./wsaa/store-adapter";

/** Immutable, credential-free operational view of an ARCA client configuration. */
export type ArcaClientConfigView = Readonly<{
  taxId: string;
  environment: ArcaEnvironment;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}>;

/** Fully wired ARCA client with access to all service modules. */
export type ArcaClient = {
  readonly config: ArcaClientConfigView;
  wsfe: WsfeService;
  vouchers: VouchersService;
  wsmtxca: WsmtxcaService;
  padron: PadronService;
};

/**
 * Creates an ARCA client from the given configuration.
 * Validates the config, wires WSAA authentication and SOAP transport,
 * and returns an object with `.vouchers`, `.wsfe`, `.wsmtxca`, and `.padron` service modules.
 *
 * @throws {ArcaConfigurationError} When the config is missing or invalid.
 */
export function createArcaClient(config: ArcaClientOptions = {}): ArcaClient {
  const discovered = discoverArcaClientConfig(config);
  assertArcaClientConfig(discovered);
  const normalizedConfig = normalizeArcaClientConfig(discovered);
  if (normalizedConfig.store && !normalizedConfig.wsaaSessionStore) {
    normalizedConfig.wsaaSessionStore = createWsaaStoreAdapter(
      normalizedConfig.store
    );
  }
  const logger = createArcaLogger(normalizedConfig.logger);

  const auth = createWsaaAuthModule({ config: normalizedConfig, logger });
  const soap = createSoapTransport({ config: normalizedConfig, logger });
  const publicConfig = Object.freeze({
    taxId: normalizedConfig.taxId,
    environment: normalizedConfig.environment,
    timeout: normalizedConfig.timeout,
    retries: normalizedConfig.retries,
    retryDelay: normalizedConfig.retryDelay,
  });

  const wsfe = createWsfeService({ config: normalizedConfig, auth, soap });
  return {
    config: publicConfig,
    wsfe,
    vouchers: createVouchersService(wsfe, normalizedConfig),
    wsmtxca: createWsmtxcaService({ config: normalizedConfig, auth, soap }),
    padron: createPadronService({ config: normalizedConfig, auth, soap }),
  };
}
