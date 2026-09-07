import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../store/memory";
import { attemptKey } from "../store/types";
import { createVouchersService } from "./vouchers";
import {
  createWsfeService,
  type WsfeAuthorizeVoucherInput,
  type WsfeVoucherInfo,
  type WsfeVoucherInput,
  type WsfeVoucherLookupResult,
} from "./wsfe";
import type { IssueInput } from "./wsfe-derive";
import { matchWsfeVoucherIdentity } from "./wsfe-identity";
import { createWsmtxcaService } from "./wsmtxca";

const invoice: IssueInput = {
  issuer: "responsable_inscripto",
  salesPoint: 1,
  date: "20260906",
  to: { condition: "responsable_inscripto", cuit: "20123456789" },
  items: [{ net: 10_000, vat: 21 }],
};
const tax = { id: 2, description: "IIBB", base: 10_000, rate: 3, amount: 300 };
const evidence = {
  service: "wsfe" as const,
  operation: "FECAESolicitar",
  results: {},
  errors: [],
  observations: [],
};
const absent: WsfeVoucherLookupResult = {
  service: "wsfe",
  operation: "FECompConsultar",
  kind: "not_found",
  observations: [],
  errors: [],
  raw: {},
};
function found(data: WsfeVoucherInput, number: number): WsfeVoucherInfo {
  return {
    ...structuredClone(data),
    documentNumber: String(data.documentNumber),
    exchangeRate: Number(data.exchangeRate),
    voucherNumber: number,
    result: "A",
    cae: "12345678901234",
    caeExpiry: "20260916",
    raw: {},
  };
}
function fixture() {
  const records = new Map<string, WsfeVoucherInfo>();
  const store = createMemoryStore();
  const wsfe = {
    getNextVoucherNumber: vi.fn(() => Promise.resolve(9)),
    lookupVoucher: vi.fn(
      async ({
        voucherType,
        number,
      }: {
        voucherType: number;
        number: number;
      }): Promise<WsfeVoucherLookupResult> => {
        await Promise.resolve();
        const voucher = records.get(`${voucherType}:${number}`);
        return voucher
          ? {
              kind: "found",
              service: "wsfe",
              operation: "FECompConsultar",
              observations: [],
              raw: {},
              voucher,
            }
          : absent;
      }
    ),
    issue: vi.fn(async ({ data, voucherNumber }: WsfeAuthorizeVoucherInput) => {
      await Promise.resolve();
      records.set(
        `${data.voucherType}:${voucherNumber}`,
        found(data, voucherNumber)
      );
      return {
        ...evidence,
        kind: "authorized" as const,
        result: "A" as const,
        resultLevel: "detail" as const,
        cae: "12345678901234",
        caeExpiry: "20260916",
        voucherNumber,
      };
    }),
  };
  const client = createVouchersService(wsfe, {
    store,
    environment: "test",
    taxId: "20123456789",
  });
  return { client, wsfe, store, records };
}

