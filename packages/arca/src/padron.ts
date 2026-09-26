export type {
  CreatePadronServiceOptions,
  PadronActivity,
  PadronAddress,
  PadronService,
  PadronTax,
  PadronTaxIdLookupResult,
  PadronTaxpayerResult,
} from "./services/padron";
// biome-ignore lint/performance/noBarrelFile: package subpath re-exports runtime padron factory
export { createPadronService } from "./services/padron";
