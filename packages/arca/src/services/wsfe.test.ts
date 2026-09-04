import { describe, expect, it, vi } from "vitest";
import { ArcaTransportError } from "../errors";
import type { WsfeVoucherInput } from "./wsfe";
import { createWsfeService } from "./wsfe";

function createBaseOptions() {
  const auth = {
    login: vi.fn().mockResolvedValue({
      token: "token",
      sign: "sign",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  };
  const soap = {
    execute: vi.fn(),
  };

  return {
    config: {
      taxId: "20123456789",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "test" as const,
    },
    auth,
    soap,
  };
}

function createBaseVoucherInput(
  overrides: Partial<WsfeVoucherInput> = {}
): WsfeVoucherInput {
  return {
    salesPoint: 1,
    voucherType: 6,
    concept: 1,
    documentType: 80,
    documentNumber: 30_717_329_654,
    receiverVatConditionId: 5,
    voucherDate: "20260501",
    totalAmount: 121,
    nonTaxableAmount: 0,
    netAmount: 100,
    exemptAmount: 0,
    taxAmount: 0,
    vatAmount: 21,
    currencyId: "PES",
    exchangeRate: 1,
    vatRates: [{ id: 5, baseAmount: 100, amount: 21 }],
    ...overrides,
  };
}

function createWsfeOperationResult(
  operation: string,
  result: Record<string, unknown>
) {
  return {
    result: {
      [`${operation}Response`]: {
        [`${operation}Result`]: result,
      },
    },
  };
}

describe("createWsfeService", () => {
  it("authorizes a voucher with an explicit WSFE number", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "123456789",
                CAEFchVto: "20260501",
              },
            },
          },
        },
      },
    });

    const service = createWsfeService(options);
    const result = await service.authorizeVoucher({
      representedTaxId: "20304050607",
      data: createBaseVoucherInput(),
      voucherNumber: 26_506,
    });

    expect(result).toEqual({
      cae: "123456789",
      caeExpiry: "20260501",
      voucherNumber: 26_506,
      raw: {
        FeDetResp: {
          FECAEDetResponse: {
            Resultado: "A",
            CAE: "123456789",
            CAEFchVto: "20260501",
          },
        },
      },
    });
    expect(options.auth.login).toHaveBeenCalledOnce();
    expect(options.auth.login).toHaveBeenCalledWith("wsfe", {
      representedTaxId: "20304050607",
    });
    expect(options.soap.execute).toHaveBeenCalledOnce();
    expect(options.soap.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "wsfe",
        operation: "FECAESolicitar",
        body: expect.objectContaining({
          FeCAEReq: expect.objectContaining({
            FeCabReq: {
              CantReg: 1,
              PtoVta: 1,
              CbteTipo: 6,
            },
            FeDetReq: {
              FECAEDetRequest: expect.objectContaining({
                CbteDesde: 26_506,
                CbteHasta: 26_506,
              }),
            },
          }),
        }),
      })
    );
  });

  it("returns authorized evidence with every WSFE observation", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeCabResp: { Resultado: "A" },
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "123456789",
                CAEFchVto: "20260501",
                Observaciones: {
                  Obs: [
                    { Code: 10_041, Msg: "Primera observación" },
                    { Code: 10_042, Msg: "Segunda observación" },
                  ],
                },
              },
            },
          },
        },
      },
    });

    const outcome = await createWsfeService(options).authorizeVoucherOutcome({
      data: createBaseVoucherInput(),
      voucherNumber: 77,
    });

    expect(outcome).toMatchObject({
      kind: "authorized",
      service: "wsfe",
      operation: "FECAESolicitar",
      result: "A",
      resultLevel: "detail",
      results: { header: "A", detail: "A" },
      cae: "123456789",
      caeExpiry: "20260501",
      voucherNumber: 77,
      errors: [],
      observations: [
        {
          source: "observation",
          category: "observation",
          code: "10041",
          message: "Primera observación",
        },
        {
          source: "observation",
          category: "observation",
          code: "10042",
          message: "Segunda observación",
        },
      ],
    });
    expect(options.soap.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "FECAESolicitar",
        retries: 0,
      })
    );
  });

  it("classifies detail and header WSFE rejections from structured results", async () => {
    const detailOptions = createBaseOptions();
    detailOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "R",
                Observaciones: {
                  Obs: [
                    { Code: 10_016, Msg: "Número incorrecto" },
                    { Code: 10_017, Msg: "Fecha inválida" },
                  ],
                },
              },
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(detailOptions).authorizeVoucherOutcome({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      kind: "rejected",
      result: "R",
      resultLevel: "detail",
      observations: [
        { code: "10016", message: "Número incorrecto" },
        { code: "10017", message: "Fecha inválida" },
      ],
    });

    const headerOptions = createBaseOptions();
    headerOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeCabResp: { Resultado: "R" },
            Errors: {
              Err: [
                { Code: 10_002, Msg: "CantReg inválido" },
                { Code: 1005, Msg: "Punto de venta inválido" },
              ],
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(headerOptions).authorizeVoucherOutcome({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      kind: "rejected",
      result: "R",
      resultLevel: "header",
      errors: [
        { category: "business", code: "10002" },
        { category: "business", code: "1005" },
      ],
    });
  });

  it("keeps WSFE infrastructure and contradictory responses indeterminate", async () => {
    const infrastructureOptions = createBaseOptions();
    infrastructureOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeCabResp: { Resultado: "R" },
            Errors: {
              Err: { Code: 502, Msg: "Transacción activa" },
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(infrastructureOptions).authorizeVoucherOutcome({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      result: "R",
      reason: "incomplete_response",
      errors: [{ category: "infrastructure", code: "502" }],
    });

    const contradictoryOptions = createBaseOptions();
    contradictoryOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeCabResp: { Resultado: "A" },
            FeDetResp: {
              FECAEDetResponse: { Resultado: "R", CAE: "123" },
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(contradictoryOptions).authorizeVoucherOutcome({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "contradictory_response",
      results: { header: "A", detail: "R" },
      cae: "123",
    });
  });

  it("returns transport failures as indeterminate without retrying authorization", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockRejectedValueOnce(
      new ArcaTransportError("connection lost")
    );

    await expect(
      createWsfeService(options).authorizeVoucherOutcome({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      service: "wsfe",
      operation: "FECAESolicitar",
      reason: "transport_error",
    });
    expect(options.soap.execute).toHaveBeenCalledOnce();
  });

  it("records typed authentication evidence without retrying exact outcomes", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FECAESolicitar", {
        Errors: {
          Err: {
            Code: 600,
            Msg: "ValidacionDeToken: token y firma rechazados",
          },
        },
      })
    );

    await expect(
      createWsfeService(options).authorizeVoucherOutcome({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "authentication_rejected",
      authentication: {
        code: "ARCA_AUTHENTICATION_ERROR",
        reason: "invalid_token",
        providerCode: "600",
      },
    });
    expect(options.auth.login).toHaveBeenCalledOnce();
    expect(options.soap.execute).toHaveBeenCalledOnce();
    expect(options.soap.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "FECAESolicitar", retries: 0 })
    );
  });

  it("retries an explicit WSFE authentication rejection once with the same authorization", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfeOperationResult("FECAESolicitar", {
          Errors: {
            Err: { Code: 600, Msg: "No se corresponden token y firma" },
          },
        })
      )
      .mockResolvedValueOnce(
        createWsfeOperationResult("FECAESolicitar", {
          FeDetResp: {
            FECAEDetResponse: {
              Resultado: "A",
              CAE: "123456789",
              CAEFchVto: "20260501",
            },
          },
        })
      );

    await expect(
      createWsfeService(options).authorizeVoucher({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).resolves.toMatchObject({
      cae: "123456789",
      voucherNumber: 77,
    });

    expect(options.auth.login).toHaveBeenCalledTimes(2);
    expect(options.auth.login).toHaveBeenNthCalledWith(
      2,
      "wsfe",
      expect.objectContaining({ forceRefresh: true })
    );
    expect(options.soap.execute).toHaveBeenCalledTimes(2);
    for (const [request] of options.soap.execute.mock.calls) {
      expect(request).toMatchObject({
        operation: "FECAESolicitar",
        retries: 0,
        body: {
          FeCAEReq: {
            FeDetReq: {
              FECAEDetRequest: {
                CbteDesde: 77,
                CbteHasta: 77,
              },
            },
          },
        },
      });
    }
  });

  it("does not retry authorization after forceRefresh or an indeterminate failure", async () => {
    const forcedOptions = createBaseOptions();
    forcedOptions.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FECAESolicitar", {
        Errors: {
          Err: { Code: 601, Msg: "CUIT representada no incluida en token" },
        },
      })
    );

    await expect(
      createWsfeService(forcedOptions).authorizeVoucher({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
        forceRefresh: true,
      })
    ).rejects.toMatchObject({
      name: "ArcaAuthenticationError",
      reason: "missing_relationship",
    });
    expect(forcedOptions.auth.login).toHaveBeenCalledOnce();
    expect(forcedOptions.soap.execute).toHaveBeenCalledOnce();

    const transportOptions = createBaseOptions();
    transportOptions.soap.execute.mockRejectedValueOnce(
      new ArcaTransportError("connection lost")
    );
    await expect(
      createWsfeService(transportOptions).authorizeVoucher({
        data: createBaseVoucherInput(),
        voucherNumber: 77,
      })
    ).rejects.toBeInstanceOf(ArcaTransportError);
    expect(transportOptions.auth.login).toHaveBeenCalledOnce();
    expect(transportOptions.soap.execute).toHaveBeenCalledOnce();
  });

  it("recovers read operations only from explicit authentication errors", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfeOperationResult("FEParamGetTiposCbte", {
          Errors: {
            Err: { Code: 600, Msg: "No se corresponden token y firma" },
          },
        })
      )
      .mockResolvedValueOnce(
        createWsfeOperationResult("FEParamGetTiposCbte", {
          ResultGet: {
            CbteTipo: { Id: 6, Desc: "Factura B" },
          },
        })
      );

    await expect(
      createWsfeService(options).getVoucherTypes({})
    ).resolves.toEqual([{ id: 6, description: "Factura B" }]);
    expect(options.auth.login).toHaveBeenCalledTimes(2);
    expect(options.auth.login).toHaveBeenNthCalledWith(
      2,
      "wsfe",
      expect.objectContaining({ forceRefresh: true })
    );
    expect(options.soap.execute).toHaveBeenCalledTimes(2);

    const businessOptions = createBaseOptions();
    businessOptions.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FEParamGetTiposCbte", {
        Errors: { Err: { Code: 700, Msg: "Error de catálogo" } },
      })
    );
    await expect(
      createWsfeService(businessOptions).getVoucherTypes({})
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      serviceCode: "700",
    });
    expect(businessOptions.auth.login).toHaveBeenCalledOnce();
    expect(businessOptions.soap.execute).toHaveBeenCalledOnce();
  });

  it("defaults an omitted peso exchange rate to one", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "123456789",
                CAEFchVto: "20260501",
              },
            },
          },
        },
      },
    });

    await createWsfeService(options).authorizeVoucher({
      data: createBaseVoucherInput({ exchangeRate: undefined }),
      voucherNumber: 42,
    });

    expect(
      options.soap.execute.mock.calls[0]?.[0].body.FeCAEReq.FeDetReq
        .FECAEDetRequest
    ).toMatchObject({
      MonId: "PES",
      MonCotiz: "1",
    });
  });

  it("serializes every exact WSFE amount and exchange rate canonically", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "123456789",
                CAEFchVto: "20260501",
              },
            },
          },
        },
      },
    });

    await createWsfeService(options).authorizeVoucher({
      data: createBaseVoucherInput({
        totalAmount: 0.1 + 0.2,
        netAmount: 0.3,
        vatAmount: 0,
        vatRates: undefined,
        currencyId: "DOL",
        exchangeRate: "1095.500000",
      }),
      voucherNumber: 42,
    });

    expect(
      options.soap.execute.mock.calls[0]?.[0].body.FeCAEReq.FeDetReq
        .FECAEDetRequest
    ).toMatchObject({
      ImpTotal: "0.30",
      ImpTotConc: "0.00",
      ImpNeto: "0.30",
      ImpOpEx: "0.00",
      ImpTrib: "0.00",
      ImpIVA: "0.00",
      MonId: "DOL",
      MonCotiz: "1095.5",
    });
    expect(options.soap.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "FECAESolicitar", retries: 0 })
    );
  });

  it.each([
    {
      overrides: { totalAmount: 259.2576 },
      code: "ARCA_INPUT_AMOUNT_PRECISION",
      field: "totalAmount",
    },
    {
      overrides: { netAmount: -1 },
      code: "ARCA_INPUT_INVALID_AMOUNT",
      field: "netAmount",
    },
    {
      overrides: { vatRates: [{ id: 5, baseAmount: 100, amount: 21.001 }] },
      code: "ARCA_INPUT_AMOUNT_PRECISION",
      field: "vatRates[0].amount",
    },
    {
      overrides: {
        taxes: [{ id: 99, baseAmount: 100, rate: 1.001, amount: 0 }],
      },
      code: "ARCA_INPUT_AMOUNT_PRECISION",
      field: "taxes[0].rate",
    },
  ])("rejects invalid exact amount precision before authentication", ({
    overrides,
    code,
    field,
  }) => {
    const options = createBaseOptions();

    expect(() =>
      createWsfeService(options).authorizeVoucher({
        data: createBaseVoucherInput(overrides),
        voucherNumber: 42,
      })
    ).toThrowError(
      expect.objectContaining({ name: "ArcaInputError", code, field })
    );
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      overrides: { totalAmount: 122 },
      field: "totalAmount",
    },
    {
      overrides: { totalAmount: 120, vatAmount: 20 },
      field: "vatAmount",
    },
    {
      overrides: { totalAmount: 122, netAmount: 101 },
      field: "netAmount",
    },
    {
      overrides: {
        totalAmount: 131,
        taxAmount: 10,
        taxes: [{ id: 99, baseAmount: 100, rate: 10, amount: 8 }],
      },
      field: "taxAmount",
    },
  ])("rejects exact amount mismatches at $field before authentication", ({
    overrides,
    field,
  }) => {
    const options = createBaseOptions();

    expect(() =>
      createWsfeService(options).authorizeVoucherOutcome({
        data: createBaseVoucherInput(overrides),
        voucherNumber: 42,
      })
    ).toThrowError(
      expect.objectContaining({
        name: "ArcaInputError",
        code: "ARCA_INPUT_AMOUNT_MISMATCH",
        field,
      })
    );
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it.each([
    2, 3, 7, 8, 52, 53,
  ])("allows voucher type %s to use ARCA's exempt VAT-base reconciliation", async (voucherType) => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FECAESolicitar", {
        FeDetResp: {
          FECAEDetResponse: {
            Resultado: "A",
            CAE: "1",
            CAEFchVto: "20260501",
          },
        },
      })
    );

    await expect(
      createWsfeService(options).authorizeVoucher({
        data: createBaseVoucherInput({
          voucherType,
          vatRates: [{ id: 5, baseAmount: 90, amount: 21 }],
        }),
        voucherNumber: 42,
      })
    ).resolves.toMatchObject({ cae: "1" });
  });

  it("still reconciles VAT totals for voucher types exempt from VAT-base reconciliation", () => {
    const options = createBaseOptions();

    expect(() =>
      createWsfeService(options).authorizeVoucher({
        data: createBaseVoucherInput({
          voucherType: 7,
          vatRates: [{ id: 5, baseAmount: 90, amount: 20 }],
        }),
        voucherNumber: 42,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_AMOUNT_MISMATCH",
        field: "vatAmount",
      })
    );
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it("accepts the documented absolute and relative reconciliation tolerances", async () => {
    const absoluteOptions = createBaseOptions();
    absoluteOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "1",
                CAEFchVto: "20260501",
              },
            },
          },
        },
      },
    });
    await expect(
      createWsfeService(absoluteOptions).authorizeVoucher({
        data: createBaseVoucherInput({ totalAmount: 121.01 }),
        voucherNumber: 1,
      })
    ).resolves.toMatchObject({ cae: "1" });

    const relativeOptions = createBaseOptions();
    relativeOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECAESolicitarResponse: {
          FECAESolicitarResult: {
            FeDetResp: {
              FECAEDetResponse: {
                Resultado: "A",
                CAE: "2",
                CAEFchVto: "20260501",
              },
            },
          },
        },
      },
    });
    await expect(
      createWsfeService(relativeOptions).authorizeVoucher({
        data: createBaseVoucherInput({
          totalAmount: 10_001,
          netAmount: 10_000,
          vatAmount: 0,
          vatRates: undefined,
        }),
        voucherNumber: 2,
      })
    ).resolves.toMatchObject({ cae: "2" });
  });

  it("requires receiver VAT condition and monetary detail before authentication", () => {
    const receiverOptions = createBaseOptions();
    expect(() =>
      createWsfeService(receiverOptions).authorizeVoucher({
        data: createBaseVoucherInput({
          receiverVatConditionId: undefined as never,
        }),
        voucherNumber: 42,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "receiverVatConditionId",
      })
    );
    expect(receiverOptions.auth.login).not.toHaveBeenCalled();

    const vatOptions = createBaseOptions();
    expect(() =>
      createWsfeService(vatOptions).authorizeVoucher({
        data: createBaseVoucherInput({ vatRates: undefined }),
        voucherNumber: 42,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "vatRates",
      })
    );
    expect(vatOptions.auth.login).not.toHaveBeenCalled();

    const taxOptions = createBaseOptions();
    expect(() =>
      createWsfeService(taxOptions).authorizeVoucher({
        data: createBaseVoucherInput({ totalAmount: 131, taxAmount: 10 }),
        voucherNumber: 42,
      })
    ).toThrowError(
      expect.objectContaining({
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "taxes",
      })
    );
    expect(taxOptions.auth.login).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a non-unit peso rate",
      overrides: { exchangeRate: 1.01 },
      code: "ARCA_INPUT_INVALID_EXCHANGE_RATE",
      message: "exchangeRate must be 1 when currencyId is PES.",
    },
    {
      name: "a missing foreign-currency rate",
      overrides: { currencyId: "USD", exchangeRate: undefined },
      code: "ARCA_INPUT_MISSING_FIELD",
      message:
        "exchangeRate is required unless sameCurrencyForeignCancellation is S for a foreign-currency voucher.",
    },
    {
      name: "a non-positive foreign-currency rate",
      overrides: { currencyId: "USD", exchangeRate: 0 },
      code: "ARCA_INPUT_INVALID_EXCHANGE_RATE",
      message:
        "exchangeRate must be a positive decimal with at most 4 integer and 6 fractional digits.",
    },
  ])("rejects $name before network work", async ({
    overrides,
    code,
    message,
  }) => {
    const options = createBaseOptions();

    await expect(
      createWsfeService(options).createNextVoucher({
        data: createBaseVoucherInput(overrides),
      })
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      code,
      field: "exchangeRate",
      message,
    });
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it("creates the next voucher and wraps WSFE collection fields", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 41,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: [
                  {
                    Resultado: "A",
                    CAE: "123456789",
                    CAEFchVto: "20260501",
                  },
                ],
              },
            },
          },
        },
      });

    const service = createWsfeService(options);
    const result = await service.createNextVoucher({
      representedTaxId: "20304050607",
      forceRefresh: true,
      data: createBaseVoucherInput({
        currencyId: "USD",
        totalAmount: 131,
        taxAmount: 10,
        associatedVouchers: [{ type: 1, salesPoint: 1, number: 1 }],
        taxes: [{ id: 99, baseAmount: 100, rate: 10, amount: 10 }],
        vatRates: [{ id: 5, baseAmount: 100, amount: 21 }],
        optionalFields: [{ id: "27", value: "test" }],
        activities: [{ id: 46_123 }],
        sameCurrencyForeignCancellation: "S",
      }),
    });

    expect(result).toEqual({
      cae: "123456789",
      caeExpiry: "20260501",
      voucherNumber: 42,
      raw: {
        FeDetResp: {
          FECAEDetResponse: [
            {
              Resultado: "A",
              CAE: "123456789",
              CAEFchVto: "20260501",
            },
          ],
        },
      },
    });
    expect(options.auth.login).toHaveBeenNthCalledWith(1, "wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.auth.login).toHaveBeenNthCalledWith(2, "wsfe", {
      representedTaxId: "20304050607",
    });
    expect(options.soap.execute.mock.calls[1]?.[0]).toMatchObject({
      service: "wsfe",
      operation: "FECAESolicitar",
      body: {
        Auth: {
          Token: "token",
          Sign: "sign",
          Cuit: 20_304_050_607,
        },
        FeCAEReq: {
          FeCabReq: {
            CantReg: 1,
            PtoVta: 1,
            CbteTipo: 6,
          },
          FeDetReq: {
            FECAEDetRequest: {
              CbteDesde: 42,
              CbteHasta: 42,
              CondicionIVAReceptorId: 5,
              CanMisMonExt: "S",
              MonId: "USD",
              CbtesAsoc: {
                CbteAsoc: [{ Tipo: 1, PtoVta: 1, Nro: 1 }],
              },
              Tributos: {
                Tributo: [
                  {
                    Id: 99,
                    BaseImp: "100.00",
                    Alic: "10.00",
                    Importe: "10.00",
                  },
                ],
              },
              Iva: {
                AlicIva: [{ Id: 5, BaseImp: "100.00", Importe: "21.00" }],
              },
              Opcionales: {
                Opcional: [{ Id: "27", Valor: "test" }],
              },
              Actividades: {
                Actividad: [{ Id: 46_123 }],
              },
            },
          },
        },
      },
    });
  });

  it("retries createNextVoucher with the originally fetched voucher number", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfeOperationResult("FECompUltimoAutorizado", { CbteNro: 41 })
      )
      .mockResolvedValueOnce(
        createWsfeOperationResult("FECAESolicitar", {
          Errors: {
            Err: { Code: 600, Msg: "No se corresponden token y firma" },
          },
        })
      )
      .mockResolvedValueOnce(
        createWsfeOperationResult("FECAESolicitar", {
          FeDetResp: {
            FECAEDetResponse: {
              Resultado: "A",
              CAE: "123456789",
              CAEFchVto: "20260501",
            },
          },
        })
      );

    await expect(
      createWsfeService(options).createNextVoucher({
        data: createBaseVoucherInput(),
      })
    ).resolves.toMatchObject({ voucherNumber: 42, cae: "123456789" });

    expect(options.soap.execute).toHaveBeenCalledTimes(3);
    expect(
      options.soap.execute.mock.calls.map(([request]) => request.operation)
    ).toEqual(["FECompUltimoAutorizado", "FECAESolicitar", "FECAESolicitar"]);
    const authorizationRequests = options.soap.execute.mock.calls.slice(1);
    for (const [request] of authorizationRequests) {
      expect(request.body.FeCAEReq.FeDetReq.FECAEDetRequest).toMatchObject({
        CbteDesde: 42,
        CbteHasta: 42,
      });
      expect(request.retries).toBe(0);
    }
    expect(options.auth.login).toHaveBeenCalledTimes(3);
    expect(options.auth.login).toHaveBeenLastCalledWith(
      "wsfe",
      expect.objectContaining({ forceRefresh: true })
    );
  });

  it("omits MonCotiz when foreign-currency vouchers are cancelled in the same currency", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 41,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: [
                  {
                    Resultado: "A",
                    CAE: "123456789",
                    CAEFchVto: "20260501",
                  },
                ],
              },
            },
          },
        },
      });

    await createWsfeService(options).createNextVoucher({
      data: createBaseVoucherInput({
        currencyId: "USD",
        exchangeRate: undefined,
        sameCurrencyForeignCancellation: "S",
      }),
    });

    const request =
      options.soap.execute.mock.calls[1]?.[0].body.FeCAEReq.FeDetReq
        .FECAEDetRequest;

    expect(request).toMatchObject({
      MonId: "USD",
      CanMisMonExt: "S",
    });
    expect(request).not.toHaveProperty("MonCotiz");
  });

  it("does not send CanMisMonExt for peso vouchers", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 41,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: [
                  {
                    Resultado: "A",
                    CAE: "123456789",
                    CAEFchVto: "20260501",
                  },
                ],
              },
            },
          },
        },
      });

    await createWsfeService(options).createNextVoucher({
      data: createBaseVoucherInput({
        sameCurrencyForeignCancellation: "S",
      }),
    });

    const request =
      options.soap.execute.mock.calls[1]?.[0].body.FeCAEReq.FeDetReq
        .FECAEDetRequest;

    expect(request).toMatchObject({
      MonId: "PES",
      MonCotiz: "1",
    });
    expect(request).not.toHaveProperty("CanMisMonExt");
  });

  it("normalizes supported date inputs before sending the SOAP request", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 41,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: [
                  {
                    Resultado: "A",
                    CAE: "123456789",
                    CAEFchVto: "20260501",
                  },
                ],
              },
            },
          },
        },
      });

    const service = createWsfeService(options);
    await service.createNextVoucher({
      data: createBaseVoucherInput({
        voucherDate: "2026-05-01",
        serviceStartDate: "2026-05-01",
        serviceEndDate: "2026-05-31",
        paymentDueDate: "20260510",
        associatedVouchers: [
          {
            type: 1,
            salesPoint: 1,
            number: 1,
            voucherDate: "2026-04-30",
          },
        ],
      }),
    });

    expect(options.soap.execute.mock.calls[1]?.[0]).toMatchObject({
      body: {
        FeCAEReq: {
          FeDetReq: {
            FECAEDetRequest: {
              CbteFch: "20260501",
              FchServDesde: "20260501",
              FchServHasta: "20260531",
              FchVtoPago: "20260510",
              CbtesAsoc: {
                CbteAsoc: [
                  {
                    CbteFch: "20260430",
                  },
                ],
              },
            },
          },
        },
      },
    });
  });

  it("sends PeriodoAsoc with normalized dates when provided", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 41,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: [
                  {
                    Resultado: "A",
                    CAE: "123456789",
                    CAEFchVto: "20260501",
                  },
                ],
              },
            },
          },
        },
      });

    const service = createWsfeService(options);
    await service.createNextVoucher({
      data: createBaseVoucherInput({
        associatedPeriod: {
          startDate: "2026-05-01",
          endDate: "20260531",
        },
      }),
    });

    expect(options.soap.execute.mock.calls[1]?.[0]).toMatchObject({
      body: {
        FeCAEReq: {
          FeDetReq: {
            FECAEDetRequest: {
              PeriodoAsoc: {
                FchDesde: "20260501",
                FchHasta: "20260531",
              },
            },
          },
        },
      },
    });
  });

  it("rejects invalid associated period dates before SOAP calls", async () => {
    const options = createBaseOptions();
    const service = createWsfeService(options);

    await expect(
      service.createNextVoucher({
        data: createBaseVoucherInput({
          associatedPeriod: {
            startDate: "05/01/2026" as never,
            endDate: "20260531",
          },
        }),
      })
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      code: "ARCA_INPUT_INVALID_DATE",
      field: "associatedPeriod.startDate",
      message:
        "Invalid WSFE associatedPeriod.startDate: expected a YYYY-MM-DD or YYYYMMDD string",
    });

    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it("allows destructuring without breaking createNextVoucher", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: { CbteNro: 0 },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: [
                  { Resultado: "A", CAE: "999", CAEFchVto: "20260601" },
                ],
              },
            },
          },
        },
      });

    const { createNextVoucher } = createWsfeService(options);
    const result = await createNextVoucher({
      data: createBaseVoucherInput(),
    });

    expect(result.cae).toBe("999");
  });

  it("supports both next-voucher method names", async () => {
    const nextNumberOptions = createBaseOptions();
    nextNumberOptions.soap.execute.mockResolvedValue({
      result: {
        FECompUltimoAutorizadoResponse: {
          FECompUltimoAutorizadoResult: {
            CbteNro: 41,
          },
        },
      },
    });

    const service = createWsfeService(nextNumberOptions);

    await expect(
      service.getNextVoucherNumber({
        salesPoint: 1,
        voucherType: 6,
      })
    ).resolves.toBe(42);
    await expect(
      service.getLastVoucher({
        salesPoint: 1,
        voucherType: 6,
      })
    ).resolves.toBe(42);
  });

  it("raises service errors for rejected vouchers and missing CAE data", async () => {
    const rejectedOptions = createBaseOptions();
    rejectedOptions.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 4,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: {
                  Resultado: "R",
                  Observaciones: {
                    Obs: {
                      Code: 10_017,
                      Msg: "Comprobante rechazado",
                    },
                  },
                },
              },
            },
          },
        },
      });

    await expect(
      createWsfeService(rejectedOptions).createNextVoucher({
        data: createBaseVoucherInput(),
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      serviceCode: "10017",
      message: "(10017) Comprobante rechazado",
    });

    const missingCaeOptions = createBaseOptions();
    missingCaeOptions.soap.execute
      .mockResolvedValueOnce({
        result: {
          FECompUltimoAutorizadoResponse: {
            FECompUltimoAutorizadoResult: {
              CbteNro: 9,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECAESolicitarResponse: {
            FECAESolicitarResult: {
              FeDetResp: {
                FECAEDetResponse: {
                  Resultado: "A",
                },
              },
            },
          },
        },
      });

    await expect(
      createWsfeService(missingCaeOptions).createNextVoucher({
        data: createBaseVoucherInput(),
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      message: "WSFE did not return CAE authorization data",
    });
  });

  it("fails fast on invalid public date inputs", async () => {
    const options = createBaseOptions();
    const service = createWsfeService(options);

    await expect(
      service.createNextVoucher({
        data: createBaseVoucherInput({
          voucherDate: "05/01/2026" as never,
        }),
      })
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      code: "ARCA_INPUT_INVALID_DATE",
      field: "voucherDate",
      message:
        "Invalid WSFE voucherDate: expected a YYYY-MM-DD or YYYYMMDD string",
    });

    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it("rejects non-string date values from untyped callers", async () => {
    const options = createBaseOptions();
    const service = createWsfeService(options);

    await expect(
      service.createNextVoucher({
        data: createBaseVoucherInput({
          voucherDate: new Date(2026, 4, 1) as never,
        }),
      })
    ).rejects.toMatchObject({
      name: "ArcaInputError",
      code: "ARCA_INPUT_INVALID_DATE",
      field: "voucherDate",
      message:
        "Invalid WSFE voucherDate: expected a YYYY-MM-DD or YYYYMMDD string",
    });

    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it("supports querying sales points and voucher information", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce({
        result: {
          FEParamGetPtosVentaResponse: {
            FEParamGetPtosVentaResult: {
              ResultGet: {
                PtoVenta: [{ Nro: 1 }, { Nro: 2 }],
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        result: {
          FECompConsultarResponse: {
            FECompConsultarResult: {
              ResultGet: {
                CbteDesde: 77,
                CbteHasta: 77,
                CbteFch: "20260501",
                PtoVta: 1,
                CbteTipo: 6,
                Concepto: 1,
                DocTipo: 80,
                DocNro: "30717329654",
                CondicionIVAReceptorId: 1,
                ImpTotal: 121,
                ImpTotConc: 0,
                ImpNeto: 100,
                ImpOpEx: 0,
                ImpTrib: 0,
                ImpIVA: 21,
                MonId: "PES",
                MonCotiz: 1,
                Resultado: "A",
                CodAutorizacion: "74123456789012",
                FchVto: "20260511",
              },
            },
          },
        },
      });

    const service = createWsfeService(options);

    await expect(
      service.getSalesPoints({
        representedTaxId: "20304050607",
        forceRefresh: true,
      })
    ).resolves.toEqual([{ number: 1 }, { number: 2 }]);

    const singlePointOptions = createBaseOptions();
    singlePointOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FEParamGetPtosVentaResponse: {
          FEParamGetPtosVentaResult: {
            ResultGet: {
              PtoVenta: {
                Nro: "1",
                EmisionTipo: "CAE - Monotributo",
                Bloqueado: "N",
                FchBaja: "NULL",
              },
            },
          },
        },
      },
    });
    await expect(
      createWsfeService(singlePointOptions).getSalesPoints({})
    ).resolves.toEqual([
      {
        number: 1,
        emissionType: "CAE - Monotributo",
        blocked: "N",
        deletedSince: "NULL",
      },
    ]);

    await expect(
      service.getVoucherInfo({
        representedTaxId: "20304050607",
        number: 77,
        salesPoint: 1,
        voucherType: 6,
        forceRefresh: true,
      })
    ).resolves.toEqual({
      voucherNumber: 77,
      voucherDate: "20260501",
      salesPoint: 1,
      voucherType: 6,
      concept: 1,
      documentType: 80,
      documentNumber: "30717329654",
      receiverVatConditionId: 1,
      totalAmount: 121,
      nonTaxableAmount: 0,
      netAmount: 100,
      exemptAmount: 0,
      taxAmount: 0,
      vatAmount: 21,
      currencyId: "PES",
      exchangeRate: 1,
      result: "A",
      cae: "74123456789012",
      caeExpiry: "20260511",
      raw: {
        CbteDesde: 77,
        CbteHasta: 77,
        CbteFch: "20260501",
        PtoVta: 1,
        CbteTipo: 6,
        Concepto: 1,
        DocTipo: 80,
        DocNro: "30717329654",
        CondicionIVAReceptorId: 1,
        ImpTotal: 121,
        ImpTotConc: 0,
        ImpNeto: 100,
        ImpOpEx: 0,
        ImpTrib: 0,
        ImpIVA: 21,
        MonId: "PES",
        MonCotiz: 1,
        Resultado: "A",
        CodAutorizacion: "74123456789012",
        FchVto: "20260511",
      },
    });
    expect(options.auth.login).toHaveBeenLastCalledWith("wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
  });

  it("normalizes only FECompConsultar 602 as voucher absence", async () => {
    const notFoundOptions = createBaseOptions();
    notFoundOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECompConsultarResponse: {
          FECompConsultarResult: {
            Errors: {
              Err: { Code: 602, Msg: "No existen datos" },
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(notFoundOptions).lookupVoucher({
        number: 77,
        salesPoint: 1,
        voucherType: 6,
      })
    ).resolves.toMatchObject({
      kind: "not_found",
      service: "wsfe",
      operation: "FECompConsultar",
      errors: [{ code: "602", message: "No existen datos" }],
    });

    const unavailableOptions = createBaseOptions();
    unavailableOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECompConsultarResponse: {
          FECompConsultarResult: {
            Errors: {
              Err: { Code: 500, Msg: "Servicio no disponible" },
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(unavailableOptions).lookupVoucher({
        number: 77,
        salesPoint: 1,
        voucherType: 6,
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      service: "wsfe",
      operation: "FECompConsultar",
      serviceCode: "500",
    });

    const mixedOptions = createBaseOptions();
    mixedOptions.soap.execute.mockResolvedValueOnce({
      result: {
        FECompConsultarResponse: {
          FECompConsultarResult: {
            Errors: {
              Err: [
                { Code: 602, Msg: "No existen datos" },
                { Code: 500, Msg: "Servicio no disponible" },
              ],
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(mixedOptions).lookupVoucher({
        number: 77,
        salesPoint: 1,
        voucherType: 6,
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      operation: "FECompConsultar",
    });
  });

  it.each([
    {
      name: "voucher types",
      method: "getVoucherTypes",
      operation: "FEParamGetTiposCbte",
      resultKey: "CbteTipo",
      rawEntry: { Id: 1, Desc: "Factura A" },
      expected: [{ id: 1, description: "Factura A" }],
    },
    {
      name: "document types",
      method: "getDocumentTypes",
      operation: "FEParamGetTiposDoc",
      resultKey: "DocTipo",
      rawEntry: { Id: 80, Desc: "CUIT" },
      expected: [{ id: 80, description: "CUIT" }],
    },
    {
      name: "concept types",
      method: "getConceptTypes",
      operation: "FEParamGetTiposConcepto",
      resultKey: "ConceptoTipo",
      rawEntry: { Id: 2, Desc: "Servicios" },
      expected: [{ id: 2, description: "Servicios" }],
    },
    {
      name: "vat rates",
      method: "getVatRates",
      operation: "FEParamGetTiposIva",
      resultKey: "IvaTipo",
      rawEntry: { Id: "5", Desc: "21%" },
      expected: [{ id: 5, description: "21%" }],
    },
    {
      name: "tax types",
      method: "getTaxTypes",
      operation: "FEParamGetTiposTributos",
      resultKey: "TributoTipo",
      rawEntry: { Id: 99, Desc: "Impuesto municipal" },
      expected: [{ id: 99, description: "Impuesto municipal" }],
    },
    {
      name: "optional field types",
      method: "getOptionalTypes",
      operation: "FEParamGetTiposOpcional",
      resultKey: "OpcionalTipo",
      rawEntry: { Id: "27", Desc: "Referencia comercial" },
      expected: [{ id: 27, description: "Referencia comercial" }],
    },
  ])("retrieves %s", async ({
    method,
    operation,
    resultKey,
    rawEntry,
    expected,
  }) => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult(operation, {
        ResultGet: {
          [resultKey]: rawEntry,
        },
      })
    );

    const service = createWsfeService(options);
    const execute = service[method as keyof typeof service] as (input: {
      representedTaxId?: number | string;
      forceRefresh?: boolean;
    }) => Promise<unknown>;

    await expect(
      execute({
        representedTaxId: "20304050607",
        forceRefresh: true,
      })
    ).resolves.toEqual(expected);
    expect(options.auth.login).toHaveBeenCalledWith("wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsfe",
      operation,
      body: {
        Auth: {
          Token: "token",
          Sign: "sign",
          Cuit: 20_304_050_607,
        },
      },
    });
  });

  it("retrieves currency types", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FEParamGetTiposMonedas", {
        ResultGet: {
          Moneda: {
            Id: "USD",
            Desc: "Dolar Estadounidense",
            FchDesde: "20200101",
            FchHasta: "NULL",
          },
        },
      })
    );

    const service = createWsfeService(options);

    await expect(
      service.getCurrencyTypes({
        representedTaxId: "20304050607",
        forceRefresh: true,
      })
    ).resolves.toEqual([
      {
        id: "USD",
        description: "Dolar Estadounidense",
        validFrom: "20200101",
        validTo: "NULL",
      },
    ]);
    expect(options.auth.login).toHaveBeenCalledWith("wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsfe",
      operation: "FEParamGetTiposMonedas",
      body: {
        Auth: {
          Token: "token",
          Sign: "sign",
          Cuit: 20_304_050_607,
        },
      },
    });
  });

  it("retrieves activities", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FEParamGetActividades", {
        ResultGet: {
          ActividadesTipo: {
            Id: "46123",
            Orden: "1",
            Desc: "Venta al por menor",
          },
        },
      })
    );

    const service = createWsfeService(options);

    await expect(
      service.getActivities({
        representedTaxId: "20304050607",
        forceRefresh: true,
      })
    ).resolves.toEqual([
      {
        id: 46_123,
        description: "Venta al por menor",
        order: 1,
      },
    ]);
    expect(options.auth.login).toHaveBeenCalledWith("wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsfe",
      operation: "FEParamGetActividades",
      body: {
        Auth: {
          Token: "token",
          Sign: "sign",
          Cuit: 20_304_050_607,
        },
      },
    });
  });

  it("retrieves receiver VAT conditions", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FEParamGetCondicionIvaReceptor", {
        ResultGet: {
          CondicionIvaReceptor: {
            Id: "1",
            Desc: "IVA Responsable Inscripto",
            Cmp_Clase: "A",
          },
        },
      })
    );

    const service = createWsfeService(options);

    await expect(
      service.getReceiverVatConditions({
        representedTaxId: "20304050607",
        voucherClass: "A",
        forceRefresh: true,
      })
    ).resolves.toEqual([
      {
        id: 1,
        description: "IVA Responsable Inscripto",
        voucherClass: "A",
      },
    ]);
    expect(options.auth.login).toHaveBeenCalledWith("wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsfe",
      operation: "FEParamGetCondicionIvaReceptor",
      body: {
        Auth: {
          Token: "token",
          Sign: "sign",
          Cuit: 20_304_050_607,
        },
        ClaseCmp: "A",
      },
    });
  });

  it("retrieves server status", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FEDummy", {
        AppServer: "OK",
        DbServer: "OK",
        AuthServer: "OK",
      })
    );

    const service = createWsfeService(options);

    await expect(service.getServerStatus()).resolves.toEqual({
      appServer: "OK",
      dbServer: "OK",
      authServer: "OK",
    });
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsfe",
      operation: "FEDummy",
      body: {},
    });
  });

  it("retrieves quotations", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FEParamGetCotizacion", {
        ResultGet: {
          MonId: "USD",
          MonCotiz: 1095.5,
          FchCotiz: "20260501",
        },
      })
    );

    const service = createWsfeService(options);

    await expect(
      service.getQuotation({
        currencyId: "USD",
        representedTaxId: "20304050607",
        forceRefresh: true,
      })
    ).resolves.toEqual({
      currencyId: "USD",
      rate: 1095.5,
      date: "20260501",
    });
    expect(options.auth.login).toHaveBeenCalledWith("wsfe", {
      representedTaxId: "20304050607",
      forceRefresh: true,
    });
    expect(options.soap.execute).toHaveBeenCalledWith({
      service: "wsfe",
      operation: "FEParamGetCotizacion",
      body: {
        Auth: {
          Token: "token",
          Sign: "sign",
          Cuit: 20_304_050_607,
        },
        MonId: "USD",
      },
    });
  });

  it("raises service errors when WSFE returns error lists", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce({
      result: {
        FEParamGetPtosVentaResponse: {
          FEParamGetPtosVentaResult: {
            Errors: {
              Err: {
                Code: 500,
                Msg: "Servicio no disponible",
              },
            },
          },
        },
      },
    });

    await expect(
      createWsfeService(options).getSalesPoints({})
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      serviceCode: "500",
      message: "(500) Servicio no disponible",
    });
  });
});

