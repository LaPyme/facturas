import { describe, expect, it, vi } from "vitest";
import { ArcaInputError, ArcaTransportError } from "../errors";
import { classifyArcaAuthenticationCandidate } from "../internal/authentication";
import type { WsfexIssueInput } from "./wsfex";
import { createWsfexService } from "./wsfex";

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
      taxId: "20123456786",
      certificatePem: "cert",
      privateKeyPem: "key",
      environment: "test" as const,
    },
    auth,
    soap,
  };
}

function createGoodsInvoice(
  overrides: Partial<WsfexIssueInput> = {}
): WsfexIssueInput {
  return {
    id: 41,
    number: 7,
    voucherType: 19,
    salesPoint: 3,
    voucherDate: "20261001",
    exportType: 1,
    permitExists: "N",
    destination: 203,
    receiverName: "Joao Da Silva",
    receiverCountryTaxId: "50000000016",
    receiverAddress: "Rua 76 km 34.5 Alagoas",
    currencyId: "DOL",
    exchangeRate: "1450.25",
    totalAmount: 500,
    paymentTerms: "Contado",
    incoterms: "FOB",
    language: 1,
    items: [
      {
        description: "Producto",
        quantity: 2,
        unit: 7,
        unitPrice: "250",
        amount: 500,
      },
    ],
    ...overrides,
  };
}

