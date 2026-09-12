import { describe, expect, it } from "vitest";
import { createArcaClient } from "./client";
import * as constantsBarrel from "./constants";
import * as arca from "./index";
import * as padronBarrel from "./padron";
import { createPadronService } from "./services/padron";
import { createWsfeService } from "./services/wsfe";
import { createWsmtxcaService } from "./services/wsmtxca";
import * as wsfeBarrel from "./wsfe";
import * as wsmtxcaBarrel from "./wsmtxca";

describe("barrel exports", () => {
  it("re-exports runtime factories from the package entrypoints", () => {
    expect(arca.createArcaClient).toBe(createArcaClient);
    expect(arca.createArcaClientConfigFromEnv).toBeTypeOf("function");
    expect(arca.ArcaAuthenticationError).toBeTypeOf("function");
    expect(arca.isArcaAuthenticationError).toBeTypeOf("function");
    expect(arca.createMemoryWsaaSessionStore).toBeTypeOf("function");
    expect(arca.createPadronService).toBe(createPadronService);
    expect(arca.createWsfeService).toBe(createWsfeService);
    expect(arca.createWsmtxcaService).toBe(createWsmtxcaService);
    expect(padronBarrel.createPadronService).toBe(createPadronService);
    expect(wsfeBarrel.createWsfeService).toBe(createWsfeService);
    expect(wsmtxcaBarrel.createWsmtxcaService).toBe(createWsmtxcaService);
    expect(arca.ARCA_ENVIRONMENTS).toEqual(["production", "test"]);
    expect(arca.ARCA_ENV_VARIABLES.environment).toBe("ARCA_ENVIRONMENT");
    expect(constantsBarrel.ARCA_VOUCHER_TYPES.FACTURA_B).toBe(6);
    expect(constantsBarrel.ARCA_DOCUMENT_TYPES.CUIT).toBe(80);
    expect(constantsBarrel.ARCA_RECEIVER_VAT_CONDITIONS.CONSUMIDOR_FINAL).toBe(
      5
    );
    expect(constantsBarrel.ARCA_CONCEPT_TYPES.SERVICIOS).toBe(2);
    expect(constantsBarrel.ARCA_VAT_RATES.IVA_21).toBe(5);
    expect(constantsBarrel.ARCA_CURRENCIES.PES).toBe("PES");
    expect(constantsBarrel.ISO_CURRENCIES.ARS).toBe("ARS");
    expect(constantsBarrel.ARCA_CURRENCY_IDS.USD).toBe("DOL");
  });
});