// Synthetic service-date/Tributos extensions of the recorded two-rate amount case.
// No private request journal or live CAE is used by these fixtures.
describe("WSFE consultation details for identity matching", () => {
  const resultGet = {
    CbteDesde: 77,
    CbteHasta: 77,
    CbteFch: "20260904",
    PtoVta: 1,
    CbteTipo: 6,
    Concepto: 2,
    DocTipo: 99,
    DocNro: "0",
    CondicionIVAReceptorId: 5,
    ImpTotal: 233.49,
    ImpTotConc: 0,
    ImpNeto: 200,
    ImpOpEx: 0,
    ImpTrib: 2,
    ImpIVA: 31.49,
    MonId: "PES",
    MonCotiz: 1,
    Resultado: "A",
    CodAutorizacion: "74123456789012",
    FchVto: "20260914",
    Iva: {
      AlicIva: [
        { Id: 5, BaseImp: 100, Importe: 21 },
        { Id: 4, BaseImp: 100, Importe: 10.5 },
      ],
    },
    FchServDesde: "20260901",
    FchServHasta: "20260930",
    FchVtoPago: "20261001",
    Tributos: {
      Tributo: {
        Id: 99,
        Desc: "Fixture tax",
        BaseImp: 200,
        Alic: 1,
        Importe: 2,
      },
    },
  };
  it("maps multiple VAT rates, service dates and a single tax from FECompConsultar", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FECompConsultar", { ResultGet: resultGet })
    );
    const found = await createWsfeService(options).lookupVoucher({
      number: 77,
      salesPoint: 1,
      voucherType: 6,
    });
    expect(found).toMatchObject({
      kind: "found",
      voucher: {
        vatRates: [
          { id: 5, baseAmount: 100, amount: 21 },
          { id: 4, baseAmount: 100, amount: 10.5 },
        ],
        serviceStartDate: "20260901",
        serviceEndDate: "20260930",
        paymentDueDate: "20261001",
        taxes: [
          {
            id: 99,
            description: "Fixture tax",
            baseAmount: 200,
            rate: 1,
            amount: 2,
          },
        ],
      },
    });
  });
  it.each([
    undefined,
    {},
    { AlicIva: [{ Id: 5, BaseImp: 100 }] },
    { AlicIva: [null] },
  ])("keeps missing or malformed VAT details absent: %j", async (Iva) => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfeOperationResult("FECompConsultar", {
        ResultGet: { ...resultGet, Iva },
      })
    );
    const found = await createWsfeService(options).lookupVoucher({
      number: 77,
      salesPoint: 1,
      voucherType: 6,
    });
    if (found.kind !== "found") {
      throw new Error("Fixture must be found");
    }
    expect(found.voucher).not.toHaveProperty("vatRates");
  });
});

it("maps associated voucher identities from real consultation fields", async () => {
  const options = createBaseOptions();
  options.soap.execute.mockResolvedValueOnce(
    createWsfeOperationResult("FECompConsultar", {
      ResultGet: {
        CbteDesde: 9,
        CbteHasta: 9,
        PtoVta: 1,
        CbteTipo: 13,
        Resultado: "A",
        CodAutorizacion: "123",
        FchVto: "20260915",
        CbtesAsoc: { CbteAsoc: { Tipo: "11", PtoVta: "1", Nro: "7" } },
      },
    })
  );
  const result = await createWsfeService(options).lookupVoucher({
    salesPoint: 1,
    voucherType: 13,
    number: 9,
  });
  expect(result).toMatchObject({
    kind: "found",
    voucher: { associatedVouchers: [{ type: 11, salesPoint: 1, number: 7 }] },
  });
});