describe("complete WSFE issuance", () => {
  it.each([
    ["ordinary", "responsable_inscripto", "responsable_inscripto", 1],
    ["ordinary", "responsable_inscripto", "consumidor_final", 6],
    ["ordinary", "monotributo", "consumidor_final", 11],
    ["retention_legend", "responsable_inscripto", "responsable_inscripto", 51],
    ["fce", "responsable_inscripto", "responsable_inscripto", 201],
    ["fce", "responsable_inscripto", "consumidor_final", 206],
    ["fce", "monotributo", "consumidor_final", 211],
  ] as const)("previews and issues %s %s to %s as %s", async (family, issuer, condition, type) => {
    const { client, wsfe } = fixture();
    const input = {
      ...invoice,
      family,
      issuer,
      to: { condition, cuit: "20123456789" },
      items:
        issuer === "monotributo"
          ? [{ amount: 12_100 }]
          : [{ net: 10_000, vat: 21 }],
      dueDate: "20260930",
      ...(family === "fce" ? { fce: { cbu: "1234567890123456789012" } } : {}),
    } as IssueInput;
    const preview = client.preview(input);
    const result = await client.issue(input, {
      number: 42,
      include: { exactInput: true },
    });
    expect(preview).toMatchObject({
      voucherType: type,
      amounts: { sentTotal: 12_100 },
    });
    expect(result).toMatchObject({
      kind: "authorized",
      sent: preview.request,
      voucher: { number: 42, voucherType: type },
    });
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
  });
  it("preserves reviewed amounts and tributes, including nonstandard historical VAT", async () => {
    const { client } = fixture();
    const result = await client.issue(
      {
        ...invoice,
        items: undefined,
        taxes: [tax],
        amounts: {
          net: 10_000,
          vat: 2099,
          vatRates: [{ id: 5, base: 10_000, amount: 2099 }],
        },
        total: 12_399,
      },
      { include: { exactInput: true } }
    );
    expect(result).toMatchObject({
      kind: "authorized",
      sent: {
        netAmount: 100,
        vatAmount: 20.99,
        taxAmount: 3,
        totalAmount: 123.99,
        taxes: [{ id: 2, baseAmount: 100, rate: 3, amount: 3 }],
      },
    });
  });
  it.each([
    1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16,
  ])("supports numeric receiver condition %s", (condition) => {
    const { client } = fixture();
    expect(
      client.preview({
        ...invoice,
        to: { condition, document: { type: 80, number: "20123456789" } },
      }).request.receiverVatConditionId
    ).toBe(condition);
  });
  it("preserves mixed services and payment in foreign currency", () => {
    const { client } = fixture();
    expect(
      client.preview({
        ...invoice,
        currency: "USD",
        exchangeRate: "1200.125",
        paidInForeignCurrency: true,
        concept: "products_and_services",
        service: { from: "20260901", to: "20260906", dueDate: "20260930" },
      }).request
    ).toMatchObject({
      concept: 3,
      currencyId: "DOL",
      exchangeRate: "1200.125",
      sameCurrencyForeignCancellation: "S",
      serviceStartDate: "20260901",
    });
  });
  it.each([
    [1, 2, 3],
    [6, 7, 8],
    [11, 12, 13],
    [51, 52, 53],
    [201, 202, 203],
    [206, 207, 208],
    [211, 212, 213],
  ])("issues credit and debit notes in family %s/%s/%s", async (type, debit, credit) => {
    const { client, records, wsfe } = fixture();
    const isC = [11, 211].includes(type);
    const data = client.preview(
      isC
        ? { ...invoice, issuer: "monotributo", items: [{ amount: 12_100 }] }
        : invoice
    ).request;
    records.set(`${type}:1`, found({ ...data, voucherType: type }, 1));
    records.set(`${debit}:2`, found({ ...data, voucherType: debit }, 2));
    const items = isC
      ? [{ amount: 6050 }]
      : ([{ net: 5000, vat: 21 }] as const);
    const preview = await client.previewDebitNote({
      for: { salesPoint: 1, voucherType: type, number: 1 },
      items,
      date: "20260906",
      ...(type >= 200 ? { fce: { annulment: false } } : {}),
    });
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(preview.voucherType).toBe(debit);
    const issued = await client.issueDebitNote(
      {
        for: { salesPoint: 1, voucherType: type, number: 1 },
        items,
        date: "20260906",
        ...(type >= 200 ? { fce: { annulment: false } } : {}),
      },
      { include: { exactInput: true } }
    );
    expect(issued).toMatchObject({
      kind: "authorized",
      sent: { voucherType: debit, totalAmount: 60.5 },
    });
    const credited = await client.issueCreditNote(
      {
        for: { salesPoint: 1, voucherType: debit, number: 2 },
        all: true,
        date: "20260906",
        ...(type >= 200 ? { fce: { annulment: false } } : {}),
      },
      { include: { exactInput: true } }
    );
    expect(credited).toMatchObject({
      kind: "authorized",
      sent: {
        voucherType: credit,
        associatedVouchers: [{ type: debit, number: 2 }],
      },
    });
    if (type >= 200 && credited.kind === "authorized") {
      expect(credited.sent.associatedVouchers?.[0]?.taxId).toBe("20123456789");
    }
  });
  it("mirrors tributes on full notes and uses explicit tributes for partial notes", async () => {
    const { client, records } = fixture();
    records.set(
      "1:1",
      found(client.preview({ ...invoice, taxes: [tax] }).request, 1)
    );
    const target = { salesPoint: 1, voucherType: 1, number: 1 };
    expect(
      await client.previewCreditNote({
        for: target,
        all: true,
        date: "20260906",
      })
    ).toMatchObject({
      request: { totalAmount: 124, taxes: [{ id: 2, amount: 3 }] },
    });
    expect(
      await client.previewCreditNote({
        for: target,
        items: [{ net: 5000, vat: 21 }],
        taxes: [{ ...tax, base: 5000, amount: 150 }],
        date: "20260906",
      })
    ).toMatchObject({ request: { totalAmount: 62, taxes: [{ amount: 1.5 }] } });
  });
  it("rejects reversed periods before any provider call", async () => {
    const { client, wsfe } = fixture();
    await expect(
      client.issueDebitNote({
        ...invoice,
        associatedPeriod: { from: "20260930", to: "20260901" },
      })
    ).rejects.toMatchObject({
      code: "ARCA_INPUT_INVALID_VALUE",
      field: "associatedPeriod",
    });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    expect(wsfe.issue).not.toHaveBeenCalled();
  });
  it("creates period-associated notes without consulting an invented original", async () => {
    const { client, wsfe } = fixture();
    expect(
      await client.issueCreditNote(
        { ...invoice, associatedPeriod: { from: "20260801", to: "20260831" } },
        { include: { exactInput: true } }
      )
    ).toMatchObject({
      kind: "authorized",
      sent: {
        voucherType: 3,
        associatedPeriod: { startDate: "20260801", endDate: "20260831" },
      },
    });
    expect(wsfe.lookupVoucher).not.toHaveBeenCalled();
  });
  it("replays a stored number after authorization and detects changed provider or reserved number", async () => {
    const { client, wsfe, store } = fixture();
    const options = { idempotencyKey: "sale", number: 41 };
    await client.issue({ ...invoice, taxes: [tax] }, options);
    expect(
      await client.issue({ ...invoice, taxes: [tax] }, options)
    ).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 41 },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        (await store.get(attemptKey("test", "20123456789", "sale"))) ?? "{}"
      )
    ).toMatchObject({ number: 41, sent: { taxAmount: 3 } });
    await expect(
      client.issue({ ...invoice, taxes: [tax] }, { ...options, number: 42 })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
  });
  it.each([
    { concept: "products_and_services" },
    { dueDate: "20260901" },
    { taxes: [{ ...tax, amount: -1 }] },
    { taxes: [{ ...tax, id: 0 }] },
    { family: "fce" },
    { paidInForeignCurrency: true },
    { details: [] },
    { to: { condition: 5, document: { type: 80, number: "1" } } },
    { amounts: { net: 10_000, vat: 2100 } },
  ])("rejects invalid extended input before any I/O: %j", async (extra) => {
    const { client, wsfe } = fixture();
    await expect(
      client.issue({ ...invoice, ...extra } as IssueInput)
    ).rejects.toMatchObject({ name: "ArcaInputError" });
    expect(wsfe.issue).not.toHaveBeenCalled();
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
  });
  it("keeps reviewed total tolerance without rewriting its VAT", async () => {
    const { client } = fixture();
    const { items: _items, ...common } = invoice;
    const result = await client.issue(
      {
        ...common,
        amounts: {
          net: 10_000,
          vat: 2100,
          vatRates: [{ id: 5, base: 10_000, amount: 2100 }],
        },
        total: 12_101,
      },
      { include: { exactInput: true } }
    );
    expect(result).toMatchObject({
      kind: "authorized",
      sent: { totalAmount: 121.01, vatAmount: 21 },
      voucher: {
        amounts: { sentTotal: 12_101, computedTotal: 12_100, vatAdjustment: 0 },
      },
    });
  });
  it("recover only consults even when the reserved document is absent", async () => {
    const { client, records, wsfe } = fixture();
    await client.issue(invoice, { idempotencyKey: "recover", number: 17 });
    expect(await client.recover("recover")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
      voucher: { number: 17 },
    });
    records.clear();
    expect(await client.recover("recover")).toMatchObject({
      kind: "indeterminate",
      attempted: { number: 17 },
      lookup: { kind: "not_found" },
    });
    expect(wsfe.issue).toHaveBeenCalledTimes(1);
    expect(wsfe.getNextVoucherNumber).not.toHaveBeenCalled();
    await expect(
      client.recover("recover", { representedTaxId: "20304050607" })
    ).rejects.toMatchObject({ code: "ARCA_INPUT_IDEMPOTENCY_MISMATCH" });
  });
  it.each([
    "taxes",
    "optionalFields",
    "buyers",
    "activities",
    "sameCurrencyForeignCancellation",
  ] as const)("does not recover a voucher with conflicting %s", (field) => {
    const { client } = fixture();
    const sent = client.preview({
      ...invoice,
      currency: "USD",
      exchangeRate: "1",
      taxes: [tax],
      optionalFields: [{ id: "27", value: "SCA" }],
      buyers: [
        { documentType: 80, documentNumber: 20_123_456_789, percentage: 100 },
      ],
      activities: [{ id: 123 }],
      paidInForeignCurrency: true,
    }).request;
    const actual = found(sent, 9);
    Object.assign(actual, {
      [field]: field === "sameCurrencyForeignCancellation" ? "N" : [],
    });
    expect(matchWsfeVoucherIdentity(sent, 9, actual)).toMatchObject({
      matches: false,
      evidence: "conflict",
    });
    delete actual[field];
    expect(matchWsfeVoucherIdentity(sent, 9, actual)).toMatchObject({
      matches: false,
      evidence: "incomplete",
    });
  });
});

