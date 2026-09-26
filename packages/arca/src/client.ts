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
  /** Issues an invoice from business input. Idempotent with a store and key. */
  issue: VouchersService["issue"];
  /** Derives what issue() would send for the same input, with no I/O. */
  preview: VouchersService["preview"];
  /** Issues a credit note against an authorized original or a period. */
  issueCreditNote: VouchersService["issueCreditNote"];
  /** Consults a durable reservation. Never allocates or authorizes a voucher. */
  recover: VouchersService["recover"];
  /** Issues a debit note against an authorized original or a period. */
  issueDebitNote: VouchersService["issueDebitNote"];
  /** Derives a credit note; reads the original but reserves no number. */
  previewCreditNote: VouchersService["previewCreditNote"];
  /** Derives a debit note; reads the original but reserves no number. */
  previewDebitNote: VouchersService["previewDebitNote"];
  /** Consults one authorized voucher; `null` when ARCA has no such voucher. */
  lookup: VouchersService["lookup"];
  wsfe: WsfeService;
  wsmtxca: WsmtxcaService;
  padron: PadronService;
};

/**
 * Creates an ARCA client from the given configuration.
 * Validates the config, wires WSAA authentication and SOAP transport,
 * and returns an object with `issue()`, `preview()`, `issueCreditNote()`,
 * `issueDebitNote()`, `previewCreditNote()`, `previewDebitNote()`, `recover()`,
 * `lookup()` and the `.wsfe`, `.wsmtxca`, and `.padron` service modules.
 *
 * @throws {ArcaConfigurationError} When the config is missing or invalid.
 */
export function createArcaClient(config: ArcaClientOptions = {}): ArcaClient {
  const discovered = discoverArcaClientConfig(config);
  assertArcaClientConfig(discovered);
  const normalizedConfig = normalizeArcaClientConfig(discovered);
  if (normalizedConfig.store && !normalizedConfig.wsaaSessionStore) {
    normalizedConfig.wsaaSessionStore = createWsaaStoreAdapter(
      normalizedConfig.store,
      normalizedConfig
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
  const wsmtxca = createWsmtxcaService({
    config: normalizedConfig,
    auth,
    soap,
  });
  const vouchers = createVouchersService(wsfe, normalizedConfig, wsmtxca);
  return {
    config: publicConfig,
    issue: vouchers.issue,
    preview: vouchers.preview,
    issueCreditNote: vouchers.issueCreditNote,
    recover: vouchers.recover,
    issueDebitNote: vouchers.issueDebitNote,
    previewCreditNote: vouchers.previewCreditNote,
    previewDebitNote: vouchers.previewDebitNote,
    lookup: vouchers.lookup,
    wsfe,
    wsmtxca,
    padron: createPadronService({ config: normalizedConfig, auth, soap }),
  };
}
