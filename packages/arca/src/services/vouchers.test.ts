import { describe, expect, it, vi } from "vitest";
import { createArcaClient } from "../client";
import { ArcaTransportError } from "../errors";
import { createMemoryStore } from "../store/memory";
import { createVouchersService } from "./vouchers";
import type { IssueOptions } from "./vouchers-types";
import {
  type CreateWsfeServiceOptions,
  createWsfeService,
  normalizeWsfeVoucherInput,
  type WsfeAuthorizationOutcome,
  type WsfeAuthorizeVoucherInput,
  type WsfeVoucherInfo,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import { deriveWsfeInvoice, type IssueInput } from "./wsfe-derive";

const input: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  to: { condition: "consumidor_final" },
  items: [{ gross: 12_100, vat: 21 }],
  date: "20260904",
};
const baseEvidence = {
  service: "wsfe" as const,
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
  raw: { private: "wire" },
};
const uncertain: WsfeAuthorizationOutcome = {
  ...baseEvidence,
  kind: "indeterminate",
  reason: "transport_error",
};
const authorized: WsfeAuthorizationOutcome = {
  ...baseEvidence,
  kind: "authorized",
  result: "A",
  resultLevel: "detail",
  cae: "74123456789012",
  caeExpiry: "20260914",
  voucherNumber: 77,
};
function found(
  overrides: Partial<WsfeVoucherInfo> = {}
): WsfeVoucherLookupResult {
  const data = deriveWsfeInvoice(input).data;
  return {
    kind: "found",
    service: "wsfe",
    operation: "FECompConsultar",
    observations: [],
    raw: { private: "lookup" },
    voucher: {
      ...data,
      documentNumber: String(data.documentNumber),
      exchangeRate: Number(data.exchangeRate),
      voucherNumber: 77,
      result: "A",
      cae: "74123456789012",
      caeExpiry: "20260914",
      raw: { private: "voucher" },
      ...overrides,
    },
  };
}
function fake(
  outcome: WsfeAuthorizationOutcome = authorized,
  lookup: WsfeVoucherLookupResult = found()
) {
  const wsfe = {
    getNextVoucherNumber: vi.fn().mockResolvedValue(77),
    issue: vi.fn(({ data }: WsfeAuthorizeVoucherInput) => {
      // Exercise the real exact-input reconciliation on every attempted write.
      normalizeWsfeVoucherInput(data);
      return Promise.resolve(outcome);
    }),
    lookupVoucher: vi.fn().mockResolvedValue(lookup),
  };
  return { wsfe, service: createVouchersService(wsfe) };
}
function expectNoRaw(value: unknown) {
  if (value && typeof value === "object") {
    expect(Object.keys(value)).not.toContain("raw");
    for (const child of Object.values(value)) {
      expectNoRaw(child);
    }
  }
}

