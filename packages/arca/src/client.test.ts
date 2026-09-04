import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mockAssertArcaClientConfig = vi.hoisted(() => vi.fn());
const mockNormalizeArcaClientConfig = vi.hoisted(() => vi.fn());
const mockCreateWsaaAuthModule = vi.hoisted(() => vi.fn());
const mockCreateSoapTransport = vi.hoisted(() => vi.fn());
const mockCreateWsfeService = vi.hoisted(() => vi.fn());
const mockCreateWsmtxcaService = vi.hoisted(() => vi.fn());
const mockCreatePadronService = vi.hoisted(() => vi.fn());
const mockPostXml = vi.hoisted(() => vi.fn());

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    assertArcaClientConfig: mockAssertArcaClientConfig,
    normalizeArcaClientConfig: mockNormalizeArcaClientConfig,
  };
});
vi.mock("./wsaa", () => ({
  createWsaaAuthModule: mockCreateWsaaAuthModule,
}));
vi.mock("./soap", () => ({
  createSoapTransport: mockCreateSoapTransport,
}));
vi.mock("./services/wsfe", () => ({
  createWsfeService: mockCreateWsfeService,
}));
vi.mock("./services/wsmtxca", () => ({
  createWsmtxcaService: mockCreateWsmtxcaService,
}));
vi.mock("./services/padron", () => ({
  createPadronService: mockCreatePadronService,
}));
vi.mock("./internal/http", () => ({
  postXmlWithMetadata: mockPostXml,
}));

import { type ArcaClientConfigView, createArcaClient } from "./client";

afterEach(() => {
  mockAssertArcaClientConfig.mockReset();
  mockNormalizeArcaClientConfig.mockReset();
  mockCreateWsaaAuthModule.mockReset();
  mockCreateSoapTransport.mockReset();
  mockCreateWsfeService.mockReset();
  mockCreateWsmtxcaService.mockReset();
  mockCreatePadronService.mockReset();
  mockPostXml.mockReset();
  vi.unstubAllEnvs();
});

