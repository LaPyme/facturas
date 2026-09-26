import { describe, expect, it } from "vitest";
import {
  ArcaAuthenticationError,
  ArcaConfigurationError,
  ArcaError,
  ArcaInputError,
  ArcaInvalidSoapResponseError,
  ArcaServiceError,
  ArcaSoapFaultError,
  ArcaTransportError,
  isArcaAuthenticationError,
} from "./errors";
import {
  classifyArcaAuthenticationCandidate,
  classifyArcaAuthenticationError,
} from "./internal/authentication";

describe("errors", () => {
  it("assigns names, codes, and metadata for all ARCA error classes", () => {
    const cause = new Error("root cause");

    const baseError = new ArcaError("base", "ARCA_BASE", { cause });
    const configError = new ArcaConfigurationError("config", { cause });
    const authenticationError = new ArcaAuthenticationError("auth", {
      cause,
      reason: "invalid_token",
      service: "wsfe",
      operation: "FECAESolicitar",
      providerCode: 600,
    });
    const inputError = new ArcaInputError("input", {
      cause,
      code: "ARCA_INPUT_INVALID_DATE",
      field: "voucherDate",
      expected: "a YYYY-MM-DD or YYYYMMDD string",
    });
    const transportError = new ArcaTransportError("transport", {
      cause,
      statusCode: 500,
      contentType: "text/xml",
      responseBodyLength: 9,
      responseBodyPreview: "<fault />",
    });
    const invalidSoapResponse = new ArcaInvalidSoapResponseError(
      "invalid soap",
      {
        cause,
        service: "wsfe",
        operation: "FECompConsultar",
        endpointUrl: "https://example.com/ws",
        statusCode: 200,
        contentType: "text/html",
        responseBodyLength: 42,
        responseBodyPreview: "<html />",
      }
    );
    const soapFault = new ArcaSoapFaultError("soap", {
      cause,
      faultCode: "soap:Server",
    });
    const serviceError = new ArcaServiceError("service", {
      cause,
      serviceCode: 10_017,
      service: "wsfe",
      operation: "FECAESolicitar",
      result: "R",
      resultLevel: "detail",
      results: { header: "R", detail: "R" },
      issues: [
        {
          service: "wsfe",
          operation: "FECAESolicitar",
          source: "observation",
          category: "business",
          code: "10017",
          message: "Fecha inválida",
        },
      ],
    });

    expect(baseError).toMatchObject({
      name: "ArcaError",
      code: "ARCA_BASE",
      message: "base",
      cause,
    });
    expect(configError).toMatchObject({
      name: "ArcaConfigurationError",
      code: "ARCA_CONFIGURATION_ERROR",
    });
    expect(authenticationError).toMatchObject({
      name: "ArcaAuthenticationError",
      code: "ARCA_AUTHENTICATION_ERROR",
      reason: "invalid_token",
      service: "wsfe",
      operation: "FECAESolicitar",
      providerCode: 600,
      cause,
    });
    expect(isArcaAuthenticationError(authenticationError)).toBe(true);
    expect(isArcaAuthenticationError(configError)).toBe(false);
    expect(inputError).toMatchObject({
      name: "ArcaInputError",
      code: "ARCA_INPUT_INVALID_DATE",
      field: "voucherDate",
      expected: "a YYYY-MM-DD or YYYYMMDD string",
      cause,
    });
    expect(inputError).not.toHaveProperty("detail");
    expect(transportError).toMatchObject({
      name: "ArcaTransportError",
      code: "ARCA_TRANSPORT_ERROR",
      statusCode: 500,
      contentType: "text/xml",
      responseBodyLength: 9,
      responseBodyPreview: "<fault />",
    });
    expect(invalidSoapResponse).toMatchObject({
      name: "ArcaInvalidSoapResponseError",
      code: "ARCA_INVALID_SOAP_RESPONSE",
      service: "wsfe",
      operation: "FECompConsultar",
      endpointUrl: "https://example.com/ws",
      statusCode: 200,
      contentType: "text/html",
      responseBodyLength: 42,
      responseBodyPreview: "<html />",
    });
    expect(soapFault).toMatchObject({
      name: "ArcaSoapFaultError",
      code: "ARCA_SOAP_FAULT",
      faultCode: "soap:Server",
    });
    expect(serviceError).toMatchObject({
      name: "ArcaServiceError",
      code: "ARCA_SERVICE_ERROR",
      serviceCode: 10_017,
      service: "wsfe",
      operation: "FECAESolicitar",
      result: "R",
      resultLevel: "detail",
      results: { header: "R", detail: "R" },
      issues: [
        {
          service: "wsfe",
          operation: "FECAESolicitar",
          source: "observation",
          category: "business",
          code: "10017",
          message: "Fecha inválida",
        },
      ],
    });
  });

  it("bounds and redacts every public response preview", () => {
    const sensitiveBody = `<ns:Token audience="private">token-value</ns:Token><Sign>sign-value</Sign>${"x".repeat(5000)}`;
    const transportError = new ArcaTransportError("transport", {
      responseBodyLength: sensitiveBody.length,
      responseBodyPreview: sensitiveBody,
    });
    const invalidSoapResponse = new ArcaInvalidSoapResponseError(
      "invalid soap",
      {
        responseBodyLength: sensitiveBody.length,
        responseBodyPreview: sensitiveBody,
      }
    );

    for (const error of [transportError, invalidSoapResponse]) {
      expect(error.responseBodyPreview).toHaveLength(4096);
      expect(error.responseBodyPreview).toContain(
        "<ns:Token>[REDACTED]</ns:Token>"
      );
      expect(error.responseBodyPreview).toContain("<Sign>[REDACTED]</Sign>");
      expect(JSON.stringify(error)).not.toContain("token-value");
      expect(JSON.stringify(error)).not.toContain("sign-value");
    }

    expect(transportError).not.toHaveProperty("responseBody");
    expect(invalidSoapResponse).not.toHaveProperty("parsedDetail");

    const soapFault = new ArcaSoapFaultError(
      `<Token>token-value</Token><Sign>sign-value</Sign>${"x".repeat(5000)}`,
      { faultCode: "<Token>fault-code-token</Token>" }
    );
    expect(soapFault.message).toHaveLength(4096);
    expect(soapFault.message).toContain("<Token>[REDACTED]</Token>");
    expect(soapFault.message).toContain("<Sign>[REDACTED]</Sign>");
    expect(soapFault.faultCode).toBe("<Token>[REDACTED]</Token>");
    expect(JSON.stringify(soapFault)).not.toMatch(
      /token-value|sign-value|fault-code-token/
    );
  });

  it.each([
    {
      name: "WSFE token/sign code",
      service: "wsfe" as const,
      providerCode: "600",
      message: "unrelated provider text",
      reason: "invalid_token",
    },
    {
      name: "WSFE represented-CUIT code",
      service: "wsfe" as const,
      providerCode: 601,
      message: "unrelated provider text",
      reason: "missing_relationship",
    },
    {
      name: "token validation text",
      service: "wsmtxca" as const,
      message: "ValidacionDeToken: firma inválida",
      reason: "invalid_token",
    },
    {
      name: "expired token text",
      service: "wsmtxca" as const,
      message: "Token vencido Fecha y Hora de Vencimiento",
      reason: "invalid_token",
    },
    {
      name: "unauthorized computer text",
      service: "wsmtxca" as const,
      message: "Computador no autorizado a acceder a los servicios de AFIP",
      reason: "unauthorized_computer",
    },
    {
      name: "service access text",
      service: "wsmtxca" as const,
      message: "No autorizado a acceder al servicio",
      reason: "authentication_rejected",
    },
    {
      name: "missing relationship with accent",
      service: "wsmtxca" as const,
      message: "No apareció CUIT en lista de relaciones",
      reason: "missing_relationship",
    },
    {
      name: "missing relationship without accent",
      service: "wsmtxca" as const,
      message: "No aparecio CUIT en lista de relaciones",
      reason: "missing_relationship",
    },
  ])("classifies $name as a typed authentication error", (fixture) => {
    const error = classifyArcaAuthenticationCandidate({
      service: fixture.service,
      operation: "operation",
      providerCode: fixture.providerCode,
      message: fixture.message,
    });

    expect(error).toMatchObject({
      name: "ArcaAuthenticationError",
      code: "ARCA_AUTHENTICATION_ERROR",
      reason: fixture.reason,
      service: fixture.service,
      operation: "operation",
    });
    expect(error?.message).not.toContain(fixture.message);
  });

  it.each([
    "ValidacionDeTokens: plural near miss",
    "El computador fue autorizado previamente",
    "No autorizado a emitir comprobantes",
    "El token budget no alcanzó",
    "No apareció CUIT en una lista de relaciones comerciales",
  ])("does not classify near-miss provider text: %s", (message) => {
    expect(
      classifyArcaAuthenticationCandidate({
        service: "wsmtxca",
        operation: "operation",
        message,
      })
    ).toBeUndefined();
  });

  it("does not inspect arbitrary errors, nested causes, or serialized graphs", () => {
    const error = new Error("generic wrapper", {
      cause: {
        message: "ValidacionDeToken",
        nested: { faultstring: "Computador no autorizado" },
      },
    });

    expect(
      classifyArcaAuthenticationError(error, {
        service: "wsfe",
        operation: "FECAESolicitar",
      })
    ).toBeUndefined();
  });

  it("redacts and bounds authentication metadata", () => {
    const error = new ArcaAuthenticationError(
      `<Token>token-value</Token>${"x".repeat(5000)}`,
      {
        reason: "authentication_rejected",
        service: "wsfe",
        operation: "FECAESolicitar",
        providerCode: `<Sign>sign-value</Sign>${"y".repeat(1000)}`,
      }
    );

    expect(error.message).toHaveLength(4096);
    expect(error.providerCode).toHaveLength(512);
    expect(JSON.stringify(error)).not.toMatch(/token-value|sign-value/);
  });
});