function createWsfexOperationResult(
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

function createAuthorizeAnswer(
  resultAuth: Record<string, unknown> | undefined,
  error: Record<string, unknown> = { ErrCode: "0", ErrMsg: "OK" }
) {
  return createWsfexOperationResult("FEXAuthorize", {
    ...(resultAuth === undefined ? {} : { FEXResultAuth: resultAuth }),
    FEXErr: error,
    FEXEvents: { EventCode: "0", EventMsg: "OK" },
  });
}

function createAuthorizedResult(overrides: Record<string, unknown> = {}) {
  return {
    Id: "41",
    Cuit: "20123456786",
    Cbte_tipo: "19",
    Punto_vta: "3",
    Cbte_nro: "7",
    Cae: "75123456789012",
    Fch_venc_Cae: "20261011",
    Fch_cbte: "20261001",
    Resultado: "A",
    Reproceso: "N",
    Motivos_Obs: "",
    ...overrides,
  };
}

function getSentBody(
  options: ReturnType<typeof createBaseOptions>,
  call = 0
): Record<string, Record<string, unknown>> {
  return options.soap.execute.mock.calls[call]?.[0].body;
}

describe("createWsfexService issue wire format", () => {
  it("serializes every Cmp field in ClsFEXRequest sequence order", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    await createWsfexService(options).issue(
      createGoodsInvoice({
        voucherType: 20,
        permitExists: "S",
        permits: [{ id: "09052EC01006154G", destination: 203 }],
        receiverTaxId: "PJ54482221-l",
        sameCurrencyForeignCancellation: "N",
        commercialObservations: "Sin observaciones",
        observations: "Nota",
        associatedVouchers: [
          {
            voucherType: 19,
            salesPoint: 3,
            number: 6,
            issuerTaxId: "20123456786",
          },
        ],
        incotermsDetail: "Puerto",
        items: [
          {
            code: "PRO1",
            description: "Producto",
            quantity: 2,
            unit: 7,
            unitPrice: "250",
            discount: 0,
            amount: 500,
          },
        ],
        paymentDate: "20261015",
        activities: [{ id: "011211" }],
      })
    );

    const body = getSentBody(options);
    expect(Object.keys(body)).toEqual(["Auth", "Cmp"]);
    expect(body.Auth).toEqual({
      Token: "token",
      Sign: "sign",
      Cuit: 20_123_456_786,
    });
    expect(Object.keys(body.Cmp ?? {})).toEqual([
      "Id",
      "Fecha_cbte",
      "Cbte_Tipo",
      "Punto_vta",
      "Cbte_nro",
      "Tipo_expo",
      "Permiso_existente",
      "Permisos",
      "Dst_cmp",
      "Cliente",
      "Cuit_pais_cliente",
      "Domicilio_cliente",
      "Id_impositivo",
      "Moneda_Id",
      "Moneda_ctz",
      "CanMisMonExt",
      "Obs_comerciales",
      "Imp_total",
      "Obs",
      "Cmps_asoc",
      "Forma_pago",
      "Incoterms",
      "Incoterms_Ds",
      "Idioma_cbte",
      "Items",
      "Fecha_pago",
      "Actividades",
    ]);
    expect(body.Cmp).toMatchObject({
      Permisos: {
        Permiso: [{ Id_permiso: "09052EC01006154G", Dst_merc: 203 }],
      },
      Cmps_asoc: {
        Cmp_asoc: [
          {
            Cbte_tipo: 19,
            Cbte_punto_vta: 3,
            Cbte_nro: 6,
            Cbte_cuit: "20123456786",
          },
        ],
      },
      Actividades: { Actividad: [{ Id: 11_211 }] },
    });
    const items = body.Cmp?.Items as { Item: Record<string, unknown>[] };
    expect(Object.keys(items.Item[0] ?? {})).toEqual([
      "Pro_codigo",
      "Pro_ds",
      "Pro_qty",
      "Pro_umed",
      "Pro_precio_uni",
      "Pro_bonificacion",
      "Pro_total_item",
    ]);
  });

  it("keeps Permiso_existente empty in place and omits absent optionals", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    await createWsfexService(options).issue({
      id: 42,
      number: 1,
      voucherType: 19,
      salesPoint: 3,
      exportType: 2,
      destination: 203,
      receiverName: "Cliente",
      receiverAddress: "Domicilio",
      receiverTaxId: "X-1",
      currencyId: "DOL",
      sameCurrencyForeignCancellation: "S",
      totalAmount: 100,
      language: 2,
      items: [{ description: "Servicio", unit: 99, amount: 100 }],
    });

    const cmp = getSentBody(options).Cmp ?? {};
    expect(Object.keys(cmp)).toEqual([
      "Id",
      "Cbte_Tipo",
      "Punto_vta",
      "Cbte_nro",
      "Tipo_expo",
      "Permiso_existente",
      "Dst_cmp",
      "Cliente",
      "Domicilio_cliente",
      "Id_impositivo",
      "Moneda_Id",
      "CanMisMonExt",
      "Imp_total",
      "Idioma_cbte",
      "Items",
    ]);
    expect(cmp.Permiso_existente).toBe("");
    expect(cmp.Items).toEqual({
      Item: [{ Pro_ds: "Servicio", Pro_umed: 99, Pro_total_item: "100.00" }],
    });
  });

  it("uses the configured transport retries and the represented CUIT", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    await createWsfexService(options).issue(
      createGoodsInvoice({ representedTaxId: "30712345678" })
    );

    expect(options.auth.login).toHaveBeenCalledWith("wsfex", {
      representedTaxId: "30712345678",
    });
    const request = options.soap.execute.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      service: "wsfex",
      operation: "FEXAuthorize",
    });
    expect(request).not.toHaveProperty("retries");
    expect(request.body.Auth.Cuit).toBe(30_712_345_678);
  });

  it("serializes amounts and N12,6 decimals in their shortest exact form", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    await createWsfexService(options).issue(
      createGoodsInvoice({
        exchangeRate: "1450.250000",
        totalAmount: 489.9,
        items: [
          {
            description: "Producto",
            quantity: 0.1,
            unit: 7,
            unitPrice: "0100.500000",
            discount: 1.25,
            amount: 498.8,
          },
          { description: "Descuento", unit: 99, amount: -8.9 },
        ],
      })
    );

    const cmp = getSentBody(options).Cmp ?? {};
    expect(cmp.Moneda_ctz).toBe("1450.25");
    expect(cmp.Imp_total).toBe("489.90");
    expect(cmp.Items).toEqual({
      Item: [
        {
          Pro_ds: "Producto",
          Pro_qty: "0.1",
          Pro_umed: 7,
          Pro_precio_uni: "100.5",
          Pro_bonificacion: "1.25",
          Pro_total_item: "498.80",
        },
        { Pro_ds: "Descuento", Pro_umed: 99, Pro_total_item: "-8.90" },
      ],
    });
  });

  it("normalizes ISO voucher and payment dates to YYYYMMDD", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    await createWsfexService(options).issue(
      createGoodsInvoice({
        voucherDate: "2026-10-01",
        paymentDate: "2026-10-15",
      })
    );

    expect(getSentBody(options).Cmp).toMatchObject({
      Fecha_cbte: "20261001",
      Fecha_pago: "20261015",
    });
  });

  it("drops empty permit, associated voucher and activity lists", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    await createWsfexService(options).issue(
      createGoodsInvoice({
        permits: [],
        associatedVouchers: [],
        activities: [],
      })
    );

    const cmp = getSentBody(options).Cmp ?? {};
    expect(cmp).not.toHaveProperty("Permisos");
    expect(cmp).not.toHaveProperty("Cmps_asoc");
    expect(cmp).not.toHaveProperty("Actividades");
  });

  it.each<[string, Partial<WsfexIssueInput>]>([
    ["voucherType", { voucherType: 6 as never }],
    ["exportType", { exportType: 3 as never }],
    ["language", { language: 4 as never }],
    ["id", { id: -1 }],
    ["number", { number: 0 }],
    ["salesPoint", { salesPoint: 1.5 }],
    ["voucherDate", { voucherDate: "20260230" }],
    ["paymentDate", { paymentDate: "2026-1015" }],
    ["permitExists", { permitExists: "X" as never }],
    ["receiverCountryTaxId", { receiverCountryTaxId: "5000000001" }],
    ["receiverName", { receiverName: " " }],
    ["exchangeRate", { exchangeRate: "12345.5" }],
    ["totalAmount", { totalAmount: 1.234 }],
    ["items", { items: [] }],
    [
      "items[0].quantity",
      {
        items: [
          { description: "x", quantity: 0.000_000_1, unit: 7, amount: 1 },
        ],
      },
    ],
    [
      "items[0].unitPrice",
      { items: [{ description: "x", unitPrice: "-1", unit: 7, amount: 1 }] },
    ],
    [
      "items[0].discount",
      {
        items: [
          { description: "x", discount: 1_234_567_890_123, unit: 7, amount: 1 },
        ],
      },
    ],
    [
      "items[0].amount",
      { items: [{ description: "x", unit: 7, amount: 0.001 }] },
    ],
    ["items[0].unit", { items: [{ description: "x", unit: 100, amount: 1 }] }],
    ["activities[0].id", { activities: [{ id: "1234567" }] }],
    [
      "associatedVouchers[0].issuerTaxId",
      {
        associatedVouchers: [
          { voucherType: 19, salesPoint: 1, number: 1, issuerTaxId: "123" },
        ],
      },
    ],
  ])("rejects malformed %s before any I/O", (field, overrides) => {
    const options = createBaseOptions();
    const service = createWsfexService(options);

    expect(() => service.issue(createGoodsInvoice(overrides))).toThrow(
      ArcaInputError
    );
    try {
      service.issue(createGoodsInvoice(overrides));
    } catch (error) {
      expect(error).toMatchObject({ field });
    }
    expect(options.auth.login).not.toHaveBeenCalled();
    expect(options.soap.execute).not.toHaveBeenCalled();
  });

  it("reports a missing required field as missing", () => {
    const service = createWsfexService(createBaseOptions());
    const { receiverAddress: _omitted, ...input } = createGoodsInvoice();

    expect(() => service.issue(input as WsfexIssueInput)).toThrow(
      expect.objectContaining({
        code: "ARCA_INPUT_MISSING_FIELD",
        field: "receiverAddress",
      })
    );
  });
});

