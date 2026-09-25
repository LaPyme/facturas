import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARCA_ENV_VARIABLES,
  ARCA_ENVIRONMENTS,
  ARCA_WSAA_CONFIG,
  assertArcaClientConfig,
  createArcaClientConfigFromEnv,
  discoverArcaClientConfig,
  getArcaServiceConfig,
} from "./config";
import { ArcaConfigurationError } from "./errors";

describe("discoverArcaClientConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fills missing fields from the environment without a default environment", () => {
    vi.stubEnv("ARCA_TAX_ID", "20123456789");
    vi.stubEnv("ARCA_CERTIFICATE_PEM", "cert");
    vi.stubEnv("ARCA_PRIVATE_KEY_PEM", "key");
    vi.stubEnv("ARCA_ENVIRONMENT", "production");

    expect(discoverArcaClientConfig({ taxId: "20999999999" })).toEqual({
      taxId: "20999999999",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "production",
    });
  });

  it("throws when neither the config nor ARCA_ENVIRONMENT names an environment", () => {
    vi.stubEnv("ARCA_ENVIRONMENT", "");

    expect(() => discoverArcaClientConfig({ taxId: "20123456789" })).toThrow(
      ArcaConfigurationError
    );
    expect(() => discoverArcaClientConfig({})).toThrow(/ARCA_ENVIRONMENT/);
  });
});

describe("config", () => {
  it("lists the target environments", () => {
    expect(ARCA_ENVIRONMENTS).toEqual(["production", "test"]);
  });

  it("accepts a complete client config", () => {
    expect(() =>
      assertArcaClientConfig({
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
        environment: "test",
      })
    ).not.toThrow();
  });

  it("rejects encrypted private keys in direct configuration", () => {
    expect(() =>
      assertArcaClientConfig({
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nTEST_CERTIFICATE\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN ENCRYPTED PRIVATE KEY-----\nTEST_KEY\n-----END ENCRYPTED PRIVATE KEY-----",
        environment: "test",
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ArcaConfigurationError",
        code: "ARCA_CONFIGURATION_ERROR",
        message:
          "Encrypted private keys are not supported. Provide an unencrypted PKCS#8 or RSA private key PEM.",
      })
    );
  });

  it("rejects legacy encrypted RSA private keys in direct configuration", () => {
    expect(() =>
      assertArcaClientConfig({
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nTEST_CERTIFICATE\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,TEST_IV\n\nTEST_KEY\n-----END RSA PRIVATE KEY-----",
        environment: "test",
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ArcaConfigurationError",
        code: "ARCA_CONFIGURATION_ERROR",
        message:
          "Encrypted private keys are not supported. Provide an unencrypted PKCS#8 or RSA private key PEM.",
      })
    );
  });

  it("preserves optional WSAA session store configuration", () => {
    const wsaaSessionStore = {
      get: async () => null,
      set: async () => undefined,
    };

    expect(() =>
      assertArcaClientConfig({
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
        environment: "test",
        wsaaSessionStore,
      })
    ).not.toThrow();
  });

  it("rejects incomplete or invalid client config fields", () => {
    expect(() =>
      assertArcaClientConfig({
        taxId: " ",
        certificatePem: "",
        privateKeyPem: " ",
        environment: "sandbox" as "test",
      })
    ).toThrowError(
      new ArcaConfigurationError(
        "Missing or invalid ARCA client config fields: taxId (ARCA_TAX_ID), certificatePem (ARCA_CERTIFICATE_PEM), privateKeyPem (ARCA_PRIVATE_KEY_PEM), environment"
      )
    );
  });

  it("builds a client config from environment variables", () => {
    const envConfig = createArcaClientConfigFromEnv({
      env: {
        [ARCA_ENV_VARIABLES.taxId]: "20123456789",
        [ARCA_ENV_VARIABLES.certificatePem]:
          "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        [ARCA_ENV_VARIABLES.privateKeyPem]:
          "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      },
    });

    expect(envConfig).toEqual({
      taxId: "20123456789",
      certificatePem:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      privateKeyPem:
        "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      environment: "test",
      timeout: 30_000,
      retries: 0,
      retryDelay: 500,
    });
  });

  it("rejects encrypted private keys loaded from environment variables", () => {
    expect(() =>
      createArcaClientConfigFromEnv({
        env: {
          [ARCA_ENV_VARIABLES.taxId]: "20123456789",
          [ARCA_ENV_VARIABLES.certificatePem]:
            "-----BEGIN CERTIFICATE-----\nTEST_CERTIFICATE\n-----END CERTIFICATE-----",
          [ARCA_ENV_VARIABLES.privateKeyPem]:
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nTEST_KEY\n-----END ENCRYPTED PRIVATE KEY-----",
        },
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ArcaConfigurationError",
        code: "ARCA_CONFIGURATION_ERROR",
        message:
          "Encrypted private keys are not supported. Provide an unencrypted PKCS#8 or RSA private key PEM.",
      })
    );
  });

  it("rejects legacy encrypted RSA private keys loaded from environment variables", () => {
    expect(() =>
      createArcaClientConfigFromEnv({
        env: {
          [ARCA_ENV_VARIABLES.taxId]: "20123456789",
          [ARCA_ENV_VARIABLES.certificatePem]:
            "-----BEGIN CERTIFICATE-----\nTEST_CERTIFICATE\n-----END CERTIFICATE-----",
          [ARCA_ENV_VARIABLES.privateKeyPem]:
            "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,TEST_IV\n\nTEST_KEY\n-----END RSA PRIVATE KEY-----",
        },
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ArcaConfigurationError",
        code: "ARCA_CONFIGURATION_ERROR",
        message:
          "Encrypted private keys are not supported. Provide an unencrypted PKCS#8 or RSA private key PEM.",
      })
    );
  });

  it("rejects invalid environment values loaded from env helpers", () => {
    expect(() =>
      createArcaClientConfigFromEnv({
        env: {
          [ARCA_ENV_VARIABLES.taxId]: "20123456789",
          [ARCA_ENV_VARIABLES.certificatePem]:
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
          [ARCA_ENV_VARIABLES.privateKeyPem]:
            "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
          [ARCA_ENV_VARIABLES.environment]: "sandbox",
        },
      })
    ).toThrowError(
      new ArcaConfigurationError(
        "Missing or invalid ARCA client config fields: environment"
      )
    );
  });

  it("returns service metadata and rejects unsupported services", () => {
    expect(ARCA_WSAA_CONFIG).toMatchObject({
      soapVersion: "1.1",
      usesEmptySoapAction: true,
    });
    expect(getArcaServiceConfig("wsfe")).toMatchObject({
      soapVersion: "1.2",
      useLegacyTlsSecurityLevel0: true,
      endpoint: expect.objectContaining({
        production: expect.stringContaining("wsfev1"),
        test: expect.stringContaining("wsfev1"),
      }),
    });
    expect(getArcaServiceConfig("padron-a13")).toMatchObject({
      usesEmptySoapAction: true,
    });
    expect(() => getArcaServiceConfig("unsupported" as never)).toThrowError(
      new ArcaConfigurationError(
        "Unsupported ARCA service configuration: unsupported"
      )
    );
  });
});