describe("vouchers.issue", () => {
  it("wires the high-level API on the client", () => {
    expect(
      createArcaClient({
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
        environment: "test",
      }).issue
    ).toBeTypeOf("function");
  });
  it("authorizes once, exposes the sent input only on request, and passes auth options unchanged", async () => {
    const { wsfe, service } = fake();
    const auth = { representedTaxId: "20304050607", forceRefresh: true };
    const result = await service.issue(input, {
      ...auth,
      include: { exactInput: true },
    });
    expect(result).toMatchObject({
      kind: "authorized",
      recoveredByMatch: false,
      voucher: {
        number: 77,
        voucherClass: "B",
        date: "20260904",
        amounts: { computedTotal: 12_100, sentTotal: 12_100, vatAdjustment: 0 },
      },
    });
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledExactlyOnceWith({
      ...auth,
      salesPoint: 1,
      voucherType: 6,
    });
    expect(wsfe.issue).toHaveBeenCalledExactlyOnceWith({
      ...auth,
      data: deriveWsfeInvoice(input).data,
      voucherNumber: 77,
    });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    if (result.kind !== "authorized") {
      throw new Error("Expected authorization");
    }
    expect(result.sent).toEqual(wsfe.issue.mock.calls[0][0].data);
    expectNoRaw(result);
  });
  it.each([
    { ...input, to: { condition: "monotributo", cuit: "20123456789" } },
    { ...input, issuer: "monotributo", items: [{ amount: 10_000 }] },
    {
      ...input,
      service: { from: "20260901", to: "20260930", dueDate: "20261001" },
    },
  ])("constructs A, C and services through the public method: %j", async (value) => {
    const { service, wsfe } = fake();
    const result = await service.issue(value as IssueInput);
    expect(result.kind).toBe("authorized");
    expect(wsfe.issue).toHaveBeenCalledOnce();
  });
  it("returns provider rejection issues and does not look up or retry", async () => {
    const issue = {
      service: "wsfe" as const,
      operation: "FECAESolicitar",
      source: "observation" as const,
      category: "business" as const,
      code: "10016",
      message: "Number must follow the last authorized",
    };
    const rejection: WsfeAuthorizationOutcome = {
      ...baseEvidence,
      kind: "rejected",
      result: "R",
      resultLevel: "detail",
      observations: [issue],
    };
    const { wsfe, service } = fake(rejection);
    expect(await service.issue(input)).toMatchObject({
      kind: "rejected",
      attempted: { salesPoint: 1, voucherType: 6, number: 77 },
      issues: [issue],
    });
    expect(wsfe.issue).toHaveBeenCalledOnce();
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it("recovers only a complete matching identity after an indeterminate attempt", async () => {
    const { wsfe, service } = fake(uncertain);
    const result = await service.issue(input, {
      representedTaxId: 20_304_050_607,
      forceRefresh: false,
      include: { exactInput: true },
    });
    expect(result).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 77 },
      attempt: { kind: "indeterminate" },
      lookup: { number: 77 },
      sent: deriveWsfeInvoice(input).data,
    });
    expect(wsfe.lookupVoucher).toHaveBeenCalledExactlyOnceWith({
      representedTaxId: 20_304_050_607,
      forceRefresh: false,
      salesPoint: 1,
      voucherType: 6,
      number: 77,
    });
    expect(wsfe.issue).toHaveBeenCalledOnce();
    expectNoRaw(result);
  });
  it.each([
    [found({ totalAmount: 121.01 }), "conflict"],
    [found({ cae: undefined }), "indeterminate"],
    [found({ result: "R" }), "indeterminate"],
    [found({ vatRates: undefined }), "indeterminate"],
    [found({ documentNumber: undefined }), "indeterminate"],
    [
      {
        kind: "not_found",
        service: "wsfe",
        operation: "FECompConsultar",
        errors: [],
        observations: [],
        raw: { private: "not found" },
      },
      "indeterminate",
    ],
  ] as const)("never resubmits after %j", async (lookup, kind) => {
    const { wsfe, service } = fake(
      uncertain,
      lookup as WsfeVoucherLookupResult
    );
    const result = await service.issue(input);
    expect(result.kind).toBe(kind);
    expectNoRaw(result);
    expect(result).not.toHaveProperty("sent");
    expect(wsfe.issue).toHaveBeenCalledOnce();
    expect(wsfe.lookupVoucher).toHaveBeenCalledOnce();
    if (result.kind === "conflict") {
      expect(result.reason).toContain("totalAmount");
    }
  });
  it("keeps lookup failures bounded and does not resubmit", async () => {
    const { wsfe, service } = fake(uncertain);
    wsfe.lookupVoucher.mockRejectedValueOnce(
      new ArcaTransportError("Lookup failed", {
        statusCode: 503,
        cause: new Error("private"),
        responseBodyPreview: "private",
      })
    );
    const result = await service.issue(input);
    expect(result).toMatchObject({
      kind: "indeterminate",
      lookup: {
        kind: "failed",
        error: {
          name: "ArcaTransportError",
          message: "Lookup failed",
          statusCode: 503,
          code: "ARCA_TRANSPORT_ERROR",
        },
      },
    });
    expectNoRaw(result);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(wsfe.issue).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    { raw: false },
    { exactInput: false },
    { raw: true },
    { exactInput: true },
    { raw: true, exactInput: true },
  ])("controls evidence and exact input with include %j", async (include) => {
    const { service } = fake();
    const result = await service.issue(input, { include });
    expect(Object.hasOwn(result, "sent")).toBe(include?.exactInput === true);
    if (result.kind !== "authorized" || result.recoveredByMatch) {
      throw new Error("Expected direct authorization");
    }
    expect(Object.hasOwn(result.authorization, "raw")).toBe(
      include?.raw === true
    );
  });
  it("exposes raw evidence across recovery paths only when requested", async () => {
    for (const lookup of [
      found(),
      found({ totalAmount: 120 }),
      found({ caeExpiry: undefined }),
      {
        kind: "not_found",
        service: "wsfe",
        operation: "FECompConsultar",
        errors: [],
        observations: [],
        raw: { private: "not found" },
      } as const,
    ]) {
      const { service } = fake(uncertain, lookup as WsfeVoucherLookupResult);
      const result = await service.issue(input, { include: { raw: true } });
      if (!("attempt" in result)) {
        throw new Error("Expected attempt evidence");
      }
      expect(result.attempt.raw).toEqual(uncertain.raw);
      const evidence =
        result.kind === "conflict"
          ? result.found
          : "lookup" in result
            ? result.lookup
            : undefined;
      expect(evidence).toHaveProperty("raw", lookup.raw);
    }
  });
  it.each([
    { ...input, items: [{ net: -1, vat: 21 }] },
    { ...input, to: {} },
    { ...input, salesPoint: 0 },
    { ...input, items: [] },
    { ...input, date: "20260230" },
    { ...input, currency: "USD" },
    { ...input, total: 12_103 },
    { ...input, items: [{ amount: 100 }] },
    { ...input, issuer: "monotributo", items: [{ gross: 100, vat: 21 }] },
  ])("does zero provider I/O for invalid input %j", async (value) => {
    const { service, wsfe } = fake();
    await expect(service.issue(value as IssueInput)).rejects.toBeInstanceOf(
      Error
    );
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it.each([
    { representedTaxId: "bad" },
    { forceRefresh: "true" },
    { include: { raw: "true" } },
    { include: null },
  ])("does zero provider I/O for invalid options %j", async (options) => {
    const { service, wsfe } = fake();
    await expect(
      service.issue(input, options as IssueOptions)
    ).rejects.toBeInstanceOf(Error);
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it("never authorizes when the next-number read fails", async () => {
    const { service, wsfe } = fake();
    wsfe.getNextVoucherNumber.mockRejectedValueOnce(new Error("Read failed"));
    await expect(service.issue(input)).rejects.toThrow("Read failed");
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    100_000_000,
  ])("never writes an invalid next number %s", async (number) => {
    const { service, wsfe } = fake();
    wsfe.getNextVoucherNumber.mockResolvedValueOnce(number);
    await expect(service.issue(input)).rejects.toMatchObject({
      code: "ARCA_SERVICE_ERROR",
      operation: "FECompUltimoAutorizado",
    });
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it("does not serialize concurrent calls without a store", async () => {
    const { service, wsfe } = fake();
    await Promise.all([service.issue(input), service.issue(input)]);
    expect(wsfe.getNextVoucherNumber).toHaveBeenCalledTimes(2);
    expect(
      wsfe.issue.mock.calls.map(([attempt]) => attempt.voucherNumber)
    ).toEqual([77, 77]);
  });
  it("serializes concurrent keyed calls with a store", async () => {
    const { wsfe } = fake();
    let next = 77;
    wsfe.getNextVoucherNumber.mockImplementation(() => Promise.resolve(next));
    wsfe.issue.mockImplementation(({ voucherNumber }) => {
      next = voucherNumber + 1;
      return Promise.resolve({ ...authorized, voucherNumber });
    });
    const service = createVouchersService(wsfe, {
      store: createMemoryStore(),
      environment: "test",
      taxId: "20123456789",
    });
    await Promise.all([
      service.issue(input, { idempotencyKey: "one" }),
      service.issue(input, { idempotencyKey: "two" }),
    ]);
    expect(
      wsfe.issue.mock.calls.map(([attempt]) => attempt.voucherNumber)
    ).toEqual([77, 78]);
  });
  it("snapshots caller assertions before awaiting the sequence read", async () => {
    const { service, wsfe } = fake();
    const items = [{ gross: 12_100, vat: 21 as const }];
    const running = service.issue({ ...input, items });
    items[0].gross = 100;
    await running;
    expect(wsfe.issue.mock.calls[0][0].data.totalAmount).toBe(121);
  });
  it("handles authorized exact evidence without expiry conservatively", async () => {
    const { service, wsfe } = fake(
      { ...authorized, caeExpiry: undefined },
      found({ caeExpiry: undefined })
    );
    expect(await service.issue(input)).toMatchObject({
      kind: "indeterminate",
      lookup: { kind: "incomplete" },
    });
    expect(wsfe.issue).toHaveBeenCalledOnce();
  });
});

describe("high-level API with the real exact SOAP adapter", () => {
  function createAdapter(soap: CreateWsfeServiceOptions["soap"]) {
    return createWsfeService({
      config: {
        taxId: "20123456789",
        certificatePem:
          "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
        environment: "test",
        retries: 5,
      },
      auth: {
        login: vi.fn().mockResolvedValue({
          token: "token",
          sign: "sign",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      },
      soap,
    });
  }

  it.each([
    ["missing", {}, "indeterminate"],
    [
      "malformed",
      { CbteDesde: "invalid", CbteHasta: "invalid" },
      "indeterminate",
    ],
    ["empty", { CbteDesde: "", CbteHasta: "" }, "indeterminate"],
    ["zero", { CbteDesde: 0 }, "indeterminate"],
    ["fractional", { CbteDesde: 77.5 }, "indeterminate"],
    ["out of range", { CbteDesde: 100_000_000 }, "indeterminate"],
    ["matching", { CbteDesde: 77, CbteHasta: 77 }, "authorized"],
    ["matching fallback", { CbteHasta: 77 }, "authorized"],
    ["different", { CbteDesde: 78, CbteHasta: 78 }, "conflict"],
  ] as const)("classifies lookup number (%s) after timeout", async (_name, numbers, kind) => {
    const execute = vi.fn(async ({ operation }: { operation: string }) => {
      await Promise.resolve();
      if (operation === "FECompUltimoAutorizado") {
        return { result: { FECompUltimoAutorizadoResult: { CbteNro: 76 } } };
      }
      if (operation === "FECAESolicitar") {
        throw new ArcaTransportError("Timeout");
      }
      expect(operation).toBe("FECompConsultar");
      return {
        result: {
          FECompConsultarResult: {
            ResultGet: {
              ...numbers,
              CbteFch: "20260904",
              PtoVta: 1,
              CbteTipo: 6,
              Concepto: 1,
              DocTipo: 99,
              DocNro: 0,
              CondicionIVAReceptorId: 5,
              MonId: "PES",
              MonCotiz: 1,
              ImpTotal: 121,
              ImpNeto: 100,
              ImpIVA: 21,
              ImpOpEx: 0,
              ImpTotConc: 0,
              ImpTrib: 0,
              Iva: { AlicIva: { Id: 5, BaseImp: 100, Importe: 21 } },
              Resultado: "A",
              CodAutorizacion: "74123456789012",
              FchVto: "20260914",
            },
          },
        },
      };
    });
    const wsfe = createAdapter({
      execute: vi.fn().mockImplementation(execute),
    });
    const result = await createVouchersService(wsfe).issue(input);
    expect(result.kind).toBe(kind);
    if (kind === "indeterminate") {
      expect(result).toMatchObject({
        lookup: { kind: "incomplete", reason: "Cannot verify number" },
      });
    } else if (kind === "authorized") {
      expect(result).toMatchObject({
        recoveredByMatch: true,
        voucher: { number: 77 },
      });
    } else {
      expect(result).toMatchObject({
        found: { number: 78 },
        reason: expect.stringContaining("number differs"),
      });
    }
    expect(execute.mock.calls.map(([call]) => call.operation)).toEqual([
      "FECompUltimoAutorizado",
      "FECAESolicitar",
      "FECompConsultar",
    ]);
    expectNoRaw(result);
  });

  it.each([
    "rejection",
    "transport",
  ])("classifies %s without a second authorization", async (mode) => {
    const execute = vi.fn(
      async ({
        operation,
        retries,
      }: {
        operation: string;
        retries?: number;
      }) => {
        await Promise.resolve();
        if (operation === "FECompUltimoAutorizado") {
          return { result: { FECompUltimoAutorizadoResult: { CbteNro: 76 } } };
        }
        if (operation === "FECompConsultar") {
          return {
            result: {
              FECompConsultarResult: {
                Errors: { Err: { Code: 602, Msg: "No existe comprobante" } },
              },
            },
          };
        }
        expect(operation).toBe("FECAESolicitar");
        expect(retries).toBe(0);
        if (mode === "transport") {
          throw new ArcaTransportError("Timeout");
        }
        return {
          result: {
            FECAESolicitarResult: {
              FeCabResp: { Resultado: "R" },
              FeDetResp: {
                FECAEDetResponse: {
                  Resultado: "R",
                  Observaciones: {
                    Obs: { Code: 10_016, Msg: "Number conflict" },
                  },
                },
              },
            },
          },
        };
      }
    );
    const wsfe = createAdapter({
      execute: vi.fn().mockImplementation(execute),
    });
    const result = await createVouchersService(wsfe).issue(input);
    expect(result.kind).toBe(
      mode === "rejection" ? "rejected" : "indeterminate"
    );
    expect(
      execute.mock.calls.filter(([call]) => call.operation === "FECAESolicitar")
    ).toHaveLength(1);
    expect(
      execute.mock.calls.filter(
        ([call]) => call.operation === "FECompConsultar"
      )
    ).toHaveLength(mode === "transport" ? 1 : 0);
    expectNoRaw(result);
  });
});