describe("createArcaClient", () => {
  it("validates config and wires every runtime module once", () => {
    const config = {
      taxId: "20123456789",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "test" as const,
      timeout: 30_000,
      retries: 0,
      retryDelay: 500,
    };
    const auth = { login: vi.fn() };
    const soap = { execute: vi.fn() };
    const wsfe = { createNextVoucher: vi.fn() };
    const wsmtxca = { authorizeVoucher: vi.fn() };
    const padron = { getTaxpayerDetails: vi.fn() };

    mockCreateWsaaAuthModule.mockReturnValue(auth);
    mockCreateSoapTransport.mockReturnValue(soap);
    mockCreateWsfeService.mockReturnValue(wsfe);
    mockCreateWsmtxcaService.mockReturnValue(wsmtxca);
    mockCreatePadronService.mockReturnValue(padron);
    mockNormalizeArcaClientConfig.mockReturnValue(config);

    const client = createArcaClient(config);

    expect(mockAssertArcaClientConfig).toHaveBeenCalledWith(config);
    expect(mockNormalizeArcaClientConfig).toHaveBeenCalledWith(config);
    expect(mockCreateWsaaAuthModule).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        logger: expect.objectContaining({
          debug: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
          error: expect.any(Function),
        }),
      })
    );
    expect(mockCreateSoapTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        logger: expect.objectContaining({
          debug: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
          error: expect.any(Function),
        }),
      })
    );
    expect(mockCreateWsfeService).toHaveBeenCalledWith({ config, auth, soap });
    expect(mockCreateWsmtxcaService).toHaveBeenCalledWith({
      config,
      auth,
      soap,
    });
    expect(mockCreatePadronService).toHaveBeenCalledWith({
      config,
      auth,
      soap,
    });
    expect(client).toEqual({
      config: {
        taxId: config.taxId,
        environment: config.environment,
        timeout: config.timeout,
        retries: config.retries,
        retryDelay: config.retryDelay,
      },
      wsfe,
      vouchers: { issue: expect.any(Function), cancel: expect.any(Function) },
      wsmtxca,
      padron,
    });
    expect(Object.isFrozen(client.config)).toBe(true);
    expectTypeOf(client.config).toEqualTypeOf<ArcaClientConfigView>();
    type CredentialKeys = Extract<
      keyof typeof client.config,
      "certificatePem" | "privateKeyPem" | "logger" | "wsaaSessionStore"
    >;
    expectTypeOf<CredentialKeys>().toEqualTypeOf<never>();
  });

  it("exposes an immutable config view without serializable secrets", () => {
    const sessionStore = {
      Token: "stored-token-value",
      Sign: "stored-sign-value",
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const config = {
      taxId: "20123456789",
      certificatePem:
        "-----BEGIN CERTIFICATE-----\ncertificate-value\n-----END CERTIFICATE-----",
      privateKeyPem:
        "-----BEGIN PRIVATE KEY-----\nprivate-key-value\n-----END PRIVATE KEY-----",
      environment: "test" as const,
      timeout: 30_000,
      retries: 1,
      retryDelay: 500,
      logger: {
        level: "debug" as const,
        log: vi.fn(),
      },
      wsaaSessionStore: sessionStore,
    };

    mockNormalizeArcaClientConfig.mockReturnValue(config);
    mockCreateWsaaAuthModule.mockReturnValue({ login: vi.fn() });
    mockCreateSoapTransport.mockReturnValue({ execute: vi.fn() });
    mockCreateWsfeService.mockReturnValue({});
    mockCreateWsmtxcaService.mockReturnValue({});
    mockCreatePadronService.mockReturnValue({});

    const client = createArcaClient(config);
    const serializedClient = JSON.stringify(client);

    expect(client.config).toEqual({
      taxId: "20123456789",
      environment: "test",
      timeout: 30_000,
      retries: 1,
      retryDelay: 500,
    });
    expect(Object.isFrozen(client.config)).toBe(true);
    expect(Reflect.set(client.config, "timeout", 1)).toBe(false);
    expect(serializedClient).not.toMatch(
      /certificatePem|privateKeyPem|logger|wsaaSessionStore/
    );
    expect(serializedClient).not.toMatch(/BEGIN (?:CERTIFICATE|PRIVATE KEY)/);
    expect(serializedClient).not.toMatch(/"(?:Token|Sign)"/);
    expect(serializedClient).not.toContain("stored-token-value");
    expect(serializedClient).not.toContain("stored-sign-value");
    expect(serializedClient).not.toContain("certificate-value");
    expect(serializedClient).not.toContain("private-key-value");
  });

  it("emits logger calls during SOAP-backed client requests", async () => {
    const log = vi.fn();
    const config = {
      taxId: "20123456789",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "test" as const,
      timeout: 30_000,
      retries: 0,
      retryDelay: 500,
      logger: {
        level: "debug" as const,
        log,
      },
    };

    const actualSoap = await vi.importActual<typeof import("./soap")>("./soap");
    const actualWsfe =
      await vi.importActual<typeof import("./services/wsfe")>(
        "./services/wsfe"
      );
    const auth = {
      login: vi.fn().mockResolvedValue({
        token: "token",
        sign: "sign",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    };

    mockNormalizeArcaClientConfig.mockReturnValue(config);
    mockCreateWsaaAuthModule.mockReturnValue(auth);
    mockCreateSoapTransport.mockImplementation(actualSoap.createSoapTransport);
    mockCreateWsfeService.mockImplementation(actualWsfe.createWsfeService);
    mockCreateWsmtxcaService.mockReturnValue({} as object);
    mockCreatePadronService.mockReturnValue({} as object);
    mockPostXml.mockResolvedValueOnce({
      body: '<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><FEParamGetPtosVentaResponse><FEParamGetPtosVentaResult><ResultGet><PtoVenta><Nro>3</Nro></PtoVenta></ResultGet></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></soap12:Body></soap12:Envelope>',
      statusCode: 200,
      contentType: "application/soap+xml; charset=utf-8",
    });

    const client = createArcaClient(config);

    await expect(client.wsfe.getSalesPoints({})).resolves.toEqual([
      { number: 3 },
    ]);

    expect(log).toHaveBeenCalledWith(
      "debug",
      "Sending ARCA SOAP request",
      expect.objectContaining({
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
        url: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
      })
    );
    expect(log).toHaveBeenCalledWith(
      "debug",
      "Received ARCA SOAP response",
      expect.objectContaining({
        service: "wsfe",
        operation: "FEParamGetPtosVenta",
        durationMs: expect.any(Number),
      })
    );
  });
});