describe("createWsfexService issue classification", () => {
  it("returns authorized evidence with the echo and reprocess flag", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult())
    );

    const outcome = await createWsfexService(options).issue(
      createGoodsInvoice()
    );

    expect(outcome).toEqual({
      kind: "authorized",
      service: "wsfex",
      operation: "FEXAuthorize",
      result: "A",
      resultLevel: "header",
      results: { header: "A" },
      cae: "75123456789012",
      caeExpiry: "20261011",
      voucherNumber: 7,
      errors: [],
      observations: [],
      reprocessed: false,
      echo: {
        id: 41,
        salesPoint: 3,
        voucherType: 19,
        number: 7,
        date: "20261001",
      },
      raw: expect.objectContaining({ FEXResultAuth: expect.any(Object) }),
    });
  });

  it("reports ARCA's stored answer for a repeated Id as reprocessed", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(
        createAuthorizedResult({ Id: "40", Cbte_nro: "6", Reproceso: "S" })
      )
    );

    await expect(
      createWsfexService(options).issue(createGoodsInvoice())
    ).resolves.toMatchObject({
      kind: "authorized",
      voucherNumber: 6,
      reprocessed: true,
      echo: { id: 40, number: 6 },
    });
  });

  it("keeps Motivos_Obs codes as observations on an authorized voucher", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult({ Motivos_Obs: "14; 16" }))
    );

    const outcome = await createWsfexService(options).issue(
      createGoodsInvoice()
    );

    expect(outcome.kind).toBe("authorized");
    expect(outcome.observations).toEqual([
      {
        service: "wsfex",
        operation: "FEXAuthorize",
        source: "observation",
        category: "observation",
        code: "14",
        message: "14",
        resultLevel: "header",
      },
      expect.objectContaining({ code: "16", category: "observation" }),
    ]);
  });

  it("keeps uncoded Motivos_Obs text as one observation", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(
        createAuthorizedResult({ Motivos_Obs: "Observado por padron" })
      )
    );

    const outcome = await createWsfexService(options).issue(
      createGoodsInvoice()
    );

    expect(outcome.observations).toEqual([
      expect.objectContaining({ message: "Observado por padron" }),
    ]);
    expect(outcome.observations[0]).not.toHaveProperty("code");
  });

  it("does not trust an approval without a CAE", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult({ Cae: "" }))
    );

    await expect(
      createWsfexService(options).issue(createGoodsInvoice())
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "incomplete_response",
      result: "A",
      resultLevel: "header",
      echo: { number: 7 },
    });
  });

  it("rejects with Motivos_Obs as business issues", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(
        createAuthorizedResult({
          Cae: "",
          Fch_venc_Cae: "",
          Resultado: "R",
          Motivos_Obs: "21",
        })
      )
    );

    await expect(
      createWsfexService(options).issue(createGoodsInvoice())
    ).resolves.toMatchObject({
      kind: "rejected",
      result: "R",
      resultLevel: "header",
      errors: [],
      observations: [
        { source: "observation", category: "business", code: "21" },
      ],
    });
  });

  it.each([
    ["1000", "invalid_token"],
    ["1001", "missing_relationship"],
  ])(
    "returns ErrCode %s as authentication_rejected evidence",
    async (code, reason) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce(
        createAuthorizeAnswer(undefined, {
          ErrCode: code,
          ErrMsg: "Usuario no autorizado a realizar esta operación",
        })
      );

      await expect(
        createWsfexService(options).issue(createGoodsInvoice())
      ).resolves.toMatchObject({
        kind: "indeterminate",
        reason: "authentication_rejected",
        authentication: {
          code: "ARCA_AUTHENTICATION_ERROR",
          reason,
          providerCode: code,
        },
        errors: [{ code, category: "infrastructure", source: "error" }],
      });
      expect(options.auth.login).toHaveBeenCalledOnce();
      expect(options.soap.execute).toHaveBeenCalledOnce();
    }
  );

  it.each(["500", "501", "502", "505"])(
    "keeps infrastructure ErrCode %s indeterminate",
    async (code) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce(
        createAuthorizeAnswer(undefined, {
          ErrCode: code,
          ErrMsg: "Error interno - Autorizador - Transaccion Activa",
        })
      );

      await expect(
        createWsfexService(options).issue(createGoodsInvoice())
      ).resolves.toMatchObject({
        kind: "indeterminate",
        reason: "incomplete_response",
        errors: [{ code, category: "infrastructure", resultLevel: "header" }],
      });
    }
  );

  it.each(["1014", "1510", "1535", "1607", "1668", "2053"])(
    "rejects validation ErrCode %s at header level",
    async (code) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce(
        createAuthorizeAnswer(undefined, {
          ErrCode: code,
          ErrMsg: "Validacion",
        })
      );

      await expect(
        createWsfexService(options).issue(createGoodsInvoice())
      ).resolves.toEqual({
        kind: "rejected",
        service: "wsfex",
        operation: "FEXAuthorize",
        result: "R",
        resultLevel: "header",
        results: {},
        errors: [
          {
            service: "wsfex",
            operation: "FEXAuthorize",
            source: "error",
            category: "business",
            code,
            message: "Validacion",
            resultLevel: "header",
          },
        ],
        observations: [],
        raw: expect.any(Object),
      });
    }
  );

  it("drops the zero-filled echo of a failed request", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(
        {
          Id: "41",
          Cuit: "0",
          Cbte_tipo: "0",
          Punto_vta: "0",
          Cbte_nro: "0",
        },
        { ErrCode: "1535", ErrMsg: "No corresponde en secuencia" }
      )
    );

    const outcome = await createWsfexService(options).issue(
      createGoodsInvoice()
    );

    expect(outcome).toMatchObject({ kind: "rejected", echo: { id: 41 } });
    expect(outcome.echo).toEqual({ id: 41 });
  });

  it("flags an error that comes with a CAE as contradictory", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult(), {
        ErrCode: "1510",
        ErrMsg: "Punto de venta",
      })
    );

    await expect(
      createWsfexService(options).issue(createGoodsInvoice())
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "contradictory_response",
      cae: "75123456789012",
    });
  });

  it("flags a rejection that comes with a CAE as contradictory", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createAuthorizeAnswer(createAuthorizedResult({ Resultado: "R" }))
    );

    await expect(
      createWsfexService(options).issue(createGoodsInvoice())
    ).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "contradictory_response",
    });
  });

  it("returns transport failures as indeterminate", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockRejectedValueOnce(
      new ArcaTransportError("socket hang up")
    );

    await expect(
      createWsfexService(options).issue(createGoodsInvoice())
    ).resolves.toEqual({
      kind: "indeterminate",
      service: "wsfex",
      operation: "FEXAuthorize",
      reason: "transport_error",
      results: {},
      errors: [],
      observations: [],
    });
  });
});