function transportFixture() {
  const vouchers = new Map<number, Record<string, unknown>>();
  const calls: string[] = [];
  const soap = {
    execute: vi
      .fn()
      .mockImplementation(
        async ({
          operation,
          body,
        }: {
          operation: string;
          body: Record<string, unknown>;
        }) => {
          await Promise.resolve();
          calls.push(operation);
          if (operation === "consultarUltimoComprobanteAutorizado") {
            return { result: { numeroComprobante: 8 } };
          }
          if (operation === "autorizarComprobante") {
            const data = body.comprobanteCAERequest as Record<string, unknown>;
            vouchers.set(
              Number(data.codigoTipoComprobante),
              structuredClone(data)
            );
            return {
              result: {
                resultado: "A",
                comprobanteResponse: {
                  CAE: "12345678901234",
                  fechaVencimientoCAE: "20260916",
                  numeroComprobante: data.numeroComprobante,
                },
              },
            };
          }
          const target = body.consultaComprobanteRequest as Record<
            string,
            unknown
          >;
          const data = vouchers.get(Number(target.codigoTipoComprobante));
          return {
            result: data
              ? {
                  comprobante: {
                    ...data,
                    codigoAutorizacion: "12345678901234",
                    fechaVencimiento: "2026-09-16",
                  },
                }
              : {
                  arrayErrores: {
                    codigoDescripcion: {
                      codigo: 1503,
                      descripcion: "No existe",
                    },
                  },
                },
          };
        }
      ),
  };
  const config = {
    taxId: "20123456789",
    certificatePem: "cert",
    privateKeyPem: "key",
    environment: "test" as const,
  };
  const auth = {
    login: vi.fn().mockResolvedValue({
      token: "token",
      sign: "sign",
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  };
  const store = createMemoryStore();
  const client = createVouchersService(
    fixture().wsfe,
    { store, environment: "test", taxId: config.taxId },
    createWsmtxcaService({ config, auth, soap })
  );
  return { client, soap, calls, vouchers, config, auth, store };
}
const detailed: IssueInput = {
  ...invoice,
  details: [
    {
      description: "Product",
      quantity: 1,
      unit: 7,
      unitPrice: "100.000000",
      vatCondition: 5,
      vatAmount: 2100,
      amount: 12_100,
    },
  ],
};
describe("WSMTXCA high-level API through the real transport adapter", () => {
  it("previews, issues and recovers complete item and tax evidence", async () => {
    const { client, calls, soap, vouchers } = transportFixture();
    const options = {
      service: "wsmtxca" as const,
      idempotencyKey: "invoice",
      include: { exactInput: true },
    };
    const input = { ...detailed, taxes: [tax] };
    const preview = client.preview(input, { service: "wsmtxca" });
    expect(calls).toEqual([]);
    expect(preview.request.comprobanteCAERequest).toMatchObject({
      importeTotal: 124,
      arrayItems: {
        item: [{ descripcion: "Product", importeIVA: 21, importeItem: 121 }],
      },
      arrayOtrosTributos: { otroTributo: [{ codigo: 2, importe: 3 }] },
    });
    expect(await client.issue(input, options)).toMatchObject({
      kind: "authorized",
      authorization: { service: "wsmtxca" },
      voucher: { number: 9 },
    });
    expect(
      soap.execute.mock.calls.find(
        ([arg]) => arg.operation === "autorizarComprobante"
      )?.[0].retries
    ).toBe(0);
    expect(await client.issue(input, options)).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
    expect(calls.filter((c) => c === "autorizarComprobante")).toHaveLength(1);
    const raw = vouchers.get(1) as Record<string, unknown>;
    const items = (raw.arrayItems as { item: { descripcion: string }[] }).item;
    if (items[0]) {
      items[0].descripcion = "Different product, same total";
    }
    expect(await client.issue(input, options)).toMatchObject({
      kind: "conflict",
    });
    expect(calls.filter((c) => c === "autorizarComprobante")).toHaveLength(1);
  });
  it("reports a stranger on a freshly reserved WSMTXCA number as a conflict", async () => {
    const { client, soap, vouchers, calls } = transportFixture();
    soap.execute.mockImplementationOnce(async ({ body }) => {
      await Promise.resolve();
      // Somebody else took the number this call reserved: identical fiscal
      // data proves consistency, never authorship.
      vouchers.set(1, structuredClone(body.comprobanteCAERequest));
      return {
        result: {
          resultado: "R",
          arrayErrores: {
            codigoDescripcion: { codigo: 999, descripcion: "Rejected request" },
          },
        },
      };
    });
    expect(
      await client.issue(detailed, {
        service: "wsmtxca",
        idempotencyKey: "race",
        number: 9,
      })
    ).toMatchObject({ kind: "conflict", found: { number: 9 } });
    expect(soap.execute).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["consultarComprobante"]);
  });
  it("keeps missing nested WSMTXCA evidence uncertain and rejects unexpected fiscal extensions", async () => {
    const { client, calls, vouchers } = transportFixture();
    await client.issue(detailed, {
      service: "wsmtxca",
      idempotencyKey: "nested",
    });
    const raw = vouchers.get(1) as Record<string, unknown>;
    const item = (raw.arrayItems as { item: Record<string, unknown>[] })
      .item[0] as Record<string, unknown>;
    item.precioUnitario = undefined;
    expect(await client.recover("nested")).toMatchObject({
      kind: "indeterminate",
    });
    item.precioUnitario = detailed.details?.[0]?.unitPrice;
    raw.arrayDatosAdicionales = {
      datoAdicional: [{ t: 23, c1: "unexpected" }],
    };
    expect(await client.recover("nested")).toMatchObject({ kind: "conflict" });
    expect(calls.filter((c) => c === "autorizarComprobante")).toHaveLength(1);
  });
  it("issues full and partial notes and debit notes using WSMTXCA", async () => {
    const { client, calls } = transportFixture();
    const options = { service: "wsmtxca" as const };
    await client.issue({ ...detailed, taxes: [tax] }, options);
    const target = { salesPoint: 1, voucherType: 1, number: 9 };
    expect(
      await client.issueCreditNote(
        { for: target, all: true, date: "20260906" },
        options
      )
    ).toMatchObject({ kind: "authorized", voucher: { voucherType: 3 } });
    expect(
      await client.issueDebitNote(
        {
          for: target,
          items: [{ net: 10_000, vat: 21 }],
          details: detailed.details,
          date: "20260906",
        },
        options
      )
    ).toMatchObject({ kind: "authorized", voucher: { voucherType: 2 } });
    expect(calls.filter((c) => c === "autorizarComprobante")).toHaveLength(3);
  });
  it("encodes FCE bank details and note annulment correctly for WSMTXCA", async () => {
    const { client, vouchers } = transportFixture();
    const options = {
      service: "wsmtxca" as const,
      idempotencyKey: "fce-invoice",
    };
    const input = {
      ...detailed,
      family: "fce" as const,
      dueDate: "20260930" as const,
      fce: {
        cbu: "1234567890123456789012",
        alias: "EMISOR.ALIAS",
        transfer: "SCA" as const,
      },
    };
    const preview = client.preview(input, { service: "wsmtxca" });
    expect(preview.request.comprobanteCAERequest.arrayDatosAdicionales).toEqual(
      {
        datoAdicional: [
          { t: 21, c1: "1234567890123456789012", c2: "EMISOR.ALIAS" },
          { t: 27, c1: "SCA" },
        ],
      }
    );
    await client.issue(input, options);
    expect(await client.recover("fce-invoice")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
    const note = {
      for: { salesPoint: 1, voucherType: 201, number: 9 },
      all: true as const,
      date: "20260906" as const,
      fce: { annulment: false },
    };
    expect(
      await client.issueCreditNote(note, {
        service: "wsmtxca",
        idempotencyKey: "fce-note",
      })
    ).toMatchObject({ kind: "authorized", voucher: { voucherType: 203 } });
    expect(vouchers.get(203)?.arrayDatosAdicionales).toEqual({
      datoAdicional: [{ t: 22, c1: "N" }],
    });
    expect(await client.recover("fce-note")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
  });
  it("supports period-associated WSMTXCA notes and single-object SOAP arrays", async () => {
    const { client, vouchers } = transportFixture();
    const input = {
      ...detailed,
      associatedPeriod: { from: "20260801" as const, to: "20260831" as const },
    };
    expect(
      await client.issueCreditNote(input, {
        service: "wsmtxca",
        idempotencyKey: "period",
      })
    ).toMatchObject({ kind: "authorized", voucher: { voucherType: 3 } });
    const raw = vouchers.get(3) as Record<string, unknown>;
    expect(raw.periodoComprobantesAsociados).toEqual({
      fechaDesde: "2026-08-01",
      fechaHasta: "2026-08-31",
    });
    const array = raw.arrayItems as { item: unknown[] };
    raw.arrayItems = { item: array.item[0] };
    expect(await client.recover("period")).toMatchObject({
      kind: "authorized",
      recoveredByMatch: true,
    });
  });
  it("returns uncertainty for incomplete consultation and never reissues", async () => {
    const { client, vouchers, calls } = transportFixture();
    const options = { service: "wsmtxca" as const, idempotencyKey: "invoice" };
    await client.issue(detailed, options);
    (vouchers.get(1) as Record<string, unknown>).arrayItems = undefined;
    expect(await client.issue(detailed, options)).toMatchObject({
      kind: "indeterminate",
    });
    expect(calls.filter((c) => c === "autorizarComprobante")).toHaveLength(1);
  });
  it("rejects invalid details before any provider request", async () => {
    const { client, calls } = transportFixture();
    await expect(
      client.issue(
        {
          ...detailed,
          details: [
            {
              ...(detailed.details?.[0] as NonNullable<
                IssueInput["details"]
              >[number]),
              amount: 1,
            },
          ],
        },
        { service: "wsmtxca" }
      )
    ).rejects.toMatchObject({ name: "ArcaInputError" });
    expect(calls).toEqual([]);
  });
  it("writes v2 records for WSMTXCA and refuses an unknown version", async () => {
    const { client, store } = transportFixture();
    const read = async (key: string) =>
      JSON.parse(
        (await store.get(attemptKey("test", "20123456789", key))) ?? "{}"
      ) as { v: number; service?: string };
    await client.issue(detailed, {
      service: "wsmtxca",
      idempotencyKey: "detailed",
    });
    await client.issue(invoice, { idempotencyKey: "plain" });
    expect(await read("detailed")).toMatchObject({ v: 2, service: "wsmtxca" });
    // A plain WSFE reservation stays v1 so a rollback to 0.10 keeps replaying it.
    const plain = await read("plain");
    expect(plain.v).toBe(1);
    expect(plain.service).toBeUndefined();
    await store.set(
      attemptKey("test", "20123456789", "plain"),
      JSON.stringify({ ...plain, v: 3 })
    );
    await expect(
      client.issue(invoice, { idempotencyKey: "plain" })
    ).rejects.toMatchObject({ name: "ArcaConfigurationError" });
  });
  it("decodes WSFE extension identity from SOAP consultation", async () => {
    const { config, auth } = transportFixture();
    const soap = {
      execute: vi.fn().mockResolvedValue({
        result: {
          ResultGet: {
            CbteDesde: 9,
            PtoVta: 1,
            CbteTipo: 201,
            CbteFch: "20260906",
            Resultado: "A",
            CodAutorizacion: "123",
            FchVto: "20260916",
            CanMisMonExt: "S",
            Opcionales: { Opcional: { Id: 27, Valor: "SCA" } },
            Actividades: { Actividad: { Id: 123 } },
            PeriodoAsoc: { FchDesde: "20260801", FchHasta: "20260831" },
            CbtesAsoc: {
              CbteAsoc: { Tipo: 201, PtoVta: 1, Nro: 8, Cuit: "20123456789" },
            },
          },
        },
      }),
    };
    expect(
      await createWsfeService({ config, auth, soap }).lookupVoucher({
        salesPoint: 1,
        voucherType: 201,
        number: 9,
      })
    ).toMatchObject({
      kind: "found",
      voucher: {
        sameCurrencyForeignCancellation: "S",
        optionalFields: [{ id: "27", value: "SCA" }],
        activities: [{ id: 123 }],
        associatedPeriod: { startDate: "20260801", endDate: "20260831" },
        associatedVouchers: [{ taxId: "20123456789" }],
      },
    });
  });
});