// Projection coverage lives beside the error classes to keep the raw-free boundary explicit.
describe("toArcaSafeErrorMetadata", () => {
  it("excludes raw bodies, causes, stacks and arbitrary properties", async () => {
    const { toArcaSafeErrorMetadata } = await import("./errors");
    const error = new ArcaTransportError("Unavailable", {
      statusCode: 503,
      cause: new Error("private"),
      responseBodyPreview: "private",
    });
    Object.assign(error, { raw: { private: true } });
    expect(toArcaSafeErrorMetadata(error)).toEqual({
      name: "ArcaTransportError",
      message: "Unavailable",
      code: "ARCA_TRANSPORT_ERROR",
      statusCode: 503,
    });
    expect(toArcaSafeErrorMetadata(new Error("Oops"))).toEqual({
      name: "Error",
      message: "Oops",
    });
    expect(toArcaSafeErrorMetadata(null)).toEqual({
      name: "UnknownError",
      message: "null",
    });
    expect(toArcaSafeErrorMetadata("failure")).toEqual({
      name: "UnknownError",
      message: "failure",
    });
  });

  it("keeps each class's typed fields and drops the private ones", async () => {
    const { toArcaSafeErrorMetadata } = await import("./errors");
    expect(
      toArcaSafeErrorMetadata(
        new ArcaInputError("Bad", {
          code: "ARCA_INPUT_INVALID_VALUE",
          field: "input.items",
          expected: "a non-empty array",
        })
      )
    ).toEqual({
      name: "ArcaInputError",
      message: "Bad",
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "input.items",
      expected: "a non-empty array",
    });
    expect(
      toArcaSafeErrorMetadata(
        new ArcaAuthenticationError("Rejected", {
          reason: "unauthorized_computer",
          service: "wsfe",
          operation: "FECAESolicitar",
          providerCode: 600,
        })
      )
    ).toEqual({
      name: "ArcaAuthenticationError",
      message: "Rejected",
      code: "ARCA_AUTHENTICATION_ERROR",
      reason: "unauthorized_computer",
      service: "wsfe",
      operation: "FECAESolicitar",
      providerCode: 600,
    });
    expect(
      toArcaSafeErrorMetadata(
        new ArcaTransportError("Unavailable", {
          statusCode: 503,
          contentType: "text/html",
          responseBodyPreview: "private",
        })
      )
    ).toEqual({
      name: "ArcaTransportError",
      message: "Unavailable",
      code: "ARCA_TRANSPORT_ERROR",
      statusCode: 503,
      contentType: "text/html",
    });
    expect(
      toArcaSafeErrorMetadata(
        new ArcaSoapFaultError("Fault", { faultCode: "soap:Server" })
      )
    ).toEqual({
      name: "ArcaSoapFaultError",
      message: "Fault",
      code: "ARCA_SOAP_FAULT",
      faultCode: "soap:Server",
    });
    expect(
      toArcaSafeErrorMetadata(
        new ArcaInvalidSoapResponseError("Invalid", {
          service: "wsmtxca",
          operation: "consultarComprobante",
          endpointUrl: "https://private.example",
          statusCode: 200,
          contentType: "text/xml",
          responseBodyPreview: "private",
        })
      )
    ).toEqual({
      name: "ArcaInvalidSoapResponseError",
      message: "Invalid",
      code: "ARCA_INVALID_SOAP_RESPONSE",
      service: "wsmtxca",
      operation: "consultarComprobante",
      statusCode: 200,
      contentType: "text/xml",
    });
    expect(
      toArcaSafeErrorMetadata(
        new ArcaServiceError("Rejected", {
          serviceCode: 10_016,
          service: "wsfe",
          operation: "FECAESolicitar",
          result: "R",
          resultLevel: "detail",
          results: { header: "R", detail: "R" },
          cae: "74123456789012",
          issues: [
            {
              service: "wsfe",
              operation: "FECAESolicitar",
              source: "error",
              category: "business",
              code: "10016",
              message: "private",
            },
          ],
        })
      )
    ).toEqual({
      name: "ArcaServiceError",
      message: "Rejected",
      code: "ARCA_SERVICE_ERROR",
      serviceCode: "10016",
      service: "wsfe",
      operation: "FECAESolicitar",
      result: "R",
      resultLevel: "detail",
    });
  });
});