describe("createWsfexService reads", () => {
  it("sends FEXGetLast_CMP's point and type inside Auth", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetLast_CMP", {
        FEXResult_LastCMP: { Cbte_nro: "6", Cbte_fecha: "20261001" },
        FEXErr: { ErrCode: "0", ErrMsg: "OK" },
      })
    );

    await expect(
      createWsfexService(options).getLastVoucherNumber({
        salesPoint: 3,
        voucherType: 19,
      })
    ).resolves.toBe(6);

    const body = getSentBody(options);
    expect(Object.keys(body)).toEqual(["Auth"]);
    expect(Object.keys(body.Auth ?? {})).toEqual([
      "Token",
      "Sign",
      "Cuit",
      "Pto_venta",
      "Cbte_Tipo",
    ]);
    expect(body.Auth).toMatchObject({ Pto_venta: 3, Cbte_Tipo: 19 });
  });

  it("raises FEXGetLast_CMP validation errors", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetLast_CMP", {
        FEXResult_LastCMP: { Cbte_nro: "0" },
        FEXErr: { ErrCode: "1607", ErrMsg: "Campo Pto_venta no es valido" },
      })
    );

    await expect(
      createWsfexService(options).getLastVoucherNumber({
        salesPoint: 9,
        voucherType: 19,
      })
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      service: "wsfex",
      serviceCode: "1607",
    });
  });

  it("reads the last request Id", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetLast_ID", {
        FEXResultGet: { Id: "40" },
        FEXErr: { ErrCode: "0", ErrMsg: "OK" },
      })
    );

    await expect(createWsfexService(options).getLastRequestId()).resolves.toBe(
      40
    );
    expect(getSentBody(options)).toEqual({
      Auth: { Token: "token", Sign: "sign", Cuit: 20_123_456_786 },
    });
  });

  it("retries a read once with a fresh ticket after ErrCode 1000", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetLast_ID", {
          FEXErr: {
            ErrCode: "1000",
            ErrMsg: "Usuario no autorizado a realizar esta operación",
          },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetLast_ID", {
          FEXResultGet: { Id: "40" },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      );

    await expect(createWsfexService(options).getLastRequestId()).resolves.toBe(
      40
    );
    expect(options.auth.login).toHaveBeenCalledTimes(2);
    expect(options.auth.login).toHaveBeenNthCalledWith(
      2,
      "wsfex",
      expect.objectContaining({ forceRefresh: true })
    );
  });

  it("maps sales points from a list and from a single row", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_PtoVenta", {
          FEXResultGet: {
            ClsFEXResponse_PtoVenta: [
              { Pve_Nro: "3", Pve_Bloqueado: "N", Pve_FchBaja: "" },
              { Pve_Nro: "4", Pve_Bloqueado: "S", Pve_FchBaja: "20250630" },
              { Pve_Nro: "5", Pve_Bloqueado: "N", Pve_FchBaja: "NULL" },
              { "@_nil": "true" },
            ],
          },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_PtoVenta", {
          FEXResultGet: {
            ClsFEXResponse_PtoVenta: {
              Pve_Nro: "7",
              Pve_Bloqueado: "N",
              Pve_FchBaja: { "@_nil": "true" },
            },
          },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      );
    const service = createWsfexService(options);

    await expect(service.getSalesPoints()).resolves.toEqual([
      { number: 3, blocked: false },
      { number: 4, blocked: true, deactivatedAt: "2025-06-30" },
      { number: 5, blocked: false },
    ]);
    await expect(service.getSalesPoints()).resolves.toEqual([
      { number: 7, blocked: false },
    ]);
  });

  it("returns an empty catalog for an empty FEXResultGet", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetPARAM_PtoVenta", {
        FEXResultGet: "",
        FEXErr: { ErrCode: "0", ErrMsg: "OK" },
      })
    );

    await expect(createWsfexService(options).getSalesPoints()).resolves.toEqual(
      []
    );
  });

  it("maps catalogs with string ids, padded activities and CUIT strings", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_DST_pais", {
          FEXResultGet: {
            ClsFEXResponse_DST_pais: { DST_Codigo: "203", DST_Ds: "BRASIL" },
          },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_DST_CUIT", {
          FEXResultGet: {
            ClsFEXResponse_DST_cuit: [
              { DST_CUIT: "50000000016", DST_Ds: "BRASIL - Persona Juridica" },
            ],
          },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_UMed", {
          FEXResultGet: {
            ClsFEXResponse_UMed: [
              { Umed_Id: "7", Umed_Ds: "unidades", Umed_vig_desde: "20100101" },
              { Umed_Id: "99", Umed_Ds: "bonificacion" },
            ],
          },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_Actividades", {
          FEXResultGet: {
            ClsFEXResponse_ActividadTipo: [
              { Id: "11211", Orden: "1", Desc: "Cultivo de trigo" },
              { Id: "620100", Orden: "2", Desc: "Servicios de consultores" },
            ],
          },
          FEXErr: { ErrCode: "0", Errmsg: "OK" },
        })
      );
    const service = createWsfexService(options);

    await expect(service.getCountries()).resolves.toEqual([
      { id: "203", description: "BRASIL" },
    ]);
    await expect(service.getCountryTaxIds()).resolves.toEqual([
      { taxId: "50000000016", description: "BRASIL - Persona Juridica" },
    ]);
    await expect(service.getUnits()).resolves.toEqual([
      { id: "7", description: "unidades" },
      { id: "99", description: "bonificacion" },
    ]);
    await expect(service.getActivities()).resolves.toEqual([
      { id: "011211", description: "Cultivo de trigo" },
      { id: "620100", description: "Servicios de consultores" },
    ]);
    expect(
      options.soap.execute.mock.calls.map(([call]) => call.operation)
    ).toEqual([
      "FEXGetPARAM_DST_pais",
      "FEXGetPARAM_DST_CUIT",
      "FEXGetPARAM_UMed",
      "FEXGetPARAM_Actividades",
    ]);
  });

  it("reads the Errmsg spelling of a catalog error", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetPARAM_Actividades", {
        FEXErr: { ErrCode: "1660", Errmsg: "Error de catalogo" },
      })
    );

    await expect(
      createWsfexService(options).getActivities()
    ).rejects.toMatchObject({
      name: "ArcaServiceError",
      message: "(1660) Error de catalogo",
      serviceCode: "1660",
    });
  });

  it("reads exchange rates as exact decimal strings", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_Ctz", {
          FEXResultGet: { Mon_ctz: "1450.123456", Mon_fecha: "20260930" },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetPARAM_Ctz", {
          FEXResultGet: { Mon_ctz: "12345.500000", Mon_fecha: "20261001" },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      );
    const service = createWsfexService(options);

    await expect(
      service.getExchangeRate({ currencyId: "DOL", date: "2026-09-30" })
    ).resolves.toEqual({
      currencyId: "DOL",
      rate: "1450.123456",
      date: "2026-09-30",
    });
    await expect(
      service.getExchangeRate({ currencyId: "060" })
    ).resolves.toEqual({
      currencyId: "060",
      rate: "12345.5",
      date: "2026-10-01",
    });
    expect(getSentBody(options, 0)).toMatchObject({
      Mon_id: "DOL",
      FchCotiz: "2026-09-30",
    });
    expect(getSentBody(options, 1)).not.toHaveProperty("FchCotiz");
  });

  it("validates the exchange rate date before any I/O", async () => {
    const options = createBaseOptions();

    await expect(
      createWsfexService(options).getExchangeRate({
        currencyId: "DOL",
        date: "2026-02-30",
      })
    ).rejects.toBeInstanceOf(ArcaInputError);
    expect(options.auth.login).not.toHaveBeenCalled();
  });

  it("checks shipping permits", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXCheck_Permiso", {
          FEXResultGet: { Status: "OK" },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXCheck_Permiso", {
          FEXResultGet: { Status: "NO" },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      );
    const service = createWsfexService(options);

    await expect(
      service.checkPermit({ id: "09052EC01006154G", destination: 203 })
    ).resolves.toBe(true);
    await expect(
      service.checkPermit({ id: "09052EC01006154G", destination: 202 })
    ).resolves.toBe(false);
    expect(getSentBody(options, 0)).toMatchObject({
      ID_Permiso: "09052EC01006154G",
      Dst_merc: 203,
    });
  });
});

