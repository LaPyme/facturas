import { describe, expect, it, vi } from "vitest";
import {
  ArcaInvalidSoapResponseError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";
import { buildSoapEnvelope } from "../internal/xml";
import { createWsmtxcaService } from "./wsmtxca";

function expectSerializedAuthBefore(
  bodyElementName: string,
  body: Record<string, unknown>,
  operationFieldName: string
) {
  const xml = buildSoapEnvelope(
    "1.1",
    bodyElementName,
    "http://impl.service.wsmtxca.afip.gov.ar/service/",
    body,
    { namespaceMode: "prefix" }
  );
  const authIndex = xml.indexOf("<authRequest>");
  const operationIndex = xml.indexOf(`<${operationFieldName}>`);

  expect(authIndex).toBeGreaterThan(-1);
  expect(operationIndex).toBeGreaterThan(authIndex);
}

function createBaseOptions() {
  return {
    config: {
      taxId: "20123456789",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "test" as const,
    },
    auth: {
      login: vi.fn().mockResolvedValue({
        token: "token",
        sign: "sign",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    },
    soap: {
      execute: vi.fn().mockResolvedValue({
        result: {
          ok: true,
        },
      }),
    },
  };
}

describe("createWsmtxcaService", () => {
  it("issues vouchers using prefixed WSMTXCA operations", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        autorizarComprobanteResponse: {
          resultado: "O",
          comprobanteResponse: {
            CAE: "12345678901234",
            fechaVencimientoCAE: "20260301",
            numeroComprobante: "11",
          },
        },
      },
    });
    const service = createWsmtxcaService(options);

    await expect(
      service.issue({
        representedTaxId: "20304050607",
        data: {
          comprobanteCAERequest: {
            numeroComprobante: 11,
          },
        },
      })
    ).resolves.toMatchObject({
      kind: "authorized",
      cae: "12345678901234",
      voucherNumber: 11,
    });

    expect(options.auth.login).toHaveBeenCalledWith("wsmtxca", {
      representedTaxId: "20304050607",
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsmtxca",
      operation: "autorizarComprobante",
      retries: 0,
      bodyElementName: "autorizarComprobanteRequest",
      bodyElementNamespaceMode: "prefix",
      body: {
        authRequest: {
          token: "token",
          sign: "sign",
          cuitRepresentada: 20_304_050_607,
        },
        comprobanteCAERequest: {
          numeroComprobante: 11,
        },
      },
    });
    const body = options.soap.execute.mock.calls[0]?.[0].body;
    expect(Object.keys(body)).toEqual(["authRequest", "comprobanteCAERequest"]);
    expectSerializedAuthBefore(
      "autorizarComprobanteRequest",
      body,
      "comprobanteCAERequest"
    );
  });

  it("rejects caller-provided WSMTXCA authentication before network work", async () => {
    const options = createBaseOptions();
    const service = createWsmtxcaService(options);

    await expect(
      service.issue({
        data: {
          authRequest: {
            token: "caller-token",
            sign: "caller-sign",
          },
          comprobanteCAERequest: {
            numeroComprobante: 11,
          },
        },
      })
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      code: "ARCA_INPUT_RESERVED_FIELD",
      field: "data.authRequest",
      message:
        'WSMTXCA authorization data cannot include the reserved top-level field "authRequest".',
    });
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it.each(["A", "O"])(
    "returns structured authorized evidence for WSMTXCA result %s",
    async (resultado) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          autorizarComprobanteResponse: {
            resultado,
            comprobanteResponse: {
              CAE: "12345678901234",
              fechaVencimientoCAE: "20260301",
              numeroComprobante: "11",
            },
            arrayObservaciones: {
              codigoDescripcion: [
                { codigo: 504, descripcion: "Observación uno" },
                { codigo: 505, descripcion: "Observación dos" },
              ],
            },
          },
        },
      });

      await expect(
        createWsmtxcaService(options).issue({
          data: {
            comprobanteCAERequest: { numeroComprobante: 11 },
          },
        })
      ).resolves.toMatchObject({
        kind: "authorized",
        result: resultado,
        resultLevel: "operation",
        results: { operation: resultado },
        cae: "12345678901234",
        voucherNumber: 11,
        observations: [
          { code: "504", message: "Observación uno" },
          { code: "505", message: "Observación dos" },
        ],
      });
    }
  );

  it("treats WSMTXCA authorization 500/501/502 as business rejection evidence", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        autorizarComprobanteResponse: {
          resultado: "R",
          arrayErrores: {
            codigoDescripcion: [
              { codigo: 500, descripcion: "Unidad inválida" },
              { codigo: 501, descripcion: "Cantidad inválida" },
              { codigo: 502, descripcion: "Precio inválido" },
            ],
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(options).issue({
        data: {
          comprobanteCAERequest: { numeroComprobante: 11 },
        },
      })
    ).resolves.toMatchObject({
      kind: "rejected",
      service: "wsmtxca",
      operation: "autorizarComprobante",
      result: "R",
      errors: [
        { code: "500", category: "business" },
        { code: "501", category: "business" },
        { code: "502", category: "business" },
      ],
    });
  });

  it("retains contradictory WSMTXCA result and CAE evidence", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        autorizarComprobanteResponse: {
          resultado: "R",
          comprobanteResponse: {
            CAE: "12345678901234",
            numeroComprobante: 11,
          },
          arrayErrores: {
            codigoDescripcion: {
              codigo: 500,
              descripcion: "Unidad inválida",
            },
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(options).issue({
        data: {
          comprobanteCAERequest: { numeroComprobante: 11 },
        },
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "contradictory_response",
      results: { operation: "R" },
      cae: "12345678901234",
      voucherNumber: 11,
    });
  });

  it("returns WSMTXCA transport failures as indeterminate without resubmitting", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockRejectedValueOnce(
      new ArcaTransportError("connection lost")
    );

    await expect(
      createWsmtxcaService(options).issue({
        data: {
          comprobanteCAERequest: { numeroComprobante: 11 },
        },
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      service: "wsmtxca",
      operation: "autorizarComprobante",
      reason: "transport_error",
    });
    expect(options.soap.execute).toHaveBeenCalledOnce();
  });

  it("records typed WSMTXCA auth evidence without retrying exact outcomes", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockRejectedValueOnce(
      new ArcaSoapFaultError(
        "Token vencido Fecha y Hora de Vencimiento del Token Enviado",
        { faultCode: "soapenv:Client" }
      )
    );

    await expect(
      createWsmtxcaService(options).issue({
        data: { comprobanteCAERequest: { numeroComprobante: 11 } },
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "authentication_rejected",
      authentication: {
        code: "ARCA_AUTHENTICATION_ERROR",
        reason: "invalid_token",
        providerCode: "soapenv:Client",
      },
    });
    expect(options.auth.login).toHaveBeenCalledOnce();
    expect(options.soap.execute).toHaveBeenCalledOnce();
    expect(options.soap.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "autorizarComprobante", retries: 0 })
    );
  });

  it("recovers a WSMTXCA read once only after explicit auth rejection", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockRejectedValueOnce(
        new ArcaSoapFaultError("No autorizado a acceder al servicio", {
          faultCode: "soapenv:Client",
        })
      )
      .mockResolvedValueOnce({
        result: {
          consultarPuntosVentaResponse: {
            arrayPuntosVenta: {
              puntoVenta: { numeroPuntoVenta: 1, bloqueado: "N" },
            },
          },
        },
      });

    await expect(
      createWsmtxcaService(options).getSalesPoints()
    ).resolves.toMatchObject({ salesPoints: [{ number: 1, blocked: false }] });
    expect(options.auth.login).toHaveBeenCalledTimes(2);
    expect(options.auth.login).toHaveBeenLastCalledWith(
      "wsmtxca",
      expect.objectContaining({ forceRefresh: true })
    );
    expect(options.soap.execute).toHaveBeenCalledTimes(2);
  });

  it("queries the last authorized voucher using the default tax id", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        consultarUltimoComprobanteAutorizadoResponse: {
          numeroComprobante: "4",
        },
      },
    });
    const service = createWsmtxcaService(options);

    await expect(
      service.getLastAuthorizedVoucher({
        voucherType: 1,
        salesPoint: 4,
      })
    ).resolves.toEqual({
      voucherNumber: 4,
      raw: {
        numeroComprobante: "4",
      },
    });

    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsmtxca",
      operation: "consultarUltimoComprobanteAutorizado",
      bodyElementName: "consultarUltimoComprobanteAutorizadoRequest",
      bodyElementNamespaceMode: "prefix",
      body: {
        authRequest: {
          token: "token",
          sign: "sign",
          cuitRepresentada: 20_123_456_789,
        },
        consultaUltimoComprobanteAutorizadoRequest: {
          codigoTipoComprobante: 1,
          numeroPuntoVenta: 4,
        },
      },
    });
    expectSerializedAuthBefore(
      "consultarUltimoComprobanteAutorizadoRequest",
      options.soap.execute.mock.calls[0]?.[0].body,
      "consultaUltimoComprobanteAutorizadoRequest"
    );
  });

  it("queries a specific voucher", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        consultarComprobanteResponse: {
          comprobanteResponse: {
            fechaEmision: "20260301",
          },
        },
      },
    });
    const service = createWsmtxcaService(options);

    await expect(
      service.lookupVoucher({
        representedTaxId: "20304050607",
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
      })
    ).resolves.toMatchObject({
      kind: "found",
      service: "wsmtxca",
      voucher: { invoiceDate: "2026-03-01" },
    });

    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsmtxca",
      operation: "consultarComprobante",
      bodyElementName: "consultarComprobanteRequest",
      bodyElementNamespaceMode: "prefix",
      body: {
        authRequest: {
          token: "token",
          sign: "sign",
          cuitRepresentada: 20_304_050_607,
        },
        consultaComprobanteRequest: {
          codigoTipoComprobante: 6,
          numeroPuntoVenta: 8,
          numeroComprobante: 25,
        },
      },
    });
  });

  it("passes forceRefresh through every authenticated WSMTXCA method", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          autorizarComprobanteResponse: {
            resultado: "O",
            comprobanteResponse: {
              CAE: "12345678901234",
              numeroComprobante: "11",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          consultarUltimoComprobanteAutorizadoResponse: {
            numeroComprobante: "11",
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          consultarComprobanteResponse: {
            comprobanteResponse: {
              fechaEmision: "20260301",
            },
          },
        },
      });

    const service = createWsmtxcaService(options);

    await service.issue({
      representedTaxId: "20304050607",
      forceRefresh: true,
      data: {
        comprobanteCAERequest: {
          numeroComprobante: 11,
        },
      },
    });
    await service.getLastAuthorizedVoucher({
      representedTaxId: "20304050607",
      voucherType: 6,
      salesPoint: 8,
      forceRefresh: true,
    });
    await service.lookupVoucher({
      representedTaxId: "20304050607",
      voucherType: 6,
      salesPoint: 8,
      voucherNumber: 11,
      forceRefresh: true,
    });

    expect(options.auth.login).toHaveBeenNthCalledWith(1, "wsmtxca", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.auth.login).toHaveBeenNthCalledWith(2, "wsmtxca", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.auth.login).toHaveBeenNthCalledWith(3, "wsmtxca", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
  });

  it("normalizes WSMTXCA latest error 1502 to an empty sequence", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        consultarUltimoComprobanteAutorizadoResponse: {
          arrayErrores: {
            codigoDescripcion: {
              codigo: 1502,
              descripcion: "No existen comprobantes autorizados",
            },
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(options).getLastAuthorizedVoucher({
        voucherType: 1,
        salesPoint: 4,
      })
    ).resolves.toMatchObject({
      voucherNumber: 0,
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["boolean", true],
    ["negative", -1],
    ["fraction", 1.5],
    ["fraction string", "1.5"],
    ["trailing text", "12abc"],
    ["exponent string", "1e2"],
    ["too many digits", "100000000"],
    ["non-numeric", "not-a-number"],
  ] as const)(
    "rejects invalid last authorized number: %s",
    async (_label, rawNumber) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          consultarUltimoComprobanteAutorizadoResponse: {
            numeroComprobante: rawNumber,
          },
        },
      });
      const failure = await createWsmtxcaService(options)
        .getLastAuthorizedVoucher({ voucherType: 1, salesPoint: 4 })
        .catch((error: unknown) => error);

      if (!(failure instanceof ArcaInvalidSoapResponseError)) {
        throw new Error("Expected invalid WSMTXCA response error");
      }
      expect(failure).toMatchObject({
        service: "wsmtxca",
        operation: "consultarUltimoComprobanteAutorizado",
      });
      expect(failure.cause).toBeUndefined();
      expect(failure.message).toBe("Invalid WSMTXCA last authorized number");
    }
  );

  it.each([
    [0, 0],
    ["0", 0],
    [41, 41],
    ["41", 41],
    [99_999_999, 99_999_999],
  ] as const)(
    "accepts explicit last authorized number %s",
    async (rawNumber, expected) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          consultarUltimoComprobanteAutorizadoResponse: {
            numeroComprobante: rawNumber,
          },
        },
      });

      await expect(
        createWsmtxcaService(options).getLastAuthorizedVoucher({
          voucherType: 1,
          salesPoint: 4,
        })
      ).resolves.toMatchObject({ voucherNumber: expected });
    }
  );

  it("normalizes only WSMTXCA consult 1503 as exact voucher absence", async () => {
    const notFoundOptions = createBaseOptions();
    notFoundOptions.soap.execute.mockResolvedValueOnce({
      result: {
        consultarComprobanteResponse: {
          arrayErrores: {
            codigoDescripcion: {
              codigo: 1503,
              descripcion: "El comprobante debe existir",
            },
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(notFoundOptions).lookupVoucher({
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
      })
    ).resolves.toMatchObject({
      kind: "not_found",
      service: "wsmtxca",
      operation: "consultarComprobante",
      errors: [{ code: "1503" }],
    });

    const caeaErrorOptions = createBaseOptions();
    caeaErrorOptions.soap.execute.mockResolvedValueOnce({
      result: {
        consultarComprobanteResponse: {
          arrayErrores: {
            codigoDescripcion: {
              codigo: 602,
              descripcion: "Validación de fecha CAEA",
            },
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(caeaErrorOptions).lookupVoucher({
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      service: "wsmtxca",
      operation: "consultarComprobante",
      serviceCode: "602",
    });

    const mixedOptions = createBaseOptions();
    mixedOptions.soap.execute.mockResolvedValueOnce({
      result: {
        consultarComprobanteResponse: {
          arrayErrores: {
            codigoDescripcion: [
              { codigo: 1503, descripcion: "El comprobante debe existir" },
              { codigo: 602, descripcion: "Validación de fecha CAEA" },
            ],
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(mixedOptions).lookupVoucher({
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      operation: "consultarComprobante",
    });
  });

  it("returns typed WSMTXCA voucher identity and monetary fields", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        consultarComprobanteResponse: {
          comprobante: {
            codigoTipoComprobante: 6,
            numeroPuntoVenta: 8,
            numeroComprobante: 25,
            fechaEmision: "20260301",
            codigoAutorizacion: "74123456789012",
            fechaVencimiento: "20260311",
            codigoTipoDocumento: 80,
            numeroDocumento: "30717329654",
            condicionIVAReceptor: 1,
            importeGravado: "100.00",
            importeNoGravado: "0.00",
            importeExento: "0.00",
            importeSubtotal: "100.00",
            importeOtrosTributos: "2.00",
            importeTotal: "123.00",
            arraySubtotalesIVA: {
              subtotalIVA: [
                { codigo: 5, importe: "20.00" },
                { codigo: 4, importe: "1.00" },
              ],
            },
            codigoMoneda: "PES",
            cotizacionMoneda: "1.00",
            codigoConcepto: 1,
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(options).lookupVoucher({
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
      })
    ).resolves.toMatchObject({
      kind: "found",
      voucher: {
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
        invoiceDate: "2026-03-01",
        cae: "74123456789012",
        caeExpiry: "2026-03-11",
        documentType: 80,
        documentNumber: "30717329654",
        receiverVatConditionId: 1,
        taxableAmount: 100,
        nonTaxableAmount: 0,
        exemptAmount: 0,
        subtotalAmount: 100,
        taxAmount: 2,
        vatAmount: 21,
        totalAmount: 123,
        currencyId: "PES",
        exchangeRate: 1,
        concept: 1,
      },
    });
  });

  it("queries WSMTXCA sales points from the source service", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        consultarPuntosVentaResponse: {
          arrayPuntosVenta: {
            puntoVenta: [
              { numeroPuntoVenta: 1, bloqueado: "N" },
              {
                numeroPuntoVenta: "2",
                bloqueado: "S",
                fechaBaja: "20260301",
              },
            ],
          },
        },
      },
    });

    await expect(
      createWsmtxcaService(options).getSalesPoints({
        representedTaxId: "20304050607",
      })
    ).resolves.toMatchObject({
      salesPoints: [
        { number: 1, blocked: false },
        { number: 2, blocked: true, deletedAt: "2026-03-01" },
      ],
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsmtxca",
      operation: "consultarPuntosVenta",
      bodyElementName: "consultarPuntosVentaRequest",
      bodyElementNamespaceMode: "prefix",
      body: {
        authRequest: {
          token: "token",
          sign: "sign",
          cuitRepresentada: 20_304_050_607,
        },
      },
    });
  });

  it("rejects malformed last-voucher and voucher lookup responses", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          consultarUltimoComprobanteAutorizadoResponse: {},
        },
      })
      .mockResolvedValueOnce({
        result: {
          consultarComprobanteResponse: {},
        },
      });

    const service = createWsmtxcaService(options);

    await expect(
      service.getLastAuthorizedVoucher({
        voucherType: 1,
        salesPoint: 4,
      })
    ).rejects.toMatchObject({
      name: "ArcaInvalidSoapResponseError",
      message: "Invalid WSMTXCA last authorized number",
    });

    await expect(
      service.lookupVoucher({
        voucherType: 6,
        salesPoint: 8,
        voucherNumber: 25,
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      message: "WSMTXCA did not return the voucher issue date",
    });
  });
});

const invalidResponseIntegers = [
  ["nulo", null],
  ["vacío", ""],
  ["espacios", "   "],
  ["booleano", true],
  ["cero", 0],
  ["negativo", -1],
  ["fracción numérica", 1.5],
  ["fracción textual", "1.5"],
  ["sufijo", "12abc"],
  ["exponente", "1e2"],
  ["hexadecimal", "0x10"],
  ["signo", "+12"],
  ["fuera de rango", 100_000_000],
  ["infinito", Number.POSITIVE_INFINITY],
  ["NaN", Number.NaN],
  ["array", [12]],
  ["objeto", {}],
] as const;

const voucherIdentityFields = [
  ["numeroComprobante", "voucherNumber", 99_999_999],
  ["numeroPuntoVenta", "salesPoint", 99_999],
  ["codigoTipoComprobante", "voucherType", 999],
] as const;

describe("identificadores enteros de WSMTXCA", () => {
  it.each(invalidResponseIntegers)(
    "conserva el CAE y devuelve invalid_response ante número %s",
    async (_label, numeroComprobante) => {
      const options = createBaseOptions();
      const raw = {
        resultado: "A",
        comprobanteResponse: {
          numeroComprobante,
          CAE: "12345678901234",
          fechaVencimientoCAE: "20260311",
        },
        arrayObservaciones: {
          codigoDescripcion: { codigo: 504, descripcion: "Observación" },
        },
      };
      options.soap.execute.mockResolvedValueOnce({
        result: { autorizarComprobanteResponse: raw },
      });
      const outcome = await createWsmtxcaService(options).issue({
        data: { comprobanteCAERequest: { numeroComprobante: 12 } },
      });

      expect(outcome).toMatchObject({
        kind: "indeterminate",
        reason: "invalid_response",
        service: "wsmtxca",
        operation: "autorizarComprobante",
        result: "A",
        resultLevel: "operation",
        results: { operation: "A" },
        cae: "12345678901234",
        caeExpiry: "2026-03-11",
        observations: [{ code: "504", message: "Observación" }],
        raw,
      });
      expect(outcome).not.toHaveProperty("voucherNumber");
      expect(options.soap.execute).toHaveBeenCalledOnce();
    }
  );

  it("no reemplaza un número nulo del comprobante por el número externo", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        autorizarComprobanteResponse: {
          resultado: "R",
          numeroComprobante: 12,
          comprobanteResponse: { numeroComprobante: null },
          arrayErrores: {
            codigoDescripcion: { codigo: 500, descripcion: "Unidad inválida" },
          },
        },
      },
    });
    const outcome = await createWsmtxcaService(options).issue({ data: {} });
    expect(outcome).toMatchObject({
      kind: "indeterminate",
      reason: "invalid_response",
      results: { operation: "R" },
      errors: [{ code: "500" }],
    });
    expect(outcome).not.toHaveProperty("voucherNumber");
  });

  it.each([1, " 00012 ", "99999999"])(
    "autoriza con el número explícito %s",
    async (numeroComprobante) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          autorizarComprobanteResponse: {
            resultado: "O",
            numeroComprobante,
            codigoAutorizacion: "12345678901234",
          },
        },
      });
      await expect(
        createWsmtxcaService(options).issue({ data: {} })
      ).resolves.toMatchObject({
        kind: "authorized",
        voucherNumber: Number(numeroComprobante),
      });
    }
  );

  it("mantiene incomplete_response cuando falta el número autorizado", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        autorizarComprobanteResponse: {
          resultado: "A",
          comprobanteResponse: { CAE: "12345678901234" },
        },
      },
    });
    await expect(
      createWsmtxcaService(options).issue({ data: {} })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "incomplete_response",
      cae: "12345678901234",
    });
  });

  describe.each(voucherIdentityFields)("consulta: %s", (field, target, max) => {
    it.each([
      ...invalidResponseIntegers,
      ["límite excedido", max + 1] as const,
    ])("rechaza %s sin inventar datos de identidad", async (_label, value) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          consultarComprobanteResponse: {
            comprobante: { [field]: value, fechaEmision: "20260301" },
          },
        },
      });
      await expect(
        createWsmtxcaService(options).lookupVoucher({
          voucherType: 6,
          salesPoint: 8,
          voucherNumber: 25,
        })
      ).rejects.toMatchObject({
        name: "ArcaInvalidSoapResponseError",
        message: `Invalid WSMTXCA ${field}`,
        service: "wsmtxca",
        operation: "consultarComprobante",
      });
      expect(options.soap.execute).toHaveBeenCalledOnce();
    });

    it.each([undefined, 1, " 00012 ", max, String(max)])(
      "conserva la ausencia y acepta el entero %s",
      async (value) => {
        const options = createBaseOptions();
        options.soap.execute.mockResolvedValueOnce({
          result: {
            consultarComprobanteResponse: {
              comprobante: { [field]: value, fechaEmision: "20260301" },
            },
          },
        });
        const outcome = await createWsmtxcaService(options).lookupVoucher({
          voucherType: 6,
          salesPoint: 8,
          voucherNumber: 25,
        });
        expect(outcome.kind).toBe("found");
        if (outcome.kind !== "found") {
          throw new Error("Se esperaba el comprobante consultado");
        }
        if (value === undefined) {
          expect(outcome.voucher).not.toHaveProperty(target);
        } else {
          expect(outcome.voucher).toHaveProperty(target, Number(value));
        }
      }
    );
  });

  it.each([
    ...invalidResponseIntegers,
    ["ausente", undefined] as const,
    ["límite excedido", 100_000] as const,
  ])("rechaza toda la lista ante punto de venta %s", async (_label, value) => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        consultarPuntosVentaResponse: {
          arrayPuntosVenta: {
            puntoVenta: [{ numeroPuntoVenta: 1 }, { numeroPuntoVenta: value }],
          },
        },
      },
    });
    await expect(
      createWsmtxcaService(options).getSalesPoints()
    ).rejects.toMatchObject({
      name: "ArcaInvalidSoapResponseError",
      service: "wsmtxca",
      operation: "consultarPuntosVenta",
    });
    expect(options.soap.execute).toHaveBeenCalledOnce();
  });

  it.each([null, 0, false, "", "12", {}, [null]])(
    "rechaza una entrada de punto de venta mal formada: %j",
    async (puntoVenta) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          consultarPuntosVentaResponse: { arrayPuntosVenta: { puntoVenta } },
        },
      });
      await expect(
        createWsmtxcaService(options).getSalesPoints()
      ).rejects.toBeInstanceOf(ArcaInvalidSoapResponseError);
    }
  );

  it.each([1, " 00012 ", 99_999, "99999"])(
    "acepta el punto de venta explícito %s",
    async (numeroPuntoVenta) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce({
        result: {
          consultarPuntosVentaResponse: {
            arrayPuntosVenta: { puntoVenta: { numeroPuntoVenta } },
          },
        },
      });
      await expect(
        createWsmtxcaService(options).getSalesPoints()
      ).resolves.toMatchObject({
        salesPoints: [{ number: Number(numeroPuntoVenta) }],
      });
    }
  );

  it.each([
    {},
    { arrayPuntosVenta: {} },
    { arrayPuntosVenta: { puntoVenta: [] } },
  ])("conserva una lista de puntos de venta vacía", async (raw) => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: { consultarPuntosVentaResponse: raw },
    });
    await expect(
      createWsmtxcaService(options).getSalesPoints()
    ).resolves.toMatchObject({ salesPoints: [] });
  });
});