describe("createWsfexService lookupVoucher", () => {
  it("keeps N12,6 quantities and discounts exact", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetCMP", {
        FEXResultGet: {
          Id: "41",
          Cbte_tipo: "19",
          Punto_vta: "3",
          Cbte_nro: "7",
          Dst_cmp: "203",
          Cliente: "Joao Da Silva",
          Domicilio_cliente: "Rua 76",
          Moneda_Id: "DOL",
          Imp_total: "1234567890.12",
          Items: {
            Item: {
              Pro_ds: "Horas",
              Pro_qty: "123456789012.123456",
              Pro_umed: "7",
              Pro_precio_uni: "0.010000",
              Pro_bonificacion: "999999999999.999999",
              Pro_total_item: "1234567890.12",
            },
          },
          Resultado: "A",
        },
        FEXErr: { ErrCode: "0", ErrMsg: "OK" },
      })
    );
    const result = await createWsfexService(options).lookupVoucher({
      salesPoint: 3,
      voucherType: 19,
      number: 7,
    });
    expect(result.kind === "found" && result.voucher.items[0]).toMatchObject({
      quantity: "123456789012.123456",
      discount: "999999999999.999999",
      unitPrice: "0.01",
    });
  });

  it("consults with ClsFEXGetCMP's lowercase Cbte_tipo and maps the voucher", async () => {
    const options = createBaseOptions();
    options.soap.execute.mockResolvedValueOnce(
      createWsfexOperationResult("FEXGetCMP", {
        FEXResultGet: {
          Id: "41",
          Fecha_cbte: "20261001",
          Cbte_tipo: "19",
          Punto_vta: "3",
          Cbte_nro: "7",
          Tipo_expo: "1",
          Permiso_existente: "S",
          Permisos: {
            Permiso: { Id_permiso: "09052EC01006154G", Dst_merc: "203" },
          },
          Dst_cmp: "203",
          Cliente: "Joao Da Silva",
          Cuit_pais_cliente: "50000000016",
          Domicilio_cliente: "Rua 76 km 34.5 Alagoas",
          Id_impositivo: "PJ54482221-l",
          Moneda_Id: "DOL",
          Moneda_ctz: "1450.123456",
          CanMisMonExt: "N",
          Obs_comerciales: "Sin observaciones",
          Imp_total: "500.00",
          Obs: "Nota",
          Cmps_asoc: {
            Cmp_asoc: [
              {
                Cbte_tipo: "88",
                Cbte_punto_vta: "1",
                Cbte_nro: "15",
                Cbte_cuit: "0",
              },
            ],
          },
          Forma_pago: "Contado",
          Incoterms: "FOB",
          Incoterms_Ds: "Puerto",
          Idioma_cbte: "1",
          Items: {
            Item: [
              {
                Pro_codigo: "PRO1",
                Pro_ds: "Producto",
                Pro_qty: "2.000000",
                Pro_umed: "7",
                Pro_precio_uni: "250.500000",
                Pro_bonificacion: "1.000000",
                Pro_total_item: "500.00",
              },
              {
                Pro_ds: "Descuento",
                Pro_qty: "0",
                Pro_umed: "99",
                Pro_precio_uni: "0",
                Pro_bonificacion: "0",
                Pro_total_item: "-0.50",
              },
            ],
          },
          Fecha_cbte_cae: "20261001",
          Fch_venc_Cae: "20261011",
          Cae: "75123456789012",
          Resultado: "A",
          Motivos_Obs: "14",
          Fecha_pago: "20261015",
          Actividades: { Actividad: { Id: "11211" } },
        },
        FEXErr: { ErrCode: "0", ErrMsg: "OK" },
      })
    );

    const result = await createWsfexService(options).lookupVoucher({
      salesPoint: 3,
      voucherType: 19,
      number: 7,
    });

    expect(getSentBody(options).Cmp).toEqual({
      Cbte_tipo: 19,
      Punto_vta: 3,
      Cbte_nro: 7,
    });
    expect(result).toMatchObject({
      kind: "found",
      service: "wsfex",
      operation: "FEXGetCMP",
      observations: [
        { source: "observation", category: "observation", code: "14" },
      ],
    });
    expect(result.kind === "found" && result.voucher).toEqual({
      id: 41,
      voucherType: 19,
      salesPoint: 3,
      number: 7,
      voucherDate: "20261001",
      exportType: 1,
      permitExists: "S",
      permits: [{ id: "09052EC01006154G", destination: 203 }],
      destination: 203,
      receiverName: "Joao Da Silva",
      receiverCountryTaxId: "50000000016",
      receiverAddress: "Rua 76 km 34.5 Alagoas",
      receiverTaxId: "PJ54482221-l",
      currencyId: "DOL",
      exchangeRate: "1450.123456",
      sameCurrencyForeignCancellation: "N",
      commercialObservations: "Sin observaciones",
      totalAmount: 500,
      observations: "Nota",
      associatedVouchers: [{ voucherType: 88, salesPoint: 1, number: 15 }],
      paymentTerms: "Contado",
      incoterms: "FOB",
      incotermsDetail: "Puerto",
      language: 1,
      items: [
        {
          code: "PRO1",
          description: "Producto",
          quantity: "2",
          unit: 7,
          unitPrice: "250.5",
          discount: "1",
          amount: 500,
        },
        {
          description: "Descuento",
          quantity: "0",
          unit: 99,
          unitPrice: "0",
          discount: "0",
          amount: -0.5,
        },
      ],
      paymentDate: "20261015",
      activities: [{ id: "011211" }],
      result: "A",
      cae: "75123456789012",
      caeExpiry: "20261011",
      authorizedAt: "20261001",
    });
  });

  it.each(["0", ""])(
    "reads an Incoterms_Ds of %j as no incotermsDetail",
    async (detail) => {
      const options = createBaseOptions();
      options.soap.execute.mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetCMP", {
          FEXResultGet: {
            Id: "41",
            Cbte_tipo: "19",
            Punto_vta: "3",
            Cbte_nro: "7",
            Dst_cmp: "203",
            Cliente: "Joao Da Silva",
            Domicilio_cliente: "Rua 76 km 34.5 Alagoas",
            Moneda_Id: "DOL",
            Imp_total: "500.00",
            Incoterms: "FOB",
            // What ARCA stores for a voucher sent without Incoterms_Ds.
            Incoterms_Ds: detail,
            Items: {
              Item: {
                Pro_ds: "Producto",
                Pro_umed: "7",
                Pro_total_item: "500.00",
              },
            },
            Resultado: "A",
          },
          FEXErr: { ErrCode: "0", ErrMsg: "OK" },
        })
      );

      const result = await createWsfexService(options).lookupVoucher({
        salesPoint: 3,
        voucherType: 19,
        number: 7,
      });

      expect(result.kind).toBe("found");
      const voucher = result.kind === "found" ? result.voucher : undefined;
      expect(voucher).toMatchObject({ incoterms: "FOB" });
      expect(voucher).not.toHaveProperty("incotermsDetail");
    }
  );

  it("normalizes only ErrCode 1020 as voucher absence", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetCMP", {
          FEXErr: { ErrCode: "1020", ErrMsg: "Comprobante inexistente" },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetCMP", {
          FEXErr: { ErrCode: "500", ErrMsg: "Error interno de aplicacion" },
        })
      );
    const service = createWsfexService(options);
    const input = { salesPoint: 3, voucherType: 19, number: 8 };

    await expect(service.lookupVoucher(input)).resolves.toMatchObject({
      kind: "not_found",
      service: "wsfex",
      operation: "FEXGetCMP",
      errors: [{ code: "1020", category: "unknown" }],
      observations: [],
    });
    await expect(service.lookupVoucher(input)).rejects.toMatchObject({
      name: "ArcaServiceError",
      serviceCode: "500",
    });
  });

  it("recovers a lookup from ErrCode 1001 with one forced refresh", async () => {
    const options = createBaseOptions();
    options.soap.execute
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetCMP", {
          FEXErr: {
            ErrCode: "1001",
            ErrMsg: "Cuit solicitante no se encuentra entre sus representados",
          },
        })
      )
      .mockResolvedValueOnce(
        createWsfexOperationResult("FEXGetCMP", {
          FEXErr: { ErrCode: "1020", ErrMsg: "Comprobante inexistente" },
        })
      );

    await expect(
      createWsfexService(options).lookupVoucher({
        salesPoint: 3,
        voucherType: 19,
        number: 8,
      })
    ).resolves.toMatchObject({ kind: "not_found" });
    expect(options.auth.login).toHaveBeenNthCalledWith(
      2,
      "wsfex",
      expect.objectContaining({ forceRefresh: true })
    );
  });
});

describe("WSFEX authentication codes", () => {
  it.each([
    ["1000", "invalid_token"],
    ["1001", "missing_relationship"],
  ])("classifies WSFEX %s as %s", (providerCode, reason) => {
    expect(
      classifyArcaAuthenticationCandidate({
        service: "wsfex",
        operation: "FEXGetLast_ID",
        providerCode,
      })
    ).toMatchObject({ reason, service: "wsfex", providerCode });
  });

  it("keeps the codes scoped to their service", () => {
    expect(
      classifyArcaAuthenticationCandidate({
        service: "wsfe",
        operation: "FECAESolicitar",
        providerCode: "1000",
      })
    ).toBeUndefined();
    expect(
      classifyArcaAuthenticationCandidate({
        service: "wsfex",
        operation: "FEXAuthorize",
        providerCode: "600",
      })
    ).toBeUndefined();
  });
});
